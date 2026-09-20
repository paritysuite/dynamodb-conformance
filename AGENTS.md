# AGENTS.md

Guidance for AI coding tools (Codex, Cursor, Aider, Claude Code, and
others) contributing to this suite. Humans are welcome to read it too;
`CONTRIBUTING.md` covers the same ground in prose.

## What this suite is

An independent conformance test suite for DynamoDB-compatible
endpoints. Tests are first run against real AWS DynamoDB to establish
ground truth, then against any target (DynamoDB Local, Dynoxide,
Dynoxide (wasm), Dynalite, LocalStack, ExtendDB, Floci, Ministack, Kumo,
or anything else implementing the DynamoDB HTTP API, or fronted by a shim
that does).
Ground truth is recorded per region - real DynamoDB
disagrees with itself in a few places, and the admitted cases live in
`registry/splits.json` - so a target passes a behaviour if it returns the
same answer real DynamoDB does in at least one observed region, and its
headline score is its best-matching region.

## Ground rules for contributions

1. **Real DynamoDB is ground truth.** Run new or modified tests
   against real AWS DynamoDB where you can, and note the result in
   the PR description. If you cannot, flag that in the PR and a
   maintainer will verify against real DynamoDB before merging.
   Either way, if real DynamoDB rejects the test, the test is wrong;
   do not adjust the assertion to match an emulator. One region is
   enough: the weekly sweep runs every test in every commercial region,
   so a behaviour that turns out to be region-split gets caught there,
   not by you.
2. **No emulator-specific tests.** Tests must pass on real DynamoDB.
   The suite's value depends on this invariant.
3. **Discuss before coding for anything non-trivial.** Open a GitHub
   issue before a PR that adds a new tier, changes how a tier is
   defined, or touches the results pipeline. Small test additions and
   fixes are fine without a prior issue.

## TypeScript conventions

- Language: TypeScript, ESM (`"type": "module"` in `package.json`).
- Runtime: Node (see `package.json` engines if set) and vitest.
- Tests live under `tests/tier1/`, `tests/tier2/`, `tests/tier3/`.
- No linter or formatter is currently configured, so match the style
  of nearby code.
- Commands contributors will use:
  - `npm install`
  - `npm test` (runs vitest)
  - `npm run test:quick` (faster, skips the online-index lifecycle tests - GSI and vector)
  - `npm run test:tier1` / `tier2` / `tier3` for a single tier
- Tables are created under a namespace prefix and cleaned up by deleting
  everything matching it, so two runs sharing a prefix delete each
  other's tables. CI uses `_conformance_` and everything else uses
  `_capture_`, resolved from `CONFORMANCE_TABLE_PREFIX` or, failing
  that, from whether `CI` is set. Credentials are scoped to match, so a
  run in the wrong namespace fails with `AccessDeniedException` rather
  than deleting someone else's tables. Set the variable explicitly to
  run two local suites against one account at once.

## Test philosophy

This is what the suite exists for; please read this section before
writing a test.

Tests encode **real AWS DynamoDB behaviour**. They are not a
specification, a wish list, or an agreement between emulators. Every
test is a claim of the form "real DynamoDB does X when given Y", and
the suite's job is to check each implementation against that claim.

Implementations are checked **against real DynamoDB, not against each
other**. Two emulators agreeing on a wrong answer does not move the
baseline; real DynamoDB is the only arbiter. If an emulator author
disagrees with a test's expected value, the resolution is to re-run
it against real DynamoDB and update the baseline, not to negotiate
between emulators. Where real regions genuinely disagree with each
other, the split registry records what each region returns rather than
picking a winner - but only a maintainer admits a row, on captured
evidence, so two emulators agreeing still moves nothing.

## What a new test needs to demonstrate

Before opening a PR that adds or modifies a test:

1. **Required: the test passes against real AWS DynamoDB, in one
   region.** This is the non-negotiable gate. If real DynamoDB rejects
   the test, the test is wrong; do not adjust the assertion to make an
   emulator pass. Run with an unset `DYNAMODB_ENDPOINT` (or whatever
   your environment configures for real AWS), in whichever region you
   can reach. You are not expected to run it in more than one: the
   weekly sweep runs the full suite in every commercial region, and if
   your test lands on a behaviour where regions disagree, the sweep
   surfaces it as a split candidate for a maintainer to adjudicate.
2. **Required: the test runs cleanly against at least one emulator
   target.** This proves the test is well-formed and actually
   exercises an emulator rather than just real DynamoDB. Dynoxide is
   the easiest local target (no Docker, no JVM):
   `DYNAMODB_ENDPOINT=http://localhost:8000 npm test`. DynamoDB Local,
   Dynalite, or LocalStack are acceptable alternatives if you have
   them handy.
3. **Optional but welcome: note in the PR description how the test
   behaves across more than one emulator**, for example "passes on
   Dynoxide, fails on DynamoDB Local, matches real DynamoDB". This
   accelerates maintainer review.
4. **Consider the rejection path, not just acceptance.** Where a
   behaviour has inputs real DynamoDB rejects (a malformed expression,
   an out-of-range parameter, a key that doesn't match the schema),
   cover the rejection too, not only the accepted form. A target that is
   too lenient passes acceptance-only tests while still diverging from
   DynamoDB, so acceptance-only coverage of a feature with a validation
   boundary is incomplete. Put the error-code assertion in the
   operation's own tier (or `tests/tier3/validation-ordering/`) and the
   exact message, where it's stable, in `tests/tier3/error-messages/`.
5. **Required if you added, moved or renamed a test: regenerate both
   manifests in the same commit.** `node scripts/suite-manifest.mjs`
   rewrites `registry/suite-manifest.json`, which is what every published
   figure divides by. CI fails the PR if it is stale, because a board
   grading against a suite it no longer has is worse than a red build.
   `npm run results:tags` rewrites `results/tag-manifest.json`, which
   groups the published results by capability. Its guard runs in
   `npm run test:tooling` and reports a stale manifest as a failing test,
   so it reads as a broken test rather than a missing step. Run both.

   Renaming a test is the expensive one. Every committed results file
   names its tests in full, so a rename leaves them measuring a
   population the suite no longer has, and the publishing gate refuses
   the manifest until each target is re-run. Land a rename with a
   results refresh, not with a coverage change.

Regenerating the published results table across all tracked targets
(DynamoDB, Dynoxide, Dynoxide (wasm), DynamoDB Local, Dynalite,
LocalStack, ExtendDB, Floci, Ministack, Kumo) is a maintainer task, not a
contributor requirement. Do not hold a PR for it.

If a test is flaky against real DynamoDB (for example GSI
propagation), use the existing wait/retry helpers rather than adding
sleeps.

A new test file must call `declareTables(...)` at module scope for
every shared table def it uses. Shared tables are created on demand,
so an undeclared table is simply never created for a run narrow enough
that no other file asked for it, and the test fails with
`ResourceNotFoundException` rather than a real answer. `npm run
test:tooling` checks the declaration against what the file references.
Reach for `compositeIndexedTableDef` when a test needs a secondary
index; `compositeTableDef` has none, and any file using the indexed one
carries both the `gsi` and `lsi` tags.

## Citing a suite finding elsewhere

When a finding from this suite is referenced in another project's
issue tracker, say an engine's own bug report about a divergence
the suite caught, cite it as an independent source by its public
identity:

> the Parity Suite ([paritysuite.org](https://paritysuite.org)), an
> independent DynamoDB conformance suite that scores multiple
> engines against live AWS DynamoDB

Link to the specific public test, pinned to a commit SHA or tag
(`.../blob/<sha>/...`, never `.../blob/main/...`, which rots when
the lines move), not a bare in-repo path. A pinned test link is the
durable evidence for a specific finding; the target's row on
paritysuite.org is a live score that moves with every run, so cite
it only for a general "how this engine scores" claim, never as
evidence for a fixed bug. Don't frame the suite as the engine's own
test harness: it is a separate party that scores that engine
alongside others, and the reference only carries weight if it reads
that way. The fuller convention, with a copyable block, is "Citing
a finding" in the README.

## Releases and the measured ref

The published board measures the most recent release tag, not `main`. A merge
to `main` still runs the full suite against real AWS, which is what validates
the tests as they land, but it does not publish. Only a release moves the
figures, so a dated changelog entry always sits behind a move in the
denominator.

`scripts/resolve-measured-ref.mjs` is where that decision is made, once, in
`conformance.yml`'s `changes` job. Every downstream job checks out what it
resolved rather than re-deriving the rule:

| event | measures |
|---|---|
| an explicit `ref` input | that ref, verbatim, which is the re-measure escape hatch |
| `schedule` or `workflow_dispatch` | the highest release tag |
| anything else | the sha that triggered it, which is never publishable |

"Highest" is by version number, not by when the tag object was written and
not by commit topology: `v2.0.0` and `v2.1.0` were backfilled after `v3.0.0`
already existed, so creation order is already unsound here.

Two jobs deliberately stay on `main`: the cross-region capture and the region
health record, because both commit back and neither can push from a detached
tag. That is also why nothing about the measurement is read from the
publisher's own tree. `summarise.mjs` takes the identity and the suite
definition as input and refuses to invent either.

The three grading inputs split by what they are:

| input | read at | why |
|---|---|---|
| `registry/suite-manifest.json` | the measured ref | it is the denominator, and it is suite definition |
| `registry/splits.json` | the measured ref | per-region expectations are suite definition |
| `registry/regions.json` | `main` | region health is live operational state, not suite definition |

A rebuild is the exception worth knowing. When the sweep records new region
health it rebuilds the board without re-measuring anything, so it carries the
committed board's `suite` block forward unchanged and reads its manifest and
splits at that block's commit. Health is the only input a rebuild is allowed
to move. Restamping the timestamp would have the board claim a measurement it
never performed.

`release.yml` cuts a version and leaves a draft release; `publish-release.yml`
flips that draft when a board carrying its version is committed. The flip is
keyed to the board changing rather than to a named upstream workflow, because
`results-table.yml` and the sweep both write `results/` and either can be the
one that lands a given board. `scripts/release.mjs` holds the mechanics for
both, so the changelog rewrite is pinned by unit tests rather than discovered
from a bad release.

## The site workspace (`site/`)

[paritysuite.org](https://paritysuite.org) is built from `site/`, an npm
workspace holding an Eleventy v3 site with WebC templates and Tailwind v4 via
the standalone CLI. No client-side framework; charts are inline SVG generated
at build time. It deploys as a static site to S3 + CloudFront.

The suite and the site live in one repo so the scoring exists once. They were
separate repos with hand-copied scoring maps until the copies drifted, and for
a day the board scored a target it could not name.

Commands, all from the repo root:

```bash
npm run site:dev          # Tailwind watch + eleventy --serve, http://localhost:8080
npm run site:build        # writes site/_site/
npm run site:test         # the site's unit tests
npm run site:check-build  # build with the network stubbed, then assert on the HTML
npm run site:snapshot     # re-fetch upstream history, rewrite the committed fallback
```

`site/` depends on the root package as `dynamodb-conformance` (a `file:..`
dependency), so it imports suite modules by package specifier rather than by
relative path.

### The rule everything else follows

Every figure on the site is derived from `results/*.json` at build time. None
of them are hand-authored. Duplicating a number anywhere is how the site and
the README drift apart, so there is a single data seam and everything renders
from it. Typing a percentage into a template is the signal something is wrong.

### How the data reaches the templates

Data flows one way: `site/src/_data/*.js` (async 11ty global data, at build
time) into `site/lib/*.mjs` (pure, testable functions) into WebC templates. The
`lib/` modules know nothing about Eleventy, which is what makes them testable
outside it.

Four data files fetch from the published repo at build time, each with a
committed fallback so builds stay green offline and without a token:

| Data file | Source | Fallback |
| --- | --- | --- |
| `conformance.js` | commits touching `results/`, plus each changed `results/<slug>.json` | `data/conformance-history.json`, and `data/tag-manifest.json` for the capability tags |
| `summary.js` | commits touching `results/summary.json` (`lib/summary-fetch.mjs`) | `data/summary-history.json` |
| `changelog.js` | `CHANGELOG.md` | `data/changelog-fallback.md` |
| `splits.js` | `registry/splits.json` | `data/splits-fallback.json` |

These still go over the network even though the files now sit in the same tree.
Collapsing that into local `git log` reads is deliberate follow-up work, not an
oversight: the scorer is pure functions over raw Vitest JSON, so sharing it
never depended on where the JSON came from.

`summary.js` carries the per-region model. The conformance model reads it to
source each target's best-match headline region, so the two are fetched once
and joined rather than fetched twice.

The conformance pipeline is the substantial one. `lib/fetch.mjs` lists the
commits that touched `results/`, works out which target files each one changed,
pulls those files at that ref from the raw CDN (which doesn't count against the
API limit), and scores each into a snapshot. `lib/history.mjs` assembles those
snapshots into the model the templates consume: runs, standings, movement,
per-target series. `scripts/snapshot.mjs` runs the same two modules to
regenerate the fallback, so the fallback is always the derived model rather
than raw API responses. It thins the per-failure `findings` records: kept for
the most recent measurement, dropped for the history. Keeping all of them takes
the file from ~1.3 MB to ~30 MB, because every run repeats each failing test's
name, tags and path. Four references point at the same standings objects
(`runs[].standings[]`, `latest.standings[]`, `perTarget[].current`,
`perTarget[].series[]`), so the strip has to handle each or the whole set leaks
back in. Only the two the site renders from are kept: `perTarget[].findings`
for the target page, and the newest `series[]` point for that target's newest
per-run page. A build that falls back therefore itemises the newest run's
failures and, for older runs, says the detail isn't retained for that snapshot.

### Four invariants worth knowing before you change anything

**Scoring has one definition, and it is the suite's.** `site/lib/scoring.mjs`
imports `DISPLAY`, `REPO`, `display`, `repoUrl` and `label` from
`scripts/summarise.mjs`, and `tierOf`, `passRate` and `scoreResults` from
`scripts/lib/score.mjs`. Adding a target to the suite's maps puts it on both
the README table and the site with no site-side edit, and `scoreEmulator`
tallies through the suite's classifier rather than reading
`assertionResults[].status` itself, so a test the suite counts one way cannot
be counted another way here. Do not reintroduce a local copy of either.

What remains site-side is the model the templates consume: `dynamodbRow`,
`sortRows` and `suiteSizeOf` assemble scored rows into runs, standings and
movement, which the suite has no equivalent of and no use for.

The headline figure is not derived here at all. `enrichSnapshot` in
`lib/history.mjs` overlays each run's total with the best-matching region rate
from the suite's published `summary.json`, keeping the locally derived score
only as `portTotalValue`. That is what makes the board and the README agree by
construction. The guard that can still catch drift is the numeric check in
`scoring.test.mjs` that `portTotalValue` equals `summary.json`'s `eu-west-2`
rate for every target; keep it alive through any refactor.

**Runs are grouped by the results' `startTime`, never by commit.** A single
commit often refreshes only some targets, and one commit can carry targets
whose `startTime`s belong to different runs, so grouping by commit would invent
runs that never happened. Within a run date the latest `startTime` per target
wins, and a target that wasn't re-tested carries forward at its last measured
value.

**DynamoDB is never fetched.** Its row is synthesised as a definitional
flat-100% baseline per run in `lib/history.mjs`. A real `dynamodb.json` scored
as if it were an emulator would only mislead.

**A changelog entry's test-count badge is paired with a run, and the pairing
can be corrected by hand.** `entryRunBadges` in `lib/changelog.mjs` takes the
nearest run on or after each entry. A run can start before that day's commits
land, so that isn't always the run that measured the entry: 2026-07-13's prose
describes 954 beside a run that measured 873. No rule fixes this from the data.
An entry that grew the suite after its run and one that added a target and no
tests (2026-05-23) are identical in dates and sizes, and only the prose tells
them apart. So the correction is an explicit `MEASURED_BY` entry naming the
right run. It names a run, never a figure, so the count still comes from that
run's results and the derived-figures rule holds. Keep it to genuine
corrections the suite's own prose evidences; it isn't a place to author
numbers. Entry headings are `## YYYY-MM-DD` with an optional release tag.
`## Unreleased` is the one other heading the parser knows: work writes its notes
there as it merges and the release gives the section its date, so it is held off
the page rather than rendered, and an empty one is the ordinary state between
releases. Anything else comes back as `skipped` and is reported rather than
dropped.

### Templates

Filters in `site/eleventy.config.js` that do real work (`chartGeometry`,
`targetOperations`, `featureSummary`, `targetCapabilities`, `regionGroups`,
`splitEvidence`, `regionLabel`, `isSelfMaintained`, `targetLinks`,
`targetRunHref`, `areaFailures`, `findingSource`, `formatNumber`) are one-line
wrappers delegating to `lib/`, which is what keeps that logic testable outside
11ty. Anything genuinely trivial (date labels, title formatting, cache-busting)
stays inline. The rest of the file is JSON-LD assembly.

A filter that needs to reshape data before delegating puts the adapter in
`lib/` too, not in the config: `targetCapabilities` renders one target's card
by handing the card renderer a model of one, and that adapter is
`renderTargetCapabilities` so it can be tested like everything else.

Three things look inconsistent with everything else and have reasons:

- WebC can't nest a `webc:for` over a property of an outer loop variable. The
  per-operation table and the capability views both need that shape, so
  `lib/matrix.mjs` and `lib/capabilities.mjs` export `render*` helpers
  returning HTML strings rather than components taking that nested loop.
- Paginated pages (`src/targets/`, `src/runs/`) compute permalink, meta,
  breadcrumbs and `lastmod` in `*.11tydata.js` under `eleventyComputed`, not in
  WebC front matter. `webc:setup` runs once at parse time, so per-page
  resolution has to happen in computed data. `src/changelog.11tydata.js` uses
  the same escape hatch for a different reason: it joins two global data sets,
  which `webc:setup` can't do per page.
- A component takes props with `:prop`, which also renders them as attributes
  on the root element. That only shows when the root carries
  `webc:root="override"`, which merges the host's attributes onto it, as
  `region-health.webc` does deliberately for a margin class. A component that
  doesn't need that (`target-links.webc`) uses a plain root, or the props leak
  into the markup.

`addUrlTransform` strips trailing slashes to pair with a CloudFront URL-rewrite
function. `lastmod` is a plain field rather than `date` because 11ty resolves
`date` too early for `eleventyComputed`.

### Deploy

`.github/workflows/deploy.yml` builds and syncs to S3 + CloudFront over OIDC on
a push to main touching `site/`, `results/`, `registry/` or `CHANGELOG.md`, on
a daily cron, or on demand. `src/history-meta.njk` emits `/history-meta.json`
carrying a content hash of the derived history (`lib/digest.mjs`); the
scheduled run compares it against the deployed copy and skips the sync and
invalidation entirely when the data hasn't moved.

Two things there will catch you out. The workflow syncs assets and HTML
separately, and the two prefix lists are complements, so a new asset directory
has to be added to both or the second pass reclaims it. And the build sets
`FAIL_ON_FALLBACK=1` because the syncs delete what they don't find: a build
that quietly fell back to the committed snapshot would publish fewer pages and
take the rest down with it.

The hosting itself is defined outside this repo.

### Presentation constraints

Score state must never be carried by colour alone. The delta text and an
`aria-label` always carry the meaning too (WCAG 1.4.1). Coloured text uses the
`-700` shades in light mode, because the `-600`s fall below 4.5:1 on the
near-white cards, and the `-400`s in dark. Bar fills and movement colours are
plain classes in `src/css/main.css` rather than Tailwind utilities, so
dynamically composed class names always resolve. Figures render with `.tnum`
(tabular numerals) so score columns align.

Every target is presented on the same terms. Copy that names one target should
read the same way if a different one were top of the table, and any target
whose author also maintains part of this project is marked as such at its own
score (`SELF_MAINTAINED` in `site/lib/scoring.mjs`) rather than in prose
elsewhere.

## Commit style

Short subject, lower-case, imperative where possible. A Conventional
Commits-style prefix (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`,
`ci:`) is preferred when one fits but is not a gate. Bodies are
welcome for anything non-obvious.

## Where to discuss

- GitHub Issues:
  <https://github.com/paritysuite/dynamodb-conformance/issues>

Discussions are not currently enabled.
