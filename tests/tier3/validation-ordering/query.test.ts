import {
  QueryCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { absentTableName, declareTables, hashTableDef } from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('Query — validation ordering', { tags: ['query', 'data-plane', 'negative-path'] }, () => {
  it('reports invalid TableName pattern', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: 'abc!',
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': { S: 'test' } },
          Select: 'INVALID',
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // DynamoDB reports at least one validation error
      expect(err.message).toContain('validation error')
    }
  })

  it('reports invalid Limit value', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: hashTableDef.name,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': { S: 'test' } },
          Limit: 0,
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // DynamoDB uses capital-L 'Limit' in the message
      expect(err.message).toContain('Limit')
    }
  })

  it('reports invalid ReturnConsumedCapacity', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: hashTableDef.name,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': { S: 'test' } },
          ReturnConsumedCapacity: 'INVALID',
          Select: 'INVALID',
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // DynamoDB reports returnConsumedCapacity (may or may not include select)
      expect(err.message).toContain('returnConsumedCapacity')
    }
  })
})

describe('Query - ConditionalOperator beside Select', { tags: ['query', 'legacy', 'data-plane', 'negative-path'] }, () => {
  it('reports XOR with two QueryFilter conditions before an unknown Select', async () => {
    // Bare, in the newer enum form, and on its own: the Select error is not
    // joined to it. Both regions (eu-west-2, us-east-1, 2026-10-09).
    try {
      await ddb.send(
        new QueryCommand({
          TableName: absentTableName('vo_query_xor'),
          KeyConditions: { pk: { ComparisonOperator: 'EQ', AttributeValueList: [{ S: 'a' }] } },
          QueryFilter: { b: { ComparisonOperator: 'NULL' }, c: { ComparisonOperator: 'NULL' } },
          ConditionalOperator: 'XOR',
          Select: 'BOGUS',
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toBe('Failed to satisfy constraint: Member must satisfy enum value set: [ALL, OR]')
    }
  })
})
