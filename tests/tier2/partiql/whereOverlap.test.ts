import { ExecuteStatementCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, compositeTableDef, cleanupItems } from '../../../src/helpers.js'

declareTables(compositeTableDef)

// DynamoDB refuses a PartiQL SELECT whose OR branches overlap on the sort key
// ("Overlapping conditions with range keys are not supported in where clause"),
// but it does not apply that refusal to a branch whose sort-key condition is
// negated or written with <>: those statements run, and return the union of
// what each branch selects. Verified against real AWS (eu-west-2, October 2026;
// us-east-1 gave the same answers). The refusal itself is pinned in
// tests/tier3/error-messages/partiqlGrammar.test.ts.
describe('PartiQL - OR branches with a negated sort-key condition', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true
  const T = compositeTableDef.name
  const PK = 'pq-overlap'
  const items = ['1', '2', '3'].map((sk) => ({ pk: { S: PK }, sk: { S: sk } }))

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-overlap-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    for (const item of items) await ddb.send(new PutItemCommand({ TableName: T, Item: item }))
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    await cleanupItems(T, items)
  })

  async function sortKeys(where: string): Promise<string[]> {
    const res = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${T}" WHERE ${where}`,
      ConsistentRead: true,
    }))
    return (res.Items ?? []).map((i) => i.sk.S!).sort()
  }

  it.each([
    ['NOT sk = ...', `pk = '${PK}' AND NOT sk = '1'`, ['2', '3']],
    ['sk <> ...', `pk = '${PK}' AND sk <> '1'`, ['2', '3']],
    ['NOT begins_with', `pk = '${PK}' AND NOT begins_with(sk, 'x')`, ['1', '2', '3']],
    ['NOT sk IN', `pk = '${PK}' AND NOT sk IN ['1', '3']`, ['2']],
    ['NOT sk > ...', `pk = '${PK}' AND NOT sk > '5'`, ['1', '2', '3']],
    ['NOT (sk = ...)', `pk = '${PK}' AND NOT (sk = '1')`, ['2', '3']],
  ])('a branch with %s beside an equality branch runs', async (_label, left, expected) => {
    expect(await sortKeys(`${left} OR pk = '${PK}' AND sk = '2'`)).toEqual(expected)
  })

  it('a bare partition branch beside one with a negated sort key runs', async () => {
    expect(await sortKeys(`pk = '${PK}' OR pk = '${PK}' AND NOT sk = '1'`)).toEqual(['1', '2', '3'])
  })
})
