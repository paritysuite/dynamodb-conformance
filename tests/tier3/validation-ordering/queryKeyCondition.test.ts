import {
  QueryCommand,
  DynamoDBServiceException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, compositeTableDef, absentTableName } from '../../../src/helpers.js'

declareTables(compositeTableDef)

// Which problem a KeyConditionExpression reports when it has more than one.
// DynamoDB walks the clauses in the order they are written and reports the first
// problem it meets, whether that is a value the request never defined or an
// operand of the wrong type, and it checks operand types before it looks for the
// table or counts the conditions. The wording can drift; the ordering should
// not, so these use `toContain`. Verified against real AWS (eu-west-2, October
// 2026).
describe('Query - KeyConditionExpression validation ordering', { tags: ['query', 'data-plane', 'negative-path'] }, () => {
  const T = compositeTableDef.name
  const OPERAND = 'Incorrect operand type for operator or function; operator or function: begins_with, operand type: N'
  const UNDEFINED = 'An expression attribute value used in expression is not defined; attribute value: :missing'

  async function rejection(TableName: string, KeyConditionExpression: string, values: Record<string, AttributeValue>) {
    try {
      await ddb.send(new QueryCommand({ TableName, KeyConditionExpression, ExpressionAttributeValues: values }))
      expect.unreachable('should have thrown')
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      return err as DynamoDBServiceException
    }
  }

  it('an undefined value written before a bad operand is reported first', async () => {
    const err = await rejection(T, 'pk = :missing AND begins_with(sk, :n)', { ':n': { N: '1' } })
    expect(err.name).toBe('ValidationException')
    expect(err.message).toContain(UNDEFINED)
  })

  it('a bad operand written before an undefined value is reported first', async () => {
    const err = await rejection(T, 'begins_with(sk, :n) AND pk = :missing', { ':n': { N: '1' } })
    expect(err.name).toBe('ValidationException')
    expect(err.message).toContain(OPERAND)
  })

  it('a bad operand in the middle clause is reported ahead of a later undefined value', async () => {
    const err = await rejection(T, 'pk = :p AND begins_with(sk, :n) AND sk = :missing', { ':p': { S: 'q' }, ':n': { N: '1' } })
    expect(err.name).toBe('ValidationException')
    expect(err.message).toContain(OPERAND)
  })

  it('a bad operand is reported ahead of a third condition', async () => {
    const err = await rejection(T, 'pk = :p AND begins_with(sk, :n) AND sk > :s', { ':p': { S: 'q' }, ':n': { N: '1' }, ':s': { S: 'a' } })
    expect(err.name).toBe('ValidationException')
    expect(err.message).toContain(OPERAND)
  })

  it('a bad operand is reported ahead of a missing table', async () => {
    const err = await rejection(absentTableName('vo_query_kce_missing'), 'pk = :p AND begins_with(sk, :n)', { ':p': { S: 'q' }, ':n': { N: '1' } })
    expect(err.name).toBe('ValidationException')
    expect(err.message).toContain(OPERAND)
  })

  // Without this control the case above shows only that something was rejected.
  it('a well-formed key condition on the same missing table reports it missing', async () => {
    const err = await rejection(absentTableName('vo_query_kce_missing'), 'pk = :p AND begins_with(sk, :s)', { ':p': { S: 'q' }, ':s': { S: 'a' } })
    expect(err.name).toBe('ResourceNotFoundException')
  })
})
