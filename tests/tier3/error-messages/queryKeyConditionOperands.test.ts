import {
  QueryCommand,
  DynamoDBServiceException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, compositeTableDef, compositeNTableDef } from '../../../src/helpers.js'

declareTables(compositeTableDef, compositeNTableDef)

// Exact AWS strings for KeyConditionExpression operands of the wrong type,
// pinned against real AWS (eu-west-2, October 2026).
//
// DynamoDB checks a key condition in two passes with different wording. An
// operand no key type could ever satisfy for that function or operator (a
// number in begins_with, a boolean in an ordering comparison) fails as an
// expression error naming the operator and the operand's type. An operand of a
// key type that simply isn't the attribute's type (a string compared with a
// number sort key) fails the schema check instead.
describe('Query - KeyConditionExpression operand types', { tags: ['query', 'data-plane', 'negative-path'] }, () => {
  const SS = compositeTableDef.name
  const SN = compositeNTableDef.name
  const SCHEMA = 'One or more parameter values were invalid: Condition parameter type does not match schema type'
  const operand = (op: string, type: string) =>
    `Invalid KeyConditionExpression: Incorrect operand type for operator or function; operator or function: ${op}, operand type: ${type}`

  async function rejection(TableName: string, KeyConditionExpression: string, values: Record<string, AttributeValue>) {
    try {
      await ddb.send(new QueryCommand({ TableName, KeyConditionExpression, ExpressionAttributeValues: values }))
      expect.unreachable('should have thrown')
      throw new Error('unreachable')
    } catch (err) {
      if (err instanceof DynamoDBServiceException) return err
      throw err
    }
  }

  async function expectMessage(
    TableName: string,
    KeyConditionExpression: string,
    values: Record<string, AttributeValue>,
    message: string,
  ) {
    const err = await rejection(TableName, KeyConditionExpression, values)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(message)
  }

  it('begins_with on a string sort key with a number operand - exact message', async () => {
    await expectMessage(SS, 'pk = :p AND begins_with(sk, :v)', { ':p': { S: 'q' }, ':v': { N: '1' } }, operand('begins_with', 'N'))
  })

  it('begins_with on a string sort key with a boolean operand - exact message', async () => {
    await expectMessage(SS, 'pk = :p AND begins_with(sk, :v)', { ':p': { S: 'q' }, ':v': { BOOL: true } }, operand('begins_with', 'BOOL'))
  })

  it('begins_with on a number sort key with a number operand - exact message', async () => {
    await expectMessage(SN, 'pk = :p AND begins_with(sk, :v)', { ':p': { S: 'q' }, ':v': { N: '1' } }, operand('begins_with', 'N'))
  })

  it('begins_with on a number sort key with a string operand fails the schema check - exact message', async () => {
    await expectMessage(SN, 'pk = :p AND begins_with(sk, :v)', { ':p': { S: 'q' }, ':v': { S: 'a' } }, SCHEMA)
  })

  it('an ordering comparison with a boolean operand - exact message', async () => {
    await expectMessage(SN, 'pk = :p AND sk < :v', { ':p': { S: 'q' }, ':v': { BOOL: true } }, operand('<', 'BOOL'))
  })

  it('an ordering comparison written value first - exact message', async () => {
    await expectMessage(SN, 'pk = :p AND :v >= sk', { ':p': { S: 'q' }, ':v': { BOOL: true } }, operand('>=', 'BOOL'))
  })

  it('BETWEEN with boolean bounds - exact message', async () => {
    await expectMessage(SN, 'pk = :p AND sk BETWEEN :a AND :b', { ':p': { S: 'q' }, ':a': { BOOL: false }, ':b': { BOOL: true } }, operand('BETWEEN', 'BOOL'))
  })

  it('equality with a boolean fails the schema check - exact message', async () => {
    await expectMessage(SN, 'pk = :p AND sk = :v', { ':p': { S: 'q' }, ':v': { BOOL: true } }, SCHEMA)
  })

  it('two conditions on the sort key - exact message', async () => {
    await expectMessage(
      SN,
      'pk = :p AND sk > :a AND sk < :b',
      { ':p': { S: 'q' }, ':a': { N: '1' }, ':b': { N: '5' } },
      'Invalid KeyConditionExpression: KeyConditionExpressions must only contain one condition per key',
    )
  })

  it('three conditions naming three attributes on a two-attribute key - exact message', async () => {
    await expectMessage(
      SN,
      'pk = :p AND sk > :a AND extra = :b',
      { ':p': { S: 'q' }, ':a': { N: '1' }, ':b': { N: '5' } },
      'The number of query conditions (3) exceeds the number of key attributes defined in the schema (2)',
    )
  })
})
