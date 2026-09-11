import {
  BatchWriteItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import { declareTables, hashTableDef, cleanupItems, expectDynamoError } from '../../../src/helpers.js'
import { observeSplit } from '../../../src/observation-sink.js'

declareTables(hashTableDef)

// Wrap a scalar leaf in `depth` single-key maps: depth=1 -> { M: { n: { S: 'leaf' } } }.
// Real DynamoDB caps document nesting at 32 levels, counting the attribute itself as
// level 1, so a value built from 31 wraps (leaf at level 32) is the deepest it accepts
// and 32 wraps (leaf at level 33) is rejected with a ValidationException. The same
// boundary and message apply to stored items (PutItem) and to ExpressionAttributeValues
// in a ConditionExpression. Captured against eu-west-2 real DynamoDB, 2026-06.
function deepMap(depth: number): AttributeValue {
  let v: AttributeValue = { S: 'leaf' }
  for (let i = 0; i < depth; i++) v = { M: { n: v } }
  return v
}

// Region wording varies; pin the invariant. AWS returns (eu-west-2):
//   "Nesting Levels have exceeded supported limits: Attributes in the item have
//    nested levels beyond supported limit"
// Require both the "nest(ing|ed) levels" and "supported limit" phrases together, so an
// unrelated ValidationException that merely mentions nesting cannot pass the assertion.
const NEST_MSG = /nest(?:ing|ed) levels[\s\S]*supported limit/i

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Nesting depth — 32-level document limit', { tags: ['put-item', 'update-item', 'data-plane'] }, () => {
  const keys = [{ pk: { S: 'nest-stored-31' } }, { pk: { S: 'nest-cond-eav' } }]

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, keys)
  })

  // --- Stored item (PutItem) ---

  it('accepts a stored attribute nested 31 levels (leaf at level 32)', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'nest-stored-31' }, data: deepMap(31) },
      }),
    )
  })

  it('rejects a stored attribute nested 32 levels (leaf at level 33)', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            // never stored, so no cleanup key needed
            Item: { pk: { S: 'nest-stored-32' }, data: deepMap(32) },
          }),
        ),
      'ValidationException',
      NEST_MSG,
    )
  })

  // --- ExpressionAttributeValue (UpdateItem ConditionExpression) ---
  // Depth is validated up front, before the condition is evaluated. A 31-level value
  // is accepted, so the condition runs: against an item with no `data`, `#d = :deep`
  // is false and surfaces as ConditionalCheckFailedException, which proves the value
  // was accepted rather than rejected on depth. A 32-level value is rejected outright.

  it('accepts a 31-level ExpressionAttributeValue (condition is evaluated)', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'nest-cond-eav' }, marker: { S: 'x' } },
      }),
    )
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateItemCommand({
            TableName: hashTableDef.name,
            Key: { pk: { S: 'nest-cond-eav' } },
            UpdateExpression: 'SET touched = :t',
            ConditionExpression: '#d = :deep',
            ExpressionAttributeNames: { '#d': 'data' },
            ExpressionAttributeValues: { ':t': { S: 'y' }, ':deep': deepMap(31) },
          }),
        ),
      'ConditionalCheckFailedException',
    )
  })

  it('rejects a 32-level ExpressionAttributeValue with ValidationException', async (ctx) => {
    // Split behaviour (registry row update-item-nesting-depth-expression-value):
    // regions without the stricter validation accept the value and fail the
    // condition instead, so what the target actually returned is recorded for
    // per-region scoring.
    await expectDynamoError(
      () =>
        observeSplit(ctx.task, () =>
          ddb.send(
            new UpdateItemCommand({
              TableName: hashTableDef.name,
              Key: { pk: { S: 'nest-cond-eav' } },
              UpdateExpression: 'SET touched = :t',
              ConditionExpression: '#d = :deep',
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':t': { S: 'y' }, ':deep': deepMap(32) },
            }),
          ),
        ),
      'ValidationException',
      NEST_MSG,
    )
  })
})

// The same 32-level cap applies to the items a batch or a transaction writes.
// Captured against eu-west-2 and us-east-1 real DynamoDB, 2026-09-12: a too
// deep Put item is a top-level ValidationException on both surfaces, checked
// before the table lookup. Inside a transaction the ExpressionAttributeValues
// split by action: an Update's value is checked and surfaces as a cancellation
// with a 'ValidationError' reason, while a ConditionCheck's value is not
// checked at all and the condition simply runs.

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Nesting depth — BatchWriteItem', { tags: ['batch', 'data-plane'] }, () => {
  const keys = [{ pk: { S: 'nest-bw-31' } }]

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, keys)
  })

  it('accepts a Put item nested 31 levels (leaf at level 32)', async () => {
    const res = await ddb.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [hashTableDef.name]: [
            { PutRequest: { Item: { pk: { S: 'nest-bw-31' }, data: deepMap(31) } } },
          ],
        },
      }),
    )
    expect(res.UnprocessedItems ?? {}).toEqual({})
  })

  it('rejects a Put item nested 32 levels (leaf at level 33)', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new BatchWriteItemCommand({
            RequestItems: {
              [hashTableDef.name]: [
                // never stored, so no cleanup key needed
                { PutRequest: { Item: { pk: { S: 'nest-bw-32' }, data: deepMap(32) } } },
              ],
            },
          }),
        ),
      'ValidationException',
      NEST_MSG,
    )
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Nesting depth — TransactWriteItems', { tags: ['transactions', 'data-plane'] }, () => {
  // An empty TransactItems is rejected by any target that implements the
  // operation, so this separates "not implemented" from "implemented".
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  const keys = [{ pk: { S: 'nest-twi-31' } }, { pk: { S: 'nest-twi-eav' } }]

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, keys)
  })

  it('accepts a Put item nested 31 levels (leaf at level 32)', async () => {
    await ddb.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: hashTableDef.name, Item: { pk: { S: 'nest-twi-31' }, data: deepMap(31) } } },
        ],
      }),
    )
  })

  it('rejects a Put item nested 32 levels with a top-level ValidationException', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              // never stored, so no cleanup key needed
              { Put: { TableName: hashTableDef.name, Item: { pk: { S: 'nest-twi-32' }, data: deepMap(32) } } },
            ],
          }),
        ),
      'ValidationException',
      NEST_MSG,
    )
  })

  it('cancels on a 32-level ExpressionAttributeValue in an Update with a ValidationError reason', async () => {
    try {
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: hashTableDef.name,
                Key: { pk: { S: 'nest-twi-eav' } },
                UpdateExpression: 'SET deep = :deep',
                ExpressionAttributeValues: { ':deep': deepMap(32) },
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionCanceledException)
      const txErr = err as TransactionCanceledException
      const expectedReasons = ['ValidationError'] as const
      expect(txErr.message).toBe(
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${expectedReasons.join(', ')}]`,
      )
      expect(txErr.CancellationReasons?.map((r) => r.Code)).toEqual([...expectedReasons])
      expect(txErr.CancellationReasons?.[0]?.Message).toMatch(NEST_MSG)
    }
  })

  it('does not check the depth of a ConditionCheck ExpressionAttributeValue (the condition is evaluated)', async () => {
    // Against an item with no `data`, `#d = :deep` is false and the transaction
    // cancels on the condition, which proves the value was accepted rather than
    // rejected on depth.
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'nest-twi-eav' }, marker: { S: 'x' } },
      }),
    )
    try {
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: hashTableDef.name,
                Key: { pk: { S: 'nest-twi-eav' } },
                ConditionExpression: '#d = :deep',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':deep': deepMap(32) },
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionCanceledException)
      const txErr = err as TransactionCanceledException
      expect(txErr.CancellationReasons?.map((r) => r.Code)).toEqual(['ConditionalCheckFailed'])
    }
  })
})
