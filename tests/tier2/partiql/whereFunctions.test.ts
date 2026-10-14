import {
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import {
  declareTables,
  hashTableDef,
  cleanupItems,
  expectDynamoError,
} from '../../../src/helpers.js'

declareTables(hashTableDef)

// Condition functions and IS in a PartiQL WHERE clause. DynamoDB accepts
// attribute_exists, attribute_not_exists, size and attribute_type there, in any
// case, and on UPDATE and DELETE treats them as a condition on the write, so a
// false one fails the write with ConditionalCheckFailedException. IS NULL,
// IS NOT NULL and IS with a type name run as filters. Verified against real AWS
// (eu-west-2, October 2026; us-east-1, eu-west-1 and us-west-2 gave the same
// answers). The refusals are pinned in
// tests/tier3/error-messages/partiqlFunctions.test.ts.
//
// no negative-path: acceptance-mixed (asserts accepted forms and conditional-check failures)
describe('PartiQL - functions and IS in a WHERE clause', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true
  const T = hashTableDef.name

  const ITEM = 'pq-fn-item'
  const seedItem: Record<string, AttributeValue> = {
    pk: { S: ITEM },
    ss: { SS: ['a', 'b', 'c'] },
    s: { S: 'str' },
    m: { M: { sub: { S: 'x' } } },
    nul: { NULL: true },
    flag: { BOOL: true },
    pqFnMarker: { S: 'present' },
  }
  const writeKeys = [
    'pq-fn-upd-ok',
    'pq-fn-upd-ccf',
    'pq-fn-upd-not',
    'pq-fn-del-ccf',
    'pq-fn-del-ok',
    'pq-fn-absent',
    'pq-fn-tx',
  ]

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-functions-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    await ddb.send(new PutItemCommand({ TableName: T, Item: seedItem }))
    for (const pk of writeKeys.filter((k) => k !== 'pq-fn-absent')) {
      await ddb.send(new PutItemCommand({ TableName: T, Item: { pk: { S: pk }, a: { N: '5' } } }))
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    await cleanupItems(T, [ITEM, ...writeKeys].map((pk) => ({ pk: { S: pk } })))
  })

  /** Every item a SELECT returns, following NextToken. */
  async function select(Statement: string): Promise<Record<string, AttributeValue>[]> {
    const items: Record<string, AttributeValue>[] = []
    let NextToken: string | undefined
    do {
      const res = await ddb.send(new ExecuteStatementCommand({ Statement, ConsistentRead: true, NextToken }))
      items.push(...(res.Items ?? []))
      NextToken = res.NextToken
    } while (NextToken)
    return items
  }

  /** The keys a SELECT on the seeded item returns: [ITEM] when the condition holds, [] when not. */
  async function keysWhere(condition: string): Promise<string[]> {
    const items = await select(`SELECT * FROM "${T}" WHERE pk = '${ITEM}' AND ${condition}`)
    return items.map((i) => i.pk.S!)
  }

  async function stored(pk: string) {
    const res = await ddb.send(new GetItemCommand({ TableName: T, Key: { pk: { S: pk } }, ConsistentRead: true }))
    return res.Item
  }

  // ── attribute_exists and attribute_not_exists in a SELECT ─────────────

  it('attribute_exists keeps an item that has the attribute', async () => {
    expect(await keysWhere('attribute_exists(ss)')).toEqual([ITEM])
  })

  it('attribute_exists drops an item without the attribute', async () => {
    expect(await keysWhere('attribute_exists(nope)')).toEqual([])
  })

  it('attribute_not_exists keeps an item without the attribute', async () => {
    expect(await keysWhere('attribute_not_exists(nope)')).toEqual([ITEM])
  })

  it('attribute_not_exists drops an item that has the attribute', async () => {
    expect(await keysWhere('attribute_not_exists(ss)')).toEqual([])
  })

  it('NOT attribute_exists keeps an item without the attribute', async () => {
    expect(await keysWhere('NOT attribute_exists(nope)')).toEqual([ITEM])
  })

  it('the function name is case-insensitive', async () => {
    expect(await keysWhere('ATTRIBUTE_EXISTS(ss)')).toEqual([ITEM])
  })

  it('works inside OR and parentheses', async () => {
    expect(await keysWhere('(attribute_exists(nope) OR attribute_exists(ss))')).toEqual([ITEM])
  })

  it('can be compared with true', async () => {
    expect(await keysWhere('attribute_exists(ss) = true')).toEqual([ITEM])
  })

  it('takes a quoted attribute name', async () => {
    expect(await keysWhere('attribute_exists("ss")')).toEqual([ITEM])
  })

  it('a nested path that is present is true', async () => {
    expect(await keysWhere('attribute_exists(m.sub)')).toEqual([ITEM])
  })

  it('a nested path that is absent is false', async () => {
    expect(await keysWhere('attribute_exists(m.nope)')).toEqual([])
  })

  it('filters a SELECT with no key condition', async () => {
    const items = await select(`SELECT pk FROM "${T}" WHERE attribute_exists(pqFnMarker)`)
    expect(items).toEqual([{ pk: { S: ITEM } }])
  })

  // ── size and attribute_type in a SELECT ──────────────────────────────

  it('size() compares the length of a string', async () => {
    expect(await keysWhere('size(s) = 3')).toEqual([ITEM])
    expect(await keysWhere('size(s) = 4')).toEqual([])
  })

  it('attribute_type() tests the type of an attribute', async () => {
    expect(await keysWhere("attribute_type(ss, 'SS')")).toEqual([ITEM])
    expect(await keysWhere("attribute_type(ss, 'S')")).toEqual([])
  })

  // ── IS in a WHERE ─────────────────────────────────────────────────────

  it('IS NULL runs as a filter', async () => {
    expect(await keysWhere('nul IS NULL')).toEqual([ITEM])
    expect(await keysWhere('s IS NULL')).toEqual([])
  })

  it('IS NOT NULL runs as a filter', async () => {
    expect(await keysWhere('s IS NOT NULL')).toEqual([ITEM])
    expect(await keysWhere('nul IS NOT NULL')).toEqual([])
  })

  it('IS with a type name runs as a filter', async () => {
    expect(await keysWhere('flag IS BOOL')).toEqual([ITEM])
    expect(await keysWhere('s IS STRING')).toEqual([ITEM])
    expect(await keysWhere('s IS BOOL')).toEqual([])
  })

  // ── As the condition on a write ──────────────────────────────────────

  it('an UPDATE whose attribute_exists holds is applied', async () => {
    await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${T}" SET z = 1 WHERE pk = 'pq-fn-upd-ok' AND attribute_exists(a)`,
    }))
    expect((await stored('pq-fn-upd-ok'))?.z).toEqual({ N: '1' })
  })

  it('an UPDATE whose attribute_exists is false fails its condition and changes nothing', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `UPDATE "${T}" SET z = 2 WHERE pk = 'pq-fn-upd-ccf' AND attribute_exists(nope)`,
      })),
      'ConditionalCheckFailedException',
    )
    expect((await stored('pq-fn-upd-ccf'))?.z).toBeUndefined()
  })

  it('an UPDATE guarded by attribute_not_exists sets the attribute once', async () => {
    await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${T}" SET y = 1 WHERE pk = 'pq-fn-upd-not' AND attribute_not_exists(y)`,
    }))
    expect((await stored('pq-fn-upd-not'))?.y).toEqual({ N: '1' })
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `UPDATE "${T}" SET y = 2 WHERE pk = 'pq-fn-upd-not' AND attribute_not_exists(y)`,
      })),
      'ConditionalCheckFailedException',
    )
    expect((await stored('pq-fn-upd-not'))?.y).toEqual({ N: '1' })
  })

  it('a DELETE whose attribute_exists is false fails its condition and keeps the item', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${T}" WHERE pk = 'pq-fn-del-ccf' AND attribute_exists(nope)`,
      })),
      'ConditionalCheckFailedException',
    )
    expect(await stored('pq-fn-del-ccf')).toBeDefined()
  })

  it('a DELETE whose attribute_not_exists holds removes the item', async () => {
    await ddb.send(new ExecuteStatementCommand({
      Statement: `DELETE FROM "${T}" WHERE pk = 'pq-fn-del-ok' AND attribute_not_exists(nope)`,
    }))
    expect(await stored('pq-fn-del-ok')).toBeUndefined()
  })

  it('an UPDATE of a missing item guarded by attribute_not_exists(pk) fails and creates nothing', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `UPDATE "${T}" SET z = 1 WHERE pk = 'pq-fn-absent' AND attribute_not_exists(pk)`,
      })),
      'ConditionalCheckFailedException',
    )
    expect(await stored('pq-fn-absent')).toBeUndefined()
  })

  it('an UPDATE in ExecuteTransaction takes attribute_exists as its condition', async () => {
    await ddb.send(new ExecuteTransactionCommand({
      TransactStatements: [
        { Statement: `UPDATE "${T}" SET z = 1 WHERE pk = 'pq-fn-tx' AND attribute_exists(a)` },
      ],
    }))
    expect((await stored('pq-fn-tx'))?.z).toEqual({ N: '1' })
  })
})
