import {
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, hashTableDef, cleanupItems } from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('UpdateItem — SET', { tags: ['update-item', 'data-plane'] }, () => {
  afterEach(async () => {
    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-set' } }])
  })

  it('creates an item when it does not exist (upsert)', async () => {
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression: 'SET #d = :v',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':v': { S: 'created-via-update' } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.data.S).toBe('created-via-update')
  })

  it('updates an existing attribute', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-set' }, data: { S: 'original' } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression: 'SET #d = :v',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':v': { S: 'modified' } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.data.S).toBe('modified')
  })

  it('adds a new attribute to an existing item', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-set' }, existing: { S: 'keep' } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression: 'SET newAttr = :v',
        ExpressionAttributeValues: { ':v': { N: '100' } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.existing.S).toBe('keep')
    expect(result.Item!.newAttr.N).toBe('100')
  })

  it('supports SET with arithmetic (SET x = x + :val)', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-set' }, counter: { N: '10' } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression: 'SET #c = #c + :inc',
        ExpressionAttributeNames: { '#c': 'counter' },
        ExpressionAttributeValues: { ':inc': { N: '5' } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.counter.N).toBe('15')
  })

  it('supports SET with if_not_exists', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-set' }, existing: { S: 'keep-me' } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression:
          'SET existing = if_not_exists(existing, :def), newone = if_not_exists(newone, :def2)',
        ExpressionAttributeValues: {
          ':def': { S: 'default' },
          ':def2': { S: 'created' },
        },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.existing.S).toBe('keep-me') // unchanged
    expect(result.Item!.newone.S).toBe('created') // set to default
  })

  it('if_not_exists with cross-attribute reference', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-set' }, myval: { S: 'original' } },
      }),
    )

    // backup doesn't exist, so if_not_exists(backup, myval) should resolve to myval's value
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression: 'SET #bk = if_not_exists(#bk, #mv)',
        ExpressionAttributeNames: { '#bk': 'backup', '#mv': 'myval' },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.backup.S).toBe('original')
  })

  it('supports SET with list_append', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: 'upd-set' },
          vals: { L: [{ S: 'a' }, { S: 'b' }] },
        },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression: 'SET vals = list_append(vals, :newItems)',
        ExpressionAttributeValues: {
          ':newItems': { L: [{ S: 'c' }, { S: 'd' }] },
        },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.vals.L).toHaveLength(4)
    expect(result.Item!.vals.L![0].S).toBe('a')
    expect(result.Item!.vals.L![3].S).toBe('d')
  })

  it('SET creates a string set whose only member is the empty string', async () => {
    // Empty string and binary values are allowed within a set; only the empty
    // set itself is rejected.
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression: 'SET tags = :v',
        ExpressionAttributeValues: { ':v': { SS: [''] } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.tags.SS).toEqual([''])
  })

  it('SET on a document path creates a nested set with an empty member', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-set' }, wrapper: { M: {} } },
      }),
    )

    // The document-path SET evaluates through the expression engine rather
    // than the whole-item validator, so it is a distinct revalidation point.
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        UpdateExpression: 'SET wrapper.tags = :v',
        ExpressionAttributeValues: { ':v': { SS: [''] } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-set' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.wrapper.M!.tags.SS).toEqual([''])
  })
})

describe('UpdateItem — REMOVE', { tags: ['update-item', 'data-plane'] }, () => {
  it('removes an attribute from an item', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: 'upd-rem' },
          keep: { S: 'yes' },
          drop: { S: 'no' },
        },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-rem' } },
        UpdateExpression: 'REMOVE #d',
        ExpressionAttributeNames: { '#d': 'drop' },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-rem' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.keep.S).toBe('yes')
    expect(result.Item!.drop).toBeUndefined()

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-rem' } }])
  })

  it('REMOVE on non-existent attribute succeeds silently', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-rem-ghost' }, existing: { S: 'hello' } },
      }),
    )

    // REMOVE an attribute that does not exist — should not throw
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-rem-ghost' } },
        UpdateExpression: 'REMOVE #g',
        ExpressionAttributeNames: { '#g': 'ghostAttr' },
      }),
    )

    // Verify item is unchanged
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-rem-ghost' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.existing.S).toBe('hello')
    expect(result.Item!.ghostAttr).toBeUndefined()

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-rem-ghost' } }])
  })

  it('REMOVE on non-existent nested path succeeds silently', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: 'upd-rem-nested' },
          mapAttr: { M: { realKey: { S: 'value' } } },
        },
      }),
    )

    // REMOVE a nested path that does not exist — should not throw
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-rem-nested' } },
        UpdateExpression: 'REMOVE #m.#n',
        ExpressionAttributeNames: { '#m': 'mapAttr', '#n': 'nonexistent' },
      }),
    )

    // Verify item is unchanged
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-rem-nested' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.mapAttr.M!.realKey.S).toBe('value')
    expect(result.Item!.mapAttr.M!.nonexistent).toBeUndefined()

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-rem-nested' } }])
  })
})

describe('UpdateItem — ADD', { tags: ['update-item', 'data-plane'] }, () => {
  it('adds a number to an existing numeric attribute', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-add' }, count: { N: '10' } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add' } },
        UpdateExpression: 'ADD #c :v',
        ExpressionAttributeNames: { '#c': 'count' },
        ExpressionAttributeValues: { ':v': { N: '3' } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.count.N).toBe('13')

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-add' } }])
  })

  it('ADD on non-existent numeric attribute creates it', async () => {
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'upd-add-new' } }, // no counter attribute
    }))
    await ddb.send(new UpdateItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-add-new' } },
      UpdateExpression: 'ADD #c :v',
      ExpressionAttributeNames: { '#c': 'counter' },
      ExpressionAttributeValues: { ':v': { N: '10' } },
    }))
    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-add-new' } },
      ConsistentRead: true,
    }))
    expect(result.Item!.counter.N).toBe('10')
    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-add-new' } }])
  })

  it('adds elements to a string set', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-add-ss' }, tags: { SS: ['a', 'b'] } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-ss' } },
        UpdateExpression: 'ADD tags :v',
        ExpressionAttributeValues: { ':v': { SS: ['c', 'd'] } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-ss' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.tags.SS).toEqual(
      expect.arrayContaining(['a', 'b', 'c', 'd']),
    )

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-add-ss' } }])
  })

  it('ADD of an empty string member onto an existing set adds it', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-add-ss-empty' }, tags: { SS: ['a'] } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-ss-empty' } },
        UpdateExpression: 'ADD tags :v',
        ExpressionAttributeValues: { ':v': { SS: [''] } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-ss-empty' } },
        ConsistentRead: true,
      }),
    )
    // GetItem returns a set's members in DynamoDB's own order, not as written:
    // string and binary sets bytewise, number sets by value. The empty string
    // sorts first (eu-west-2, 2026-10-09).
    expect(result.Item!.tags.SS).toEqual(['', 'a'])

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-add-ss-empty' } }])
  })

  it('ADD of an empty string member onto a missing attribute creates the set', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-add-ss-empty-new' } }, // no tags attribute
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-ss-empty-new' } },
        UpdateExpression: 'ADD tags :v',
        ExpressionAttributeValues: { ':v': { SS: [''] } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-ss-empty-new' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.tags.SS).toEqual([''])

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-add-ss-empty-new' } }])
  })

  it('ADD of an already-present empty member leaves the set unchanged', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-add-ss-empty-dup' }, tags: { SS: [''] } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-ss-empty-dup' } },
        UpdateExpression: 'ADD tags :v',
        ExpressionAttributeValues: { ':v': { SS: [''] } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-ss-empty-dup' } },
        ConsistentRead: true,
      }),
    )
    // Set semantics, not multiset: still exactly one member.
    expect(result.Item!.tags.SS).toEqual([''])

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-add-ss-empty-dup' } }])
  })

  it('ADD of a zero-length binary member onto an existing binary set adds it', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-add-bs-empty' }, bins: { BS: [new Uint8Array([1])] } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-bs-empty' } },
        UpdateExpression: 'ADD bins :v',
        ExpressionAttributeValues: { ':v': { BS: [new Uint8Array(0)] } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-add-bs-empty' } },
        ConsistentRead: true,
      }),
    )
    const members = result.Item!.bins.BS!
    expect(members).toHaveLength(2)
    expect(members.map((b) => b.byteLength).sort()).toEqual([0, 1])

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-add-bs-empty' } }])
  })
})

describe('UpdateItem — DELETE', { tags: ['update-item', 'data-plane'] }, () => {
  it('DELETE all elements from set removes the attribute entirely', async () => {
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'upd-del-all' }, tags: { SS: ['a', 'b'] } },
    }))
    await ddb.send(new UpdateItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-all' } },
      UpdateExpression: 'DELETE #t :v',
      ExpressionAttributeNames: { '#t': 'tags' },
      ExpressionAttributeValues: { ':v': { SS: ['a', 'b'] } },
    }))
    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-all' } },
      ConsistentRead: true,
    }))
    // Attribute should be gone entirely, not an empty set
    expect(result.Item!.tags).toBeUndefined()
    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-del-all' } }])
  })

  it('DELETE partial elements from set keeps remaining', async () => {
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'upd-del-partial' }, tags: { SS: ['a', 'b', 'c'] } },
    }))
    await ddb.send(new UpdateItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-partial' } },
      UpdateExpression: 'DELETE #t :v',
      ExpressionAttributeNames: { '#t': 'tags' },
      ExpressionAttributeValues: { ':v': { SS: ['b'] } },
    }))
    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-partial' } },
      ConsistentRead: true,
    }))
    expect(result.Item!.tags.SS).toEqual(expect.arrayContaining(['a', 'c']))
    expect(result.Item!.tags.SS).not.toContain('b')
    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-del-partial' } }])
  })

  it('removes elements from a string set', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-del-ss' }, tags: { SS: ['a', 'b', 'c'] } },
      }),
    )

    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-del-ss' } },
        UpdateExpression: 'DELETE tags :v',
        ExpressionAttributeValues: { ':v': { SS: ['b'] } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-del-ss' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.tags.SS).toEqual(expect.arrayContaining(['a', 'c']))
    expect(result.Item!.tags.SS).not.toContain('b')

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-del-ss' } }])
  })

  it('DELETE of the empty member removes it and keeps the rest', async () => {
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'upd-del-ss-empty' }, tags: { SS: ['', 'a'] } },
    }))
    await ddb.send(new UpdateItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-ss-empty' } },
      UpdateExpression: 'DELETE tags :v',
      ExpressionAttributeValues: { ':v': { SS: [''] } },
    }))
    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-ss-empty' } },
      ConsistentRead: true,
    }))
    expect(result.Item!.tags.SS).toEqual(['a'])
    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-del-ss-empty' } }])
  })

  it('DELETE of the last remaining (empty) member removes the attribute entirely', async () => {
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'upd-del-ss-empty-last' }, tags: { SS: [''] } },
    }))
    await ddb.send(new UpdateItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-ss-empty-last' } },
      UpdateExpression: 'DELETE tags :v',
      ExpressionAttributeValues: { ':v': { SS: [''] } },
    }))
    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-ss-empty-last' } },
      ConsistentRead: true,
    }))
    // Attribute gone entirely, not left behind as an (unrepresentable) empty set.
    expect(result.Item).toBeDefined()
    expect(result.Item!.tags).toBeUndefined()
    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-del-ss-empty-last' } }])
  })

  it('DELETE of the non-empty member leaves a set whose only member is empty', async () => {
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'upd-del-ss-to-empty' }, tags: { SS: ['', 'a'] } },
    }))
    await ddb.send(new UpdateItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-ss-to-empty' } },
      UpdateExpression: 'DELETE tags :v',
      ExpressionAttributeValues: { ':v': { SS: ['a'] } },
    }))
    const result = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'upd-del-ss-to-empty' } },
      ConsistentRead: true,
    }))
    // The set survives with the empty string as its sole member; the mutation
    // output is a one-member set, not a removed attribute.
    expect(result.Item!.tags.SS).toEqual([''])
    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-del-ss-to-empty' } }])
  })
})

describe('UpdateItem — return values', { tags: ['update-item', 'data-plane'] }, () => {
  it('returns ALL_NEW after update', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-ret' }, x: { N: '1' } },
      }),
    )

    const result = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-ret' } },
        UpdateExpression: 'SET x = :v',
        ExpressionAttributeValues: { ':v': { N: '2' } },
        ReturnValues: 'ALL_NEW',
      }),
    )

    expect(result.Attributes!.x.N).toBe('2')
    expect(result.Attributes!.pk.S).toBe('upd-ret')

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-ret' } }])
  })

  it('returns UPDATED_OLD for changed attributes', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-ret2' }, x: { N: '1' }, y: { S: 'keep' } },
      }),
    )

    const result = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-ret2' } },
        UpdateExpression: 'SET x = :v',
        ExpressionAttributeValues: { ':v': { N: '2' } },
        ReturnValues: 'UPDATED_OLD',
      }),
    )

    expect(result.Attributes!.x.N).toBe('1')
    // y was not updated, so it should not appear in UPDATED_OLD
    expect(result.Attributes!.y).toBeUndefined()

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-ret2' } }])
  })

  it('returns UPDATED_NEW for changed attributes', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'upd-ret3' }, x: { N: '1' }, y: { S: 'keep' } },
      }),
    )

    const result = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'upd-ret3' } },
        UpdateExpression: 'SET x = :v',
        ExpressionAttributeValues: { ':v': { N: '2' } },
        ReturnValues: 'UPDATED_NEW',
      }),
    )

    expect(result.Attributes!.x.N).toBe('2')
    expect(result.Attributes!.y).toBeUndefined()

    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-ret3' } }])
  })
})

describe('UpdateItem — SET evaluation semantics', { tags: ['update-item', 'data-plane'] }, () => {
  const keys: { pk: { S: string } }[] = []
  afterAll(async () => {
    await cleanupItems(hashTableDef.name, keys)
  })

  it('a second SET clause reads the pre-update value of another attribute', async () => {
    const pk = 'upd-snapshot'
    keys.push({ pk: { S: pk } })
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, a: { S: 'OLD' } },
      }),
    )
    // DynamoDB evaluates the whole expression against the pre-update snapshot,
    // so `b` gets the old value of `a`, not the value just assigned in the same call.
    const res = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        UpdateExpression: 'SET a = :v, b = a',
        ExpressionAttributeValues: { ':v': { S: 'NEW' } },
        ReturnValues: 'ALL_NEW',
      }),
    )
    expect(res.Attributes!.a.S).toBe('NEW')
    expect(res.Attributes!.b.S).toBe('OLD')
  })

  it('applies parenthesised arithmetic (SET c = (c - :v))', async () => {
    const pk = 'upd-paren'
    keys.push({ pk: { S: pk } })
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, c: { N: '10' } },
      }),
    )
    const res = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        UpdateExpression: 'SET c = (c - :v)',
        ExpressionAttributeValues: { ':v': { N: '3' } },
        ReturnValues: 'ALL_NEW',
      }),
    )
    expect(res.Attributes!.c.N).toBe('7')
  })

  it('applies arithmetic around if_not_exists (SET v = if_not_exists(v, :d) - :amt)', async () => {
    const pk = 'upd-ifnot-arith'
    keys.push({ pk: { S: pk } })
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, v: { N: '10' } },
      }),
    )
    const res = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        UpdateExpression: 'SET v = if_not_exists(v, :d) - :amt',
        ExpressionAttributeValues: { ':d': { N: '0' }, ':amt': { N: '3' } },
        ReturnValues: 'ALL_NEW',
      }),
    )
    expect(res.Attributes!.v.N).toBe('7')
  })

  it('composes nested functions: list_append(if_not_exists(list, :empty), :more) on a missing list', async () => {
    const pk = 'upd-nested-fn'
    keys.push({ pk: { S: pk } })
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk } },
      }),
    )
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        UpdateExpression: 'SET mylist = list_append(if_not_exists(mylist, :empty), :more)',
        ExpressionAttributeValues: { ':empty': { L: [] }, ':more': { L: [{ S: 'x' }] } },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.mylist.L).toEqual([{ S: 'x' }])
  })

  it('list_append argument order controls prepend vs append', async () => {
    const pk = 'upd-prepend'
    keys.push({ pk: { S: pk } })
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, vals: { L: [{ S: 'b' }, { S: 'c' }] } },
      }),
    )
    await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        UpdateExpression: 'SET vals = list_append(:new, vals)',
        ExpressionAttributeValues: { ':new': { L: [{ S: 'a' }] } },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.vals.L).toEqual([{ S: 'a' }, { S: 'b' }, { S: 'c' }])
  })
})

describe('UpdateItem — ReturnValues granularity', { tags: ['update-item', 'data-plane'] }, () => {
  const keys: { pk: { S: string } }[] = []
  afterAll(async () => {
    await cleanupItems(hashTableDef.name, keys)
  })

  it('UPDATED_NEW on a create returns the newly set attributes', async () => {
    const pk = 'rv-create'
    keys.push({ pk: { S: pk } })
    const res = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        UpdateExpression: 'SET a = :a',
        ExpressionAttributeValues: { ':a': { S: 'x' } },
        ReturnValues: 'UPDATED_NEW',
      }),
    )
    // Even when the update creates the item, AWS returns the set attribute.
    expect(res.Attributes).toBeDefined()
    expect(res.Attributes!.a.S).toBe('x')
  })

  it('UPDATED_NEW on a nested SET returns only the changed fragment', async () => {
    const pk = 'rv-nested'
    keys.push({ pk: { S: pk } })
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: pk },
          parent: { M: { keep: { S: 'k' }, child: { S: 'old' } } },
        },
      }),
    )
    const res = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        UpdateExpression: 'SET parent.child = :v',
        ExpressionAttributeValues: { ':v': { S: 'new' } },
        ReturnValues: 'UPDATED_NEW',
      }),
    )
    // Only the changed path comes back, not the whole parent map.
    expect(res.Attributes!.parent.M!.child.S).toBe('new')
    expect(res.Attributes!.parent.M!.keep).toBeUndefined()
  })

  it('REMOVE with UPDATED_NEW omits Attributes (nothing was set to a new value)', async () => {
    const pk = 'rv-remove'
    keys.push({ pk: { S: pk } })
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, x: { S: 'keep' }, y: { S: 'drop' } },
      }),
    )
    const res = await ddb.send(
      new UpdateItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        UpdateExpression: 'REMOVE y',
        ReturnValues: 'UPDATED_NEW',
      }),
    )
    expect(res.Attributes).toBeUndefined()
  })
})

describe('UpdateItem — no-op upsert', { tags: ['update-item', 'data-plane'] }, () => {
  afterEach(async () => {
    await cleanupItems(hashTableDef.name, [{ pk: { S: 'upd-noop' } }])
  })

  it('with only Key and no update actions creates the item', async () => {
    // Real AWS treats an UpdateItem carrying only TableName and Key (no
    // UpdateExpression, no AttributeUpdates) as a no-op upsert: it succeeds and
    // the item exists afterwards with just its key.
    const key = { pk: { S: 'upd-noop' } }
    const res = await ddb.send(
      new UpdateItemCommand({ TableName: hashTableDef.name, Key: key }),
    )
    expect(res.Attributes).toBeUndefined()

    const got = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: key,
        ConsistentRead: true,
      }),
    )
    expect(got.Item).toEqual(key)
  })
})
