import {
  BatchWriteItemCommand,
  BatchGetItemCommand,
  GetItemCommand,
  DynamoDBServiceException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { absentTableName, cleanupItems, declareTables, hashTableDef } from '../../../src/helpers.js'

declareTables(hashTableDef)

// What these two assert is the ordering: an empty RequestItems map is refused
// before the map is read, so the request never reaches a table. The wording of
// the refusal is regional and is not this tier's business. The 2026-06
// validation-framework rollout is replacing the bespoke sentence
// `The <op>Items parameter is required for <Op>` with the framework's generic
// `Value at 'RequestItems' failed to satisfy constraint: ...`, and as of
// 2026-08-17 BatchGetItem has crossed in 11 of the 33 answering regions while
// BatchWriteItem has crossed in none. Matching the parameter name
// case-insensitively spans both wordings, so a rewording does not turn an
// ordering test red. Registry row batch-get-item-empty-request-items-message
// and the tier 3 error-messages test it keys to pin the exact wording.
const REJECTS_EMPTY_REQUEST_ITEMS = /requestitems/i

describe('Batch operations — validation ordering', { tags: ['batch', 'data-plane', 'negative-path'] }, () => {
  it('BatchWriteItem rejects empty RequestItems', async () => {
    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {},
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toMatch(REJECTS_EMPTY_REQUEST_ITEMS)
    }
  })

  it('BatchGetItem rejects empty RequestItems', async () => {
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {},
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toMatch(REJECTS_EMPTY_REQUEST_ITEMS)
    }
  })

  it('BatchWriteItem rejects more than 25 items with exact count in message', async () => {
    // Build 26 put requests
    const requests = Array.from({ length: 26 }, (_, i) => ({
      PutRequest: {
        Item: { pk: { S: `item_${i}` } },
      },
    }))

    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [hashTableDef.name]: requests,
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // DynamoDB reports the number of items in validation error
      expect(err.message).toMatch(/member must have length less than or equal to 25|too many items/i)
    }
  })

  it('BatchGetItem rejects more than 100 keys with exact count in message', async () => {
    // Build 101 key requests
    const keys = Array.from({ length: 101 }, (_, i) => ({
      pk: { S: `key_${i}` },
    }))

    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [hashTableDef.name]: {
              Keys: keys,
            },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // DynamoDB reports too many items in validation error
      expect(err.message).toMatch(/member must have length less than or equal to 100|too many items/i)
    }
  })
})

// Which failure wins when a batch request has more than one. Captured in
// us-east-1 and eu-west-2, 2026-10-09, each case sent with and without an
// unknown ReturnConsumedCapacity. Member constraints are checked first and
// reported together in one `N validation errors detected:` message; a missing
// table, duplicate keys and key-schema problems come after. A table name that
// fails its pattern is a member constraint on BatchGetItem's RequestItems map,
// and is reported together with the enum, but BatchWriteItem gives way to the
// enum and reports it alone.
const ENUM_RCC =
  "Value 'BOGUS' at 'returnConsumedCapacity' failed to satisfy constraint: Member must satisfy enum value set: [INDEXES, TOTAL, NONE]"
const ENUM_RICM =
  "Value 'BOGUS2' at 'returnItemCollectionMetrics' failed to satisfy constraint: Member must satisfy enum value set: [SIZE, NONE]"
const one = (m: string) => `1 validation error detected: ${m}`
const key = (pk: string): Record<string, AttributeValue> => ({ pk: { S: pk } })

async function refusal(send: () => Promise<unknown>): Promise<string> {
  try {
    await send()
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(DynamoDBServiceException)
    const err = e as DynamoDBServiceException
    expect(err.name).toBe('ValidationException')
    return err.message
  }
  expect.unreachable('should have thrown')
  return ''
}

async function absent(k: Record<string, AttributeValue>): Promise<void> {
  const got = await ddb.send(new GetItemCommand({ TableName: hashTableDef.name, Key: k, ConsistentRead: true }))
  expect(got.Item).toBeUndefined()
}

describe('Batch operations — enum and ordering checks', { tags: ['batch', 'data-plane', 'negative-path'] }, () => {
  const written = [key('vo-bw-rcc'), key('vo-bw-ricm'), key('vo-bw-both'), key('vo-bw-badname')]

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, written)
  })

  it('BatchWriteItem refuses an unknown ReturnConsumedCapacity and writes nothing', async () => {
    const message = await refusal(() =>
      ddb.send(
        new BatchWriteItemCommand({
          RequestItems: { [hashTableDef.name]: [{ PutRequest: { Item: key('vo-bw-rcc') } }] },
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
    await absent(key('vo-bw-rcc'))
  })

  it('BatchWriteItem refuses an unknown ReturnItemCollectionMetrics and writes nothing', async () => {
    const message = await refusal(() =>
      ddb.send(
        new BatchWriteItemCommand({
          RequestItems: { [hashTableDef.name]: [{ PutRequest: { Item: key('vo-bw-ricm') } }] },
          ReturnItemCollectionMetrics: 'BOGUS2' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RICM))
    await absent(key('vo-bw-ricm'))
  })

  it('BatchWriteItem reports both unknown enums in one message, ReturnConsumedCapacity first', async () => {
    const message = await refusal(() =>
      ddb.send(
        new BatchWriteItemCommand({
          RequestItems: { [hashTableDef.name]: [{ PutRequest: { Item: key('vo-bw-both') } }] },
          ReturnConsumedCapacity: 'BOGUS' as any,
          ReturnItemCollectionMetrics: 'BOGUS2' as any,
        }),
      ),
    )
    expect(message).toBe(`2 validation errors detected: ${ENUM_RCC}; ${ENUM_RICM}`)
    await absent(key('vo-bw-both'))
  })

  it('BatchWriteItem reports an unknown ReturnConsumedCapacity ahead of a missing table', async () => {
    const message = await refusal(() =>
      ddb.send(
        new BatchWriteItemCommand({
          RequestItems: { [absentTableName('vo_bw_missing')]: [{ PutRequest: { Item: key('a') } }] },
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })

  it('BatchWriteItem reports an unknown ReturnConsumedCapacity alone over a malformed table name', async () => {
    const message = await refusal(() =>
      ddb.send(
        new BatchWriteItemCommand({
          RequestItems: { 'bad!name': [{ PutRequest: { Item: key('vo-bw-badname') } }] },
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })

  it('BatchGetItem refuses an unknown ReturnConsumedCapacity', async () => {
    const message = await refusal(() =>
      ddb.send(
        new BatchGetItemCommand({
          RequestItems: { [hashTableDef.name]: { Keys: [key('a')] } },
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })

  it('BatchGetItem reports an unknown ReturnConsumedCapacity ahead of a missing table', async () => {
    const message = await refusal(() =>
      ddb.send(
        new BatchGetItemCommand({
          RequestItems: { [absentTableName('vo_bg_missing')]: { Keys: [key('a')] } },
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })

  it('BatchGetItem reports a malformed table name and an unknown ReturnConsumedCapacity together', async () => {
    const message = await refusal(() =>
      ddb.send(
        new BatchGetItemCommand({
          RequestItems: { 'bad!name': { Keys: [{ pk: { S: 'a' } }] } },
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(
      `2 validation errors detected: Value '{"bad!name":{"Keys":[{"pk":{"S":"a"}}]}}' at 'requestItems' failed to satisfy constraint: Map keys must satisfy constraint: [Member must have length less than or equal to 255, Member must have length greater than or equal to 3, Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+]; ${ENUM_RCC}`,
    )
  })
})
