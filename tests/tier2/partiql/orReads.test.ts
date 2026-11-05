import { ExecuteStatementCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, compositeTableDef, compositeNTableDef, cleanupItems } from '../../../src/helpers.js'

declareTables(compositeTableDef, compositeNTableDef)

// How a PartiQL SELECT whose OR branches stay in one partition pages under
// `Limit`. Captured in eu-west-2 and us-east-1, 2026-11-03 to 2026-11-05. Every
// full page sequence pinned here (items, token and cost on each page) gave the
// same answer on at least ten walks across fresh tables. Where a page ends
// inside an open range DynamoDB sometimes keeps the token for one more, empty
// page and sometimes doesn't, so those reads assert only the rows walked.
//
// Items are a few bytes each, so an eventually consistent page costs half a
// unit for each key it reads and the sums below are exact. Each scenario group
// has a partition of its own.

const T = compositeTableDef.name
const TN = compositeNTableDef.name

/** Four small rows, `row-1` to `row-4`, with `x` set to 1 to 4. */
const fourRows = (pk: string) =>
  [1, 2, 3, 4].map((n) => ({ pk: { S: pk }, sk: { S: `row-${n}` }, x: { N: String(n) } }))

/** Three small rows, `row-1` to `row-3`, with `x` set to 1 to 3. */
const threeRows = (pk: string) => fourRows(pk).slice(0, 3)

const KEYS = 'or-page-keys'
const MISSING = 'or-page-missing'
const SINGLE = 'or-page-single'
const IN = 'or-page-in'
const BOUNDS = 'or-page-bounds'
const UNION = 'or-page-union'
const NUMBERS = 'or-page-numbers'

const TABLE_ITEMS: Record<string, AttributeValue>[] = [
  ...fourRows(KEYS),
  ...fourRows(MISSING),
  ...fourRows(SINGLE),
  ...fourRows(IN),
  ...threeRows(BOUNDS),
  ...threeRows(UNION),
]
const NUMBER_ITEMS: Record<string, AttributeValue>[] = ['-1', '1.5', '2', '10'].map((n) => ({
  pk: { S: NUMBERS }, sk: { N: n },
}))

interface Page { items: string[]; token: boolean; cu: number | undefined }

const page = (items: string[], token: boolean, cu: number): Page => ({ items, token, cu })

/** More pages than any read here needs, so a token that never ends still stops. */
const MAX_PAGES = 8

/** Walk a statement page by page, recording each page's sort keys, token and cost. */
async function walk(
  Statement: string,
  opts: { Limit?: number; Parameters?: AttributeValue[] } = {},
): Promise<Page[]> {
  const pages: Page[] = []
  let NextToken: string | undefined
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await ddb.send(new ExecuteStatementCommand({
      Statement, ...opts, NextToken, ReturnConsumedCapacity: 'TOTAL',
    }))
    pages.push({
      items: (res.Items ?? []).map((it) => it.sk.S ?? it.sk.N!),
      token: res.NextToken !== undefined,
      cu: res.ConsumedCapacity?.CapacityUnits,
    })
    NextToken = res.NextToken
    if (!NextToken) break
  }
  return pages
}

/** Every row a walk returned, in sort order, duplicates kept. */
const rowsWalked = (pages: Page[]) => pages.flatMap((p) => p.items).sort()

/**
 * Wait until an eventually consistent read of a partition sees every row,
 * three reads running, so the walks below don't read a replica the writes
 * haven't reached yet.
 */
async function settle(table: string, pk: string, count: number): Promise<void> {
  let streak = 0
  for (let i = 0; i < 60 && streak < 3; i++) {
    const res = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${table}" WHERE pk = '${pk}'`,
    }))
    streak = (res.Items ?? []).length === count ? streak + 1 : 0
    if (streak < 3) await new Promise((r) => setTimeout(r, 250))
  }
}

describe('PartiQL - OR reads in one partition: paging', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-or-reads-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    for (const Item of TABLE_ITEMS) await ddb.send(new PutItemCommand({ TableName: T, Item }))
    for (const Item of NUMBER_ITEMS) await ddb.send(new PutItemCommand({ TableName: TN, Item }))
    for (const pk of [KEYS, MISSING, SINGLE, IN]) await settle(T, pk, 4)
    for (const pk of [BOUNDS, UNION]) await settle(T, pk, 3)
    await settle(TN, NUMBERS, 4)
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    await cleanupItems(T, TABLE_ITEMS.map(({ pk, sk }) => ({ pk, sk })))
    await cleanupItems(TN, NUMBER_ITEMS)
  })

  // A read of a fixed set of keys ends on the page that returns the last key.
  describe('a set of sort keys ends on its last key', () => {
    const P = KEYS

    it.each([
      ['one OR of sort-key equalities', `pk = '${P}' AND (sk = 'row-1' OR sk = 'row-2')`, undefined],
      ['two branches that each name the partition key', `(pk = '${P}' AND sk = 'row-1') OR (pk = '${P}' AND sk = 'row-2')`, undefined],
      ['parameters', `pk = ? AND (sk = ? OR sk = ?)`, [{ S: P }, { S: 'row-1' }, { S: 'row-2' }]],
    ])('two keys under Limit 1 take two pages, the second with no token, written as %s', async (_label, where, Parameters) => {
      expect(await walk(`SELECT * FROM "${T}" WHERE ${where}`, { Limit: 1, Parameters })).toEqual([
        page(['row-1'], true, 0.5),
        page(['row-2'], false, 0.5),
      ])
    })

    it.each([2, 3])('two keys under Limit %i come back on one page with no token', async (Limit) => {
      const pages = await walk(`SELECT * FROM "${T}" WHERE pk = '${P}' AND (sk = 'row-1' OR sk = 'row-2')`, { Limit })
      expect(pages.map(({ items, token }) => ({ items, token }))).toEqual([
        { items: ['row-1', 'row-2'], token: false },
      ])
    })

    it('three keys under Limit 2 take two pages, the second with no token', async () => {
      expect(await walk(
        `SELECT * FROM "${T}" WHERE pk = '${P}' AND (sk = 'row-1' OR sk = 'row-2' OR sk = 'row-3')`,
        { Limit: 2 },
      )).toEqual([
        page(['row-1', 'row-2'], true, 1),
        page(['row-3'], false, 0.5),
      ])
    })

    it('two keys read descending return the higher key first and end on the lower', async () => {
      expect(await walk(
        `SELECT * FROM "${T}" WHERE pk = '${P}' AND (sk = 'row-1' OR sk = 'row-2') ORDER BY sk DESC`,
        { Limit: 1 },
      )).toEqual([
        page(['row-2'], true, 0.5),
        page(['row-1'], false, 0.5),
      ])
    })

    it('two keys with a row between them read descending skip that row', async () => {
      expect(await walk(
        `SELECT * FROM "${T}" WHERE pk = '${P}' AND (sk = 'row-1' OR sk = 'row-3') ORDER BY sk DESC`,
        { Limit: 1 },
      )).toEqual([
        page(['row-3'], true, 0.5),
        page(['row-1'], false, 0.5),
      ])
    })
  })

  describe('number sort keys', () => {
    it.each([
      ['1.5 and 10', `sk = 1.5 OR sk = 10`, ['1.5', '10']],
      ['-1 and 1.5', `sk = -1 OR sk = 1.5`, ['-1', '1.5']],
    ])('keys %s under Limit 1 take two pages, the second with no token', async (_label, keys, [first, second]) => {
      expect(await walk(`SELECT * FROM "${TN}" WHERE pk = '${NUMBERS}' AND (${keys})`, { Limit: 1 })).toEqual([
        page([first], true, 0.5),
        page([second], false, 0.5),
      ])
    })
  })

  // Every requested key is charged half a unit whether or not it exists, on
  // the page that reaches it.
  describe('a missing key', () => {
    const P = MISSING

    it.each([
      ['ascending', `sk = 'row-1' OR sk = 'row-9'`, '', 'row-1'],
      ['descending', `sk = 'row-0' OR sk = 'row-2'`, ' ORDER BY sk DESC', 'row-2'],
    ])('a missing last key keeps the token for an empty half-unit page, %s', async (_label, keys, order, found) => {
      expect(await walk(`SELECT * FROM "${T}" WHERE pk = '${P}' AND (${keys})${order}`, { Limit: 1 })).toEqual([
        page([found], true, 0.5),
        page([], false, 0.5),
      ])
    })

    it.each([
      ['ascending', `sk = 'row-0' OR sk = 'row-2'`, '', 'row-2'],
      ['descending', `sk = 'row-1' OR sk = 'row-9'`, ' ORDER BY sk DESC', 'row-1'],
    ])('a missing first key gives one page with no token, charged for both keys, %s', async (_label, keys, order, found) => {
      expect(await walk(`SELECT * FROM "${T}" WHERE pk = '${P}' AND (${keys})${order}`, { Limit: 1 })).toEqual([
        page([found], false, 1),
      ])
    })

    it.each([
      ['ascending', '', ['row-1', 'row-2']],
      ['descending', ' ORDER BY sk DESC', ['row-2', 'row-1']],
    ])('a missing key between two found ones is charged on the second page, %s', async (_label, order, [first, second]) => {
      expect(await walk(
        `SELECT * FROM "${T}" WHERE pk = '${P}' AND (sk = 'row-1' OR sk = 'row-15' OR sk = 'row-2')${order}`,
        { Limit: 1 },
      )).toEqual([
        page([first], true, 0.5),
        page([second], false, 1),
      ])
    })
  })

  describe('a single key', () => {
    const P = SINGLE

    it.each([
      ['a full key', `pk = '${P}' AND sk = 'row-1'`, ['row-1']],
      ['a full key with a filter', `pk = '${P}' AND sk = 'row-1' AND x = 1`, ['row-1']],
      ['a single key read descending', `pk = '${P}' AND sk = 'row-2' ORDER BY sk DESC`, ['row-2']],
      ['a missing single key', `pk = '${P}' AND sk = 'row-9'`, []],
    ])('%s under Limit 1 gives one page with no token', async (_label, where, items) => {
      expect(await walk(`SELECT * FROM "${T}" WHERE ${where}`, { Limit: 1 })).toEqual([
        page(items, false, 0.5),
      ])
    })
  })

  // A sort-key IN pages the way the equivalent OR does.
  describe('a sort-key IN', () => {
    const P = IN

    it('two found keys under Limit 1 take two pages, the second with no token', async () => {
      expect(await walk(`SELECT * FROM "${T}" WHERE pk = '${P}' AND sk IN ['row-1', 'row-3']`, { Limit: 1 })).toEqual([
        page(['row-1'], true, 0.5),
        page(['row-3'], false, 0.5),
      ])
    })

    it('a missing last key keeps the token for an empty half-unit page', async () => {
      expect(await walk(`SELECT * FROM "${T}" WHERE pk = '${P}' AND sk IN ['row-1', 'row-9']`, { Limit: 1 })).toEqual([
        page(['row-1'], true, 0.5),
        page([], false, 0.5),
      ])
    })

    it('read descending returns the higher key first', async () => {
      expect(await walk(
        `SELECT * FROM "${T}" WHERE pk = '${P}' AND sk IN ['row-1', 'row-3'] ORDER BY sk DESC`,
        { Limit: 1 },
      )).toEqual([
        page(['row-3'], true, 0.5),
        page(['row-1'], false, 0.5),
      ])
    })
  })

  // A page that ends on a closed bound ends the read, even with rows beyond
  // the bound. A branch the read hasn't reached yet holds the token.
  describe('ranges with closed bounds', () => {
    const P = BOUNDS

    it.each([
      ['BETWEEN under Limit 1', `sk BETWEEN 'row-1' AND 'row-2'`, 1, [page(['row-1'], true, 0.5), page(['row-2'], false, 0.5)]],
      ['<= under Limit 2', `sk <= 'row-2'`, 2, [page(['row-1', 'row-2'], false, 0.5)]],
      ['BETWEEN over three rows under Limit 3', `sk BETWEEN 'row-1' AND 'row-3'`, 3, [page(['row-1', 'row-2', 'row-3'], false, 0.5)]],
      ['>= read descending under Limit 1', `sk >= 'row-2' ORDER BY sk DESC`, 1, [page(['row-3'], true, 0.5), page(['row-2'], false, 0.5)]],
      [
        'a union of two closed ranges under Limit 1',
        `(sk BETWEEN 'row-0' AND 'row-1' OR sk BETWEEN 'row-3' AND 'row-3')`,
        1,
        [page(['row-1'], true, 0.5), page(['row-3'], false, 0.5)],
      ],
    ])('%s ends on the bound with no trailing empty page', async (_label, cond, Limit, expected) => {
      expect(await walk(`SELECT * FROM "${T}" WHERE pk = '${P}' AND ${cond}`, { Limit })).toEqual(expected)
    })

    it('an empty branch the read has not reached keeps the token for an empty page', async () => {
      expect(await walk(
        `SELECT * FROM "${T}" WHERE pk = '${P}' AND (sk BETWEEN 'row-0' AND 'row-1' OR sk BETWEEN 'x' AND 'y')`,
        { Limit: 1 },
      )).toEqual([
        page(['row-1'], true, 0.5),
        page([], false, 0.5),
      ])
    })
  })

  // These end inside an open range or on a non-key filter, where DynamoDB may
  // or may not add an empty last page. Only the rows walked are pinned.
  describe('reads whose last page varies', () => {
    const P = UNION

    it.each([
      ['two open ranges under Limit 1', `(sk < 'row-2' OR sk > 'row-2')`, 1, ['row-1', 'row-3']],
      ['an equality and an open range under Limit 1', `(sk = 'row-1' OR sk > 'row-2')`, 1, ['row-1', 'row-3']],
      ['an OR filter on a non-key attribute under Limit 2', `(x = 1 OR x = 2)`, 2, ['row-1', 'row-2']],
    ])('%s returns exactly its rows across the walk', async (_label, cond, Limit, expected) => {
      const pages = await walk(`SELECT * FROM "${T}" WHERE pk = '${P}' AND ${cond}`, { Limit })
      expect(rowsWalked(pages)).toEqual(expected)
    })
  })
})
