import {
  BatchExecuteStatementCommand,
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, hashTableDef, hashNTableDef, compositeTableDef } from '../../../src/helpers.js'

declareTables(hashTableDef, hashNTableDef, compositeTableDef)

// Exact AWS strings for statements DynamoDB's PartiQL parser refuses, pinned
// against real AWS (eu-west-2, October 2026). tests/tier2/partiql/grammar.test.ts
// covers the accepted forms and asserts that nothing runs for the refused ones;
// this file pins the wording.
//
// Three shapes recur. A statement the parser can't read gets the "wasn't well
// formed" envelope, with a detail after the colon or, for a literal it cannot
// convert at all, nothing after it. A table alias has a message of its own with
// no envelope. A number literal that parses but breaks DynamoDB's number rules
// gets the ordinary number message with the path inside the value appended.
const NOT_WELL_FORMED = "Statement wasn't well formed, can't be processed: "
const LEFTOVER = `${NOT_WELL_FORMED}Unexpected token after expression`
const ALIASING = 'Aliasing is not supported'
const OVERFLOW = 'Number overflow. Attempting to store a number with magnitude larger than supported range'
const UNDERFLOW = 'Number underflow. Attempting to store a number with magnitude smaller than supported range'
const DIGITS = 'Attempting to store more than 38 significant digits in a Number'

describe('PartiQL grammar - exact error messages', { tags: ['partiql', 'data-plane', 'negative-path'] }, () => {
  let supported = true
  const S = hashTableDef.name
  const N = hashNTableDef.name

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${S}" WHERE pk = 'partiql-grammar-canary'`,
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
  async function rejection(Statement: string) {
    try {
      await ddb.send(new ExecuteStatementCommand({ Statement }))
      expect.unreachable('should have thrown')
      throw new Error('unreachable')
    } catch (err) {
      if (err instanceof DynamoDBServiceException) return err
      throw err
    }
  }

  async function expectMessage(Statement: string, message: string) {
    const err = await rejection(Statement)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(message)
  }

  // ── A token left over after a complete statement ──────────────────────

  it('a token after a SELECT WHERE clause - exact message', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1 foo`, LEFTOVER)
  })

  it('a number split from its exponent - exact message', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1 e5`, LEFTOVER)
  })

  it('a token after an INSERT item literal - exact message', async () => {
    await expectMessage(`INSERT INTO "${N}" VALUE {'pk': 970001} foo`, LEFTOVER)
  })

  it('a token after an UPDATE WHERE clause - exact message', async () => {
    await expectMessage(`UPDATE "${N}" SET a = 9 WHERE pk = 970002 foo`, LEFTOVER)
  })

  it('a token after a DELETE WHERE clause - exact message', async () => {
    await expectMessage(`DELETE FROM "${N}" WHERE pk = 970003 foo`, LEFTOVER)
  })

  it('a stray closing parenthesis - exact message', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1)`, LEFTOVER)
  })

  // ── ORDER BY in a place it cannot go ─────────────────────────────────

  it('ORDER BY on a DELETE - exact message', async () => {
    await expectMessage(`DELETE FROM "${N}" WHERE pk = 970004 ORDER BY pk`, LEFTOVER)
  })

  it('ORDER BY ahead of WHERE - exact message', async () => {
    await expectMessage(`SELECT * FROM "${N}" ORDER BY pk WHERE pk = 1`, LEFTOVER)
  })

  // ── Literals and comments the parser cannot read ─────────────────────

  it('an exponent that does not fit a 32-bit integer - nothing after the colon', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1e2147483648`, NOT_WELL_FORMED)
  })

  it('a far larger exponent - nothing after the colon', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1e99999999999`, NOT_WELL_FORMED)
  })

  it('an exponent that fits but leaves a scale that does not - nothing after the colon', async () => {
    // The scale is the digits written after the point less the exponent. Here
    // that is 1 + 2147483647, one more than a 32-bit integer holds, although
    // the exponent itself is in range.
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1.5e-2147483647`, NOT_WELL_FORMED)
  })

  it('a hash comment - nothing after the colon', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1 # note`, NOT_WELL_FORMED)
  })

  it('an unterminated block comment - nothing after the colon', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1 /* note`, NOT_WELL_FORMED)
  })

  // ── Table aliases ────────────────────────────────────────────────────

  it('an alias on a SELECT - exact message', async () => {
    await expectMessage(`SELECT * FROM "${S}" t WHERE pk = 'x'`, ALIASING)
  })

  it('an AS alias on a SELECT - exact message', async () => {
    await expectMessage(`SELECT * FROM "${S}" AS t WHERE pk = 'x'`, ALIASING)
  })

  it('an alias on an UPDATE - exact message', async () => {
    await expectMessage(`UPDATE "${S}" t SET a = 3 WHERE pk = 'x'`, ALIASING)
  })

  it('an alias on a DELETE - exact message', async () => {
    await expectMessage(`DELETE FROM "${S}" t WHERE pk = 'x'`, ALIASING)
  })

  it('an alias on an INSERT is a leftover token - exact message', async () => {
    await expectMessage(`INSERT INTO "${S}" t VALUE {'pk': 'x'}`, LEFTOVER)
  })

  // ── Number literals that break DynamoDB's number rules ───────────────

  it('a WHERE literal above the largest number - exact message', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1e126`, `${OVERFLOW} under root`)
  })

  it('a WHERE literal below the smallest number - exact message', async () => {
    await expectMessage(`SELECT * FROM "${N}" WHERE pk = 1e-131`, `${UNDERFLOW} under root`)
  })

  it('a WHERE literal with 39 significant digits - exact message', async () => {
    await expectMessage(
      `SELECT * FROM "${N}" WHERE pk = 123456789012345678901234567890123456789`,
      `${DIGITS} under root`,
    )
  })

  it('an INSERT literal above the largest number - exact message', async () => {
    await expectMessage(`INSERT INTO "${N}" VALUE {'pk': 1e126}`, `${OVERFLOW} under root`)
  })

  it('an UPDATE SET literal below the smallest number - exact message', async () => {
    await expectMessage(`UPDATE "${N}" SET a = 1e-131 WHERE pk = 970005`, `${UNDERFLOW} under root`)
  })

  it('a literal inside a map names its path - exact message', async () => {
    await expectMessage(
      `INSERT INTO "${N}" VALUE {'pk': 970006, 'm': {'x': 1e126}}`,
      `${OVERFLOW} under root.x`,
    )
  })

  it('a literal inside a list names its index - exact message', async () => {
    await expectMessage(
      `INSERT INTO "${N}" VALUE {'pk': 970007, 'l': [1, 1e126]}`,
      `${OVERFLOW} under root[1]`,
    )
  })

  // ── A WHERE with nothing where a condition should start ─────────────

  it.each([
    ['WHERE at the end of a SELECT', `SELECT * FROM "${S}" WHERE`],
    ['WHERE then a semicolon', `SELECT * FROM "${S}" WHERE;`],
    ['WHERE then spaces', `SELECT * FROM "${S}" WHERE   `],
    ['WHERE after a projection', `SELECT pk FROM "${S}" WHERE`],
    ['WHERE at the end of an UPDATE', `UPDATE "${S}" SET a = 1 WHERE`],
    ['WHERE at the end of a DELETE', `DELETE FROM "${S}" WHERE`],
    ['WHERE NOT with nothing after it', `SELECT * FROM "${S}" WHERE NOT`],
    ['WHERE ( with nothing after it', `SELECT * FROM "${S}" WHERE (`],
    ['WHERE at the end, on a table that does not exist', `SELECT * FROM "${S}-never-created" WHERE`],
  ])('%s - exact message', async (_label, statement) => {
    await expectMessage(statement, `${NOT_WELL_FORMED}Unexpected term`)
  })

  it('a condition ending in AND - exact message', async () => {
    await expectMessage(`SELECT * FROM "${S}" WHERE pk = 'p1' AND`, `${NOT_WELL_FORMED}Missing right-hand side expression of infix operator`)
  })

  it('a condition ending in OR - exact message', async () => {
    await expectMessage(`SELECT * FROM "${S}" WHERE pk = 'p1' OR`, `${NOT_WELL_FORMED}Missing right-hand side expression of infix operator`)
  })

  it('WHERE followed by ORDER BY - exact message', async () => {
    await expectMessage(`SELECT * FROM "${S}" WHERE ORDER BY pk`, `${NOT_WELL_FORMED}Unexpected keyword`)
  })

  it('an empty WHERE in ExecuteTransaction - exact message', async () => {
    try {
      await ddb.send(new ExecuteTransactionCommand({ TransactStatements: [{ Statement: `SELECT * FROM "${S}" WHERE` }] }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('ValidationException')
      expect(err.message).toBe(`Validation failed in TransactStatements[0]: ${NOT_WELL_FORMED}Unexpected term`)
    }
  })

  it('an empty WHERE in BatchExecuteStatement - exact message', async () => {
    const res = await ddb.send(new BatchExecuteStatementCommand({ Statements: [{ Statement: `SELECT * FROM "${S}" WHERE` }] }))
    expect(res.Responses).toHaveLength(1)
    expect(res.Responses![0].Error?.Code).toBe('ValidationError')
    expect(res.Responses![0].Error?.Message).toBe(`${NOT_WELL_FORMED}Unexpected term`)
  })

  // ── IS with a type name, and operators where a term should start ────

  it.each(['INT4', 'INT8', 'DOUBLE PRECISION', 'CHARACTER VARYING'])(
    'IS %s parses as a type test - exact message',
    async (type) => {
      // A bare expression statement is refused once it parses; the refusal
      // names the type test, so the type name was accepted.
      await expectMessage(`x IS ${type}`, 'Unsupported operation: IsType')
    },
  )

  it('IS with a name that is not a type, in a WHERE - exact message', async () => {
    await expectMessage(`SELECT * FROM "${S}" WHERE pk = 'a' AND x IS FOO`, `${NOT_WELL_FORMED}Expected type name`)
  })

  it('IS where a WHERE condition should start - exact message', async () => {
    await expectMessage(`SELECT * FROM "${S}" WHERE IS NULL`, `${NOT_WELL_FORMED}Unexpected operator`)
  })

  it('LIKE where a comparison operand should start - exact message', async () => {
    await expectMessage(`SELECT * FROM "${S}" WHERE pk = LIKE`, `${NOT_WELL_FORMED}Unexpected operator`)
  })

  // ── A statement that stops after DELETE FROM or SELECT ... FROM ─────

  it.each([
    ['DELETE FROM', 'DELETE FROM'],
    ['DELETE FROM then spaces', 'DELETE FROM   '],
    ['DELETE FROM then a semicolon', 'DELETE FROM;'],
    ['DELETE FROM then WHERE', "DELETE FROM WHERE pk = 'a'"],
  ])('%s with no table - exact message', async (_label, statement) => {
    await expectMessage(statement, `${NOT_WELL_FORMED}Expected identifier for simple path`)
  })

  it('SELECT * FROM with no table - exact message', async () => {
    await expectMessage('SELECT * FROM', `${NOT_WELL_FORMED}Unexpected term`)
  })

  // ── The FROM-first UPDATE form ───────────────────────────────────────

  it('FROM ... SET with no WHERE - exact message', async () => {
    await expectMessage(`FROM "${S}" SET c = 1`, 'Where clause does not contain a mandatory equality on all key attributes')
  })

  it('FROM ... REMOVE with no WHERE - exact message', async () => {
    await expectMessage(`FROM "${S}" REMOVE a`, 'Where clause does not contain a mandatory equality on all key attributes')
  })

  it('FROM ... WHERE on a non-key attribute ... SET - exact message', async () => {
    await expectMessage(`FROM "${S}" WHERE a = 1 SET c = 1`, 'Where clause does not contain a mandatory equality on all key attributes')
  })

  it('FROM ... SET with the WHERE after it - exact message', async () => {
    await expectMessage(`FROM "${S}" SET c = 1 WHERE pk = 'pq-ff-msg'`, LEFTOVER)
  })

  it('FROM ... SET ... WHERE ... SET - exact message', async () => {
    await expectMessage(`FROM "${S}" SET c = 1 WHERE pk = 'pq-ff-msg' SET d = 2`, LEFTOVER)
  })

  it('FROM ... WHERE ... SET on a table that does not exist - exact error', async () => {
    const err = await rejection(`FROM "${S}-never-created" WHERE pk = 'x' SET c = 1`)
    expect(err.name).toBe('ResourceNotFoundException')
    expect(err.message).toBe('Requested resource not found')
  })

  // ── OR branches that overlap on the sort key ─────────────────────────

  it.each([
    ['a non-key equality', "x = '1'"],
    ['a non-key <>', "x <> '1'"],
  ])('an OR branch with %s beside a sort-key branch - exact message', async (_label, condition) => {
    const C = compositeTableDef.name
    await expectMessage(
      `SELECT * FROM "${C}" WHERE pk = 'a' AND ${condition} OR pk = 'a' AND sk = '2'`,
      'Overlapping conditions with range keys are not supported in where clause',
    )
  })
})
