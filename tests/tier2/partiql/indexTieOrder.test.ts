import { CreateTableCommand, ExecuteStatementCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import {
  uniqueTableName,
  waitUntilActive,
  deleteTable,
  tieOrderTableInput,
  TIE_ORDER_ITEMS,
} from '../../../src/helpers.js'

// Captured in eu-west-2 and us-east-1, 2026-11-05.
//
// A PartiQL read of an LSI returns rows tied on the index key in the same fixed
// order a Query of that index does. The order is not the table sort key and not
// write order, and ORDER BY on the tied key reverses it.
//
// A table of its own, created fresh, so the order is read from the key values
// and nothing else.

const tableName = uniqueTableName('tieOrderPartiql')

async function sortKeys(Statement: string): Promise<(string | undefined)[]> {
  const res = await ddb.send(new ExecuteStatementCommand({ Statement, ConsistentRead: true }))
  return (res.Items ?? []).map((i) => i.sk?.S)
}

describe('ExecuteStatement - order of rows tied on an index key', { tags: ['partiql', 'data-plane', 'gsi', 'lsi'] }, () => {
  let supported = true
  let ready: Promise<void> = Promise.resolve()

  // Started here and awaited before each case, so a table that never becomes
  // ACTIVE fails every case as a failed observation instead of skipping them
  // all.
  beforeAll(() => {
    ready = (async () => {
      await ddb.send(new CreateTableCommand(tieOrderTableInput(tableName)))
      await waitUntilActive(tableName)

      try {
        await ddb.send(new ExecuteStatementCommand({
          Statement: `SELECT * FROM "${tableName}" WHERE pk = 'partiql-canary'`,
        }))
      } catch (e: unknown) {
        // The suite's definition of "not implemented", so a target declining
        // PartiQL skips rather than failing every case here.
        if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
          supported = false
          return
        }
      }

      // Only the LSI is read here, and an LSI is written with the table, so
      // there is no index fill to wait for.
      for (const Item of TIE_ORDER_ITEMS) {
        await ddb.send(new PutItemCommand({ TableName: tableName, Item }))
      }
    })()
    ready.catch(() => {})
  })

  beforeEach(async ({ skip }) => {
    await ready
    if (!supported) skip()
  })

  afterAll(async () => {
    await deleteTable(tableName)
  })

  it('returns LSI ties in the order a Query of the index does', async () => {
    expect(await sortKeys(`SELECT * FROM "${tableName}"."l-all" WHERE pk = 'tie' AND l = 't'`)).toEqual(
      ['row-b', 'row-a', 'row-c', 'row-f', 'row-d', 'row-e'],
    )
  })

  it('returns two rows sharing an LSI key in a fixed order, not sort-key order', async () => {
    expect(await sortKeys(`SELECT * FROM "${tableName}"."l-all" WHERE pk = 'k' AND l = 'b'`)).toEqual(
      ['row-3', 'row-2'],
    )
  })

  it('reverses that order under ORDER BY on the tied key descending', async () => {
    expect(
      await sortKeys(`SELECT * FROM "${tableName}"."l-all" WHERE pk = 'k' AND l = 'b' ORDER BY l DESC`),
    ).toEqual(['row-2', 'row-3'])
  })
})
