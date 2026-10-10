import {
  UpdateItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  hashBTableDef,
  compositeTableDef,
  cleanupItems,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef, hashBTableDef, compositeTableDef)

const hashKeys = [
  { pk: { S: 'em-upd-key-mod' } },
  { pk: { S: 'em-upd-type-mismatch' } },
]

const compositeKeys = [
  { pk: { S: 'em-upd-range-mod' }, sk: { S: 'sk1' } },
]

afterAll(async () => {
  await cleanupItems(hashTableDef.name, hashKeys)
  await cleanupItems(compositeTableDef.name, compositeKeys)
})

describe('UpdateItem — exact error messages', { tags: ['update-item', 'data-plane', 'negative-path'] }, () => {
  it('cannot update hash key attribute', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-upd-key-mod' } },
          UpdateExpression: 'SET pk = :v',
          ExpressionAttributeValues: { ':v': { S: 'new-val' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: Cannot update attribute pk. This attribute is part of the key',
      )
    }
  })

  it('invalid UpdateExpression syntax', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-upd-key-mod' } },
          UpdateExpression: 'INVALID SYNTAX HERE',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      // Structural: pin the contractual constraint, float the "N validation
      // error detected:" envelope AWS adds in some regions and not others
      // (2026-06 four-region capture). See CONTRIBUTING, "error-messages".
      expect((err as DynamoDBServiceException).message).toContain(
        'Invalid UpdateExpression: Syntax error; token: "INVALID", near: "INVALID SYNTAX"',
      )
    }
  })

  it('unused ExpressionAttributeNames', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-upd-key-mod' } },
          UpdateExpression: 'SET attr1 = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          ExpressionAttributeNames: { '#unused': 'someattr' },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Value provided in ExpressionAttributeNames unused in expressions: keys: {#unused}',
      )
    }
  })

  it('unused ExpressionAttributeValues', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-upd-key-mod' } },
          UpdateExpression: 'SET attr1 = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' }, ':unused': { S: 'extra' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Value provided in ExpressionAttributeValues unused in expressions: keys: {:unused}',
      )
    }
  })

  it('missing ExpressionAttributeValues reference', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-upd-key-mod' } },
          UpdateExpression: 'SET attr1 = :v',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Invalid UpdateExpression: An expression attribute value used in expression is not defined; attribute value: :v',
      )
    }
  })

  it('undefined value in the ConditionExpression beside a defined one: full error string', async () => {
    // The UpdateExpression's own value is defined, so the condition is the
    // only problem. Enveloped, naming the expression and the value (eu-west-2
    // and us-east-1, 2026-10-09).
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-upd-key-mod' } },
          UpdateExpression: 'SET b = :w',
          ConditionExpression: 'a = :v',
          ExpressionAttributeValues: { ':w': { S: 'x' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        '1 validation error detected: Invalid ConditionExpression: An expression attribute value used in expression is not defined; attribute value: :v',
      )
    }
  })

  it('mixing UpdateExpression with AttributeUpdates', { tags: ['legacy'] }, async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-upd-key-mod' } },
          UpdateExpression: 'SET attr1 = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          AttributeUpdates: {
            attr1: { Value: { S: 'val' }, Action: 'PUT' },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Can not use both expression and non-expression parameters in the same request: Non-expression parameters: {AttributeUpdates} Expression parameters: {UpdateExpression}',
      )
    }
  })

  it('empty UpdateExpression', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-upd-key-mod' } },
          UpdateExpression: '',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Invalid UpdateExpression: The expression can not be empty;',
      )
    }
  })

  it('cannot update range key attribute on composite table', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: compositeTableDef.name,
          Key: { pk: { S: 'em-upd-range-mod' }, sk: { S: 'sk1' } },
          UpdateExpression: 'SET sk = :v',
          ExpressionAttributeValues: { ':v': { S: 'new-sk' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: Cannot update attribute sk. This attribute is part of the key',
      )
    }
  })

  it('empty-binary key value: full ValidationException message', async () => {
    // Real AWS rejects a zero-length binary key value with a top-level
    // ValidationException, the binary analogue of the empty-string key rejection.
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: hashBTableDef.name,
          Key: { pk: { B: new Uint8Array([]) } },
          UpdateExpression: 'SET attr1 = :v',
          ExpressionAttributeValues: { ':v': { S: 'x' } },
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
})
