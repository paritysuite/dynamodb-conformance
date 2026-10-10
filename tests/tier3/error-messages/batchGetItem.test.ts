import {
  BatchGetItemCommand,
  DynamoDBServiceException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { observeSplit } from '../../../src/observation-sink.js'
import { declareTables, hashTableDef, hashBTableDef, compositeTableDef, absentTableName } from '../../../src/helpers.js'

declareTables(hashTableDef, hashBTableDef, compositeTableDef)

describe('BatchGetItem — exact error messages', { tags: ['batch', 'data-plane', 'negative-path'] }, () => {
  it('empty RequestItems: full required-parameter error', async (ctx) => {
    // Split behaviour (registry row batch-get-item-empty-request-items-message):
    // the answer differs by region, so what the target actually returned is
    // recorded for per-region scoring. eu-west-2 is pinned, and it moved to the
    // validation framework's generic constraint message between the 2026-08-08
    // and 2026-08-15 sweeps. The rest have followed it since: as of the
    // 2026-09-02 sweep only me-central-1 still answers the bespoke sentence
    // `The requestItems parameter is required for BatchGetItem`.
    try {
      await observeSplit(ctx.task, () => ddb.send(new BatchGetItemCommand({ RequestItems: {} })))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value at 'RequestItems' failed to satisfy constraint: Member must have length greater than or equal to 1",
      )
    }
  })

  it('> 100 keys across all tables: interpolated full error', async () => {
    // Only variable part is the table name (we own it via uniqueTableName),
    // so we keep the exact-match rung and interpolate.
    const keys = Array.from({ length: 101 }, (_, i) => ({ pk: { S: `bg-${i}` } }))
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: { [hashTableDef.name]: { Keys: keys } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        `1 validation error detected: Value at 'RequestItems.${hashTableDef.name}.member.Keys' failed to satisfy constraint: Member must have length less than or equal to 100`,
      )
    }
  })

  it('non-existent table: full ResourceNotFoundException message', async () => {
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [absentTableName('does_not_exist_em_bg')]: {
              Keys: [{ pk: { S: 'test' } }],
            },
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

  it('duplicate keys in one Keys array: full duplicate-keys error', async () => {
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [hashTableDef.name]: {
              Keys: [
                { pk: { S: 'em-bg-dup' } },
                { pk: { S: 'em-bg-dup' } },
              ],
            },
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

  // A KeysAndAttributes block accepts both the legacy AttributesToGet and a modern
  // ProjectionExpression; supplying both is the expression/non-expression conflict,
  // rejected before any read.
  it('AttributesToGet with ProjectionExpression in a KeysAndAttributes block: full conflict error', { tags: ['legacy'] }, async () => {
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [hashTableDef.name]: {
              Keys: [{ pk: { S: 'em-bg-mix' } }],
              AttributesToGet: ['pk'],
              ProjectionExpression: 'pk',
            },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Can not use both expression and non-expression parameters in the same request: Non-expression parameters: {AttributesToGet} Expression parameters: {ProjectionExpression}',
      )
    }
  })

  it('empty-binary lookup key: full empty-value message', async () => {
    // Real AWS rejects a zero-length binary key value with a top-level
    // ValidationException, the binary analogue of the empty-string key rejection.
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [hashBTableDef.name]: { Keys: [{ pk: { B: new Uint8Array([]) } }] },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty binary value. Key: pk',
      )
    }
  })

  it('mixing ProjectionExpression on one table and AttributesToGet on another is rejected', { tags: ['legacy'] }, async () => {
    // Each table's block is internally consistent, but real AWS rejects the
    // request as a whole for mixing expression and non-expression projection
    // across tables.
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [hashTableDef.name]: { Keys: [{ pk: { S: 'bg-mix-a' } }], ProjectionExpression: 'pk' },
            [compositeTableDef.name]: {
              Keys: [{ pk: { S: 'bg-mix-b' }, sk: { S: 'z' } }],
              AttributesToGet: ['pk'],
            },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
    }
  })

  // Captured in us-east-1 and eu-west-2, 2026-10-09; both regions agree. A
  // malformed table name is a constraint on the RequestItems map's keys, and the
  // message echoes the map as JSON.
  it('malformed table name: full map-keys constraint message', async () => {
    try {
      await ddb.send(new BatchGetItemCommand({ RequestItems: { 'bad!name': { Keys: [{ pk: { S: 'a' } }] } } }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        `1 validation error detected: Value '{"bad!name":{"Keys":[{"pk":{"S":"a"}}]}}' at 'requestItems' failed to satisfy constraint: Map keys must satisfy constraint: [Member must have length less than or equal to 255, Member must have length greater than or equal to 3, Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+]`,
      )
    }
  })

  it('empty Keys list: full minimum-length message', async () => {
    try {
      await ddb.send(new BatchGetItemCommand({ RequestItems: { [hashTableDef.name]: { Keys: [] } } }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        `1 validation error detected: Value at 'RequestItems.${hashTableDef.name}.member.Keys' failed to satisfy constraint: Member must have length greater than or equal to 1`,
      )
    }
  })
})

describe('BatchGetItem — ProjectionExpression rejection messages', { tags: ['batch', 'data-plane', 'negative-path'] }, () => {
  // BatchGetItem carries its projection per table entry inside RequestItems,
  // but the projection rules and their messages match the other read
  // operations. None of the keys below resolves to a stored item, which is the
  // point: the rejections fire before any read.
  const batchGetWithProjection = (expr: string, names?: Record<string, string>) =>
    ddb.send(
      new BatchGetItemCommand({
        RequestItems: {
          [hashTableDef.name]: {
            Keys: [{ pk: { S: 'em-bg-proj' } }],
            ProjectionExpression: expr,
            ...(names ? { ExpressionAttributeNames: names } : {}),
          },
        },
      }),
    )

  it('duplicate paths (a, a) reject even when the key matches no item', async () => {
    try {
      await batchGetWithProjection('a, a')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })

  it('two distinct aliases resolving to one attribute (#a, #b -> a): rejected on the resolved names', async () => {
    try {
      await batchGetWithProjection('#a, #b', { '#a': 'a', '#b': 'a' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })

  it('overlapping parent and child paths (a, a.b): full overlap message', async () => {
    try {
      await batchGetWithProjection('a, a.b')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a, b]',
      )
    }
  })

  it('a bad projection on one table entry rejects the whole batch despite a clean entry on another', async () => {
    // Parity with the cross-table AttributesToGet/ProjectionExpression case
    // above: one invalid entry fails the entire request, with the same message
    // the single-entry rejection carries.
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [hashTableDef.name]: {
              Keys: [{ pk: { S: 'em-bg-proj-bad' } }],
              ProjectionExpression: 'a, a',
            },
            [compositeTableDef.name]: {
              Keys: [{ pk: { S: 'em-bg-proj-clean' }, sk: { S: 'z' } }],
              ProjectionExpression: 'a',
            },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })
})
