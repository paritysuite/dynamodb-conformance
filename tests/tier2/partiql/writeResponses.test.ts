import {
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, hashTableDef, cleanupItems } from '../../../src/helpers.js'

declareTables(hashTableDef)

// What a successful PartiQL write answers with. Through ExecuteStatement, an
// INSERT, UPDATE or DELETE without a RETURNING clause comes back with an empty
// Items list, whether or not the DELETE found an item. An ExecuteTransaction
// of writes comes back with an empty Responses list, not one entry per
// statement; a transaction of reads still has one entry per statement.
// Verified against real AWS (eu-west-2, October 2026; us-east-1, eu-west-1 and
// us-west-2 gave the same answers).
describe('PartiQL - responses to writes', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true
  const T = hashTableDef.name
  const keys = ['pq-wr-insert', 'pq-wr-update', 'pq-wr-delete', 'pq-wr-tx-a', 'pq-wr-tx-b', 'pq-wr-tx-new', 'pq-wr-tx-c']

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-write-responses-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    for (const pk of ['pq-wr-update', 'pq-wr-delete', 'pq-wr-tx-a', 'pq-wr-tx-b', 'pq-wr-tx-c']) {
      await ddb.send(new PutItemCommand({ TableName: T, Item: { pk: { S: pk }, a: { N: '1' } } }))
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    await cleanupItems(T, keys.map((pk) => ({ pk: { S: pk } })))
  })

  function run(Statement: string) {
    return ddb.send(new ExecuteStatementCommand({ Statement }))
  }

  // ── ExecuteStatement ─────────────────────────────────────────────────

  it('an INSERT returns an empty Items list', async () => {
    const res = await run(`INSERT INTO "${T}" VALUE {'pk': 'pq-wr-insert'}`)
    expect(res.Items).toEqual([])
  })

  it('an UPDATE returns an empty Items list', async () => {
    const res = await run(`UPDATE "${T}" SET a = 2 WHERE pk = 'pq-wr-update'`)
    expect(res.Items).toEqual([])
  })

  it('a DELETE that removes an item returns an empty Items list', async () => {
    const res = await run(`DELETE FROM "${T}" WHERE pk = 'pq-wr-delete'`)
    expect(res.Items).toEqual([])
  })

  it('a DELETE that finds no item returns an empty Items list', async () => {
    const res = await run(`DELETE FROM "${T}" WHERE pk = 'pq-wr-never-written'`)
    expect(res.Items).toEqual([])
  })

  // ── ExecuteTransaction ───────────────────────────────────────────────

  it('a transaction of updates returns an empty Responses list', async () => {
    const res = await ddb.send(new ExecuteTransactionCommand({
      TransactStatements: [
        { Statement: `UPDATE "${T}" SET a = 2 WHERE pk = 'pq-wr-tx-a'` },
        { Statement: `UPDATE "${T}" SET a = 2 WHERE pk = 'pq-wr-tx-b'` },
      ],
    }))
    expect(res.Responses).toEqual([])
  })

  it('a transaction of an INSERT and a DELETE returns an empty Responses list', async () => {
    const res = await ddb.send(new ExecuteTransactionCommand({
      TransactStatements: [
        { Statement: `INSERT INTO "${T}" VALUE {'pk': 'pq-wr-tx-new'}` },
        { Statement: `DELETE FROM "${T}" WHERE pk = 'pq-wr-tx-c'` },
      ],
    }))
    expect(res.Responses).toEqual([])
  })

  it('a transaction of writes asked for its capacity returns it beside an empty Responses list', async () => {
    const res = await ddb.send(new ExecuteTransactionCommand({
      TransactStatements: [{ Statement: `UPDATE "${T}" SET a = 3 WHERE pk = 'pq-wr-tx-a'` }],
      ReturnConsumedCapacity: 'TOTAL',
    }))
    expect(res.Responses).toEqual([])
    expect(res.ConsumedCapacity).toHaveLength(1)
    expect(res.ConsumedCapacity![0].TableName).toBe(T)
  })
})
