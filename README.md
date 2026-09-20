# Parity Suite: the DynamoDB conformance suite

[![CI](https://github.com/paritysuite/dynamodb-conformance/actions/workflows/ci.yml/badge.svg)](https://github.com/paritysuite/dynamodb-conformance/actions/workflows/ci.yml)
[![Licence: Apache 2.0](https://img.shields.io/badge/licence-Apache%202.0-blue.svg)](LICENSE)
[![Live results](https://img.shields.io/badge/live%20results-paritysuite.org-brightgreen)](https://paritysuite.org)

An independent test suite that validates any DynamoDB-compatible endpoint against real DynamoDB behaviour. It works against DynamoDB, DynamoDB Local, Dynoxide, Dynoxide (wasm), Dynalite, LocalStack, ExtendDB, Floci, Ministack, or anything else that implements the DynamoDB HTTP API.

## Why this exists

There's no official AWS conformance suite for DynamoDB. The closest thing the community has is Dynalite's test suite, but over half of its tests are stale against current DynamoDB behaviour (verified March 2026). DynamoDB Local ships with no test suite at all. Every emulator author ends up guessing at behaviour and testing against their own assumptions.

This suite fixes that by running every test against real DynamoDB first, recording what passes, and using those results as the baseline. An emulator only passes if it gives the same answer DynamoDB does.

**Live results:** [the Parity Suite board](https://paritysuite.org) - the full table for every target, tracked run over run.

## Quick start

```bash
npm install

# Run against a local target
DYNAMODB_ENDPOINT=http://localhost:8000 npm test

# Quicker run, excludes GSI lifecycle tests (see runtime notes below)
DYNAMODB_ENDPOINT=http://localhost:8000 npm run test:quick

# Run a specific tier
DYNAMODB_ENDPOINT=http://localhost:8000 npm run test:tier1
```

## Contents

**Scores** - [Results](#results) · [Tiers](#tiers) · [Operations covered](#operations-covered) · [Filtering by feature](#filtering-by-feature)

**Running it** - [Running against targets](#running-against-targets) · [Expected runtime](#expected-runtime) · [Generating results](#generating-results)

**How it works** - [Design principles](#design-principles) · [Test organisation](#test-organisation) · [Shared infrastructure](#shared-infrastructure) · [The site](#the-site) · [SDK blindspots](#sdk-blindspots)

**Taking part** - [Contributing](#contributing) · [Citing a finding](#citing-a-finding) · [Community](#community) · [Independence](#independence) · [Licence](#licence)

## Results

<!-- results:start -->
Scored against real DynamoDB in each of the 33 observed regions, at each target's best-matching region.

**Coverage** is how much of DynamoDB's behaviour a target implements.

**Divergence** is how much of it the target answers differently from real DynamoDB.

Both are shares of the whole suite, and they are never added together: an operation a target declines is discoverable in minutes, one it answers wrongly is discoverable in production.

**Grade** reads the pair, with divergence setting the letter and coverage only ever lowering it, under the versioned criteria in the [methodology](https://paritysuite.org/methodology).

**Regions** counts the observed regions a target's headline matched, as evidence rather than a score: it currently over-credits a target whose assertion matches a region's answer loosely ([#138](https://github.com/paritysuite/dynamodb-conformance/issues/138)). Real DynamoDB does not answer identically everywhere, and the per-region detail is in `results/summary.json`.

Rows are sorted by divergence. The tier columns are divergence within that tier, so lower is better in every column but Coverage. Behaviour varies by region and over time, so these are point-in-time figures.

`me-south-1` has been dropped from the observed set and is not scored against.

_Suite v3.3.0, measured against real DynamoDB on 2026-09-20. Region health as of 2026-09-02._

| Target | Grade | Version | Divergence | Coverage | Fail | Skip | Tier 1 | Tier 2 | Tier 3 | Regions |
|--------|-------|---------|-----------|----------|------|------|--------|--------|--------|---------|
| [DynamoDB](https://aws.amazon.com/dynamodb/) | baseline | live (AWS) | 0.0% | 100.0% | 0 | 0 | 0.0% | 0.0% | 0.0% | 33 of 33 |
| [Dynoxide](https://github.com/nubo-db/dynoxide) · native SQLite | A | 1.2.0 | 0.2% | 98.9% | 2 | 14 | 0.0% | 0.0% | 0.5% | 22 of 33 |
| ↳ WebAssembly / OPFS | A | 1.2.0 | 0.2% | 88.8% | 2 | 140 | 0.0% | 0.0% | 0.5% | 16 of 33 |
| [ExtendDB](https://github.com/ExtendDB/extenddb) · PostgreSQL | B | v0.1.12 | 1.8% | 78.7% | 23 | 267 | 0.0% | 0.0% | 5.6% | 16 of 33 |
| ↳ SQLite | B | v0.1.12 | 2.1% | 82.8% | 26 | 215 | 0.0% | 1.2% | 5.4% | 16 of 33 |
| [Ministack](https://github.com/ministackorg/ministack) | B | 917a87cce516 | 7.1% | 95.8% | 89 | 52 | 0.0% | 0.3% | 21.5% | 6 of 33 |
| [LocalStack](https://github.com/localstack/localstack) | B | 2026.8.3 | 8.1% | 95.3% | 101 | 59 | 2.8% | 12.5% | 10.7% | 1 of 33 |
| [Dynalite](https://github.com/architect/dynalite) | C | 4.0.0 | 11.5% | 69.1% | 144 | 386 | 10.7% | 8.1% | 15.4% | 11 of 33 |
| [Floci](https://github.com/floci-io/floci) | C | f5aa8c18302c | 15.0% | 95.3% | 188 | 59 | 0.0% | 27.5% | 22.7% | 16 of 33 |
| [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html) | C | ff89bd48ff32 | 15.7% | 94.2% | 196 | 73 | 7.5% | 15.4% | 25.9% | 16 of 33 |
<!-- results:end -->

**Divergence** is `Fail / Total` and **Coverage** is `(Pass + Fail) / Total`,
and they are never added together: an operation a target declines is one you
plan around, one it gets quietly wrong is one you find in production.

The **Grade** leads because a row carries several figures and a reader
comparing a column of them needs somewhere to start. Divergence sets the letter
(A under 5%, B under 15%, C under 25%, D under 35%, F beyond) and coverage can
only lower it, never raise it: a third of whatever a target leaves
unimplemented is added to its divergence before the bands are read, so a target
implementing the whole suite is graded on divergence alone. A+ is exactly zero
divergence at full coverage, and nothing holds it today. Real DynamoDB reads
`baseline` rather than a letter, because grading the yardstick against itself
would put it in a band an engine had to earn its way into.

Both figures print beside the letter, so any grade here is recomputable, and the
percentage points are the finer instrument: **rank on the two figures rather
than the letter** if a close call matters to you. A grade is an observation
against this suite's tests on a date, not a certification. The criteria are
versioned and dated in the
[methodology](https://paritysuite.org/methodology#grading), which carries the
derivation of the bands, the worked examples, and what withdrawing a test costs.

Rows are ordered by divergence. That ranks how much a target gets wrong rather
than telling you which one to pick, because that depends on the operations you
need: a target with no divergences over a narrow surface sits high, and its
coverage figure says how narrow.

An indented row (`↳`) is a second build of the project above it: the same
engine with a storage backend swapped underneath, or compiled for somewhere
else to run. Every build the suite runs has a row here, with its own figures,
whether or not they match the build above.

On [paritysuite.org](https://paritysuite.org) a project's other builds sit
behind a disclosure on its row. It starts closed only when every build under it
reads the same grade, divergence and coverage as the row above, and only when
each of them was measured in that run: a row carried from an earlier run, on
either side, opens the disclosure whatever the percentages say, and so does a
run the suite declined to score. The comparison is made from each run, so a
build that converges starts closed next time and one that diverges starts open
again. Markdown has no disclosure to offer, so this table lists them all
outright.

A skipped test is deliberate: each test file probes for feature support in
`beforeAll` and skips itself when the target doesn't implement that operation,
so a skip records scope rather than a gap in correctness. An indeterminate test
is a failed observation - a timeout, an exhausted throttle, a transport fault -
and counts neither for nor against a target, because nobody knows what the
answer was.

DynamoDB is the ground truth, recorded per region. Real DynamoDB disagrees with
itself in a handful of places (the admitted cases are in `registry/splits.json`),
so each target is measured in every observed region and scored against its
best-matching one, and fails a behaviour only when no observed region does what
it does. The spread is three tests in about a thousand, so the per-region detail
lives in `results/summary.json` rather than in the table.

This table is regenerated by the **Update Results Table** workflow -
automatically when a Conformance Tests run finishes on `main`, and on demand
from the Actions tab. It fills each row's Version from the run (npm version,
container image digest, release tag, or `live` for real AWS). Run
`npm run results:table` to preview it locally.

## Tiers

**Tier 1 - Core.** The operations and behaviours that 90% of DynamoDB users rely on. CRUD, queries, scans, batch operations, secondary indexes (GSI and LSI), UpdateTable. If an emulator fails Tier 1, it's not usable.

**Tier 2 - Complete.** Less common but documented features. Transactions, PartiQL, TTL, streams, tags, vector search, the online index lifecycle (adding and removing a GSI or a vector index on a live table), and the `cloud-only` surfaces below: backups and PITR, S3 export and import, Kinesis, Contributor Insights, resource policies, account reads. An emulator that passes Tier 1 but fails some Tier 2 is usable with caveats.

**Tier 3 - Strict.** Validation ordering, error behaviour at a range of strictness (exact where DynamoDB's wording is stable, structural where its rendering is non-deterministic), edge cases around limits, legacy API compatibility (ScanFilter, QueryFilter). An emulator that passes Tier 1 and Tier 2 but fails some Tier 3 is production-quality for local dev.

The tiers give emulator authors something meaningful to report. "0.0% Tier 1, 5.0% Tier 2, 20.0% Tier 3" tells you far more than a single figure over the whole suite.

### Tier 3 structure

Tier 3 splits into four sub-directories by what each test asserts:

- `validation-ordering/` - which validation fires first when a request has multiple problems. Uses `toContain` against the message; the wording can drift, the ordering should not.
- `error-messages/` - the error DynamoDB returns. Uses inline `try/catch` with `expect(err).toBeInstanceOf(...)` and `expect(err.name).toBe(...)`; the message is matched exactly where it's stable and structurally (`toContain` on the field and constraint) where AWS's rendering varies by region or SDK version.
- `limits/` - hard-coded service limits and the errors that fire when you cross them (item size, batch size, response size, transaction size).
- `legacy-api/` - the older request shapes (`AttributeUpdates`, `QueryFilter`, `ScanFilter`, `Expected`, `AttributesToGet`) for backwards compatibility.

A new test goes in whichever sub-directory matches what it asserts. If you care about the message the service returns, that's `error-messages/`. If you only care which error fires, that's `validation-ordering/`.

## Operations covered

| Operation | Tier 1 | Tier 2 | Tier 3 |
|-----------|--------|--------|--------|
| PutItem | basic, conditions (incl. parens), validation, expressions, dataTypes, consumedCapacity, indexConsumedCapacity (GSI/LSI write cost) | vector write validation, vector write capacity (projection rule, byte formula) | error messages, item size to the byte, number byte cost |
| GetItem | basic, validation, projection, consumedCapacity | | error messages |
| UpdateItem | basic, conditions (incl. parens, non-existent key branch), validation, paths, index write-capacity ladder | | error messages, item size (charged on what the statement writes, plus a per-clause cost) |
| DeleteItem | basic, conditions (incl. parens), validation, index write capacity | | error messages |
| Query | basic, GSI, LSI, expressions (incl. KeyCondition + Filter parens), select, numericKeys, binaryKeys, pagination, consumedCapacity (sized before the filter and the projection) | | error messages, validation ordering |
| Scan | basic, validation, GSI (incl. pagination), LSI (incl. pagination), parallel, select, filterOperators, filterExpression parens, consumedCapacity (sized before the filter and the projection) | | error messages, validation ordering |
| BatchWriteItem | basic, validation, index write capacity | | error messages, item size |
| BatchGetItem | basic, validation | | error messages |
| CreateTable | basic, GSI, LSI | vector indexes (lifecycle, SearchSchema, validation) | error messages, validation ordering |
| DeleteTable | basic | | |
| DescribeTable | basic | | |
| ListTables | basic | | |
| UpdateTable | basic (throughput, billing mode) | GSI lifecycle, vector index lifecycle | |
| SearchVectors | | scores per distance function, projection, capacity shape, request validation | error messages |
| TransactWriteItems | | basic, conditions (incl. parens, non-existent key branch), idempotency, cancellation | error messages, item size (flat on both actions, reported two ways) |
| TransactGetItems | | basic, validation | error messages |
| ExecuteStatement | | INSERT, SELECT, UPDATE, DELETE, parameterised, RETURNING, vector index non-reach, index qualifiers (membership, projection, reach-back, capacity arms, qualified writes), comparison on non-scalar types | error messages (RETURNING, index qualifiers), item size |
| BatchExecuteStatement | | batch, partial failure, RETURNING honoured, per-member ConsistentRead, primary-key requirement, TableName echo | |
| ExecuteTransaction | | atomic, rollback, RETURNING rejected | error messages (RETURNING) |
| UpdateTimeToLive | | enable, validation | |
| DescribeTimeToLive | | describe | |
| TagResource | | add, list, remove, validation | |
| DynamoDB Streams | | ListStreams, DescribeStream, GetRecords, view types | |
| Backups | | on-demand, continuous (PITR) | |
| ExportTableToPointInTime / ImportTable | | S3 export and import | |
| Kinesis streaming destination | | enable, describe, disable | |
| UpdateContributorInsights | | enable, describe, list | |
| Resource policies | | put, get, delete | |
| DescribeLimits / DescribeEndpoints | | account reads | |

### Operations every emulator skips

A handful of operations only exist on real AWS or reach into another AWS
service, so no emulator implements them and each one skips on every target. The
suite still exercises them against real DynamoDB - characterising AWS's own
behaviour has value - and they all carry the `cloud-only` tag, so
`--tags-filter='!cloud-only'` drops the lot:

- Import/Export to S3
- Kinesis Data Streams integration (streaming destinations)
- On-demand backups and Point-in-Time Recovery
- Contributor Insights
- Resource-based policies
- Account reads (DescribeLimits, DescribeEndpoints)

Import/Export and Kinesis lean on slow async control-plane calls that make poor
gate material, so they run in a separate non-gating job via
`npm run test:integrations` rather than on the gating run. They still run
against real AWS every scheduled run, and the ground-truth coverage check
fails if they don't.

Vector search (SearchVectors and the vector index lifecycle) is in the same
position today for a different reason: the surface shipped on AWS in August
2026 and no emulator implements it yet, so every current target skips the
whole family through its support probes. Unlike the list above it is not
`cloud-only` - it is ordinary DynamoDB surface any emulator can adopt, and the
skips (and the coverage they cost) should shrink as targets catch up. The
family carries the `vector` tag, so `--tags-filter='!vector'` drops it. The
UpdateTable half of the lifecycle backfills on GSI timescales and rides in the
same slow lane as the GSI lifecycle (`npm run test:gsi`).

Genuinely not covered, with no tests yet:

- Global Tables
- DynamoDB Accelerator (DAX)

## Filtering by feature

Tiers tell you how strict a target is. Tags tell you which capabilities it implements, and they're an independent axis: a test lives in one tier but carries a tag for the operation it covers, a `data-plane` or `control-plane` tag, and any cross-cutting trait that applies. That lets you ask a narrower question than the tier score - "how does this target do on just the features I actually use?"

Filter with vitest's `--tags-filter`:

```bash
# Ignore PartiQL
DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run --tags-filter='!partiql'

# Ignore the legacy request parameters (AttributeUpdates, QueryFilter, ...)
DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run --tags-filter='!legacy'

# Only item reads and writes, no table management
DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run --tags-filter='data-plane'

# Drop the operations no emulator implements
DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run --tags-filter='!cloud-only'

# Skip secondary indexes entirely, and create no table that has one
DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run --tags-filter='!gsi and !lsi'

# Compose them, and with tiers: transactions only, excluding cloud-only async
DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run tests/tier2 --tags-filter='transactions and !cloud-only'
```

The grammar takes `and` / `&&`, `not` / `!`, `or`, parentheses, and `prefix/*` wildcards, and it composes with the tier scripts and directory paths.

The vocabulary lives in one place, `src/tags.ts`, and stays honest two ways: `strictTags` rejects an undeclared tag the moment the suite runs, and a coverage guard (`npm run test:tooling`) fails if any test is left untagged. So an exclusion like `!partiql` can't silently miss a test that someone forgot to tag.

### What excluding an index buys you

Most exclusions only change which tests run. The index ones also change what gets built, which matters if your engine can't build it.

Tables are created on demand: a test file declares the shared tables it needs, and a run creates what its selected files asked for and nothing else. Exclude `gsi` and `lsi` and no table carrying a secondary index is ever created, so an engine with no index support can complete the run instead of dying in setup.

The shared indexed table carries both kinds together, so any test using it is tagged `gsi` and `lsi` both, and excluding either axis drops it. That costs some precision when you select rather than exclude: `--tags-filter='gsi'` picks up tests that only exercise an LSI, because they share a table. If a target ever supports one index kind and not the other, splitting the table into separate variants is the way to fix that, at the cost of seeding both.

<!-- tags:start -->
**Operation tags** - one per test, matching the operation it exercises.

| Tag | Plane | Operation |
|-----|-------|-----------|
| `put-item` | data-plane | PutItem |
| `get-item` | data-plane | GetItem |
| `update-item` | data-plane | UpdateItem |
| `delete-item` | data-plane | DeleteItem |
| `query` | data-plane | Query |
| `scan` | data-plane | Scan |
| `batch` | data-plane | BatchGetItem, BatchWriteItem |
| `transactions` | data-plane | TransactWriteItems, TransactGetItems |
| `partiql` | data-plane | ExecuteStatement, BatchExecuteStatement, ExecuteTransaction |
| `search-vectors` | data-plane | SearchVectors |
| `create-table` | control-plane | CreateTable |
| `update-table` | control-plane | UpdateTable |
| `delete-table` | control-plane | DeleteTable |
| `describe-table` | control-plane | DescribeTable |
| `list-tables` | control-plane | ListTables |
| `ttl` | control-plane | UpdateTimeToLive, DescribeTimeToLive |
| `streams` | control-plane | DynamoDB Streams |
| `resource-tags` | control-plane | TagResource, UntagResource, ListTagsOfResource |
| `backups` | control-plane | On-demand backups, point-in-time recovery |
| `export-import` | control-plane | ExportTableToPointInTime, ImportTable |
| `kinesis` | control-plane | Kinesis streaming destinations |
| `contributor-insights` | control-plane | UpdateContributorInsights |
| `resource-policy` | control-plane | PutResourcePolicy, GetResourcePolicy, DeleteResourcePolicy |
| `account` | control-plane | DescribeLimits, DescribeEndpoints |

**Cross-cutting tags** - applied wherever they fit.

| Tag | Meaning |
|-----|---------|
| `data-plane` | Reads or writes items |
| `control-plane` | Manages tables, indexes, or table-level features |
| `cloud-only` | No emulator implements it; needs real AWS infrastructure, another AWS service, or account/region context |
| `gsi` | Depends on a Global Secondary Index, whether it queries one, asserts on an index key, or creates a table carrying one |
| `lsi` | Depends on a Local Secondary Index, on the same terms |
| `vector` | Depends on a vector index, whether it searches one, writes through one, or creates a table carrying one |
| `legacy` | Sends a deprecated request parameter (AttributeUpdates, QueryFilter, ScanFilter, Expected, AttributesToGet), wherever the test lives |
| `slow` | Long-running against real AWS; the set `test:gating` excludes |
| `negative-path` | Asserts only rejections: every case expects a validation error, conditional-check failure, or transaction cancellation |
<!-- tags:end -->

## Running against targets

### Dynalite

```bash
npx dynalite --port 8002 &
DYNAMODB_ENDPOINT=http://localhost:8002 npm test
kill %1
```

### DynamoDB Local

```bash
docker run -d --name ddb-local -p 8000:8000 amazon/dynamodb-local:latest
DYNAMODB_ENDPOINT=http://localhost:8000 npm test
docker stop ddb-local && docker rm ddb-local
```

### Dynoxide

```bash
dynoxide --port 8001 &
DYNAMODB_ENDPOINT=http://localhost:8001 npm test
kill %1
```

### Dynoxide (wasm)

A separate engine from the native build above, scored as its own row. The same
query layer compiles to `wasm32-unknown-unknown` and runs against the official
SQLite-wasm build over OPFS, in a browser Web Worker. Both engines issue the
same SQL, so the two rows differ only where the backends do.

The engine has no HTTP server of its own - it answers a `postMessage` RPC
(`open`, `execute`, `capabilities`). Reaching it needs a shim that speaks the
DynamoDB HTTP API on a port and forwards each request into a headless browser
running the shipped `dist/` bundle. Dynoxide ships that shim as a repo script,
so the suite sees a port like every other target. The script is test-only and
deliberately undistributed - it is not a way to run dynoxide, and getting it
means cloning the repo.

```bash
# in a dynoxide checkout: build the bundle, then serve it
npm ci && npm run build:wasm
npm run wasm:serve &        # http://127.0.0.1:8003, installs its own browser

# back in this repo
DYNAMODB_ENDPOINT=http://127.0.0.1:8003 CONFORMANCE_TARGET=dynoxide-wasm npm test
```

Port 8003 keeps it clear of the native build on 8001; the script also takes a
second port for its internal static server, defaulting to 8004. `--port` and
`--asset-port` override both.

It's a preview with deliberate gaps. PartiQL, `TransactWriteItems`, tags and TTL
aren't implemented, so those tests skip rather than fail and the row carries a
far higher skip count than any other target. Read the row as "correct on what it
implements", not as a like-for-like comparison with a target that implements
everything.

One scope caveat worth knowing. The shim opens the engine `ephemeral`, which
forces an in-memory database so no OPFS state can leak between runs. That keeps
the run clean, but it means the conformance path does not exercise OPFS
persistence, which is the wasm build's actual storage layer. Dynoxide covers
persistence in its own browser tests.

### ExtendDB

ExtendDB is heavier than the other local targets: it builds from source
(Rust), stores data in PostgreSQL 14+, mandates TLS, and verifies SigV4
against a local IAM store. `scripts/run-extenddb.sh` automates the whole
bring-up (build, init, a `dynamodb:*` IAM user, access key, serve) against a
PostgreSQL instance, and the CI job uses it. To wire it up by hand instead,
build ExtendDB, run `extenddb init`, create an IAM user with a `dynamodb:*`
policy plus an access key (ExtendDB getting-started guide, "Post-init
workflow"), then start it and point the suite at it:

```bash
# ExtendDB 0.1.2 defaults to port 18443, so pin the suite's 8000 explicitly.
# Env vars prefixed EXTENDDB__ layer over the config file (the same mechanism
# scripts/run-extenddb.sh uses), so this makes serve bind 8000.
export EXTENDDB__SERVER__PORT=8000
./target/release/extenddb serve --config extenddb.toml   # https://127.0.0.1:8000

# The JS SDK ignores AWS_CA_BUNDLE; trust the self-signed cert via NODE_EXTRA_CA_CERTS.
export NODE_EXTRA_CA_CERTS=~/.extenddb/tls/cert.pem
export AWS_ACCESS_KEY_ID=<access-key-id>        # a real key - ExtendDB verifies the signature
export AWS_SECRET_ACCESS_KEY=<secret-access-key>
export AWS_REGION=us-east-1                      # SigV4 signing region for the local endpoint; ground truth is recorded per region, so no single region needs matching
export DYNAMODB_ENDPOINT=https://127.0.0.1:8000
CONFORMANCE_TARGET=extenddb npm test            # writes results/extenddb.json
```

Use `127.0.0.1` or `localhost` (both are in the cert's SANs). ExtendDB does
not implement PartiQL, so those Tier 2 tests skip.

#### The SQLite build

ExtendDB selects its storage backend at build time, and v0.1.3 added SQLite
beside PostgreSQL. It is the same server over a single file, so it needs no
database service. `scripts/run-extenddb.sh` handles the bring-up either way:

```bash
eval "$(EXTENDDB_DIR=/path/to/extenddb EXTENDDB_BACKEND=sqlite ./scripts/run-extenddb.sh)"
CONFORMANCE_TARGET=extenddb-sqlite npm test   # writes results/extenddb-sqlite.json
```

By hand it is the PostgreSQL flow with one line changed, the feature at build
time. SQLite takes no connection details, so `init` only names the backend:

```bash
cargo build --release -p extenddb --no-default-features --features sqlite
./target/release/extenddb init --backend sqlite   # database at ./extenddb.sqlite
```

The database path comes from the config file. ExtendDB documents
`serve --sqlite-path <path>` for overriding it, but v0.1.3 declares that flag
on no subcommand and rejects it, so `[storage.sqlite].path` is the only way in.
Checked against v0.1.3 rather than assumed.

`init` refuses to overwrite an existing database, so a repeat local run wants
`extenddb destroy` first.

ExtendDB also ships a `dev-mode` build feature that serves plain HTTP with open
authorisation. The suite deliberately does not use it. It would change the
security posture, and these two rows are meant to differ only in storage engine.

### Floci

```bash
docker run -d --name floci -p 4566:4566 floci/floci:latest
DYNAMODB_ENDPOINT=http://localhost:4566 npm test
docker stop floci && docker rm floci
```

### LocalStack

LocalStack requires a free account. Sign up at [localstack.cloud](https://www.localstack.cloud) and set your auth token.

```bash
export LOCALSTACK_AUTH_TOKEN=your-token-here
docker run -d --name localstack -p 4566:4566 -e LOCALSTACK_AUTH_TOKEN localstack/localstack
DYNAMODB_ENDPOINT=http://localhost:4566 npm test
docker stop localstack && docker rm localstack
```

### Ministack

```bash
docker run -d --name ministack -p 4566:4566 ministackorg/ministack:latest
DYNAMODB_ENDPOINT=http://localhost:4566 npm test
docker stop ministack && docker rm ministack
```

### Real DynamoDB

```bash
# Uses the default AWS credential chain (env vars, ~/.aws/credentials, IAM role)
npm test
```

## Expected runtime

| Target | `npm test` | `npm run test:quick` |
|--------|-----------|---------------------|
| Local emulators | ~2-5 seconds | ~2-5 seconds |
| Real DynamoDB | ~1-3.5 hours | ~20-25 minutes |

The full suite includes slow online-index lifecycle tests: 14 UpdateTable GSI tests that add and remove Global Secondary Indexes from existing tables, plus two UpdateTable vector index tests, which backfill on the same machinery: the lifecycle walk, and a shorter one asserting that the table cannot be deleted while an index is still being created. That second one cancels the index rather than waiting the backfill out, so it costs about a minute. On real DynamoDB, each index creation triggers a backfill that usually takes 5-15 minutes even on small tables, and has been observed taking 25+ on a slow night (a 25-item vector index took ~17). These tests are important for conformance but they dominate runtime against real AWS.

`test:quick` excludes the online-index lifecycle tests (GSI and vector) for faster local iteration. CI's gating real-DynamoDB job runs `test:gating`, which drops those *and* the S3 and Kinesis integration suites (see "Operations every emulator skips" above), so a slow async import can't redden the build. Emulator targets run the full `npm test` since index creation is instant locally.

Nothing is dropped from real AWS by being off the gate, only moved. Real-AWS
coverage runs in three lanes, split by runtime rather than by importance:

| Lane | Scope | Gates the build |
|------|-------|-----------------|
| `test:gating` | the suite minus the two below | yes |
| `test:integrations` | S3 export/import, Kinesis | no |
| `test:gsi` | the UpdateTable online-index lifecycle tests (GSI and vector) | no |

The GSI lane exists because a full green run of that file was measured at
2h50m against real AWS on a slow backfill night, far longer than the gating
run can absorb. It gets a lane sized for it instead of being skipped.

Because the published DynamoDB row is scored across the whole suite, the
**Ground-truth coverage** job unions the three lanes after every scheduled run
and fails if any test in the suite has no real-AWS observation behind it. Run
it yourself with `node scripts/ground-truth-coverage.mjs --reference
results/<emulator>.json <ground-truth files>`. A hole in ground truth is the
one thing here that is never allowed to be quiet.

## Design principles

**Ground truth first.** Every test is validated against real DynamoDB. Behaviour is recorded per region: a weekly sweep runs the full suite in every commercial region, and the few behaviours where regions genuinely disagree are held, with evidence, in `registry/splits.json`. If DynamoDB's behaviour changes, the suite updates.

**Observable behaviour only.** Tests verify what comes back over the wire: response bodies, error types, error messages. No testing of internal implementation details.

**SDK-driven.** Tests use the AWS SDK v3 for JavaScript rather than raw HTTP. This tests what real applications actually experience.

**Endpoint-agnostic.** A single environment variable (`DYNAMODB_ENDPOINT`) points the suite at any target. No target-specific code paths, no special cases.

## Test organisation

```
tests/
  tier1/                    # ~489 tests
    createTable/            # basic, gsi, lsi
    putItem/                # basic, conditions, validation, expressions, dataTypes, ...
    getItem/                # basic, validation, projection, consumedCapacity
    deleteItem/             # basic, validation
    updateItem/             # basic, conditions, validation, paths
    query/                  # basic, gsi, lsi, expressions, select, numericKeys, binaryKeys
    scan/                   # basic, validation, gsi, lsi, parallel, select, filterOperators
    batchWriteItem/         # basic, validation
    batchGetItem/           # basic, validation
    deleteTable/            # basic
    describeTable/          # basic
    listTables/             # basic
    updateTable/            # basic
  tier2/                    # ~225 tests
    transactions/           # transactWrite, transactGet
    partiql/                # executeStatement, batchExecuteStatement, executeTransaction
    ttl/                    # basic
    streams/                # basic
    tags/                   # basic
    updateTable/            # gsi
    vectorSearch/           # lifecycle, updateLifecycle, search, validation,
                            # writeValidation, consumedCapacity, partiql
  tier3/                    # ~340 tests
    validation-ordering/    # per-operation validation error ordering
    error-messages/         # exact error message strings
    limits/                 # itemSize, batchLimits, responseSize, transactionLimits,
                            # numberPrecision, emptyValues, reservedWords
    legacy-api/             # expected, attributeUpdates, queryFilter, scanFilter, attributesToGet
```

## Shared infrastructure

- `src/client.ts` - DynamoDB and Streams client, configured from the `DYNAMODB_ENDPOINT` env var
- `src/helpers.ts` - table lifecycle, assertion helpers (`expectDynamoError`, `cleanupItems`, `waitForGsiConsistency`)
- `src/vector.ts` - vector search feature probes (`skipUnlessSearchVectors`, `skipUnlessVectorIndexes`) and index-aware waiters (`waitForVectorIndexActive`, `waitForVectorSearchable`)
- `src/setup.ts` - per-file beforeAll that creates the shared tables the running file declared
- `src/types.ts` - `TestTableDef` and `KeyDef` types

## The site

[paritysuite.org](https://paritysuite.org) is built from `site/`, an npm workspace in this repository. It renders the files in `results/` as current standings, a page per target with its score over time, and a browsable archive of every recorded run. It imports the suite's own target maps and the same divergence, coverage and grading arithmetic, so the board and the table above can't disagree about a target's name, its link, or its score.

```bash
npm run site:dev     # http://localhost:8080
npm run site:build   # writes site/_site/
npm run site:test
```

`site/README.md` covers the data flow and the build; `AGENTS.md` covers the architecture and the invariants.

## Generating results

```bash
# Run against a target and save JSON output
DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run --reporter=json --outputFile=results/dynamodb-local.json

# Generate the comparison table from all saved results
npm run results:table

# Re-enumerate the suite after adding, moving or renaming a test. This is the
# count every published figure divides by, and CI fails a PR that leaves it
# stale.
npm run suite:manifest

# Which targets look like they share an implementation, measured by how much
# of their failure set they have in common. A prompt to go and check, not a
# published artefact: it writes nothing and feeds nothing on the board.
npm run results:lineage
```

## SDK blindspots

This suite uses the AWS SDK v3 (not raw HTTP), which means it can't test:

1. **Request signing validation** - the SDK always signs correctly
2. **Error wire format** - `__type` field naming, `message` vs `Message` casing
3. **Content-type handling** - the SDK always sends `application/x-amz-json-1.0`
4. **Connection-level behaviour** - HTTP headers, chunked encoding, CRC32 checks

You'd need a raw HTTP test layer using `fetch()` with `aws4` signing for those. The dynalite test suite is a good reference for that approach.

## Contributing

### Adding tests

1. Follow existing patterns in the relevant tier directory
2. Use `expectDynamoError()` for error assertions, not try/catch
3. Use `cleanupItems()` in `afterAll` for data cleanup
4. Use `ExpressionAttributeNames` for all attribute names in expressions (avoid reserved words)
5. Use `ConsistentRead: true` on all read-back assertions
6. **Test against real DynamoDB first** - if AWS fails, the test is wrong by definition

### Adding a target

1. Start the target on a port
2. Run: `DYNAMODB_ENDPOINT=http://localhost:<port> npx vitest run --reporter=json --outputFile=results/<target>.json`
3. Generate the table: `npm run results:table`
4. Submit a PR with the results JSON

If the target speaks HTTPS only or verifies request signatures (ExtendDB is
the first such target), two extra steps apply: trust its certificate with
`NODE_EXTRA_CA_CERTS=/path/to/cert.pem` (the JS SDK does **not** read
`AWS_CA_BUNDLE`), and pass a real `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
whose policy allows the operations the suite exercises. Before committing the
results JSON, grep it for your key to be sure no credential leaked into it, and
run `npm run results:check-leaks`, which catches account IDs and the machine
paths Vitest records.

If the engine doesn't speak DynamoDB HTTP at all - a browser or embedded engine
reached over its own RPC - it can still be tracked, provided the vendor fronts
it with a shim exposing the HTTP API on a port (Dynoxide wasm is the first such
target). The suite stays endpoint-agnostic either way. Two things the shim has
to get right. It must start from clean state, because the suite creates its
shared tables in `beforeAll` and never resets the target. And for any operation
the engine doesn't implement it must return `UnknownOperationException`, a
message matching `unknown operation` / `not implemented` / `unsupported
operation` / `is not supported`, or HTTP 501. That's what `isUnsupportedFault`
in `src/infra.ts` looks for; anything else arrives as an ordinary error and the
operation is scored as a failure instead of a skip.

### Test data

All test data must be synthetic. Don't use real names, emails, addresses, or any personally identifiable information in test fixtures.

## Citing a finding

When the suite surfaces a divergence in a target and you want to raise it on that
target's own issue tracker, the reference carries weight because the suite is not
the engine's own test harness: every target is scored against the same live-AWS
baseline, so "the conformance suite flags this" says more than a self-written
test can.

Fill in the bracketed parts. The block is the same whichever engine the finding concerns:

> Found by [Parity Suite, the DynamoDB conformance suite](https://paritysuite.org) (paritysuite.org), an independent project that scores multiple engines against live AWS DynamoDB.
>
> **Operation:** [e.g. CreateTable]
> **Expected (real DynamoDB, [region, e.g. eu-west-2]):** `[the exact response or error message real AWS returns]`
> **Observed in [target] [version]:** [what the target did instead]
> **Suite test:** [public link to the specific test, pinned to a commit or tag]

Two details keep the citation honest:

- **Link the specific test, and pin it.** Use a commit SHA or tag (`.../blob/<sha>/...`), never `.../blob/main/...`: a `main` link rots the moment the file is reformatted or the lines shift, while a pinned link points at the exact assertion for good. Link the test itself, not a bare in-repo path, so it resolves for anyone reading the issue.
- **Pinned test for a specific finding; site row only for a general claim.** The pinned test is durable evidence that this exact case diverged. A row on [the board](https://paritysuite.org) is a live score that moves with every run, so it answers "how does this engine do overall", not "what broke here". Don't cite a moving score as evidence for a fixed bug.

Real AWS DynamoDB is the ground truth here as everywhere: the "expected" line is what AWS does, captured against a named region, not what any emulator does. If the behaviour is one where regions disagree, say so and name the regions on each side - the admitted cases are in `registry/splits.json`.

## Community

- [Contributing](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) - how to add tests and targets.
- [Code of Conduct](CODE_OF_CONDUCT.md) - the Contributor Covenant.
- [Security policy](SECURITY.md) - how to report a vulnerability or a leaked credential privately.
- [Support](SUPPORT.md) - where to ask for help.

## Independence

This suite is maintained by the same person who maintains Dynoxide, one of the
engines it scores. Dynoxide runs through the same automated matrix as every
other target, against the same live-AWS ground truth, and the tests and the
results are both in this repo.

Two inputs are hand-picked rather than measured. The grade bands and the
coverage weight decide a published letter, and moving either regrades targets
whose results never changed, so they carry a version: these are grading criteria
version 1, and any change to a band, the coverage weight or the A+ gate bumps
the version and is dated in the
[methodology](https://paritysuite.org/methodology#grading).

`registry/splits.json` is the other, and it is written by hand by design. It
records the behaviours where real DynamoDB's own regions disagree, with the
evidence each region returned, and a target matching any recorded answer is
scored as conformant rather than wrong. Admitting a row turns a fail into a pass
with no re-run and no results file changing, which is the one thing "a score
can't be tuned without changing the published results first" does not cover. So
the registry is in this repo, every row carries its captured evidence and the
date it was refreshed, and a behaviour enters only once confirmed across regions.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
