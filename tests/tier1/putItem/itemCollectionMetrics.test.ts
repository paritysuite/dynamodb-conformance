import {
  PutItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, compositeIndexedTableDef, cleanupItems } from '../../../src/helpers.js'

declareTables(compositeIndexedTableDef)

describe('ReturnItemCollectionMetrics', { tags: ['put-item', 'data-plane', 'gsi', 'lsi'] }, () => {
  const keys = [
    { pk: { S: 'icm-put-1' }, sk: { S: 'a' } },
    { pk: { S: 'icm-del-1' }, sk: { S: 'a' } },
    { pk: { S: 'icm-upd-1' }, sk: { S: 'a' } },
    { pk: { S: 'icm-none-1' }, sk: { S: 'a' } },
    { pk: { S: 'icm-range-1' }, sk: { S: 'a' } },
  ]

  afterAll(async () => {
    await cleanupItems(compositeIndexedTableDef.name, keys)
  })

  it('PutItem with SIZE returns ItemCollectionMetrics', async () => {
    const result = await ddb.send(
      new PutItemCommand({
        TableName: compositeIndexedTableDef.name,
        Item: {
          pk: { S: 'icm-put-1' },
          sk: { S: 'a' },
          lsi1sk: { S: 'lval' },
          data: { S: 'hello' },
        },
        ReturnItemCollectionMetrics: 'SIZE',
      }),
    )

    expect(result.ItemCollectionMetrics).toBeDefined()
    expect(result.ItemCollectionMetrics!.ItemCollectionKey).toBeDefined()
    expect(result.ItemCollectionMetrics!.ItemCollectionKey!.pk.S).toBe('icm-put-1')
    expect(result.ItemCollectionMetrics!.SizeEstimateRangeGB).toBeDefined()
    expect(result.ItemCollectionMetrics!.SizeEstimateRangeGB).toHaveLength(2)
  })

  it('DeleteItem with SIZE returns ItemCollectionMetrics', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: compositeIndexedTableDef.name,
        Item: {
          pk: { S: 'icm-del-1' },
          sk: { S: 'a' },
          lsi1sk: { S: 'lval' },
          data: { S: 'to-delete' },
        },
      }),
    )

    const result = await ddb.send(
      new DeleteItemCommand({
        TableName: compositeIndexedTableDef.name,
        Key: { pk: { S: 'icm-del-1' }, sk: { S: 'a' } },
        ReturnItemCollectionMetrics: 'SIZE',
      }),
    )

    expect(result.ItemCollectionMetrics).toBeDefined()
    expect(result.ItemCollectionMetrics!.ItemCollectionKey).toBeDefined()
    expect(result.ItemCollectionMetrics!.SizeEstimateRangeGB).toBeDefined()
    expect(result.ItemCollectionMetrics!.SizeEstimateRangeGB).toHaveLength(2)
  })

  it('UpdateItem with SIZE returns ItemCollectionMetrics', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: compositeIndexedTableDef.name,
        Item: {
          pk: { S: 'icm-upd-1' },
          sk: { S: 'a' },
          lsi1sk: { S: 'lval' },
          data: { S: 'original' },
        },
      }),
    )

    const result = await ddb.send(
      new UpdateItemCommand({
        TableName: compositeIndexedTableDef.name,
        Key: { pk: { S: 'icm-upd-1' }, sk: { S: 'a' } },
        UpdateExpression: 'SET #d = :v',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':v': { S: 'updated' } },
        ReturnItemCollectionMetrics: 'SIZE',
      }),
    )

    expect(result.ItemCollectionMetrics).toBeDefined()
    expect(result.ItemCollectionMetrics!.ItemCollectionKey).toBeDefined()
    expect(result.ItemCollectionMetrics!.SizeEstimateRangeGB).toBeDefined()
    expect(result.ItemCollectionMetrics!.SizeEstimateRangeGB).toHaveLength(2)
  })

  it('PutItem reports a small item collection as the range 0 to 1 GB', async () => {
    // SizeEstimateRangeGB is a range of whole gigabytes the collection falls
    // in, not a point estimate of its size: a one-item collection is [0, 1]
    // (eu-west-2 and us-east-1, 2026-10-09).
    const result = await ddb.send(
      new PutItemCommand({
        TableName: compositeIndexedTableDef.name,
        Item: {
          pk: { S: 'icm-range-1' },
          sk: { S: 'a' },
          lsi1sk: { S: 'lval' },
          data: { S: 'hello' },
        },
        ReturnItemCollectionMetrics: 'SIZE',
      }),
    )

    expect(result.ItemCollectionMetrics!.SizeEstimateRangeGB).toEqual([0, 1])
  })

  it('PutItem with NONE does not return ItemCollectionMetrics', async () => {
    const result = await ddb.send(
      new PutItemCommand({
        TableName: compositeIndexedTableDef.name,
        Item: {
          pk: { S: 'icm-none-1' },
          sk: { S: 'a' },
          lsi1sk: { S: 'lval' },
          data: { S: 'hello' },
        },
        ReturnItemCollectionMetrics: 'NONE',
      }),
    )

    expect(result.ItemCollectionMetrics).toBeUndefined()
  })
})
