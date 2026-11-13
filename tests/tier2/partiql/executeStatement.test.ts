import {
  ExecuteStatementCommand,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, hashTableDef, compositeTableDef, cleanupItems, expectDynamoError, absentTableName, withBody } from '../../../src/helpers.js'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

declareTables(hashTableDef, compositeTableDef)

describe('ExecuteStatement — PartiQL', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true

  const keysToCleanup: Record<string, { S: string }>[] = []
  const compositeKeysToCleanup: Record<string, AttributeValue>[] = []

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      // isUnsupportedFault is the suite's definition of "not implemented", so a
      // target signalling it any recognised way (including HTTP 501) skips here
      // rather than failing every PartiQL test. UnrecognizedClientException is
      // kept alongside it: it is a credentials rejection, not an unsupported
      // fault, but it is how at least one target declines PartiQL.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    if (keysToCleanup.length > 0) {
      await cleanupItems(hashTableDef.name, keysToCleanup)
    }
    if (compositeKeysToCleanup.length > 0) {
      await cleanupItems(compositeTableDef.name, compositeKeysToCleanup)
    }
  })

  it('INSERTs a new item', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-insert-1' } })

    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': 'partiql-insert-1', 'data': 'inserted'}`,
    }))

    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-insert-1' } },
      ConsistentRead: true,
    }))

    expect(result.Item).toBeDefined()
    expect(result.Item!.data.S).toBe('inserted')
  })

  it('SELECTs an item by primary key', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-select-1' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'partiql-select-1' }, data: { S: 'selectme' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'partiql-select-1'`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    expect(result.Items![0].pk.S).toBe('partiql-select-1')
    expect(result.Items![0].data.S).toBe('selectme')
  })

  it('SELECTs with WHERE clause using comparison', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-cmp-1' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'partiql-cmp-1' }, age: { N: '30' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'partiql-cmp-1' AND age > 20`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    expect(result.Items![0].age.N).toBe('30')
  })

  it('UPDATEs an existing item', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-update-1' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'partiql-update-1' }, data: { S: 'before' } },
    }))

    await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET data = 'after' WHERE pk = 'partiql-update-1'`,
    }))

    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-update-1' } },
      ConsistentRead: true,
    }))

    expect(result.Item).toBeDefined()
    expect(result.Item!.data.S).toBe('after')
  })

  it('DELETEs an item', async () => {
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'partiql-delete-1' }, data: { S: 'gone' } },
    }))

    await ddb.send(new ExecuteStatementCommand({
      Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = 'partiql-delete-1'`,
    }))

    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-delete-1' } },
      ConsistentRead: true,
    }))

    expect(result.Item).toBeUndefined()
  })

  it('rejects INSERT on an existing item (INSERT is not upsert)', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-dup-insert' } })

    // First insert succeeds
    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': 'partiql-dup-insert', 'data': 'first'}`,
    }))

    // Verify item was created
    const check = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-dup-insert' } },
      ConsistentRead: true,
    }))
    expect(check.Item).toBeDefined()
    expect(check.Item!.data.S).toBe('first')

    // Second INSERT with same key should fail with DuplicateItemException
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': 'partiql-dup-insert', 'data': 'second'}`,
      })),
      'DuplicateItemException',
    )
  })

  it('INSERT succeeds after DELETE of same key', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-reinsert' } })

    // Insert an item
    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': 'partiql-reinsert', 'data': 'original'}`,
    }))

    // Delete it
    await ddb.send(new ExecuteStatementCommand({
      Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = 'partiql-reinsert'`,
    }))

    // Verify it's gone
    const deleted = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-reinsert' } },
      ConsistentRead: true,
    }))
    expect(deleted.Item).toBeUndefined()

    // INSERT again with same key — should succeed
    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': 'partiql-reinsert', 'data': 'reinserted'}`,
    }))

    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-reinsert' } },
      ConsistentRead: true,
    }))
    expect(result.Item).toBeDefined()
    expect(result.Item!.data.S).toBe('reinserted')
  })

  it('SELECT returns empty results for non-matching WHERE', async () => {
    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'partiql-nonexistent-key'`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(0)
  })

  it('parameterized INSERT with ? placeholders', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-param-insert-1' } })

    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': ?, 'data': ?}`,
      Parameters: [
        { S: 'partiql-param-insert-1' },
        { S: 'param-inserted' },
      ],
    }))

    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-param-insert-1' } },
      ConsistentRead: true,
    }))

    expect(result.Item).toBeDefined()
    expect(result.Item!.data.S).toBe('param-inserted')
  })

  it('parameterized SELECT with ? placeholder', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-param-select-1' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'partiql-param-select-1' }, data: { S: 'found' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = ?`,
      Parameters: [{ S: 'partiql-param-select-1' }],
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    expect(result.Items![0].data.S).toBe('found')
  })

  // ── N1: PartiQL nested path SELECT ──────────────────────────────────

  it('SELECT with nested map path', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-nested' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: {
        pk: { S: 'partiql-nested' },
        mymap: { M: { nested: { S: 'deep' } } },
      },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT mymap.nested FROM "${hashTableDef.name}" WHERE pk = 'partiql-nested'`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    expect(result.Items![0].nested.S).toBe('deep')
  })

  it('SELECT with specific attributes', async () => {
    // Re-uses 'partiql-nested' item from prior test
    keysToCleanup.push({ pk: { S: 'partiql-nested' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: {
        pk: { S: 'partiql-nested' },
        mymap: { M: { nested: { S: 'deep' } } },
        extra: { S: 'should-not-appear' },
      },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT pk, mymap FROM "${hashTableDef.name}" WHERE pk = 'partiql-nested'`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(item.pk.S).toBe('partiql-nested')
    expect(item.mymap).toBeDefined()
    expect(item.extra).toBeUndefined()
  })

  // ── N2: PartiQL begins_with in WHERE ──────────────────────────────────

  it('SELECT with begins_with in WHERE clause', async () => {
    compositeKeysToCleanup.push(
      { pk: { S: 'partiql-bw-test' }, sk: { S: 'prefix-alpha' } },
      { pk: { S: 'partiql-bw-test' }, sk: { S: 'prefix-beta' } },
      { pk: { S: 'partiql-bw-test' }, sk: { S: 'other-gamma' } },
    )

    await Promise.all([
      ddb.send(new PutItemCommand({
        TableName: compositeTableDef.name,
        Item: { pk: { S: 'partiql-bw-test' }, sk: { S: 'prefix-alpha' }, data: { S: 'a' } },
      })),
      ddb.send(new PutItemCommand({
        TableName: compositeTableDef.name,
        Item: { pk: { S: 'partiql-bw-test' }, sk: { S: 'prefix-beta' }, data: { S: 'b' } },
      })),
      ddb.send(new PutItemCommand({
        TableName: compositeTableDef.name,
        Item: { pk: { S: 'partiql-bw-test' }, sk: { S: 'other-gamma' }, data: { S: 'c' } },
      })),
    ])

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${compositeTableDef.name}" WHERE pk = 'partiql-bw-test' AND begins_with("sk", 'prefix-')`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(2)
    const sks = result.Items!.map((i) => i.sk.S).sort()
    expect(sks).toEqual(['prefix-alpha', 'prefix-beta'])
  })

  // ── N3: PartiQL UPDATE with set operations ────────────────────────────

  it('PartiQL UPDATE with SET on attribute', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-update-set' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'partiql-update-set' }, myattr: { S: 'oldval' } },
    }))

    await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET myattr = 'newval' WHERE pk = 'partiql-update-set'`,
    }))

    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-update-set' } },
      ConsistentRead: true,
    }))

    expect(result.Item).toBeDefined()
    expect(result.Item!.myattr.S).toBe('newval')
  })

  it('PartiQL UPDATE with REMOVE', async () => {
    keysToCleanup.push({ pk: { S: 'partiql-update-remove' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'partiql-update-remove' }, myattr: { S: 'to-remove' }, keep: { S: 'stay' } },
    }))

    await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" REMOVE myattr WHERE pk = 'partiql-update-remove'`,
    }))

    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'partiql-update-remove' } },
      ConsistentRead: true,
    }))

    expect(result.Item).toBeDefined()
    expect(result.Item!.myattr).toBeUndefined()
    expect(result.Item!.keep.S).toBe('stay')
  })

  it('returns a populated ConsumedCapacity block when requested', async () => {
    const pk = 'partiql-cc'
    keysToCleanup.push({ pk: { S: pk } })

    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${hashTableDef.name}" VALUE { 'pk': '${pk}', 'v': 1 }`,
    }))

    const res = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = '${pk}'`,
      ReturnConsumedCapacity: 'TOTAL',
    }))

    // PartiQL always returns the ConsumedCapacity block when asked; some
    // emulators omit it entirely.
    expect(res.ConsumedCapacity).toBeDefined()
    expect(res.ConsumedCapacity!.CapacityUnits).toBeGreaterThan(0)
  })

  it('evaluates negated predicates (NOT begins_with, IS NOT MISSING)', async () => {
    keysToCleanup.push({ pk: { S: 'pq-neg-a' } }, { pk: { S: 'pq-neg-b' } })
    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${hashTableDef.name}" VALUE { 'pk': 'pq-neg-a', 'kind': 'alpha' }`,
    }))
    await ddb.send(new ExecuteStatementCommand({
      Statement: `INSERT INTO "${hashTableDef.name}" VALUE { 'pk': 'pq-neg-b', 'kind': 'beta' }`,
    }))

    // NOT begins_with must evaluate, not fail: only 'beta' does not begin with 'al'.
    const notBw = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk IN ['pq-neg-a','pq-neg-b'] AND NOT begins_with("kind", 'al')`,
    }))
    expect(notBw.Items).toHaveLength(1)
    expect(notBw.Items![0].pk.S).toBe('pq-neg-b')

    // IS NOT MISSING must evaluate: 'kind' is present, so the row matches.
    const notMissing = await ddb.send(new ExecuteStatementCommand({
      Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'pq-neg-a' AND "kind" IS NOT MISSING`,
    }))
    expect(notMissing.Items).toHaveLength(1)
    expect(notMissing.Items![0].pk.S).toBe('pq-neg-a')
  })

  // ── Non-key predicates in PartiQL write WHERE clauses ─────────────────
  // AWS treats a non-key predicate in a DELETE/UPDATE WHERE as a condition that
  // must hold. When the item exists but the predicate is false, the write fails
  // with ConditionalCheckFailedException and the item is left untouched. A
  // missing key is a silent no-op (not ConditionalCheckFailed). The full primary
  // key is mandatory; omitting it is a ValidationException.

  it('DELETE with a false non-key predicate fails ConditionalCheckFailed and leaves the item', async () => {
    const pk = 'pq-pred-del-false'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, name: { S: 'alpha' }, n: { N: '5' } },
    }))

    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' AND "name" = 'beta'`,
      })),
      'ConditionalCheckFailedException',
    )

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item).toBeDefined()
    expect(after.Item!.name.S).toBe('alpha')
  })

  it('DELETE with a true non-key predicate removes the item', async () => {
    const pk = 'pq-pred-del-true'
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, name: { S: 'alpha' } },
    }))

    await ddb.send(new ExecuteStatementCommand({
      Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' AND "name" = 'alpha'`,
    }))

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item).toBeUndefined()
  })

  it('UPDATE with a false non-key predicate fails ConditionalCheckFailed and leaves the item', async () => {
    const pk = 'pq-pred-upd-false'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, name: { S: 'alpha' }, n: { N: '5' } },
    }))

    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `UPDATE "${hashTableDef.name}" SET n = 9 WHERE pk = '${pk}' AND "name" = 'beta'`,
      })),
      'ConditionalCheckFailedException',
    )

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.n.N).toBe('5')
  })

  it('UPDATE with a true non-key predicate mutates the item', async () => {
    const pk = 'pq-pred-upd-true'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, name: { S: 'alpha' }, n: { N: '5' } },
    }))

    await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET n = 9 WHERE pk = '${pk}' AND "name" = 'alpha'`,
    }))

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.n.N).toBe('9')
  })

  it('DELETE with a false NOT begins_with predicate fails ConditionalCheckFailed', async () => {
    const pk = 'pq-pred-fn-false'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, name: { S: 'alpha' } },
    }))

    // name is 'alpha' which begins with 'al', so NOT begins_with(name, 'al') is false.
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' AND NOT begins_with("name", 'al')`,
      })),
      'ConditionalCheckFailedException',
    )

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item).toBeDefined()
  })

  it('DELETE with a true NOT begins_with predicate removes the item', async () => {
    const pk = 'pq-pred-fn-true'
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, name: { S: 'alpha' } },
    }))

    await ddb.send(new ExecuteStatementCommand({
      Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' AND NOT begins_with("name", 'zz')`,
    }))

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item).toBeUndefined()
  })

  it('rejects a write WHERE clause that omits the primary key', async () => {
    const pk = 'pq-pred-nopk'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, name: { S: 'alpha' } },
    }))

    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE "name" = 'alpha'`,
      })),
      'ValidationException',
      'Where clause does not contain a mandatory equality on all key attributes',
    )
  })

  it('DELETE on a missing key with a non-key predicate is a silent no-op', async () => {
    const pk = 'pq-pred-missing'
    // Ensure the key does not exist.
    await ddb.send(new DeleteItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } },
    }))

    // The item does not exist, so the condition is never evaluated. This succeeds
    // as a no-op rather than raising ConditionalCheckFailedException.
    await ddb.send(new ExecuteStatementCommand({
      Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' AND "name" = 'x'`,
    }))

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item).toBeUndefined()
  })

  // ── RETURNING clause ──────────────────────────────────────────────────
  // DynamoDB PartiQL accepts only `RETURNING ALL OLD *` on DELETE, and all four
  // variants (ALL/MODIFIED x OLD/NEW) on UPDATE. The returned attributes surface
  // on `result.Items` (an array), not on `Attributes`. `ALL *` includes the key;
  // `MODIFIED *` returns only the changed attribute and omits the key. Behaviour
  // characterised against real AWS (eu-west-2). See #102.

  it('DELETE RETURNING ALL OLD * returns the deleted item', async () => {
    const pk = 'pq-ret-del-hit'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'gone' }, n: { N: '7' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' RETURNING ALL OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    expect(result.Items![0].pk.S).toBe(pk)
    expect(result.Items![0].data.S).toBe('gone')
    expect(result.Items![0].n.N).toBe('7')

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item).toBeUndefined()
  })

  it('DELETE RETURNING ALL OLD * on a missing item returns an empty Items list', async () => {
    const pk = 'pq-ret-del-miss'
    // Ensure the key does not exist.
    await ddb.send(new DeleteItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' RETURNING ALL OLD *`,
    }))

    // AWS returns an empty array — a no-op success — not undefined. This differs
    // from the classic DeleteItem ReturnValues path (Attributes: undefined).
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(0)
  })

  it('DELETE rejects RETURNING MODIFIED OLD * (only ALL OLD * is valid on DELETE)', async () => {
    const pk = 'pq-ret-del-modold'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name, Item: { pk: { S: pk }, data: { S: 'x' } },
    }))

    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
      })),
      'ValidationException',
      /Only RETURNING ALL OLD \* is allowed in DELETE statements/,
    )

    // The rejected statement must not have deleted the item.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data.S).toBe('x')
  })

  it('DELETE rejects RETURNING MODIFIED NEW * (only ALL OLD * is valid on DELETE)', async () => {
    const pk = 'pq-ret-del-modnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name, Item: { pk: { S: pk }, data: { S: 'x' } },
    }))

    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
      })),
      'ValidationException',
      /Only RETURNING ALL OLD \* is allowed in DELETE statements/,
    )

    // The rejected statement must not have deleted the item.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data.S).toBe('x')
  })

  it('DELETE rejects RETURNING ALL NEW * with a 400, not a 500', async () => {
    const pk = 'pq-ret-del-allnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name, Item: { pk: { S: pk }, data: { S: 'x' } },
    }))

    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' RETURNING ALL NEW *`,
      }))
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.$metadata.httpStatusCode).toBe(400)
    }

    // The rejected statement must not have deleted the item.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data.S).toBe('x')
  })

  it('UPDATE RETURNING ALL OLD * returns the full prior item', async () => {
    const pk = 'pq-ret-upd-allold'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' }, keep: { S: 'same' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING ALL OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(item.pk.S).toBe(pk)
    expect(item.data.S).toBe('old')   // pre-update value
    expect(item.keep.S).toBe('same')  // untouched attribute present

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data.S).toBe('new')
  })

  it('UPDATE RETURNING MODIFIED OLD * returns only the changed attribute (old value, no key)', async () => {
    const pk = 'pq-ret-upd-modold'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' }, keep: { S: 'same' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(item.data.S).toBe('old')
    // MODIFIED returns only the changed attribute — no key, no untouched attrs.
    expect(Object.keys(item)).toEqual(['data'])

    // The payload echoes the OLD value, so confirm the write actually applied.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data.S).toBe('new')
  })

  it('UPDATE RETURNING ALL NEW * returns the full new item', async () => {
    const pk = 'pq-ret-upd-allnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' }, keep: { S: 'same' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING ALL NEW *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(item.pk.S).toBe(pk)
    expect(item.data.S).toBe('new')   // post-update value
    expect(item.keep.S).toBe('same')  // untouched attribute present

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data.S).toBe('new')
  })

  it('UPDATE RETURNING MODIFIED NEW * returns only the changed attribute (new value, no key)', async () => {
    const pk = 'pq-ret-upd-modnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' }, keep: { S: 'same' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(item.data.S).toBe('new')
    expect(Object.keys(item)).toEqual(['data'])

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data.S).toBe('new')
  })

  // ── RETURNING clause: MODIFIED projection edges ───────────────────────
  // MODIFIED returns Items: [] (no row) when the projection would be empty —
  // a removed attribute under NEW, or a never-existed attribute under OLD —
  // and returns only the changed leaf for a nested SET path (the untouched
  // sibling and the key are excluded). Characterised against real AWS
  // (eu-west-2). See #102.

  it('UPDATE RETURNING MODIFIED NEW * over a nested path returns only the changed leaf', async () => {
    const pk = 'pq-ret-upd-nested-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, profile: { M: { sub: { S: 'old' }, sib: { S: 'keep' } } } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET profile.sub = 'new' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    // Only the changed leaf comes back — no untouched sibling, no key.
    expect(Object.keys(item)).toEqual(['profile'])
    expect(Object.keys(item.profile.M!)).toEqual(['sub'])
    expect(item.profile.M!.sub.S).toBe('new')
  })

  it('UPDATE RETURNING MODIFIED OLD * over a nested path returns only the changed leaf at its old value', async () => {
    const pk = 'pq-ret-upd-nested-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, profile: { M: { sub: { S: 'old' }, sib: { S: 'keep' } } } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET profile.sub = 'new' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['profile'])
    expect(Object.keys(item.profile.M!)).toEqual(['sub'])
    expect(item.profile.M!.sub.S).toBe('old')
  })

  it('UPDATE REMOVE RETURNING MODIFIED OLD * returns the removed attribute at its old value', async () => {
    const pk = 'pq-ret-rem-modold'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' }, keep: { S: 'same' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" REMOVE data WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['data'])
    expect(item.data.S).toBe('old')
  })

  it('UPDATE REMOVE RETURNING MODIFIED NEW * returns an empty Items list', async () => {
    const pk = 'pq-ret-rem-modnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' }, keep: { S: 'same' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" REMOVE data WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    // The removed attribute has no new value to project, so AWS returns no row
    // (Items: []) rather than a row holding an empty object.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(0)
  })

  it('UPDATE RETURNING MODIFIED OLD * on a newly-set attribute returns an empty Items list', async () => {
    const pk = 'pq-ret-upd-noprior-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, keep: { S: 'same' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    // The changed attribute had no old value, so the MODIFIED OLD projection is
    // empty and AWS returns no row (Items: []), not a row with an empty object.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(0)
  })

  it('UPDATE RETURNING MODIFIED NEW * on a newly-set attribute returns the new value', async () => {
    const pk = 'pq-ret-upd-noprior-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, keep: { S: 'same' } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['data'])
    expect(item.data.S).toBe('new')
  })

  it('UPDATE RETURNING MODIFIED NEW * on a list index returns only the changed element', async () => {
    const pk = 'pq-ret-upd-lidx-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[0] = 'x' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    // The list analogue of the nested-map changed-leaf rule: only the changed
    // element comes back, in list shape, its index collapsed to 0. No key, no
    // untouched sibling elements.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.length).toBe(1)
    expect(item.tags.L![0].S).toBe('x')

    // And the write is a genuine list-index SET: the untouched element survives.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['x', 'b'])
  })

  it('UPDATE RETURNING MODIFIED OLD * on a list index returns only the prior element', async () => {
    const pk = 'pq-ret-upd-lidx-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[0] = 'x' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.length).toBe(1)
    expect(item.tags.L![0].S).toBe('a')
  })

  // ── RETURNING clause: MODIFIED over list-index edges ──────────────────
  // Extends the single-index-0 case above. MODIFIED projects each path named
  // in the statement against the relevant item (new item for NEW, old item for
  // OLD): a path that still resolves contributes its element, one that no longer
  // resolves contributes nothing, and contributed list elements come back as a
  // dense list in ascending index order (positions are not preserved). So a
  // non-zero index collapses to a single element, multiple indices pack densely,
  // an out-of-range append projects nothing, and a REMOVE shifts rather than
  // clears the index. Characterised against real AWS (eu-west-2). See #102.

  it('UPDATE RETURNING MODIFIED NEW * on a non-zero list index returns only the changed element', async () => {
    const pk = 'pq-ret-upd-lidx-nz-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[2] = 'y' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    // The changed element comes back as a single-element list whatever its source
    // index — index 2 collapses to projection index 0, the same as index 0 did.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['y'])

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['a', 'b', 'y'])
  })

  it('UPDATE RETURNING MODIFIED OLD * on a non-zero list index returns the prior element', async () => {
    const pk = 'pq-ret-upd-lidx-nz-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[2] = 'y' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['c'])
  })

  it('UPDATE RETURNING MODIFIED NEW * over multiple list indices returns a dense pack of the changed elements', async () => {
    const pk = 'pq-ret-upd-lidx-multi-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[0] = 'x', tags[2] = 'y' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    // Both changed elements come back, packed into a dense list in ascending
    // index order. The untouched element at index 1 is dropped and 'y' sits at
    // projection index 1, not 2 — this is not a positional or sparse projection.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['x', 'y'])

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['x', 'b', 'y'])
  })

  it('UPDATE RETURNING MODIFIED OLD * over multiple list indices returns the prior elements densely', async () => {
    const pk = 'pq-ret-upd-lidx-multi-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[0] = 'x', tags[2] = 'y' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['a', 'c'])
  })

  it('UPDATE RETURNING MODIFIED NEW * packs changed indices in ascending index order, not statement order', async () => {
    const pk = 'pq-ret-upd-lidx-order'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    // The statement lists the higher index first, but the projection still comes
    // back in ascending index order ('x' from index 0 before 'y' from index 2),
    // so the dense pack is ordered by index, not by the order of the SET clauses.
    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[2] = 'y', tags[0] = 'x' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['x', 'y'])

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['x', 'b', 'y'])
  })

  it('UPDATE RETURNING MODIFIED OLD * packs changed indices in ascending index order, not statement order', async () => {
    const pk = 'pq-ret-upd-lidx-order-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    // OLD sorts by index too: the statement lists tags[2] before tags[0], but the
    // prior values come back ['a','c'] (index 0 then index 2), not ['c','a'].
    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[2] = 'y', tags[0] = 'x' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['a', 'c'])
  })

  it('UPDATE RETURNING MODIFIED NEW * on an out-of-range list index (append) returns an empty Items list', async () => {
    const pk = 'pq-ret-upd-lidx-append-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[5] = 'c' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    // The write appends at the end (the index is clamped to the length), but the
    // projection resolves the literal path tags[5] against the new 3-element list,
    // where it is out of range — so nothing is projected and AWS returns no row.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(0)

    // The append still applied.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['a', 'b', 'c'])
  })

  it('UPDATE RETURNING MODIFIED OLD * on an out-of-range list index (append) returns an empty Items list', async () => {
    const pk = 'pq-ret-upd-lidx-append-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[5] = 'c' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    // tags[5] is out of range on the old 2-element list too, so the OLD
    // projection is also empty.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(0)
  })

  it('UPDATE RETURNING MODIFIED NEW * appending at exactly the list length returns the appended element', async () => {
    const pk = 'pq-ret-upd-lidx-applen-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[2] = 'c' WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    // Same append as the tags[5] case (stored ['a','b','c']), but here the literal
    // index equals the old length, so tags[2] DOES resolve on the new 3-element
    // list and the projection returns the appended element rather than Items: [].
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['c'])

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['a', 'b', 'c'])
  })

  it('UPDATE RETURNING MODIFIED OLD * appending at exactly the list length returns an empty Items list', async () => {
    const pk = 'pq-ret-upd-lidx-applen-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" SET tags[2] = 'c' WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    // tags[2] is out of range on the OLD 2-element list, so the OLD projection is
    // empty even though the NEW projection returns the appended element.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(0)
  })

  it('UPDATE REMOVE RETURNING MODIFIED OLD * on a list index returns the removed element at its old value', async () => {
    const pk = 'pq-ret-rem-lidx-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" REMOVE tags[1] WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['b'])

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['a', 'c'])
  })

  it('UPDATE REMOVE RETURNING MODIFIED NEW * on a list index returns the shifted element, not an empty list', async () => {
    const pk = 'pq-ret-rem-lidx-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" REMOVE tags[1] WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    // Removing a list index shifts the tail down rather than deleting a key, so
    // the path tags[1] still resolves on the new list ['a','c'] and points at 'c'.
    // This is why the map-REMOVE rule (removed attribute -> Items: []) does not
    // carry to list indices: the index is not gone, it now holds the shifted tail.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['c'])

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['a', 'c'])
  })

  it('UPDATE REMOVE RETURNING MODIFIED NEW * on the last list index returns an empty Items list', async () => {
    const pk = 'pq-ret-rem-lidx-last-new'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" REMOVE tags[2] WHERE pk = '${pk}' RETURNING MODIFIED NEW *`,
    }))

    // Removing the LAST index leaves no tail to shift up, so tags[2] no longer
    // resolves on the new 2-element list and the NEW projection is empty — unlike
    // a middle-index REMOVE, where the shifted element keeps the path resolvable.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(0)

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.tags.L!.map(v => v.S)).toEqual(['a', 'b'])
  })

  it('UPDATE REMOVE RETURNING MODIFIED OLD * on the last list index returns the removed element', async () => {
    const pk = 'pq-ret-rem-lidx-last-old'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, tags: { L: [{ S: 'a' }, { S: 'b' }, { S: 'c' }] } },
    }))

    const result = await ddb.send(new ExecuteStatementCommand({
      Statement: `UPDATE "${hashTableDef.name}" REMOVE tags[2] WHERE pk = '${pk}' RETURNING MODIFIED OLD *`,
    }))

    // tags[2] is in range on the OLD list, so the OLD projection still returns the
    // removed element.
    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(1)
    const item = result.Items![0]
    expect(Object.keys(item)).toEqual(['tags'])
    expect(item.tags.L!.map(v => v.S)).toEqual(['c'])
  })

  it('UPDATE SET on a list index of an absent attribute is rejected, not auto-created', async () => {
    const pk = 'pq-ret-upd-lidx-absent'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, marker: { S: 'present' } },
    }))

    // A write-path gap, not RETURNING-specific: DynamoDB does not auto-create a
    // parent for a nested write, so setting an index on an attribute that does
    // not exist is rejected the same as a map key on a missing parent. It does
    // not create the list. Characterised against real AWS (eu-west-2).
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `UPDATE "${hashTableDef.name}" SET newlist[0] = 'x' WHERE pk = '${pk}'`,
      })),
      'ValidationException',
      'The document path provided in the update expression is invalid for update',
    )

    // The rejected statement created nothing.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.newlist).toBeUndefined()
    expect(after.Item!.marker.S).toBe('present')
  })

  it('UPDATE on a non-existent key fails ConditionalCheckFailed (PartiQL UPDATE is not an upsert)', async () => {
    const pk = 'pq-ret-upd-ghost'
    // Deliberately not seeded — the key must not exist.

    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING ALL OLD *`,
      })),
      'ConditionalCheckFailedException',
      'The conditional request failed',
    )

    // Not an upsert — the rejected UPDATE did not create the item.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item).toBeUndefined()
  })

  // ── Limit ────────────────────────────────────────────────────────────

  // Captured in eu-west-2 and us-east-1, 2026-11-03 and 2026-11-05. A Limit
  // far past the row count reads everything on one page, however it is
  // written, and a fractional Limit is truncated rather than refused.
  describe('Limit', () => {
    const pk = 'partiql-limit'
    const rows = ['row-1', 'row-2', 'row-3', 'row-4']
    const partition = () => `SELECT * FROM "${compositeTableDef.name}" WHERE pk = '${pk}'`
    const keySet = () => `SELECT * FROM "${compositeTableDef.name}" WHERE pk = '${pk}' AND (sk = 'row-1' OR sk = 'row-3')`

    beforeAll(async () => {
      if (!supported) return
      for (const sk of rows) {
        compositeKeysToCleanup.push({ pk: { S: pk }, sk: { S: sk } })
        await ddb.send(new PutItemCommand({
          TableName: compositeTableDef.name,
          Item: { pk: { S: pk }, sk: { S: sk } },
        }))
      }
    })

    // The SDK sends Limit as a JSON number it has formatted itself, so the
    // other spellings go in a body written by hand.
    function rawPage(Statement: string, limit: string, NextToken?: string) {
      const token = NextToken === undefined ? '' : `,"NextToken":${JSON.stringify(NextToken)}`
      const body = `{"Statement":${JSON.stringify(Statement)},"ConsistentRead":true,"Limit":${limit}${token}}`
      return ddb.send(withBody(new ExecuteStatementCommand({ Statement, ConsistentRead: true }), body))
    }

    const sortKeys = (items: Record<string, AttributeValue>[] | undefined) => (items ?? []).map((i) => i.sk.S)

    it('a Limit at or past the 32-bit range returns the whole partition on one page', async () => {
      for (const Limit of [2147483647, 2147483648, 2 ** 62, 2 ** 63]) {
        const res = await ddb.send(new ExecuteStatementCommand({ Statement: partition(), Limit, ConsistentRead: true }))
        expect(sortKeys(res.Items), String(Limit)).toEqual(rows)
        expect(res.NextToken, String(Limit)).toBeUndefined()
      }
    })

    it('a Limit near the 64-bit range returns a whole set of keys on one page', async () => {
      for (const Limit of [2 ** 62, 2 ** 63]) {
        const res = await ddb.send(new ExecuteStatementCommand({ Statement: keySet(), Limit, ConsistentRead: true }))
        expect(sortKeys(res.Items), String(Limit)).toEqual(['row-1', 'row-3'])
        expect(res.NextToken, String(Limit)).toBeUndefined()
      }
    })

    it('a Limit written with an exponent or past 64 bits returns the whole partition on one page', async () => {
      for (const limit of ['1E+2', '1e+20', '100000000000000000000', '18446744073709551617']) {
        const res = await rawPage(partition(), limit)
        expect(sortKeys(res.Items), limit).toEqual(rows)
        expect(res.NextToken, limit).toBeUndefined()
      }
    })

    for (const limit of ['1.0', '1.5']) {
      it(`a Limit of ${limit} reads as 1, one row a page`, async () => {
        // Whether an empty page follows the last row is not pinned; every page
        // with rows holds exactly one, and together they cover the partition.
        const pages: (string | undefined)[][] = []
        let NextToken: string | undefined
        for (let i = 0; i < rows.length + 2; i++) {
          const res = await rawPage(partition(), limit, NextToken)
          pages.push(sortKeys(res.Items))
          NextToken = res.NextToken
          if (!NextToken) break
        }
        expect(NextToken).toBeUndefined()
        const filled = pages.filter((p) => p.length > 0)
        expect(filled).toEqual(rows.map((r) => [r]))
      })
    }
  })

  // ── Error tests ───────────────────────────────────────────────────────

  it('rejects a statement with syntax error', async () => {
    await expectDynamoError(
      () => ddb.send(new ExecuteStatementCommand({
        Statement: `SELECTT * FROMM "${hashTableDef.name}"`,
      })),
      'ValidationException',
    )
  })

  it('rejects a reference to a non-existent table', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${absentTableName('nonexistent_table')}" WHERE pk = 'x'`,
      }))
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeDefined()
      expect((e as Error).name).toBe('ResourceNotFoundException')
    }
  })
})
