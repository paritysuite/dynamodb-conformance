import {
  BatchExecuteStatementCommand,
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

// PartiQL's FROM-first form of UPDATE: `FROM "T" WHERE <key> SET ...` or
// `... REMOVE ...`, with the clauses in that order. DynamoDB runs it as an
// UPDATE of the item the WHERE names: a key that matches no item fails with
// ConditionalCheckFailedException, a further condition in the WHERE is a
// condition on the write, RETURNING works, and so do parameters,
// ExecuteTransaction and BatchExecuteStatement. Verified against real AWS
// (eu-west-2, October 2026; us-east-1, eu-west-1 and us-west-2 gave the same
// answers). The refusals (no WHERE, a non-key WHERE, a WHERE after SET) are
// pinned in tests/tier3/error-messages/partiqlGrammar.test.ts.
//
// no negative-path: acceptance-mixed (asserts accepted forms and conditional-check failures)
describe('PartiQL - FROM-first UPDATE', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true
  const T = hashTableDef.name
  const used: string[] = []

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-from-first-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    await cleanupItems(T, used.map((pk) => ({ pk: { S: pk } })))
  })

  async function seed(pk: string): Promise<string> {
    used.push(pk)
    await ddb.send(new PutItemCommand({ TableName: T, Item: { pk: { S: pk }, a: { N: '1' }, b: { S: 'bee' } } }))
    return pk
  }

  async function stored(pk: string): Promise<Record<string, AttributeValue> | undefined> {
    const res = await ddb.send(new GetItemCommand({ TableName: T, Key: { pk: { S: pk } }, ConsistentRead: true }))
    return res.Item
  }

  function run(Statement: string, Parameters?: AttributeValue[]) {
    return ddb.send(new ExecuteStatementCommand({ Statement, ...(Parameters ? { Parameters } : {}) }))
  }

  it('FROM ... WHERE ... SET updates the item', async () => {
    const pk = await seed('pq-ff-set')
    await run(`FROM "${T}" WHERE pk = '${pk}' SET c = 1`)
    expect((await stored(pk))?.c).toEqual({ N: '1' })
  })

  it('FROM ... WHERE ... REMOVE removes the attribute', async () => {
    const pk = await seed('pq-ff-remove')
    await run(`FROM "${T}" WHERE pk = '${pk}' REMOVE b`)
    expect((await stored(pk))?.b).toBeUndefined()
  })

  it('SET and REMOVE can follow each other', async () => {
    const pk = await seed('pq-ff-set-remove')
    await run(`FROM "${T}" WHERE pk = '${pk}' SET c = 2 REMOVE a`)
    const item = await stored(pk)
    expect(item?.c).toEqual({ N: '2' })
    expect(item?.a).toBeUndefined()
  })

  it('RETURNING ALL NEW * returns the updated item', async () => {
    const pk = await seed('pq-ff-returning')
    const res = await run(`FROM "${T}" WHERE pk = '${pk}' SET d = 3 RETURNING ALL NEW *`)
    expect(res.Items).toEqual([{ pk: { S: pk }, a: { N: '1' }, b: { S: 'bee' }, d: { N: '3' } }])
  })

  it('the keywords are case-insensitive', async () => {
    const pk = await seed('pq-ff-lower')
    await run(`from "${T}" where pk = '${pk}' set e = 4`)
    expect((await stored(pk))?.e).toEqual({ N: '4' })
  })

  it('takes parameters', async () => {
    const pk = await seed('pq-ff-params')
    await run(`FROM "${T}" WHERE pk = ? SET c = ?`, [{ S: pk }, { N: '7' }])
    expect((await stored(pk))?.c).toEqual({ N: '7' })
  })

  it('a further condition in the WHERE that holds lets the update through', async () => {
    const pk = await seed('pq-ff-condition')
    await run(`FROM "${T}" WHERE pk = '${pk}' AND a = 1 SET c = 5`)
    expect((await stored(pk))?.c).toEqual({ N: '5' })
  })

  it('a further condition in the WHERE that fails stops the update', async () => {
    const pk = await seed('pq-ff-condition-fails')
    await expectDynamoError(
      () => run(`FROM "${T}" WHERE pk = '${pk}' AND a = 2 SET c = 5`),
      'ConditionalCheckFailedException',
    )
    expect((await stored(pk))?.c).toBeUndefined()
  })

  it('a key that matches no item fails its condition and creates nothing', async () => {
    used.push('pq-ff-absent')
    await expectDynamoError(
      () => run(`FROM "${T}" WHERE pk = 'pq-ff-absent' SET c = 1`),
      'ConditionalCheckFailedException',
    )
    expect(await stored('pq-ff-absent')).toBeUndefined()
  })

  it('ExecuteTransaction runs it', async () => {
    const pk = await seed('pq-ff-tx')
    await ddb.send(new ExecuteTransactionCommand({
      TransactStatements: [{ Statement: `FROM "${T}" WHERE pk = '${pk}' SET c = 1` }],
    }))
    expect((await stored(pk))?.c).toEqual({ N: '1' })
  })

  it('BatchExecuteStatement runs it', async () => {
    const pk = await seed('pq-ff-batch')
    const res = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [{ Statement: `FROM "${T}" WHERE pk = '${pk}' SET c = 1` }],
    }))
    expect(res.Responses).toHaveLength(1)
    expect(res.Responses![0].Error).toBeUndefined()
    expect((await stored(pk))?.c).toEqual({ N: '1' })
  })
})
