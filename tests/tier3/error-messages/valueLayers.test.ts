import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  DynamoDBServiceException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import { cleanupItems, declareTables, hashTableDef } from '../../../src/helpers.js'
import { recordObserved } from '../../../src/observation-sink.js'

declareTables(hashTableDef)

// DynamoDB checks attribute values in one of two layers, and which one an
// operation runs decides the wording of a bad number or a duplicate set
// member. Captured in eu-west-2, us-east-1, eu-west-1 and us-west-2,
// 2026-10-09 (four of four unless a test says otherwise).
//
//   current  PutItem, UpdateItem and DeleteItem, inside the
//            `1 validation error detected: ` envelope wherever the value sits
//            (item, key, expression value, AttributeUpdates, Expected, set
//            member, nested); GetItem, BatchGetItem and Query, bare.
//   older    BatchWriteItem, TransactWriteItems, TransactGetItems and Scan,
//            bare, with expression values inside the
//            `ExpressionAttributeValues contains invalid value: ` wrapper.
//
// That table is the 2026-10-09 state, when eu-west-2 already ran the current
// layer on transactions. Transactions and BatchWriteItem have moved since, as
// follows.
//
// eu-west-2 runs the current layer on transactions. Of the 33 regions that
// answered on 2026-11-13, 31 ran the current layer; ap-south-1 had joined them
// on 2026-11-14, which leaves me-central-1 on the older one. The transaction
// tests assert the current layer, and each has a registry row recording
// me-central-1 on the older one.
//
// On 2026-10-22 eu-west-2 and eu-north-1 had moved BatchWriteItem to the
// current layer as well, bare, while us-east-1 still ran the older one, so the
// BatchWriteItem tests accept either layer as a whole.

const T = hashTableDef.name
const S = (s: string): AttributeValue => ({ S: s })
const N = (n: string): AttributeValue => ({ N: n })
const one = (m: string) => `1 validation error detected: ${m}`
const forKey = (m: string, k: string) => `ExpressionAttributeValues contains invalid value: ${m} for key ${k}`

const written = [{ pk: S('layer-n') }, { pk: S('layer-n-expected') }, { pk: S('layer-d') }]
afterAll(async () => {
  await cleanupItems(T, written)
})

async function refusal(send: () => Promise<unknown>): Promise<string> {
  try {
    await send()
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(DynamoDBServiceException)
    const err = e as DynamoDBServiceException
    expect(err.name).toBe('ValidationException')
    return err.message
  }
  return '(accepted)'
}

// ---- Numbers ---------------------------------------------------------------

const OVERFLOW = 'Number overflow. Attempting to store a number with magnitude larger than supported range'
const UNDERFLOW = 'Number underflow. Attempting to store a number with magnitude smaller than supported range'
const NOT_NUMERIC = 'The parameter cannot be converted to a numeric value'

// The four shapes sent to every surface, and the current layer's answer to
// each. An exponent that fits a 64-bit integer is range-checked, so
// 1e2147483647 overflows; an empty string keeps the colon and a space.
const SHAPES = ['abc', '', '1e126', '1e2147483647']
const CURRENT = [`${NOT_NUMERIC}: abc`, `${NOT_NUMERIC}: `, OVERFLOW, OVERFLOW]
// The older layer reads the number as Java's BigDecimal does: 1e2147483647
// wraps to an underflow, and an empty string has no colon.
const OLDER = [`${NOT_NUMERIC}: abc`, NOT_NUMERIC, OVERFLOW, UNDERFLOW]

async function eachShape(send: (v: AttributeValue, raw: string) => Promise<unknown>): Promise<string[]> {
  const got: string[] = []
  for (const sh of SHAPES) got.push(await refusal(() => send(N(sh), sh)))
  return got
}

describe('Number values — messages by operation', { tags: ['put-item', 'update-item', 'delete-item', 'get-item', 'query', 'batch', 'data-plane', 'negative-path'] }, () => {
  it('PutItem refuses every malformed number in an item inside the validation envelope', async () => {
    // Exponents past an int, NaN and Infinity, stray spaces and too many
    // digits: every one is enveloped (eu-west-2 and us-east-1).
    const cases: [string, string][] = [
      ['1e99999999999', OVERFLOW],
      ['-1e99999999999', OVERFLOW],
      ['1e-99999999999', UNDERFLOW],
      ['1e2147483648', OVERFLOW],
      ['1e2147483647', OVERFLOW],
      ['1e-2147483648', UNDERFLOW],
      ['1e126', OVERFLOW],
      ['1e-131', UNDERFLOW],
      ['abc', `${NOT_NUMERIC}: abc`],
      ['1.2.3', `${NOT_NUMERIC}: 1.2.3`],
      ['', `${NOT_NUMERIC}: `],
      [' 1', `${NOT_NUMERIC}:  1`],
      ['1 ', `${NOT_NUMERIC}: 1 `],
      ['0x10', `${NOT_NUMERIC}: 0x10`],
      ['1e', `${NOT_NUMERIC}: 1e`],
      ['NaN', `${NOT_NUMERIC}: NaN`],
      ['Infinity', `${NOT_NUMERIC}: Infinity`],
      ['1234567890123456789012345678901234567890', 'Attempting to store more than 38 significant digits in a Number'],
    ]
    const got: string[] = []
    for (const [n] of cases) {
      got.push(await refusal(() => ddb.send(new PutItemCommand({ TableName: T, Item: { pk: S('layer-n'), n: N(n) } }))))
    }
    expect(got).toEqual(cases.map(([, m]) => one(m)))
  })

  it('PutItem refuses a malformed number set member and a nested number inside the envelope', async () => {
    const member = await eachShape((_, raw) => ddb.send(new PutItemCommand({ TableName: T, Item: { pk: S('layer-n'), n: { NS: ['1', raw] } } })))
    const nested = await eachShape((v) => ddb.send(new PutItemCommand({ TableName: T, Item: { pk: S('layer-n'), n: { M: { x: { L: [v] } } } } })))
    expect({ member, nested }).toEqual({ member: CURRENT.map(one), nested: CURRENT.map(one) })
  })

  it('PutItem refuses a malformed number in a condition value inside the envelope', async () => {
    const got = await eachShape((v) =>
      ddb.send(
        new PutItemCommand({
          TableName: T,
          Item: { pk: S('layer-n') },
          ConditionExpression: 'attribute_not_exists(pk) OR n = :v',
          ExpressionAttributeValues: { ':v': v },
        }),
      ),
    )
    expect(got).toEqual(CURRENT.map(one))
  })

  it('PutItem checks the numbers in Expected values and writes nothing', { tags: ['legacy'] }, async () => {
    const got = await eachShape((v) => ddb.send(new PutItemCommand({ TableName: T, Item: { pk: S('layer-n-expected') }, Expected: { n: { Value: v } } })))
    expect(got).toEqual(CURRENT.map(one))
    const item = await ddb.send(new GetItemCommand({ TableName: T, Key: { pk: S('layer-n-expected') }, ConsistentRead: true }))
    expect(item.Item).toBeUndefined()
  })

  it('UpdateItem refuses a malformed number in a value, in AttributeUpdates and in the key inside the envelope', { tags: ['legacy'] }, async () => {
    const value = await eachShape((v) =>
      ddb.send(new UpdateItemCommand({ TableName: T, Key: { pk: S('layer-n') }, UpdateExpression: 'SET n = :v', ExpressionAttributeValues: { ':v': v } })),
    )
    const attributeUpdates = await eachShape((v) =>
      ddb.send(new UpdateItemCommand({ TableName: T, Key: { pk: S('layer-n') }, AttributeUpdates: { n: { Action: 'PUT', Value: v } } })),
    )
    const keyValue = await eachShape((v) =>
      ddb.send(new UpdateItemCommand({ TableName: T, Key: { pk: v }, UpdateExpression: 'SET n = :o', ExpressionAttributeValues: { ':o': N('1') } })),
    )
    const want = CURRENT.map(one)
    expect({ value, attributeUpdates, keyValue }).toEqual({ value: want, attributeUpdates: want, keyValue: want })
  })

  it('DeleteItem refuses a malformed number in a condition value and in the key inside the envelope, with no wrapper', async () => {
    const value = await eachShape((v) =>
      ddb.send(new DeleteItemCommand({ TableName: T, Key: { pk: S('layer-n') }, ConditionExpression: 'n = :v', ExpressionAttributeValues: { ':v': v } })),
    )
    const keyValue = await eachShape((v) => ddb.send(new DeleteItemCommand({ TableName: T, Key: { pk: v } })))
    expect({ value, keyValue }).toEqual({ value: CURRENT.map(one), keyValue: CURRENT.map(one) })
  })

  it('GetItem, BatchGetItem and Query refuse a malformed number bare, in the current wording', async () => {
    const get = await eachShape((v) => ddb.send(new GetItemCommand({ TableName: T, Key: { pk: v } })))
    const batchGet = await eachShape((v) => ddb.send(new BatchGetItemCommand({ RequestItems: { [T]: { Keys: [{ pk: v }] } } })))
    const query = await eachShape((v) =>
      ddb.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :p',
          FilterExpression: 'n = :v',
          ExpressionAttributeValues: { ':p': S('layer-n'), ':v': v },
        }),
      ),
    )
    expect({ get, batchGet, query }).toEqual({ get: CURRENT, batchGet: CURRENT, query: CURRENT })
  })

  it('BatchWriteItem refuses a malformed number bare, in one layer for every shape', async () => {
    const got = await eachShape((v) => ddb.send(new BatchWriteItemCommand({ RequestItems: { [T]: [{ PutRequest: { Item: { pk: S('layer-n'), n: v } } }] } })))
    // Either layer, as a whole: see the note at the top of the file.
    expect([OLDER, CURRENT]).toContainEqual(got)
  })
})

// The transaction tests are split by region, one registry row each. A region
// on the older layer answers every request a test sends in that layer, so a
// target is recorded as answering the way it does only when every answer is
// the older layer's, never on a mix. The record is the older layer's answer to
// the test's last request as the target gave it, which differs from the
// current layer's in every one of these tests and is what each row holds for
// those regions. A pass needs no record, since it already means the pinned
// eu-west-2 answer.
function recordOlderLayer(task: Parameters<typeof recordObserved>[0], got: string[], older: string[]): void {
  if (got.length === older.length && got.every((m, i) => m === older[i])) {
    recordObserved(task, { outcome: 'rejected', error: { name: 'ValidationException', message: got[got.length - 1] } })
  }
}

describe('Number values — transactions by region', { tags: ['transactions', 'data-plane', 'negative-path'] }, () => {
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  // eu-west-2 runs the current layer here. On their latest answers, by
  // 2026-11-14, so did every other region but me-central-1, which ran the older
  // one for every shape.

  it('TransactWriteItems refuses a malformed number in a Put item up front', async (ctx) => {
    // Split behaviour (registry row transact-write-items-put-number-layer).
    const got = await eachShape((v) => ddb.send(new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: T, Item: { pk: S('layer-n'), n: v } } }] })))
    recordOlderLayer(ctx.task, got, OLDER)
    expect(got).toEqual(CURRENT)
  })

  it('TransactWriteItems refuses a malformed number in an Update value up front', async (ctx) => {
    // Split behaviour (registry row transact-write-items-update-number-layer).
    const got = await eachShape((v) =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [{ Update: { TableName: T, Key: { pk: S('layer-n') }, UpdateExpression: 'SET n = :v', ExpressionAttributeValues: { ':v': v } } }],
        }),
      ),
    )
    recordOlderLayer(ctx.task, got, OLDER.map((m) => forKey(m, ':v')))
    expect(got).toEqual(CURRENT)
  })

  it('TransactGetItems refuses a malformed number in a key up front', async (ctx) => {
    // Split behaviour (registry row transact-get-items-key-number-layer).
    const got = await eachShape((v) => ddb.send(new TransactGetItemsCommand({ TransactItems: [{ Get: { TableName: T, Key: { pk: v } } }] })))
    recordOlderLayer(ctx.task, got, OLDER)
    expect(got).toEqual(CURRENT)
  })
})

// ---- Duplicate set members -------------------------------------------------

// Each set is sent with a repeated member and not in order: SS b, a, b; BS
// /w==, AA==, AA==; NS 2, 1, 2. The current layer quotes the members and
// lists them in byte order up to the first repeat, then the repeat, then the
// rest as sent; it names no members of a number set. The older layer prints
// the members as sent, unquoted, and drops the prefix and full stop from the
// number-set message.
const DUPES: [string, AttributeValue][] = [
  ['SS', { SS: ['b', 'a', 'b'] }],
  ['BS', { BS: [Buffer.from('/w==', 'base64'), Buffer.from('AA==', 'base64'), Buffer.from('AA==', 'base64')] }],
  ['NS', { NS: ['2', '1', '2'] }],
]
const INVALID = 'One or more parameter values were invalid: '
const DUPE_CURRENT = [
  `${INVALID}Input collection ["a", "b", "b"] contains duplicates.`,
  `${INVALID}Input collection ["AA==","/w==","AA=="]of type BS contains duplicates.`,
  `${INVALID}Input collection contains duplicates.`,
]
const DUPE_OLDER = [
  `${INVALID}Input collection [b, a, b] contains duplicates.`,
  `${INVALID}Input collection [/w==, AA==, AA==]of type BS contains duplicates.`,
  'Input collection contains duplicates',
]

async function eachSet(send: (d: AttributeValue) => Promise<unknown>): Promise<string[]> {
  const got: string[] = []
  for (const [, d] of DUPES) got.push(await refusal(() => send(d)))
  return got
}

describe('Duplicate set members — messages by operation', { tags: ['put-item', 'update-item', 'delete-item', 'get-item', 'query', 'batch', 'data-plane', 'negative-path'] }, () => {
  it('PutItem refuses a duplicate in an item, a condition value and an Expected value inside the envelope', { tags: ['legacy'] }, async () => {
    const item = await eachSet((d) => ddb.send(new PutItemCommand({ TableName: T, Item: { pk: S('layer-d'), s: d } })))
    const condition = await eachSet((d) =>
      ddb.send(
        new PutItemCommand({
          TableName: T,
          Item: { pk: S('layer-d') },
          ConditionExpression: 'attribute_not_exists(pk) OR s = :t',
          ExpressionAttributeValues: { ':t': d },
        }),
      ),
    )
    const expected = await eachSet((d) => ddb.send(new PutItemCommand({ TableName: T, Item: { pk: S('layer-d') }, Expected: { s: { Value: d } } })))
    const want = DUPE_CURRENT.map(one)
    expect({ item, condition, expected }).toEqual({ item: want, condition: want, expected: want })
  })

  it('UpdateItem refuses a duplicate in a condition value, AttributeUpdates and the key inside the envelope', { tags: ['legacy'] }, async () => {
    const condition = await eachSet((d) =>
      ddb.send(
        new UpdateItemCommand({
          TableName: T,
          Key: { pk: S('layer-d') },
          UpdateExpression: 'SET o = :o',
          ConditionExpression: 'attribute_not_exists(pk) OR s = :t',
          ExpressionAttributeValues: { ':o': N('1'), ':t': d },
        }),
      ),
    )
    const attributeUpdates = await eachSet((d) =>
      ddb.send(new UpdateItemCommand({ TableName: T, Key: { pk: S('layer-d') }, AttributeUpdates: { s: { Action: 'PUT', Value: d } } })),
    )
    const keyValue = await eachSet((d) =>
      ddb.send(new UpdateItemCommand({ TableName: T, Key: { pk: d }, UpdateExpression: 'SET o = :o', ExpressionAttributeValues: { ':o': N('1') } })),
    )
    const want = DUPE_CURRENT.map(one)
    expect({ condition, attributeUpdates, keyValue }).toEqual({ condition: want, attributeUpdates: want, keyValue: want })
  })

  it('DeleteItem refuses a duplicate in the key inside the envelope', async () => {
    const got = await eachSet((d) => ddb.send(new DeleteItemCommand({ TableName: T, Key: { pk: d } })))
    expect(got).toEqual(DUPE_CURRENT.map(one))
  })

  it('GetItem and BatchGetItem refuse a duplicate in the key bare, in the current wording', async () => {
    const get = await eachSet((d) => ddb.send(new GetItemCommand({ TableName: T, Key: { pk: d } })))
    const batchGet = await eachSet((d) => ddb.send(new BatchGetItemCommand({ RequestItems: { [T]: { Keys: [{ pk: d }] } } })))
    expect({ get, batchGet }).toEqual({ get: DUPE_CURRENT, batchGet: DUPE_CURRENT })
  })

  it('Query refuses a duplicate in a key value, a filter value, ExclusiveStartKey and QueryFilter bare, with no wrapper', { tags: ['legacy'] }, async () => {
    const keyValue = await eachSet((d) =>
      ddb.send(new QueryCommand({ TableName: T, KeyConditionExpression: 'pk = :t', ExpressionAttributeValues: { ':t': d } })),
    )
    const filter = await eachSet((d) =>
      ddb.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'pk = :p',
          FilterExpression: 's = :t',
          ExpressionAttributeValues: { ':p': S('layer-d'), ':t': d },
        }),
      ),
    )
    const startKey = await eachSet((d) =>
      ddb.send(
        new QueryCommand({ TableName: T, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': S('layer-d') }, ExclusiveStartKey: { pk: d } }),
      ),
    )
    const queryFilter = await eachSet((d) =>
      ddb.send(
        new QueryCommand({
          TableName: T,
          KeyConditions: { pk: { ComparisonOperator: 'EQ', AttributeValueList: [S('layer-d')] } },
          QueryFilter: { s: { ComparisonOperator: 'EQ', AttributeValueList: [d] } },
        }),
      ),
    )
    expect({ keyValue, filter, startKey, queryFilter }).toEqual({
      keyValue: DUPE_CURRENT,
      filter: DUPE_CURRENT,
      startKey: DUPE_CURRENT,
      queryFilter: DUPE_CURRENT,
    })
  })

  it('BatchWriteItem refuses a duplicate in an item and a delete key bare, in one layer for both', async () => {
    const put = await eachSet((d) => ddb.send(new BatchWriteItemCommand({ RequestItems: { [T]: [{ PutRequest: { Item: { pk: S('layer-d'), s: d } } }] } })))
    const del = await eachSet((d) => ddb.send(new BatchWriteItemCommand({ RequestItems: { [T]: [{ DeleteRequest: { Key: { pk: d } } }] } })))
    // Either layer, as a whole, and the same one for both requests: see the
    // note at the top of the file.
    expect([
      { put: DUPE_OLDER, del: DUPE_OLDER },
      { put: DUPE_CURRENT, del: DUPE_CURRENT },
    ]).toContainEqual({ put, del })
  })
})

describe('Duplicate set members — transactions by region', { tags: ['transactions', 'data-plane', 'negative-path'] }, () => {
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  // The transaction operations check every action's sets before running any
  // of them, so a duplicate is a top-level ValidationException, never a
  // cancellation. eu-west-2 answers in the current layer. On their latest
  // answers, by 2026-11-14, so did every other region but me-central-1, which
  // answered every shape in the older one.

  it('TransactWriteItems refuses a duplicate in a Put item and a Delete key up front', async (ctx) => {
    // Split behaviour (registry row transact-write-items-put-delete-duplicate-layer).
    const put = await eachSet((d) => ddb.send(new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: T, Item: { pk: S('layer-d'), s: d } } }] })))
    const del = await eachSet((d) => ddb.send(new TransactWriteItemsCommand({ TransactItems: [{ Delete: { TableName: T, Key: { pk: d } } }] })))
    recordOlderLayer(ctx.task, [...put, ...del], [...DUPE_OLDER, ...DUPE_OLDER])
    expect({ put, del }).toEqual({ put: DUPE_CURRENT, del: DUPE_CURRENT })
  })

  it('TransactWriteItems refuses a duplicate in a condition or update value of every action type up front', async (ctx) => {
    // Split behaviour (registry row transact-write-items-expression-duplicate-layer).
    const cond = { ConditionExpression: 'attribute_not_exists(pk) OR s = :t' }
    const shapes: ((d: AttributeValue) => any)[] = [
      (d) => ({ Put: { TableName: T, Item: { pk: S('layer-d') }, ...cond, ExpressionAttributeValues: { ':t': d } } }),
      (d) => ({ Update: { TableName: T, Key: { pk: S('layer-d') }, UpdateExpression: 'SET s = :t', ExpressionAttributeValues: { ':t': d } } }),
      (d) => ({ Delete: { TableName: T, Key: { pk: S('layer-d') }, ...cond, ExpressionAttributeValues: { ':t': d } } }),
      (d) => ({ ConditionCheck: { TableName: T, Key: { pk: S('layer-d') }, ...cond, ExpressionAttributeValues: { ':t': d } } }),
    ]
    const got: string[][] = []
    for (const shape of shapes) {
      got.push(await eachSet((d) => ddb.send(new TransactWriteItemsCommand({ TransactItems: [shape(d)] }))))
    }
    const older = DUPE_OLDER.map((m) => forKey(m, ':t'))
    recordOlderLayer(ctx.task, got.flat(), shapes.flatMap(() => older))
    expect(got).toEqual(shapes.map(() => DUPE_CURRENT))
  })

  it('TransactGetItems refuses a duplicate in a key up front', async (ctx) => {
    // Split behaviour (registry row transact-get-items-key-duplicate-layer).
    const got = await eachSet((d) => ddb.send(new TransactGetItemsCommand({ TransactItems: [{ Get: { TableName: T, Key: { pk: d } } }] })))
    recordOlderLayer(ctx.task, got, DUPE_OLDER)
    expect(got).toEqual(DUPE_CURRENT)
  })
})
