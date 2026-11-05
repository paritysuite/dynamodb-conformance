import {
  CreateTableCommand,
  DeleteTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  UpdateTableCommand,
  UpdateContinuousBackupsCommand,
  ListTablesCommand,
  QueryCommand,
  DynamoDBServiceException,
  ResourceInUseException,
  ResourceNotFoundException,
  type CreateTableCommandInput,
  type AttributeDefinition,
  type KeySchemaElement,
  type GlobalSecondaryIndex,
  type LocalSecondaryIndex,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from './client.js'
import { region } from './aws-config.js'
import { IndeterminateError, indeterminateFrom } from './indeterminate.js'
import { ceilingsFor } from './regions.js'
import type { TestTableDef } from './types.js'
import { resolveTablePrefix } from './table-namespace.js'

// The namespace this run owns. Resolved in vitest.config.ts before any worker
// spawns and pinned into the environment there, so the worker that creates the
// tables and the main-process teardown that sweeps them agree on one prefix.
// src/table-namespace.ts carries the reasoning.
const TABLE_PREFIX = resolveTablePrefix()
let counter = 0

/** Whether a table name belongs to the namespace this run owns. */
export function isSuiteTable(name: string, prefix: string = TABLE_PREFIX): boolean {
  return name.startsWith(prefix)
}

/**
 * A name in this run's namespace that nothing creates, for tests needing a
 * table that does not exist. It still has to sit inside the namespace: a name
 * outside it is refused by IAM before DynamoDB can answer that it is missing,
 * and the test sees AccessDeniedException instead of ResourceNotFoundException.
 */
export function absentTableName(suffix: string): string {
  return `${TABLE_PREFIX}${suffix}`
}

/** Generate a unique table name for this test run */
export function uniqueTableName(base: string): string {
  return `${TABLE_PREFIX}${base}_${Date.now()}_${counter++}`
}

/** Build a CreateTableCommand input from a TestTableDef */
function buildCreateInput(def: TestTableDef): CreateTableCommandInput {
  const attrs: AttributeDefinition[] = [
    { AttributeName: def.hashKey.name, AttributeType: def.hashKey.type },
  ]
  const keySchema: KeySchemaElement[] = [
    { AttributeName: def.hashKey.name, KeyType: 'HASH' },
  ]

  if (def.rangeKey) {
    attrs.push({
      AttributeName: def.rangeKey.name,
      AttributeType: def.rangeKey.type,
    })
    keySchema.push({ AttributeName: def.rangeKey.name, KeyType: 'RANGE' })
  }

  const gsis: GlobalSecondaryIndex[] = []
  if (def.gsis) {
    for (const g of def.gsis) {
      if (!attrs.find((a) => a.AttributeName === g.hashKey.name)) {
        attrs.push({
          AttributeName: g.hashKey.name,
          AttributeType: g.hashKey.type,
        })
      }
      const gsiKeySchema: KeySchemaElement[] = [
        { AttributeName: g.hashKey.name, KeyType: 'HASH' },
      ]
      if (g.rangeKey) {
        if (!attrs.find((a) => a.AttributeName === g.rangeKey!.name)) {
          attrs.push({
            AttributeName: g.rangeKey.name,
            AttributeType: g.rangeKey.type,
          })
        }
        gsiKeySchema.push({ AttributeName: g.rangeKey.name, KeyType: 'RANGE' })
      }
      gsis.push({
        IndexName: g.indexName,
        KeySchema: gsiKeySchema,
        Projection: {
          ProjectionType: g.projectionType,
          ...(g.nonKeyAttributes
            ? { NonKeyAttributes: g.nonKeyAttributes }
            : {}),
        },
        ...(def.billingMode !== 'PAY_PER_REQUEST'
          ? {
              ProvisionedThroughput: {
                ReadCapacityUnits: 5,
                WriteCapacityUnits: 5,
              },
            }
          : {}),
      })
    }
  }

  const lsis: LocalSecondaryIndex[] = []
  if (def.lsis) {
    for (const l of def.lsis) {
      if (!attrs.find((a) => a.AttributeName === l.rangeKey.name)) {
        attrs.push({
          AttributeName: l.rangeKey.name,
          AttributeType: l.rangeKey.type,
        })
      }
      lsis.push({
        IndexName: l.indexName,
        KeySchema: [
          { AttributeName: def.hashKey.name, KeyType: 'HASH' },
          { AttributeName: l.rangeKey.name, KeyType: 'RANGE' },
        ],
        Projection: {
          ProjectionType: l.projectionType,
          ...(l.nonKeyAttributes
            ? { NonKeyAttributes: l.nonKeyAttributes }
            : {}),
        },
      })
    }
  }

  return {
    TableName: def.name,
    AttributeDefinitions: attrs,
    KeySchema: keySchema,
    ...(gsis.length ? { GlobalSecondaryIndexes: gsis } : {}),
    ...(lsis.length ? { LocalSecondaryIndexes: lsis } : {}),
    ...(def.billingMode === 'PAY_PER_REQUEST'
      ? { BillingMode: 'PAY_PER_REQUEST' as const }
      : {
          ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5,
          },
        }),
  }
}

/** Wait until a table reaches ACTIVE status (and all GSIs are ACTIVE) */
export async function waitUntilActive(
  tableName: string,
  timeoutMs = ceilingsFor(region).tableActiveMs,
): Promise<void> {
  const start = Date.now()
  let delay = 0
  while (Date.now() - start < timeoutMs) {
    const res = await ddb.send(
      new DescribeTableCommand({ TableName: tableName }),
    )
    const table = res.Table
    if (!table) throw new Error(`DescribeTable returned no Table for ${tableName}`)

    const tableActive = table.TableStatus === 'ACTIVE'
    const gsisActive =
      !table.GlobalSecondaryIndexes ||
      table.GlobalSecondaryIndexes.every((i) => i.IndexStatus === 'ACTIVE')

    if (tableActive && gsisActive) return

    if (delay > 0) await sleep(delay)
    delay = Math.min(delay || 500, 2000)
  }
  // A ceiling expiring is not an answer from DynamoDB: the table may well have
  // gone ACTIVE moments later. Typed so it can never read as a behavioural
  // disagreement downstream.
  throw new IndeterminateError(
    'table-active-timeout',
    `Timeout waiting for table ${tableName} to become ACTIVE`,
  )
}

/**
 * Create a table from a TestTableDef and wait for it to become ACTIVE.
 *
 * Idempotent on the create itself. An attempt whose CreateTable succeeded but
 * whose activation wait timed out leaves the table behind, and table names are
 * fixed for the run - so the retry must adopt the existing table rather than
 * collide with it. Without this, one slow activation turns every later file's
 * provisioning into ResourceInUseException, which is a real answer rather than
 * an indeterminate one and would publish a run of false disagreements.
 */
export async function createTable(def: TestTableDef): Promise<void> {
  const input = buildCreateInput(def)
  try {
    await ddb.send(new CreateTableCommand(input))
  } catch (e: unknown) {
    if (!(e instanceof ResourceInUseException)) throw e
  }
  await waitUntilActive(def.name)
}

/** Delete a table, ignoring ResourceNotFoundException and ResourceInUseException */
export async function deleteTable(tableName: string): Promise<void> {
  try {
    await ddb.send(new DeleteTableCommand({ TableName: tableName }))
    // Wait until gone
    const start = Date.now()
    let delay = 0
    while (Date.now() - start < 30_000) {
      try {
        await ddb.send(new DescribeTableCommand({ TableName: tableName }))
        if (delay > 0) await sleep(delay)
        delay = Math.min(delay || 500, 2000)
      } catch (e: unknown) {
        if (e instanceof ResourceNotFoundException) return
        throw e
      }
    }
  } catch (e: unknown) {
    if (e instanceof ResourceNotFoundException) return
    if (e instanceof ResourceInUseException) return // already being deleted
    // A deletion-protected table cannot be deleted until protection is
    // disabled. Disable and retry once so cleanup is robust.
    if (
      e instanceof DynamoDBServiceException &&
      e.name === 'ValidationException' &&
      /protected against deletion|deletion protection is enabled/i.test(e.message)
    ) {
      // Best-effort: disable protection then delete. A target that blocks the
      // delete but rejects the protection toggle (some emulators) must not make
      // cleanup throw and poison the run.
      try {
        await disableDeletionProtection(tableName)
        await waitUntilActive(tableName)
        await ddb.send(new DeleteTableCommand({ TableName: tableName }))
      } catch {
        // give up; cleanup is best-effort
      }
      return
    }
    throw e
  }
}

/**
 * Retry an operation while DynamoDB is still enabling continuous backups on a
 * freshly-created table (CreateBackup and UpdateContinuousBackups both throw
 * ContinuousBackupsUnavailableException during that window).
 */
export async function retryWhileBackupsEnabling<T>(
  fn: () => Promise<T>,
  timeoutMs = 120_000,
): Promise<T> {
  const start = Date.now()
  let delay = 0
  for (;;) {
    try {
      return await fn()
    } catch (e: unknown) {
      if (
        e instanceof DynamoDBServiceException &&
        e.name === 'ContinuousBackupsUnavailableException' &&
        Date.now() - start < timeoutMs
      ) {
        if (delay > 0) await sleep(delay)
        delay = Math.min(delay || 2000, 5000)
        continue
      }
      throw e
    }
  }
}

/** Enable point-in-time recovery, waiting out the post-create enabling window. */
export async function enablePitr(tableName: string): Promise<void> {
  await retryWhileBackupsEnabling(() =>
    ddb.send(
      new UpdateContinuousBackupsCommand({
        TableName: tableName,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    ),
  )
}

/**
 * Disable deletion protection, absorbing DynamoDB's throttle on changing the
 * deletion-protection setting more than once per 15 seconds.
 */
async function disableDeletionProtection(tableName: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateTableCommand({ TableName: tableName, DeletionProtectionEnabled: false }),
    )
  } catch (e: unknown) {
    if (e instanceof DynamoDBServiceException && e.name === 'ThrottlingException') {
      await sleep(16_000)
      try {
        await ddb.send(
          new UpdateTableCommand({ TableName: tableName, DeletionProtectionEnabled: false }),
        )
      } catch (e2: unknown) {
        // A throttle that outlasts both the SDK's retry and this 16-second
        // backoff never produced an answer; surface it typed.
        throw indeterminateFrom(e2) ?? e2
      }
      return
    }
    throw e
  }
}

// ── Demand-driven provisioning ────────────────────────────────────────
//
// A test file declares the shared tables it needs at module scope, and setup
// creates only the tables declared by the file whose hook is running.
//
// Scoping to the declaring file is load-bearing, not tidiness. `--tags-filter`
// skips tests; it does not deselect files, so vitest still imports an excluded
// file and its declaration still registers. Its setup hook does not run,
// though, so keying declarations by file is what stops an excluded axis
// creating its tables - provisioning the whole registry would create them on
// behalf of the next file that runs.
//
// Module scope rather than inside a hook because a static declaration can be
// checked by scripts/table-declarations.test.mjs; a missing declaration would
// otherwise surface only as a runtime missing-table error, and only on a run
// narrow enough that no other file declared the same table.

interface TableRegistry {
  // `this: void` so unbinding these onto module-level consts below stays safe:
  // a future edit reaching for `this` fails to compile rather than at runtime.
  declare: (this: void, ...defs: TestTableDef[]) => void
  declaredDefs: (this: void) => TestTableDef[]
  declaredBy: (this: void, file: string) => TestTableDef[]
  provision: (
    this: void,
    create?: (def: TestTableDef) => Promise<void>,
    file?: string,
  ) => Promise<void>
  sweepOnce: (this: void, sweep?: () => Promise<void>) => Promise<void>
}

/**
 * The file vitest is currently importing or running, used to scope
 * declarations. Available at module-import time as well as inside hooks.
 */
function currentTestFile(): string {
  return expect.getState().testPath ?? 'unknown'
}

/** A declaration set, creation memo and sweep guard. A factory so the
 * memoisation and retry behaviour can be tested without real AWS. */
export function createTableRegistry(): TableRegistry {
  const declared = new Map<string, TestTableDef>()
  const declaringFiles = new Map<string, Set<string>>()
  const inFlight = new Map<string, Promise<void>>()
  let swept: Promise<void> | null = null

  return {
    declare(...defs: TestTableDef[]): void {
      const file = currentTestFile()
      for (const def of defs) {
        declared.set(def.name, def)
        const files = declaringFiles.get(file) ?? new Set<string>()
        files.add(def.name)
        declaringFiles.set(file, files)
      }
    },

    declaredDefs(): TestTableDef[] {
      return [...declared.values()]
    },

    declaredBy(file: string): TestTableDef[] {
      const names = declaringFiles.get(file) ?? new Set<string>()
      return [...names].flatMap((n) => {
        const def = declared.get(n)
        return def ? [def] : []
      })
    },

    async provision(create = createTable, file = currentTestFile()): Promise<void> {
      const names = declaringFiles.get(file) ?? new Set<string>()
      await Promise.all(
        [...names].map((name) => {
          const def = declared.get(name)
          if (!def) return Promise.resolve()
          const existing = inFlight.get(def.name)
          if (existing) return existing
          // Drop a rejected attempt from the memo so the next file retries it
          // instead of replaying the rejection.
          const attempt = create(def).catch((e: unknown) => {
            inFlight.delete(def.name)
            throw e
          })
          inFlight.set(def.name, attempt)
          return attempt
        }),
      )
    },

    // Guarded separately from provisioning: provisioning runs per file, and a
    // sweep sharing that guard would delete tables earlier files are using.
    sweepOnce(sweep = cleanupAllTables): Promise<void> {
      if (!swept) {
        swept = sweep().catch((e: unknown) => {
          swept = null
          throw e
        })
      }
      return swept
    },
  }
}

// Shared across every test file only because the suite runs as a single
// non-isolated fork (maxWorkers: 1, isolate: false in vitest.config.ts), the
// same property the table defs below rely on for their names.
const registry = createTableRegistry()

/** Declare the shared tables a file uses. Call once at module scope. */
export const declareTables = registry.declare

/** Every shared table declared by the files collected so far. */
export const declaredTableDefs = registry.declaredDefs

/** The shared tables one test file declared. */
export const tablesDeclaredBy = registry.declaredBy

/** Create the current file's declared tables. Safe to call per file. */
export const provisionDeclaredTables = registry.provision

/** Sweep leftover tables exactly once per run, before anything is created. */
export const cleanupAllTablesOnce = registry.sweepOnce

/** Delete all tables created by the conformance suite */
export async function cleanupAllTables(): Promise<void> {
  const allNames: string[] = []
  let exclusiveStartTableName: string | undefined
  do {
    const res = await ddb.send(
      new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }),
    )
    const names = (res.TableNames ?? []).filter((n) => isSuiteTable(n))
    allNames.push(...names)
    exclusiveStartTableName = res.LastEvaluatedTableName
  } while (exclusiveStartTableName)

  for (let i = 0; i < allNames.length; i += 10) {
    // Best-effort: one undeletable table (e.g. a deletion-protected table on a
    // target that won't toggle protection off) must not poison setup.
    await Promise.all(
      allNames.slice(i, i + 10).map((n) => deleteTable(n).catch(() => {})),
    )
  }
}

/** Assert that a DynamoDB error has the expected name and message pattern */
export function assertDynamoError(
  error: unknown,
  expectedName: string,
  expectedMessage?: string | RegExp,
): void {
  expect(error).toBeDefined()
  expect(error).toBeInstanceOf(DynamoDBServiceException)
  const err = error as DynamoDBServiceException
  expect(err.name).toBe(expectedName)
  if (expectedMessage) {
    if (typeof expectedMessage === 'string') {
      expect(err.message).toContain(expectedMessage)
    } else {
      expect(err.message).toMatch(expectedMessage)
    }
  }
}

/** Expect an async function to throw a DynamoDB error with the given name/message */
export async function expectDynamoError(
  fn: () => Promise<unknown>,
  expectedName: string,
  expectedMessage?: string | RegExp,
): Promise<void> {
  try {
    await fn()
    expect.unreachable('should have thrown')
  } catch (e) {
    assertDynamoError(e, expectedName, expectedMessage)
  }
}

/** Delete a batch of items by key, ignoring errors */
export async function cleanupItems(
  tableName: string,
  keys: Record<string, AttributeValue>[],
): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      ddb.send(new DeleteItemCommand({ TableName: tableName, Key: key })).catch(() => {}),
    ),
  )
}

interface WaitForGsiOptions {
  tableName: string
  indexName: string
  partitionKey: { name: string; value: AttributeValue }
  expectedCount: number
  timeoutMs?: number
}

/** Wait for GSI to reflect the expected number of items */
export async function waitForGsiConsistency(opts: WaitForGsiOptions): Promise<void> {
  const {
    tableName,
    indexName,
    partitionKey,
    expectedCount,
    timeoutMs = ceilingsFor(region).gsiConsistencyMs,
  } = opts
  const start = Date.now()
  let delay = 0
  while (Date.now() - start < timeoutMs) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': partitionKey.name },
        ExpressionAttributeValues: { ':pk': partitionKey.value },
      }),
    )
    if ((res.Count ?? 0) >= expectedCount) return
    if (delay > 0) await sleep(delay)
    delay = Math.min((delay || 250) * 1.5, 2000)
  }
  // An index that has not settled within the ceiling is a failed observation,
  // not evidence about what the index would eventually return.
  throw new IndeterminateError(
    'gsi-consistency-timeout',
    `Timeout waiting for GSI ${indexName} consistency (expected ${expectedCount} items)`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Shared table definitions ──────────────────────────────────────────
// These mirror the dynalite test tables so we can port tests directly.

export const hashTableDef: TestTableDef = {
  name: uniqueTableName('hash'),
  hashKey: { name: 'pk', type: 'S' },
  // On-demand, like hashNTableDef. The shared tables live for the whole run
  // (provisioned once), so a provisioned 5-WCU table runs out of burst capacity
  // under a run's worth of writes and throttles. Nothing asserts this table is
  // provisioned; createTable/config covers that mode. The near-400KB writes that
  // first forced this now have itemSizeTableDef to themselves.
  billingMode: 'PAY_PER_REQUEST',
}

export const hashNTableDef: TestTableDef = {
  name: uniqueTableName('hashN'),
  hashKey: { name: 'pk', type: 'N' },
  billingMode: 'PAY_PER_REQUEST',
}

// Binary partition key. The other shared defs are string- or number-keyed, so an
// empty-binary key value only reaches the binary key validator on a table whose
// key attribute is declared type B. Used by the empty-binary key-value cases,
// which pin the `Key: pk` message real AWS returns for a zero-length binary key.
export const hashBTableDef: TestTableDef = {
  name: uniqueTableName('hashB'),
  hashKey: { name: 'pk', type: 'B' },
  billingMode: 'PAY_PER_REQUEST',
}

// Binary-typed GSI key. Used by the empty-binary secondary-index-key cases,
// which need a table whose index key attribute is declared type B so an empty
// binary value reaches the secondary-index-key validator rather than a
// type-mismatch check.
export const gsiBTableDef: TestTableDef = {
  name: uniqueTableName('gsiB'),
  hashKey: { name: 'pk', type: 'S' },
  gsis: [
    {
      indexName: 'gsib',
      hashKey: { name: 'bidx', type: 'B' },
      projectionType: 'ALL',
    },
  ],
  billingMode: 'PAY_PER_REQUEST',
}

// The generic composite-key table. No secondary index, so a run excluding both
// index axes creates nothing an index-free engine would reject.
export const compositeTableDef: TestTableDef = {
  name: uniqueTableName('composite'),
  hashKey: { name: 'pk', type: 'S' },
  rangeKey: { name: 'sk', type: 'S' },
}

// The same key schema carrying the secondary indexes. Index names, projections
// and key attributes are unchanged - tests pin messages naming `gsi1` and
// `lsi1sk` exactly. One indexed variant carries both kinds, so excluding both
// axes together is the guarantee and excluding one is not; see README.
export const compositeIndexedTableDef: TestTableDef = {
  ...compositeTableDef,
  name: uniqueTableName('compositeIdx'),
  lsis: [
    {
      indexName: 'lsi1',
      rangeKey: { name: 'lsi1sk', type: 'S' },
      projectionType: 'ALL',
    },
    {
      indexName: 'lsi2',
      rangeKey: { name: 'lsi2sk', type: 'S' },
      projectionType: 'INCLUDE',
      nonKeyAttributes: ['lsi1sk'],
    },
  ],
  gsis: [
    {
      indexName: 'gsi1',
      hashKey: { name: 'lsi1sk', type: 'S' },
      projectionType: 'ALL',
    },
    {
      indexName: 'gsi2',
      hashKey: { name: 'lsi1sk', type: 'S' },
      rangeKey: { name: 'lsi2sk', type: 'S' },
      projectionType: 'INCLUDE',
      nonKeyAttributes: ['data'],
    },
  ],
}

// The fixture the August 2026 PartiQL index-qualifier captures were taken
// against, mirrored so a case that behaves oddly can be replayed against the
// recorded answer without translating between two schemas.
//
// Separate from compositeIndexedTableDef rather than an extension of it. That
// def carries no KEYS_ONLY index and no attribute left unprojected by every
// index, which is what the projection, reach-back and unprojected-filter rules
// all turn on; extending it would also move the gsi/lsi tag surface for every
// file already using it, and existing tests pin messages naming `gsi1` and
// `lsi1sk` exactly.
//
// Index names match the capture. They appear verbatim in the rejection messages
// this fixture exists to assert, so they are part of the fixture rather than
// incidental.
export const partiqlIndexTableDef: TestTableDef = {
  name: uniqueTableName('partiqlIdx'),
  hashKey: { name: 'pk', type: 'S' },
  rangeKey: { name: 'sk', type: 'S' },
  gsis: [
    { indexName: 'gsi-all', hashKey: { name: 'gsiPk', type: 'S' }, projectionType: 'ALL' },
    {
      indexName: 'gsi-inc',
      hashKey: { name: 'gsiPk2', type: 'S' },
      projectionType: 'INCLUDE',
      nonKeyAttributes: ['projattr'],
    },
    { indexName: 'gsi-keys', hashKey: { name: 'gsiPk2', type: 'S' }, projectionType: 'KEYS_ONLY' },
  ],
  lsis: [
    { indexName: 'lsi-all', rangeKey: { name: 'lsiSk', type: 'S' }, projectionType: 'ALL' },
    { indexName: 'lsi-keys', rangeKey: { name: 'lsiSk2', type: 'S' }, projectionType: 'KEYS_ONLY' },
    // The reach-back capture's own index. A KEYS_ONLY LSI projects nothing but
    // keys, so it has no non-key attribute to filter on, and a filter on its
    // sort key is a key condition that narrows the scan rather than a filter
    // applied to rows already read. Separating rows walked from rows kept needs
    // an index projecting something that is not a key.
    {
      indexName: 'lsi-inc',
      rangeKey: { name: 'lsiSk3', type: 'S' },
      projectionType: 'INCLUDE',
      nonKeyAttributes: ['projattr'],
    },
  ],
}

/**
 * The attribute no *non-ALL* index in partiqlIndexTableDef projects. `gsi-all`
 * and `lsi-all` project everything, this attribute included, so a case testing
 * the projection or filter rules must name one of the other four indexes.
 *
 * Against those four: naming it in a projection is rejected on a GSI and served
 * from the base table on an LSI; naming it in a filter is rejected on either,
 * but only when the read is keyed on the index partition key.
 */
export const PARTIQL_UNPROJECTED_ATTR = 'nonproj'

// The tables the 400KB item-size work writes to, and nothing else does.
//
// Those tests write items a few bytes under the item limit, dozens of them, and
// that is not a neighbour the shared tables can carry. A Scan reads a bounded
// amount of data per page, so a handful of near-400KB rows fills the first page
// on its own and every other row in the table falls onto a page the reading test
// never asks for. tests/tier1/scan/filterOperators.test.ts reads one page and
// counts what matched, which is a fair thing to do on a table holding six small
// rows and impossible on one holding six large ones. Separate tables, and the
// question does not arise.
export const itemSizeTableDef: TestTableDef = {
  name: uniqueTableName('itemSize'),
  hashKey: { name: 'pk', type: 'S' },
  // A provisioned table runs out of burst capacity partway through a run of
  // near-400KB writes and throttles, which reads as a rejection the size gate
  // did not make.
  billingMode: 'PAY_PER_REQUEST',
}

/** The composite-key variant, for the cases that need a sort key. */
export const itemSizeCompositeTableDef: TestTableDef = {
  name: uniqueTableName('itemSizeComposite'),
  hashKey: { name: 'pk', type: 'S' },
  rangeKey: { name: 'sk', type: 'S' },
  billingMode: 'PAY_PER_REQUEST',
}

// A partition key whose *name* carries bytes. Every other shared def names its
// key `pk`, which is two bytes, so nothing in the suite could separate the key
// name's contribution to a figure from the key value's.
//
// UpdateItem is where that matters: it excludes the key attributes from the size
// it measures against the 400KB gate, names included, so lengthening the name
// buys back exactly the headroom that lengthening the value does. A def with a
// 16-byte key name makes the two halves comparable at one keystroke.
export const longKeyNameTableDef: TestTableDef = {
  name: uniqueTableName('longKeyName'),
  hashKey: { name: 'partitionKeyName', type: 'S' },
  // On-demand, like the other defs the near-400KB writes use: a provisioned
  // table runs out of burst capacity and throttles, which would read as a
  // rejection the size gate did not make.
  billingMode: 'PAY_PER_REQUEST',
}

export const compositeNTableDef: TestTableDef = {
  name: uniqueTableName('compositeN'),
  hashKey: { name: 'pk', type: 'S' },
  rangeKey: { name: 'sk', type: 'N' },
}

export const compositeBTableDef: TestTableDef = {
  name: uniqueTableName('compositeB'),
  hashKey: { name: 'pk', type: 'S' },
  rangeKey: { name: 'sk', type: 'B' },
}

// Replaces a command's serialised body before signing. The SDK drops null
// members and refuses wrong-typed ones, so a raw body is the only way to send
// them. A string body is sent as written, for number spellings such as `1.0`
// or `1e+20` that JSON.stringify would rewrite.
export function withBody<C extends { middlewareStack: { add: (...args: any[]) => void } }>(
  command: C,
  body: Record<string, unknown> | string,
): C {
  const json = typeof body === 'string' ? body : JSON.stringify(body)
  command.middlewareStack.add(
    (next: (args: any) => Promise<unknown>) => async (args: any) => {
      args.request.body = json
      args.request.headers['content-length'] = String(Buffer.byteLength(json))
      return next(args)
    },
    { step: 'build', priority: 'high', name: 'rawBody' },
  )
  return command
}
