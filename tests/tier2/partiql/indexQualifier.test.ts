import {
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  PutItemCommand,
  DeleteItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import {
  declareTables,
  partiqlIndexTableDef,
  PARTIQL_UNPROJECTED_ATTR,
  cleanupItems,
  waitForGsiConsistency,
  waitForReadsToSettle,
} from '../../../src/helpers.js'

declareTables(partiqlIndexTableDef)

const TABLE = partiqlIndexTableDef.name

// Mirrors the capture fixture. Three properties are load-bearing: s3 carries no
// index attribute at all, so every index excludes it and a qualified read that
// returns it is reading the table; s1 and s4 share a gsi-all partition key, so a
// bounded read across them has a second row to continue to; and `nonproj` is
// projected by no index, which is what the projection and filter rules turn on.
const ITEMS: Record<string, AttributeValue>[] = [
  {
    pk: { S: 'p' }, sk: { S: 's1' },
    gsiPk: { S: 'x' }, gsiPk2: { S: 'y' },
    lsiSk: { S: 'l1' }, lsiSk2: { S: 'k1' }, lsiSk3: { S: 'm1' },
    projattr: { S: 'proj1' }, [PARTIQL_UNPROJECTED_ATTR]: { S: 'np1' },
  },
  {
    pk: { S: 'p' }, sk: { S: 's2' },
    gsiPk: { S: 'z' }, gsiPk2: { S: 'y' },
    lsiSk: { S: 'l2' }, lsiSk2: { S: 'k2' }, lsiSk3: { S: 'm2' },
    projattr: { S: 'proj2' }, [PARTIQL_UNPROJECTED_ATTR]: { S: 'np2' },
  },
  // No index attribute of any kind, so no index holds it.
  { pk: { S: 'p' }, sk: { S: 's3' }, [PARTIQL_UNPROJECTED_ATTR]: { S: 'np3' } },
  {
    pk: { S: 'p' }, sk: { S: 's4' },
    gsiPk: { S: 'x' }, gsiPk2: { S: 'y' },
    lsiSk: { S: 'l4' }, lsiSk2: { S: 'k4' }, lsiSk3: { S: 'm4' },
    projattr: { S: 'proj4' }, [PARTIQL_UNPROJECTED_ATTR]: { S: 'np4' },
  },
  // A second gsi-inc partition key, on its own table partition so it stays out
  // of every `pk = 'p'` read. An OR across two index keys needs a second key to
  // reach for.
  {
    pk: { S: 'q' }, sk: { S: 's5' },
    gsiPk2: { S: 'y2' },
    projattr: { S: 'proj5' }, [PARTIQL_UNPROJECTED_ATTR]: { S: 'np5' },
  },
]

// Partition `lk` exists only for the LSI key-set reads. Its rows carry `lsiSk`
// and nothing else an index keys on, so they sit in lsi-all alone, and two of
// them share a key. The rows are small, so each key a read touches costs one
// unit under ConsistentRead.
const LSI_SET_ITEMS: Record<string, AttributeValue>[] = [
  { pk: { S: 'lk' }, sk: { S: 'r1' }, lsiSk: { S: 'a' } },
  { pk: { S: 'lk' }, sk: { S: 'r2' }, lsiSk: { S: 'b' } },
  { pk: { S: 'lk' }, sk: { S: 'r3' }, lsiSk: { S: 'b' } },
]

/** Run a statement and hand back the rows and the per-arm capacity. */
async function select(Statement: string, extra: Record<string, unknown> = {}) {
  const res = await ddb.send(
    new ExecuteStatementCommand({ Statement, ReturnConsumedCapacity: 'INDEXES', ...extra }),
  )
  const cc = res.ConsumedCapacity
  return {
    items: res.Items ?? [],
    nextToken: res.NextToken,
    total: cc?.CapacityUnits ?? 0,
    table: cc?.Table?.CapacityUnits ?? 0,
    gsi: (name: string) => cc?.GlobalSecondaryIndexes?.[name]?.CapacityUnits ?? 0,
    lsi: (name: string) => cc?.LocalSecondaryIndexes?.[name]?.CapacityUnits ?? 0,
  }
}

/** Keys the rejected INSERT cases would create on an engine that accepts them. */
const REJECTED_INSERT_KEYS = [
  { pk: { S: 'w1' }, sk: { S: 'w1' } },
  { pk: { S: 'w2' }, sk: { S: 'w2' } },
]

/** Expect a statement to be refused, and hand back the error for inspection. */
async function expectRejected(Statement: string, extra: Record<string, unknown> = {}) {
  try {
    await select(Statement, extra)
    // Rethrown below rather than swallowed by the sibling catch, so a statement
    // that was wrongly accepted reports itself instead of reporting that an
    // assertion error is not an AWS exception.
    expect.unreachable(`should have been rejected: ${Statement}`)
    throw new Error('unreachable')
  } catch (err) {
    if (!(err instanceof DynamoDBServiceException)) throw err
    expect(err.name).toBe('ValidationException')
    return err
  }
}

/** The attribute names one row came back with, sorted so order means nothing. */
const attrsOf = (item: Record<string, AttributeValue>) => Object.keys(item).sort()

describe('ExecuteStatement — index qualifier', { tags: ['partiql', 'data-plane', 'gsi', 'lsi'] }, () => {
  let supported = true
  let lsiSetSettled: Promise<void> = Promise.resolve()

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${TABLE}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      // The suite's definition of "not implemented", so a target declining
      // PartiQL skips rather than failing every case here.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }

    for (const Item of [...ITEMS, ...LSI_SET_ITEMS]) {
      await ddb.send(new PutItemCommand({ TableName: TABLE, Item }))
    }

    // The LSI key-set walks pin exact pages on eventually consistent reads.
    // Awaited by those walks rather than here, so reads that never settle fail
    // them as a failed observation instead of skipping the whole file.
    lsiSetSettled = waitForReadsToSettle({
      tableName: TABLE,
      indexName: 'lsi-all',
      partitionKey: { name: 'pk', value: { S: 'lk' } },
      expectedCount: LSI_SET_ITEMS.length,
    })
    lsiSetSettled.catch(() => {})

    // A GSI fills asynchronously, and a read of one still filling is
    // indistinguishable from an engine returning the wrong rows.
    await waitForGsiConsistency({
      tableName: TABLE,
      indexName: 'gsi-all',
      partitionKey: { name: 'gsiPk', value: { S: 'x' } },
      expectedCount: 2,
    })
    await waitForGsiConsistency({
      tableName: TABLE,
      indexName: 'gsi-inc',
      partitionKey: { name: 'gsiPk2', value: { S: 'y' } },
      expectedCount: 3,
    })
    // gsi-keys is a separate index and fills on its own schedule, and the s5 row
    // arrives under its own partition key. Both are read below, and an index
    // still filling is indistinguishable from an engine returning wrong rows.
    await waitForGsiConsistency({
      tableName: TABLE,
      indexName: 'gsi-keys',
      partitionKey: { name: 'gsiPk2', value: { S: 'y' } },
      expectedCount: 3,
    })
    await waitForGsiConsistency({
      tableName: TABLE,
      indexName: 'gsi-inc',
      partitionKey: { name: 'gsiPk2', value: { S: 'y2' } },
      expectedCount: 1,
    })
    await waitForGsiConsistency({
      tableName: TABLE,
      indexName: 'gsi-keys',
      partitionKey: { name: 'gsiPk2', value: { S: 'y2' } },
      expectedCount: 1,
    })
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    if (!supported) return
    await cleanupItems(TABLE, [
      ...[...ITEMS, ...LSI_SET_ITEMS].map((i) => ({ pk: i.pk, sk: i.sk })),
      // The qualified INSERTs below are rejected by DynamoDB and write nothing.
      // An engine that wrongly accepts one leaves a row behind, in a table the
      // run shares with every other file.
      ...REJECTED_INSERT_KEYS,
    ])
  })

  describe('membership', () => {
    it('a qualified SELECT omits an item the index does not hold', async () => {
      const viaIndex = await select(`SELECT pk, sk FROM "${TABLE}"."gsi-all" WHERE gsiPk = 'x'`)
      expect(viaIndex.items.map((i) => i.sk.S).sort()).toEqual(['s1', 's4'])

      // The same rows plus s3 are all in the table, so the absence above is the
      // index's membership rather than the rows not existing.
      const viaTable = await select(`SELECT pk, sk FROM "${TABLE}" WHERE pk = 'p'`)
      expect(viaTable.items.map((i) => i.sk.S).sort()).toEqual(['s1', 's2', 's3', 's4'])
    })
  })

  describe('projection follows the index, not the item', () => {
    it('a KEYS_ONLY GSI returns the index key and the table key and nothing else', async () => {
      const r = await select(`SELECT * FROM "${TABLE}"."gsi-keys" WHERE gsiPk2 = 'y'`)
      expect(r.items.length).toBe(3)
      for (const item of r.items) {
        expect(attrsOf(item)).toEqual(['gsiPk2', 'pk', 'sk'])
      }
    })

    it('an INCLUDE GSI adds the named attribute and no others', async () => {
      const r = await select(`SELECT * FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y'`)
      expect(r.items.length).toBe(3)
      for (const item of r.items) {
        expect(attrsOf(item)).toEqual(['gsiPk2', 'pk', 'projattr', 'sk'])
      }
    })

    it('a KEYS_ONLY LSI returns the index key and the table key and nothing else', async () => {
      const r = await select(`SELECT * FROM "${TABLE}"."lsi-keys" WHERE pk = 'p'`)
      expect(r.items.length).toBe(3)
      for (const item of r.items) {
        expect(attrsOf(item)).toEqual(['lsiSk2', 'pk', 'sk'])
      }
    })

    // The obvious reading of `SELECT *` is that it selects everything. It does
    // not: a star against a non-ALL index is the index's own projection, served
    // without touching the base table.
    it('SELECT * against a non-ALL index does not reach back', async () => {
      const gsi = await select(`SELECT * FROM "${TABLE}"."gsi-keys" WHERE gsiPk2 = 'y'`)
      expect(gsi.table).toBe(0)
      expect(gsi.gsi('gsi-keys')).toBe(gsi.total)

      const lsi = await select(`SELECT * FROM "${TABLE}"."lsi-keys" WHERE pk = 'p'`)
      expect(lsi.table).toBe(0)
      expect(lsi.lsi('lsi-keys')).toBe(lsi.total)
    })
  })

  describe('the reach-back splits by index kind', () => {
    it('an LSI serves an unprojected attribute from the base table', async () => {
      const r = await select(
        `SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."lsi-keys" WHERE pk = 'p'`,
      )
      expect(r.items.length).toBe(3)
      expect(r.items.every((i) => i[PARTIQL_UNPROJECTED_ATTR]?.S !== undefined)).toBe(true)
      // Charged on the table arm, which is the base-table fetch made visible.
      expect(r.table).toBeGreaterThan(0)
    })

    // A GSI does not share a partition with the table, so it has no cheap way
    // back and rejects instead.
    it('a GSI rejects an unprojected attribute rather than reaching back', async () => {
      try {
        await select(`SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y'`)
        expect.unreachable('should have thrown')
      } catch (err) {
        if (!(err instanceof DynamoDBServiceException)) throw err
        expect(err.name).toBe('ValidationException')
      }
    })

    it('naming only projected attributes on an LSI charges no table arm', async () => {
      const r = await select(`SELECT lsiSk2 FROM "${TABLE}"."lsi-keys" WHERE pk = 'p'`)
      expect(r.table).toBe(0)
    })

    // The reach-back is sized on the rows it walked, not the rows the filter
    // kept, so a filter matching nothing costs what matching everything costs.
    it('a filtered reach-back is charged on rows walked, not rows kept', async () => {
      // The filter is on a projected non-key attribute, so it is applied to rows
      // already read. A condition on the index sort key would narrow the scan
      // instead, and would legitimately cost less.
      const none = await select(
        `SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."lsi-inc" WHERE pk = 'p' AND projattr = 'no-such-value'`,
      )
      const all = await select(
        `SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."lsi-inc" WHERE pk = 'p'`,
      )
      expect(none.items.length).toBe(0)
      expect(all.items.length).toBe(3)
      expect(none.table).toBe(all.table)
    })

    it('a bounded reach-back walks fewer rows and is charged less', async () => {
      const one = await select(
        `SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."lsi-keys" WHERE pk = 'p'`,
        { Limit: 1 },
      )
      const all = await select(
        `SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."lsi-keys" WHERE pk = 'p'`,
      )
      expect(one.items.length).toBe(1)
      expect(one.table).toBeLessThan(all.table)
    })
  })

  // A filter naming an attribute the index does not project is refused, but only
  // when the read is keyed on the index partition key. Unkeyed the read is a
  // scan, and a scan matches nothing rather than failing.
  //
  // This is a separate rule from the projection one above and was first read as
  // the same rule. The mirror cases are what tell them apart, so none of them is
  // redundant: without the LSI-unkeyed case this reads as a rule about index
  // kind, and without the two-filter case it reads as a rule about how many
  // conditions the statement carries.
  describe('the unprojected-filter rejection turns on the key condition', () => {
    it('rejects a keyed GSI read filtering on an unprojected attribute', async () => {
      await expectRejected(
        `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y' AND ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
      )
    })

    it('rejects the LSI mirror, so the rule is not about index kind', async () => {
      await expectRejected(
        `SELECT pk FROM "${TABLE}"."lsi-keys" WHERE pk = 'p' AND ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
      )
    })

    it('accepts the same GSI filter unkeyed, matching nothing', async () => {
      const r = await select(
        `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
      )
      expect(r.items.length).toBe(0)
    })

    // The mirror of the accepted GSI case. Together with the rejected LSI case
    // above, this is what kills the index-kind reading outright.
    it('accepts the same LSI filter unkeyed, matching nothing', async () => {
      const r = await select(
        `SELECT pk FROM "${TABLE}"."lsi-keys" WHERE ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
      )
      expect(r.items.length).toBe(0)
    })

    // Two conditions, no index key, still accepted: the trigger is not having
    // more than one condition.
    it('accepts two unprojected filters with no index key', async () => {
      const r = await select(
        `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE ${PARTIQL_UNPROJECTED_ATTR} = 'np1' AND ${PARTIQL_UNPROJECTED_ATTR} = 'np2'`,
      )
      expect(r.items.length).toBe(0)
    })

    it('accepts a keyed read filtering on an attribute the index does project', async () => {
      const r = await select(
        `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y' AND projattr = 'proj1'`,
      )
      expect(r.items.length).toBe(1)
    })

    it.each(['IS MISSING', 'IS NOT MISSING'])(
      'rejects a keyed read with %s on an unprojected attribute',
      async (predicate) => {
        await expectRejected(
          `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y' AND ${PARTIQL_UNPROJECTED_ATTR} ${predicate}`,
        )
      },
    )

    it('rejects a keyed read with begins_with on an unprojected attribute', async () => {
      await expectRejected(
        `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y' AND begins_with(${PARTIQL_UNPROJECTED_ATTR}, 'np')`,
      )
    })

    it('accepts the same predicate on a projected attribute', async () => {
      const r = await select(
        `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y' AND projattr IS NOT MISSING`,
      )
      expect(r.items.length).toBe(3)
    })

    // Negating the predicate does not get round the rule.
    it('rejects a keyed read with a negated filter on an unprojected attribute', async () => {
      await expectRejected(
        `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y' AND NOT ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
      )
    })

    // Unkeyed the read is a scan of the index, and the index has no such
    // attribute at all. A comparison against a missing attribute is false, so
    // the negation is true and every index row matches.
    //
    // That makes this the sharpest case in the file. An engine discarding the
    // qualifier scans the base table, where the attribute is present and one row
    // genuinely holds 'np1', and returns two rows where DynamoDB returns three.
    it('matches every index row when the negated filter names an absent attribute', async () => {
      const r = await select(
        `SELECT pk, sk FROM "${TABLE}"."gsi-keys" WHERE NOT ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
      )
      expect(r.items.map((i) => i.sk.S).sort()).toEqual(['s1', 's2', 's4', 's5'])
    })

    // "Keyed" follows the shape of the key condition, not what the read can do
    // with it. An IN cannot be pushed down as a single key and the read still
    // scans, and the filter beside it is rejected anyway.
    it('counts IN on the index partition key as keyed', async () => {
      await expectRejected(
        `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 IN ['y', 'z'] AND ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
      )
    })

    // An index key reached through OR is not pushed down, and the filter sits
    // inside a branch rather than beside a key condition at the top level. Both
    // together are what make this accepted where the IN case above is refused.
    it('accepts an unprojected filter inside an OR branch', async () => {
      const r = await select(
        `SELECT pk, sk FROM "${TABLE}"."gsi-inc" WHERE (gsiPk2 = 'y' AND ${PARTIQL_UNPROJECTED_ATTR} = 'np1') OR (gsiPk2 = 'y2')`,
      )
      // The first branch matches nothing: the index does not carry the
      // attribute. The second returns its row, so the statement ran.
      expect(r.items.map((i) => i.sk.S)).toEqual(['s5'])
    })

    // Unlike the case above, the OR here sits beside the key condition rather
    // than holding it, so the read is keyed and the filter inside the OR is
    // still a filter on an attribute the index cannot answer.
    it('rejects an OR of unprojected filters beside the index partition key', async () => {
      await expectRejected(
        `SELECT * FROM "${TABLE}"."gsi-keys" WHERE gsiPk2 = 'y' AND (${PARTIQL_UNPROJECTED_ATTR} = 'np1' OR ${PARTIQL_UNPROJECTED_ATTR} = 'np2')`,
      )
    })

    it('rejects the same OR beside a multi-value IN on the index partition key', async () => {
      await expectRejected(
        `SELECT * FROM "${TABLE}"."gsi-keys" WHERE gsiPk2 IN ['y', 'y2'] AND (${PARTIQL_UNPROJECTED_ATTR} = 'np1' OR ${PARTIQL_UNPROJECTED_ATTR} = 'np2')`,
      )
    })

    it('counts BETWEEN on the index sort key as keyed', async () => {
      await expectRejected(
        `SELECT pk FROM "${TABLE}"."lsi-keys" WHERE pk = 'p' AND lsiSk2 BETWEEN 'k1' AND 'k4' AND ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
      )
    })
  })

  describe('pagination across a qualified read', () => {
    it('mints a token when a bounded read leaves rows behind', async () => {
      const first = await select(`SELECT pk, sk FROM "${TABLE}"."gsi-all" WHERE gsiPk = 'x'`, { Limit: 1 })
      expect(first.items.length).toBe(1)
      expect(first.nextToken).toBeDefined()

      // The continuation returns the other row rather than repeating the first,
      // which is the property a broken token silently loses.
      const second = await select(
        `SELECT pk, sk FROM "${TABLE}"."gsi-all" WHERE gsiPk = 'x'`,
        { NextToken: first.nextToken },
      )
      const seen = [...first.items, ...second.items].map((i) => i.sk.S).sort()
      expect(seen).toEqual(['s1', 's4'])
    })

    it('rejects a token minted against one index and replayed against another', async () => {
      const first = await select(`SELECT pk, sk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y'`, { Limit: 1 })
      expect(first.nextToken).toBeDefined()

      await expectRejected(
        `SELECT pk, sk FROM "${TABLE}"."gsi-keys" WHERE gsiPk2 = 'y'`,
        { NextToken: first.nextToken },
      )
    })
  })

  // An OR of LSI sort-key values reads each key in turn. Under a Limit the token
  // is held until the read has passed every key, so a key with no rows still
  // costs a page, and each key is charged on its own.
  describe('a set of LSI keys', () => {
    const KEY_SET = (a: string, b: string) =>
      `SELECT * FROM "${TABLE}"."lsi-all" WHERE pk = 'lk' AND (lsiSk = '${a}' OR lsiSk = '${b}')`

    /** Walk a statement a page at a time and record what each page held. */
    async function walk(Statement: string, extra: Record<string, unknown> = {}) {
      await lsiSetSettled
      const pages: { items: (string | undefined)[]; token: boolean; total: number }[] = []
      let NextToken: string | undefined
      // Capped so an engine that never stops minting tokens fails rather than hangs.
      for (let i = 0; i < 10; i++) {
        const r = await select(Statement, { ...extra, NextToken })
        pages.push({ items: r.items.map((it) => it.sk?.S), token: r.nextToken !== undefined, total: r.total })
        NextToken = r.nextToken
        if (!NextToken) break
      }
      return pages
    }

    it.each([
      ['after the found key', 'a', 'z'],
      ['before the found key', 'z', 'a'],
    ])('holds the token past a missing key written %s', async (_label, a, b) => {
      expect(await walk(KEY_SET(a, b), { Limit: 1 })).toEqual([
        { items: ['r1'], token: true, total: 0.5 },
        { items: [], token: false, total: 0.5 },
      ])
    })

    it('charges a missing key beside a found one under ConsistentRead', async () => {
      const r = await select(KEY_SET('a', 'z'), { ConsistentRead: true })
      expect(r.items.map((i) => i.sk?.S)).toEqual(['r1'])
      expect(r.nextToken).toBeUndefined()
      expect(r.total).toBe(2)
      expect(r.lsi('lsi-all')).toBe(2)
    })

    it('charges per key, not per row, for two found keys over three rows', async () => {
      const r = await select(KEY_SET('a', 'b'), { ConsistentRead: true })
      expect(r.items.map((i) => i.sk?.S).sort()).toEqual(['r1', 'r2', 'r3'])
      expect(r.nextToken).toBeUndefined()
      expect(r.total).toBe(2)
    })

    // Whether a page follows the last row varies from walk to walk, so only the
    // rows the walk adds up to are asserted.
    it('returns every row across pages when two rows share a key', async () => {
      const pages = await walk(KEY_SET('a', 'b'), { Limit: 1 })
      expect(pages.at(-1)?.token).toBe(false)
      expect(pages.flatMap((p) => p.items).sort()).toEqual(['r1', 'r2', 'r3'])
    })
  })

  // The qualifier is grammatical on UPDATE and DELETE and ungrammatical on
  // INSERT, so the three rejections are not interchangeable. An engine
  // answering all three with a parse failure diverges on two of them even
  // though every case is a rejection either way.
  describe('write statements reject the qualifier, and not all the same way', () => {
    it('rejects an INSERT carrying a qualifier at parse position', async () => {
      const err = await expectRejected(
        `INSERT INTO "${TABLE}"."gsi-all" VALUE {'pk': 'w1', 'sk': 'w1'}`,
      )
      expect(err.message).toContain('FROM clause may only contain a single table name')
    })

    it('rejects an INSERT whose qualifier names no index with the same message', async () => {
      const err = await expectRejected(
        `INSERT INTO "${TABLE}"."no-such-index" VALUE {'pk': 'w2', 'sk': 'w2'}`,
      )
      // Identical to the real-index case, so the rejection is at parse rather
      // than after resolving the name.
      expect(err.message).toContain('FROM clause may only contain a single table name')
    })

    it('rejects an UPDATE carrying a qualifier semantically', async () => {
      const err = await expectRejected(
        `UPDATE "${TABLE}"."gsi-all" SET projattr = 'z' WHERE pk = 'p' AND sk = 's1'`,
      )
      expect(err.message).toContain('This operation is not supported on an index')
    })

    it('rejects a DELETE carrying a qualifier semantically', async () => {
      const err = await expectRejected(
        `DELETE FROM "${TABLE}"."gsi-all" WHERE pk = 'p' AND sk = 's1'`,
      )
      expect(err.message).toContain('This operation is not supported on an index')
    })

    it('leaves the rows untouched after the rejected writes', async () => {
      const r = await select(`SELECT pk, sk FROM "${TABLE}" WHERE pk = 'p'`)
      expect(r.items.map((i) => i.sk.S).sort()).toEqual(['s1', 's2', 's3', 's4'])
    })
  })

  // Neither multi-statement surface ever serves an index read. A transaction
  // refuses one outright as a validation error rather than cancelling, and the
  // batch surface refuses it for its own reason (see batchExecuteStatement), so
  // neither owes an index capacity arm.
  describe('a transaction refuses an index-qualified read', () => {
    it('rejects it outright, not as a cancellation', async () => {
      try {
        await ddb.send(new ExecuteTransactionCommand({
          TransactStatements: [
            { Statement: `SELECT * FROM "${TABLE}"."gsi-all" WHERE gsiPk = 'x'` },
          ],
        }))
        expect.unreachable('should have thrown')
      } catch (err) {
        if (!(err instanceof DynamoDBServiceException)) throw err
        expect(err.name).toBe('ValidationException')
        expect(err.message).toContain('Reads on indices are not supported within transactions')
      }
    })

    // The control: the same shape unqualified runs, so what is refused is the
    // qualifier rather than the statement or the table.
    it('accepts the same read unqualified', async () => {
      const res = await ddb.send(new ExecuteTransactionCommand({
        TransactStatements: [
          { Statement: `SELECT * FROM "${TABLE}" WHERE pk = 'p' AND sk = 's1'` },
        ],
      }))
      expect(res.Responses).toBeDefined()
      expect(res.Responses!.length).toBe(1)
    })
  })

  describe('capacity lands on the index arm', () => {
    it('a keyed GSI read charges the index and a zero table arm', async () => {
      const r = await select(`SELECT pk FROM "${TABLE}"."gsi-all" WHERE gsiPk = 'x'`)
      expect(r.table).toBe(0)
      expect(r.gsi('gsi-all')).toBeGreaterThan(0)
      expect(r.gsi('gsi-all')).toBe(r.total)
    })

    it('a keyed LSI read charges the index and a zero table arm', async () => {
      const r = await select(`SELECT pk FROM "${TABLE}"."lsi-all" WHERE pk = 'p'`)
      expect(r.table).toBe(0)
      expect(r.lsi('lsi-all')).toBeGreaterThan(0)
      expect(r.lsi('lsi-all')).toBe(r.total)
    })

    // ConsistentRead doubles an index arm the same way it doubles a table arm,
    // so the existing rate needs a new arm to land on rather than a new rule.
    it('ConsistentRead doubles the LSI arm', async () => {
      const eventual = await select(`SELECT pk FROM "${TABLE}"."lsi-all" WHERE pk = 'p'`)
      const consistent = await select(
        `SELECT pk FROM "${TABLE}"."lsi-all" WHERE pk = 'p'`,
        { ConsistentRead: true },
      )
      expect(consistent.lsi('lsi-all')).toBe(eventual.lsi('lsi-all') * 2)
      expect(consistent.total).toBe(eventual.total * 2)
    })

    it('ConsistentRead doubles both arms of a reach-back', async () => {
      const eventual = await select(
        `SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."lsi-keys" WHERE pk = 'p'`,
      )
      const consistent = await select(
        `SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."lsi-keys" WHERE pk = 'p'`,
        { ConsistentRead: true },
      )
      expect(consistent.table).toBe(eventual.table * 2)
      expect(consistent.lsi('lsi-keys')).toBe(eventual.lsi('lsi-keys') * 2)
    })

    it('rejects ConsistentRead against a GSI qualifier', async () => {
      try {
        await select(`SELECT pk FROM "${TABLE}"."gsi-all" WHERE gsiPk = 'x'`, { ConsistentRead: true })
        expect.unreachable('should have thrown')
      } catch (err) {
        if (!(err instanceof DynamoDBServiceException)) throw err
        expect(err.name).toBe('ValidationException')
      }
    })
  })
})
