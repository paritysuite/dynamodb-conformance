import {
  CreateTableCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
  type QueryCommandInput,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  uniqueTableName,
  waitUntilActive,
  deleteTable,
  waitForGsiConsistency,
  expectDynamoError,
} from '../../../src/helpers.js'

// A global secondary index whose key is one HASH attribute and four RANGE
// attributes (multi-attribute keys). Verified against real AWS (eu-central-1 and
// us-east-1, October 2026; eu-west-2 for this file).
//
// Items sort by the RANGE attributes in the order the key schema lists them,
// compared one after another. An item missing any key attribute is not in the
// index. The key condition must give an equality for the HASH attribute and for
// a prefix of the RANGE attributes with no gap, and only the last attribute it
// names may carry a range condition; the clauses can be written in any order.
// A page's LastEvaluatedKey carries the table key and every index key attribute.
//
// The table is created here rather than from a shared def: TestTableDef models
// one RANGE attribute per index.
//
// no negative-path: acceptance-mixed (asserts accepted and rejected conditions)
describe('Query - GSI with a multi-attribute key', { tags: ['query', 'gsi', 'data-plane'] }, () => {
  const tableName = uniqueTableName('multiKeyGsi')
  const indexName = 'gsi'

  const items: Record<string, string | undefined>[] = [
    { pk: 'p1', a: 'T', b: 'live', c: 'b', d: 'r1' },
    { pk: 'p2', a: 'T', b: 'live', c: 'a', d: 'r2' },
    { pk: 'p3', a: 'T', b: 'live', c: 'a', d: 'r1' },
    { pk: 'p4', a: 'T', b: 'draft', c: 'c', d: 'r1' },
    { pk: 'p5', a: 'F', b: 'live', c: 'a', d: 'r0' },
    // No c, so not in the index.
    { pk: 'p6', a: 'T', b: 'live', c: undefined, d: 'r1' },
  ]

  beforeAll(async () => {
    await ddb.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: ['pk', 'h', 'a', 'b', 'c', 'd'].map((n) => ({ AttributeName: n, AttributeType: 'S' })),
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{
        IndexName: indexName,
        KeySchema: [
          { AttributeName: 'h', KeyType: 'HASH' },
          { AttributeName: 'a', KeyType: 'RANGE' },
          { AttributeName: 'b', KeyType: 'RANGE' },
          { AttributeName: 'c', KeyType: 'RANGE' },
          { AttributeName: 'd', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      }],
    }))
    await waitUntilActive(tableName)
    for (const item of items) {
      const Item: Record<string, AttributeValue> = { h: { S: 'o1' } }
      for (const [k, v] of Object.entries(item)) if (v !== undefined) Item[k] = { S: v }
      await ddb.send(new PutItemCommand({ TableName: tableName, Item }))
    }
    await waitForGsiConsistency({
      tableName,
      indexName,
      partitionKey: { name: 'h', value: { S: 'o1' } },
      expectedCount: 5,
    })
  })

  afterAll(async () => {
    await deleteTable(tableName)
  })

  const values: Record<string, AttributeValue> = {
    ':h': { S: 'o1' }, ':a': { S: 'T' }, ':b': { S: 'live' }, ':c': { S: 'a' },
    ':d': { S: 'r' }, ':x': { S: 'r1' }, ':y': { S: 'r1' },
  }

  /** Query the index and return the table keys in the order they came back. */
  async function query(KeyConditionExpression: string, extra: Partial<QueryCommandInput> = {}) {
    const used = Object.fromEntries(Object.entries(values).filter(([k]) => KeyConditionExpression.includes(k)))
    const res = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression,
      ExpressionAttributeValues: used,
      ...extra,
    }))
    return { pks: (res.Items ?? []).map((i) => i.pk.S), lastEvaluatedKey: res.LastEvaluatedKey }
  }

  it('the HASH attribute alone returns the indexed items in key order, without the item missing a key attribute', async () => {
    expect((await query('h = :h')).pks).toEqual(['p5', 'p4', 'p3', 'p2', 'p1'])
  })

  it('an equality on the first RANGE attribute narrows to it', async () => {
    expect((await query('h = :h AND a = :a')).pks).toEqual(['p4', 'p3', 'p2', 'p1'])
  })

  it('ScanIndexForward=false reverses the order', async () => {
    expect((await query('h = :h AND a = :a', { ScanIndexForward: false })).pks).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('equalities on the first two RANGE attributes', async () => {
    expect((await query('h = :h AND a = :a AND b = :b')).pks).toEqual(['p3', 'p2', 'p1'])
  })

  it('equalities on the first three RANGE attributes', async () => {
    expect((await query('h = :h AND a = :a AND b = :b AND c = :c')).pks).toEqual(['p3', 'p2'])
  })

  it('a range condition on the last attribute named', async () => {
    expect((await query('h = :h AND a = :a AND b = :b AND c > :c')).pks).toEqual(['p1'])
  })

  it('begins_with on the fourth RANGE attribute', async () => {
    expect((await query('h = :h AND a = :a AND b = :b AND c = :c AND begins_with(d, :d)')).pks).toEqual(['p3', 'p2'])
  })

  it('BETWEEN on the fourth RANGE attribute', async () => {
    expect((await query('h = :h AND a = :a AND b = :b AND c = :c AND d BETWEEN :x AND :y')).pks).toEqual(['p3'])
  })

  it('a range condition on the second RANGE attribute', async () => {
    expect((await query('h = :h AND a = :a AND b < :b')).pks).toEqual(['p4'])
  })

  it('the clauses can be written in any order', async () => {
    expect((await query('b = :b AND h = :h AND a = :a')).pks).toEqual(['p3', 'p2', 'p1'])
  })

  it('a page carries the table key and every index key attribute in LastEvaluatedKey', async () => {
    const { pks, lastEvaluatedKey } = await query('h = :h AND a = :a', { Limit: 2 })
    expect(pks).toEqual(['p4', 'p3'])
    expect(Object.keys(lastEvaluatedKey ?? {}).sort()).toEqual(['a', 'b', 'c', 'd', 'h', 'pk'])
  })

  it('a gap in the RANGE attributes is refused', async () => {
    await expectDynamoError(
      () => query('h = :h AND a = :a AND c = :c'),
      'ValidationException',
      'RANGE key attributes b must have equality conditions specified in the query because a condition is present on key attribute c',
    )
  })

  it('a range condition before the last attribute named is refused', async () => {
    await expectDynamoError(
      () => query('h = :h AND a = :a AND b > :b AND c = :c'),
      'ValidationException',
      'RANGE key attributes b must have equality conditions specified in the query because a condition is present on key attribute c',
    )
  })

  it('skipping the first RANGE attribute is refused', async () => {
    await expectDynamoError(
      () => query('h = :h AND b = :b'),
      'ValidationException',
      'RANGE key attributes a must have equality conditions specified in the query because a condition is present on key attribute b',
    )
  })
})
