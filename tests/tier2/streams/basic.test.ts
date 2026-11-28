import { ddb, ddbStreams } from '../../../src/client.js'
import {
  CreateTableCommand,
  DescribeTableCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb'
import {
  ListStreamsCommand,
  DescribeStreamCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
} from '@aws-sdk/client-dynamodb-streams'
import {
  uniqueTableName,
  waitUntilActive,
  deleteTable,
  expectDynamoError,
} from '../../../src/helpers.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { indeterminateFrom } from '../../../src/indeterminate.js'

async function getAllStreamRecords(streamArn: string, maxRetries = 30): Promise<any[]> {
  const allRecords: any[] = []
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const desc = await ddbStreams.send(new DescribeStreamCommand({ StreamArn: streamArn }))
    const shards = desc.StreamDescription!.Shards ?? []
    for (const shard of shards) {
      const iterRes = await ddbStreams.send(new GetShardIteratorCommand({
        StreamArn: streamArn,
        ShardId: shard.ShardId!,
        ShardIteratorType: 'TRIM_HORIZON',
      }))
      let iterator = iterRes.ShardIterator
      while (iterator) {
        const res = await ddbStreams.send(new GetRecordsCommand({ ShardIterator: iterator }))
        if (res.Records && res.Records.length > 0) {
          allRecords.push(...res.Records)
        }
        // Only continue if there are more records to read in this shard
        if (!res.Records || res.Records.length === 0) break
        iterator = res.NextShardIterator
      }
    }
    if (allRecords.length > 0) return allRecords
    await new Promise(r => setTimeout(r, 1000))
  }
  return allRecords
}

async function waitForStreamEnabled(streamArn: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await ddbStreams.send(new DescribeStreamCommand({ StreamArn: streamArn }))
    if (res.StreamDescription!.StreamStatus === 'ENABLED') return
    await new Promise(r => setTimeout(r, 1000))
  }
}

describe('DynamoDB Streams — basic', { tags: ['streams', 'control-plane'] }, () => {
  let supported = true
  let streamTableName: string
  let streamArn: string

  beforeAll(async () => {
    // Long enough that the whole name is over 48 characters under either
    // prefix, so a ShardId built from the table name would pass the 65
    // characters the API model allows.
    streamTableName = uniqueTableName('stream_shard_id_length')
    try {
      await ddb.send(new CreateTableCommand({
        TableName: streamTableName,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: {
          StreamEnabled: true,
          StreamViewType: 'NEW_AND_OLD_IMAGES',
        },
      }))
      await waitUntilActive(streamTableName)
      const desc = await ddb.send(new DescribeTableCommand({ TableName: streamTableName }))
      streamArn = desc.Table!.LatestStreamArn!
      await waitForStreamEnabled(streamArn)
    } catch (e: unknown) {
      // Use the suite's shared "not implemented" classifier so streams follows
      // the same skip rule as every other feature: only an unsupported fault
      // (UnknownOperationException / a "not implemented" message / HTTP 501)
      // skips. A bare ValidationException is a real answer - the target
      // rejecting a request real DynamoDB accepts - and must score as a fail,
      // not vanish as a skip. dynalite, the only streams-less target, drops the
      // StreamSpecification and answers DescribeStream with
      // UnknownOperationException, so it still skips correctly.
      if (isUnsupportedFault(e)) {
        supported = false
      } else {
        throw e
      }
    }
  }, 120_000)

  afterAll(async () => {
    if (streamTableName) await deleteTable(streamTableName).catch(() => {})
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  // ── Table setup ──────────────────────────────────────────────────────

  it('table with StreamSpecification has LatestStreamArn in DescribeTable', async () => {
    const desc = await ddb.send(new DescribeTableCommand({ TableName: streamTableName }))
    expect(desc.Table!.LatestStreamArn).toBeDefined()
    expect(typeof desc.Table!.LatestStreamArn).toBe('string')
    expect(desc.Table!.LatestStreamArn!.length).toBeGreaterThan(0)
  })

  it('table StreamSpecification.StreamEnabled is true', async () => {
    const desc = await ddb.send(new DescribeTableCommand({ TableName: streamTableName }))
    expect(desc.Table!.StreamSpecification).toBeDefined()
    expect(desc.Table!.StreamSpecification!.StreamEnabled).toBe(true)
  })

  it('table StreamSpecification.StreamViewType matches what was requested', async () => {
    const desc = await ddb.send(new DescribeTableCommand({ TableName: streamTableName }))
    expect(desc.Table!.StreamSpecification!.StreamViewType).toBe('NEW_AND_OLD_IMAGES')
  })

  // ── ListStreams ──────────────────────────────────────────────────────

  it('ListStreams returns the stream for our table', async () => {
    const res = await ddbStreams.send(new ListStreamsCommand({}))
    expect(res.Streams).toBeDefined()
    const match = res.Streams!.find(s => s.StreamArn === streamArn)
    expect(match).toBeDefined()
  })

  it('ListStreams with TableName filter returns only our table\'s stream', async () => {
    const res = await ddbStreams.send(new ListStreamsCommand({ TableName: streamTableName }))
    expect(res.Streams).toBeDefined()
    expect(res.Streams!.length).toBeGreaterThanOrEqual(1)
    for (const stream of res.Streams!) {
      expect(stream.TableName).toBe(streamTableName)
    }
  })

  // ── DescribeStream ──────────────────────────────────────────────────

  it('DescribeStream returns stream status ENABLED or ENABLING', async () => {
    const res = await ddbStreams.send(new DescribeStreamCommand({ StreamArn: streamArn }))
    expect(res.StreamDescription).toBeDefined()
    expect(['ENABLED', 'ENABLING']).toContain(res.StreamDescription!.StreamStatus)
  })

  it('DescribeStream returns at least one shard', async () => {
    const res = await ddbStreams.send(new DescribeStreamCommand({ StreamArn: streamArn }))
    expect(res.StreamDescription!.Shards).toBeDefined()
    expect(res.StreamDescription!.Shards!.length).toBeGreaterThanOrEqual(1)
  })

  it('each shard has a ShardId', async () => {
    // The model bounds ShardId to 28-65 characters, and boto3 and the PHP SDK
    // refuse a GetShardIterator request outside that before sending it. The
    // shape inside the bounds is undocumented, so only the length is pinned.
    expect(streamTableName.length).toBeGreaterThan(48)
    const res = await ddbStreams.send(new DescribeStreamCommand({ StreamArn: streamArn }))
    for (const shard of res.StreamDescription!.Shards!) {
      expect(typeof shard.ShardId).toBe('string')
      expect(shard.ShardId!.length).toBeGreaterThanOrEqual(28)
      expect(shard.ShardId!.length).toBeLessThanOrEqual(65)
    }
  })

  // ── GetShardIterator ────────────────────────────────────────────────

  it('TRIM_HORIZON returns a valid iterator string', async () => {
    const desc = await ddbStreams.send(new DescribeStreamCommand({ StreamArn: streamArn }))
    const shardId = desc.StreamDescription!.Shards![0].ShardId!
    const res = await ddbStreams.send(new GetShardIteratorCommand({
      StreamArn: streamArn,
      ShardId: shardId,
      ShardIteratorType: 'TRIM_HORIZON',
    }))
    expect(res.ShardIterator).toBeDefined()
    expect(typeof res.ShardIterator).toBe('string')
    expect(res.ShardIterator!.length).toBeGreaterThan(0)
  })

  it('LATEST returns a valid iterator string', async () => {
    const desc = await ddbStreams.send(new DescribeStreamCommand({ StreamArn: streamArn }))
    const shardId = desc.StreamDescription!.Shards![0].ShardId!
    const res = await ddbStreams.send(new GetShardIteratorCommand({
      StreamArn: streamArn,
      ShardId: shardId,
      ShardIteratorType: 'LATEST',
    }))
    expect(res.ShardIterator).toBeDefined()
    expect(typeof res.ShardIterator).toBe('string')
    expect(res.ShardIterator!.length).toBeGreaterThan(0)
  })

  // ── GetRecords after writes ─────────────────────────────────────────

  it('GetRecords after PutItem contains the new image (INSERT event)', async () => {
    await ddb.send(new PutItemCommand({
      TableName: streamTableName,
      Item: { pk: { S: 'stream-put-1' }, data: { S: 'hello' } },
    }))

    const records = await getAllStreamRecords(streamArn)

    const insertRecord = records.find(
      r => r.eventName === 'INSERT' && r.dynamodb?.Keys?.pk?.S === 'stream-put-1',
    )
    expect(insertRecord).toBeDefined()
    expect(insertRecord.dynamodb.NewImage).toBeDefined()
    expect(insertRecord.dynamodb.NewImage.data.S).toBe('hello')
  }, 60_000)

  it('INSERT record has eventName INSERT', async () => {
    await ddb.send(new PutItemCommand({
      TableName: streamTableName,
      Item: { pk: { S: 'stream-put-2' }, data: { S: 'event-name-test' } },
    }))

    const records = await getAllStreamRecords(streamArn)

    const insertRecord = records.find(
      r => r.dynamodb?.Keys?.pk?.S === 'stream-put-2',
    )
    expect(insertRecord).toBeDefined()
    expect(insertRecord.eventName).toBe('INSERT')
  }, 60_000)

  it('INSERT record dynamodb.Keys contains the item key', async () => {
    await ddb.send(new PutItemCommand({
      TableName: streamTableName,
      Item: { pk: { S: 'stream-put-3' }, data: { S: 'keys-test' } },
    }))

    const records = await getAllStreamRecords(streamArn)

    const insertRecord = records.find(
      r => r.eventName === 'INSERT' && r.dynamodb?.Keys?.pk?.S === 'stream-put-3',
    )
    expect(insertRecord).toBeDefined()
    expect(insertRecord.dynamodb.Keys).toBeDefined()
    expect(insertRecord.dynamodb.Keys.pk).toEqual({ S: 'stream-put-3' })
  }, 60_000)

  it('INSERT record dynamodb.NewImage contains the full item', async () => {
    await ddb.send(new PutItemCommand({
      TableName: streamTableName,
      Item: { pk: { S: 'stream-put-4' }, data: { S: 'full-image' }, num: { N: '42' } },
    }))

    const records = await getAllStreamRecords(streamArn)

    const insertRecord = records.find(
      r => r.eventName === 'INSERT' && r.dynamodb?.Keys?.pk?.S === 'stream-put-4',
    )
    expect(insertRecord).toBeDefined()
    expect(insertRecord.dynamodb.NewImage.pk.S).toBe('stream-put-4')
    expect(insertRecord.dynamodb.NewImage.data.S).toBe('full-image')
    expect(insertRecord.dynamodb.NewImage.num.N).toBe('42')
  }, 60_000)

  it('GetRecords after UpdateItem contains both old and new images (MODIFY event)', async () => {
    // Insert first
    await ddb.send(new PutItemCommand({
      TableName: streamTableName,
      Item: { pk: { S: 'stream-update-1' }, data: { S: 'before' } },
    }))

    // Update
    await ddb.send(new UpdateItemCommand({
      TableName: streamTableName,
      Key: { pk: { S: 'stream-update-1' } },
      UpdateExpression: 'SET #d = :v',
      ExpressionAttributeNames: { '#d': 'data' },
      ExpressionAttributeValues: { ':v': { S: 'after' } },
    }))

    const records = await getAllStreamRecords(streamArn)

    const modifyRecord = records.find(
      r => r.eventName === 'MODIFY' && r.dynamodb?.Keys?.pk?.S === 'stream-update-1',
    )
    expect(modifyRecord).toBeDefined()
    expect(modifyRecord.dynamodb.OldImage).toBeDefined()
    expect(modifyRecord.dynamodb.OldImage.data.S).toBe('before')
    expect(modifyRecord.dynamodb.NewImage).toBeDefined()
    expect(modifyRecord.dynamodb.NewImage.data.S).toBe('after')
  }, 60_000)

  it('GetRecords after DeleteItem contains old image (REMOVE event)', async () => {
    // Insert first
    await ddb.send(new PutItemCommand({
      TableName: streamTableName,
      Item: { pk: { S: 'stream-delete-1' }, data: { S: 'to-delete' } },
    }))

    // Delete
    await ddb.send(new DeleteItemCommand({
      TableName: streamTableName,
      Key: { pk: { S: 'stream-delete-1' } },
    }))

    const records = await getAllStreamRecords(streamArn)

    const removeRecord = records.find(
      r => r.eventName === 'REMOVE' && r.dynamodb?.Keys?.pk?.S === 'stream-delete-1',
    )
    expect(removeRecord).toBeDefined()
    expect(removeRecord.dynamodb.OldImage).toBeDefined()
    expect(removeRecord.dynamodb.OldImage.data.S).toBe('to-delete')
  }, 60_000)

  // ── Stream view types ───────────────────────────────────────────────

  // Both answers captured from eu-west-2 on 26 November 2026. Kept after every
  // test that reads streamArn, since a target that accepts the UpdateTable may
  // start a new stream on the table.
  it('GetShardIterator refuses a ShardId the stream does not have', async () => {
    // Caught by hand: the Streams client's errors aren't DynamoDBServiceException,
    // which expectDynamoError requires.
    let thrown: any
    try {
      await ddbStreams.send(new GetShardIteratorCommand({
        StreamArn: streamArn,
        ShardId: 'shardId-00000000000000000000-00000000',
        ShardIteratorType: 'TRIM_HORIZON',
      }))
    } catch (e) {
      thrown = e
    }
    if (thrown?.name !== 'ResourceNotFoundException' && indeterminateFrom(thrown)) throw thrown
    expect(thrown?.name).toBe('ResourceNotFoundException')
    expect(thrown?.message).toBe('Requested resource not found: Shard does not exist')
  })

  it('UpdateTable refuses to enable a stream that is already enabled', async () => {
    for (const viewType of ['NEW_AND_OLD_IMAGES', 'KEYS_ONLY'] as const) {
      await expectDynamoError(
        () => ddb.send(new UpdateTableCommand({
          TableName: streamTableName,
          StreamSpecification: { StreamEnabled: true, StreamViewType: viewType },
        })),
        'ValidationException',
        `Table already has an enabled stream: TableName: ${streamTableName}`,
      )
    }
    const desc = await ddb.send(new DescribeTableCommand({ TableName: streamTableName }))
    expect(desc.Table!.LatestStreamArn).toBe(streamArn)
  })

  describe('NEW_IMAGE view type', () => {
    let newImageTableName: string
    let newImageStreamArn: string
    let viewTypeSupported = true

    beforeAll(async () => {
      if (!supported) return
      newImageTableName = uniqueTableName('streams-new-img')
      try {
        await ddb.send(new CreateTableCommand({
          TableName: newImageTableName,
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
          StreamSpecification: {
            StreamEnabled: true,
            StreamViewType: 'NEW_IMAGE',
          },
        }))
        await waitUntilActive(newImageTableName)
        const desc = await ddb.send(new DescribeTableCommand({ TableName: newImageTableName }))
        newImageStreamArn = desc.Table!.LatestStreamArn!
        await waitForStreamEnabled(newImageStreamArn)
      } catch (e: unknown) {
        if (isUnsupportedFault(e)) {
          viewTypeSupported = false
        } else {
          throw e
        }
      }
    }, 120_000)

    afterAll(async () => {
      if (newImageTableName) await deleteTable(newImageTableName).catch(() => {})
    })

    beforeEach(({ skip }) => { if (!supported || !viewTypeSupported) skip() })

    it('records have NewImage but no OldImage on MODIFY', async () => {
      await ddb.send(new PutItemCommand({
        TableName: newImageTableName,
        Item: { pk: { S: 'ni-1' }, data: { S: 'original' } },
      }))

      await ddb.send(new UpdateItemCommand({
        TableName: newImageTableName,
        Key: { pk: { S: 'ni-1' } },
        UpdateExpression: 'SET #d = :v',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':v': { S: 'updated' } },
      }))

      const records = await getAllStreamRecords(newImageStreamArn)

      const modifyRecord = records.find(
        r => r.eventName === 'MODIFY' && r.dynamodb?.Keys?.pk?.S === 'ni-1',
      )
      expect(modifyRecord).toBeDefined()
      expect(modifyRecord.dynamodb.NewImage).toBeDefined()
      expect(modifyRecord.dynamodb.NewImage.data.S).toBe('updated')
      expect(modifyRecord.dynamodb.OldImage).toBeUndefined()
    }, 60_000)
  })

  describe('KEYS_ONLY view type', () => {
    let keysOnlyTableName: string
    let keysOnlyStreamArn: string
    let viewTypeSupported = true

    beforeAll(async () => {
      if (!supported) return
      keysOnlyTableName = uniqueTableName('streams-keys')
      try {
        await ddb.send(new CreateTableCommand({
          TableName: keysOnlyTableName,
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
          StreamSpecification: {
            StreamEnabled: true,
            StreamViewType: 'KEYS_ONLY',
          },
        }))
        await waitUntilActive(keysOnlyTableName)
        const desc = await ddb.send(new DescribeTableCommand({ TableName: keysOnlyTableName }))
        keysOnlyStreamArn = desc.Table!.LatestStreamArn!
        await waitForStreamEnabled(keysOnlyStreamArn)
      } catch (e: unknown) {
        if (isUnsupportedFault(e)) {
          viewTypeSupported = false
        } else {
          throw e
        }
      }
    }, 120_000)

    afterAll(async () => {
      if (keysOnlyTableName) await deleteTable(keysOnlyTableName).catch(() => {})
    })

    beforeEach(({ skip }) => { if (!supported || !viewTypeSupported) skip() })

    it('records have Keys but no NewImage or OldImage', async () => {
      await ddb.send(new PutItemCommand({
        TableName: keysOnlyTableName,
        Item: { pk: { S: 'ko-1' }, data: { S: 'secret' } },
      }))

      await ddb.send(new UpdateItemCommand({
        TableName: keysOnlyTableName,
        Key: { pk: { S: 'ko-1' } },
        UpdateExpression: 'SET #d = :v',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':v': { S: 'still-secret' } },
      }))

      const records = await getAllStreamRecords(keysOnlyStreamArn)

      expect(records.length).toBeGreaterThanOrEqual(1)
      for (const record of records) {
        expect(record.dynamodb.Keys).toBeDefined()
        expect(record.dynamodb.Keys.pk).toBeDefined()
        expect(record.dynamodb.NewImage).toBeUndefined()
        expect(record.dynamodb.OldImage).toBeUndefined()
      }
    }, 60_000)
  })
})
