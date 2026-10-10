import {
  BatchExecuteStatementCommand,
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  PutItemCommand,
  DynamoDBServiceException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, hashTableDef, cleanupItems } from '../../../src/helpers.js'

declareTables(hashTableDef)

// Exact AWS strings for the functions DynamoDB's PartiQL refuses or restricts,
// pinned against real AWS (eu-west-2, October 2026; us-east-1, eu-west-1 and
// us-west-2 gave the same strings). The accepted forms are in
// tests/tier2/partiql/whereFunctions.test.ts and setFunctions.test.ts.
//
// Several messages carry a position, `at <line>:<column>:<length>`, counted in
// characters from 1 and pointing at a token of the statement. The table name
// differs from run to run, so each test works the column out from the
// statement it sends.
describe('PartiQL functions - exact error messages', { tags: ['partiql', 'data-plane', 'negative-path'] }, () => {
  let supported = true
  const T = hashTableDef.name
  const ITEM = 'pq-fn-msg'
  const NOT_WELL_FORMED = "Statement wasn't well formed, can't be processed: "

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${T}" WHERE pk = 'partiql-function-messages-canary'`,
      }))
    } catch (e: unknown) {
      // The same canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    await ddb.send(new PutItemCommand({
      TableName: T,
      Item: {
        pk: { S: ITEM },
        ss: { SS: ['a', 'b', 'c'] },
        ns: { NS: ['1', '2', '3'] },
        s: { S: 'str' },
        m: { M: { inner: { SS: ['x'] } } },
      },
    }))
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    await cleanupItems(T, [{ pk: { S: ITEM } }])
  })

  /** Run a statement and hand back the exception it raises. */
  async function rejection(Statement: string, Parameters?: AttributeValue[]) {
    try {
      await ddb.send(new ExecuteStatementCommand({ Statement, ...(Parameters ? { Parameters } : {}) }))
      expect.unreachable('should have thrown')
      throw new Error('unreachable')
    } catch (err) {
      if (err instanceof DynamoDBServiceException) return err
      throw err
    }
  }

  async function expectMessage(Statement: string, message: string, Parameters?: AttributeValue[]) {
    const err = await rejection(Statement, Parameters)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(message)
  }

  /** `1:<column>:<length>` for the first occurrence of `token` at or after `from`. */
  function at(statement: string, token: string, length = token.length, from = 0): string {
    const index = statement.indexOf(token, from)
    expect(index, `"${token}" in the statement`).toBeGreaterThanOrEqual(0)
    return `1:${index + 1}:${length}`
  }

  const where = (condition: string) => `SELECT * FROM "${T}" WHERE pk = '${ITEM}' AND ${condition}`
  const update = (set: string) => `UPDATE "${T}" SET ${set} WHERE pk = '${ITEM}'`

  // ── attribute_exists and attribute_not_exists ────────────────────────

  it('attribute_exists with a string literal - exact message', async () => {
    await expectMessage(where("attribute_exists('ss')"),
      'Operator or function requires a document path; operator or function: attribute_exists')
  })

  it('attribute_exists with a parameter - exact message', async () => {
    await expectMessage(where('attribute_exists(?)'),
      'Operator or function requires a document path; operator or function: attribute_exists',
      [{ S: 'ss' }])
  })

  it('attribute_exists with no operand - exact message', async () => {
    await expectMessage(where('attribute_exists()'),
      'Incorrect number of operands for operator or function; operator or function: attribute_exists, number of operands: 0')
  })

  it('attribute_exists with two operands - exact message', async () => {
    await expectMessage(where('attribute_exists(ss, ns)'),
      'Incorrect number of operands for operator or function; operator or function: attribute_exists, number of operands: 2')
  })

  it('attribute_exists as a SELECT projection - exact message', async () => {
    const statement = `SELECT attribute_exists(ss) FROM "${T}" WHERE pk = '${ITEM}'`
    await expectMessage(statement, `Unexpected path component at ${at(statement, 'attribute_exists')}`)
  })

  it('EXISTS(path) in a WHERE is not a function - exact message', async () => {
    const statement = where('EXISTS(ss)')
    await expectMessage(statement, `Unrecognized function: exists at ${at(statement, 'EXISTS')}`)
  })

  it('a path through an attribute named inner - exact message', async () => {
    await expectMessage(where('attribute_exists(m.inner)'), `${NOT_WELL_FORMED}Invalid path dot component`)
  })

  it('a SELECT in ExecuteTransaction whose WHERE uses attribute_exists - exact message', async () => {
    try {
      await ddb.send(new ExecuteTransactionCommand({
        TransactStatements: [{ Statement: where('attribute_exists(ss)') }],
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('ValidationException')
      expect(err.message).toBe('Validation failed in TransactStatements[0]: Select statements within ExecuteTransaction must specify the primary key in the where clause.')
    }
  })

  it('a SELECT in BatchExecuteStatement whose WHERE uses attribute_exists - exact message', async () => {
    const res = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [{ Statement: where('attribute_exists(ss)') }],
    }))
    expect(res.Responses).toHaveLength(1)
    expect(res.Responses![0].Error?.Code).toBe('ValidationError')
    expect(res.Responses![0].Error?.Message).toBe('Select statements within BatchExecuteStatement must specify the primary key in the where clause.')
  })

  it('EXISTS(SELECT ...) with no further condition in ExecuteTransaction - exact message', async () => {
    try {
      await ddb.send(new ExecuteTransactionCommand({
        TransactStatements: [
          { Statement: `EXISTS(SELECT * FROM "${T}" WHERE pk = '${ITEM}')` },
          { Statement: `UPDATE "${T}" SET z = 1 WHERE pk = 'pq-fn-msg-never-written'` },
        ],
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('ValidationException')
      expect(err.message).toBe('Validation failed in TransactStatements[0]: EXISTS() must contain a single item read with additional condition')
    }
  })

  // ── set_add and set_delete ───────────────────────────────────────────

  it('set_add assigned to another attribute - exact message', async () => {
    const statement = update("t = set_add(ss, <<'x'>>)")
    await expectMessage(statement, `The first argument to SET_ADD must equal the assignment value at ${at(statement, 'set_add')}`)
  })

  it('set_add whose first argument is not a path - exact message', async () => {
    const statement = update("ss = set_add(<<'a'>>, <<'b'>>)")
    await expectMessage(statement, `The first argument to SET_ADD must equal the assignment value at ${at(statement, 'set_add')}`)
  })

  it('set_add with a string to add - exact message', async () => {
    const statement = update("ss = set_add(ss, 'x')")
    // The position is the first argument's, not the second's.
    await expectMessage(statement, `The second argument to SET_ADD must be a value with type SET at ${at(statement, 'ss', 2, statement.indexOf('set_add('))}`)
  })

  it('set_add with a list to add - exact message', async () => {
    const statement = update("ss = set_add(ss, ['x'])")
    await expectMessage(statement, `The second argument to SET_ADD must be a value with type SET at ${at(statement, 'ss', 2, statement.indexOf('set_add('))}`)
  })

  it('set_add with one argument - exact message', async () => {
    const statement = update('ss = set_add(ss)')
    await expectMessage(statement, `SET_ADD must have exactly two arguments at ${at(statement, 'set_add')}`)
  })

  it('set_add with three arguments - exact message', async () => {
    const statement = update("ss = set_add(ss, <<'x'>>, <<'y'>>)")
    await expectMessage(statement, `SET_ADD must have exactly two arguments at ${at(statement, 'set_add')}`)
  })

  it('set_add of a number to a string set - exact message', async () => {
    await expectMessage(update('ss = set_add(ss, <<1>>)'), 'An operand in the update expression has an incorrect data type')
  })

  it('set_add to an attribute that is not a set - exact message', async () => {
    await expectMessage(update("s = set_add(s, <<'x'>>)"), 'An operand in the update expression has an incorrect data type')
  })

  it('set_add of a set literal with a repeated member - exact message', async () => {
    await expectMessage(update("ss = set_add(ss, <<'x', 'x'>>)"),
      'One or more parameter values were invalid: Input collection [x, x] contains duplicates.')
  })

  it('set_add of an empty set literal - exact message', async () => {
    await expectMessage(update('ss = set_add(ss, <<>>)'), 'Empty bags are not supported')
  })

  it('set_add on a path through an attribute named inner - exact message', async () => {
    await expectMessage(update("m.inner = set_add(m.inner, <<'y'>>)"), `${NOT_WELL_FORMED}Invalid path dot component`)
  })

  it('set_add in a SELECT WHERE - exact message', async () => {
    const statement = where("set_add(ss, <<'x'>>) = ss")
    await expectMessage(statement, `Unrecognized function: set_add at ${at(statement, 'set_add')}`)
  })

  it('set_add in an INSERT value - exact message', async () => {
    const statement = `INSERT INTO "${T}" VALUE {'pk': 'pq-fn-msg-insert', 'ss': set_add(<<'a'>>, <<'b'>>)}`
    await expectMessage(statement, `Unsupported data type: set_add under key root at ${at(statement, 'set_add')}`)
  })

  it('set_delete assigned to another attribute - exact message', async () => {
    const statement = update("t = set_delete(ss, <<'a'>>)")
    await expectMessage(statement, `The first argument to SET_DELETE must equal the assignment value at ${at(statement, 'set_delete')}`)
  })

  it('set_delete with a string to remove - exact message', async () => {
    const statement = update("ss = set_delete(ss, 'a')")
    await expectMessage(statement, `The second argument to SET_DELETE must be a value with type SET at ${at(statement, 'ss', 2, statement.indexOf('set_delete('))}`)
  })

  it('set_delete of a number from a string set - exact message', async () => {
    await expectMessage(update('ss = set_delete(ss, <<1>>)'), 'An operand in the update expression has an incorrect data type')
  })
})
