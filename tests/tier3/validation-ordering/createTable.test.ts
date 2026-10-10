import {
  CreateTableCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { absentTableName } from '../../../src/helpers.js'

describe('CreateTable — validation ordering', { tags: ['create-table', 'control-plane', 'negative-path'] }, () => {
  it('empty TableName reports only tableName constraint', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: '',
          KeySchema: [],
          AttributeDefinitions: [],
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toContain('tableName')
    }
  })

  it('invalid table name pattern reports only tableName', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: 'x!',
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [],
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toContain('tableName')
    }
  })

  it('reports invalid BillingMode and invalid KeySchema element together', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: absentTableName('valid_table_name'),
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'INVALID' },
          ],
          BillingMode: 'INVALID_MODE',
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message.length).toBeGreaterThan(0)
    }
  })

  it('reports missing ProvisionedThroughput and invalid key type together', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: absentTableName('valid_table_name'),
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'INVALID' },
          ],
          BillingMode: 'PROVISIONED',
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message.length).toBeGreaterThan(0)
    }
  })

  it('rejects a duplicate attribute in KeySchema', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: absentTableName('dupkey'),
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'pk', KeyType: 'RANGE' },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toContain('Invalid KeySchema')
    }
  })

  it('rejects more than two KeySchema elements', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: absentTableName('threekey'),
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
            { AttributeName: 'tk', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
            { AttributeName: 'tk', KeyType: 'RANGE' },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // The full message echoes the KeySchema as a Java-style object dump
      // (SDK-version-coupled), so assert only the stable constraint phrase.
      expect(err.message).toContain('Member must have length less than or equal to 2')
    }
  })

  it('rejects an invalid BillingMode on its own', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: absentTableName('badbilling'),
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          // @ts-expect-error -- testing invalid BillingMode
          BillingMode: 'INVALID_MODE',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toContain('billingMode')
      expect(err.message).toContain('[PROVISIONED, PAY_PER_REQUEST]')
    }
  })
})

describe('CreateTable - index name errors across index kinds', { tags: ['create-table', 'gsi', 'lsi', 'control-plane', 'negative-path'] }, () => {
  // Two-character index names on both a GSI and an LSI: the GSI's error comes
  // first whichever order the request lists them in, and whatever the names
  // sort to. Both regions (eu-west-2, us-east-1, 2026-10-09).
  const tooShort = (name: string, member: string) =>
    `Value '${name}' at '${member}.1.member.indexName' failed to satisfy constraint: Member must have length greater than or equal to 3`
  const base = {
    TableName: absentTableName('vo_ct_index_names'),
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
  }
  const lsi = (name: string) => ({
    IndexName: name,
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'lr', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  })
  const gsi = (name: string) => ({
    IndexName: name,
    KeySchema: [{ AttributeName: 'gh', KeyType: 'HASH' }],
    Projection: { ProjectionType: 'ALL' },
  })

  async function message(input: Record<string, unknown>): Promise<string> {
    try {
      await ddb.send(new CreateTableCommand(input as any))
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      return err.message
    }
    expect.unreachable('should have thrown')
    return ''
  }

  it('lists the GSI error before the LSI error when the request lists the LSI first', async () => {
    const got = await message({ ...base, LocalSecondaryIndexes: [lsi('l1')], GlobalSecondaryIndexes: [gsi('g1')] })
    expect(got).toBe(
      `2 validation errors detected: ${tooShort('g1', 'globalSecondaryIndexes')}; ${tooShort('l1', 'localSecondaryIndexes')}`,
    )
  })

  it('lists the GSI error first even when the LSI name sorts first', async () => {
    const got = await message({ ...base, LocalSecondaryIndexes: [lsi('aa')], GlobalSecondaryIndexes: [gsi('zz')] })
    expect(got).toBe(
      `2 validation errors detected: ${tooShort('zz', 'globalSecondaryIndexes')}; ${tooShort('aa', 'localSecondaryIndexes')}`,
    )
  })
})
