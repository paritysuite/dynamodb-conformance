import { CreateTableCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  uniqueTableName,
  waitUntilActive,
  deleteTable,
  waitForGsiConsistency,
  tieOrderTableInput,
  TIE_ORDER_ITEMS,
} from '../../../src/helpers.js'

// Captured in eu-west-2 and us-east-1, 2026-11-05.
//
// Rows that share an index key come back in a fixed order. It is not the table
// sort key in either direction and not write order, and the LSI and the GSI
// disagree on it, but it reproduces across fresh tables, write orders, regions
// and accounts. Descending is always the exact reverse of ascending.
//
// A table of its own, created fresh, so the order is read from the key values
// and nothing else.

const tableName = uniqueTableName('tieOrderQuery')

const LSI_ASC = ['row-b', 'row-a', 'row-c', 'row-f', 'row-d', 'row-e']
const GSI_ASC = ['row-a', 'row-f', 'row-b', 'row-e', 'row-d', 'row-c']

async function readTie(
  IndexName: 'l-all' | 'g-all',
  ScanIndexForward: boolean,
): Promise<(string | undefined)[]> {
  const lsi = IndexName === 'l-all'
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName,
      KeyConditionExpression: lsi ? 'pk = :p AND l = :l' : 'g = :p AND l = :l',
      ExpressionAttributeValues: { ':p': { S: 'tie' }, ':l': { S: 't' } },
      ScanIndexForward,
      // A GSI refuses ConsistentRead, and the LSI's order is the same either way.
      ConsistentRead: lsi ? true : undefined,
    }),
  )
  return (res.Items ?? []).map((i) => i.sk?.S)
}

let ready: Promise<void> = Promise.resolve()

// Started here and awaited before each case, so a table or index that never
// becomes ready fails every case as a failed observation instead of skipping
// them all.
beforeAll(() => {
  ready = (async () => {
    await ddb.send(new CreateTableCommand(tieOrderTableInput(tableName)))
    await waitUntilActive(tableName)
    for (const Item of TIE_ORDER_ITEMS) {
      await ddb.send(new PutItemCommand({ TableName: tableName, Item }))
    }
    // All six, not the first: a GSI read part-way through filling returns a
    // subset in the right order and would read as a wrong order.
    await waitForGsiConsistency({
      tableName,
      indexName: 'g-all',
      partitionKey: { name: 'g', value: { S: 'tie' } },
      expectedCount: 6,
    })
  })()
  ready.catch(() => {})
})

beforeEach(async () => {
  await ready
})

afterAll(async () => {
  await deleteTable(tableName)
})

describe('Query - order of rows tied on an index key', { tags: ['query', 'data-plane', 'gsi', 'lsi'] }, () => {
  it('returns LSI ties in a fixed order ascending', async () => {
    expect(await readTie('l-all', true)).toEqual(LSI_ASC)
  })

  it('returns LSI ties in the exact reverse descending', async () => {
    expect(await readTie('l-all', false)).toEqual([...LSI_ASC].reverse())
  })

  it('returns GSI ties in a fixed order ascending, different from the LSI', async () => {
    expect(await readTie('g-all', true)).toEqual(GSI_ASC)
  })

  it('returns GSI ties in the exact reverse descending', async () => {
    expect(await readTie('g-all', false)).toEqual([...GSI_ASC].reverse())
  })
})
