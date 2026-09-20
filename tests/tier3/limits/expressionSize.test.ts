import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import { declareTables, hashTableDef, expectDynamoError, cleanupItems } from '../../../src/helpers.js'

declareTables(hashTableDef)

// Real DynamoDB caps every expression parameter at 4096 bytes, measured on the
// raw expression string as sent: aliases are not substituted before counting,
// whitespace is not normalised, and ExpressionAttributeValues are not counted.
// Verified against real AWS in eu-west-2, us-east-1, eu-central-1 and
// ap-southeast-2 (2026-07-12): 4096 bytes accepted and 4097 rejected on all
// five surfaces below, in every region. Only the phrase pinned here is
// invariant; the wording around it varies by operation and region (a
// `1 validation error detected:` envelope, an `; expression size: <n>` tail),
// so the assertion floats everything else.
const LIMIT = 4096
const OVER = LIMIT + 1
const SIZE_MSG = 'Expression size has exceeded the maximum allowed size'

const PREFIX = 'lim-es-'
const keysToClean: { pk: { S: string } }[] = []

afterAll(async () => {
  await cleanupItems(hashTableDef.name, keysToClean)
})

function key(id: string) {
  const k = { pk: { S: `${PREFIX}${id}` } }
  keysToClean.push(k)
  return k
}

// A ~50-byte attribute name, unique per clause: letters plus an index, so it
// is a valid literal path component and never a reserved word.
function padName(i: number, len = 50): string {
  const suffix = `x${i}`
  return 'a'.repeat(len - suffix.length) + suffix
}

// Join clauses to exactly `target` bytes, stretching the final clause's
// attribute name to land on the byte. Everything is ASCII, so string length is
// byte length; the check guards the construction, not DynamoDB.
function buildToBytes(
  target: number,
  prefix: string,
  joiner: string,
  clause: (i: number, nameLen: number) => string,
): { expr: string; clauses: number } {
  const parts: string[] = []
  let total = prefix.length
  for (let i = 0; ; i++) {
    const c = clause(i, 50)
    const add = (parts.length ? joiner.length : 0) + c.length
    if (total + add > target) break
    parts.push(c)
    total += add
  }
  const short = target - total
  if (short > 0) parts[parts.length - 1] = clause(parts.length - 1, 50 + short)
  const expr = prefix + parts.join(joiner)
  if (Buffer.byteLength(expr) !== target) {
    throw new Error(`built ${Buffer.byteLength(expr)} bytes, wanted ${target}`)
  }
  return { expr, clauses: parts.length }
}

// Every oversized construction below must be rejected for its byte count, not
// for tripping the 300-operator ceiling first - which is why each one's
// operator-plus-function count is kept far below 300 (0 for SET actions and
// projection paths, ~105 for the condition chain, ~133 for the filter chain at
// these lengths), and why every rejection asserts the size phrase rather than
// just ValidationException.

function updateExpression(target: number) {
  const { expr, clauses } = buildToBytes(
    target,
    'SET ',
    ', ',
    (i, n) => `${padName(i, n)} = :v${i}`,
  )
  const values: Record<string, { S: string }> = {}
  for (let i = 0; i < clauses; i++) values[`:v${i}`] = { S: 'x' }
  return { expr, values }
}

function conditionExpression(target: number): string {
  return buildToBytes(target, '', ' AND ', (i, n) => `attribute_not_exists(${padName(i, n)})`)
    .expr
}

function filterExpression(target: number) {
  const { expr, clauses } = buildToBytes(target, '', ' OR ', (i, n) => `${padName(i, n)} = :v${i}`)
  const values: Record<string, { S: string }> = {}
  for (let i = 0; i < clauses; i++) values[`:v${i}`] = { S: 'x' }
  return { expr, values }
}

function projectionExpression(target: number): string {
  return buildToBytes(target, '', ', ', (i, n) => padName(i, n)).expr
}

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Expression size limit (4KB) — UpdateExpression', { tags: ['update-item', 'get-item', 'data-plane'] }, () => {
  it('accepts an UpdateExpression at the 4096-byte limit', async () => {
    const k = key('upd-at')
    const { expr, values } = updateExpression(LIMIT)
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: k,
        UpdateExpression: expr,
        ExpressionAttributeValues: values,
      }),
    )
    // The expression was applied, not merely tolerated.
    const get = await ddb.send(
      new GetItemCommand({ TableName: hashTableDef.name, Key: k, ConsistentRead: true }),
    )
    expect(get.Item![padName(0)].S).toBe('x')
  })

  it('rejects an UpdateExpression over the 4096-byte limit', async () => {
    const { expr, values } = updateExpression(OVER)
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateItemCommand({
            TableName: hashTableDef.name,
            Key: key('upd-over'),
            UpdateExpression: expr,
            ExpressionAttributeValues: values,
          }),
        ),
      'ValidationException',
      SIZE_MSG,
    )
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Expression size limit (4KB) — ConditionExpression', { tags: ['put-item', 'data-plane'] }, () => {
  it('accepts a ConditionExpression at the 4096-byte limit', async () => {
    // Every attribute_not_exists() in the chain is true against a fresh key,
    // so the put succeeds only if the full 4096-byte condition was evaluated.
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: key('cond-at'),
        ConditionExpression: conditionExpression(LIMIT),
      }),
    )
  })

  it('rejects a ConditionExpression over the 4096-byte limit', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: key('cond-over'),
            ConditionExpression: conditionExpression(OVER),
          }),
        ),
      'ValidationException',
      SIZE_MSG,
    )
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Expression size limit (4KB) — Query FilterExpression', { tags: ['query', 'put-item', 'data-plane'] }, () => {
  it('accepts a Query FilterExpression at the 4096-byte limit and evaluates it', async () => {
    // Seed an item satisfying the chain's first disjunct and assert it is
    // matched: a bare "Count is defined" would also pass on a target that
    // ignored the FilterExpression entirely.
    const k = key('qfilter-at')
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { ...k, [padName(0)]: { S: 'x' } },
      }),
    )
    const { expr, values } = filterExpression(LIMIT)
    const res = await ddb.send(
      new QueryCommand({
        TableName: hashTableDef.name,
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: expr,
        ExpressionAttributeValues: { ...values, ':pk': k.pk },
        ConsistentRead: true,
      }),
    )
    expect(res.Count).toBe(1)
  })

  it('rejects a Query FilterExpression over the 4096-byte limit', async () => {
    const { expr, values } = filterExpression(OVER)
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: hashTableDef.name,
            KeyConditionExpression: 'pk = :pk',
            FilterExpression: expr,
            ExpressionAttributeValues: { ...values, ':pk': { S: `${PREFIX}qfilter-over` } },
          }),
        ),
      'ValidationException',
      SIZE_MSG,
    )
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Expression size limit (4KB) — Scan FilterExpression', { tags: ['scan', 'data-plane'] }, () => {
  it('accepts a Scan FilterExpression at the 4096-byte limit', async () => {
    // Acceptance only: the shared table holds other tests' items (some near
    // 400KB), so a Scan page can end before any seeded item and a match-count
    // assertion would flake. The Query case carries the evaluation proof.
    const { expr, values } = filterExpression(LIMIT)
    const res = await ddb.send(
      new ScanCommand({
        TableName: hashTableDef.name,
        FilterExpression: expr,
        ExpressionAttributeValues: values,
      }),
    )
    expect(res.$metadata.httpStatusCode).toBe(200)
  })

  it('rejects a Scan FilterExpression over the 4096-byte limit', async () => {
    const { expr, values } = filterExpression(OVER)
    await expectDynamoError(
      () =>
        ddb.send(
          new ScanCommand({
            TableName: hashTableDef.name,
            FilterExpression: expr,
            ExpressionAttributeValues: values,
          }),
        ),
      'ValidationException',
      SIZE_MSG,
    )
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Expression size limit (4KB) — ProjectionExpression', { tags: ['get-item', 'put-item', 'data-plane'] }, () => {
  it('accepts a ProjectionExpression at the 4096-byte limit and applies it', async () => {
    // The projection's first path is seeded on the item, so the attribute
    // coming back proves the 4096-byte path list was parsed and applied.
    const k = key('proj-at')
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { ...k, [padName(0)]: { S: 'present' } },
      }),
    )
    const res = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: k,
        ProjectionExpression: projectionExpression(LIMIT),
        ConsistentRead: true,
      }),
    )
    expect(res.Item![padName(0)].S).toBe('present')
  })

  it('rejects a ProjectionExpression over the 4096-byte limit', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new GetItemCommand({
            TableName: hashTableDef.name,
            Key: key('proj-over'),
            ProjectionExpression: projectionExpression(OVER),
          }),
        ),
      'ValidationException',
      SIZE_MSG,
    )
  })

  it('measures the raw expression, not the alias-substituted form', async () => {
    // 30 aliases, ~168 bytes raw, whose ExpressionAttributeNames expand to
    // ~7.5KB. Real DynamoDB accepts this: the limit applies to the expression
    // string as sent, before substitution. Every other case in this file uses
    // literal inline names, so a target that substitutes aliases before
    // counting bytes passes all of them - this is the case that catches it.
    const k = key('proj-alias')
    await ddb.send(
      new PutItemCommand({ TableName: hashTableDef.name, Item: { ...k, real: { S: 'y' } } }),
    )
    const aliases = Array.from({ length: 30 }, (_, i) => `#a${i}`)
    const names: Record<string, string> = {}
    aliases.forEach((alias, i) => {
      names[alias] = 'n'.repeat(246) + `q${i}`
    })
    const projection = aliases.join(', ')
    expect(Buffer.byteLength(projection)).toBeLessThan(LIMIT)
    const res = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: k,
        ProjectionExpression: projection,
        ExpressionAttributeNames: names,
        ConsistentRead: true,
      }),
    )
    // Accepted; none of the padded names exist on the item, and real DynamoDB
    // returns an empty Item (not an omitted one) for a zero-match projection
    // on an existing item.
    expect(res.$metadata.httpStatusCode).toBe(200)
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Expression size limit (4KB) — TransactWriteItems', { tags: ['transactions', 'data-plane'] }, () => {
  // An empty TransactItems is rejected by any target that implements the
  // operation, so this separates "not implemented" from "implemented".
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  // The same 4096-byte cap applies inside a transaction, and an oversized
  // member is a top-level ValidationException rather than a cancellation:
  // the size is checked before any member runs. Captured against eu-west-2
  // and us-east-1 real DynamoDB, 2026-09-12.

  it('accepts a Put ConditionExpression at the 4096-byte limit', async () => {
    const k = key('twi-cond-at')
    await ddb.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: hashTableDef.name,
              Item: { ...k, real: { S: 'y' } },
              ConditionExpression: conditionExpression(LIMIT),
            },
          },
        ],
      }),
    )
    // The put went through, so the condition was evaluated rather than dropped.
    const get = await ddb.send(
      new GetItemCommand({ TableName: hashTableDef.name, Key: k, ConsistentRead: true }),
    )
    expect(get.Item?.real?.S).toBe('y')
  })

  it('rejects a Put ConditionExpression over the 4096-byte limit', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: hashTableDef.name,
                  Item: key('twi-cond-over'),
                  ConditionExpression: conditionExpression(OVER),
                },
              },
            ],
          }),
        ),
      'ValidationException',
      SIZE_MSG,
    )
  })

  it('rejects an Update UpdateExpression over the 4096-byte limit', async () => {
    const { expr, values } = updateExpression(OVER)
    await expectDynamoError(
      () =>
        ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Update: {
                  TableName: hashTableDef.name,
                  Key: key('twi-upd-over'),
                  UpdateExpression: expr,
                  ExpressionAttributeValues: values,
                },
              },
            ],
          }),
        ),
      'ValidationException',
      SIZE_MSG,
    )
  })

  it('rejects the whole request when only the second member is oversized', async () => {
    // A top-level ValidationException, not a TransactionCanceledException:
    // the first member is fine and still nothing is written.
    const first = key('twi-second-first')
    await expectDynamoError(
      () =>
        ddb.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              { Put: { TableName: hashTableDef.name, Item: first } },
              {
                Put: {
                  TableName: hashTableDef.name,
                  Item: key('twi-second-over'),
                  ConditionExpression: conditionExpression(OVER),
                },
              },
            ],
          }),
        ),
      'ValidationException',
      SIZE_MSG,
    )
    const get = await ddb.send(
      new GetItemCommand({ TableName: hashTableDef.name, Key: first, ConsistentRead: true }),
    )
    expect(get.Item).toBeUndefined()
  })
})
