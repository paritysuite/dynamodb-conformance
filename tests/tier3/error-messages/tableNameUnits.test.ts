import {
  DeleteItemCommand,
  DynamoDBServiceException,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { observeSplit } from '../../../src/observation-sink.js'

// How the item operations measure a table name. Captured in 33 regions,
// 2026-11-05.
//
// A shallow request counts the name in characters, so two emoji are too short
// and 128 emoji are not too long. It reports the first broken constraint
// alone, except on UpdateItem, which lists the pattern and then the length.
// On 2026-11-05, me-central-1, and eu-north-1 on Scan, counted UTF-16 units and
// listed both constraints, so the cases that tell the two apart are split by
// region and pin the eu-west-2 answer.

const TWO_EMOJI = '😀😀'
const MANY_EMOJI = '😀'.repeat(128)
const KEY = { pk: { S: 'a' } }

const nameError = (value: string, rule: string) => `Value '${value}' at 'tableName' failed to satisfy constraint: Member must ${rule}`
const TOO_SHORT = 'have length greater than or equal to 3'
const PATTERN = 'satisfy regular expression pattern: [a-zA-Z0-9_.-]+'
const one = (error: string) => `1 validation error detected: ${error}`

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

const put = (TableName: string) => () => ddb.send(new PutItemCommand({ TableName, Item: KEY }))
const update = (TableName: string) => () => ddb.send(new UpdateItemCommand({ TableName, Key: KEY }))
const get = (TableName: string) => () => ddb.send(new GetItemCommand({ TableName, Key: KEY }))
const del = (TableName: string) => () => ddb.send(new DeleteItemCommand({ TableName, Key: KEY }))
const query = (TableName: string) => () =>
  ddb.send(new QueryCommand({ TableName, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': { S: 'a' } } }))
const scan = (TableName: string) => () => ddb.send(new ScanCommand({ TableName }))

describe('Item operations count a table name in characters', { tags: ['put-item', 'update-item', 'get-item', 'delete-item', 'query', 'scan', 'data-plane', 'negative-path'] }, () => {
  it('PutItem does not find 200 accented letters too long', async () => {
    // Every region agrees: 200 characters, 200 UTF-16 units, 400 bytes.
    const name = 'é'.repeat(200)
    expect(await refusal(put(name))).toBe(one(nameError(name, PATTERN)))
  })
})

// The older validation layer, which served me-central-1 (and eu-north-1 on
// Scan) on 2026-11-05, counts these names in UTF-16 units, so
// registry/splits.json carries its answers beside the pinned one.
describe('Item operations count a table name in characters, split by region', { tags: ['put-item', 'update-item', 'get-item', 'delete-item', 'query', 'scan', 'data-plane', 'negative-path'] }, () => {
  it('PutItem reports only the length for two accented letters', async (ctx) => {
    // Split behaviour (registry row put-item-two-accented-table-name).
    expect(await refusal(() => observeSplit(ctx.task, put('éé')))).toBe(one(nameError('éé', TOO_SHORT)))
  })

  it('PutItem finds two emoji too short', async (ctx) => {
    // Split behaviour (registry row put-item-two-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, put(TWO_EMOJI)))).toBe(one(nameError(TWO_EMOJI, TOO_SHORT)))
  })

  it('PutItem does not find 128 emoji too long', async (ctx) => {
    // Split behaviour (registry row put-item-128-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, put(MANY_EMOJI)))).toBe(one(nameError(MANY_EMOJI, PATTERN)))
  })

  it('UpdateItem finds two emoji too short, after the pattern', async (ctx) => {
    // Split behaviour (registry row update-item-two-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, update(TWO_EMOJI)))).toBe(
      `2 validation errors detected: ${nameError(TWO_EMOJI, PATTERN)}; ${nameError(TWO_EMOJI, TOO_SHORT)}`,
    )
  })

  it('GetItem finds two emoji too short', async (ctx) => {
    // Split behaviour (registry row get-item-two-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, get(TWO_EMOJI)))).toBe(one(nameError(TWO_EMOJI, TOO_SHORT)))
  })

  it('GetItem does not find 128 emoji too long', async (ctx) => {
    // Split behaviour (registry row get-item-128-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, get(MANY_EMOJI)))).toBe(one(nameError(MANY_EMOJI, PATTERN)))
  })

  it('DeleteItem finds two emoji too short', async (ctx) => {
    // Split behaviour (registry row delete-item-two-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, del(TWO_EMOJI)))).toBe(one(nameError(TWO_EMOJI, TOO_SHORT)))
  })

  it('DeleteItem does not find 128 emoji too long', async (ctx) => {
    // Split behaviour (registry row delete-item-128-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, del(MANY_EMOJI)))).toBe(one(nameError(MANY_EMOJI, PATTERN)))
  })

  it('Query finds two emoji too short', async (ctx) => {
    // Split behaviour (registry row query-two-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, query(TWO_EMOJI)))).toBe(one(nameError(TWO_EMOJI, TOO_SHORT)))
  })

  it('Query does not find 128 emoji too long', async (ctx) => {
    // Split behaviour (registry row query-128-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, query(MANY_EMOJI)))).toBe(one(nameError(MANY_EMOJI, PATTERN)))
  })

  it('Scan finds two emoji too short', async (ctx) => {
    // Split behaviour (registry row scan-two-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, scan(TWO_EMOJI)))).toBe(one(nameError(TWO_EMOJI, TOO_SHORT)))
  })

  it('Scan does not find 128 emoji too long', async (ctx) => {
    // Split behaviour (registry row scan-128-emoji-table-name).
    expect(await refusal(() => observeSplit(ctx.task, scan(MANY_EMOJI)))).toBe(one(nameError(MANY_EMOJI, PATTERN)))
  })
})
