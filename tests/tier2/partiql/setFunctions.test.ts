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

// set_add and set_delete in a PartiQL UPDATE. DynamoDB reads
// `SET a = set_add(a, <<...>>)` as adding members to the set `a` holds, and
// set_delete as removing them: adding to a missing attribute creates the set,
// removing every member removes the attribute, and adding a member already
// there or removing one that isn't changes nothing. The function name is
// case-insensitive, a parameter can carry the set, and ExecuteTransaction and
// BatchExecuteStatement run it too. Verified against real AWS (eu-west-2,
// October 2026; us-east-1, eu-west-1 and us-west-2 gave the same answers).
// The refusals are pinned in tests/tier3/error-messages/partiqlFunctions.test.ts.
//
// Set members are compared sorted: the order a set reads back in is not what
// this file is about.
//
// no negative-path: acceptance-mixed (asserts accepted forms and conditional-check failures)
describe('PartiQL - set_add and set_delete', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true
  const T = hashTableDef.name
  const used: string[] = []

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-set-functions-canary'`,
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

  /** Seed an item holding a string, number and binary set, and return its key. */
  async function seed(pk: string): Promise<string> {
    used.push(pk)
    await ddb.send(new PutItemCommand({
      TableName: T,
      Item: {
        pk: { S: pk },
        ss: { SS: ['a', 'b', 'c'] },
        ns: { NS: ['1', '2', '3'] },
        bs: { BS: [Buffer.from('AQ==', 'base64'), Buffer.from('Ag==', 'base64')] },
        s: { S: 'str' },
      },
    }))
    return pk
  }

  async function stored(pk: string) {
    const res = await ddb.send(new GetItemCommand({ TableName: T, Key: { pk: { S: pk } }, ConsistentRead: true }))
    return res.Item!
  }

  function run(Statement: string, Parameters?: AttributeValue[]) {
    return ddb.send(new ExecuteStatementCommand({ Statement, ...(Parameters ? { Parameters } : {}) }))
  }

  const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort()
  const numbers = (xs: string[] | undefined) => [...(xs ?? [])].map(Number).sort((a, b) => a - b)
  const base64 = (xs: Uint8Array[] | undefined) => [...(xs ?? [])].map((b) => Buffer.from(b).toString('base64')).sort()

  // ── set_add ──────────────────────────────────────────────────────────

  it('set_add adds members to a string set', async () => {
    const pk = await seed('pq-set-add-ss')
    await run(`UPDATE "${T}" SET ss = set_add(ss, <<'0', 'z'>>) WHERE pk = '${pk}'`)
    expect(sorted((await stored(pk)).ss.SS)).toEqual(['0', 'a', 'b', 'c', 'z'])
  })

  it('set_add adds members to a number set', async () => {
    const pk = await seed('pq-set-add-ns')
    await run(`UPDATE "${T}" SET ns = set_add(ns, <<4, 1>>) WHERE pk = '${pk}'`)
    expect(numbers((await stored(pk)).ns.NS)).toEqual([1, 2, 3, 4])
  })

  it('set_add takes the set to add as a parameter', async () => {
    const pk = await seed('pq-set-add-param')
    await run(`UPDATE "${T}" SET bs = set_add(bs, ?) WHERE pk = '${pk}'`, [
      { BS: [Buffer.from('AQ==', 'base64'), Buffer.from('Aw==', 'base64')] },
    ])
    expect(base64((await stored(pk)).bs.BS)).toEqual(['AQ==', 'Ag==', 'Aw=='])
  })

  it('set_add of a member already in the set changes nothing', async () => {
    const pk = await seed('pq-set-add-existing')
    await run(`UPDATE "${T}" SET ss = set_add(ss, <<'a'>>) WHERE pk = '${pk}'`)
    expect(sorted((await stored(pk)).ss.SS)).toEqual(['a', 'b', 'c'])
  })

  it('set_add to a missing attribute creates the set', async () => {
    const pk = await seed('pq-set-add-new')
    await run(`UPDATE "${T}" SET nss = set_add(nss, <<'x'>>) WHERE pk = '${pk}'`)
    expect((await stored(pk)).nss).toEqual({ SS: ['x'] })
  })

  it('the function name is case-insensitive', async () => {
    const pk = await seed('pq-set-add-upper')
    await run(`UPDATE "${T}" SET ss = SET_ADD(ss, <<'x'>>) WHERE pk = '${pk}'`)
    expect(sorted((await stored(pk)).ss.SS)).toEqual(['a', 'b', 'c', 'x'])
  })

  it('two SET clauses can each call set_add', async () => {
    const pk = await seed('pq-set-add-two')
    await run(`UPDATE "${T}" SET ss = set_add(ss, <<'x'>>) SET ns = set_add(ns, <<9>>) WHERE pk = '${pk}'`)
    const item = await stored(pk)
    expect(sorted(item.ss.SS)).toEqual(['a', 'b', 'c', 'x'])
    expect(numbers(item.ns.NS)).toEqual([1, 2, 3, 9])
  })

  it('RETURNING ALL NEW * returns the set after the addition', async () => {
    const pk = await seed('pq-set-add-returning')
    const res = await run(`UPDATE "${T}" SET ss = set_add(ss, <<'r'>>) WHERE pk = '${pk}' RETURNING ALL NEW *`)
    expect(res.Items).toHaveLength(1)
    expect(sorted(res.Items![0].ss.SS)).toEqual(['a', 'b', 'c', 'r'])
  })

  it('set_add on a missing item fails its condition and creates nothing', async () => {
    used.push('pq-set-add-absent')
    await expectDynamoError(
      () => run(`UPDATE "${T}" SET ss = set_add(ss, <<'x'>>) WHERE pk = 'pq-set-add-absent'`),
      'ConditionalCheckFailedException',
    )
    const res = await ddb.send(new GetItemCommand({ TableName: T, Key: { pk: { S: 'pq-set-add-absent' } }, ConsistentRead: true }))
    expect(res.Item).toBeUndefined()
  })

  // ── set_delete ───────────────────────────────────────────────────────

  it('set_delete removes a member', async () => {
    const pk = await seed('pq-set-del-one')
    await run(`UPDATE "${T}" SET ss = set_delete(ss, <<'a'>>) WHERE pk = '${pk}'`)
    expect(sorted((await stored(pk)).ss.SS)).toEqual(['b', 'c'])
  })

  it('set_delete removes a member from a number set', async () => {
    const pk = await seed('pq-set-del-ns')
    await run(`UPDATE "${T}" SET ns = set_delete(ns, <<2>>) WHERE pk = '${pk}'`)
    expect(numbers((await stored(pk)).ns.NS)).toEqual([1, 3])
  })

  it('removing every member removes the attribute', async () => {
    const pk = await seed('pq-set-del-all')
    await run(`UPDATE "${T}" SET ss = set_delete(ss, <<'a', 'b', 'c'>>) WHERE pk = '${pk}'`)
    expect((await stored(pk)).ss).toBeUndefined()
  })

  it('removing a member that is not there changes nothing', async () => {
    const pk = await seed('pq-set-del-absent-member')
    await run(`UPDATE "${T}" SET ss = set_delete(ss, <<'zz'>>) WHERE pk = '${pk}'`)
    expect(sorted((await stored(pk)).ss.SS)).toEqual(['a', 'b', 'c'])
  })

  it('set_delete on a missing attribute leaves it missing', async () => {
    const pk = await seed('pq-set-del-missing-attr')
    await run(`UPDATE "${T}" SET nss = set_delete(nss, <<'a'>>) WHERE pk = '${pk}'`)
    expect((await stored(pk)).nss).toBeUndefined()
  })

  // ── In ExecuteTransaction and BatchExecuteStatement ──────────────────

  it('ExecuteTransaction runs set_add', async () => {
    const pk = await seed('pq-set-add-tx')
    await ddb.send(new ExecuteTransactionCommand({
      TransactStatements: [{ Statement: `UPDATE "${T}" SET ss = set_add(ss, <<'t'>>) WHERE pk = '${pk}'` }],
    }))
    expect(sorted((await stored(pk)).ss.SS)).toEqual(['a', 'b', 'c', 't'])
  })

  it('BatchExecuteStatement runs set_add', async () => {
    const pk = await seed('pq-set-add-batch')
    const res = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [{ Statement: `UPDATE "${T}" SET ss = set_add(ss, <<'t'>>) WHERE pk = '${pk}'` }],
    }))
    expect(res.Responses).toHaveLength(1)
    expect(res.Responses![0].Error).toBeUndefined()
    expect(sorted((await stored(pk)).ss.SS)).toEqual(['a', 'b', 'c', 't'])
  })
})
