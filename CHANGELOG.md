# Conformance suite history

A dated log of how the conformance test suite has grown: tests added, tiers
broadened, and targets brought into the run. Newest first.

Work lands its notes under `## Unreleased` as it merges. The release gives that
section its date and version, so several branches can write ahead of one.

## Unreleased

Kumo joins the board, suggested by [@exoego](https://github.com/exoego). It is a
Go emulator covering 82 AWS services, of which DynamoDB is one, and it runs from
a container image or a single binary with nothing else to install.

## 2026-09-03 (3.3.0)

Thirteen captures against eu-west-2 turned into coverage, and the suite grew
from 1056 tests to 1251. All of it was ground truth nothing asserted, so an
engine could discard a PartiQL index qualifier or store an item AWS would
refuse and still score a clean pass.

- **PartiQL index qualifier.** What a qualified `SELECT` returns, when an
  unprojected attribute is rejected and when it is served from the base table,
  how the reach-back is charged, that a qualified write is rejected, and the
  exact wording of each rejection.
- **PartiQL comparison on non-scalar types.** Equality and inequality on every
  set, map and list, each checked against the same predicate written as a
  `ConditionExpression`.
- **`BatchExecuteStatement` member fields.** Per-member `ConsistentRead`, the
  primary-key requirement, and which failures echo `TableName`.
- **The 400KB gate, to the byte.** 409,600 accepted and 409,601 refused across
  seven write surfaces. `UpdateItem` is the outlier: it charges what the
  statement writes plus a fixed cost per clause, so the key and every untouched
  attribute stay out of the figure.
- **A number's byte cost.** Twenty-three literals, each measured by an accept
  and a refusal either side of the gate. The rule the developer guide documents
  is wrong in two ways, and both have a case.
- **Reads are sized before the filter.** `Scan`, `Query` and PartiQL all charge
  before the `WHERE` clause and the projection, so discarding rows saves
  nothing.
- **Vector write capacity.** `VectorWriteRequestBytes` pinned term by term,
  charged on the change to the index's own stored view like a GSI.
  `VectorSearchRequestBytes` stays shape-only: five identical searches against
  an unchanged index reported 14214, 13903, 14214, 14214 and 14518.
- **Vector index creation has two phases.** Resource allocation, where the table
  sits in `UPDATING`, `Backfilling` reads false and a cancel is refused, then
  backfilling, which takes one. The one-online-index limit binds the table
  rather than the call.

Two fixes came with it. A local run against real DynamoDB takes its own table
namespace, so it can no longer delete a CI run's tables. And a
`TransactWriteItems` control, plus the whole PartiQL validation-ordering file,
were feeding an unsupported fault into an assertion about wording and scoring a
declared gap as a disagreement; both now skip.

`BatchWriteItem` with an empty `RequestItems` map is now a recorded regional
split. eu-north-1 answers the validation framework's generic constraint message
where the other 32 answering regions answer the bespoke required-parameter
sentence. A capture on 2026-08-17 found every answering region on the bespoke
wording, which dates the crossing to that week rather than guessing at it.

The over-25-requests assertion beside it spans both cohorts instead of becoming
a second row. Neither wording is byte-stable: the table name carries a per-run
suffix, the old cohort echoes all 26 requests back, and seven regions echo them
as a JVM object identity rather than expanded fields. A row records one verbatim
answer per region and there is nothing verbatim here to record, so the anchored
pattern grew a second branch instead. It still refuses a wrong limit and a wrong
table, and it matches every one of the 33 answering regions.

The capture harness can take that evidence without creating tables. `--probes`
selects named probes and `--no-tables` skips the fixtures, which is all these
three need: DynamoDB refuses each of them before it looks at a table, so the
answers do not depend on one existing, and read-only credentials are enough. The
2026-08-17 capture was taken with a scoped script that was never committed; this
is the committed way to reproduce it.

## 2026-08-21 (3.2.1)

AWS corrected the vector index readiness documentation, prompted by [a write-up
of the earlier guidance][vector-docs] that drew on the suite's measurements. The
ACTIVE-plus-backfilling state the old advice was built around, and which no
index ever occupies, is gone from the three pages that described it. The wait
now reads "Backfilling is not true" rather than "is false", so a check written
literally from it fires on both creation paths instead of neither. The tutorial
no longer says a search during backfill can return incomplete results. Two
things the suite had measured but nobody had written down are documented as
well: that DescribeTable reporting ACTIVE leads the dedicated search endpoint,
and that the readiness check depending on neither status field is a real search
in a retry loop.

[vector-docs]: https://martinhicks.dev/articles/dynamodb-vector-search-docs-get-wrong

That contract is now pinned rather than described. The UpdateTable walk asserts
that Backfilling true is only ever reported alongside CREATING, that an ACTIVE
index reports no Backfilling field at all, and that the base table goes ACTIVE
while the index is still building, which is what makes a table waiter the wrong
gate for a search. The first search that succeeds has to carry every seeded
item, since the backfill window answers with an error rather than a partial
view. On the CreateTable path a new test runs the documented check the way an
application would, and every rejection before the first served response has to
be the retryable ValidationException rather than a not-found.

The suite's own search wait now absorbs those two rejections and rethrows every
other answer, so a fixture waiting on an index that is ACTIVE but not yet served
no longer fails on the lag it was waiting out. Two files asserting exact
rejection messages wait for a served search rather than for ACTIVE: "does not
have the specified index" is also what a freshly ACTIVE index says, and it would
otherwise stand in for whichever message the case asked for.

The tutorial's other new claim, that a table cannot be deleted while a vector
index is being created, has a test of its own. Only the UpdateTable path can ask
it. Across three runs an index created with its table reached ACTIVE in the same
250ms poll as the table, so the table is never ACTIVE with the index still
building there, and a DeleteTable during creation is refused for the table's own
status rather than with the documented index wording. Adding an index to a live
table opens that window about thirty seconds in. The test cancels the index
afterwards instead of waiting out the backfill, which a still-creating vector
index turns out to accept the way a backfilling GSI does, so it costs a minute
rather than seventeen.

A release now dispatches its measurement as the results bot rather than with
the workflow's own token. GitHub raises no `workflow_run` event when a run
started by `GITHUB_TOKEN` finishes, so 3.2.0 measured green for three hours and
its board only landed once the results table was dispatched by hand.

## 2026-08-18 (3.2.0)

The board now measures the most recent release tag rather than `main`. Merging
a test still runs it against real AWS, which is what validates it, but the
published figures no longer move until a release moves them, so a dated
changelog entry always sits behind a change in the denominator. Expect the
figures to shift on this release: the board is switching from measuring `main`
to measuring a tag, and those are different trees today.

Every board now says what produced it. `results/summary.json` carries a `suite`
block naming the ref measured, its commit, the suite version at that ref, the
region it ran against and when. It is additive, so `schemaVersion` stays at 1.
The same block reaches `/data/latest.json`, `/data/index.json` and
`/data/runs.json`, where each historical run carries its own copy, so a
denominator that moved between two runs can be attributed to the release that
moved it. Branch on `kind`: only `tag` is a released board.

A board is graded against the suite manifest and split registry as they stood
at the ref it measured. Region health is the exception and is read live, so a
region dropped since the tag still counts against today's cohorts. That is the
one input allowed to move under a board without a new measurement, and the
board carries a health date beside its measurement date to say so.

Releases are cut by one workflow dispatch: it bumps the version, dates this
section, installs against the bumped tree, tags, and opens a draft release,
then starts the measurement. The draft publishes itself when the board carrying
that version lands, which takes about three hours.

eu-west-2 has crossed to the validation framework's generic constraint message
for `BatchGetItem` with an empty `RequestItems` map, so the split row recording
that behaviour is re-characterised against a 34-region capture taken on
2026-08-17. Eleven of the thirty-three regions that answer now return the
generic message; twenty-two still return the bespoke required-parameter
sentence, and me-central-1 joins the row.

The matching validation-ordering row is retired. Both wordings refuse an empty
`RequestItems` before the map is read, which is all that tier asserts, so the
assertion now matches the parameter name case-insensitively and spans both. The
`BatchWriteItem` case beside it, which no region has moved yet, is written the
same way.

A probe absent from the baseline is no longer reported as drift. Adding a probe
to the capture script leaves every older baseline without it, and a scheduled
red then named the new probe as the thing that had moved.

The weekly cross-region capture now includes eu-west-2, so the drift lens reads
its baseline and the candidate regions from one capture taken at one moment
rather than comparing today's candidates against an older baseline file. A
scheduled red also keeps the eu-west-2 capture its drift verdict was read from,
which was previously discarded with the runner.

## 2026-08-15 (3.1.0)

ExtendDB's SQLite backend joins the run, built from the same release as the
PostgreSQL one and held to the same TLS, SigV4 and IAM posture, so the storage
engine is the only thing that differs between them.

A project's other builds now sit behind a disclosure on its row. Every build is
measured in full and has a row of its own with its own figures; the disclosure
starts closed only when every build under it reads the same grade, divergence
and coverage as the row above, and only when each of them was measured in that
run: a carried row on either side opens it, and so does a run the suite declined
to score. It is read from each run, so a build can start closed on one and open
on the next. The README table has no disclosure to offer, so it lists every
build outright.

Every target in the data endpoints gains two fields. `collapsedIntoProject` is
true when the board starts that build's row closed. `standsForProject` says
which row the board treats as a project's own, which `isVariant` cannot answer:
on a run where a project's reference build recorded nothing, a build is promoted
to stand for it and every row of that project reads `isVariant: true`. Both are
additive, so `schemaVersion` is unchanged, and `/data/index.json` gains a
`projects` block documenting them.

`/data/index.json` also gains a `schema` block saying what the version number
entitles a consumer to: a field you already read will not change type or meaning
while `schemaVersion` stays put, and new fields can appear at any version. The
grading criteria are named there as a separate axis, since a change to the bands
changes what a letter means without the schema moving.

The `coverage` description said a partial run was carried forward on its last
clean measurement. It is not: the row stays in the run, publishes null for both
figures and reads `carried: false`, because the target did report. Carrying
forward is what happens to the baseline's unobserved lanes. Corrected, along
with Dynoxide's build label, which now names its storage (`native SQLite`) like
every other build in the registry rather than its compile target.

## 2026-08-12 (3.0.0)

**Read this first if you consume the JSON.** The data endpoints go from schema 2
to schema 4 in one step. Schema 3 was never published on its own, so everything
on 2 crosses both steps at once. Schema 3 breaks in four ways:

- `movement.state` values changed from `up`/`down` to `improved`/`regressed`.
  **This is the one that fails silently:** the old names still parse, and now
  mean the opposite direction.
- `movement.delta` keeps its shape but is computed from divergence rather than
  correctness, so the sign of a delta means the opposite of what it did.
- A tier no longer carries `pct` and `value`. It carries `divergence`,
  `coverage` and `correctness`, each with a `pct` and a `value` of its own.
- The whole-suite correctness percentage is `correctness`, not `total`. `total`
  also names the raw test count inside `counts`, so the same word meant a count
  in one place and a percentage in another.

Schema 4 is additive on top: each target carries its grade and the full criteria
in `metrics.grade`, every envelope gains `baseline.observation` (how much of the
suite the live-AWS row stands on, which passes reported, and what is carried),
`latest.json` and `runs.json` gain `divergence`, `project`, `configuration` and
`isVariant`, `results/summary.json` gains `regionFailures`, and `/data/index.json`
lists the split registry.

### A score is two figures, never one

Divergence is the share of the whole suite a target answers differently from real
DynamoDB. Coverage is the share it implements at all. They are reported apart and
never summed, because a declined operation is discoverable in minutes and a wrong
one in production. No target was re-run for the change and no pass, fail or skip
moved: what changed is how the same counts are expressed.

Everything else that was a percentage followed the headline down - tier figures,
the per-region drilldown, the per-operation table, and the colour bands, which
inverted with them. A target's history is two plots rather than one, because
divergence falls when a target stops attempting something it used to get wrong,
so a divergence line alone can render a withdrawal as an improvement.

### Every target wears a letter

Divergence sets it - A under 5%, B under 15%, C under 25%, D under 35%, F beyond
- and coverage can only lower it, never raise it: a third of whatever a target
leaves unimplemented is added to its divergence before the bands are read. A+ is
exactly zero divergence at full coverage. A row says when coverage is holding its
letter down, so a capped row is not mistaken for one with room above it. Real
DynamoDB reads `baseline` rather than a letter, because grading the yardstick
against itself would seat it in a band an engine had to earn its way into.

These are grading criteria version 1, dated in the
[methodology](https://paritysuite.org/methodology#grading), which carries the
derivation. Where a threshold sits is a hand-picked input to a published letter,
and moving one regrades targets whose results never changed, so any change to a
band, the coverage weight or the A+ gate bumps the version.

### The suite grows from 998 tests to 1054

**Vector search (#125).** 42 tests over the deterministic surface DynamoDB
shipped in August 2026: the index lifecycle on both creation paths, request
validation on each plane, rejection wording, write-path validation, search on a
fixture where the nearest neighbour is unambiguous, the two new capacity shapes,
and PartiQL's inability to reach a vector index. Every pinned value was
characterised against real DynamoDB in eu-west-2 before it was asserted. Two
findings worth naming: searching during a backfill is an error, which settles
which side of a contradiction in AWS's own documentation is right - three
developer-guide pages say the call fails, the tutorial page says results can be
incomplete - and an overwrite leaving the stored vector unchanged reports no
vector write capacity at all, because index replication is delta-based. Both
sides are captured in `captures/2026-08-12-vector-backfill-docs.json`. No
emulator implements the family yet, so every target skips it and every coverage
figure drops with this release while divergence is untouched. Sending the new
operations needs `@aws-sdk/client-dynamodb` 3.1103.0 or later.

**Index write costs (#124).** 14 tests. The suite's only per-index capacity
assertion was on a Query, so the write side - the half you get billed extra for -
went unmeasured. A sub-1KB write costs one unit for the table and one for each
index it lands in, and LSI units fold into the total exactly as GSI units do.
Moving an item to a new GSI key costs two on that index, a delete and an insert;
touching a projected attribute costs one; touching a non-projected attribute
costs nothing, and the response carries no arm for that index rather than a zero.
An overwrite that leaves the item unchanged reports no index cost whatsoever.

**The index exclusions create no indexed table (#116).** `!gsi and !lsi` used to
select the right tests and then build the tables anyway, so an engine with no
secondary-index support died in setup whatever it had asked for. Shared tables
are created on demand from what the running file declared, the composite table
split into indexed and plain variants, and three guards keep the declarations and
the tags honest.

### Corrections

- **The suite counts its own tests.** "The whole suite" had meant whichever
  target ran the most tests, so one of the measured things was setting the
  denominator every figure divided by. `registry/suite-manifest.json` lists every
  test by file and full name, generated from the suite rather than inferred from
  a run, and CI fails if it drifts. Publishing now refuses a row whose test
  population disagrees with it, which catches a results file carried across a
  rename that keeps its old total while naming tests that no longer exist.
- **Every figure on a row comes from one region.** A headline came from the
  target's best-matching region while its tier split and raw counts stayed on the
  baseline region's basis. Correctness never had to reconcile, because each tier
  had its own denominator; divergence is additive, so it does.
- **The per-region overlay is matched to the run it describes**, rather than
  keyed on the date real AWS was last swept, which had put a later run's figures
  on an earlier run's page.
- **A methodology claim was wrong.** The page said that measuring divergence over
  the whole suite stops an engine implementing a sliver from posting a perfect
  score. It doesn't: zero fails is 0.0% divergence at any coverage. What does hold
  is the identity the page now states - a test going from failing to skipped
  leaves both numerators together over the same denominator, so withdrawal costs
  exactly as much coverage as it gains divergence, and is disclosed rather than
  silent.
- **The baseline row is measured rather than pinned** once real AWS has been
  observed across the whole suite. It runs in three passes and only the main one
  reached the published artefact, so the row had claimed a full suite on a run
  that recorded less. The passes are merged before scoring, each with its own
  capture date, and the row stays pinned and says so until all three report.
- **The Atom feed carries no letter on any run measured before criteria version 1
  took effect.** It had been rewriting each entry's summary with a grade the run
  never had, while leaving `<updated>` alone so no subscriber re-notified.
- **Badges publish the grade** under a `parity` label, having still been
  publishing the correctness percentage the board retired under a `conformance`
  label. The endpoint URL is unchanged; a badge whose target has no results this
  run reads `no data` rather than disappearing, because the URL sits in other
  people's READMEs.
- Two more regional splits are admitted, both `BatchGetItem` with an empty
  `RequestItems` map. The nesting-depth row was rewritten from a full 32-region
  capture, having been written from four.
- A build of an engine nests under it rather than taking a row beside it, and
  `maintainedByAuthor` is keyed on the project, so it now reads `true` for the
  WebAssembly build. That build runs in CI like every other target, where its row
  had been refreshed by hand.
- The board leads with the highest-graded engine, since the baseline moved into a
  panel above the standings. Where that is the board author's own engine, the
  conflict-of-interest disclosure sits on the card.
- The Region column is gone. It named the cohort a target matched at its best
  rate, which read as breadth. The count sits beside the figure instead, and the
  cohort listing stays on the target page.
- Each target lists how it is actually distributed, with the project's own page
  for each. These are the only claims on the board the suite does not measure, so
  each carries the link that backs it.

## 2026-07-21 (2.1.0)

Grew to 982 tests, up 28, all characterised against real DynamoDB across the
per-region ground truth 2.0.0 put in place. New coverage is PartiQL's
RETURNING clause; the GSI lifecycle also joins the ground truth, and the
sweep's drift classifier gains a converged case.

- PartiQL RETURNING (#103, #105): the clause pinned across every PartiQL
  surface. DELETE accepts only `RETURNING ALL OLD *` and rejects the other
  three variants with a 400, the message pinned; UPDATE accepts all four
  ALL/MODIFIED x OLD/NEW forms, where MODIFIED returns just the changed
  attribute and drops the key. The empty-projection edges are pinned too: a
  MODIFIED projection that resolves to nothing - a nested leaf, a list index,
  a batch statement - returns `Items: []` rather than a keyed row.
  BatchExecuteStatement honours RETURNING; ExecuteTransaction rejects it. The
  non-upsert paths round it out: INSERT on an existing item, and UPDATE or
  DELETE behind a false predicate, fail ConditionalCheckFailed and leave the
  item untouched.
- PartiQL RETURNING over list indices (#102): the MODIFIED projection shapes
  for a list-index `SET` or `REMOVE`, pinned against real AWS. The projection
  reads the literal index against the resulting list (`MODIFIED NEW *`) or the
  prior list (`MODIFIED OLD *`): an in-range index returns its element, an
  out-of-range one returns nothing, and multiple changed indices pack into a
  dense list in ascending index order. So a non-zero index collapses to one
  element, an append projects only when the index lands inside the new list,
  and removing the last index yields nothing under NEW while a middle REMOVE
  returns the shifted element. Setting an index on an absent attribute is
  rejected, not auto-created. In BatchExecuteStatement a member that fails to
  parse surfaces per-statement with the short `Code: ValidationError`, the same
  Code as an execution failure, and does not fail the batch.
- GSI lifecycle in the ground truth (#100): the 14 UpdateTable GSI lifecycle
  tests are now observed by the weekly sweep and recorded as per-region ground
  truth. They are the one slice the gating run drops for runtime, so they were
  the one slice without a real-AWS answer; the sweep records them without
  slowing the gate.
- Drift classification (#104): a drift where every region moves off the pinned
  answer at once is now classified as converged rather than moved, with the
  converged path covered end to end.

## 2026-07-17 (2.0.0)

Per-region scoring lands complete. 2.0.0-pre put the scoring logic in place,
comparing each target against every region's recorded answer, but the
evidence half was never wired: no test recorded what a target actually
answered and the classifier never read one, so a fail could not be credited
to a region the target matched and the score could only ever subtract. 2.0.0
closes that loop, and the seed split runs its whole lifecycle in the same
release.

What changed:

- The split tests now record what the target actually answered
  (`src/observation-sink.ts`), in the same shape the registry stores each
  region's answer, and the classifier carries it onto the verdict. An engine
  that matches a rejecting region on a split is now scored as passing in that
  region. Evidence only ever redeems a committed fail: a pass keeps the
  committed assertion's deliberate wording tolerance and is never held to the
  byte-exact recorded string. Committed results predate the capture, so
  published scores move on each target's next run, not in this change.
- Headline ties now prefer a region the registry characterises. A region
  absent from every split row ties the top score by having nothing recorded
  about it, and the Region column must not answer "conformant to what?" with
  a region the suite knows nothing about. Only the label is affected; a
  strictly higher score still wins whatever its source.
- The seeded `{ NULL: false }` split closed its own loop. eu-west-2 and
  eu-central-1 were the last regions accepting it; by the 2026-07-17 sweep
  both reject it again, so every region agrees, the split is retired, and its
  test asserts the shared rejection. The detect, admit and reconcile path the
  pre-release introduced, exercised end to end within days.
- A tooling test now asserts every tracked file is text, after a raw NUL
  byte used as a delimiter in one source file made grep classify the file as
  binary and silently skip it.

## 2026-07-13 (2.0.0-pre)

The scores barely move in this release, but what they mean has changed.

Until now the suite pinned one region, eu-west-2, as ground truth. That was
quietly unfair: real DynamoDB disagrees with itself in a handful of places,
and a one-region baseline takes a side without saying so. The clearest case
is the `{ NULL: false }` attribute value - accepted and normalised to
`{ NULL: true }` in eu-west-2 and eu-central-1, rejected with a
ValidationException in us-east-1 and ap-southeast-2. An engine matching
us-east-1 on that behaviour was marked non-conformant for doing exactly what
real DynamoDB does in Virginia. From 2.0.0, ground truth is per region.

What changed:

- A weekly sweep runs the full suite against real DynamoDB in every
  commercial region and publishes per-region ground truth
  (`.github/workflows/sweep.yml`, `ground-truth/`). It gates nothing: PR
  scoring stays offline and deterministic.
- Confirmed regional splits live in a checked-in registry
  (`registry/splits.json`), each row carrying what every named region
  actually returned, when, and who admitted it. Detection is automatic;
  admission is not. The sweep files an issue with the evidence, and only a
  human commits a row. The registry ships seeded with the `{ NULL: false }`
  split.
- Each target is scored against every observed region's expectations, and
  its published number is its best-matching region - named in the results
  table's new Region column, with the full per-region view in
  `results/summary.json` (a versioned, additive artefact; the per-target
  `results/<slug>.json` files are unchanged in shape).
- A third result state, indeterminate, for a failed observation: a timeout,
  an exhausted throttle, a transport fault. It is excluded from both sides
  of the score and cannot become a split, a registry row, or a fail. An
  absent answer is not a different answer.
- Region health is tracked in `registry/regions.json`. A region that cannot
  complete a sweep is published as unresolved rather than silently omitted;
  two consecutive misses drop it from the scored set and page a maintainer
  in the same act.

One deliberate departure from the RFC that proposed this (#75): the RFC
suggested a behaviour conforms if it matches *any* real region. 2.0.0
scores each target against one region at a time and headlines the best
match, so a target only passes a behaviour when at least one real region
does what it did, and its headline reflects one coherent region rather than
a mix. Match-any scoring would have accepted an engine that combines
eu-west-2's answer on one behaviour with us-east-1's on another - a
deployment that exists nowhere. That is stricter than the RFC asked for,
and it is deliberate.

No score moves at release: the one admitted split pins eu-west-2, which is
the only region in the health record until the first sweep runs. Per-target
deltas will be published once the sweep admits more regions; the expected
movement is roughly a tenth of a percent for the six engines that match
us-east-1 on the `{ NULL: false }` split.

The suite also grew to 954 tests, up 81, all characterised against real
DynamoDB - the control-plane pins in eu-west-2, everything else across four
regions (eu-west-2, eu-central-1, us-east-1, ap-southeast-2):

- UpdateTable AttributeDefinitions reconciliation (#77, #78, #79):
  delta-fed GSI adds merge into the stored union rather than replacing it, a
  conflicting redeclaration of an existing key keeps the stored type, and
  deleting a GSI prunes only its orphaned key attributes. An unused
  definition on an add is silently dropped where CreateTable rejects the
  same shape.
- ProjectionExpression validation (#81): duplicate paths, alias collisions
  and parent/child overlaps rejected identically on GetItem, Query, Scan and
  BatchGetItem, pinned with exact messages; legal shared-prefix projections
  guarded as accepted; GetItem's misfiled validation tests rehomed into
  Tier 3.
- Expression-size limit (#80): every expression parameter caps at 4096
  bytes, measured on the raw string before ExpressionAttributeNames
  substitution - 4096 accepted, 4097 rejected, on all five expression
  surfaces. No tracked target enforces this limit today, so the Tier 3
  movement it causes is new coverage, not a regression.
- Empty set members (#82): empty strings in an SS and zero-length members
  in a BS are accepted and round-trip intact through every write path,
  and contains() can find them; an empty NS member and duplicate empty
  members are rejected, with messages pinned. One existing assertion got
  stricter: the empty-binary round-trip now asserts byte length zero.

## 2026-07-01

Grew to 873 tests, up 49, all characterised against real DynamoDB in eu-west-2.
New coverage in three areas:

- ConsumedCapacity: the transactional read/write split on a same-token replay and
  on ExecuteTransaction, and a correction that single-item operations report the
  aggregate CapacityUnits and omit the split, which is transactional-only.
- Empty-binary key values: rejected as a top-level ValidationException on every
  path, including secondary-index keys and inside transactions, mirroring the
  empty-string rejection.
- Expression, limit and response-shape parity: KeyConditionExpression operand and
  nested-path rules, ExpressionAttributeNames/Values hygiene, projection
  validation and list-index fidelity, reversed-bounds BETWEEN, read-path
  key-length and segment caps, whitespace numbers, batch unprocessed fields and
  cross-table projection mixing, the bare no-op upsert, multi-subpath
  UPDATED_NEW, filter operand ordering, hash-only-GSI pagination, and CreateTable
  spec validation.

## 2026-06-30

Grew to 824 tests, up 7, in two parts: two sibling-parity gaps where one half of
a rule was pinned and the other was not, and the capacity accounting of
conditional and idempotent transactional writes. All characterised against real
DynamoDB in eu-west-2.

The first covers the LSI side of the INCLUDE-projection-without-NonKeyAttributes
rejection; the GSI side already had it. An LSI declared with ProjectionType
INCLUDE and no NonKeyAttributes is rejected as a ValidationException in tier1 and
pinned to the exact message in tier3, the same wording the GSI case returns.

The second pins the Query message for Select SPECIFIC_ATTRIBUTES with no
ProjectionExpression, which Scan already had. Query and Scan enforce the same rule
but word it differently: Query wraps the phrase in the "1 validation error
detected:" envelope, Scan returns it bare.

The transaction cases settle what a conditional TransactWriteItems actually costs.
A passing condition adds no read capacity: a conditional write bills the same 2 WCU
per sub-1KB item as an unconditional one, and a standalone ConditionCheck costs 2
WCU, billed as write not read. Idempotent replay splits the accounting - the first
call reports 2 write capacity units, a same-token replay within the window reports
2 read capacity units for re-reading the stored result. A failing condition cancels
the transaction, and the response carries no ConsumedCapacity at all. Answers #27.

## 2026-06-26

Grew to 817 tests, up 55, covering DynamoDB's 32-level document nesting limit,
number-set equality precision, Number format on PutItem, and a sweep of
parameter-combination rejections behind a new negative-path filter. The nesting cases
pin the boundary on both paths - a stored item via PutItem and an ExpressionAttributeValue
in a ConditionExpression - accepting 31 levels of map nesting and rejecting 32 with the
same ValidationException, captured against real DynamoDB in eu-west-2. The
expression-value error comes back bare, before the condition is evaluated, not wrapped
as an invalid-value message. The precision case pins that two number sets differing
only in the last of 18 digits are distinct, where an f64 comparison would collapse them
and report a match.

A negative-path tag now marks every wholly-rejection describe across all three tiers, so
a run can select or exclude the rejection class with `--tags-filter` - something
directory filtering cannot do, because the negative describes are not all under tier3/.
The new rejection cases it makes filterable pin parameter combinations that are each
well-formed but illegal together, caught before any read: Scan parity for the
Select/ProjectionExpression and consistent-read-on-a-GSI rules already held on Query;
DeleteItem and BatchGetItem rejecting a legacy non-expression parameter mixed with its
modern expression equivalent; and three CreateTable contradictions - PAY_PER_REQUEST
with a ProvisionedThroughput, a GSI INCLUDE projection with no NonKeyAttributes, and a
stream left disabled while a StreamViewType is set. Each was characterised against real
DynamoDB in eu-west-2 and asserts the contractual phrase, floating the region-varying
envelope.

The Number format cases pin which N strings DynamoDB accepts, how it normalises them on
read-back, and which it rejects. A leading '+' on the mantissa is accepted and dropped
(+5 stored as 5), along with the bare-decimal and trailing-dot forms (.5, 5., 1.e5);
1+2, 1.2.3, +e2, a digitless exponent, and any surrounding or internal whitespace are
rejected with a ValidationException. A '+'-prefixed numeric sort key normalises to the
same key as its bare form. Captured against real DynamoDB in us-east-1.

## 2026-06-24

Grew to 762 tests, up 18, covering a malformed value in the lookup Key of a
TransactWriteItems Update, Delete, or ConditionCheck - the path a Put item key does
not take. Captured across four regions (eu-west-2, us-east-1, ap-southeast-2,
eu-central-1), where every string was identical, so they pin exactly. An empty-string
Key surfaces as a top-level ValidationException with the same message a Put item key
gives; a wrong-typed or non-scalar Key cancels with a ValidationError reason carrying
"The provided key element does not match the schema" - the key-only form, not the
"Type mismatch for key" message the item-key path returns. The same run confirmed the
BatchWriteItem table-key schema-mismatch message is region-invariant.

## 2026-06-23

Grew to 744 tests, up 8, pinning the Select / ProjectionExpression rules on Query
and Scan. A ProjectionExpression is only valid with Select SPECIFIC_ATTRIBUTES, and
ALL_PROJECTED_ATTRIBUTES is only valid with an IndexName; real DynamoDB rejects both
with a ValidationException before reading anything. The cases span ALL_ATTRIBUTES,
COUNT, and ALL_PROJECTED_ATTRIBUTES, including the request that breaks both rules at
once, where AWS reports the ProjectionExpression one. They assert the contractual
phrase, so they hold whether or not the engine carries the wrapper AWS adds on Query
but not Scan.

## 2026-06-22

Grew to 736 tests, up 30, covering what TransactWriteItems and BatchWriteItem do
with an item whose key value is malformed - the wrong type, non-scalar, or an
empty string - across both table and index keys. PutItem already covered this;
the transactional and batch paths covered none of it.

Characterising it against real AWS turned up a split worth pinning. An
empty-string key value is rejected by up-front input validation, so even inside a
transaction it surfaces as a top-level ValidationException. A wrong-typed or
non-scalar key value is caught while the transaction runs, so it comes back as a
TransactionCanceledException carrying a ValidationError reason rather than a
top-level error. BatchWriteItem has no cancellation path, so every variant there
is a plain ValidationException. The tests pin both halves, which catches two
opposite mistakes: an engine that wraps the empty-string case as a cancellation,
and one that surfaces the type-mismatch case as a top-level error.

## 2026-06-21

Grew to 706 tests, up 7, tightening secondary-index behaviour in Tier 1. Query
and Scan on a GSI or LSI now assert sparse membership: an item that omits the
index key stays off the index but remains on the base table. And PutItem now
rejects an item whose GSI or LSI key value is the wrong type, non-scalar, or an
empty string while the base-table keys are valid, holding an index key to its
declared scalar type the same way a table key is held.

## 2026-06-09

Real DynamoDB in eu-west-2 reworded a chunk of its validation errors, and the
Tier 3 error-message tests moved with it. They now assert the contract the error
carries - its type, the field it objects to, and the constraint - rather than the
exact prose, because AWS varies the wrapper, the echoed input value and the field
casing from one region to the next. A four-region capture in June found eu-west-2
and eu-central-1 on the new wording and us-east-1 and ap-southeast-2 still on the
old, so the line between contract and cosmetic is drawn from what is invariant
across all four.

This moves some Tier 3 numbers. Targets that were only ever marked down for
wording DynamoDB itself renders inconsistently now pass those checks, so their
Tier 3 scores rise: the suite has stopped counting a cosmetic difference as a
behavioural one. Genuine behavioural divergences are still pinned exactly, for
example PutItem with a { NULL: false } attribute, which DynamoDB now accepts in
eu-west-2 and normalises to { NULL: true }.

## 2026-05-28

Grew to 699 tests, up 15 on the previous run: seven more in Tier 1 and eight
more in Tier 2.

Tier 1 picked up two behaviours. A GetItem or BatchGetItem whose projection
matches nothing on a present item still returns that item as an empty result,
rather than treating it as absent. And the TableId from CreateTable matches the
one DescribeTable reports, holding stable across repeated calls rather than
being minted fresh each time.

Tier 2 picked up PartiQL writes with a non-key WHERE predicate. DELETE and
UPDATE evaluate the whole predicate, so a false one fails with
ConditionalCheckFailed and leaves the item untouched, a write WHERE that omits
the primary key is rejected, and a DELETE on an absent key is a silent no-op.

## 2026-05-26

Grew to 684 tests with a control-plane and table-configuration sweep: the
CreateTable/UpdateTable config parameters and the secondary control-plane
operations (limits, backups and PITR, exports and imports, Kinesis, resource
policies, contributor insights), each characterised against real AWS and
probe-skipped where a target doesn't implement it.

The published percentage changed with it. It now measures correctness over
implemented operations, Pass / (Pass + Fail), so skips no longer count against
the score. A skip is honest scope; a fail is a bug.

## 2026-05-24

Grew to 625 tests, up 24 on the previous run: eleven more in Tier 1 and
thirteen more in Tier 3, tightening coverage of core operations and the strict
edge cases.

## 2026-05-23

ExtendDB joined the run as a target. The suite itself held steady at 601 tests.

## 2026-04-27

Grew to 601 tests, up 29, and every new test landed in Tier 3: a broader strict
surface spanning validation ordering, exact error messages, service limits, and
the legacy request shapes. Floci and Ministack were added to the run as targets
the same day.

## 2026-04-24

Grew to 572 tests, up 46 on the first run: thirty-six more in Tier 1 and ten
more in Tier 2, deepening coverage of the core and complete-feature behaviour.

## 2026-03-23

The suite was established with 526 tests across the three tiers (267 Tier 1, 93
Tier 2, 166 Tier 3), run against Dynalite, DynamoDB Local, Dynoxide, and
LocalStack, with live AWS DynamoDB as the baseline.
