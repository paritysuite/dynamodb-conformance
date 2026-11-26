// Capture of the shard IDs DynamoDB Streams hands out, and of what UpdateTable
// does when asked to enable a stream that is already enabled.
//
// Per region, it creates one table with a stream, under a name long enough that
// an emulator deriving its ShardId from the table name would pass the 65
// characters the API model allows, and records:
//
//   - DescribeStream's ShardIds, their lengths and the stream label;
//   - UpdateTable with StreamEnabled=true on the enabled stream, once with the
//     same StreamViewType and once with a different one (the error, or the
//     response and whether the stream ARN moved);
//   - the stream after disabling and re-enabling it: the new ARN and label, the
//     new ShardIds, and DescribeStream on the old ARN.
//
// Output is one JSON document on stdout, with account IDs in ARNs replaced by
// 000000000000. The table is deleted by exact name at the end of each region.
//
//   AWS_PROFILE=conformance-test node scripts/capture-stream-shard-ids.mjs \
//     --table-prefix=_capture_20261126_shardid > capture.json
//   AWS_PROFILE=conformance-test node scripts/capture-stream-shard-ids.mjs eu-west-2 us-east-1 \
//     --table-prefix=_capture_20261126_shardid > capture.json
//
// The default region is eu-west-2. --table-prefix follows the rule in
// capture-validation-messages.mjs: _conformance_ (the CI role's namespace) or
// _capture_ (a maintainer's), since nothing else is ever swept up.

import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb'
import { DynamoDBStreamsClient, DescribeStreamCommand } from '@aws-sdk/client-dynamodb-streams'
import { resolveTablePrefix } from './capture-validation-messages.mjs'

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const positional = args.filter((a) => !a.startsWith('--'))
const regions = positional.length ? positional : ['eu-west-2']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The SDK error fields worth keeping: the type and DynamoDB's own message. */
function failure(e) {
  return { ok: false, name: e?.name ?? null, message: e?.message ?? null }
}

export function redactAccountIds(value) {
  return JSON.parse(
    JSON.stringify(value).replace(/(arn:aws[a-z-]*:[a-z0-9-]+:[^:]*:)\d{12}(:)/g, '$1000000000000$2'),
  )
}

function shardSummary(description) {
  return (description?.Shards ?? []).map((s) => ({
    ShardId: s.ShardId,
    length: s.ShardId?.length ?? null,
    ParentShardId: s.ParentShardId ?? null,
    SequenceNumberRange: s.SequenceNumberRange ?? null,
  }))
}

async function waitActive(ddb, name) {
  const start = Date.now()
  for (;;) {
    const res = await ddb.send(new DescribeTableCommand({ TableName: name }))
    if (res.Table?.TableStatus === 'ACTIVE') return res.Table
    if (Date.now() - start > 180_000) throw new Error(`timeout waiting ACTIVE: ${name}`)
    await sleep(2000)
  }
}

async function waitStream(streams, arn, wanted) {
  const start = Date.now()
  for (;;) {
    const res = await streams.send(new DescribeStreamCommand({ StreamArn: arn }))
    const d = res.StreamDescription
    if (d?.StreamStatus === wanted && (wanted !== 'ENABLED' || (d.Shards ?? []).length > 0)) return d
    if (Date.now() - start > 180_000) throw new Error(`timeout waiting ${wanted}: ${arn}`)
    await sleep(2000)
  }
}

async function describeStream(streams, arn) {
  try {
    const d = (await streams.send(new DescribeStreamCommand({ StreamArn: arn }))).StreamDescription
    return {
      ok: true,
      StreamArn: d?.StreamArn,
      StreamLabel: d?.StreamLabel,
      StreamStatus: d?.StreamStatus,
      StreamViewType: d?.StreamViewType,
      shards: shardSummary(d),
    }
  } catch (e) {
    return failure(e)
  }
}

async function updateStream(ddb, name, spec) {
  const request = { TableName: name, StreamSpecification: spec }
  try {
    const res = await ddb.send(new UpdateTableCommand(request))
    return {
      request,
      ok: true,
      StreamSpecification: res.TableDescription?.StreamSpecification ?? null,
      LatestStreamArn: res.TableDescription?.LatestStreamArn ?? null,
      LatestStreamLabel: res.TableDescription?.LatestStreamLabel ?? null,
    }
  } catch (e) {
    return { request, ...failure(e) }
  }
}

async function captureRegion(region, tablePrefix) {
  const ddb = new DynamoDBClient({ region })
  const streams = new DynamoDBStreamsClient({ region })
  const name = `${tablePrefix}_stream_shard_id_length_${Date.now()}`
  const out = { region, tableName: name, tableNameLength: name.length }

  await ddb.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
    }),
  )
  try {
    const table = await waitActive(ddb, name)
    const firstArn = table.LatestStreamArn
    await waitStream(streams, firstArn, 'ENABLED')
    out.created = {
      LatestStreamArn: firstArn,
      LatestStreamLabel: table.LatestStreamLabel,
      describeStream: await describeStream(streams, firstArn),
      describeStreamAgain: await describeStream(streams, firstArn),
    }

    out.enableWhileEnabled = {}
    for (const viewType of ['NEW_AND_OLD_IMAGES', 'KEYS_ONLY']) {
      const update = await updateStream(ddb, name, { StreamEnabled: true, StreamViewType: viewType })
      const after = await waitActive(ddb, name)
      out.enableWhileEnabled[viewType] = {
        ...update,
        afterward: {
          LatestStreamArn: after.LatestStreamArn,
          streamArnUnchanged: after.LatestStreamArn === firstArn,
          StreamSpecification: after.StreamSpecification ?? null,
        },
      }
    }

    out.disable = await updateStream(ddb, name, { StreamEnabled: false })
    await waitActive(ddb, name)
    await waitStream(streams, firstArn, 'DISABLED').catch(() => {})
    out.reenable = await updateStream(ddb, name, {
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    })
    const reenabled = await waitActive(ddb, name)
    const secondArn = reenabled.LatestStreamArn
    if (secondArn) await waitStream(streams, secondArn, 'ENABLED')
    out.afterReenable = {
      LatestStreamArn: secondArn ?? null,
      LatestStreamLabel: reenabled.LatestStreamLabel ?? null,
      streamArnChanged: secondArn !== firstArn,
      describeNewStream: secondArn ? await describeStream(streams, secondArn) : null,
      describeOldStream: await describeStream(streams, firstArn),
    }
  } finally {
    await ddb.send(new DeleteTableCommand({ TableName: name })).catch((e) => {
      process.stderr.write(`  could not delete ${name}: ${e?.name} ${e?.message}\n`)
    })
  }
  return out
}

async function main() {
  const tablePrefix = resolveTablePrefix(flags)
  const out = { capturedAt: new Date().toISOString(), kind: 'stream-shard-ids', regions: {} }
  for (const region of regions) {
    process.stderr.write(`capturing ${region}...\n`)
    try {
      out.regions[region] = await captureRegion(region, tablePrefix)
    } catch (e) {
      process.stderr.write(`  ${region} did not answer: ${e?.name} ${e?.message}\n`)
      out.regions[region] = { region, unanswered: failure(e) }
    }
  }
  process.stdout.write(JSON.stringify(redactAccountIds(out), null, 2) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('CAPTURE FAILED:', e?.name, e?.message)
    process.exit(1)
  })
}
