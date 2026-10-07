import {
  BatchWriteItemCommand,
  DynamoDBServiceException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { observeSplit } from '../../../src/observation-sink.js'
import {
  hashTableDef,
  hashBTableDef,
  cleanupItems,
  declareTables,
  absentTableName
} from '../../../src/helpers.js'

declareTables(hashTableDef, hashBTableDef)

const keysToCleanup = [
  { pk: { S: 'em-bw-dup' } },
]

afterAll(async () => {
  await cleanupItems(hashTableDef.name, keysToCleanup)
})

describe('BatchWriteItem — exact error messages', { tags: ['batch', 'data-plane', 'negative-path'] }, () => {
  it('empty RequestItems: full required-parameter error', async (ctx) => {
    // Split behaviour (registry row batch-write-item-empty-request-items-message):
    // the answer differs by region, so what the target actually returned is
    // recorded for per-region scoring. The validation-framework rollout has not
    // settled for this operation. eu-west-2, the pinned region, moved to the
    // framework's generic constraint message on the 2026-09-05 sweep, was back on
    // the bespoke sentence by 2026-09-12, and moved again on 2026-10-03, so
    // pinning either sentence fails the ground-truth run each time it moves.
    // The assertion accepts both exact messages and nothing else; the row
    // records which one each region gives.
    try {
      await observeSplit(ctx.task, () => ddb.send(new BatchWriteItemCommand({ RequestItems: {} })))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect([
        'The requestItems parameter is required for BatchWriteItem',
        "1 validation error detected: Value at 'RequestItems' failed to satisfy constraint: Member must have length greater than or equal to 1",
      ]).toContain((err as DynamoDBServiceException).message)
    }
  })

  it('> 25 requests: anchored regex on the constraint phrase', async () => {
    // AWS echoes the entire WriteRequest list into the validation message
    // in a Java-toString format that includes every AttributeValue field
    // (recently they added `workloadProfileName`). Pinning the echo verbatim
    // with .toBe() would couple this assertion to the SDK's serialisation,
    // which has changed before and will again. Anchored regex around the
    // structural envelope (`{<table>=[<dump>]}`) and the constraint phrase
    // at the end lets the dump vary without weakening what we actually
    // care about: that the right validation fires.
    //
    // The pattern now spans both validation cohorts. eu-north-1 crossed to the
    // framework's generic wording on 2026-08-22 and names the constraint
    // against the member path instead of echoing the request; the 25-item
    // limit is what fires either way, which is all this assertion claims. It
    // stays a pattern rather than a registry row because a row records one
    // verbatim answer per region, and neither cohort's message is constant:
    // the table name carries a per-run suffix and the old cohort embeds the
    // whole request. Nothing byte-exact exists here for a row to hold.
    const requests = Array.from({ length: 26 }, (_, i) => ({
      PutRequest: { Item: { pk: { S: `bw-${i}` } } },
    }))
    const escapedName = hashTableDef.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const echoedRequest =
      `Value '\\{${escapedName}=\\[.+\\]\\}' at 'requestItems' failed to satisfy constraint: ` +
      `Map value must satisfy constraint: \\[Member must have length less than or equal to 25, ` +
      `Member must have length greater than or equal to 1\\]`
    const namedMemberPath =
      `Value at 'RequestItems\\.${escapedName}\\.member' failed to satisfy constraint: ` +
      `Member must have length less than or equal to 25`
    const expectedPattern = new RegExp(
      `^1 validation error detected: (?:${echoedRequest}|${namedMemberPath})$`,
      's',
    )
    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: { [hashTableDef.name]: requests },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toMatch(expectedPattern)
    }
  })

  it('same key Put and Delete in one batch: full duplicate-keys error', async () => {
    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [hashTableDef.name]: [
              { PutRequest: { Item: { pk: { S: 'em-bw-dup' } } } },
              { DeleteRequest: { Key: { pk: { S: 'em-bw-dup' } } } },
            ],
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Provided list of item keys contains duplicates',
      )
    }
  })

  it('non-existent table: full ResourceNotFoundException message', async () => {
    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [absentTableName('does_not_exist_em_bw')]: [
              { PutRequest: { Item: { pk: { S: 'test' } } } },
            ],
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceNotFoundException)
      expect((err as ResourceNotFoundException).name).toBe(
        'ResourceNotFoundException',
      )
      expect((err as ResourceNotFoundException).message).toBe(
        'Requested resource not found',
      )
    }
  })

  // Invalid key value inside a PutRequest item. BatchWriteItem validates up front,
  // so every variant is a top-level ValidationException (no cancellation path).
  // Strings captured from real AWS, invariant across four regions (eu-west-2,
  // us-east-1, ap-southeast-2, eu-central-1; 2026-06-23) — so the table-key
  // schema-mismatch message is the contract, not a region-local wording.
  // The secondary-index-key variants live in indexKeyValues.test.ts, so this
  // file declares no indexed table.
  const expectExactValidation = async (
    command: BatchWriteItemCommand,
    message: string,
  ) => {
    try {
      await ddb.send(command)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(message)
    }
  }

  it('wrong-typed table key: full schema-mismatch message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: { [hashTableDef.name]: [{ PutRequest: { Item: { pk: { N: '5' } } } }] },
      }),
      'The provided key element does not match the schema',
    )
  })

  it('non-scalar table key: full schema-mismatch message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: { [hashTableDef.name]: [{ PutRequest: { Item: { pk: { L: [{ S: 'x' }] } } } }] },
      }),
      'The provided key element does not match the schema',
    )
  })

  it('empty-string table key: full empty-value message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: { [hashTableDef.name]: [{ PutRequest: { Item: { pk: { S: '' } } } }] },
      }),
      'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: pk',
    )
  })

  it('empty-binary put-request key: full empty-value message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: { [hashBTableDef.name]: [{ PutRequest: { Item: { pk: { B: new Uint8Array([]) } } } }] },
      }),
      'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty binary value. Key: pk',
    )
  })

  it('empty-binary delete-request key: full empty-value message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: { [hashBTableDef.name]: [{ DeleteRequest: { Key: { pk: { B: new Uint8Array([]) } } } }] },
      }),
      'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty binary value. Key: pk',
    )
  })
})
