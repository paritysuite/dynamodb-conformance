import {
  TransactGetItemsCommand,
  DynamoDBServiceException,
  ResourceNotFoundException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, hashTableDef, absentTableName } from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('TransactGetItems — exact error messages', { tags: ['transactions', 'data-plane', 'negative-path'] }, () => {
  it('empty TransactItems: full minimum-length error', async () => {
    // The validation-framework rollout is reaching this operation. eu-north-1
    // moved to the framework's generic constraint message by the 2026-10-03
    // sweep, and ap-northeast-2 has given both. So has eu-west-2: the request
    // echo to a separate client on 2026-10-08 and the generic message to the
    // ground-truth run on main the same day. Pinning either message fails
    // that run whenever it lands on the other, so the assertion accepts both
    // exact messages and nothing else. There is no registry row while
    // eu-west-2 gives both, because a row holds one answer per region.
    try {
      await ddb.send(new TransactGetItemsCommand({ TransactItems: [] }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect([
        "1 validation error detected: Value '[]' at 'transactItems' failed to satisfy constraint: Member must have length greater than or equal to 1",
        "1 validation error detected: Value at 'TransactItems' failed to satisfy constraint: Member must have length greater than or equal to 1",
      ]).toContain((err as DynamoDBServiceException).message)
    }
  })

  it('> 100 gets: anchored regex on the constraint phrase', async () => {
    // Same Java-toString dump shape as TransactWriteItems / BatchWriteItem;
    // anchor around the dump rather than pinning it verbatim.
    const items = Array.from({ length: 101 }, (_, i) => ({
      Get: {
        TableName: hashTableDef.name,
        Key: { pk: { S: `tgi-${i}` } },
      },
    }))
    // The pattern spans both validation cohorts. eu-north-1 moved to the
    // framework's generic wording by the 2026-10-03 sweep and names the
    // constraint against the member instead of echoing the request; the
    // 100-item limit is what fires either way, which is all this
    // assertion claims. It stays a pattern rather than a registry row because
    // the old cohort's message embeds the whole request, per-run table name
    // included, so there is no byte-exact answer for a row to hold.
    const echoedRequest = `Value '\\[.+\\]' at 'transactItems'`
    const namedMember = `Value at 'TransactItems'`
    const expectedPattern = new RegExp(
      `^1 validation error detected: (?:${echoedRequest}|${namedMember}) failed to satisfy constraint: ` +
        `Member must have length less than or equal to 100$`,
      's',
    )
    try {
      await ddb.send(new TransactGetItemsCommand({ TransactItems: items }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toMatch(expectedPattern)
    }
  })

  it('non-existent table: full ResourceNotFoundException message', async () => {
    try {
      await ddb.send(
        new TransactGetItemsCommand({
          TransactItems: [
            {
              Get: {
                TableName: absentTableName('does_not_exist_em_tgi'),
                Key: { pk: { S: 'x' } },
              },
            },
          ],
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

  it('invalid ProjectionExpression syntax: full parser error', async () => {
    // Request-level ValidationException — the parser rejects the expression
    // before any per-action processing runs.
    try {
      await ddb.send(
        new TransactGetItemsCommand({
          TransactItems: [
            {
              Get: {
                TableName: hashTableDef.name,
                Key: { pk: { S: 'tgi-pe' } },
                ProjectionExpression: '!!!',
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Syntax error; token: "!", near: "!!"',
      )
    }
  })

  it('missing key attribute: action-level ValidationError surfaces as TransactionCanceledException', async () => {
    // Per-action validation (here: an empty Key) is reported through the
    // cancellation channel rather than as a request-level ValidationException.
    // The reason code is 'ValidationError', not 'ConditionalCheckFailed'.
    try {
      await ddb.send(
        new TransactGetItemsCommand({
          TransactItems: [
            {
              Get: {
                TableName: hashTableDef.name,
                Key: {},
              },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionCanceledException)
      const txErr = err as TransactionCanceledException
      const expectedReasons = ['ValidationError'] as const
      expect(txErr.message).toBe(
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${expectedReasons.join(', ')}]`,
      )
      expect(txErr.CancellationReasons?.map((r) => r.Code)).toEqual([
        ...expectedReasons,
      ])
    }
  })

  it('malformed table name: top-level ValidationException naming the member', async () => {
    // A request-level constraint, not a cancellation reason: the message names
    // the action's position. Captured in us-east-1 and eu-west-2, 2026-10-09.
    try {
      await ddb.send(
        new TransactGetItemsCommand({
          TransactItems: [{ Get: { TableName: 'bad!name', Key: { pk: { S: 'a' } } } }],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect(err).not.toBeInstanceOf(TransactionCanceledException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value 'bad!name' at 'transactItems.1.member.get.tableName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+",
      )
    }
  })

  it('malformed table name on the second Get: the message names its position', async () => {
    try {
      await ddb.send(
        new TransactGetItemsCommand({
          TransactItems: [
            { Get: { TableName: hashTableDef.name, Key: { pk: { S: 'a' } } } },
            { Get: { TableName: 'bad!name', Key: { pk: { S: 'a' } } } },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value 'bad!name' at 'transactItems.2.member.get.tableName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+",
      )
    }
  })
})
