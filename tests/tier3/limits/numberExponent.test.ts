import {
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  QueryCommand,
  BatchGetItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  hashNTableDef,
  compositeNTableDef,
  cleanupItems,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef, hashNTableDef, compositeNTableDef)

// Numbers written with an exponent far outside DynamoDB's range, and zero
// written with an exponent. DynamoDB reads the exponent in full before applying
// its magnitude limits (1E-130 to 9.99...E+125), so an exponent past a 32-bit
// integer is refused as an overflow or underflow rather than wrapping, and an
// exponent past a 64-bit integer cannot be converted at all. Zero is
// range-checked by the exponent it is written with. Verified against real AWS
// (eu-west-2, October 2026).
//
// The messages are asserted as substrings: some regions prefix them with
// "1 validation error detected: " and some do not.
//
// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Number limits - exponents', { tags: ['put-item', 'get-item', 'delete-item', 'update-item', 'query', 'batch', 'data-plane'] }, () => {
  const OVERFLOW = 'Number overflow. Attempting to store a number with magnitude larger than supported range'
  const UNDERFLOW = 'Number underflow. Attempting to store a number with magnitude smaller than supported range'
  const UNCONVERTIBLE = 'The parameter cannot be converted to a numeric value'

  const S = hashTableDef.name
  const N = hashNTableDef.name
  const SN = compositeNTableDef.name
  const keys = ['nx-zero', 'nx-small', 'nx-update', 'nx-condition'].map((s) => ({ pk: { S: s } }))

  afterAll(async () => {
    await cleanupItems(S, keys)
  })

  function put(value: string, pk = 'nx-rejected') {
    return () => ddb.send(new PutItemCommand({ TableName: S, Item: { pk: { S: pk }, val: { N: value } } }))
  }

  // ── Attribute values ─────────────────────────────────────────────────

  it('an exponent past a 32-bit integer overflows', async () => {
    await expectDynamoError(put('1e99999999999'), 'ValidationException', OVERFLOW)
  })

  it('a negative exponent past a 32-bit integer underflows', async () => {
    await expectDynamoError(put('1e-99999999999'), 'ValidationException', UNDERFLOW)
  })

  it('an exponent one past a 32-bit integer overflows', async () => {
    await expectDynamoError(put('1e2147483648'), 'ValidationException', OVERFLOW)
  })

  it('an exponent past a 64-bit integer cannot be converted', async () => {
    await expectDynamoError(put('1e9223372036854775808'), 'ValidationException', UNCONVERTIBLE)
  })

  it('zero with an exponent above the range overflows', async () => {
    await expectDynamoError(put('0e126'), 'ValidationException', OVERFLOW)
  })

  it('zero with an exponent below the range underflows', async () => {
    await expectDynamoError(put('0e-131'), 'ValidationException', UNDERFLOW)
  })

  it('zero with an exponent inside the range is stored as 0', async () => {
    await put('0e125', 'nx-zero')()
    const res = await ddb.send(new GetItemCommand({ TableName: S, Key: { pk: { S: 'nx-zero' } }, ConsistentRead: true }))
    expect(res.Item!.val).toEqual({ N: '0' })
  })

  it('the smallest magnitude written with an exponent is accepted', async () => {
    await put('1e-130', 'nx-small')()
    const res = await ddb.send(new GetItemCommand({ TableName: S, Key: { pk: { S: 'nx-small' } }, ConsistentRead: true }))
    expect(res.Item!.val.N).toBeDefined()
  })

  it('an UpdateExpression value with an exponent past a 32-bit integer overflows', async () => {
    await expectDynamoError(
      () => ddb.send(new UpdateItemCommand({
        TableName: S,
        Key: { pk: { S: 'nx-update' } },
        UpdateExpression: 'SET m = :v',
        ExpressionAttributeValues: { ':v': { N: '1e99999999999' } },
      })),
      'ValidationException',
      OVERFLOW,
    )
  })

  it('a ConditionExpression value with an exponent past a 32-bit integer overflows', async () => {
    await expectDynamoError(
      () => ddb.send(new PutItemCommand({
        TableName: S,
        Item: { pk: { S: 'nx-condition' } },
        ConditionExpression: 'attribute_not_exists(n) OR n = :v',
        ExpressionAttributeValues: { ':v': { N: '1e99999999999' } },
      })),
      'ValidationException',
      OVERFLOW,
    )
  })

  // ── Key values ───────────────────────────────────────────────────────
  // A key read with a number outside the range is refused, never matched
  // against whatever a truncated reading of it would be.

  it('a GetItem key with an exponent past a 32-bit integer overflows', async () => {
    await expectDynamoError(
      () => ddb.send(new GetItemCommand({ TableName: N, Key: { pk: { N: '1e99999999999' } } })),
      'ValidationException',
      OVERFLOW,
    )
  })

  it('a DeleteItem key with an exponent past a 32-bit integer overflows', async () => {
    await expectDynamoError(
      () => ddb.send(new DeleteItemCommand({ TableName: N, Key: { pk: { N: '1e99999999999' } } })),
      'ValidationException',
      OVERFLOW,
    )
  })

  it('an UpdateItem key with an exponent past a 32-bit integer overflows', async () => {
    await expectDynamoError(
      () => ddb.send(new UpdateItemCommand({
        TableName: N,
        Key: { pk: { N: '1e99999999999' } },
        UpdateExpression: 'SET a = :a',
        ExpressionAttributeValues: { ':a': { S: 'x' } },
      })),
      'ValidationException',
      OVERFLOW,
    )
  })

  it('a Query sort-key value with an exponent past a 32-bit integer overflows', async () => {
    await expectDynamoError(
      () => ddb.send(new QueryCommand({
        TableName: SN,
        KeyConditionExpression: 'pk = :p AND sk = :v',
        ExpressionAttributeValues: { ':p': { S: 'nx-query' }, ':v': { N: '1e99999999999' } },
      })),
      'ValidationException',
      OVERFLOW,
    )
  })

  it('a BatchGetItem key with an exponent past a 32-bit integer overflows', async () => {
    await expectDynamoError(
      () => ddb.send(new BatchGetItemCommand({
        RequestItems: { [N]: { Keys: [{ pk: { N: '1e99999999999' } }] } },
      })),
      'ValidationException',
      OVERFLOW,
    )
  })
})
