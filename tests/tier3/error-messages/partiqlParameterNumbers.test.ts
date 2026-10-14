import {
  BatchExecuteStatementCommand,
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  DynamoDBServiceException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, compositeTableDef } from '../../../src/helpers.js'

declareTables(compositeTableDef)

// How DynamoDB reads a number passed as a PartiQL parameter, pinned against
// real AWS (eu-west-2, October 2026; us-east-1 gave the same strings).
//
// A parameter is read the way Java's BigDecimal reads a string. An exponent
// that doesn't fit in a 32-bit integer can't be converted at all, so
// 1e99999999999 and 1e2147483648 get "cannot be converted" with the text
// echoed, in every position the parameter can take. Inside that range the
// magnitude check works on precision minus scale in 32-bit arithmetic, which
// wraps: 1e2147483647 comes out as an underflow. An empty string gets the
// message with nothing after it. This differs from an attribute value sent to
// PutItem, which tests/tier3/limits/numberExponent.test.ts pins.
//
// When a parameter is both nested too deeply and holds a number that can't be
// converted, DynamoDB reports whichever it reaches first in document order.
describe('PartiQL parameters - numbers - exact error messages', { tags: ['partiql', 'data-plane', 'negative-path'] }, () => {
  let supported = true
  const T = compositeTableDef.name
  const NEST = 'Nesting Levels have exceeded supported limits: Attributes in the item have nested levels beyond supported limit'
  const UNCONVERTIBLE = 'The parameter cannot be converted to a numeric value'
  const UNDERFLOW = 'Number underflow. Attempting to store a number with magnitude smaller than supported range'

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-parameter-numbers-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  /** Run a statement and hand back the exception it raises. */
  async function rejection(Statement: string, Parameters: AttributeValue[]) {
    try {
      await ddb.send(new ExecuteStatementCommand({ Statement, Parameters }))
      expect.unreachable('should have thrown')
      throw new Error('unreachable')
    } catch (err) {
      if (err instanceof DynamoDBServiceException) return err
      throw err
    }
  }

  async function expectMessage(Statement: string, Parameters: AttributeValue[], message: string) {
    const err = await rejection(Statement, Parameters)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(message)
  }

  /** `depth` map levels around a leaf. */
  function deep(depth: number, leaf: AttributeValue = { S: 'leaf' }): AttributeValue {
    let v = leaf
    for (let i = 0; i < depth; i++) v = { M: { n: v } }
    return v
  }

  const positions: [string, string][] = [
    ['a WHERE comparison', `SELECT * FROM "${T}" WHERE pk = 'pq-pn' AND n = ?`],
    ['an INSERT value', `INSERT INTO "${T}" VALUE {'pk': 'pq-pn-insert', 'sk': 's', 'n': ?}`],
    ['an UPDATE SET', `UPDATE "${T}" SET n = ? WHERE pk = 'pq-pn' AND sk = 's'`],
    ['a key', `SELECT * FROM "${T}" WHERE pk = ?`],
  ]

  // ── An exponent outside a 32-bit integer ────────────────────────────

  describe.each(['1e99999999999', '-1e99999999999', '1e-99999999999', '1e2147483648', '1e-2147483648'])(
    'the parameter %s',
    (value) => {
      it.each(positions)('in %s cannot be converted - exact message', async (_label, statement) => {
        await expectMessage(statement, [{ N: value }], `${UNCONVERTIBLE}: ${value}`)
      })
    },
  )

  it.each(positions)('the parameter 1e2147483647 in %s underflows - exact message', async (_label, statement) => {
    await expectMessage(statement, [{ N: '1e2147483647' }], UNDERFLOW)
  })

  it.each(positions)('an empty number parameter in %s - exact message', async (_label, statement) => {
    await expectMessage(statement, [{ N: '' }], UNCONVERTIBLE)
  })

  it('an unconvertible number inside a list parameter - exact message', async () => {
    await expectMessage(positions[0][1], [{ L: [{ N: '1' }, { N: '1e99999999999' }] }], `${UNCONVERTIBLE}: 1e99999999999`)
  })

  it('an unconvertible number inside a map parameter - exact message', async () => {
    await expectMessage(positions[0][1], [{ M: { x: { N: '1e99999999999' } } }], `${UNCONVERTIBLE}: 1e99999999999`)
  })

  it('an unconvertible member of a number set parameter - exact message', async () => {
    await expectMessage(positions[0][1], [{ NS: ['1', '1e99999999999'] }], `${UNCONVERTIBLE}: 1e99999999999`)
  })

  it('an unconvertible number in ExecuteTransaction - exact message', async () => {
    try {
      await ddb.send(new ExecuteTransactionCommand({
        TransactStatements: [{ Statement: `UPDATE "${T}" SET n = ? WHERE pk = 'pq-pn' AND sk = 's'`, Parameters: [{ N: '1e99999999999' }] }],
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('ValidationException')
      expect(err.message).toBe(`${UNCONVERTIBLE}: 1e99999999999`)
    }
  })

  it('an unconvertible number in BatchExecuteStatement - exact message', async () => {
    const res = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [{ Statement: `SELECT * FROM "${T}" WHERE pk = 'pq-pn' AND sk = 's' AND n = ?`, Parameters: [{ N: '1e99999999999' }] }],
    }))
    expect(res.Responses).toHaveLength(1)
    expect(res.Responses![0].Error?.Code).toBe('ValidationError')
    expect(res.Responses![0].Error?.Message).toBe(`${UNCONVERTIBLE}: 1e99999999999`)
  })

  // ── Too deep and unconvertible: the first problem in document order ──

  const pair = `SELECT * FROM "${T}" WHERE pk = 'pq-pn' AND x = ? AND y = ?`
  const single = `SELECT * FROM "${T}" WHERE pk = 'pq-pn' AND x = ?`

  describe.each([40, 100])('nested %i levels', (depth) => {
    it('a deep parameter before an unconvertible one - exact message', async () => {
      await expectMessage(pair, [deep(depth), { N: 'abc' }], NEST)
    })

    it('an unconvertible parameter before a deep one - exact message', async () => {
      await expectMessage(pair, [{ N: 'abc' }, deep(depth)], `${UNCONVERTIBLE}: abc`)
    })

    it('a deep member of a map before an unconvertible one - exact message', async () => {
      await expectMessage(single, [{ M: { d: deep(depth), bad: { N: 'abc' } } }], NEST)
    })

    it('an unconvertible member of a map before a deep one - exact message', async () => {
      await expectMessage(single, [{ M: { bad: { N: 'abc' }, d: deep(depth) } }], `${UNCONVERTIBLE}: abc`)
    })

    it('an unconvertible number at the bottom of a deep value - exact message', async () => {
      await expectMessage(single, [deep(depth, { N: 'abc' })], NEST)
    })

    it('a deep parameter before one past the largest number - exact message', async () => {
      await expectMessage(pair, [deep(depth), { N: '1e126' }], NEST)
    })

    it('a deep parameter before an unconvertible one, in ExecuteTransaction - exact message', async () => {
      try {
        await ddb.send(new ExecuteTransactionCommand({
          TransactStatements: [{
            Statement: `UPDATE "${T}" SET x = ? SET y = ? WHERE pk = 'pq-pn' AND sk = '1'`,
            Parameters: [deep(depth), { N: 'abc' }],
          }],
        }))
        expect.unreachable('should have thrown')
      } catch (err) {
        if (!(err instanceof DynamoDBServiceException)) throw err
        expect(err.name).toBe('ValidationException')
        expect(err.message).toBe(NEST)
      }
    })

    it('a deep parameter before an unconvertible one, in BatchExecuteStatement - exact message', async () => {
      const res = await ddb.send(new BatchExecuteStatementCommand({
        Statements: [{ Statement: pair, Parameters: [deep(depth), { N: 'abc' }] }],
      }))
      expect(res.Responses).toHaveLength(1)
      expect(res.Responses![0].Error?.Code).toBe('ValidationError')
      expect(res.Responses![0].Error?.Message).toBe(NEST)
    })
  })
})
