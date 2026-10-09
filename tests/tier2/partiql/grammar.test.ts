import {
  ExecuteStatementCommand,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import {
  declareTables,
  hashTableDef,
  hashNTableDef,
  compositeNTableDef,
  cleanupItems,
  expectDynamoError,
} from '../../../src/helpers.js'

declareTables(hashTableDef, hashNTableDef, compositeNTableDef)

// How DynamoDB's PartiQL parser reads the forms a statement can take beyond the
// basics: number literals written with an exponent or without a leading digit,
// comments, ORDER BY, and the refusals that keep a malformed statement from
// running as something else. Verified against real AWS (eu-west-2, October
// 2026). The exact rejection strings are pinned in
// tests/tier3/error-messages/partiqlGrammar.test.ts; this file asserts what
// runs, what comes back, and that a refused statement changes nothing.
//
// no negative-path: acceptance-mixed (asserts accepted and rejected forms)
describe('PartiQL - grammar', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true
  const S = hashTableDef.name
  const N = hashNTableDef.name
  const SN = compositeNTableDef.name

  const numberKeys = ['7310000', '7.3', '-7.3'].map((n) => ({ pk: { N: n } }))
  const insertedNumberKeys = ['7320000', '7.325'].map((n) => ({ pk: { N: n } }))
  const stringKeys = ['pq-grammar-a', 'pq-grammar-b', 'pq-grammar-c'].map((s) => ({ pk: { S: s } }))
  const orderKeys = ['1', '2', '3'].map((n) => ({ pk: { S: 'pq-grammar-order' }, sk: { N: n } }))

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${S}" WHERE pk = 'partiql-grammar-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    for (const key of numberKeys) {
      await ddb.send(new PutItemCommand({ TableName: N, Item: { ...key, tag: { S: 'grammar' } } }))
    }
    for (const key of stringKeys) {
      await ddb.send(new PutItemCommand({ TableName: S, Item: { ...key, tag: { S: 'grammar' } } }))
    }
    for (const key of orderKeys) {
      await ddb.send(new PutItemCommand({ TableName: SN, Item: key }))
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    await cleanupItems(N, [...numberKeys, ...insertedNumberKeys])
    await cleanupItems(S, stringKeys)
    await cleanupItems(SN, orderKeys)
  })

  async function select(Statement: string): Promise<Record<string, AttributeValue>[]> {
    const res = await ddb.send(new ExecuteStatementCommand({ Statement, ConsistentRead: true }))
    return res.Items ?? []
  }

  async function stored(TableName: string, Key: Record<string, AttributeValue>) {
    const res = await ddb.send(new GetItemCommand({ TableName, Key, ConsistentRead: true }))
    return res.Item
  }

  // ── Number literals ──────────────────────────────────────────────────

  it('an exponent literal in WHERE matches the number it denotes', async () => {
    const items = await select(`SELECT * FROM "${N}" WHERE pk = 7.31e6`)
    expect(items).toHaveLength(1)
    expect(items[0].pk).toEqual({ N: '7310000' })
  })

  it('an upper-case E, an explicit sign and a shifted mantissa all match the same number', async () => {
    for (const literal of ['7.31E6', '7.31e+6', '731e4', '73100000e-1']) {
      const items = await select(`SELECT * FROM "${N}" WHERE pk = ${literal}`)
      expect(items, literal).toHaveLength(1)
      expect(items[0].pk, literal).toEqual({ N: '7310000' })
    }
  })

  it('an exponent literal in an INSERT stores the number it denotes', async () => {
    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${N}" VALUE {'pk': 7.32e6, 'tag': 'grammar'}`,
    }))
    expect(await stored(N, { pk: { N: '7320000' } })).toBeDefined()
  })

  it('a number with no leading digit matches in WHERE', async () => {
    const items = await select(`SELECT * FROM "${N}" WHERE pk = .73e1`)
    expect(items).toHaveLength(1)
    expect(items[0].pk).toEqual({ N: '7.3' })
  })

  it('a negative number with no leading digit matches in WHERE', async () => {
    const items = await select(`SELECT * FROM "${N}" WHERE pk = -.73e1`)
    expect(items).toHaveLength(1)
    expect(items[0].pk).toEqual({ N: '-7.3' })
  })

  it('a number with no leading digit in an INSERT stores the number it denotes', async () => {
    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${N}" VALUE {'pk': .7325e1, 'tag': 'grammar'}`,
    }))
    expect(await stored(N, { pk: { N: '7.325' } })).toBeDefined()
  })

  it('an exponent that does not fit a 32-bit integer is refused', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "${N}" WHERE pk = 1e99999999999` })),
      'ValidationException',
    )
  })

  // ── Comments ─────────────────────────────────────────────────────────

  it('a line comment after the statement is ignored', async () => {
    const items = await select(`SELECT * FROM "${S}" WHERE pk = 'pq-grammar-a' -- a note`)
    expect(items).toHaveLength(1)
    expect(items[0].pk).toEqual({ S: 'pq-grammar-a' })
  })

  it('a line comment between FROM and WHERE leaves the WHERE clause in force', async () => {
    // Read as anything other than whitespace, the comment would either refuse
    // the statement or swallow the WHERE clause and return every row.
    const items = await select(`SELECT * FROM "${S}" -- a note\nWHERE pk = 'pq-grammar-b'`)
    expect(items).toHaveLength(1)
    expect(items[0].pk).toEqual({ S: 'pq-grammar-b' })
  })

  it('a line comment before the statement is ignored', async () => {
    const items = await select(`-- a note\nSELECT * FROM "${S}" WHERE pk = 'pq-grammar-a'`)
    expect(items).toHaveLength(1)
  })

  it('a block comment between clauses is ignored', async () => {
    const items = await select(`SELECT * FROM "${S}" /* a note */ WHERE pk = 'pq-grammar-c'`)
    expect(items).toHaveLength(1)
    expect(items[0].pk).toEqual({ S: 'pq-grammar-c' })
  })

  it('a block comment after the statement is ignored', async () => {
    const items = await select(`SELECT * FROM "${S}" WHERE pk = 'pq-grammar-c' /* a note */`)
    expect(items).toHaveLength(1)
  })

  it('a hash comment is refused', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "${S}" WHERE pk = 'pq-grammar-a' # a note` })),
      'ValidationException',
    )
  })

  // ── ORDER BY ─────────────────────────────────────────────────────────

  it('ORDER BY the sort key DESC returns the rows in descending order', async () => {
    const items = await select(`SELECT * FROM "${SN}" WHERE pk = 'pq-grammar-order' ORDER BY sk DESC`)
    expect(items.map((i) => i.sk.N)).toEqual(['3', '2', '1'])
  })

  it('ORDER BY the sort key ASC returns the rows in ascending order', async () => {
    const items = await select(`SELECT * FROM "${SN}" WHERE pk = 'pq-grammar-order' ORDER BY sk ASC`)
    expect(items.map((i) => i.sk.N)).toEqual(['1', '2', '3'])
  })

  // ── Refusals that must not run as something else ────────────────────

  it('an INSERT with a token left over is refused and writes nothing', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({ Statement: `INSERT INTO "${N}" VALUE {'pk': 7330000} foo` })),
      'ValidationException',
    )
    expect(await stored(N, { pk: { N: '7330000' } })).toBeUndefined()
  })

  it('a SELECT with a table alias is refused rather than read without its WHERE clause', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "${S}" t WHERE pk = 'pq-grammar-a'` })),
      'ValidationException',
    )
  })

  it('a DELETE with a table alias is refused and deletes nothing', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({ Statement: `DELETE FROM "${S}" t WHERE pk = 'pq-grammar-a'` })),
      'ValidationException',
    )
    expect(await stored(S, { pk: { S: 'pq-grammar-a' } })).toBeDefined()
  })

  it('a DELETE with ORDER BY is refused and deletes nothing', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({ Statement: `DELETE FROM "${S}" WHERE pk = 'pq-grammar-b' ORDER BY pk` })),
      'ValidationException',
    )
    expect(await stored(S, { pk: { S: 'pq-grammar-b' } })).toBeDefined()
  })
})
