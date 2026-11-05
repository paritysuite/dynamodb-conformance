import {
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { absentTableName, cleanupItems, compositeTableDef, declareTables } from '../../../src/helpers.js'
import { observeSplit } from '../../../src/observation-sink.js'

declareTables(compositeTableDef)

// An attribute name can't start with an underscore in an expression unless it
// goes through ExpressionAttributeNames. Every expression type rejects it as a
// syntax error, and `near:` echoes the expression around the underscore, so
// each expression here is written exactly as captured.
// Captured in eu-west-2 and us-east-1, 2026-11-03 and 2026-11-05.

async function refusal(send: () => Promise<unknown>): Promise<{ name: string; message: string }> {
  try {
    await send()
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(DynamoDBServiceException)
    const err = e as DynamoDBServiceException
    return { name: err.name, message: err.message }
  }
  expect.unreachable('should have thrown')
  return { name: '', message: '' }
}

const T = compositeTableDef.name
const keyed = { TableName: T, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': { S: 'us-msg' } } }

describe('Leading underscore — exact error messages', { tags: ['query', 'scan', 'put-item', 'update-item', 'data-plane', 'negative-path'] }, () => {
  // Only a target that wrongly accepts the write expressions leaves these.
  afterAll(async () => {
    await cleanupItems(T, [
      { pk: { S: 'us-msg' }, sk: { S: 'cond' } },
      { pk: { S: 'us-msg' }, sk: { S: 'upd' } },
    ])
  })

  it('in a Query FilterExpression', async () => {
    const got = await refusal(() => ddb.send(new QueryCommand({ ...keyed, FilterExpression: 'attribute_exists(_x)' })))
    expect(got.name).toBe('ValidationException')
    expect(got.message).toBe('Invalid FilterExpression: Syntax error; token: "_", near: "(_x"')
  })

  it('in a Scan FilterExpression', async () => {
    const got = await refusal(() => ddb.send(new ScanCommand({ TableName: T, FilterExpression: 'attribute_exists(_x)' })))
    expect(got.name).toBe('ValidationException')
    expect(got.message).toBe('Invalid FilterExpression: Syntax error; token: "_", near: "(_x"')
  })

  it('in a ProjectionExpression', async () => {
    const got = await refusal(() => ddb.send(new QueryCommand({ ...keyed, ProjectionExpression: 'pk, _x' })))
    expect(got.name).toBe('ValidationException')
    expect(got.message).toBe('Invalid ProjectionExpression: Syntax error; token: "_", near: ", _x"')
  })

  it('as the partition key in a KeyConditionExpression', async () => {
    const got = await refusal(() =>
      ddb.send(
        new QueryCommand({ TableName: T, KeyConditionExpression: '_pk = :v', ExpressionAttributeValues: { ':v': { S: 'k' } } }),
      ),
    )
    expect(got.name).toBe('ValidationException')
    expect(got.message).toBe('Invalid KeyConditionExpression: Syntax error; token: "_", near: "_pk"')
  })

  it('inside begins_with in a KeyConditionExpression', async () => {
    const got = await refusal(() =>
      ddb.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :v AND begins_with(_sk, :p)',
          ExpressionAttributeValues: { ':v': { S: 'k' }, ':p': { S: 'r' } },
        }),
      ),
    )
    expect(got.name).toBe('ValidationException')
    expect(got.message).toBe('Invalid KeyConditionExpression: Syntax error; token: "_", near: "(_sk"')
  })

  // The expression is parsed before the table or index is looked up, so the
  // index case needs neither to exist.
  it('in a KeyConditionExpression on an index', async () => {
    const got = await refusal(() =>
      ddb.send(
        new QueryCommand({
          TableName: absentTableName('underscore_absent'),
          IndexName: 'g-keys',
          KeyConditionExpression: '_g = :v',
          ExpressionAttributeValues: { ':v': { S: 'k' } },
        }),
      ),
    )
    expect(got.name).toBe('ValidationException')
    expect(got.message).toBe('Invalid KeyConditionExpression: Syntax error; token: "_", near: "_g"')
  })

  // The write expressions carry the single-error envelope in every region on
  // the newer validation layer. me-central-1 still answers without it.
  it('in a ConditionExpression', async (ctx) => {
    // Split behaviour (registry row condition-expression-leading-underscore-message).
    const got = await refusal(() =>
      observeSplit(ctx.task, () =>
        ddb.send(
          new PutItemCommand({
            TableName: T,
            Item: { pk: { S: 'us-msg' }, sk: { S: 'cond' } },
            ConditionExpression: 'attribute_not_exists(_x)',
          }),
        ),
      ),
    )
    expect(got.name).toBe('ValidationException')
    expect(got.message).toBe(
      '1 validation error detected: Invalid ConditionExpression: Syntax error; token: "_", near: "(_x"',
    )
  })

  it('in an UpdateExpression', async (ctx) => {
    // Split behaviour (registry row update-expression-leading-underscore-message).
    const got = await refusal(() =>
      observeSplit(ctx.task, () =>
        ddb.send(
          new UpdateItemCommand({
            TableName: T,
            Key: { pk: { S: 'us-msg' }, sk: { S: 'upd' } },
            UpdateExpression: 'SET _x = :v',
            ExpressionAttributeValues: { ':v': { S: 'v' } },
          }),
        ),
      ),
    )
    expect(got.name).toBe('ValidationException')
    expect(got.message).toBe(
      '1 validation error detected: Invalid UpdateExpression: Syntax error; token: "_", near: "SET _x"',
    )
  })
})
