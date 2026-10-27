import {
  CreateTableCommand,
  DescribeTableCommand,
  PutItemCommand,
  ExportTableToPointInTimeCommand,
  DescribeExportCommand,
  ListExportsCommand,
  ImportTableCommand,
  DescribeImportCommand,
  ListImportsCommand,
} from '@aws-sdk/client-dynamodb'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { ddb } from '../../../src/client.js'
import { s3 } from '../../../src/aws-aux.js'
import {
  uniqueTableName,
  waitUntilActive,
  deleteTable,
  enablePitr,
} from '../../../src/helpers.js'
import { isUnsupportedFault, withS3Bucket } from '../../../src/infra.js'
import { IndeterminateError } from '../../../src/indeterminate.js'

// Table export and import via S3. Both run asynchronously (minutes), so export
// asserts initiation; import waits for COMPLETED while the bucket is still alive
// so it can finish reading. The bucket is torn down by the harness; the import
// target table is waited out and deleted in teardown.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Export and import — S3', { tags: ['export-import', 'control-plane', 'cloud-only', 'slow'] }, () => {
  const source = uniqueTableName('exp_src')
  const importTargets: string[] = []
  let arn = ''
  let supported = true

  beforeAll(async () => {
    await ddb.send(
      new CreateTableCommand({
        TableName: source,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    )
    await waitUntilActive(source)
    await ddb.send(new PutItemCommand({ TableName: source, Item: { pk: { S: 'a' } } }))
    arn = (await ddb.send(new DescribeTableCommand({ TableName: source }))).Table!.TableArn!
    try {
      await ddb.send(new ListExportsCommand({ TableArn: arn }))
      await enablePitr(source)
    } catch (e) {
      if (isUnsupportedFault(e)) supported = false
      else throw e
    }
  }, 180_000)

  afterAll(async () => {
    for (const t of importTargets) {
      try {
        await waitUntilActive(t, 300_000)
      } catch {
        // best-effort
      }
      await deleteTable(t)
    }
    await deleteTable(source)
  }, 360_000)

  it('ExportTableToPointInTime initiates an export and reports it', async ({ skip }) => {
    if (!supported) return skip()
    await withS3Bucket(async (bucket) => {
      const exp = await ddb.send(
        new ExportTableToPointInTimeCommand({ TableArn: arn, S3Bucket: bucket }),
      )
      const exportArn = exp.ExportDescription?.ExportArn
      expect(exportArn).toBeTruthy()
      expect(exp.ExportDescription?.ExportStatus).toBe('IN_PROGRESS')

      const desc = await ddb.send(new DescribeExportCommand({ ExportArn: exportArn }))
      expect(desc.ExportDescription?.ExportArn).toBe(exportArn)

      const list = await ddb.send(new ListExportsCommand({ TableArn: arn }))
      expect((list.ExportSummaries ?? []).map((s) => s.ExportArn)).toContain(exportArn)
    })
  }, 240_000)

  it('ImportTable ingests S3 data into a new table', async ({ skip }) => {
    if (!supported) return skip()
    const target = uniqueTableName('imp_tgt')
    importTargets.push(target)
    await withS3Bucket(async (bucket) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: 'imp/data.json',
          Body: '{"Item":{"pk":{"S":"imported1"}}}\n',
        }),
      )
      const imp = await ddb.send(
        new ImportTableCommand({
          S3BucketSource: { S3Bucket: bucket, S3KeyPrefix: 'imp/' },
          InputFormat: 'DYNAMODB_JSON',
          InputCompressionType: 'NONE',
          TableCreationParameters: {
            TableName: target,
            AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            BillingMode: 'PAY_PER_REQUEST',
          },
        }),
      )
      const importArn = imp.ImportTableDescription?.ImportArn
      expect(importArn).toBeTruthy()
      expect(imp.ImportTableDescription?.ImportStatus).toBe('IN_PROGRESS')

      const list = await ddb.send(new ListImportsCommand({}))
      expect((list.ImportSummaryList ?? []).map((s) => s.ImportArn)).toContain(importArn)

      // Let the import finish reading S3 before the bucket is torn down.
      const start = Date.now()
      for (;;) {
        const d = await ddb.send(new DescribeImportCommand({ ImportArn: importArn }))
        const status = d.ImportTableDescription?.ImportStatus
        if (status && status !== 'IN_PROGRESS') {
          if (status !== 'COMPLETED') {
            throw new Error(
              `import ${status}: ${d.ImportTableDescription?.FailureCode} - ${d.ImportTableDescription?.FailureMessage}`,
            )
          }
          break
        }
        // Real imports have crept from under two minutes to past four, so the
        // ceiling leaves room. Running out of it is a failed observation, not
        // an answer, so it never scores as a divergence.
        if (Date.now() - start > 600_000) {
          throw new IndeterminateError('import-timeout', `import ${importArn} was still IN_PROGRESS after 600s`)
        }
        await sleep(5000)
      }
    })
  }, 690_000)
})
