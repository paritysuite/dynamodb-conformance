import {
  BatchWriteItemCommand,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import { declareTables, hashTableDef, cleanupItems, assertDynamoError, expectDynamoError } from '../../../src/helpers.js'
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

// The same depth built from single-element lists.
function deepList(depth: number): AttributeValue {
  let v: AttributeValue = { S: 'leaf' }
  for (let i = 0; i < depth; i++) v = { L: [v] }
  return v
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function depthOf(v: AttributeValue | undefined): number {
  let depth = 0
  while (v?.M?.n) {
    depth++
    v = v.M.n
  }
  return depth
}

// The nesting refusal comes in four exact forms, depending on the surface:
//
//   NEST_BARE    a transaction refusing a too deep item, and the regions that
//                check transaction values up front (see the TransactWriteItems
//                block below)
//   NEST_SINGLE  UpdateItem and PutItem refusing a too deep value, inside the
//                validation envelope
//   nestForKey   a transaction refusing a value nested past the second limit,
//                naming the ExpressionAttributeValues key
//   NEST_REASON  the cancellation reason when a transaction runs and the item
//                it would write is too deep
//
// Captured in us-east-1, eu-west-2, eu-central-1, eu-north-1 and
// ap-northeast-1, 2026-10-08, and again in us-east-1 and eu-west-2, 2026-10-09.
// A BatchWriteItem item is refused without the envelope, a PutItem item with
// it. Both regions agree on every form below unless a test says otherwise.
const NEST_BARE =
  'Nesting Levels have exceeded supported limits: Attributes in the item have nested levels beyond supported limit'
const NEST_SINGLE = `1 validation error detected: ${NEST_BARE}`
const NEST_REASON = 'Nesting Levels have exceeded supported limits'
const nestForKey = (key: string) => `ExpressionAttributeValues contains invalid value: ${NEST_BARE} for key ${key}`

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Nesting depth — 32-level document limit', { tags: ['put-item', 'update-item', 'data-plane'] }, () => {
  const keys = [
    { pk: { S: 'nest-stored-31' } },
    { pk: { S: 'nest-cond-eav' } },
    // never stored by DynamoDB; cleaned up in case a target writes them
    { pk: { S: 'nest-stored-61' } },
    { pk: { S: 'nest-stored-63' } },
  ]

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
      new RegExp(`^${escapeRegExp(NEST_SINGLE)}$`),
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
      new RegExp(`^${escapeRegExp(NEST_SINGLE)}$`),
    )
  })

  // Far past the limit the request is still read and refused with the nesting
  // error, never a failure to parse the body. Somewhere between 61 and 63
  // levels the single-item operations move to a second check: a PutItem item
  // loses the envelope, and an UpdateItem value is refused naming its key.
  // Both regions agree (us-east-1 and eu-west-2, 2026-10-09).
  it('rejects a stored attribute nested 61 levels with the same message', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({ TableName: hashTableDef.name, Item: { pk: { S: 'nest-stored-61' }, data: deepMap(61) } }),
        ),
      'ValidationException',
      new RegExp(`^${escapeRegExp(NEST_SINGLE)}$`),
    )
  })

  it('rejects a stored attribute nested 63 levels without the envelope', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({ TableName: hashTableDef.name, Item: { pk: { S: 'nest-stored-63' }, data: deepMap(63) } }),
        ),
      'ValidationException',
      new RegExp(`^${escapeRegExp(NEST_BARE)}$`),
    )
  })

  it('rejects a 63-level ExpressionAttributeValue naming its key', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateItemCommand({
            TableName: hashTableDef.name,
            Key: { pk: { S: 'nest-cond-eav' } },
            UpdateExpression: 'SET touched = :t',
            ConditionExpression: '#d = :deep',
            ExpressionAttributeNames: { '#d': 'data' },
            ExpressionAttributeValues: { ':t': { S: 'y' }, ':deep': deepMap(63) },
          }),
        ),
      'ValidationException',
      new RegExp(`^${escapeRegExp(nestForKey(':deep'))}$`),
    )
  })
})

// The same 32-level cap applies to the items a batch or a transaction writes.
// Captured against eu-west-2 and us-east-1 real DynamoDB, 2026-09-12: a too
// deep Put item is a top-level ValidationException on both surfaces.
// TransactWriteItems does not check a 32-level ExpressionAttributeValue in most
// regions, where UpdateItem checks it (registry row
// update-item-nesting-depth-expression-value); a value one level deeper is a
// different matter (the last tests in the TransactWriteItems block). An Update
// that writes a too deep value into the item still cancels on the stored-item
// cap.

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Nesting depth — BatchWriteItem', { tags: ['batch', 'get-item', 'data-plane'] }, () => {
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
    expect(res.UnprocessedItems).toEqual({})
    const get = await ddb.send(
      new GetItemCommand({ TableName: hashTableDef.name, Key: { pk: { S: 'nest-bw-31' } }, ConsistentRead: true }),
    )
    expect(depthOf(get.Item?.data)).toBe(31)
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
      new RegExp(`^${escapeRegExp(NEST_BARE)}$`),
    )
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Nesting depth — TransactWriteItems', { tags: ['transactions', 'put-item', 'get-item', 'data-plane'] }, () => {
  // An empty TransactItems is rejected by any target that implements the
  // operation, so this separates "not implemented" from "implemented".
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  const keys = [
    { pk: { S: 'nest-twi-31' } },
    { pk: { S: 'nest-twi-eav' } },
    // never stored by DynamoDB; cleaned up in case a target writes them
    { pk: { S: 'nest-twi-put-33' } },
    { pk: { S: 'nest-twi-upd-33' } },
  ]

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
    const get = await ddb.send(
      new GetItemCommand({ TableName: hashTableDef.name, Key: { pk: { S: 'nest-twi-31' } }, ConsistentRead: true }),
    )
    expect(depthOf(get.Item?.data)).toBe(31)
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
      new RegExp(`^${escapeRegExp(NEST_BARE)}$`),
    )
  })

  // The next three are mid-rollout. eu-north-1 and ap-northeast-2 started
  // checking the depth of every value in the request before the transaction
  // runs, and eu-west-2 followed on 2026-10-08, between two ground-truth runs on
  // main 30 minutes apart. Those regions answer each of these tests with a
  // top-level ValidationException; the other 30 still run the transaction and
  // cancel it. Each test accepts either answer, exactly, until the regions
  // settle. Their names describe what the 30 still do, and change when one
  // answer is pinned: a rename invalidates every committed results file, so it
  // lands with a results refresh rather than ahead of one.
  it('cancels an Update that writes a 32-level value into the item with a ValidationError reason', async () => {
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
      if (err instanceof TransactionCanceledException) {
        const expectedReasons = ['ValidationError'] as const
        expect(err.message).toBe(
          `Transaction cancelled, please refer cancellation reasons for specific reasons [${expectedReasons.join(', ')}]`,
        )
        expect(err.CancellationReasons?.map((r) => r.Code)).toEqual([...expectedReasons])
        // The reason is the short sentence, not the item-level message.
        expect(err.CancellationReasons?.[0]?.Message).toBe(NEST_REASON)
      } else {
        assertDynamoError(err, 'ValidationException')
        expect((err as Error).message).toBe(NEST_BARE)
      }
    }
  })

  it('does not check the depth of an Update ExpressionAttributeValue (the condition is evaluated)', async () => {
    // The value stays out of the item, so only the condition sees it. Against an
    // item with no `data`, `#d = :deep` is false, so a transaction that accepts
    // the value cancels on the condition. UpdateItem rejects the same request
    // with ValidationException in most regions.
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
              Update: {
                TableName: hashTableDef.name,
                Key: { pk: { S: 'nest-twi-eav' } },
                UpdateExpression: 'SET touched = :t',
                ConditionExpression: '#d = :deep',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':t': { S: 'y' }, ':deep': deepMap(32) },
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        expect(err.CancellationReasons?.map((r) => r.Code)).toEqual(['ConditionalCheckFailed'])
      } else {
        assertDynamoError(err, 'ValidationException')
        expect((err as Error).message).toBe(NEST_BARE)
      }
    }
  })

  it('does not check the depth of a ConditionCheck ExpressionAttributeValue (the condition is evaluated)', async () => {
    // Against an item with no `data`, `#d = :deep` is false, so a cancellation on
    // the condition proves the value was accepted rather than rejected on depth.
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
      if (err instanceof TransactionCanceledException) {
        expect(err.CancellationReasons?.map((r) => r.Code)).toEqual(['ConditionalCheckFailed'])
      } else {
        assertDynamoError(err, 'ValidationException')
        expect((err as Error).message).toBe(NEST_BARE)
      }
    }
  })

  // A second limit sits one level past the first. The 30 regions that still run
  // the transaction with a 32-level value refuse a value nested 33 or more
  // levels before running it, naming the key. The regions that already check
  // every value up front (eu-north-1, ap-northeast-2, and eu-west-2 from
  // 2026-10-08) refuse it with the bare sentence instead. Captured in us-east-1
  // and eu-west-2, 2026-10-09, from 30 to 101 levels: lists and maps alike, on
  // every action type, and ahead of any table lookup.
  const NEST_33 = [nestForKey(':deep'), NEST_BARE]

  it('refuses a ConditionCheck value nested 33 levels before the transaction runs', async () => {
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
                ExpressionAttributeValues: { ':deep': deepMap(33) },
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      assertDynamoError(err, 'ValidationException')
      expect(NEST_33).toContain((err as Error).message)
    }
  })

  it('refuses a Put whose condition compares a value nested 33 levels, and writes nothing', async () => {
    try {
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: hashTableDef.name,
                Item: { pk: { S: 'nest-twi-put-33' } },
                ConditionExpression: 'attribute_not_exists(pk) AND #d <> :deep',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':deep': deepMap(33) },
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      assertDynamoError(err, 'ValidationException')
      expect(NEST_33).toContain((err as Error).message)
    }
    const get = await ddb.send(
      new GetItemCommand({ TableName: hashTableDef.name, Key: { pk: { S: 'nest-twi-put-33' } }, ConsistentRead: true }),
    )
    expect(get.Item).toBeUndefined()
  })

  it('refuses an Update writing a value nested 33 levels before the transaction runs', async () => {
    try {
      await ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: hashTableDef.name,
                Key: { pk: { S: 'nest-twi-upd-33' } },
                UpdateExpression: 'SET deep = :deep',
                ExpressionAttributeValues: { ':deep': deepMap(33) },
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      assertDynamoError(err, 'ValidationException')
      expect(NEST_33).toContain((err as Error).message)
    }
  })

  // Past 60 levels both groups of regions name the key. The request still has
  // to be read to get there: a value this deep is a ValidationException, never
  // a failure to parse the request body.
  for (const [shape, build] of [['map', deepMap], ['list', deepList]] as const) {
    it(`refuses a ConditionCheck ${shape} value nested 61 levels, naming the key`, async () => {
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
                  ExpressionAttributeValues: { ':deep': build(61) },
                },
              },
            ],
          }),
        )
        expect.unreachable('should have thrown')
      } catch (err) {
        assertDynamoError(err, 'ValidationException')
        expect((err as Error).message).toBe(nestForKey(':deep'))
      }
    })
  }
})
