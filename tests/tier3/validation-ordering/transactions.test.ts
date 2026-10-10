import {
  GetItemCommand,
  PutItemCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  DynamoDBServiceException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import { absentTableName, cleanupItems, declareTables, hashTableDef } from '../../../src/helpers.js'

declareTables(hashTableDef)

// What the transaction operations check first when a request has more than
// one thing wrong with it. Captured in us-east-1 and eu-west-2, 2026-10-09,
// each case sent with and without an unknown ReturnConsumedCapacity so the
// other failure's own answer is on record next to the combined one.
//
// Member constraints (the enums, the TransactItems length, the
// ClientRequestToken length, a table name's pattern) are checked before the
// request is read any further, and every failing member is reported in one
// `N validation errors detected:` message. Everything else (a missing table, a
// duplicate target, a key that does not match the schema) comes after.

const ENUM_RCC =
  "Value 'BOGUS' at 'returnConsumedCapacity' failed to satisfy constraint: Member must satisfy enum value set: [INDEXES, TOTAL, NONE]"
const ENUM_RICM =
  "Value 'BOGUS2' at 'returnItemCollectionMetrics' failed to satisfy constraint: Member must satisfy enum value set: [SIZE, NONE]"
const one = (m: string) => `1 validation error detected: ${m}`

const key = (pk: string): Record<string, AttributeValue> => ({ pk: { S: pk } })
const written = [key('vo-tx-rcc'), key('vo-tx-ricm'), key('vo-tx-both'), key('vo-tx-token'), key('vo-tx-dup'), key('vo-tx-deep'), key('vo-tx-cc')]

afterAll(async () => {
  await cleanupItems(hashTableDef.name, written)
})

async function absent(k: Record<string, AttributeValue>): Promise<void> {
  const got = await ddb.send(new GetItemCommand({ TableName: hashTableDef.name, Key: k, ConsistentRead: true }))
  expect(got.Item).toBeUndefined()
}

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

describe('TransactWriteItems — validation ordering', { tags: ['transactions', 'data-plane', 'negative-path'] }, () => {
  // An empty TransactItems is rejected by any target that implements the
  // operation, so this separates "not implemented" from "implemented".
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  it('refuses an unknown ReturnConsumedCapacity and writes nothing', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: hashTableDef.name, Item: key('vo-tx-rcc') } }],
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
    await absent(key('vo-tx-rcc'))
  })

  it('refuses an unknown ReturnItemCollectionMetrics and writes nothing', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: hashTableDef.name, Item: key('vo-tx-ricm') } }],
          ReturnItemCollectionMetrics: 'BOGUS2' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RICM))
    await absent(key('vo-tx-ricm'))
  })

  it('reports both unknown enums in one message, ReturnConsumedCapacity first', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: hashTableDef.name, Item: key('vo-tx-both') } }],
          ReturnConsumedCapacity: 'BOGUS' as any,
          ReturnItemCollectionMetrics: 'BOGUS2' as any,
        }),
      ),
    )
    expect(message).toBe(`2 validation errors detected: ${ENUM_RCC}; ${ENUM_RICM}`)
    await absent(key('vo-tx-both'))
  })

  it('reports an unknown ReturnConsumedCapacity ahead of a missing table', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: absentTableName('vo_tx_missing'), Item: key('a') } }],
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })

  it('reports an unknown ReturnConsumedCapacity ahead of a duplicate target', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: hashTableDef.name, Item: key('vo-tx-dup') } },
            { Delete: { TableName: hashTableDef.name, Key: key('vo-tx-dup') } },
          ],
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })

  // The wording of a too-long token is mid-rollout. eu-west-2 already gives
  // the validation framework's generic sentence, which names the member
  // without echoing it, and reports it alone; us-east-1 echoes the token and
  // still combines it with the other member errors. Either way the token comes
  // first, which is what the second test pins.
  const TOKEN = 'x'.repeat(37)
  const TOKEN_GENERIC =
    "Value at 'ClientRequestToken' failed to satisfy constraint: Member must have length less than or equal to 36"
  const TOKEN_ECHOED = `Value '${TOKEN}' at 'clientRequestToken' failed to satisfy constraint: Member must have length less than or equal to 36`

  it('refuses a ClientRequestToken over 36 characters', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: hashTableDef.name, Item: key('vo-tx-token') } }],
          ClientRequestToken: TOKEN,
        }),
      ),
    )
    expect([one(TOKEN_GENERIC), one(TOKEN_ECHOED)]).toContain(message)
    await absent(key('vo-tx-token'))
  })

  it('reports a ClientRequestToken over 36 characters ahead of an unknown ReturnConsumedCapacity', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: hashTableDef.name, Item: key('vo-tx-token') } }],
          ClientRequestToken: TOKEN,
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect([one(TOKEN_GENERIC), `2 validation errors detected: ${TOKEN_ECHOED}; ${ENUM_RCC}`]).toContain(message)
  })

  // An expression that does not parse is refused before any action runs and
  // before any table is looked up, whichever action carries it. Between two
  // failing actions, the first in request order wins.
  const SYNTAX = 'Invalid ConditionExpression: Syntax error; token: "<EOF>", near: "("'
  const deep32 = (): AttributeValue => {
    let v: AttributeValue = { S: 'leaf' }
    for (let i = 0; i < 32; i++) v = { M: { n: v } }
    return v
  }
  const NEST_BARE =
    'Nesting Levels have exceeded supported limits: Attributes in the item have nested levels beyond supported limit'

  it('reports a malformed condition on a later action ahead of a missing table on an earlier one', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: absentTableName('vo_tx_missing'), Item: key('a') } },
            {
              ConditionCheck: {
                TableName: hashTableDef.name,
                Key: key('vo-tx-cc'),
                ConditionExpression: 'attribute_not_exists(',
              },
            },
          ],
        }),
      ),
    )
    expect(message).toBe(SYNTAX)
  })

  it('reports a malformed condition on the first action ahead of a too deep item on the second', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: hashTableDef.name,
                Key: key('vo-tx-cc'),
                ConditionExpression: 'attribute_not_exists(',
              },
            },
            { Put: { TableName: hashTableDef.name, Item: { ...key('vo-tx-deep'), data: deep32() } } },
          ],
        }),
      ),
    )
    expect(message).toBe(SYNTAX)
  })

  it('reports a too deep item on the first action ahead of a malformed condition on the second', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: hashTableDef.name, Item: { ...key('vo-tx-deep'), data: deep32() } } },
            {
              ConditionCheck: {
                TableName: hashTableDef.name,
                Key: key('vo-tx-cc'),
                ConditionExpression: 'attribute_not_exists(',
              },
            },
          ],
        }),
      ),
    )
    expect(message).toBe(NEST_BARE)
  })

  // A value no expression uses is refused before any action runs, on every
  // action type, ahead of a missing table or a duplicate target wherever they
  // sit. us-east-1 and eu-west-2 agree (2026-10-09).
  const UNUSED = 'Value provided in ExpressionAttributeValues unused in expressions: keys: {:v}'
  const unusedCheck = () => ({
    ConditionCheck: {
      TableName: hashTableDef.name,
      Key: key('vo-tx-cc'),
      ConditionExpression: 'attribute_not_exists(pk)',
      ExpressionAttributeValues: { ':v': { S: 'x' } },
    },
  })

  it('reports an unused value ahead of a missing table on an earlier action', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: absentTableName('vo_tx_missing'), Item: key('a') } }, unusedCheck()],
        }),
      ),
    )
    expect(message).toBe(UNUSED)
  })

  it('reports an unused value ahead of a missing table on a later action', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [unusedCheck(), { Put: { TableName: absentTableName('vo_tx_missing'), Item: key('a') } }],
        }),
      ),
    )
    expect(message).toBe(UNUSED)
  })

  it('reports an unused value ahead of a duplicate target', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: hashTableDef.name, Item: key('vo-tx-cc') } }, unusedCheck()],
        }),
      ),
    )
    expect(message).toBe(UNUSED)
    await absent(key('vo-tx-cc'))
  })
})

describe('TransactGetItems — validation ordering', { tags: ['transactions', 'data-plane', 'negative-path'] }, () => {
  skipUnlessSupported(() => ddb.send(new TransactGetItemsCommand({ TransactItems: [] })))

  beforeAll(async () => {
    await ddb.send(new PutItemCommand({ TableName: hashTableDef.name, Item: key('vo-tg-item') }))
  })

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, [key('vo-tg-item')])
  })

  it('refuses an unknown ReturnConsumedCapacity', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactGetItemsCommand({
          TransactItems: [{ Get: { TableName: hashTableDef.name, Key: key('vo-tg-item') } }],
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })

  it('reports an unknown ReturnConsumedCapacity ahead of a missing table', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactGetItemsCommand({
          TransactItems: [{ Get: { TableName: absentTableName('vo_tg_missing'), Key: key('a') } }],
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })

  it('reports an unknown ReturnConsumedCapacity ahead of a duplicate target', async () => {
    const message = await refusal(() =>
      ddb.send(
        new TransactGetItemsCommand({
          TransactItems: [
            { Get: { TableName: hashTableDef.name, Key: key('vo-tg-item') } },
            { Get: { TableName: hashTableDef.name, Key: key('vo-tg-item') } },
          ],
          ReturnConsumedCapacity: 'BOGUS' as any,
        }),
      ),
    )
    expect(message).toBe(one(ENUM_RCC))
  })
})
