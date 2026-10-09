import {
  CreateTableCommand,
  ExecuteStatementCommand,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import {
  uniqueTableName,
  waitUntilActive,
  deleteTable,
  waitForGsiConsistency,
  expectDynamoError,
} from '../../../src/helpers.js'

// PartiQL refuses to read a global secondary index whose key has more than one
// HASH or more than one RANGE attribute (multi-attribute keys). Verified against
// real AWS (eu-west-2 and us-east-1, October 2026).
//
// The refusal follows the index, not the table, despite its wording: on the same
// table the base table, a single-attribute GSI and an LSI all read, and base
// table writes run. tests/tier3/error-messages/partiqlMultiAttributeIndex.test.ts
// pins the wording and where the refusal sits against the other checks.
//
// The tables are created here rather than from a shared def: TestTableDef models
// one HASH and one RANGE attribute per index.
//
// no negative-path: acceptance-mixed (asserts refused and accepted statements)
describe('PartiQL - GSI with a multi-attribute key', { tags: ['partiql', 'data-plane', 'gsi', 'lsi'] }, () => {
  let supported = true
  const S = (s: string): AttributeValue => ({ S: s })

  // Two HASH and two RANGE attributes, and nothing else on the table.
  const multiTable = uniqueTableName('pqMultiKey')
  // A table with a single-attribute GSI, a multi-attribute GSI (two HASH, one
  // RANGE) and an LSI side by side.
  const mixedTable = uniqueTableName('pqMultiMixed')

  const strings = (names: string[]) => names.map((AttributeName) => ({ AttributeName, AttributeType: 'S' as const }))

  const multiDef: CreateTableCommandInput = {
    TableName: multiTable,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: strings(['id', 'h1', 'h2', 'r1', 'r2']),
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [{
      IndexName: 'gsi',
      KeySchema: [
        { AttributeName: 'h1', KeyType: 'HASH' },
        { AttributeName: 'h2', KeyType: 'HASH' },
        { AttributeName: 'r1', KeyType: 'RANGE' },
        { AttributeName: 'r2', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    }],
  }

  const mixedDef: CreateTableCommandInput = {
    TableName: mixedTable,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: strings(['id', 'sk', 'g', 'h1', 'h2', 'r1', 'l']),
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    GlobalSecondaryIndexes: [
      { IndexName: 'single', KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } },
      {
        IndexName: 'multi',
        KeySchema: [
          { AttributeName: 'h1', KeyType: 'HASH' },
          { AttributeName: 'h2', KeyType: 'HASH' },
          { AttributeName: 'r1', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    LocalSecondaryIndexes: [{
      IndexName: 'local',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }, { AttributeName: 'l', KeyType: 'RANGE' }],
      Projection: { ProjectionType: 'ALL' },
    }],
  }

  beforeAll(async () => {
    try {
      // The canary the other PartiQL files run, against a table that doesn't
      // exist yet: a target signalling the operation is unimplemented skips
      // rather than failing every case.
      await ddb.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "${multiTable}" WHERE id = 'canary'` }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    await Promise.all([ddb.send(new CreateTableCommand(multiDef)), ddb.send(new CreateTableCommand(mixedDef))])
    await Promise.all([waitUntilActive(multiTable), waitUntilActive(mixedTable)])
    await ddb.send(new PutItemCommand({
      TableName: multiTable,
      Item: { id: S('i1'), h1: S('a'), h2: S('x'), r1: S('m'), r2: S('n') },
    }))
    await ddb.send(new PutItemCommand({
      TableName: mixedTable,
      Item: { id: S('i1'), sk: S('s'), g: S('g1'), h1: S('a'), h2: S('x'), r1: S('m'), l: S('l1') },
    }))
    await waitForGsiConsistency({
      tableName: mixedTable,
      indexName: 'single',
      partitionKey: { name: 'g', value: S('g1') },
      expectedCount: 1,
    })
  })

  afterAll(async () => {
    if (!supported) return
    await Promise.all([deleteTable(multiTable), deleteTable(mixedTable)])
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  async function select(Statement: string) {
    const res = await ddb.send(new ExecuteStatementCommand({ Statement }))
    return res.Items ?? []
  }

  // ── The multi-attribute index refuses ─────────────────────────────────

  it('a SELECT on a GSI with two HASH and two RANGE attributes is refused', async () => {
    await expectDynamoError(
      () => select(`SELECT * FROM "${multiTable}"."gsi" WHERE h1 = 'a'`),
      'ValidationException',
    )
  })

  it('a SELECT with ORDER BY on that index is refused too', async () => {
    await expectDynamoError(
      () => select(`SELECT id FROM "${multiTable}"."gsi" WHERE h1 = 'a' AND h2 = 'x' ORDER BY r1 DESC`),
      'ValidationException',
    )
  })

  it('a SELECT on a GSI with two HASH attributes and one RANGE is refused', async () => {
    await expectDynamoError(
      () => select(`SELECT * FROM "${mixedTable}"."multi" WHERE h1 = 'a' AND h2 = 'x'`),
      'ValidationException',
    )
  })

  // ── The rest of the table is unaffected ───────────────────────────────

  it('the same table\'s base table, single-attribute GSI and LSI still read', async () => {
    expect(await select(`SELECT * FROM "${mixedTable}" WHERE id = 'i1'`)).toHaveLength(1)
    expect(await select(`SELECT * FROM "${mixedTable}"."single" WHERE g = 'g1'`)).toHaveLength(1)
    expect(await select(`SELECT * FROM "${mixedTable}"."local" WHERE id = 'i1'`)).toHaveLength(1)
  })

  it('base table SELECT, INSERT, UPDATE and DELETE run on a table whose GSI is multi-attribute', async () => {
    expect(await select(`SELECT * FROM "${multiTable}" WHERE id = 'i1'`)).toHaveLength(1)

    await ddb.send(new ExecuteStatementCommand({ Statement: `INSERT INTO "${multiTable}" VALUE {'id': 'n1'}` }))
    const inserted = await ddb.send(new GetItemCommand({ TableName: multiTable, Key: { id: S('n1') }, ConsistentRead: true }))
    expect(inserted.Item).toBeDefined()

    await ddb.send(new ExecuteStatementCommand({ Statement: `UPDATE "${multiTable}" SET a = 1 WHERE id = 'i1'` }))
    const updated = await ddb.send(new GetItemCommand({ TableName: multiTable, Key: { id: S('i1') }, ConsistentRead: true }))
    expect(updated.Item?.a).toEqual({ N: '1' })

    // A DELETE that matches nothing still runs rather than being refused.
    await ddb.send(new ExecuteStatementCommand({ Statement: `DELETE FROM "${multiTable}" WHERE id = 'zz'` }))
  })
})
