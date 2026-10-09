import {
  DeleteItemCommand,
  DynamoDBServiceException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, compositeTableDef, hashTableDef, hashBTableDef, absentTableName } from '../../../src/helpers.js'

declareTables(compositeTableDef, hashTableDef, hashBTableDef)

// Conditional-check failures for DeleteItem live in conditionalCheck.test.ts —
// that file owns the conditional-check error family across operations.

describe('DeleteItem — exact error messages', { tags: ['delete-item', 'data-plane', 'negative-path'] }, () => {
  it('non-existent table: full ResourceNotFoundException message', async () => {
    try {
      await ddb.send(
        new DeleteItemCommand({
          TableName: absentTableName('does_not_exist_em_delete'),
          Key: { pk: { S: 'test' } },
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

  it('malformed Key (missing range key on composite table): full schema-mismatch error', async () => {
    try {
      await ddb.send(
        new DeleteItemCommand({
          TableName: compositeTableDef.name,
          Key: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The provided key element does not match the schema',
      )
    }
  })

  // Completes the expression/non-expression mutual-exclusion family for the item
  // writes (PutItem and UpdateItem already pin it). DeleteItem takes legacy Expected
  // and a modern ConditionExpression; supplying both is rejected up front.
  it('mixing Expected with ConditionExpression: full conflict error', { tags: ['legacy'] }, async () => {
    try {
      await ddb.send(
        new DeleteItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'em-del-mix' } },
          Expected: { pk: { Exists: false } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Can not use both expression and non-expression parameters in the same request: Non-expression parameters: {Expected} Expression parameters: {ConditionExpression}',
      )
    }
  })

  it('empty-binary key value: full ValidationException message', async () => {
    // Real AWS rejects a zero-length binary key value with a top-level
    // ValidationException, the binary analogue of the empty-string key rejection.
    try {
      await ddb.send(
        new DeleteItemCommand({
          TableName: hashBTableDef.name,
          Key: { pk: { B: new Uint8Array([]) } },
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

describe('DeleteItem - request validation envelope', { tags: ['delete-item', 'data-plane', 'negative-path'] }, () => {
  // DeleteItem reports each of these request-validation errors inside the
  // `1 validation error detected: ` envelope, as PutItem and UpdateItem do.
  // The ExpressionAttributeValues message carries no ": ConditionExpression is
  // null" suffix. Both regions (eu-west-2, us-east-1, 2026-10-09).
  const Key = { pk: { S: 'em-del-envelope' } }
  const one = (m: string) => `1 validation error detected: ${m}`
  const INVALID = 'One or more parameter values were invalid: '

  async function message(input: Record<string, unknown>): Promise<string> {
    try {
      await ddb.send(new DeleteItemCommand({ TableName: hashTableDef.name, Key, ...input } as any))
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      return err.message
    }
    expect.unreachable('should have thrown')
    return ''
  }

  it('ExpressionAttributeValues or ExpressionAttributeNames without an expression', { tags: ['legacy'] }, async () => {
    expect(await message({ ExpressionAttributeValues: { ':v': { S: 'x' } } })).toBe(
      one('ExpressionAttributeValues can only be specified when using expressions'),
    )
    expect(await message({ ExpressionAttributeNames: { '#a': 'a' } })).toBe(
      one('ExpressionAttributeNames can only be specified when using expressions'),
    )
    expect(await message({ Expected: { a: { Exists: false } }, ExpressionAttributeNames: { '#a': 'a' } })).toBe(
      one('ExpressionAttributeNames can only be specified when using expressions'),
    )
  })

  it('an empty ExpressionAttributeValues or ExpressionAttributeNames map', async () => {
    const condition = { ConditionExpression: 'attribute_exists(a)' }
    expect(await message({ ...condition, ExpressionAttributeValues: {} })).toBe(one('ExpressionAttributeValues must not be empty'))
    expect(await message({ ...condition, ExpressionAttributeNames: {} })).toBe(one('ExpressionAttributeNames must not be empty'))
  })

  it('an empty ConditionExpression', async () => {
    expect(await message({ ConditionExpression: '' })).toBe(one('Invalid ConditionExpression: The expression can not be empty;'))
  })

  it('ReturnValues ALL_NEW or UPDATED_NEW', async () => {
    expect(await message({ ReturnValues: 'ALL_NEW' })).toBe(one('ReturnValues can only be ALL_OLD or NONE'))
    expect(await message({ ReturnValues: 'UPDATED_NEW' })).toBe(one('ReturnValues can only be ALL_OLD or NONE'))
  })

  it('every malformed Expected condition', { tags: ['legacy'] }, async () => {
    const got = [
      await message({ Expected: { a: { Exists: true } } }),
      await message({ Expected: { a: { Exists: false, Value: { S: 'x' } } } }),
      await message({ Expected: { a: { Value: { S: 'x' }, ComparisonOperator: 'EQ', AttributeValueList: [{ S: 'x' }] } } }),
      await message({ Expected: { a: { ComparisonOperator: 'EQ' } } }),
      await message({ Expected: { a: { ComparisonOperator: 'BETWEEN', AttributeValueList: [{ S: 'x' }] } } }),
    ]
    expect(got).toEqual([
      one(`${INVALID}Value must be provided when Exists is true for Attribute: a`),
      one(`${INVALID}Value cannot be used when Exists is false for Attribute: a`),
      one(`${INVALID}Value and AttributeValueList cannot be used together for Attribute: a`),
      one(`${INVALID}Value or AttributeValueList must be used with ComparisonOperator: EQ for Attribute: a`),
      one(`${INVALID}Invalid number of argument(s) for the BETWEEN ComparisonOperator`),
    ])
  })
})
