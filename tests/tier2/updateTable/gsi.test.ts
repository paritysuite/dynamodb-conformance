import {
  CreateTableCommand,
  UpdateTableCommand,
  DescribeTableCommand,
  PutItemCommand,
  QueryCommand,
  GetItemCommand,
  type AttributeDefinition,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  uniqueTableName,
  waitUntilActive,
  deleteTable,
  expectDynamoError,
  waitForGsiConsistency,
} from '../../../src/helpers.js'
import { region } from '../../../src/aws-config.js'
import { ceilingsFor, indexTestTimeoutMs } from '../../../src/regions.js'

// GSI backfills on real AWS usually land in 5-15 minutes even on empty
// tables, but have been observed taking 25+ (eu-west-2, 2026-07-12), so the
// wait for an added index is 40 minutes there. On an emulator it is 2
// minutes (see indexBackfillMs in src/regions.ts). The waits and test
// timeouts in this file are deliberately generous ceilings, not expected
// durations - an ACTIVE index returns immediately. Each test timeout is
// longer than the waits inside the test put together, so an expired wait is
// reported as the typed table-active-timeout rather than as a vitest timeout.
const CEILINGS = ceilingsFor(region)
const INDEX_WAIT_MS = CEILINGS.indexBackfillMs
const INDEX_TEST_TIMEOUT_MS = indexTestTimeoutMs(CEILINGS)

/** Create a base table with pk (S) + sk (S) for GSI lifecycle tests */
async function createBaseTable(name: string): Promise<void> {
  await ddb.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  )
  await waitUntilActive(name)
}

/** Create a base table that already has a GSI (for remove/validation tests) */
async function createTableWithGsi(name: string): Promise<void> {
  await ddb.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsiPk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'existingGsi',
          KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  )
  await waitUntilActive(name)
}

/**
 * Create a table whose GSI shares pk with the table key and which also carries
 * an LSI. Deleting that GSI then discriminates a correct union-recompute of
 * AttributeDefinitions from the two obvious wrong implementations: a naive
 * subtractor drops pk (still used by the table key), and a tableKeys ∪ gsiKeys
 * recompute drops lsiSk (still used by the LSI).
 */
async function createTableWithLsiAndSharedKeyGsi(name: string): Promise<void> {
  await ddb.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'lsiSk', AttributeType: 'N' },
        { AttributeName: 'gsiSk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: 'lsi1',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'lsiSk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'existingGsi',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'gsiSk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  )
  await waitUntilActive(name)
}

/** AttributeDefinitions sorted by name: assertions compare the full set, not the order */
function sortedAttrDefs(table: TableDescription): AttributeDefinition[] {
  return [...(table.AttributeDefinitions ?? [])].sort((a, b) =>
    a.AttributeName!.localeCompare(b.AttributeName!),
  )
}

describe('UpdateTable — add GSI', { tags: ['update-table', 'control-plane', 'slow', 'gsi'] }, () => {
  const tablesToCleanup: string[] = []

  afterAll(async () => {
    await Promise.all(tablesToCleanup.map(deleteTable))
  })

  it('adds a hash-only GSI to an existing table', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_add_hash')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'gsiPk', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsi1',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
            },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    const desc = await ddb.send(new DescribeTableCommand({ TableName: name }))
    const gsis = desc.Table!.GlobalSecondaryIndexes!
    expect(gsis).toHaveLength(1)
    expect(gsis[0].IndexName).toBe('gsi1')
    expect(gsis[0].IndexStatus).toBe('ACTIVE')
    expect(gsis[0].KeySchema).toEqual([
      { AttributeName: 'gsiPk', KeyType: 'HASH' },
    ])
    expect(gsis[0].Projection?.ProjectionType).toBe('ALL')
  })

  it('adds a composite GSI (hash + range) to an existing table', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_add_comp')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'gsiPk', AttributeType: 'S' },
          { AttributeName: 'gsiSk', AttributeType: 'N' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsiComposite',
              KeySchema: [
                { AttributeName: 'gsiPk', KeyType: 'HASH' },
                { AttributeName: 'gsiSk', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    const desc = await ddb.send(new DescribeTableCommand({ TableName: name }))
    const gsis = desc.Table!.GlobalSecondaryIndexes!
    expect(gsis).toHaveLength(1)
    expect(gsis[0].IndexName).toBe('gsiComposite')
    expect(gsis[0].KeySchema).toEqual([
      { AttributeName: 'gsiPk', KeyType: 'HASH' },
      { AttributeName: 'gsiSk', KeyType: 'RANGE' },
    ])
  })

  it('adds a GSI with KEYS_ONLY projection', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_keys_only')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'gsiPk', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsiKeysOnly',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'KEYS_ONLY' },
            },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    const desc = await ddb.send(new DescribeTableCommand({ TableName: name }))
    const gsi = desc.Table!.GlobalSecondaryIndexes![0]
    expect(gsi.IndexName).toBe('gsiKeysOnly')
    expect(gsi.Projection?.ProjectionType).toBe('KEYS_ONLY')
  })

  it('adds a GSI with INCLUDE projection and NonKeyAttributes', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_include')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'gsiPk', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsiInclude',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: {
                ProjectionType: 'INCLUDE',
                NonKeyAttributes: ['attr1', 'attr2'],
              },
            },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    const desc = await ddb.send(new DescribeTableCommand({ TableName: name }))
    const gsi = desc.Table!.GlobalSecondaryIndexes![0]
    expect(gsi.IndexName).toBe('gsiInclude')
    expect(gsi.Projection?.ProjectionType).toBe('INCLUDE')
    expect(gsi.Projection?.NonKeyAttributes).toEqual(
      expect.arrayContaining(['attr1', 'attr2']),
    )
  })

  it('can query a newly created GSI after putting items', { timeout: indexTestTimeoutMs(CEILINGS, { otherWaitsMs: 30_000 }) }, async () => {
    const name = uniqueTableName('ut_gsi_query')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    // Put items before adding the GSI
    await ddb.send(
      new PutItemCommand({
        TableName: name,
        Item: {
          pk: { S: 'item1' },
          sk: { S: 'a' },
          gsiPk: { S: 'group1' },
          data: { S: 'hello' },
        },
      }),
    )
    await ddb.send(
      new PutItemCommand({
        TableName: name,
        Item: {
          pk: { S: 'item2' },
          sk: { S: 'b' },
          gsiPk: { S: 'group1' },
          data: { S: 'world' },
        },
      }),
    )
    await ddb.send(
      new PutItemCommand({
        TableName: name,
        Item: {
          pk: { S: 'item3' },
          sk: { S: 'c' },
          gsiPk: { S: 'group2' },
          data: { S: 'other' },
        },
      }),
    )

    // Add the GSI
    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'gsiPk', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsiQuery',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
            },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    // Wait for the GSI to backfill existing items
    await waitForGsiConsistency({
      tableName: name,
      indexName: 'gsiQuery',
      partitionKey: { name: 'gsiPk', value: { S: 'group1' } },
      expectedCount: 2,
      timeoutMs: 30_000,
    })

    // Query the GSI
    const res = await ddb.send(
      new QueryCommand({
        TableName: name,
        IndexName: 'gsiQuery',
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'gsiPk' },
        ExpressionAttributeValues: { ':pk': { S: 'group1' } },
      }),
    )

    expect(res.Count).toBe(2)
    const pks = res.Items!.map((item) => item.pk.S).sort()
    expect(pks).toEqual(['item1', 'item2'])
  })

  it('adds multiple GSIs sequentially', { timeout: indexTestTimeoutMs(CEILINGS, { indexWaits: 2 }) }, async () => {
    const name = uniqueTableName('ut_gsi_multi')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    // Add first GSI
    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'g1', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsi1',
              KeySchema: [{ AttributeName: 'g1', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
            },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    // Add second GSI
    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'g2', AttributeType: 'N' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsi2',
              KeySchema: [{ AttributeName: 'g2', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'KEYS_ONLY' },
            },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    const desc = await ddb.send(new DescribeTableCommand({ TableName: name }))
    const gsis = desc.Table!.GlobalSecondaryIndexes!
    expect(gsis).toHaveLength(2)
    const names = gsis.map((g) => g.IndexName).sort()
    expect(names).toEqual(['gsi1', 'gsi2'])
    expect(gsis.every((g) => g.IndexStatus === 'ACTIVE')).toBe(true)

    // Each add above declared only its own attribute, yet the reconciled set
    // is the full union of table and index key attributes — merge, not
    // replace. Codifies observed AWS behaviour (eu-west-2, 2026-07-12); the
    // docs state only what a caller must send, not what happens to the rest.
    expect(sortedAttrDefs(desc.Table!)).toEqual([
      { AttributeName: 'g1', AttributeType: 'S' },
      { AttributeName: 'g2', AttributeType: 'N' },
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ])

    // A base-table write keyed only on pk/sk (GSI attributes are sparse)
    // still round-trips after the delta-fed adds.
    await ddb.send(
      new PutItemCommand({
        TableName: name,
        Item: { pk: { S: 'base' }, sk: { S: '1' } },
      }),
    )
    const got = await ddb.send(
      new GetItemCommand({
        TableName: name,
        Key: { pk: { S: 'base' }, sk: { S: '1' } },
        ConsistentRead: true,
      }),
    )
    expect(got.Item).toBeDefined()
  })

  it('accepts a conflicting redeclaration of an existing key attribute and keeps the stored type', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_redecl')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    // Redeclares the table's hash key pk (stored as S) with a conflicting N
    // alongside the new index attribute. Real DynamoDB accepts the call and
    // the stored type does not move — no rejection, no overwrite. Codifies
    // observed AWS behaviour (eu-west-2, 2026-07-12) that AWS has never
    // documented; do not "fix" this to expect a ValidationException.
    const updateRes = await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'N' },
          { AttributeName: 'gsiPk', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsiRedecl',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'KEYS_ONLY' },
            },
          },
        ],
      }),
    )

    // Reconciliation is synchronous: the response already carries the merged
    // set with pk untouched, before any backfill starts.
    expect(sortedAttrDefs(updateRes.TableDescription!)).toEqual([
      { AttributeName: 'gsiPk', AttributeType: 'S' },
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ])

    // The wait is cleanup enablement, not assertion staging: DeleteTable is
    // rejected with ResourceInUseException while an index is CREATING
    // (observed eu-west-2, 2026-07-12), so afterAll needs the table settled.
    await waitUntilActive(name, INDEX_WAIT_MS)

    const desc = await ddb.send(new DescribeTableCommand({ TableName: name }))
    const defs = sortedAttrDefs(desc.Table!)
    // Assert the absence of a duplicate explicitly: a target that appends
    // {pk,N} alongside {pk,S} should fail with a message naming the
    // duplication, not a generic set mismatch.
    expect(defs.filter((d) => d.AttributeName === 'pk')).toHaveLength(1)
    expect(defs).toEqual([
      { AttributeName: 'gsiPk', AttributeType: 'S' },
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ])

    // The key type genuinely did not move: a string-keyed write round-trips.
    await ddb.send(
      new PutItemCommand({
        TableName: name,
        Item: { pk: { S: 'redecl' }, sk: { S: '1' } },
      }),
    )
    const got = await ddb.send(
      new GetItemCommand({
        TableName: name,
        Key: { pk: { S: 'redecl' }, sk: { S: '1' } },
        ConsistentRead: true,
      }),
    )
    expect(got.Item).toBeDefined()
  })

  it('drops an unused AttributeDefinition supplied with a GSI add', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_unused')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    // CreateTable rejects an AttributeDefinition no key schema uses (pinned
    // in tests/tier1/createTable/basic.test.ts); UpdateTable instead accepts
    // the call and silently drops the unused definition. The two operations
    // genuinely diverge. Codifies observed AWS behaviour (eu-west-2,
    // 2026-07-12) that AWS has never documented.
    const updateRes = await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: [
          { AttributeName: 'g1', AttributeType: 'S' },
          { AttributeName: 'extraUnused', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: 'gsiUnused',
              KeySchema: [{ AttributeName: 'g1', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'KEYS_ONLY' },
            },
          },
        ],
      }),
    )

    // The drop is synchronous: extraUnused is already absent from the
    // UpdateTable response, before any backfill starts.
    expect(sortedAttrDefs(updateRes.TableDescription!)).toEqual([
      { AttributeName: 'g1', AttributeType: 'S' },
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ])

    // Cleanup enablement: DeleteTable is rejected while an index is CREATING.
    await waitUntilActive(name, INDEX_WAIT_MS)

    // And the dropped definition stays dropped once the index is ACTIVE.
    const desc = await ddb.send(new DescribeTableCommand({ TableName: name }))
    expect(sortedAttrDefs(desc.Table!)).toEqual([
      { AttributeName: 'g1', AttributeType: 'S' },
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ])
  })
})

describe('UpdateTable — remove GSI', { tags: ['update-table', 'control-plane', 'slow', 'gsi'] }, () => {
  const tablesToCleanup: string[] = []

  afterAll(async () => {
    await Promise.all(tablesToCleanup.map(deleteTable))
  })

  it('removes a GSI from a table', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_remove')
    tablesToCleanup.push(name)
    // The table shape is deliberate: the GSI shares pk with the table key and
    // an LSI holds lsiSk, so the AttributeDefinitions assertion below can
    // discriminate a correct recompute from naive subtraction.
    await createTableWithLsiAndSharedKeyGsi(name)

    // Verify the GSI exists before removal
    const before = await ddb.send(new DescribeTableCommand({ TableName: name }))
    expect(before.Table!.GlobalSecondaryIndexes).toHaveLength(1)

    // Remove the GSI
    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        GlobalSecondaryIndexUpdates: [
          {
            Delete: { IndexName: 'existingGsi' },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    const after = await ddb.send(new DescribeTableCommand({ TableName: name }))
    // GSI list should be empty or undefined
    const gsis = after.Table!.GlobalSecondaryIndexes ?? []
    expect(gsis).toHaveLength(0)

    // Only the deleted index's orphaned key attribute (gsiSk) is pruned from
    // AttributeDefinitions. pk survives because the table key still uses it;
    // lsiSk survives because the LSI still does. Codifies observed AWS
    // behaviour (eu-west-2, 2026-07-12); AWS documents nothing about pruning.
    expect(sortedAttrDefs(after.Table!)).toEqual([
      { AttributeName: 'lsiSk', AttributeType: 'N' },
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ])
  })

  it('base table operations still work after removing a GSI', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_rm_ops')
    tablesToCleanup.push(name)
    await createTableWithGsi(name)

    // Remove the GSI
    await ddb.send(
      new UpdateTableCommand({
        TableName: name,
        GlobalSecondaryIndexUpdates: [
          {
            Delete: { IndexName: 'existingGsi' },
          },
        ],
      }),
    )

    await waitUntilActive(name, INDEX_WAIT_MS)

    // Put an item — should still work
    await ddb.send(
      new PutItemCommand({
        TableName: name,
        Item: {
          pk: { S: 'afterRemove' },
          sk: { S: '1' },
          data: { S: 'still works' },
        },
      }),
    )

    // Get the item back
    const res = await ddb.send(
      new GetItemCommand({
        TableName: name,
        Key: {
          pk: { S: 'afterRemove' },
          sk: { S: '1' },
        },
      }),
    )

    expect(res.Item).toBeDefined()
    expect(res.Item!.data.S).toBe('still works')

    // Query the base table
    const queryRes = await ddb.send(
      new QueryCommand({
        TableName: name,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': { S: 'afterRemove' } },
      }),
    )

    expect(queryRes.Count).toBe(1)
  })
})

describe('UpdateTable — GSI validation', { tags: ['update-table', 'control-plane', 'slow', 'gsi', 'negative-path'] }, () => {
  const tablesToCleanup: string[] = []

  afterAll(async () => {
    await Promise.all(tablesToCleanup.map(deleteTable))
  })

  it('rejects adding a GSI with a name that already exists', { timeout: INDEX_TEST_TIMEOUT_MS }, async () => {
    const name = uniqueTableName('ut_gsi_dup')
    tablesToCleanup.push(name)
    await createTableWithGsi(name)

    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateTableCommand({
            TableName: name,
            AttributeDefinitions: [
              { AttributeName: 'gsiPk', AttributeType: 'S' },
            ],
            GlobalSecondaryIndexUpdates: [
              {
                Create: {
                  IndexName: 'existingGsi',
                  KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
                  Projection: { ProjectionType: 'ALL' },
                },
              },
            ],
          }),
        ),
      'ValidationException',
    )
  })

  it('rejects adding a GSI with an attribute not in AttributeDefinitions', async () => {
    const name = uniqueTableName('ut_gsi_no_attr')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateTableCommand({
            TableName: name,
            // Intentionally omitting AttributeDefinitions for 'unknownAttr'
            GlobalSecondaryIndexUpdates: [
              {
                Create: {
                  IndexName: 'gsiBadAttr',
                  KeySchema: [{ AttributeName: 'unknownAttr', KeyType: 'HASH' }],
                  Projection: { ProjectionType: 'ALL' },
                },
              },
            ],
          }),
        ),
      'ValidationException',
    )
  })

  it('rejects a GSI keyed on a table attribute omitted from the request AttributeDefinitions', async () => {
    const name = uniqueTableName('ut_gsi_stored_attr')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    // pk is defined on the table, but a new index's key attributes must all
    // appear in the request's own AttributeDefinitions — the stored
    // definitions do not satisfy the validation. The API reference's "must
    // include the key element(s) of the new index" is literal. Codifies
    // observed AWS behaviour (eu-west-2, 2026-07-12): a target that resolves
    // index keys from its stored definitions is too lenient and fails here.
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateTableCommand({
            TableName: name,
            AttributeDefinitions: [{ AttributeName: 'g3', AttributeType: 'S' }],
            GlobalSecondaryIndexUpdates: [
              {
                Create: {
                  IndexName: 'gsiSharedPk',
                  KeySchema: [
                    { AttributeName: 'pk', KeyType: 'HASH' },
                    { AttributeName: 'g3', KeyType: 'RANGE' },
                  ],
                  Projection: { ProjectionType: 'KEYS_ONLY' },
                },
              },
            ],
          }),
        ),
      'ValidationException',
    )
  })

  it('rejects removing a non-existent GSI', async () => {
    const name = uniqueTableName('ut_gsi_rm_none')
    tablesToCleanup.push(name)
    await createBaseTable(name)

    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateTableCommand({
            TableName: name,
            GlobalSecondaryIndexUpdates: [
              {
                Delete: { IndexName: 'doesNotExist' },
              },
            ],
          }),
        ),
      'ResourceNotFoundException',
    )
  })
})
