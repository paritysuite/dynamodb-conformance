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
import { recordObserved } from '../../../src/observation-sink.js'
import { isUnsupportedFault, skipUnlessSupported } from '../../../src/infra.js'
import {
  itemSizeTableDef,
  itemSizeCompositeTableDef,
  longKeyNameTableDef,
  cleanupItems,
  declareTables,
  assertDynamoError,
  expectDynamoError,
} from '../../../src/helpers.js'
import {
  MAX_ITEM_BYTES,
  asciiOfBytes,
  itemBytes,
  itemOfBytes,
  utf8Bytes,
} from '../../../src/item-size.js'

declareTables(itemSizeTableDef, itemSizeCompositeTableDef, longKeyNameTableDef)

// Seven write surfaces reach the 400KB gate and they do not agree about it.
// Captured against eu-west-2 on 2026-08-18 by bisecting each surface's ceiling
// and reading the accepted item back, so every figure below is a stored size
// rather than a predicted one.
//
// Six of the seven are flat: the ceiling is the item's own size, exactly
// 409,600, with no key exclusion and no per-action term. Standalone UpdateItem
// is the outlier in eu-west-2 and has its own describes below. It is not the
// outlier everywhere: in ten regions UpdateItem is flat too (see the note above
// updateCeilingIs).
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

  // The discriminator against standalone UpdateItem, which refuses a finished
  // item of 409,600 at this key: the key exclusion belongs to that operation
  // alone rather than to updates generally.
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

  // An Update inside a transaction is measured flat against the item too, so it
  // accepts what standalone UpdateItem refuses at the same key: the exclusion is
  // not inherited.
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

// ── UpdateItem, the one surface that does not measure flat ────────────────────
//
// Two things differ from every surface above:
//
//   max(finished item, attributes the update writes + action cost) <= 409600
//
// The second half is the surprise. UpdateItem does not measure the item it is
// about to store; it measures what the statement writes, name and value, and
// adds a fixed cost per clause. So the key is out of the figure — an update
// never writes it — and so is every attribute the statement leaves alone. At a
// short key that puts the ceiling *below* 400KB, and it stays there however
// little the update touches. The first half is what stops the exclusion running
// away: DynamoDB never stores a finished item above 409,600 at any key length.
//
// The 2026-08-18 capture recorded this as `item - key attributes + action cost`,
// which is the same arithmetic on the fixtures it used, because every one of
// them held an item made of exactly the key plus what the update wrote. It comes
// apart as soon as the item carries an attribute the update does not touch, and
// the case below pins that: an untouched attribute measuring 11 bytes lifts the
// ceiling by 11, where the key-exclusion reading says it should not move at all.
// Measured against eu-west-2 on 2026-08-19.
//
// The action cost is three bytes for the update itself plus a fixed amount per
// clause. It does not vary with the value written, its type or size, the
// attribute name, the alias, or the expression text.
//
// These figures have no documented basis and look like an internal serialised
// mutation record rather than a contract. They are asserted anyway, because a
// correct implementation can derive every one of them from the request it was
// given: an engine can see which clauses it has and what each one writes, and
// getting it wrong means accepting a write AWS refuses, at the same key, with
// the same statement.
const UPDATE_BASE_COST = 3
const SET_COST = 19
const REMOVE_COST = 2

// The statement-sized rule is regional. Ten regions (ap-south-2, ap-southeast-6,
// ap-southeast-7, ca-central-1, eu-central-2, eu-south-1, eu-south-2, eu-west-1,
// me-central-1 and us-east-2) size an UpdateItem like every other write: the
// finished item, capped at exactly 409,600, with no key exclusion and no
// per-clause cost. So every case below that puts the ceiling under 409,600 fails
// there on its first refusal, which those regions accept and store. The other 22
// apply the rule; ap-northeast-1 has answered both ways and is in no row.
// Measured across all 33 regions on 2026-09-28 and 2026-09-29.
//
// Each such test is a split, and what it records for per-region scoring is only
// the flat side: that the target stored an update this rule refuses, confirmed
// by reading it back. A test that measures two ceilings hands its task to the
// first measurement only. A flat region stores that first write and the test
// stops there, so a target that refuses it and then stores the second has not
// answered the way a flat region does. The refusing side needs no record, because a pass already
// means the pinned eu-west-2 answer. Recording refusals would be wrong here,
// since these tests go on past the refusal, and a target refusing at the right
// point but failing a later step would be credited as matching the regions that
// refuse.
const STATEMENT_RULE_STORED = 'stored an update the statement-sized rule refuses'

async function recordStoredDespiteRule(
  task: Parameters<typeof recordObserved>[0] | undefined,
  table: string,
  k: Record<string, AttributeValue>,
  landed: (item: Record<string, AttributeValue>) => boolean,
): Promise<void> {
  if (!task) return
  const got = await ddb.send(new GetItemCommand({ TableName: table, Key: { ...k }, ConsistentRead: true }))
  if (got.Item && landed(got.Item)) {
    recordObserved(task, { outcome: 'accepted', detail: STATEMENT_RULE_STORED })
  }
}

/**
 * The largest finished item UpdateItem accepts.
 *
 * `uncountedBytes` is everything in the finished item the statement does not
 * write: the key attributes, always, plus any attribute it leaves alone.
 */
function updateCeiling(uncountedBytes: number, actionCost: number): number {
  return Math.min(MAX_ITEM_BYTES, MAX_ITEM_BYTES + uncountedBytes - actionCost)
}

interface UpdateShape {
  /** The expression, which must set the padding attribute from `:pad`. */
  expression: string
  names?: Record<string, string>
  values?: Record<string, AttributeValue>
  /** Attributes further clauses write, besides the padding. */
  extra?: Record<string, AttributeValue>
  /** Attributes the item carries and the statement leaves alone. */
  untouched?: Record<string, AttributeValue>
  /** Where the padding lands. */
  padAttribute: string
  /** 3 for the update, plus 19 per SET or ADD and 2 per REMOVE or DELETE. */
  actionCost: number
  /** What the item must already carry for the expression to have something to do. */
  seed?: Record<string, AttributeValue>
}

/**
 * Confirm UpdateItem's ceiling at this key and this shape, and return it.
 *
 * Accepted at the predicted figure and refused one byte over is the assertion;
 * the accepted item is then read back so the figure rests on a stored size
 * rather than on the arithmetic that produced it.
 */
async function updateCeilingIs(
  table: string,
  keys: { accepted: Record<string, AttributeValue>; refused: Record<string, AttributeValue> },
  shape: UpdateShape,
  task?: Parameters<typeof recordObserved>[0],
): Promise<number> {
  const uncounted = itemBytes(keys.accepted) + itemBytes(shape.untouched ?? {})
  const ceiling = updateCeiling(uncounted, shape.actionCost)

  const send = async (k: Record<string, AttributeValue>, bytes: number) => {
    const padding =
      bytes -
      itemBytes(k) -
      itemBytes(shape.extra ?? {}) -
      itemBytes(shape.untouched ?? {}) -
      utf8Bytes(shape.padAttribute)
    const seed = { ...shape.seed, ...shape.untouched }
    if (Object.keys(seed).length > 0) {
      await ddb.send(new PutItemCommand({ TableName: table, Item: { ...k, ...seed } }))
    }
    await ddb.send(new UpdateItemCommand({
      TableName: table,
      Key: { ...k },
      UpdateExpression: shape.expression,
      ExpressionAttributeNames: shape.names,
      ExpressionAttributeValues: { ...shape.values, ':pad': { S: asciiOfBytes(padding) } },
    }))
  }

  await send(keys.accepted, ceiling)
  const stored = await ddb.send(new GetItemCommand({
    TableName: table, Key: { ...keys.accepted }, ConsistentRead: true,
  }))
  expect(itemBytes(stored.Item as Record<string, AttributeValue>)).toBe(ceiling)

  await expectDynamoError(
    async () => {
      await send(keys.refused, ceiling + 1)
      await recordStoredDespiteRule(task, table, keys.refused, (item) => itemBytes(item) === ceiling + 1)
    },
    'ValidationException',
    UPDATE_WORDING,
  )
  return ceiling
}

/** The plainest shape: one SET, landing the padding in `b`. */
function oneSet(overrides: Partial<UpdateShape> = {}): UpdateShape {
  return {
    expression: 'SET b = :pad',
    padAttribute: 'b',
    actionCost: UPDATE_BASE_COST + SET_COST,
    ...overrides,
  }
}

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — UpdateItem does not charge for the key', { tags: ['update-item', 'data-plane'] }, () => {
  const pair = (id: string) => ({ accepted: key(`upd-${id}-at`), refused: key(`upd-${id}-over`) })

  // Short enough that the key attributes come to less than a single SET costs,
  // so the exclusion is what binds and the ceiling sits under 400KB.
  const shortKey = () => ({ accepted: { pk: { S: 'K' } }, refused: { pk: { S: 'L' } } })

  it('sits below 409,600 at a one-byte key, so the exclusion binds', async (ctx) => {
    // Split behaviour (registry row update-item-size-short-key): flat in ten
    // regions, see the note above updateCeilingIs.
    const keys = shortKey()
    keysToClean.push(keys.accepted, keys.refused)
    const ceiling = await updateCeilingIs(TABLE, keys, oneSet(), ctx.task)
    expect(ceiling).toBeLessThan(MAX_ITEM_BYTES)
    // 2 bytes of key name plus 1 of key value, against a 22-byte single SET.
    expect(ceiling).toBe(MAX_ITEM_BYTES - 19)
  })

  // Past a 20-byte key the item's own size is the binding half, and it stays
  // binding however long the key gets. Nothing ever stores a finished item above
  // 409,600.
  it.each([100, 1_024])('caps at exactly 409,600 with a %i-byte key value', async (length) => {
    const keys = pair(`long-${length}`)
    for (const k of [keys.accepted, keys.refused]) k.pk.S = k.pk.S.padEnd(length, 'k').slice(0, length)
    expect(keys.accepted.pk.S).toHaveLength(length)
    expect(await updateCeilingIs(TABLE, keys, oneSet())).toBe(MAX_ITEM_BYTES)
  })

  // The name is excluded as well as the value, so the two are interchangeable.
  // Sixteen bytes of key name and one of value buys back what two bytes of name
  // and fifteen of value does.
  it('buys back the same headroom from the key name as from the key value', async (ctx) => {
    // Split behaviour (registry row update-item-size-key-name): flat in ten
    // regions, see the note above updateCeilingIs.
    const byValue = { accepted: { pk: { S: 'v'.repeat(15) } }, refused: { pk: { S: 'w'.repeat(15) } } }
    keysToClean.push(byValue.accepted, byValue.refused)
    const byName = {
      accepted: { partitionKeyName: { S: 'v' } },
      refused: { partitionKeyName: { S: 'w' } },
    }
    longKeyNameKeysToClean.push(byName.accepted, byName.refused)
    expect(itemBytes(byValue.accepted)).toBe(itemBytes(byName.accepted))

    const fromValue = await updateCeilingIs(TABLE, byValue, oneSet(), ctx.task)
    const fromName = await updateCeilingIs(longKeyNameTableDef.name, byName, oneSet())
    expect(fromName).toBe(fromValue)
    // Both still under the cap, or the comparison would be two tables agreeing
    // on 409,600 for reasons that have nothing to do with the key.
    expect(fromValue).toBeLessThan(MAX_ITEM_BYTES)
  })

  it('buys back a sort key’s own bytes as well', async (ctx) => {
    // Split behaviour (registry row update-item-size-sort-key): flat in ten
    // regions, see the note above updateCeilingIs.
    const hashOnly = { accepted: { pk: { S: 'S' } }, refused: { pk: { S: 'T' } } }
    keysToClean.push(hashOnly.accepted, hashOnly.refused)
    const withSort = {
      accepted: { pk: { S: 'S' }, sk: { S: 'a' } },
      refused: { pk: { S: 'T' }, sk: { S: 'a' } },
    }
    compositeKeysToClean.push(withSort.accepted, withSort.refused)

    const flat = await updateCeilingIs(TABLE, hashOnly, oneSet(), ctx.task)
    const composite = await updateCeilingIs(itemSizeCompositeTableDef.name, withSort, oneSet())
    expect(composite - flat).toBe(itemBytes({ sk: withSort.accepted.sk }))
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — UpdateItem charges per action', { tags: ['update-item', 'data-plane'] }, () => {
  // Every case here runs at a key short enough for the exclusion to bind. Past a
  // 20-byte key the item's own size caps the figure and the action cost stops
  // being observable at all.
  const shortPair = (id: string) => {
    const keys = { accepted: { pk: { S: `A${id}` } }, refused: { pk: { S: `B${id}` } } }
    keysToClean.push(keys.accepted, keys.refused)
    return keys
  }

  it('charges a second SET clause exactly 19 bytes', async (ctx) => {
    // Split behaviour (registry row update-item-size-second-set): flat in ten
    // regions, see the note above updateCeilingIs.
    const one = await updateCeilingIs(TABLE, shortPair('1'), oneSet(), ctx.task)
    const two = await updateCeilingIs(TABLE, shortPair('2'), oneSet({
      expression: 'SET b = :pad, c = :c',
      values: { ':c': { S: 'y' } },
      extra: { c: { S: 'y' } },
      actionCost: UPDATE_BASE_COST + SET_COST * 2,
    }))
    expect(one - two).toBe(SET_COST)
  })

  it('charges a REMOVE alongside a SET exactly 2 bytes', async (ctx) => {
    // Split behaviour (registry row update-item-size-remove): flat in ten
    // regions, see the note above updateCeilingIs.
    const setOnly = await updateCeilingIs(TABLE, shortPair('3'), oneSet(), ctx.task)
    const withRemove = await updateCeilingIs(TABLE, shortPair('4'), oneSet({
      expression: 'SET b = :pad REMOVE r',
      seed: { r: { S: 'z' } },
      actionCost: UPDATE_BASE_COST + SET_COST + REMOVE_COST,
    }))
    expect(setOnly - withRemove).toBe(REMOVE_COST)
  })

  // The clause is charged, not what it carries. A second clause writing 500
  // bytes costs what one writing a single byte costs, and the threshold does not
  // move when the attribute is reached through an alias instead of by name.
  it('charges the clause, not the value it writes', async (ctx) => {
    // Split behaviour (registry row update-item-size-clause-not-value): flat in ten
    // regions, see the note above updateCeilingIs.
    const small = await updateCeilingIs(TABLE, shortPair('5'), oneSet({
      expression: 'SET b = :pad, c = :c',
      values: { ':c': { S: 'y' } },
      extra: { c: { S: 'y' } },
      actionCost: UPDATE_BASE_COST + SET_COST * 2,
    }), ctx.task)
    const large = await updateCeilingIs(TABLE, shortPair('6'), oneSet({
      expression: 'SET b = :pad, c = :c',
      values: { ':c': { S: 'y'.repeat(500) } },
      extra: { c: { S: 'y'.repeat(500) } },
      actionCost: UPDATE_BASE_COST + SET_COST * 2,
    }))
    expect(large).toBe(small)
    // Both sides collapse onto 409,600 the moment the key outgrows the action
    // cost, and the equality then holds whatever the per-clause cost is. The
    // keys here are short enough that it does not, and this says so.
    expect(small).toBeLessThan(MAX_ITEM_BYTES)
  })

  // The half the capture's own reading missed. An attribute the statement never
  // names is in the stored item and out of the figure, so it buys back its own
  // bytes exactly as a key attribute does — which is what shows the exclusion is
  // about what the update writes rather than about keys.
  it('does not charge for an attribute the statement leaves alone', async (ctx) => {
    // Split behaviour (registry row update-item-size-untouched-attribute): flat in ten
    // regions, see the note above updateCeilingIs.
    const untouched = { u: { S: 'y'.repeat(10) } }
    const written = await updateCeilingIs(TABLE, shortPair('9'), oneSet(), ctx.task)
    const alongside = await updateCeilingIs(TABLE, shortPair('a'), oneSet({ untouched }))
    expect(alongside - written).toBe(itemBytes(untouched))
    expect(alongside).toBeLessThan(MAX_ITEM_BYTES)
  })

  it('charges the clause, not the attribute name or its alias', async (ctx) => {
    // Split behaviour (registry row update-item-size-alias): flat in ten
    // regions, see the note above updateCeilingIs.
    const byName = await updateCeilingIs(TABLE, shortPair('7'), oneSet(), ctx.task)
    const byAlias = await updateCeilingIs(TABLE, shortPair('8'), oneSet({
      expression: 'SET #twelvechars = :pad',
      names: { '#twelvechars': 'b' },
    }))
    expect(byAlias).toBe(byName)
    expect(byName).toBeLessThan(MAX_ITEM_BYTES)
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — UpdateItem through a document path', { tags: ['update-item', 'data-plane'] }, () => {
  // Reaching into a map or a list means the padding has to live inside the
  // document, and no capture settles what a map or a list costs. So each case is
  // measured against a reference clause that writes the same attribute to the
  // same finished value the plain way — `SET d = :whole` against `SET d.leaf =`
  // or `SET d[0] =`. The document's own bytes are then identical on both sides
  // and cancel, and what is left is the difference between the two clause forms.
  //
  // The reference threshold is found by bisection rather than predicted, so
  // nothing here asserts a document-sizing figure. Only a size rejection counts
  // as a refusal: a throttled 400KB write read as one would return a number that
  // looks like a measurement and is not one.
  const k = { pk: { S: 'D' } }
  const over = { pk: { S: 'E' } }

  async function accepts(run: () => Promise<unknown>): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await run()
        return true
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string }
        if (err.name === 'ValidationException' && /Item size/.test(err.message ?? '')) return false
        if (attempt === 4) throw e
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      }
    }
  }

  /** The largest padding `run` accepts, bisected inside a window both ends of which are checked. */
  async function largestAccepted(run: (padding: number) => Promise<unknown>): Promise<number> {
    let accepted = MAX_ITEM_BYTES - 256
    let refused = MAX_ITEM_BYTES
    expect(await accepts(() => run(accepted)), 'the low end of the search window').toBe(true)
    expect(await accepts(() => run(refused)), 'the high end of the search window').toBe(false)
    while (refused - accepted > 1) {
      const midpoint = Math.floor((accepted + refused) / 2)
      if (await accepts(() => run(midpoint))) accepted = midpoint
      else refused = midpoint
    }
    return accepted
  }

  const update = (
    at: Record<string, AttributeValue>,
    expression: string,
    values: Record<string, AttributeValue>,
    names?: Record<string, string>,
  ) => ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { ...at },
    UpdateExpression: expression,
    ExpressionAttributeValues: values,
    ExpressionAttributeNames: names,
  }))

  const wholeMap = (padding: number) => ({ M: { leaf: { S: asciiOfBytes(padding) } } })
  const wholeList = (padding: number) => ({ L: [{ S: asciiOfBytes(padding) }] })

  beforeAll(() => { keysToClean.push(k, over) })

  it('charges a SET through a nested path the same as a plain SET', async () => {
    const plainly = (at: Record<string, AttributeValue>) => (padding: number) =>
      update(at, 'SET d = :whole', { ':whole': wholeMap(padding) })
    const throughPath = (at: Record<string, AttributeValue>) => (padding: number) =>
      update(at, 'SET d.#leaf = :pad', { ':pad': { S: asciiOfBytes(padding) } }, { '#leaf': 'leaf' })

    const reference = await largestAccepted(plainly(k))
    // The path form needs the map to exist before it can reach into it.
    await update(k, 'SET d = :whole', { ':whole': wholeMap(1) })
    await update(over, 'SET d = :whole', { ':whole': wholeMap(1) })

    expect(await accepts(() => throughPath(k)(reference))).toBe(true)
    expect(await accepts(() => throughPath(over)(reference + 1))).toBe(false)
  })

  // The capture measured a list-index SET at 20 bytes against 19 for a plain
  // one. Asserted as the difference against the plain clause's own measured
  // threshold rather than against either constant, so what fails is the one byte
  // rather than a figure nothing else checks.
  it('charges a SET through a list index exactly one byte more', async (ctx) => {
    // Split behaviour (registry row update-item-size-list-index): flat in ten
    // regions, see the note above updateCeilingIs.
    const plainly = (at: Record<string, AttributeValue>) => (padding: number) =>
      update(at, 'SET d = :whole', { ':whole': wholeList(padding) })
    const throughIndex = (at: Record<string, AttributeValue>) => (padding: number) =>
      update(at, 'SET d[0] = :pad', { ':pad': { S: asciiOfBytes(padding) } })

    const reference = await largestAccepted(plainly(k))
    await update(k, 'SET d = :whole', { ':whole': wholeList(1) })
    await update(over, 'SET d = :whole', { ':whole': wholeList(1) })

    expect(await accepts(async () => {
      await throughIndex(over)(reference)
      await recordStoredDespiteRule(ctx.task, TABLE, over, (item) => item.d?.L?.[0]?.S?.length === reference)
    })).toBe(false)
    expect(await accepts(() => throughIndex(k)(reference - 1))).toBe(true)
  })
})

/**
 * A key short enough that UpdateItem's ceiling falls below 409,600, seeded with
 * a small row, together with the finished item of exactly 409,600 that
 * UpdateItem will not write there.
 *
 * The refusal is asserted here rather than in each caller, because it is what
 * makes the acceptance on the other surfaces mean anything: the same item, at
 * the same key, written by an operation that measures it differently.
 */
async function keyUpdateItemRefusesAt(id: string, task?: Parameters<typeof recordObserved>[0]) {
  const at = { pk: { S: id } }
  keysToClean.push(at)
  await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...at } }))
  const item = itemOfBytes(MAX_ITEM_BYTES, at, 'p')
  await expectDynamoError(
    async () => {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { ...at },
        UpdateExpression: 'SET p = :p',
        ExpressionAttributeValues: { ':p': item.p },
      }))
      await recordStoredDespiteRule(task, TABLE, at, (stored) => itemBytes(stored) === MAX_ITEM_BYTES)
    },
    'ValidationException',
    UPDATE_WORDING,
  )
  return { at, item }
}

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — a PartiQL UPDATE does not inherit the exclusion', { tags: ['partiql', 'update-item', 'data-plane'] }, () => {
  let supported = true

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${TABLE}" WHERE pk = 'excl-canary'`,
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  it('writes what UpdateItem refuses at the same key', async (ctx) => {
    // Split behaviour (registry row partiql-update-size-exclusion): flat in ten
    // regions, see the note above updateCeilingIs.
    const { at, item } = await keyUpdateItemRefusesAt('X', ctx.task)
    await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${TABLE}" SET p = ? WHERE pk = ?`,
      Parameters: [item.p, at.pk],
    }))
    expect(await storedBytes(at)).toBe(MAX_ITEM_BYTES)
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Item size limit by surface — a transacted Update does not inherit the exclusion', { tags: ['transactions', 'update-item', 'data-plane'] }, () => {
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  it('writes what UpdateItem refuses at the same key', async (ctx) => {
    // Split behaviour on the UpdateItem half (registry row
    // transact-update-size-exclusion), see the note above updateCeilingIs.
    //
    // The transacted half is mid-rollout. Most regions measure a transacted
    // Update flat, like every other write, and store the item. eu-north-1 and
    // ap-northeast-2 started applying UpdateItem's statement-sized rule to it
    // before the transaction runs, and eu-west-2 followed on 2026-10-08, between
    // two ground-truth runs on main 30 minutes apart. Those three refuse it with
    // a top-level ValidationException carrying the update wording. The test
    // accepts either until the regions settle. Its name describes what most
    // regions still do, and changes when one answer is pinned, alongside the
    // results refresh a rename needs.
    const { at, item } = await keyUpdateItemRefusesAt('Y', ctx.task)
    let refused: unknown
    try {
      await ddb.send(new TransactWriteItemsCommand({
        TransactItems: [{
          Update: {
            TableName: TABLE,
            Key: { ...at },
            UpdateExpression: 'SET p = :p',
            ExpressionAttributeValues: { ':p': item.p },
          },
        }],
      }))
    } catch (err) {
      refused = err
    }
    if (refused === undefined) {
      expect(await storedBytes(at)).toBe(MAX_ITEM_BYTES)
    } else {
      assertDynamoError(refused, 'ValidationException', UPDATE_WORDING)
    }
  })
})
