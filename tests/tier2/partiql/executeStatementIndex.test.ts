import {
  BatchExecuteStatementCommand,
  DeleteItemCommand,
  ExecuteStatementCommand,
  PutItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, compositeIndexedTableDef, waitForGsiConsistency } from '../../../src/helpers.js'

// Index-qualified PartiQL reads live in their own file so capability-filtered
// runs (`partiql and !gsi and !lsi`) never provision the indexed table: module
// imports execute even when tests are filtered out, so the declaration must
// stay here alone.
declareTables(compositeIndexedTableDef)

describe('ExecuteStatement — index-qualified SELECT', { tags: ['partiql', 'data-plane', 'gsi', 'lsi'] }, () => {
  let supported = true

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${compositeIndexedTableDef.name}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
    if (!supported) return

    await ddb.send(new PutItemCommand({
      TableName: compositeIndexedTableDef.name,
      Item: {
        pk: { S: 'pq-idx-select' }, sk: { S: 's1' }, lsi1sk: { S: 'pq-gsi-a' },
        lsi2sk: { S: 'pq-lsi-b' }, data: { S: 'one' },
      },
    }))
    // The GSI read follows its write immediately; give the index time to
    // surface the item before any assertion depends on it.
    await waitForGsiConsistency({
      tableName: compositeIndexedTableDef.name,
      indexName: 'gsi1',
      partitionKey: { name: 'lsi1sk', value: { S: 'pq-gsi-a' } },
      expectedCount: 1,
    })
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    await ddb.send(new DeleteItemCommand({
      TableName: compositeIndexedTableDef.name,
      Key: { pk: { S: 'pq-idx-select' }, sk: { S: 's1' } },
    }))
  })

  it('reads through a GSI-qualified FROM with equality on the index partition key', async () => {
    const res = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${compositeIndexedTableDef.name}"."gsi1" WHERE lsi1sk = 'pq-gsi-a'`,
    }))
    expect(res.Items).toHaveLength(1)
    expect(res.Items![0].pk.S).toBe('pq-idx-select')
  })

  // Characterised on real AWS (eu-west-1, 2026-09-02): without equality on the
  // index partition key the statement performs a full index scan and applies
  // the remaining conditions as a filter.
  it('performs a full index scan when WHERE lacks the index partition key', async () => {
    const res = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${compositeIndexedTableDef.name}"."gsi1" WHERE pk = 'pq-idx-select'`,
    }))
    expect(res.Items).toHaveLength(1)
    expect(res.Items![0].sk.S).toBe('s1')
  })

  it('accepts ConsistentRead on an LSI-qualified statement', async () => {
    const res = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${compositeIndexedTableDef.name}"."lsi1" WHERE pk = 'pq-idx-select'`,
      ConsistentRead: true,
    }))
    expect(res.Items).toHaveLength(1)
  })

  // Characterised on real AWS (eu-west-1, 2026-09-02): an LSI read reaches the
  // co-located base item, so an explicit column outside the index projection
  // still returns. lsi2 is INCLUDE lsi1sk, so `data` is outside it.
  it('reaches non-projected attributes through an LSI-qualified read', async () => {
    const res = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT data FROM "${compositeIndexedTableDef.name}"."lsi2" WHERE pk = 'pq-idx-select' AND lsi2sk = 'pq-lsi-b'`,
    }))
    expect(res.Items).toHaveLength(1)
    expect(res.Items![0].data.S).toBe('one')
  })
  // A GSI cannot reach outside its projection: the rejection lists every
  // unprojected column in statement order, bracketed.
  it('rejects non-projected columns on a GSI in statement order', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT alternate, mymap FROM "${compositeIndexedTableDef.name}"."gsi2" WHERE lsi1sk = 'pq-gsi-a'`,
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: Global secondary index gsi2 does not project [alternate, mymap]',
      )
    }
  })

  it('rejects non-projected columns on the GSI scan path too', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT alternate FROM "${compositeIndexedTableDef.name}"."gsi2"`,
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: Global secondary index gsi2 does not project [alternate]',
      )
    }
  })
})

describe('BatchExecuteStatement — SELECT statements resolve through the primary key', { tags: ['partiql', 'data-plane', 'gsi'] }, () => {
  let supported = true

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${compositeIndexedTableDef.name}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  // Characterised on real AWS (eu-west-1, 2026-09-02): a batch SELECT may not
  // target a secondary index and must carry the full primary key in its WHERE
  // clause; each offending statement gets its own slot error while the batch
  // itself succeeds.
  it('rejects index-qualified and partial-key SELECT statements per slot', async () => {
    const res = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `SELECT * FROM "${compositeIndexedTableDef.name}"."gsi1" WHERE lsi1sk = 'pq-gsi-a'` },
        { Statement: `SELECT * FROM "${compositeIndexedTableDef.name}" WHERE pk = 'pq-idx-select'` },
      ],
    }))
    expect(res.Responses).toHaveLength(2)
    for (const slot of res.Responses!) {
      expect(slot.Error?.Code).toBe('ValidationError')
      expect(slot.Error?.Message).toBe(
        'Select statements within BatchExecuteStatement must specify the primary key in the where clause.',
      )
    }
  })
})
