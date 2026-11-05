import {
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import {
  declareTables,
  partiqlIndexTableDef,
  PARTIQL_UNPROJECTED_ATTR,
} from '../../../src/helpers.js'

declareTables(partiqlIndexTableDef)

const TABLE = partiqlIndexTableDef.name

/** Run a statement and hand back the exception it raises. */
async function rejection(Statement: string, extra: Record<string, unknown> = {}) {
  try {
    await ddb.send(new ExecuteStatementCommand({ Statement, ...extra }))
    // Thrown, then rethrown below, so a wrongly-accepted statement reports
    // itself rather than reporting that an assertion error is not an AWS error.
    expect.unreachable(`should have been rejected: ${Statement}`)
    throw new Error('unreachable')
  } catch (err) {
    if (err instanceof DynamoDBServiceException) return err
    throw err
  }
}

// Exact AWS strings for the index-qualifier rejections, pinned against real AWS
// (eu-west-2). Tier 2 (tests/tier2/partiql/indexQualifier.test.ts) asserts the
// shape; this file pins the wording.
//
// Separate from partiql.test.ts because it declares the indexed fixture, and a
// file declaring one carries `gsi` and `lsi` so an index-free target excludes it
// before setup tries to create the table.
describe('PartiQL index qualifier — exact error messages', { tags: ['partiql', 'data-plane', 'gsi', 'lsi', 'negative-path'] }, () => {
  let supported = true

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${TABLE}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  // Note the wording: `Secondary index`, with neither `Global` nor `Local` in
  // front, on both kinds. Query builds its own string for the same condition, so
  // a shared constant would make one of them wrong.
  it('unprojected filter attribute on a GSI — exact message', async () => {
    const err = await rejection(
      `SELECT pk FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y' AND ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
    )
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(
      `One or more parameter values were invalid: Secondary index gsi-inc does not project one or more filter attributes: [${PARTIQL_UNPROJECTED_ATTR}]`,
    )
  })

  it('unprojected filter attribute on an LSI — same wording, no Local prefix', async () => {
    const err = await rejection(
      `SELECT pk FROM "${TABLE}"."lsi-keys" WHERE pk = 'p' AND ${PARTIQL_UNPROJECTED_ATTR} = 'np1'`,
    )
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(
      `One or more parameter values were invalid: Secondary index lsi-keys does not project one or more filter attributes: [${PARTIQL_UNPROJECTED_ATTR}]`,
    )
  })

  // Captured in eu-west-2 and us-east-1, 2026-11-03. An OR over the unprojected
  // attribute gets the same message as a single condition on it, whether the
  // index key is one value or an IN list the branches share.
  it.each([
    ['one key value', `gsiPk2 = 'k'`],
    ['an IN list', `gsiPk2 IN ['k', 'a']`],
  ])('unprojected attribute in an OR filter on a KEYS_ONLY GSI, keyed on %s - exact message', async (_label, key) => {
    const err = await rejection(
      `SELECT * FROM "${TABLE}"."gsi-keys" WHERE ${key} AND (${PARTIQL_UNPROJECTED_ATTR} = 1 OR ${PARTIQL_UNPROJECTED_ATTR} = 2)`,
    )
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(
      `One or more parameter values were invalid: Secondary index gsi-keys does not project one or more filter attributes: [${PARTIQL_UNPROJECTED_ATTR}]`,
    )
  })

  // The projection rejection is worded differently, and this half does name the
  // index kind.
  it('unprojected projection attribute on a GSI — exact message', async () => {
    const err = await rejection(
      `SELECT ${PARTIQL_UNPROJECTED_ATTR} FROM "${TABLE}"."gsi-inc" WHERE gsiPk2 = 'y'`,
    )
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(
      `One or more parameter values were invalid: Global secondary index gsi-inc does not project [${PARTIQL_UNPROJECTED_ATTR}]`,
    )
  })

  // The trap is the absent suffix. Query builds the same sentence and appends
  // the index name; this surface does not.
  it('a qualifier naming no index — exact message, with no name appended', async () => {
    const err = await rejection(`SELECT * FROM "${TABLE}"."no-such-index" WHERE pk = 'p'`)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe('The table does not have the specified index')
  })

  it('a qualifier naming the table itself — same message', async () => {
    const err = await rejection(`SELECT * FROM "${TABLE}"."${TABLE}" WHERE pk = 'p'`)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe('The table does not have the specified index')
  })

  it('a three-component path — exact message', async () => {
    const err = await rejection(`SELECT * FROM "${TABLE}"."gsi-all"."extra" WHERE pk = 'p'`)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe('A path may contain at most 2 components in the FROM clause')
  })

  it('an empty index component — exact message', async () => {
    const err = await rejection(`SELECT * FROM "${TABLE}"."" WHERE pk = 'p'`)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe('Path component cannot be an empty string')
  })

  // Query answers the same condition in different words, and pins it in
  // tests/tier3/error-messages/indexReads.test.ts. Two surfaces, two wordings:
  // a shared constant would make one of them wrong, so both stay pinned where
  // they are rather than being folded together here.
  it('ConsistentRead against a GSI qualifier — exact message', async () => {
    const err = await rejection(
      `SELECT * FROM "${TABLE}"."gsi-all" WHERE gsiPk = 'x'`,
      { ConsistentRead: true },
    )
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe('Strongly consistent read is not supported on Global Secondary Indexes')
  })

  it('an index-qualified read inside a transaction — exact message', async () => {
    try {
      await ddb.send(new ExecuteTransactionCommand({
        TransactStatements: [
          { Statement: `SELECT * FROM "${TABLE}"."gsi-all" WHERE gsiPk = 'x'` },
        ],
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('ValidationException')
      expect(err.message).toBe(
        'Validation failed in TransactStatements[0]: Reads on indices are not supported within transactions.',
      )
    }
  })
})
