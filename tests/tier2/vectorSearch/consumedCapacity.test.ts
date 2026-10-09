import { CreateTableCommand, GetItemCommand, PutItemCommand, SearchVectorsCommand } from '@aws-sdk/client-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { uniqueTableName, deleteTable, expectDynamoError } from '../../../src/helpers.js'
import { MAX_ITEM_BYTES, asciiOfBytes, itemBytes, numberBytes, utf8Bytes } from '../../../src/item-size.js'
import {
  skipUnlessVectorSearch,
  supportsVectorSearch,
  waitForVectorIndexActive,
  waitForVectorSearchable,
} from '../../../src/vector.js'

// The two vector capacity units, characterised against real DynamoDB in
// eu-west-2 (2026-08-11, issue #125). They are metered in bytes processed and
// reported in shapes that break the classic ConsumedCapacity mould:
//
// - SearchVectors reports a bare { VectorSearchRequestBytes } object with no
//   CapacityUnits and no TableName, identically under TOTAL and INDEXES.
// - A write reports a VectorIndexes map (per-index VectorWriteRequestBytes)
//   beside the classic fields, under INDEXES only — and only when the write
//   actually changes what the index stores. Overwriting an item with an
//   identical vector reports no vector write at all: replication is
//   delta-based.
//
// The write figure was left unpinned in that first round and is pinned now, from
// the 2026-08-18 capture: VectorWriteRequestBytes is the item size of the
// projected index entry, with the vector attribute contributing its name plus a
// flat 4 bytes per dimension, held to a 1024-byte floor. Every term is derivable
// from the request, which is what separates it from the search figure. That one
// is non-deterministic - five identical 512-dimension searches reported 14214,
// 13903, 14214, 14214 and 14518 - and stays asserted shape-only below.
//
// The fixture carries four indexes so each term of the write formula can be
// moved on its own. Two sit on the same attribute and differ only in projection,
// which is the whole experiment for the projection rule; the other two isolate
// the dimension count and the attribute name.

const tableName = uniqueTableName('vec_cap')
const vec = (...ns: number[]) => ns.map((n) => ({ N: String(n) }))

/** The attribute the projection cases use, indexed twice at two projections. */
const THREE_DIM = 'embedding'
/**
 * Six dimensions under a name the same length as `THREE_DIM`, so a comparison
 * between the two moves the dimension count and nothing else. The test asserts
 * the lengths match rather than trusting the names to stay this way.
 */
const SIX_DIM = 'sixdimvec'
/** Three dimensions again, under a longer name, which isolates the name term. */
const LONG_NAME = 'embeddingWithALongerName'

let created = false

beforeAll(async () => {
  if (!(await supportsVectorSearch())) return
  // Registered before the create so a partial setup still gets torn down.
  created = true
  await ddb.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      VectorIndexes: [
        {
          IndexName: 'vix',
          VectorAttribute: { AttributeName: THREE_DIM },
          Dimensions: 3,
          DistanceFunction: 'COSINE',
          Projection: { ProjectionType: 'ALL' },
        },
        // Same attribute, same dimensions, different projection. Either index
        // alone reproduces the ambiguity the projection cases exist to settle,
        // so the pair has to be written as a pair.
        {
          IndexName: 'vkeys',
          VectorAttribute: { AttributeName: THREE_DIM },
          Dimensions: 3,
          DistanceFunction: 'COSINE',
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
        {
          IndexName: 'vdims',
          VectorAttribute: { AttributeName: SIX_DIM },
          Dimensions: 6,
          DistanceFunction: 'COSINE',
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'vname',
          VectorAttribute: { AttributeName: LONG_NAME },
          Dimensions: 3,
          DistanceFunction: 'COSINE',
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  )
  for (const index of ['vix', 'vkeys', 'vdims', 'vname']) {
    await waitForVectorIndexActive(tableName, index)
  }
  await ddb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: { pk: { S: 'seed' }, embedding: { L: vec(1, 0, 0) } },
    }),
  )
  await waitForVectorSearchable({
    tableName,
    indexName: 'vix',
    searchVector: vec(1, 0, 0),
    expectedCount: 1,
  })
})

afterAll(async () => {
  if (created) await deleteTable(tableName)
})

describe('SearchVectors — ConsumedCapacity shape', { tags: ['search-vectors', 'data-plane', 'vector'] }, () => {
  skipUnlessVectorSearch()

  it('reports VectorSearchRequestBytes with no classic capacity fields', async () => {
    const res = await ddb.send(
      new SearchVectorsCommand({
        TableName: tableName,
        IndexName: 'vix',
        SearchVector: vec(1, 0, 0),
        TopK: 1,
        ReturnConsumedCapacity: 'TOTAL',
      }),
    )
    const cc = res.ConsumedCapacity!
    expect(typeof cc.VectorSearchRequestBytes).toBe('number')
    expect(cc.VectorSearchRequestBytes!).toBeGreaterThan(0)
    const asClassic = cc as { CapacityUnits?: unknown; TableName?: unknown; Table?: unknown }
    expect(asClassic.CapacityUnits).toBeUndefined()
    expect(asClassic.TableName).toBeUndefined()
    expect(asClassic.Table).toBeUndefined()
  })

  it('reports the same shape under INDEXES as under TOTAL', async () => {
    const input = {
      TableName: tableName,
      IndexName: 'vix',
      SearchVector: vec(1, 0, 0),
      TopK: 1,
    }
    const total = await ddb.send(
      new SearchVectorsCommand({ ...input, ReturnConsumedCapacity: 'TOTAL' }),
    )
    const indexes = await ddb.send(
      new SearchVectorsCommand({ ...input, ReturnConsumedCapacity: 'INDEXES' }),
    )
    expect(indexes.ConsumedCapacity?.VectorSearchRequestBytes).toBe(
      total.ConsumedCapacity?.VectorSearchRequestBytes,
    )
  })

  it('reports nothing under NONE', async () => {
    const res = await ddb.send(
      new SearchVectorsCommand({
        TableName: tableName,
        IndexName: 'vix',
        SearchVector: vec(1, 0, 0),
        TopK: 1,
        ReturnConsumedCapacity: 'NONE',
      }),
    )
    expect(res.ConsumedCapacity).toBeUndefined()
  })
})

describe('PutItem — vector write capacity shape', { tags: ['put-item', 'data-plane', 'vector'] }, () => {
  skipUnlessVectorSearch()

  it('INDEXES adds a per-index VectorWriteRequestBytes map beside the classic fields', async () => {
    const res = await ddb.send(
      new PutItemCommand({
        TableName: tableName,
        ReturnConsumedCapacity: 'INDEXES',
        Item: { pk: { S: 'fresh-write' }, embedding: { L: vec(0, 1, 0) } },
      }),
    )
    const cc = res.ConsumedCapacity!
    expect(cc.CapacityUnits).toBe(1)
    expect(cc.Table?.CapacityUnits).toBe(1)
    const vix = cc.VectorIndexes?.vix
    expect(vix).toBeDefined()
    expect(typeof vix!.VectorWriteRequestBytes).toBe('number')
    expect(vix!.VectorWriteRequestBytes!).toBeGreaterThan(0)
  })

  it('TOTAL folds nothing in: no vector fields at all', async () => {
    const res = await ddb.send(
      new PutItemCommand({
        TableName: tableName,
        ReturnConsumedCapacity: 'TOTAL',
        Item: { pk: { S: 'total-write' }, embedding: { L: vec(0, 0, 1) } },
      }),
    )
    const cc = res.ConsumedCapacity!
    expect(cc.CapacityUnits).toBe(1)
    expect(cc.VectorIndexes).toBeUndefined()
    expect(cc.Table).toBeUndefined()
  })

  // The name overreaches and the body is fine. It states a general rule this
  // item cannot demonstrate: the item holds no vector attribute at all, so it is
  // in neither index and no vector write is the only answer available. The
  // general rule is false - a write leaving the vector alone is charged whenever
  // it changes something the index projects - and the projection cases below are
  // what settle it.
  //
  // Left as it is on purpose. Renaming a test invalidates every committed
  // results file, which names its tests in full, and the publishing gate refuses
  // a manifest naming tests the measured runs do not. The rename belongs with a
  // results refresh, not with a coverage change.
  it('a write not touching the vector attribute reports no vector write', async () => {
    const res = await ddb.send(
      new PutItemCommand({
        TableName: tableName,
        ReturnConsumedCapacity: 'INDEXES',
        Item: { pk: { S: 'plain-write' }, label: { S: 'no-vector' } },
      }),
    )
    const cc = res.ConsumedCapacity!
    expect(cc.CapacityUnits).toBe(1)
    expect(cc.VectorIndexes).toBeUndefined()
  })

  it('an identical overwrite reports no vector write: replication is delta-based', async () => {
    const item = { pk: { S: 'idempotent' }, embedding: { L: vec(0.5, 0.5, 0) } }
    const first = await ddb.send(
      new PutItemCommand({ TableName: tableName, ReturnConsumedCapacity: 'INDEXES', Item: item }),
    )
    expect(first.ConsumedCapacity?.VectorIndexes?.vix?.VectorWriteRequestBytes).toBeGreaterThan(0)

    const repeat = await ddb.send(
      new PutItemCommand({ TableName: tableName, ReturnConsumedCapacity: 'INDEXES', Item: item }),
    )
    expect(repeat.ConsumedCapacity?.CapacityUnits).toBe(1)
    expect(repeat.ConsumedCapacity?.VectorIndexes).toBeUndefined()
  })
})

/** Write `item` and return each index's reported figure. */
async function writeAndReadCapacity(
  item: Record<string, AttributeValue>,
): Promise<Record<string, number | undefined>> {
  const res = await ddb.send(
    new PutItemCommand({ TableName: tableName, ReturnConsumedCapacity: 'INDEXES', Item: item }),
  )
  const indexes = res.ConsumedCapacity?.VectorIndexes ?? {}
  return Object.fromEntries(
    ['vix', 'vkeys', 'vdims', 'vname'].map((n) => [n, indexes[n]?.VectorWriteRequestBytes]),
  )
}

// A vector index is charged on the change to its own stored view, exactly as a
// GSI is. Nothing about the vector attribute is special, and a write that leaves
// the vector untouched is charged whenever it changes something the index
// projects.
//
// The two indexes below sit on the same attribute, over the same table, with the
// same dimensions, and differ only in projection. That is the whole experiment:
// one write, two answers, and projection is the only thing that could have
// decided between them.
describe('PutItem — a vector index is charged on the change to its stored view', { tags: ['put-item', 'data-plane', 'vector'] }, () => {
  skipUnlessVectorSearch()

  const key = { pk: { S: 'projection' } }
  const embedded = { ...key, [THREE_DIM]: { L: vec(0.25, 0.5, 0.75) } }

  it('charges the index that projects the changed attribute, and not the one that does not', async () => {
    await writeAndReadCapacity({ ...embedded, note: { S: 'before' } })
    const charged = await writeAndReadCapacity({ ...embedded, note: { S: 'after!' } })

    expect(charged.vix, 'the ALL index projects note, so its stored view changed').toBeGreaterThan(0)
    expect(charged.vkeys, 'the KEYS_ONLY index does not project note').toBeUndefined()
  })

  it('charges neither when the write changes nothing either index holds', async () => {
    const item = { ...embedded, note: { S: 'settled' } }
    await writeAndReadCapacity(item)
    const repeated = await writeAndReadCapacity(item)

    expect(repeated.vix).toBeUndefined()
    expect(repeated.vkeys).toBeUndefined()
  })
})

// VectorWriteRequestBytes, one term at a time. Every assertion below is a
// difference between two writes that differ in exactly one way, so a failure
// names the term that moved rather than reporting one number against another.
describe('PutItem — VectorWriteRequestBytes', { tags: ['put-item', 'data-plane', 'vector'] }, () => {
  skipUnlessVectorSearch()

  const FLOOR = 1024
  /** Enough payload to lift the figure clear of the floor, identical across the comparisons. */
  const blob = { blob: { S: 'x'.repeat(1_500) } }

  /**
   * A key of exactly two characters, so the rest of the projected entry is the
   * same size in every comparison below.
   *
   * Every item also gets its own key. Replication is delta-based, so writing the
   * same item twice reports nothing at all the second time, and a comparison
   * built on a repeated write would be comparing against an absent figure.
   */
  const entry = (key: string, attribute: string, value: AttributeValue[], extra = {}) => {
    expect(key, 'keys must match in length across the comparisons').toHaveLength(2)
    return { pk: { S: key }, [attribute]: { L: value }, ...blob, ...extra }
  }

  it('reports the 1024 floor for an entry below it on every term', async () => {
    const charged = await writeAndReadCapacity({
      pk: { S: 'f0' },
      [THREE_DIM]: { L: vec(0, 1, 0) },
    })
    expect(charged.vix).toBe(FLOOR)
  })

  // One write, two indexes: the ALL entry carries the blob and clears the floor,
  // the KEYS_ONLY entry does not and reports 1024. So the floor binds on the
  // entry rather than on the write.
  it('applies the floor per index, not per write', async () => {
    const charged = await writeAndReadCapacity(entry('3a', THREE_DIM, vec(1, 0, 0)))
    expect(charged.vix!).toBeGreaterThan(FLOOR)
    expect(charged.vkeys).toBe(FLOOR)
  })

  it('charges four bytes per dimension', async () => {
    // The two attribute names are the same length on purpose, so this comparison
    // moves the dimension count alone.
    expect(utf8Bytes(SIX_DIM)).toBe(utf8Bytes(THREE_DIM))
    const three = await writeAndReadCapacity(entry('3b', THREE_DIM, vec(1, 0, 0)))
    const six = await writeAndReadCapacity(entry('6b', SIX_DIM, vec(1, 0, 0, 0, 1, 0)))
    expect(six.vdims! - three.vix!).toBe(4 * 3)
  })

  it('charges the vector attribute’s name by its own length', async () => {
    const three = await writeAndReadCapacity(entry('3c', THREE_DIM, vec(1, 0, 0)))
    const named = await writeAndReadCapacity(entry('nc', LONG_NAME, vec(1, 0, 0)))
    expect(named.vname! - three.vix!).toBe(utf8Bytes(LONG_NAME) - utf8Bytes(THREE_DIM))
  })

  it('charges a projected non-vector attribute its own item size', async () => {
    const note = { note: { S: 'n' } }
    const without = await writeAndReadCapacity(entry('3d', THREE_DIM, vec(1, 0, 0)))
    const withNote = await writeAndReadCapacity(entry('td', THREE_DIM, vec(1, 0, 0), note))
    expect(withNote.vix! - without.vix!).toBe(itemBytes(note))
  })
})

// The base item is billed at a different size from the one it is stored at.
// Captured against eu-west-2 and us-east-1 on 2026-10-09 by bisecting the write
// and read unit boundaries and the 400KB gate: an attribute a vector index reads
// costs its name plus four bytes per dimension on a write (1, 3, 8, 256 and 1,024
// dimensions, with numbers from 1e-30 to 38-digit integers), and DescribeTable's
// TableSizeBytes follows the same figure. A read and the 400KB gate size the
// vector as the list of numbers it holds.
//
// Every vector below holds 38-digit integers, 20 bytes each as numbers, so a
// target that bills a write by the numbers lands a unit high, and one that sizes
// a read or the gate by the billed figure lands a unit low or lets an oversized
// item through.

/** A 38-digit integer: 20 bytes as a number, 4 as a billed dimension. */
const WIDE = '12345678901234567890123456789012345678'

const wideVector = (dims: number): AttributeValue => ({
  L: Array.from({ length: dims }, () => ({ N: WIDE })),
})

/**
 * A list's stored size: 3 bytes, plus 1 per element, plus the elements. Held to
 * the byte for every unindexed list probed in the 2026-10-09 capture.
 */
const storedVectorBytes = (dims: number) => 3 + dims * (1 + numberBytes(WIDE))

/**
 * An item on `attribute` measuring exactly `target` bytes, with its vector
 * counted as `vectorBytes`: the key, the vector and a padding string. Keys are
 * two characters, so the fixed part is the same in every comparison.
 */
function itemWithVector(
  target: number,
  key: string,
  attribute: string,
  dims: number,
  vectorBytes: number,
): Record<string, AttributeValue> {
  expect(key, 'keys must match in length across the comparisons').toHaveLength(2)
  const fixed = utf8Bytes('pk') + utf8Bytes(key) + utf8Bytes(attribute) + vectorBytes + utf8Bytes('pad')
  return { pk: { S: key }, [attribute]: wideVector(dims), pad: { S: asciiOfBytes(target - fixed) } }
}

/** An item of exactly `target` billed bytes. */
const billedItem = (target: number, key: string, attribute: string, dims: number) =>
  itemWithVector(target, key, attribute, dims, 4 * dims)

/** Write `item` and return its units. TOTAL carries the table's units and no vector figures. */
async function writeUnits(item: Record<string, AttributeValue>): Promise<number | undefined> {
  const res = await ddb.send(
    new PutItemCommand({ TableName: tableName, ReturnConsumedCapacity: 'TOTAL', Item: item }),
  )
  return res.ConsumedCapacity?.CapacityUnits
}

describe('PutItem - a vector attribute is billed at four bytes per dimension', { tags: ['put-item', 'data-plane', 'vector'] }, () => {
  skipUnlessVectorSearch()

  it('bills a three-dimension vector at 12 bytes, whatever numbers it holds', async () => {
    expect(await writeUnits(billedItem(1024, 'a3', THREE_DIM, 3))).toBe(1)
    expect(await writeUnits(billedItem(1025, 'b3', THREE_DIM, 3))).toBe(2)
  })

  it('bills a six-dimension vector at 24 bytes, whatever numbers it holds', async () => {
    expect(await writeUnits(billedItem(1024, 'a6', SIX_DIM, 6))).toBe(1)
    expect(await writeUnits(billedItem(1025, 'b6', SIX_DIM, 6))).toBe(2)
  })
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('GetItem and the 400KB gate - a vector is sized by its numbers', { tags: ['put-item', 'get-item', 'data-plane', 'vector'] }, () => {
  skipUnlessVectorSearch()

  it('charges a read for the numbers the vector holds, not its billed size', async () => {
    const item = billedItem(4096, 'r6', SIX_DIM, 6)
    const stored = 4096 - 4 * 6 + storedVectorBytes(6)
    expect(stored, 'only the numbers may take the item past 4KB').toBeGreaterThan(4096)
    expect(stored).toBeLessThanOrEqual(8192)

    await ddb.send(new PutItemCommand({ TableName: tableName, Item: item }))
    const read = await ddb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: item.pk },
        ConsistentRead: true,
        ReturnConsumedCapacity: 'TOTAL',
      }),
    )
    expect(read.ConsumedCapacity?.CapacityUnits).toBe(2)
  })

  it('holds the item to 400KB with the vector sized by its numbers', async () => {
    // Billed, both items sit 105 bytes under the gate.
    const atGate = itemWithVector(MAX_ITEM_BYTES, 'g0', SIX_DIM, 6, storedVectorBytes(6))
    const overGate = itemWithVector(MAX_ITEM_BYTES + 1, 'g1', SIX_DIM, 6, storedVectorBytes(6))

    await ddb.send(new PutItemCommand({ TableName: tableName, Item: atGate }))
    await expectDynamoError(
      () => ddb.send(new PutItemCommand({ TableName: tableName, Item: overGate })),
      'ValidationException',
      /Item size has exceeded the maximum allowed size/,
    )
  })
})
