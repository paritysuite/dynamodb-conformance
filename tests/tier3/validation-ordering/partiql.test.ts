import {
  ExecuteStatementCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { absentTableName, withBody } from '../../../src/helpers.js'
import { isUnsupportedFault } from '../../../src/infra.js'

// Which check answers first when a PartiQL statement has more than one problem.
// The wording can drift; the ordering should not, so these use `toContain`.
describe('PartiQL — validation ordering', { tags: ['partiql', 'data-plane', 'negative-path'] }, () => {
  let supported = true

  // The same canary the other PartiQL files run, so a target without the
  // operation skips rather than failing every case with an unsupported fault
  // read as the wrong validation answer. It probes a table that cannot exist,
  // which keeps this file provisioning nothing: a target with PartiQL answers
  // ResourceNotFoundException, a real answer, and one without it answers the
  // unsupported fault. UnrecognizedClientException is kept alongside because
  // it is how at least one target declines PartiQL.
  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT pk FROM "${absentTableName('vo_partiql_canary')}" WHERE pk = ?`,
        Parameters: [{ S: 'x' }],
      }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  // The operand-type check is a property of the statement, so it answers without
  // the table being resolved at all. An engine evaluating it as a comparison
  // outcome reaches the table first and reports the table missing instead.
  it('the operand-type check fires ahead of table resolution', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT pk FROM "${absentTableName('vo_partiql_missing')}" WHERE pk = ? AND val < ?`,
        Parameters: [{ S: 'x' }, { BOOL: true }],
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain('Incorrect operand type')
    }
  })

  // The same table, named correctly, still reports itself missing. Without this
  // the case above proves only that something was rejected.
  it('a well-formed statement on the same table reports it missing', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT pk FROM "${absentTableName('vo_partiql_missing')}" WHERE pk = ?`,
        Parameters: [{ S: 'x' }],
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ResourceNotFoundException')
    }
  })

  // The empty-component check also answers before the table is looked up, and
  // it applies to the table half of the path as much as the index half.
  it('an empty path component fires ahead of table resolution', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "" WHERE pk = 'x'` }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain('Path component cannot be an empty string')
    }
  })

  // Captured in eu-west-2 and us-east-1, 2026-11-05. These refusals turn on the
  // table's key schema or an index's projection, so DynamoDB looks the table up
  // first. On a table that doesn't exist each one reports the table missing.
  it.each([
    ['a negated sort-key term in an OR filter', `WHERE pk = 'k' AND (NOT sk = 's0' OR x = 0)`],
    ['a number for a partition key, twice', 'WHERE pk = 1 AND pk = 1.0'],
    ['a number for a partition key', 'WHERE pk = 1'],
    ['a boolean for a partition key', 'WHERE pk = true'],
    ['a boolean for a partition key beside two sort keys', `WHERE pk = true AND (sk = 'row-1' OR sk = 'row-2')`],
    ['ORDER BY over two branches on one partition', `WHERE (pk = 'k' AND x = 1) OR (pk = 'k' AND x = 2) ORDER BY sk DESC`],
    ['ORDER BY on the sort key over two partitions', `WHERE (pk = 'a' AND x = 1) OR (pk = 'k' AND x = 2) ORDER BY sk`],
    ['sort-key ranges that meet', `WHERE pk = 'k' AND (sk <= 'row-2' OR sk >= 'row-2')`],
    ['an unbounded OR branch beside a sort-key equality', `WHERE pk = 'k' AND (sk = 'row-1' OR x = 3)`],
  ])('%s waits for table resolution', async (_label, where) => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${absentTableName('vo_partiql_missing')}" ${where}`,
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('ResourceNotFoundException')
    }
  })

  it('an unprojected OR filter on an index waits for table resolution', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${absentTableName('vo_partiql_missing')}"."gsi-keys" WHERE gsiPk2 = 'k' AND (nonproj = 1 OR nonproj = 2)`,
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('ResourceNotFoundException')
    }
  })

  // Captured in 33 regions, 2026-11-05, none of which had the table. Limit is
  // checked as a request member, before the table is looked up.
  it.each([0, -1])('a Limit of %i fires ahead of table resolution', async (Limit) => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${absentTableName('vo_partiql_missing')}" WHERE pk = 'k'`,
        Limit,
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('ValidationException')
      expect(err.message).toContain(`Value '${Limit}' at 'limit' failed to satisfy constraint`)
    }
  })

  // Captured in eu-west-2 and us-east-1, 2026-11-05. The SDK won't send a
  // string Limit, so the body is written by hand.
  it('a Limit sent as a string fails deserialisation ahead of table resolution', async () => {
    const Statement = `SELECT * FROM "${absentTableName('vo_partiql_missing')}" WHERE pk = 'k'`
    try {
      await ddb.send(withBody(new ExecuteStatementCommand({ Statement }), { Statement, Limit: '2' }))
      expect.unreachable('should have thrown')
    } catch (err) {
      if (!(err instanceof DynamoDBServiceException)) throw err
      expect(err.name).toBe('SerializationException')
    }
  })
})
