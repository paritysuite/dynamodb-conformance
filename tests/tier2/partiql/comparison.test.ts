import {
  ExecuteStatementCommand,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, hashTableDef, cleanupItems } from '../../../src/helpers.js'

declareTables(hashTableDef)

const TABLE = hashTableDef.name
const PREFIX = 'pq-cmp-'
const keysToClean: Record<string, AttributeValue>[] = []

/**
 * One case per type. `same` should match, `differs` should not, and `permuted`
 * is the question the type is here to answer: sets are order-insensitive, lists
 * are not, and a map ignores the order its keys arrive in.
 *
 * Values go through `Parameters` rather than statement literals, so the SDK
 * serialises each type rather than the test writing PartiQL literal syntax for
 * a set or a map.
 */
const CASES: {
  type: string
  stored: AttributeValue
  same: AttributeValue
  differs: AttributeValue
  permuted?: { value: AttributeValue; matches: boolean; why: string }
}[] = [
  {
    type: 'SS',
    stored: { SS: ['a', 'b', 'c'] },
    same: { SS: ['a', 'b', 'c'] },
    differs: { SS: ['a', 'b', 'd'] },
    permuted: { value: { SS: ['c', 'a', 'b'] }, matches: true, why: 'a string set is unordered' },
  },
  {
    type: 'NS',
    stored: { NS: ['1', '2', '3'] },
    same: { NS: ['1', '2', '3'] },
    differs: { NS: ['1', '2', '4'] },
    permuted: { value: { NS: ['3', '1', '2'] }, matches: true, why: 'a number set is unordered' },
  },
  {
    type: 'BS',
    stored: { BS: [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])] },
    same: { BS: [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])] },
    differs: { BS: [Uint8Array.from([1, 2]), Uint8Array.from([5, 6])] },
    permuted: {
      value: { BS: [Uint8Array.from([3, 4]), Uint8Array.from([1, 2])] },
      matches: true,
      why: 'a binary set is unordered',
    },
  },
  {
    type: 'L',
    stored: { L: [{ S: 'a' }, { S: 'b' }] },
    same: { L: [{ S: 'a' }, { S: 'b' }] },
    differs: { L: [{ S: 'a' }, { S: 'c' }] },
    permuted: {
      value: { L: [{ S: 'b' }, { S: 'a' }] },
      matches: false,
      why: 'a list is ordered, so a permutation is a different value',
    },
  },
  {
    type: 'M',
    stored: { M: { x: { N: '1' }, y: { N: '2' } } },
    same: { M: { x: { N: '1' }, y: { N: '2' } } },
    differs: { M: { x: { N: '1' }, y: { N: '3' } } },
    permuted: {
      value: { M: { y: { N: '2' }, x: { N: '1' } } },
      matches: true,
      why: 'a map compares by content, not by the order its keys arrived in',
    },
  },
  {
    type: 'B',
    stored: { B: Uint8Array.from([1, 2, 3]) },
    same: { B: Uint8Array.from([1, 2, 3]) },
    differs: { B: Uint8Array.from([1, 2, 4]) },
  },
  {
    type: 'NULL',
    stored: { NULL: true },
    same: { NULL: true },
    differs: { S: 'not null' },
  },
]

const keyFor = (type: string, suffix = '') => `${PREFIX}${type}${suffix}`

/** Does a PartiQL equality predicate match the stored item? */
async function partiqlMatches(pk: string, value: AttributeValue, op: '=' | '<>') {
  const res = await ddb.send(new ExecuteStatementCommand({
    Statement: `SELECT pk FROM "${TABLE}" WHERE pk = ? AND val ${op} ?`,
    Parameters: [{ S: pk }, value],
  }))
  return (res.Items ?? []).length === 1
}

/**
 * Does the same predicate as a ConditionExpression hold? Asserted through a
 * write whose only effect is a marker attribute, so the fixture survives.
 */
async function conditionHolds(pk: string, value: AttributeValue, op: '=' | '<>') {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: pk } },
      UpdateExpression: 'SET marker = :m',
      ConditionExpression: `val ${op} :v`,
      ExpressionAttributeValues: { ':m': { N: '1' }, ':v': value },
    }))
    return true
  } catch (err) {
    if (err instanceof DynamoDBServiceException && err.name === 'ConditionalCheckFailedException') {
      return false
    }
    throw err
  }
}

describe('ExecuteStatement — comparison on non-scalar types', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${TABLE}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }

    // A key per type, so no case's result depends on another's writes.
    for (const c of CASES) {
      const key = { pk: { S: keyFor(c.type) } }
      keysToClean.push(key)
      await ddb.send(new PutItemCommand({ TableName: TABLE, Item: { ...key, val: c.stored } }))
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    if (keysToClean.length > 0) await cleanupItems(TABLE, keysToClean)
  })

  // Quoted by hand: the title is part of the test ID, and Vitest 5 stopped
  // quoting string placeholders.
  describe.each(CASES)("'$type'", (c) => {
    it('matches an equal value', async () => {
      expect(await partiqlMatches(keyFor(c.type), c.same, '=')).toBe(true)
    })

    it('does not match a different value', async () => {
      expect(await partiqlMatches(keyFor(c.type), c.differs, '=')).toBe(false)
    })

    // `<>` is the exact complement of `=`, which is the half an engine
    // answering true for every unhandled type gets wrong in both directions.
    it('answers <> as the complement of =', async () => {
      expect(await partiqlMatches(keyFor(c.type), c.same, '<>')).toBe(false)
      expect(await partiqlMatches(keyFor(c.type), c.differs, '<>')).toBe(true)
    })

    if (c.permuted) {
      const p = c.permuted
      it(`${p.matches ? 'matches' : 'does not match'} a permuted value, because ${p.why}`, async () => {
        expect(await partiqlMatches(keyFor(c.type), p.value, '=')).toBe(p.matches)
      })
    }

    // The cross-surface assertion. Asserting each surface on its own still
    // passes an engine whose two comparison paths disagree with each other,
    // which is the divergence this exists to catch.
    it('agrees with the same predicate as a ConditionExpression', async () => {
      for (const [label, value] of [['same', c.same], ['differs', c.differs]] as const) {
        for (const op of ['=', '<>'] as const) {
          const viaPartiql = await partiqlMatches(keyFor(c.type), value, op)
          const viaCondition = await conditionHolds(keyFor(c.type), value, op)
          expect(viaPartiql, `${c.type} ${label} ${op}`).toBe(viaCondition)
        }
      }
    })
  })

  // An ordering operator rejects an operand whose type has no ordering. The rule
  // is about the operand alone, not about the two sides matching, and it fires
  // as a statement-level check rather than as a comparison outcome.
  describe('ordering operators reject an operand type with no ordering', () => {
    const UNORDERED: [string, AttributeValue][] = [
      ['BOOL', { BOOL: true }],
      ['NULL', { NULL: true }],
      ['L', { L: [{ S: 'a' }] }],
      ['M', { M: { a: { S: 'b' } } }],
      ['SS', { SS: ['a'] }],
      ['NS', { NS: ['1'] }],
      ['BS', { BS: [Uint8Array.from([1])] }],
    ]

    async function orderingRejection(clause: string, params: AttributeValue[]) {
      try {
        await ddb.send(new ExecuteStatementCommand({
          Statement: `SELECT pk FROM "${TABLE}" WHERE pk = ? AND ${clause}`,
          Parameters: [{ S: keyFor('B') }, ...params],
        }))
        expect.unreachable(`should have been rejected: ${clause}`)
      } catch (err) {
        expect(err).toBeInstanceOf(DynamoDBServiceException)
        const e = err as DynamoDBServiceException
        expect(e.name).toBe('ValidationException')
        return e
      }
      throw new Error('unreachable')
    }

    it.each(UNORDERED)('rejects < against %s', async (_type, value) => {
      await orderingRejection('val < ?', [value])
    })

    it.each(['<', '<=', '>', '>='])('names the operator %s as written', async (op) => {
      const err = await orderingRejection(`val ${op} ?`, [{ BOOL: true }])
      expect(err.message).toBe(
        `Incorrect operand type for operator or function; operator or function: ${op}, operand type: BOOL`,
      )
    })

    it('names BETWEEN as written too', async () => {
      const err = await orderingRejection('val BETWEEN ? AND ?', [{ BOOL: true }, { BOOL: false }])
      expect(err.message).toContain('operator or function: BETWEEN')
    })

    // Equality accepts every type the ordering operators refuse.
    it.each(UNORDERED)('accepts = and <> against %s', async (_type, value) => {
      await expect(partiqlMatches(keyFor('B'), value, '=')).resolves.toBe(false)
      await expect(partiqlMatches(keyFor('B'), value, '<>')).resolves.toBe(true)
    })

    // If the rule were about the two sides matching, this would be refused.
    // It is about the operand's own type, so a string against a number is fine.
    it('accepts an ordering comparison between S and N', async () => {
      const res = await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT pk FROM "${TABLE}" WHERE pk = ? AND val < ?`,
        Parameters: [{ S: keyFor('NULL') }, { N: '5' }],
      }))
      expect(res.Items).toBeDefined()
    })

    it('orders binary by its bytes', async () => {
      const below = await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT pk FROM "${TABLE}" WHERE pk = ? AND val < ?`,
        Parameters: [{ S: keyFor('B') }, { B: Uint8Array.from([1, 2, 4]) }],
      }))
      expect((below.Items ?? []).length).toBe(1)

      const above = await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT pk FROM "${TABLE}" WHERE pk = ? AND val > ?`,
        Parameters: [{ S: keyFor('B') }, { B: Uint8Array.from([1, 2, 4]) }],
      }))
      expect((above.Items ?? []).length).toBe(0)
    })

  })

  describe('a write conditioned on a non-scalar predicate', () => {
    it('fires when the predicate holds', async () => {
      const key = { pk: { S: keyFor('SS', '-write-true') } }
      keysToClean.push(key)
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: { ...key, val: { SS: ['a', 'b'] } },
      }))

      await ddb.send(new ExecuteStatementCommand({
        Statement: `UPDATE "${TABLE}" SET touched = 'yes' WHERE pk = ? AND val = ?`,
        Parameters: [{ S: key.pk.S }, { SS: ['b', 'a'] }],
      }))

      const got = await ddb.send(new GetItemCommand({
        TableName: TABLE, Key: key, ConsistentRead: true,
      }))
      expect(got.Item!.touched?.S).toBe('yes')
    })

    it('raises ConditionalCheckFailed and leaves the item when it does not', async () => {
      const key = { pk: { S: keyFor('M', '-write-false') } }
      keysToClean.push(key)
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: { ...key, val: { M: { x: { N: '1' } } } },
      }))

      try {
        await ddb.send(new ExecuteStatementCommand({
          Statement: `UPDATE "${TABLE}" SET touched = 'yes' WHERE pk = ? AND val = ?`,
          Parameters: [{ S: key.pk.S }, { M: { x: { N: '2' } } }],
        }))
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(DynamoDBServiceException)
        expect((err as DynamoDBServiceException).name).toBe('ConditionalCheckFailedException')
      }

      const got = await ddb.send(new GetItemCommand({
        TableName: TABLE, Key: key, ConsistentRead: true,
      }))
      expect(got.Item!.touched).toBeUndefined()
    })
  })
})
