// Kept on one line on purpose: the tag-coverage guard skips an import's opening
// line only, so a marker symbol on a continuation line reads as the whole file
// sending that command. See scripts/lib/tag-content.mjs.
import { ExecuteStatementCommand } from '@aws-sdk/client-dynamodb'
import {
  BatchWriteItemCommand,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault, skipUnlessSupported } from '../../../src/infra.js'
import {
  itemSizeTableDef,
  itemSizeCompositeTableDef,
  longKeyNameTableDef,
  cleanupItems,
  declareTables,
  expectDynamoError,
} from '../../../src/helpers.js'
import {
  MAX_ITEM_BYTES,
  asciiOfBytes,
  attributeValueBytes,
  itemBytes,
  itemOfBytes,
  utf8Bytes,
} from '../../../src/item-size.js'

declareTables(itemSizeTableDef, itemSizeCompositeTableDef, longKeyNameTableDef)

// Seven write surfaces reach the 400KB gate. Captured against eu-west-2 on
// 2026-08-18 by bisecting each surface's ceiling and reading the accepted item
// back, so every figure below is a stored size rather than a predicted one.
// UpdateItem was re-measured on 2026-11-21.
//
// All seven cap the finished item at exactly 409,600, key included. Standalone
// UpdateItem also sizes what its SET clauses write, which can refuse a
// statement whose finished item is small; see the note above its describes.
//
// The reporting split follows whether the size can be known from the request
// alone. A put's can, so a transacted Put over the limit is a plain
// ValidationException raised before the transaction opens. An update's depends
// on the stored item, so a transacted Update can only fail once the transaction
// is running and surfaces as a cancellation. That is an outcome rather than
// wording, and an engine validating everything up front diverges on it.
//
// The wording split is coarser: the put path says the item has exceeded the
// size, the update path says the item *to update* has. Asserted on the
// distinguishing clause rather than the whole string, which
// tests/tier3/error-messages/ owns.
const TABLE = itemSizeTableDef.name
const PUT_WORDING = 'Item size has exceeded the maximum allowed size'
const UPDATE_WORDING = 'Item size to update has exceeded the maximum allowed size'

const PREFIX = 'lim-surface-'
const keysToClean: Record<string, AttributeValue>[] = []
const compositeKeysToClean: Record<string, AttributeValue>[] = []
const longKeyNameKeysToClean: Record<string, AttributeValue>[] = []

afterAll(async () => {
  await cleanupItems(TABLE, keysToClean)
  await cleanupItems(itemSizeCompositeTableDef.name, compositeKeysToClean)
  await cleanupItems(longKeyNameTableDef.name, longKeyNameKeysToClean)
})

function key(id: string) {
  const k = { pk: { S: `${PREFIX}${id}` } }
  keysToClean.push(k)
  return k
}

/**
 * An item on this table measuring exactly `bytes`, key included.
 *
 * itemOfBytes throws unless it landed on the target, which is the guard the
 * capture learned the hard way: a fixture built to a length it did not reach
 * makes every measurement downstream wrong in a way that reads as a finding
 * about DynamoDB rather than about the fixture.
 */
const sizedItem = (k: Record<string, AttributeValue>, bytes: number) =>
  itemOfBytes(bytes, k, 'p')

/** The stored size, read back rather than predicted. */
async function storedBytes(k: Record<string, AttributeValue>): Promise<number> {
  const got = await ddb.send(
    new GetItemCommand({ TableName: TABLE, Key: k, ConsistentRead: true }),
  )
  expect(got.Item).toBeDefined()
  return itemBytes(got.Item as Record<string, AttributeValue>)
}

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — BatchWriteItem', { tags: ['batch', 'data-plane'] }, () => {
  async function write(k: Record<string, AttributeValue>, bytes: number) {
    await ddb.send(new BatchWriteItemCommand({
      RequestItems: { [TABLE]: [{ PutRequest: { Item: sizedItem(k, bytes) } }] },
    }))
  }

  it('accepts an item of exactly 409,600 bytes', async () => {
    const k = key('bwi-at')
    await write(k, MAX_ITEM_BYTES)
    expect(await storedBytes(k)).toBe(MAX_ITEM_BYTES)
  })

  it('refuses it one byte over, with the put wording', async () => {
    await expectDynamoError(
      () => write(key('bwi-over'), MAX_ITEM_BYTES + 1),
      'ValidationException',
      PUT_WORDING,
    )
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — PartiQL', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${TABLE}" WHERE pk = 'size-canary'`,
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  async function insert(k: Record<string, AttributeValue>, bytes: number) {
    const item = sizedItem(k, bytes)
    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${TABLE}" VALUE {'pk': ?, 'p': ?}`,
      Parameters: [k.pk, item.p],
    }))
  }

  /** Seed a small row, then grow it to `bytes` with an UPDATE. */
  async function updateTo(k: Record<string, AttributeValue>, bytes: number) {
    await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...k } }))
    const item = sizedItem(k, bytes)
    await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${TABLE}" SET p = ? WHERE pk = ?`,
      Parameters: [item.p, k.pk],
    }))
  }

  it('INSERT accepts an item of exactly 409,600 bytes', async () => {
    const k = key('pql-ins-at')
    await insert(k, MAX_ITEM_BYTES)
    expect(await storedBytes(k)).toBe(MAX_ITEM_BYTES)
  })

  it('INSERT refuses it one byte over, with the put wording', async () => {
    await expectDynamoError(
      () => insert(key('pql-ins-over'), MAX_ITEM_BYTES + 1),
      'ValidationException',
      PUT_WORDING,
    )
  })

  it('UPDATE accepts a finished item of exactly 409,600 bytes', async () => {
    const k = key('pql-upd-at')
    await updateTo(k, MAX_ITEM_BYTES)
    expect(await storedBytes(k)).toBe(MAX_ITEM_BYTES)
  })

  it('UPDATE refuses it one byte over, with the update wording', async () => {
    await expectDynamoError(
      () => updateTo(key('pql-upd-over'), MAX_ITEM_BYTES + 1),
      'ValidationException',
      UPDATE_WORDING,
    )
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — TransactWriteItems', { tags: ['transactions', 'data-plane'] }, () => {
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  async function transactPut(k: Record<string, AttributeValue>, bytes: number) {
    await ddb.send(new TransactWriteItemsCommand({
      TransactItems: [{ Put: { TableName: TABLE, Item: sizedItem(k, bytes) } }],
    }))
  }

  async function transactUpdate(k: Record<string, AttributeValue>, bytes: number) {
    const item = sizedItem(k, bytes)
    await ddb.send(new TransactWriteItemsCommand({
      TransactItems: [{
        Update: {
          TableName: TABLE,
          Key: { ...k },
          UpdateExpression: 'SET p = :p',
          ExpressionAttributeValues: { ':p': item.p },
        },
      }],
    }))
  }

  /** Assert a cancellation carrying `reason`, rather than an up-front rejection. */
  async function expectCancelledFor(fn: () => Promise<unknown>, reason: string) {
    try {
      await fn()
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(TransactionCanceledException)
      const cancelled = e as TransactionCanceledException
      expect(cancelled.name).toBe('TransactionCanceledException')
      expect(cancelled.CancellationReasons?.[0]?.Code).toBe('ValidationError')
      expect(cancelled.CancellationReasons?.[0]?.Message).toContain(reason)
    }
  }

  it('a Put accepts an item of exactly 409,600 bytes', async () => {
    const k = key('txn-put-at')
    await transactPut(k, MAX_ITEM_BYTES)
    expect(await storedBytes(k)).toBe(MAX_ITEM_BYTES)
  })

  // A put's size is knowable from the request, so it never reaches the
  // transaction. An engine deferring every check to execution reports a
  // cancellation here and diverges.
  it('a Put one byte over raises ValidationException, not a cancellation', async () => {
    await expectDynamoError(
      () => transactPut(key('txn-put-over'), MAX_ITEM_BYTES + 1),
      'ValidationException',
      PUT_WORDING,
    )
  })

  it('an Update accepts a finished item of exactly 409,600 bytes', async () => {
    const k = key('txn-upd-at')
    await transactUpdate(k, MAX_ITEM_BYTES)
    expect(await storedBytes(k)).toBe(MAX_ITEM_BYTES)
  })

  // The mirror of the Put case. An update's size depends on the stored item, so
  // it can only fail once the transaction is running.
  it('an Update one byte over surfaces as a cancellation, with the update wording', async () => {
    await expectCancelledFor(
      () => transactUpdate(key('txn-upd-over'), MAX_ITEM_BYTES + 1),
      UPDATE_WORDING,
    )
  })

  // The split is about which action it is, not about whether a merge was
  // needed: a fresh key answers the same way as a row that already exists.
  it('answers the same way for a fresh key and for an existing row', async () => {
    const existing = key('txn-upd-existing')
    await ddb.send(new PutItemCommand({
      TableName: TABLE, Item: { ...existing, p: { S: 'small' } },
    }))
    await expectCancelledFor(
      () => transactUpdate(existing, MAX_ITEM_BYTES + 1),
      UPDATE_WORDING,
    )
  })
})

// ── UpdateItem ────────────────────────────────────────────────────────────────
//
// UpdateItem answers to two limits, and refuses whichever it breaks with the
// update wording:
//
//   finished item                                        <= 409600
//   sum over SET clauses of (target name + value given)  <= 409600
//
// The first is the cap every surface above applies: the item as stored, key and
// untouched attributes included.
//
// The second sizes what the statement's SET clauses would write if each value
// landed. It counts each target's attribute name, with any alias resolved, plus
// the value operand it is given, once for every use. It does not count the key,
// an operand path, a placeholder's name, or a value used only in the condition.
// So a statement can be refused while the item it would leave stays tiny, which
// is what `SET c = if_not_exists(c, :v)` on an item already holding `c` shows.
// It is checked before the ConditionExpression (see the last describe).
//
// Measured against eu-west-2 on 2026-11-21 by bisection, with every accepted
// item read back. Until the week before, UpdateItem sized the statement
// differently: the key was left out of the figure and every clause carried a
// fixed charge, so at a short key the ceiling sat below 409,600. The
// 2026-11-21 ground-truth sweep found every region that answered storing the
// writes that rule refused.

/** A list's own bytes over its elements', as the 2026-10-09 capture measured. */
const listBytes = (...elements: number[]) => 3 + elements.length + elements.reduce((a, b) => a + b, 0)

const updateItem = (
  table: string,
  k: Record<string, AttributeValue>,
  expression: string,
  values: Record<string, AttributeValue>,
  names?: Record<string, string>,
) => ddb.send(new UpdateItemCommand({
  TableName: table,
  Key: { ...k },
  UpdateExpression: expression,
  ExpressionAttributeValues: values,
  ExpressionAttributeNames: names,
}))

/**
 * Confirm `SET b = :pad` stores a finished item of exactly 409,600 at the first
 * key and refuses one byte more at the second, then read the stored item back
 * so the figure rests on a stored size rather than on the arithmetic.
 */
async function finishedItemCapHolds(
  table: string,
  keys: { accepted: Record<string, AttributeValue>; refused: Record<string, AttributeValue> },
  untouched: Record<string, AttributeValue> = {},
): Promise<void> {
  const send = async (k: Record<string, AttributeValue>, bytes: number) => {
    if (Object.keys(untouched).length > 0) {
      await ddb.send(new PutItemCommand({ TableName: table, Item: { ...k, ...untouched } }))
    }
    const padding = bytes - itemBytes(k) - itemBytes(untouched) - utf8Bytes('b')
    await updateItem(table, k, 'SET b = :pad', { ':pad': { S: asciiOfBytes(padding) } })
  }

  await send(keys.accepted, MAX_ITEM_BYTES)
  const stored = await ddb.send(new GetItemCommand({ TableName: table, Key: { ...keys.accepted }, ConsistentRead: true }))
  expect(itemBytes(stored.Item as Record<string, AttributeValue>)).toBe(MAX_ITEM_BYTES)

  await expectDynamoError(() => send(keys.refused, MAX_ITEM_BYTES + 1), 'ValidationException', UPDATE_WORDING)
}

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — UpdateItem sizes the finished item', { tags: ['update-item', 'data-plane'] }, () => {
  const pair = (id: string) => ({ accepted: key(`upd-${id}-at`), refused: key(`upd-${id}-over`) })

  it('caps at exactly 409,600 at a one-byte key', async () => {
    const keys = { accepted: { pk: { S: 'K' } }, refused: { pk: { S: 'L' } } }
    keysToClean.push(keys.accepted, keys.refused)
    await finishedItemCapHolds(TABLE, keys)
  })

  it.each([100, 1_024])('caps at exactly 409,600 with a %i-byte key value', async (length) => {
    const keys = pair(`long-${length}`)
    for (const k of [keys.accepted, keys.refused]) k.pk.S = k.pk.S.padEnd(length, 'k').slice(0, length)
    expect(keys.accepted.pk.S).toHaveLength(length)
    await finishedItemCapHolds(TABLE, keys)
  })

  it('counts a long key name as it counts a key value', async () => {
    const keys = { accepted: { partitionKeyName: { S: 'v' } }, refused: { partitionKeyName: { S: 'w' } } }
    longKeyNameKeysToClean.push(keys.accepted, keys.refused)
    await finishedItemCapHolds(longKeyNameTableDef.name, keys)
  })

  it('counts a sort key', async () => {
    const keys = { accepted: { pk: { S: 'S' }, sk: { S: 'a' } }, refused: { pk: { S: 'T' }, sk: { S: 'a' } } }
    compositeKeysToClean.push(keys.accepted, keys.refused)
    await finishedItemCapHolds(itemSizeCompositeTableDef.name, keys)
  })

  it('counts an attribute the statement leaves alone', async () => {
    const keys = { accepted: { pk: { S: 'U' } }, refused: { pk: { S: 'V' } } }
    keysToClean.push(keys.accepted, keys.refused)
    await finishedItemCapHolds(TABLE, keys, { u: { S: 'y'.repeat(999) } })
  })

  it('caps a SET through a list index at the same finished item', async () => {
    const accepted = { pk: { S: 'D' } }
    const refused = { pk: { S: 'E' } }
    keysToClean.push(accepted, refused)
    // The list holds one element before and after, so its own bytes are fixed
    // and only the element's padding moves.
    const padding = (k: Record<string, AttributeValue>) => MAX_ITEM_BYTES - itemBytes(k) - utf8Bytes('d') - listBytes(0)
    const send = async (k: Record<string, AttributeValue>, bytes: number) => {
      await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...k, d: { L: [{ S: 'x' }] } } }))
      await updateItem(TABLE, k, 'SET d[0] = :pad', { ':pad': { S: asciiOfBytes(bytes) } })
    }

    await send(accepted, padding(accepted))
    const stored = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { ...accepted }, ConsistentRead: true }))
    expect(stored.Item?.d?.L?.[0]?.S).toHaveLength(padding(accepted))

    await expectDynamoError(() => send(refused, padding(refused) + 1), 'ValidationException', UPDATE_WORDING)
  })

  it('caps a SET through a nested path at the same finished item', async () => {
    const accepted = { pk: { S: 'F' } }
    const refused = { pk: { S: 'G' } }
    keysToClean.push(accepted, refused)
    // A map's bytes are not captured, so the threshold is taken from the plain
    // SET of the same document and the path form must agree with it exactly.
    // While bisecting, any size refusal counts: near the top of the window the
    // whole map is refused as a value in its own right, with the value wording.
    // Anything else is retried, so a throttled write is not read as a refusal.
    const wholeMap = (bytes: number) => ({ M: { leaf: { S: asciiOfBytes(bytes) } } })
    const sizeRefused = async (run: () => Promise<unknown>): Promise<boolean> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await run()
          return false
        } catch (e: unknown) {
          const err = e as { name?: string; message?: string }
          if (err.name === 'ValidationException' && /Item size/.test(err.message ?? '')) return true
          if (attempt === 4) throw e
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
        }
      }
    }
    let low = MAX_ITEM_BYTES - 256
    let high = MAX_ITEM_BYTES
    expect(await sizeRefused(() => updateItem(TABLE, accepted, 'SET d = :m', { ':m': wholeMap(low) })), 'the low end').toBe(false)
    expect(await sizeRefused(() => updateItem(TABLE, accepted, 'SET d = :m', { ':m': wholeMap(high) })), 'the high end').toBe(true)
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2)
      if (await sizeRefused(() => updateItem(TABLE, accepted, 'SET d = :m', { ':m': wholeMap(mid) }))) high = mid
      else low = mid
    }

    for (const k of [accepted, refused]) await updateItem(TABLE, k, 'SET d = :m', { ':m': wholeMap(1) })
    const throughPath = (k: Record<string, AttributeValue>, bytes: number) =>
      updateItem(TABLE, k, 'SET d.#leaf = :pad', { ':pad': { S: asciiOfBytes(bytes) } }, { '#leaf': 'leaf' })
    await throughPath(accepted, low)
    await expectDynamoError(() => throughPath(refused, low + 1), 'ValidationException', UPDATE_WORDING)
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — UpdateItem sizes what its SET clauses write', { tags: ['update-item', 'data-plane'] }, () => {
  // Every case leaves the stored item tiny: each target already holds a value,
  // and `if_not_exists` keeps it. So the finished item never binds and the
  // limit found is the statement's alone. `limit` is the largest padding
  // accepted; one byte more is refused.
  interface Shape {
    expression: string
    seed: Record<string, AttributeValue>
    values: (padding: number) => Record<string, AttributeValue>
    names?: Record<string, string>
    limit: number
    at?: (id: string) => Record<string, AttributeValue>
  }

  let n = 0
  async function statementLimitIs(shape: Shape): Promise<void> {
    n += 1
    const at = shape.at ?? ((id: string) => ({ pk: { S: id } }))
    const accepted = at(`W${n}`)
    const refused = at(`X${n}`)
    keysToClean.push(accepted, refused)
    const send = async (k: Record<string, AttributeValue>, padding: number) => {
      await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...k, ...shape.seed } }))
      await updateItem(TABLE, k, shape.expression, shape.values(padding), shape.names)
    }

    await send(accepted, shape.limit)
    const stored = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { ...accepted }, ConsistentRead: true }))
    expect(stored.Item).toEqual({ ...accepted, ...shape.seed })

    await expectDynamoError(() => send(refused, shape.limit + 1), 'ValidationException', UPDATE_WORDING)
  }

  const x = { S: 'x' }
  const pad = (padding: number) => ({ S: asciiOfBytes(padding) })

  it('counts the target name with the value it is given', async () => {
    await statementLimitIs({
      expression: 'SET c = if_not_exists(c, :v)',
      seed: { c: x },
      values: (p) => ({ ':v': pad(p) }),
      limit: MAX_ITEM_BYTES - utf8Bytes('c'),
    })
    await statementLimitIs({
      expression: 'SET cccccccccc = if_not_exists(cccccccccc, :v)',
      seed: { cccccccccc: x },
      values: (p) => ({ ':v': pad(p) }),
      limit: MAX_ITEM_BYTES - utf8Bytes('cccccccccc'),
    })
  })

  it('counts the attribute an alias names, not the alias', async () => {
    await statementLimitIs({
      expression: 'SET #nnnnnnnnnn = if_not_exists(#nnnnnnnnnn, :v)',
      names: { '#nnnnnnnnnn': 'c' },
      seed: { c: x },
      values: (p) => ({ ':v': pad(p) }),
      limit: MAX_ITEM_BYTES - utf8Bytes('c'),
    })
  })

  it('does not count the key, an operand path or a placeholder name', async () => {
    await statementLimitIs({
      expression: 'SET c = if_not_exists(zzzzzzzzzz, :vvvvvvvvvv)',
      seed: { c: x, zzzzzzzzzz: x },
      values: (p) => ({ ':vvvvvvvvvv': pad(p) }),
      at: (id) => ({ pk: { S: id.padEnd(100, 'k') } }),
      limit: MAX_ITEM_BYTES - utf8Bytes('c'),
    })
  })

  it('counts a value at every use', async () => {
    await statementLimitIs({
      expression: 'SET c = if_not_exists(c, :v), d = if_not_exists(d, :v)',
      seed: { c: x, d: x },
      values: (p) => ({ ':v': pad(p) }),
      limit: MAX_ITEM_BYTES / 2 - utf8Bytes('c'),
    })
  })

  it('adds the clauses together', async () => {
    await statementLimitIs({
      expression: 'SET c = if_not_exists(c, :v), d = if_not_exists(d, :one)',
      seed: { c: x, d: x },
      values: (p) => ({ ':v': pad(p), ':one': { N: '1' } }),
      limit: MAX_ITEM_BYTES - utf8Bytes('c') - utf8Bytes('d') - attributeValueBytes({ N: '1' }),
    })
  })

  it('does not count a value used only in the condition', async () => {
    const k = key('cond-value')
    await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...k, c: x } }))
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { ...k },
      UpdateExpression: 'SET b = :s',
      ConditionExpression: 'c <> :v',
      ExpressionAttributeValues: { ':s': x, ':v': pad(MAX_ITEM_BYTES + 100) },
    }))
    expect(await storedBytes(k)).toBe(itemBytes({ ...k, c: x, b: x }))
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — AttributeUpdates sizes the finished item', { tags: ['update-item', 'legacy', 'data-plane'] }, () => {
  // The legacy parameter is sized by the finished item alone, key and untouched
  // attributes included, exactly 409,600.
  // Captured in eu-west-2 on 2026-10-09 with and without an untouched attribute.
  for (const [label, untouched] of [['alone', {}], ['beside an untouched attribute', { u: { S: 'y'.repeat(10) } }]] as const) {
    it(`caps the finished item at exactly 409,600 ${label}`, async () => {
      const accepted = key(`au-${label.length}-at`)
      const refused = key(`au-${label.length}-over`)
      const padding = (k: Record<string, AttributeValue>) =>
        MAX_ITEM_BYTES - itemBytes(k) - utf8Bytes('b') - itemBytes(untouched)
      const send = async (k: Record<string, AttributeValue>, bytes: number) => {
        if (Object.keys(untouched).length > 0) {
          await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...k, ...untouched } }))
        }
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: { ...k },
          AttributeUpdates: { b: { Action: 'PUT', Value: { S: asciiOfBytes(bytes) } } },
        }))
      }
      await send(accepted, padding(accepted))
      const stored = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { ...accepted }, ConsistentRead: true }))
      expect(itemBytes(stored.Item as Record<string, AttributeValue>)).toBe(MAX_ITEM_BYTES)
      await expectDynamoError(() => send(refused, padding(refused) + 1), 'ValidationException', UPDATE_WORDING)
    })
  }
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — UpdateItem checks the charge before the condition', { tags: ['update-item', 'data-plane'] }, () => {
  // `SET c = if_not_exists(c, :huge)` on an item that already holds `c` leaves
  // the item tiny, but the statement carries 409,700 bytes. The statement's size
  // is refused before the ConditionExpression is evaluated: a failing condition
  // still gets the size refusal, not ConditionalCheckFailedException, and a
  // passing one is refused too. Captured in eu-west-2 on 2026-10-09, and still
  // the answer on 2026-11-21.
  const huge = { S: 'h'.repeat(409_700) }
  const send = async (k: Record<string, AttributeValue>, condition?: string) => {
    await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...k, c: { S: 'x' } } }))
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { ...k },
      UpdateExpression: 'SET c = if_not_exists(c, :huge)',
      ConditionExpression: condition,
      ExpressionAttributeValues: { ':huge': huge },
    }))
  }

  it('refuses an over-limit charge even when the condition would fail', async () => {
    await expectDynamoError(() => send(key('order-fails'), 'attribute_exists(nope)'), 'ValidationException', UPDATE_WORDING)
  })

  it('refuses an over-limit charge when the condition passes, and with no condition', async () => {
    await expectDynamoError(() => send(key('order-passes'), 'attribute_exists(c)'), 'ValidationException', UPDATE_WORDING)
    await expectDynamoError(() => send(key('order-none')), 'ValidationException', UPDATE_WORDING)
  })
})
