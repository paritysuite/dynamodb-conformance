import {
  BatchExecuteStatementCommand,
  CreateTableCommand,
  DynamoDBServiceException,
  ExecuteStatementCommand,
  PutItemCommand,
  type AttributeValue,
  type ExecuteStatementCommandInput,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { isUnsupportedFault } from '../../../src/infra.js'
import { uniqueTableName, waitUntilActive, deleteTable } from '../../../src/helpers.js'

// Exact AWS strings for PartiQL reads of a global secondary index whose key has
// more than one HASH or more than one RANGE attribute, pinned against real AWS
// (eu-west-2 and us-east-1, October 2026; the two regions gave the same answers).
// tests/tier2/partiql/multiAttributeIndex.test.ts covers which statements run.
//
// The refusal names tables, but it follows the index. A statement the parser
// can't read, a literal it can't convert and a parameter that isn't a number are
// reported ahead of it; key types, the WHERE requirements and COUNT(*) come after
// it. In a BatchExecuteStatement it fails only its own statement, and it is
// reported ahead of the rule that a batch SELECT must name the primary key.
//
// The tables are created here rather than from a shared def: TestTableDef models
// one HASH and one RANGE attribute per index.
const REFUSED = 'PartiQL statements cannot be executed on tables with multi-attribute HASH keys or multi-attribute RANGE keys.'
const NOT_WELL_FORMED = "Statement wasn't well formed, can't be processed: "
const BATCH_NEEDS_KEY = 'Select statements within BatchExecuteStatement must specify the primary key in the where clause.'

describe('PartiQL - multi-attribute index exact error messages', { tags: ['partiql', 'data-plane', 'gsi', 'negative-path'] }, () => {
  let supported = true
  const S = (s: string): AttributeValue => ({ S: s })

  // Two HASH and two RANGE attributes.
  const hashRangeTable = uniqueTableName('pqMultiHhRr')
  // Two HASH attributes and one RANGE.
  const hashTable = uniqueTableName('pqMultiHhR')
  // One of each, for the batch member that fails on the key-only rule instead.
  const controlTable = uniqueTableName('pqMultiCtrl')

  function def(TableName: string, hash: string[], range: string[]) {
    return new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: ['id', ...hash, ...range].map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{
        IndexName: 'gsi',
        KeySchema: [
          ...hash.map((AttributeName) => ({ AttributeName, KeyType: 'HASH' as const })),
          ...range.map((AttributeName) => ({ AttributeName, KeyType: 'RANGE' as const })),
        ],
        Projection: { ProjectionType: 'ALL' },
      }],
    })
  }

  beforeAll(async () => {
    try {
      // The canary the other PartiQL files run: a target signalling the
      // operation is unimplemented skips rather than failing every case.
      await ddb.send(new ExecuteStatementCommand({ Statement: `SELECT * FROM "${hashTable}" WHERE id = 'canary'` }))
    } catch (e: unknown) {
      if (isUnsupportedFault(e) || (e instanceof Error && e.name === 'UnrecognizedClientException')) {
        supported = false
        return
      }
    }
    await Promise.all([
      ddb.send(def(hashRangeTable, ['h1', 'h2'], ['r1', 'r2'])),
      ddb.send(def(hashTable, ['h1', 'h2'], ['r1'])),
      ddb.send(def(controlTable, ['h1'], ['r1'])),
    ])
    await Promise.all([waitUntilActive(hashRangeTable), waitUntilActive(hashTable), waitUntilActive(controlTable)])
    await ddb.send(new PutItemCommand({
      TableName: hashRangeTable,
      Item: { id: S('i1'), h1: S('a'), h2: S('x'), r1: S('m'), r2: S('n') },
    }))
    for (const TableName of [hashTable, controlTable]) {
      await ddb.send(new PutItemCommand({ TableName, Item: { id: S('i1'), h1: S('a'), h2: S('x'), r1: S('m') } }))
    }
  })

  afterAll(async () => {
    if (!supported) return
    await Promise.all([deleteTable(hashRangeTable), deleteTable(hashTable), deleteTable(controlTable)])
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  /** Run a statement and hand back the exception it raises. */
  async function rejection(input: ExecuteStatementCommandInput) {
    try {
      await ddb.send(new ExecuteStatementCommand(input))
      expect.unreachable('should have thrown')
      throw new Error('unreachable')
    } catch (err) {
      if (err instanceof DynamoDBServiceException) return err
      throw err
    }
  }

  async function expectMessage(Statement: string, message: string, extra: Partial<ExecuteStatementCommandInput> = {}) {
    const err = await rejection({ Statement, ...extra })
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(message)
  }

  // ── The refusal ───────────────────────────────────────────────────────

  it('a SELECT on a GSI with two HASH and two RANGE attributes - exact message', async () => {
    await expectMessage(`SELECT * FROM "${hashRangeTable}"."gsi" WHERE h1 = 'a'`, REFUSED)
  })

  it('a SELECT on a GSI with two HASH attributes and one RANGE - exact message', async () => {
    await expectMessage(`SELECT * FROM "${hashTable}"."gsi" WHERE h1 = 'a'`, REFUSED)
  })

  it('a SELECT with ORDER BY on a multi-attribute GSI - exact message', async () => {
    await expectMessage(
      `SELECT id FROM "${hashRangeTable}"."gsi" WHERE h1 = 'a' AND h2 = 'x' ORDER BY r1 DESC`,
      REFUSED,
    )
  })

  // ── What is reported ahead of it ──────────────────────────────────────

  it('a statement that breaks off reports its syntax error ahead of the refusal', async () => {
    await expectMessage(`SELECT * FROM "${hashTable}"."gsi" WHERE`, `${NOT_WELL_FORMED}Unexpected term`)
  })

  it('a number literal that cannot be converted is reported ahead of the refusal', async () => {
    await expectMessage(`SELECT * FROM "${hashTable}"."gsi" WHERE h1 = 1e99999999999`, NOT_WELL_FORMED)
  })

  it('a parameter that cannot be converted to a number is reported ahead of the refusal', async () => {
    await expectMessage(
      `SELECT * FROM "${hashTable}"."gsi" WHERE h1 = ?`,
      'The parameter cannot be converted to a numeric value: 1e99999999999',
      { Parameters: [{ N: '1e99999999999' }] },
    )
  })

  // ── What it is reported ahead of ──────────────────────────────────────

  it('the refusal is reported ahead of a key type mismatch, a non-key WHERE, a missing WHERE and COUNT(*)', async () => {
    const G = `"${hashTable}"."gsi"`
    await expectMessage(`SELECT * FROM ${G} WHERE h1 = 5`, REFUSED)
    await expectMessage(`SELECT * FROM ${G} WHERE id = 'i1'`, REFUSED)
    await expectMessage(`SELECT * FROM ${G}`, REFUSED)
    await expectMessage(`SELECT COUNT(*) FROM ${G}`, REFUSED)
  })

  // ── In a batch ────────────────────────────────────────────────────────

  it('in a BatchExecuteStatement only the statement reading the index fails, ahead of the key-only rule', async () => {
    const res = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `SELECT * FROM "${controlTable}"."gsi" WHERE h1 = 'a' AND r1 = 'm'` },
        { Statement: `SELECT * FROM "${hashTable}"."gsi" WHERE h1 = 'a' AND h2 = 'x' AND r1 = 'm'` },
        { Statement: `SELECT * FROM "${hashTable}" WHERE id = 'i1'` },
      ],
    }))
    const [control, multi, base] = res.Responses!
    expect(control.Error?.Code).toBe('ValidationError')
    expect(control.Error?.Message).toBe(BATCH_NEEDS_KEY)
    expect(multi.Error?.Code).toBe('ValidationError')
    expect(multi.Error?.Message).toBe(REFUSED)
    expect(base.Error).toBeUndefined()
    expect(base.Item?.id).toEqual(S('i1'))
  })
})
