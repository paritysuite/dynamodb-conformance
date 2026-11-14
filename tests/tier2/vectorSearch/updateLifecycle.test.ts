import { CreateTableCommand, DescribeTableCommand, DeleteTableCommand, UpdateTableCommand, PutItemCommand, SearchVectorsCommand, DynamoDBServiceException } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { uniqueTableName, waitUntilActive, deleteTable, expectDynamoError } from '../../../src/helpers.js'
import { skipUnlessVectorIndexes, describeVectorIndex } from '../../../src/vector.js'
import { isUnsupportedFault } from '../../../src/unsupported.js'
import { IndeterminateError, indeterminateFrom } from '../../../src/indeterminate.js'
import { region } from '../../../src/aws-config.js'
import { ceilingsFor, indexTestTimeoutMs } from '../../../src/regions.js'

// The UpdateTable path of the vector index lifecycle. Separated from
// lifecycle.test.ts because index creation here runs on GSI timescales
// (~17 minutes observed for a 25-item table, eu-west-2, 2026-08-11), so this
// file rides in the slow online-index lane beside
// tests/tier2/updateTable/gsi.test.ts rather than in the gating run.

// The wait for an added index to become searchable: 40 minutes on real
// DynamoDB, 2 minutes on an emulator (see indexBackfillMs in src/regions.ts).
const CEILINGS = ceilingsFor(region)
const INDEX_WAIT_MS = CEILINGS.indexBackfillMs

const tablesToCleanup: string[] = []

afterAll(async () => {
  await Promise.all(tablesToCleanup.map(deleteTable))
})

describe('UpdateTable — vector index lifecycle', { tags: ['update-table', 'delete-table', 'search-vectors', 'control-plane', 'vector', 'slow'] }, () => {
  skipUnlessVectorIndexes()

  // Characterised 2026-08-11 (eu-west-2): an index added to a 25-item table
  // took ~17 minutes to become searchable, on the same online-index machinery
  // as GSIs. The walk on this path differs from the CreateTable path in three
  // observed ways: the table status moves to UPDATING, the Backfilling field
  // IS reported (false during early CREATING, true while backfilling, absent
  // once done), and SearchVectors rejects the whole time — first with "The
  // table does not have the specified index", then with "Cannot search
  // backfilling vector index". DescribeTable flipping to ACTIVE can lead the
  // search plane by a beat, so readiness is proven by a search succeeding,
  // never by the description alone.
  //
  // All of that is now the documented sequence too, so the assertions below
  // pin it rather than describing it. The developer guide previously built its
  // waiting advice around an ACTIVE-plus-Backfilling-true state this walk never
  // occupies; it now numbers the same three steps this test observes. See
  // captures/2026-08-21-vector-readiness-docs.json for the before and after.
  it('adds an index that backfills like a GSI, enforces one online action, then deletes it', async ({ skip }) => {
    const tableName = uniqueTableName('vec_upd')
    tablesToCleanup.push(tableName)
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    )
    await waitUntilActive(tableName)
    for (let i = 0; i < 5; i++) {
      await ddb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            pk: { S: `item-${i}` },
            embedding: { L: [{ N: String(i) }, { N: '1' }, { N: '0' }] },
          },
        }),
      )
    }

    // A target can implement vector indexes at CreateTable (which is what the
    // control-plane probe checks) without implementing VectorIndexUpdates;
    // an unsupported answer here is scope, not divergence.
    try {
      await ddb.send(
        new UpdateTableCommand({
          TableName: tableName,
          VectorIndexUpdates: [
            {
              Create: {
                IndexName: 'vix',
                VectorAttribute: { AttributeName: 'embedding' },
                Dimensions: 3,
                DistanceFunction: 'COSINE',
                Projection: { ProjectionType: 'ALL' },
              },
            },
          ],
        }),
      )
    } catch (err) {
      if (
        isUnsupportedFault(err) ||
        (err instanceof DynamoDBServiceException && err.name === 'ValidationException')
      ) {
        return skip()
      }
      throw err
    }

    // Walk to searchable. Four claims are pinned on every poll:
    //
    //  - Statuses stay within CREATING and ACTIVE. There is no BACKFILLING
    //    status value.
    //  - Backfilling true is only ever reported alongside CREATING. The state
    //    the old guidance built its waiting advice around, ACTIVE with
    //    Backfilling true, is never occupied.
    //  - Once the index is ACTIVE the field is gone rather than false. That is
    //    why the documented wait reads "Backfilling is not true"; a readiness
    //    check written as `=== false` never fires on this path and has nothing
    //    to read at all on the CreateTable path.
    //  - The base table reports ACTIVE while the index is still CREATING, which
    //    is the reason a table waiter is the wrong gate for a search.
    //
    // Table and index status come from one DescribeTable rather than two, or a
    // transition between the calls would make the pairing meaningless.
    //
    // Readiness itself is a search that succeeds, never the description. Every
    // pre-ready failure must be one of the two characterised rejections, and
    // the first success must carry every seeded item: the backfill window is
    // documented as returning an error, not a partial view.
    const seenStatuses = new Set<string>()
    let sawBackfillingField = false
    let sawActiveTableWithCreatingIndex = false
    const deadline = Date.now() + INDEX_WAIT_MS
    for (;;) {
      const described = await ddb.send(new DescribeTableCommand({ TableName: tableName }))
      const ix = (described.Table?.VectorIndexes ?? []).find((i) => i.IndexName === 'vix')
      if (ix?.IndexStatus) seenStatuses.add(ix.IndexStatus)
      if (ix?.Backfilling !== undefined) sawBackfillingField = true
      if (ix?.Backfilling === true) expect(ix.IndexStatus).toBe('CREATING')
      if (ix?.IndexStatus === 'ACTIVE') expect(ix.Backfilling).toBeUndefined()
      if (described.Table?.TableStatus === 'ACTIVE' && ix?.IndexStatus === 'CREATING') {
        sawActiveTableWithCreatingIndex = true
      }

      let found: number | undefined
      try {
        const res = await ddb.send(
          new SearchVectorsCommand({
            TableName: tableName,
            IndexName: 'vix',
            SearchVector: [{ N: '1' }, { N: '1' }, { N: '0' }],
            TopK: 5,
          }),
        )
        found = (res.SearchResults ?? []).length
      } catch (err) {
        // A throttle or transport fault mid-poll is a failed observation,
        // not an answer; anything else must be one of the two characterised
        // pre-ready rejections.
        const indeterminate = indeterminateFrom(err)
        if (indeterminate) throw indeterminate
        expect(err).toBeInstanceOf(DynamoDBServiceException)
        expect((err as DynamoDBServiceException).name).toBe('ValidationException')
        expect((err as DynamoDBServiceException).message).toMatch(
          /The table does not have the specified index: vix|Cannot search backfilling vector index: vix/,
        )
      }
      // Asserted outside the try, or a short answer would be caught and read as
      // a pre-ready rejection that failed to look like one.
      if (found !== undefined) {
        expect(found).toBe(5)
        break
      }
      if (Date.now() > deadline) {
        throw new IndeterminateError(
          'vector-index-timeout',
          `Vector index vix on ${tableName} never became searchable`,
        )
      }
      await new Promise((r) => setTimeout(r, 5000))
    }
    expect([...seenStatuses].every((s) => s === 'CREATING' || s === 'ACTIVE')).toBe(true)
    expect(sawBackfillingField).toBe(true)
    expect(sawActiveTableWithCreatingIndex).toBe(true)

    // One online index action per call, enforced with the GSI machinery's
    // own error.
    const extra = (name: string) => ({
      Create: {
        IndexName: name,
        VectorAttribute: { AttributeName: 'embedding' },
        Dimensions: 3,
        DistanceFunction: 'COSINE' as const,
        Projection: { ProjectionType: 'KEYS_ONLY' as const },
      },
    })
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateTableCommand({
            TableName: tableName,
            VectorIndexUpdates: [extra('vix2'), extra('vix3')],
          }),
        ),
      'LimitExceededException',
      'Subscriber limit exceeded: Only 1 online index can be created or deleted simultaneously per table',
    )

    // Delete removes the index and leaves the base table untouched.
    await ddb.send(
      new UpdateTableCommand({
        TableName: tableName,
        VectorIndexUpdates: [{ Delete: { IndexName: 'vix' } }],
      }),
    )
    const deleteDeadline = Date.now() + 300_000
    for (;;) {
      const ix = await describeVectorIndex(tableName, 'vix')
      if (!ix) break
      expect(ix.IndexStatus === 'DELETING' || ix.IndexStatus === 'ACTIVE').toBe(true)
      if (Date.now() > deleteDeadline) {
        throw new IndeterminateError(
          'vector-index-timeout',
          `Vector index vix on ${tableName} never finished deleting`,
        )
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    const table = await ddb.send(new DescribeTableCommand({ TableName: tableName }))
    expect(table.Table?.TableStatus).toBe('ACTIVE')
    expect(table.Table?.VectorIndexes ?? []).toHaveLength(0)
    // Timeout: the table-creation wait, the searchable ceiling (INDEX_WAIT_MS)
    // and the delete ceiling (300s), plus a minute. The outer bound must exceed
    // the summed internal deadlines or vitest kills the test as a failure
    // before either internal ceiling can type the expiry as indeterminate.
  }, indexTestTimeoutMs(CEILINGS, { otherWaitsMs: 300_000 }))

  // The other half of "wait for the index, not just the table": while a vector
  // index is being created, the table underneath it cannot be deleted. AWS
  // documents this in the tutorial's readiness callout, quoting the message as
  // "Cannot delete table while indexes are being created, updated, or deleted."
  // The answer carries a ResourceInUseException envelope clause in front of
  // that sentence, and the assertion matches the pair whole rather than the
  // documented half. Matching the inner clause alone passes a target that
  // returns only the second half of the answer, which is a real divergence in
  // the wording a caller reads.
  //
  // Only the UpdateTable path can ask the question. Measured in eu-west-2 on
  // 2026-08-21, an index created as part of CreateTable reaches ACTIVE in the
  // same DescribeTable poll as its own table - three runs, polling at 250ms,
  // no gap in any of them - so the table is never ACTIVE with the index still
  // CREATING there, and a DeleteTable during creation is refused for the
  // table's own status instead ("Table is being created"). Adding an index to a
  // live table is what opens that window, about 31 seconds after the
  // UpdateTable call, and it then stays open for the whole backfill.
  //
  // Cleanup cancels the index rather than waiting the backfill out. A vector
  // index in CREATING accepts a Delete the way a backfilling GSI does, and the
  // table is deletable about five seconds later. That keeps this to a minute in
  // a lane where the test above runs for seventeen.
  it('refuses to delete the table while a vector index is still being created', async ({ skip }) => {
    const tableName = uniqueTableName('vec_del')
    tablesToCleanup.push(tableName)
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    )
    await waitUntilActive(tableName)
    for (let i = 0; i < 5; i++) {
      await ddb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            pk: { S: `item-${i}` },
            embedding: { L: [{ N: String(i) }, { N: '1' }, { N: '0' }] },
          },
        }),
      )
    }

    // As above: a target may implement vector indexes at CreateTable without
    // implementing VectorIndexUpdates, and that is scope rather than divergence.
    try {
      await ddb.send(
        new UpdateTableCommand({
          TableName: tableName,
          VectorIndexUpdates: [
            {
              Create: {
                IndexName: 'vix',
                VectorAttribute: { AttributeName: 'embedding' },
                Dimensions: 3,
                DistanceFunction: 'COSINE',
                Projection: { ProjectionType: 'ALL' },
              },
            },
          ],
        }),
      )
    } catch (err) {
      if (
        isUnsupportedFault(err) ||
        (err instanceof DynamoDBServiceException && err.name === 'ValidationException')
      ) {
        return skip()
      }
      throw err
    }

    // Wait for the state the claim is about: the table back to ACTIVE with the
    // index still CREATING.
    const reachDeadline = Date.now() + 300_000
    for (;;) {
      const described = await ddb.send(new DescribeTableCommand({ TableName: tableName }))
      const ix = (described.Table?.VectorIndexes ?? []).find((i) => i.IndexName === 'vix')
      if (described.Table?.TableStatus === 'ACTIVE' && ix?.IndexStatus === 'CREATING') break
      // An index that reached ACTIVE without the table ever being seen ACTIVE
      // beside it would leave the question unaskable, not answered.
      expect(ix?.IndexStatus).not.toBe('ACTIVE')
      if (Date.now() > reachDeadline) {
        throw new IndeterminateError(
          'vector-index-timeout',
          `Table ${tableName} never reported ACTIVE while vector index vix was CREATING`,
        )
      }
      await new Promise((r) => setTimeout(r, 1000))
    }

    await expectDynamoError(
      () => ddb.send(new DeleteTableCommand({ TableName: tableName })),
      'ResourceInUseException',
      /^Attempt to change a resource which is still in use: Cannot delete table while indexes are being created, updated, or deleted\.$/,
    )

    // Cancelling is what makes this cheap, and it is its own small claim: a
    // vector index still CREATING takes a Delete rather than answering the
    // one-online-action limit.
    await ddb.send(
      new UpdateTableCommand({
        TableName: tableName,
        VectorIndexUpdates: [{ Delete: { IndexName: 'vix' } }],
      }),
    )
    const goneDeadline = Date.now() + 300_000
    for (;;) {
      const ix = await describeVectorIndex(tableName, 'vix')
      if (!ix) break
      if (Date.now() > goneDeadline) {
        throw new IndeterminateError(
          'vector-index-timeout',
          `Cancelled vector index vix on ${tableName} never disappeared`,
        )
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    // Once the index is gone the table is deletable again, which is the same
    // claim from the other side.
    await ddb.send(new DeleteTableCommand({ TableName: tableName }))
    // Timeout: the reach ceiling (300s) plus the cancel ceiling (300s) plus
    // setup margin, on the same rule as the test above.
  }, 700_000)

  // Index creation is not one phase, and only the second of them takes a
  // cancel. Measured in eu-west-2 on 2026-08-23, on the same five-item table
  // shape as the tests above: an index added to a live table spends its first
  // stretch in a resource allocation phase, then starts backfilling.
  // DescribeTable tells them apart through Backfilling — false while
  // allocating, true once the backfill is running — and the base table sits in
  // UPDATING for the first of them, returning to ACTIVE about thirty seconds
  // in while the index carries on building.
  //
  // None of that was pinned before. The first test polls at five-second
  // intervals and asserts only over what it happened to see, so it never has to
  // occupy the early window; the DeleteTable test waits for the table to return
  // to ACTIVE before it cancels, and that wait is exactly what carries it past
  // resource allocation. So "a CREATING index accepts a Delete" was true as
  // written and true only of the second phase, and a target that accepted one
  // in the first phase passed anyway.
  //
  // It also asks the one-online-action limit the question the first test
  // cannot: a second create in an UpdateTable of its own, while the
  // first index is still going. That test sends both creates in one VectorIndexUpdates array,
  // so a target that simply refuses arrays longer than one passes it and still
  // accepts a second concurrent create. The limit is on the table.
  //
  // Cheap for this lane despite living in it. Nothing here waits out the
  // backfill — the last poll it needs is the one where Backfilling first reads
  // true, a minute or so in — where the first test runs for seventeen.
  it('reports UPDATING with Backfilling false while allocating, and takes a cancel only once backfilling starts', async ({ skip }) => {
    const tableName = uniqueTableName('vec_phase')
    tablesToCleanup.push(tableName)
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    )
    await waitUntilActive(tableName)
    for (let i = 0; i < 5; i++) {
      await ddb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            pk: { S: `item-${i}` },
            embedding: { L: [{ N: String(i) }, { N: '1' }, { N: '0' }] },
          },
        }),
      )
    }

    // As above: a target may implement vector indexes at CreateTable without
    // implementing VectorIndexUpdates, and that is scope rather than divergence.
    let created
    try {
      created = await ddb.send(
        new UpdateTableCommand({
          TableName: tableName,
          VectorIndexUpdates: [
            {
              Create: {
                IndexName: 'vix',
                VectorAttribute: { AttributeName: 'embedding' },
                Dimensions: 3,
                DistanceFunction: 'COSINE',
                Projection: { ProjectionType: 'ALL' },
              },
            },
          ],
        }),
      )
    } catch (err) {
      if (
        isUnsupportedFault(err) ||
        (err instanceof DynamoDBServiceException && err.name === 'ValidationException')
      ) {
        return skip()
      }
      throw err
    }

    // The call answers with the table already moved off ACTIVE, so the first
    // evidence that adding an index disturbs the table's own status is in the
    // UpdateTable response rather than in a later description.
    expect(created.TableDescription?.TableStatus).toBe('UPDATING')

    // First read, within a beat of the call returning. Asserted directly rather
    // than collected over a poll loop: "immediately after the UpdateTable" is
    // the claim, and a flag set anywhere in a loop would not carry it. All
    // three fields are read from one DescribeTable, or the pairing would be
    // meaningless.
    const first = await ddb.send(new DescribeTableCommand({ TableName: tableName }))
    const firstIx = (first.Table?.VectorIndexes ?? []).find((i) => i.IndexName === 'vix')
    expect(first.Table?.TableStatus).toBe('UPDATING')
    expect(firstIx?.IndexStatus).toBe('CREATING')
    // Present and false, not absent. The field's absence means something else
    // on this path (the index has finished), so `toBe(false)` is the assertion
    // and `toBeFalsy()` would not be.
    expect(firstIx?.Backfilling).toBe(false)

    // Still allocating, so the cancel is refused, and the answer names both the
    // phase it is in and the phase to retry in. Matched whole and anchored at
    // both ends: the ResourceInUseException envelope clause is part of the
    // answer, and a target returning only the sentence after it is diverging —
    // an assertion on the inner clause alone would read that as a pass. The
    // two identifiers it ends on are the bare table and index names rather
    // than ARNs (eu-west-2, 2026-08-23), so they are pinned as they are read.
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateTableCommand({
            TableName: tableName,
            VectorIndexUpdates: [{ Delete: { IndexName: 'vix' } }],
          }),
        ),
      'ResourceInUseException',
      new RegExp(
        '^Attempt to change a resource which is still in use: ' +
          'Index creation is in resource allocation phase\\. ' +
          'Retry deletion during backfilling phase or when the index is active\\. ' +
          `Table: ${tableName} Index: vix$`,
      ),
    )

    // Still allocating, and a create of a second index in its own UpdateTable
    // is refused too — for the limit rather than for the phase. The two
    // refusals side by side are what separate the claims: the phase governs
    // what the index already being built will accept, and the limit governs
    // the table rather than the call. The first test in this file fires both
    // creates in a single VectorIndexUpdates array, which a target passes by
    // rejecting arrays longer than one while still taking this.
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateTableCommand({
            TableName: tableName,
            VectorIndexUpdates: [
              {
                Create: {
                  IndexName: 'vix2',
                  VectorAttribute: { AttributeName: 'embedding' },
                  Dimensions: 3,
                  DistanceFunction: 'COSINE',
                  Projection: { ProjectionType: 'KEYS_ONLY' },
                },
              },
            ],
          }),
        ),
      'LimitExceededException',
      /^Subscriber limit exceeded: Only 1 online index can be created or deleted simultaneously per table$/,
    )

    // Walk to the second phase. Backfilling turning true is the only signal
    // that allocation is over — IndexStatus stays CREATING across both, and
    // there is no third status value to read the boundary from — so it is what
    // the loop waits on and what the cancel below is timed against.
    let sawActiveTableWhileCreating = false
    const backfillDeadline = Date.now() + 600_000
    for (;;) {
      const described = await ddb.send(new DescribeTableCommand({ TableName: tableName }))
      const ix = (described.Table?.VectorIndexes ?? []).find((i) => i.IndexName === 'vix')
      // An index that reached ACTIVE here never occupied the phase this test is
      // about; the backfill of even five items runs for minutes.
      expect(ix?.IndexStatus).toBe('CREATING')
      // The table's status is the one that moves first, and it moves back while
      // the index is still building — which is the whole reason a table waiter
      // is the wrong gate for a question about an index.
      if (described.Table?.TableStatus === 'ACTIVE') sawActiveTableWhileCreating = true
      else expect(described.Table?.TableStatus).toBe('UPDATING')
      if (ix?.Backfilling === true) break
      expect(ix?.Backfilling).toBe(false)
      if (Date.now() > backfillDeadline) {
        throw new IndeterminateError(
          'vector-index-timeout',
          `Vector index vix on ${tableName} never started backfilling`,
        )
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(sawActiveTableWhileCreating).toBe(true)

    // Backfilling now, and the identical call the allocation phase refused is
    // taken. That is the claim the phase split exists to make: the difference
    // is the index's phase, not the request.
    await ddb.send(
      new UpdateTableCommand({
        TableName: tableName,
        VectorIndexUpdates: [{ Delete: { IndexName: 'vix' } }],
      }),
    )
    const goneDeadline = Date.now() + 300_000
    for (;;) {
      const ix = await describeVectorIndex(tableName, 'vix')
      if (!ix) break
      if (Date.now() > goneDeadline) {
        throw new IndeterminateError(
          'vector-index-timeout',
          `Cancelled vector index vix on ${tableName} never disappeared`,
        )
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    // Timeout: the backfill-start ceiling (600s) plus the cancel ceiling (300s)
    // plus setup margin, on the same rule as the tests above — the outer bound
    // must exceed the summed internal deadlines or vitest kills the test as a
    // failure before either can type the expiry as indeterminate.
  }, 1_000_000)
})
