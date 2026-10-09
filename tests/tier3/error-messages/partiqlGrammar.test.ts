import {
  ExecuteStatementCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { declareTables, hashTableDef, hashNTableDef } from '../../../src/helpers.js'

declareTables(hashTableDef, hashNTableDef)

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
})
