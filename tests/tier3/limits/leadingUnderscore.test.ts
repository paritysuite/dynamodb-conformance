import {
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  absentTableName,
  cleanupItems,
  compositeTableDef,
  declareTables,
  expectDynamoError,
} from '../../../src/helpers.js'

declareTables(compositeTableDef)

// A name starting with an underscore is a syntax error in every expression
// type unless it goes through ExpressionAttributeNames. An underscore anywhere
// else in the name is fine.
// Captured in eu-west-2 and us-east-1, 2026-11-03 and 2026-11-05.

const T = compositeTableDef.name
const PK = 'us-limits'
const keyed = { TableName: T, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': { S: PK } } }

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Leading underscore in expressions', { tags: ['query', 'scan', 'put-item', 'update-item', 'data-plane'] }, () => {
  const keys = [
    { pk: { S: PK }, sk: { S: 'row' } },
    { pk: { S: PK }, sk: { S: 'cond' } },
    { pk: { S: PK }, sk: { S: 'cond-alias' } },
    { pk: { S: PK }, sk: { S: 'upd' } },
    { pk: { S: PK }, sk: { S: 'upd-alias' } },
  ]

  beforeAll(async () => {
    await ddb.send(new PutItemCommand({ TableName: T, Item: { pk: { S: PK }, sk: { S: 'row' }, _x: { S: 'v' } } }))
  })

  afterAll(async () => {
    await cleanupItems(T, keys)
  })

  // ── Rejected without an alias ──

  it('rejects one in a FilterExpression on Query and Scan', async () => {
    await expectDynamoError(
      () => ddb.send(new QueryCommand({ ...keyed, FilterExpression: 'attribute_exists(_x)' })),
      'ValidationException',
    )
    await expectDynamoError(
      () => ddb.send(new ScanCommand({ TableName: T, FilterExpression: 'attribute_exists(_x)' })),
      'ValidationException',
    )
  })

  it('rejects one in a ProjectionExpression', async () => {
    await expectDynamoError(
      () => ddb.send(new QueryCommand({ ...keyed, ProjectionExpression: 'pk, _x' })),
      'ValidationException',
    )
  })

  it('rejects one in a KeyConditionExpression, on a table and on an index', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({ TableName: T, KeyConditionExpression: '_pk = :v', ExpressionAttributeValues: { ':v': { S: PK } } }),
        ),
      'ValidationException',
    )
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: T,
            KeyConditionExpression: 'pk = :v AND begins_with(_sk, :p)',
            ExpressionAttributeValues: { ':v': { S: PK }, ':p': { S: 'r' } },
          }),
        ),
      'ValidationException',
    )
    // Parsed before the table or index is looked up.
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: absentTableName('underscore_limits_absent'),
            IndexName: 'g-keys',
            KeyConditionExpression: '_g = :v',
            ExpressionAttributeValues: { ':v': { S: 'k' } },
          }),
        ),
      'ValidationException',
    )
  })

  it('rejects one in a ConditionExpression', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: T,
            Item: { pk: { S: PK }, sk: { S: 'cond' } },
            ConditionExpression: 'attribute_not_exists(_x)',
          }),
        ),
      'ValidationException',
    )
  })

  it('rejects one in an UpdateExpression', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateItemCommand({
            TableName: T,
            Key: { pk: { S: PK }, sk: { S: 'upd' } },
            UpdateExpression: 'SET _x = :v',
            ExpressionAttributeValues: { ':v': { S: 'v' } },
          }),
        ),
      'ValidationException',
    )
  })

  // ── Accepted through an alias ──

  it('accepts one through an alias in a filter and a projection', async () => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: T,
        KeyConditionExpression: 'pk = :p AND sk = :s',
        FilterExpression: 'attribute_exists(#x)',
        ProjectionExpression: 'pk, #x',
        ExpressionAttributeNames: { '#x': '_x' },
        ExpressionAttributeValues: { ':p': { S: PK }, ':s': { S: 'row' } },
        ConsistentRead: true,
      }),
    )
    expect(res.Items).toEqual([{ pk: { S: PK }, _x: { S: 'v' } }])
  })

  it('accepts one through an alias in a Scan filter', async () => {
    const res = await ddb.send(
      new ScanCommand({
        TableName: T,
        FilterExpression: 'pk = :p AND sk = :s AND attribute_exists(#x)',
        ExpressionAttributeNames: { '#x': '_x' },
        ExpressionAttributeValues: { ':p': { S: PK }, ':s': { S: 'row' } },
        ConsistentRead: true,
      }),
    )
    expect(res.Items?.map((i) => i.sk.S)).toEqual(['row'])
  })

  it('accepts one through an alias in a KeyConditionExpression', async () => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: T,
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'pk' },
        ExpressionAttributeValues: { ':p': { S: PK } },
        ConsistentRead: true,
      }),
    )
    expect(res.Count).toBeGreaterThanOrEqual(1)
  })

  it('accepts one through an alias in a ConditionExpression', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: T,
        Item: { pk: { S: PK }, sk: { S: 'cond-alias' } },
        ConditionExpression: 'attribute_not_exists(#x)',
        ExpressionAttributeNames: { '#x': '_x' },
      }),
    )
  })

  it('accepts one through an alias in an UpdateExpression', async () => {
    const res = await ddb.send(
      new UpdateItemCommand({
        TableName: T,
        Key: { pk: { S: PK }, sk: { S: 'upd-alias' } },
        UpdateExpression: 'SET #x = :v',
        ExpressionAttributeNames: { '#x': '_x' },
        ExpressionAttributeValues: { ':v': { S: 'v' } },
        ReturnValues: 'ALL_NEW',
      }),
    )
    expect(res.Attributes?._x).toEqual({ S: 'v' })
  })

  it('accepts an underscore inside a name without an alias', async () => {
    const res = await ddb.send(new QueryCommand({ ...keyed, FilterExpression: 'attribute_not_exists(a_b)', ConsistentRead: true }))
    expect(res.Items?.map((i) => i.sk.S)).toContain('row')
  })
})
