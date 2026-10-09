import {
  UpdateItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { absentTableName } from '../../../src/helpers.js'
import { observeSplit } from '../../../src/observation-sink.js'

describe('UpdateItem — validation ordering', { tags: ['update-item', 'data-plane', 'negative-path'] }, () => {
  it('empty TableName reports only tableName constraint', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: '',
          Key: {},
        } as any),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // Field is 'TableName' (eu-west-2, 2026-06) or 'tableName' (older
      // regions); match case-insensitively. One error proves it stops at the
      // table name rather than also reporting the empty Key.
      expect(err.message.toLowerCase()).toContain('tablename')
      expect(err.message).toMatch(/^1 validation error detected:/)
    }
  })

  it('rejects invalid ReturnValues (UpdateItem reports the first enum error)', async (ctx) => {
    // Split behaviour (registry row update-item-validation-error-aggregation):
    // the answer differs by region, so what the target actually returned is
    // recorded for per-region scoring.
    try {
      await observeSplit(ctx.task, () =>
        ddb.send(
          new UpdateItemCommand({
            TableName: absentTableName('valid_table_name'),
            Key: { pk: { S: 'test' } },
            ReturnValues: 'INVALID',
            ReturnConsumedCapacity: 'INVALID',
          } as any),
        ),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // Behaviour change captured 2026-06-08: UpdateItem in eu-west-2 stops at
      // the first invalid enum (ReturnValues) and reports one error, where
      // older regions aggregated both. Pin the ground-truth single-error form.
      expect(err.message).toMatch(/^1 validation error detected:/)
      expect(err.message).toContain('enum value set')
    }
  })

  it('invalid table name pattern reports only tableName', async () => {
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: 'x!',
          Key: {},
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
})

describe('UpdateItem - member errors beside a missing Key', { tags: ['update-item', 'data-plane', 'negative-path'] }, () => {
  // With Key left out altogether, an empty table name and a ConditionalOperator
  // outside its enum are reported in the older per-value form and joined with
  // the missing key in one message, member by member: ReturnConsumedCapacity,
  // tableName, ReturnValues, key. Both regions (eu-west-2, us-east-1,
  // 2026-10-09).
  const update = { UpdateExpression: 'SET a = :a', ExpressionAttributeValues: { ':a': { S: 'x' } } }
  const EMPTY_NAME = "Value '' at 'tableName' failed to satisfy constraint: Member must have length greater than or equal to 1"
  const NO_KEY = "Value null at 'key' failed to satisfy constraint: Member must not be null"

  async function message(input: Record<string, unknown>): Promise<string> {
    try {
      await ddb.send(new UpdateItemCommand(input as any))
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      return err.message
    }
    expect.unreachable('should have thrown')
    return ''
  }

  it('joins an empty table name with the missing key', async () => {
    expect(await message({ TableName: '', ...update })).toBe(`2 validation errors detected: ${EMPTY_NAME}; ${NO_KEY}`)
  })

  it('joins the enums, an empty table name and the missing key in member order', async () => {
    expect(await message({ TableName: '', ...update, ReturnConsumedCapacity: 'INVALID', ReturnValues: 'INVALID' })).toBe(
      '4 validation errors detected: ' +
        "Value 'INVALID' at 'returnConsumedCapacity' failed to satisfy constraint: Member must satisfy enum value set: [INDEXES, TOTAL, NONE]; " +
        `${EMPTY_NAME}; ` +
        "Value 'INVALID' at 'returnValues' failed to satisfy constraint: Member must satisfy enum value set: [ALL_NEW, UPDATED_OLD, ALL_OLD, NONE, UPDATED_NEW]; " +
        NO_KEY,
    )
  })

  it('joins XOR with two Expected conditions to the missing key', { tags: ['legacy'] }, async () => {
    const got = await message({
      TableName: absentTableName('vo_upd_nokey'),
      AttributeUpdates: { x: { Action: 'PUT', Value: { S: '1' } } },
      Expected: { a: { Exists: false }, b: { Exists: false } },
      ConditionalOperator: 'XOR',
    })
    expect(got).toBe(
      "2 validation errors detected: Value 'XOR' at 'conditionalOperator' failed to satisfy constraint: Member must satisfy enum value set: [OR, AND]; " +
        NO_KEY,
    )
  })
})
