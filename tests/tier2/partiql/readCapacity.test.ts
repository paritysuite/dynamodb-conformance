import { CreateTableCommand, ExecuteStatementCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import {
  declareTables,
  compositeTableDef,
  cleanupItems,
  uniqueTableName,
  waitUntilActive,
  deleteTable,
} from '../../../src/helpers.js'

declareTables(compositeTableDef)

// Captured in eu-west-2 and us-east-1, 2026-11-03 to 2026-11-05.
//
// A PartiQL SELECT whose sort-key condition is an OR, or an IN, is charged a
// read for each branch rather than for the bytes it returns. With items of a
// few dozen bytes each branch costs one unit under ConsistentRead and half a
// unit otherwise, whether or not it finds anything, so the figures below are
// exact. Reading the whole partition costs a single unit by contrast.
//
// Each case reads its own partition of three small items. A partition shared
// across cases would grow during the run and move its charge across a 4 KB
// boundary.

/** Run a statement and hand back the sort keys it returned and its total cost. */
async function read(Statement: string, ConsistentRead?: boolean) {
  const res = await ddb.send(new ExecuteStatementCommand({
    Statement,
    ConsistentRead,
    ReturnConsumedCapacity: 'TOTAL',
  }))
  return {
    keys: (res.Items ?? []).map((i) => i.sk.S!).sort(),
    nextToken: res.NextToken,
    cu: res.ConsumedCapacity?.CapacityUnits,
  }
}

describe('PartiQL - read capacity of OR and IN on the sort key', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true
  const T = compositeTableDef.name

  const PARTITIONS = [
    'two-keys', 'three-keys', 'partition', 'missing-and-found', 'repeated-key',
    'empty-range', 'two-ranges', 'key-and-range', 'empty-prefix', 'empty-between',
    'desc-empty-range', 'eventual-two-keys', 'eventual-two-missing', 'eventual-three-missing',
    'in-two-keys', 'in-eventual', 'in-three-keys', 'in-missing', 'wide-x', 'wide-missing',
    'positive-pairs-2', 'positive-pairs-9',
  ] as const
  const P = (name: (typeof PARTITIONS)[number]) => `pq-rcap-${name}`

  // row-1 to row-3, each carrying x set to 1 to 3 and nothing else.
  const items: Record<string, AttributeValue>[] = PARTITIONS.flatMap((name) =>
    [1, 2, 3].map((n) => ({ pk: { S: P(name) }, sk: { S: `row-${n}` }, x: { N: String(n) } })),
  )

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-read-capacity-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    for (const Item of items) await ddb.send(new PutItemCommand({ TableName: T, Item }))
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    if (!supported) return
    await cleanupItems(T, items.map((i) => ({ pk: i.pk, sk: i.sk })))
  })

  describe('ConsistentRead', () => {
    it('two found keys cost 2', async () => {
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('two-keys')}' AND (sk = 'row-1' OR sk = 'row-2')`, true)
      expect(r.keys).toEqual(['row-1', 'row-2'])
      expect(r.cu).toBe(2)
    })

    it('three found keys cost 3', async () => {
      const r = await read(
        `SELECT * FROM "${T}" WHERE pk = '${P('three-keys')}' AND (sk = 'row-1' OR sk = 'row-2' OR sk = 'row-3')`,
        true,
      )
      expect(r.keys).toEqual(['row-1', 'row-2', 'row-3'])
      expect(r.cu).toBe(3)
    })

    it('the whole three-row partition costs 1', async () => {
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('partition')}'`, true)
      expect(r.keys).toEqual(['row-1', 'row-2', 'row-3'])
      expect(r.cu).toBe(1)
    })

    it('a missing key beside a found one costs 2', async () => {
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('missing-and-found')}' AND (sk = 'row-0' OR sk = 'row-2')`, true)
      expect(r.keys).toEqual(['row-2'])
      expect(r.cu).toBe(2)
    })

    it('a missing key repeated within one branch beside a found one costs 2', async () => {
      const r = await read(
        `SELECT * FROM "${T}" WHERE pk = '${P('repeated-key')}' AND ((sk = 'row-0' AND sk = 'row-0') OR sk = 'row-2')`,
        true,
      )
      expect(r.keys).toEqual(['row-2'])
      expect(r.cu).toBe(2)
    })

    // A range branch is charged a unit even when it holds no row.
    it('a union of two ranges, one of them empty, costs 2', async () => {
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('empty-range')}' AND (sk < 'row-0' OR sk > 'row-2')`, true)
      expect(r.keys).toEqual(['row-3'])
      expect(r.cu).toBe(2)
    })

    it('a union of two ranges that each find a row costs 2', async () => {
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('two-ranges')}' AND (sk < 'row-2' OR sk > 'row-2')`, true)
      expect(r.keys).toEqual(['row-1', 'row-3'])
      expect(r.cu).toBe(2)
    })

    it('a key beside a range costs 2', async () => {
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('key-and-range')}' AND (sk = 'row-1' OR sk > 'row-2')`, true)
      expect(r.keys).toEqual(['row-1', 'row-3'])
      expect(r.cu).toBe(2)
    })

    it('an empty begins_with branch beside a found one costs 2', async () => {
      const r = await read(
        `SELECT * FROM "${T}" WHERE pk = '${P('empty-prefix')}' AND (begins_with(sk, 'row-1') OR begins_with(sk, 'zz'))`,
        true,
      )
      expect(r.keys).toEqual(['row-1'])
      expect(r.cu).toBe(2)
    })

    it('an empty BETWEEN branch beside a found one costs 2', async () => {
      const r = await read(
        `SELECT * FROM "${T}" WHERE pk = '${P('empty-between')}' AND (sk BETWEEN 'row-0' AND 'row-1' OR sk BETWEEN 'x' AND 'y')`,
        true,
      )
      expect(r.keys).toEqual(['row-1'])
      expect(r.cu).toBe(2)
    })

    it('an empty range branch read descending costs 2', async () => {
      const r = await read(
        `SELECT * FROM "${T}" WHERE pk = '${P('desc-empty-range')}' AND (sk < 'row-0' OR sk > 'row-2') ORDER BY sk DESC`,
        true,
      )
      expect(r.keys).toEqual(['row-3'])
      expect(r.cu).toBe(2)
    })
  })

  // Half a unit a key. The rows were written before the file's first read, but
  // an eventually consistent read may still miss one, so only the cost is
  // pinned where a row is expected.
  describe('eventually consistent', () => {
    it('two found keys cost 1', async () => {
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('eventual-two-keys')}' AND (sk = 'row-1' OR sk = 'row-2')`)
      expect(r.cu).toBe(1)
    })

    it('two missing keys cost 1', async () => {
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('eventual-two-missing')}' AND (sk = 'row-0' OR sk = 'row-9')`)
      expect(r.keys).toEqual([])
      expect(r.cu).toBe(1)
    })

    it('three missing keys and one found cost 2', async () => {
      const r = await read(
        `SELECT * FROM "${T}" WHERE pk = '${P('eventual-three-missing')}' AND (sk = 'row-0' OR sk = 'row-00' OR sk = 'row-000' OR sk = 'row-2')`,
      )
      expect(r.cu).toBe(2)
    })
  })

  // A sort-key IN is read as the OR it is equivalent to, and charged the same.
  describe('IN costs what its OR costs', () => {
    it('two keys cost 2 under ConsistentRead', async () => {
      const pk = P('in-two-keys')
      const viaIn = await read(`SELECT * FROM "${T}" WHERE pk = '${pk}' AND sk IN ['row-1', 'row-3']`, true)
      expect(viaIn.keys).toEqual(['row-1', 'row-3'])
      expect(viaIn.cu).toBe(2)
      const viaOr = await read(`SELECT * FROM "${T}" WHERE pk = '${pk}' AND (sk = 'row-1' OR sk = 'row-3')`, true)
      expect(viaOr.cu).toBe(2)
    })

    it('two keys cost 1 eventually consistent', async () => {
      const pk = P('in-eventual')
      const viaIn = await read(`SELECT * FROM "${T}" WHERE pk = '${pk}' AND sk IN ['row-1', 'row-3']`)
      expect(viaIn.cu).toBe(1)
      const viaOr = await read(`SELECT * FROM "${T}" WHERE pk = '${pk}' AND (sk = 'row-1' OR sk = 'row-3')`)
      expect(viaOr.cu).toBe(1)
    })

    it('three keys cost 3 under ConsistentRead', async () => {
      const pk = P('in-three-keys')
      const viaIn = await read(`SELECT * FROM "${T}" WHERE pk = '${pk}' AND sk IN ['row-1', 'row-2', 'row-3']`, true)
      expect(viaIn.keys).toEqual(['row-1', 'row-2', 'row-3'])
      expect(viaIn.cu).toBe(3)
      const viaOr = await read(`SELECT * FROM "${T}" WHERE pk = '${pk}' AND (sk = 'row-1' OR sk = 'row-2' OR sk = 'row-3')`, true)
      expect(viaOr.cu).toBe(3)
    })

    it('a missing key and a found one cost 2 under ConsistentRead', async () => {
      const pk = P('in-missing')
      const viaIn = await read(`SELECT * FROM "${T}" WHERE pk = '${pk}' AND sk IN ['row-0', 'row-3']`, true)
      expect(viaIn.keys).toEqual(['row-3'])
      expect(viaIn.cu).toBe(2)
      const viaOr = await read(`SELECT * FROM "${T}" WHERE pk = '${pk}' AND (sk = 'row-0' OR sk = 'row-3')`, true)
      expect(viaOr.cu).toBe(2)
    })
  })

  // Wide filters beside a set of sort keys don't widen the read: only the two
  // keys are charged.
  describe('two sort keys beside a wide filter', () => {
    it('nine non-key OR pairs that no row passes cost 1 eventually consistent', async () => {
      const wide = Array.from({ length: 9 }, (_, n) => ` AND (x = ${n} OR x = ${n + 100})`).join('')
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('wide-x')}' AND (sk = 'row-1' OR sk = 'row-2')${wide}`)
      expect(r.keys).toEqual([])
      expect(r.cu).toBe(1)
    })

    it('eight IS MISSING OR pairs that every row passes cost 2 under ConsistentRead', async () => {
      const wide = Array.from({ length: 8 }, (_, n) => ` AND (f${n} IS MISSING OR f${n} = 2)`).join('')
      const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P('wide-missing')}' AND (sk = 'row-1' OR sk = 'row-2')${wide}`, true)
      expect(r.keys).toEqual(['row-1', 'row-2'])
      expect(r.cu).toBe(2)
    })
  })

  // Each pair names the sort key positively, so the statement is accepted. No
  // row has a sort key of s0 or an x of 0, so nothing passes the first pair.
  it.each([2, 9] as const)('%i positive OR pairs naming the sort key are accepted and return nothing', async (count) => {
    const pairs = Array.from({ length: count }, (_, n) => `(sk = 's${n}' OR x = ${n})`).join(' AND ')
    const r = await read(`SELECT * FROM "${T}" WHERE pk = '${P(`positive-pairs-${count}`)}' AND ${pairs}`)
    expect(r.keys).toEqual([])
  })
})

// Captured in eu-west-2 and us-east-1, 2026-11-04 and 2026-11-05.
//
// A partition key that can't name a partition (a boolean, or a number on a
// string key) beside closed sort-key ranges is accepted and finds nothing. The
// read covers the whole table, so it costs what reading the whole table does,
// however many ranges there are: 2 eventually consistent and 4 under
// ConsistentRead on the small on-demand table created here. A larger table
// costs more, which is why the test has a table of its own.
describe('PartiQL - read capacity of a partition key that cannot be a key', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true
  const T = uniqueTableName('pqUnkeyable')
  let ready: Promise<void> = Promise.resolve()

  const RANGES = [
    `(sk >= 'a' AND sk <= 'b')`,
    `((sk >= 'a' AND sk <= 'b') OR (sk >= 'c' AND sk <= 'd'))`,
    `((sk >= 'a' AND sk <= 'b') OR (sk >= 'c' AND sk <= 'd') OR (sk >= 'e' AND sk <= 'f'))`,
  ]

  beforeAll(async () => {
    try {
      // The canary the other PartiQL files run, against the shared table. A
      // read of this file's own table before it exists can leave PartiQL
      // reporting it missing for a while after it is created.
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${compositeTableDef.name}" WHERE pk = 'partiql-unkeyable-canary'`,
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    // Started here and awaited before each case, so a table that never becomes
    // ACTIVE fails every case as a failed observation instead of skipping them
    // all.
    ready = (async () => {
      await ddb.send(new CreateTableCommand({
        TableName: T,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }))
      await waitUntilActive(T)
      for (const sk of ['row-1', 'row-2', 'row-3']) {
        await ddb.send(new PutItemCommand({ TableName: T, Item: { pk: { S: 'k' }, sk: { S: sk } } }))
      }
    })()
    ready.catch(() => {})
  })

  afterAll(async () => {
    if (!supported) return
    await deleteTable(T)
  })

  beforeEach(async ({ skip }) => {
    if (!supported) skip()
    await ready
  })

  it.each([
    { label: 'pk = true', literal: 'true', count: 1, ranges: 'one closed range' },
    { label: 'pk = true', literal: 'true', count: 2, ranges: 'two closed ranges' },
    { label: 'pk = true', literal: 'true', count: 3, ranges: 'three closed ranges' },
    { label: 'pk = 1 on a string key', literal: '1', count: 1, ranges: 'one closed range' },
    { label: 'pk = 1 on a string key', literal: '1', count: 2, ranges: 'two closed ranges' },
    { label: 'pk = 1 on a string key', literal: '1', count: 3, ranges: 'three closed ranges' },
  ])('$label beside $ranges finds nothing for 2, or 4 consistently', async ({ literal, count }) => {
    const Statement = `SELECT * FROM "${T}" WHERE pk = ${literal} AND ${RANGES[count - 1]}`

    const eventual = await read(Statement)
    expect(eventual.keys).toEqual([])
    expect(eventual.nextToken).toBeUndefined()
    expect(eventual.cu).toBe(2)

    const consistent = await read(Statement, true)
    expect(consistent.keys).toEqual([])
    expect(consistent.nextToken).toBeUndefined()
    expect(consistent.cu).toBe(4)
  })
})
