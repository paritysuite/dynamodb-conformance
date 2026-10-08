// Shared tier scoring for the results table and the per-target badges, so the
// badge percentage can never drift from the published table.
//
// Scoring consumes the classifier's verdicts (scripts/lib/classify.mjs), never
// raw Vitest statuses: a raw status cannot tell a failed observation from a
// real failure, and only the classifier can. The percentage is correctness
// over implemented, observed operations: passed / (passed + failed). Two kinds
// of test are excluded from the denominator, for two different reasons that
// must not be blurred:
//
// - skips: honest scope. The feature probe declined to run the operation
//   because the target does not implement it.
// - indeterminates: failed observations. A timeout, an exhausted throttle or a
//   transport fault means nobody knows what the answer was, so it can count
//   neither for nor against a target.

import { classifyResults } from './classify.mjs'
import { loadRegistry, sameObservation, splitFor, verdictAgainstPin } from './registry.mjs'
import { loadRegionHealth, observedRegions } from './observed.mjs'

// The conformance ground truth. Real DynamoDB defines correctness, so its row
// is pinned to 100% rather than scored from a results file. Under per-region
// ground truth the pin is earned rather than assumed: each real region scores
// 100% against its own recorded behaviour by construction, so the max over any
// observed set is 100% too. Shared by the results table and the badges so
// the two can't disagree on which slug it is.
export const GROUND_TRUTH_SLUG = 'dynamodb'

// Result-file slugs that are never a published target. `local` is the default
// output of an ad-hoc local run (DYNAMODB_ENDPOINT set with no
// CONFORMANCE_TARGET - see vitest.config.ts), a scratch file that must not be
// scored, badged, or listed in the results table. `summary` is the versioned
// per-region artefact this scoring layer emits (results/summary.json), a
// product of the pipeline rather than a target's run output. `tag-manifest` is
// the capability index (scripts/tag-manifest.mjs), a document with no
// testResults at all - it was excluded only by the extension filters callers
// happened to write above this check, which is why testIdentities threw on it.
// Kept here so the table and the badges agree on what to skip, the same way
// they share GROUND_TRUTH_SLUG.
export const RESERVED_SLUGS = new Set(['local', 'summary', 'tag-manifest'])

// The lanes real AWS is observed in, beyond the gating run. Most of the suite
// runs in one job, but S3 export/import, Kinesis and the UpdateTable GSI
// backfills are far too slow for its credential window and run in jobs of
// their own (package.json's test:integrations and test:gsi). Their documents
// land beside the ground-truth results file as `<ground truth>.<lane>.json`,
// where scripts/summarise.mjs folds them into it.
export const GROUND_TRUTH_LANES = ['integrations', 'gsi']

// Whether a result-file slug is one of those lane documents. They are evidence
// behind the ground-truth row, not runs of their own, so nothing may score,
// badge or seat them as a target.
export function isGroundTruthLane(slug) {
  return GROUND_TRUTH_LANES.some((lane) => slug === `${GROUND_TRUTH_SLUG}.${lane}`)
}

// Whether a result-file slug is a published conformance target. False for the
// reserved scratch slugs above and for the ground-truth lanes.
export function isPublishedTarget(slug) {
  return !RESERVED_SLUGS.has(slug) && !isGroundTruthLane(slug)
}

/**
 * The target slug a results file belongs to, or null if it is not one.
 *
 * `results/` holds six kinds of file - a target's run, the ground-truth lane
 * documents, indeterminate sidecars, badge endpoints, version stamps, and
 * pipeline artefacts that are not runs at all - and every caller that walked
 * the directory rebuilt a subset of this rule from memory. Three defects came
 * from the gaps: a lane document scored as an emulator holding a fraction of
 * the suite, testIdentities thrown on the tag manifest, and the manifest
 * passing isPublishedTarget because it was filtered by extension somewhere
 * else instead.
 *
 * Returns the slug rather than a boolean so a caller never re-derives it with
 * basename and disagrees about where the name ends. `dynamodb.gsi.json` is a
 * lane, not a target called `dynamodb.gsi`.
 *
 * Accepts a path or a bare file name.
 */
export function targetResultSlug(path) {
  const name = String(path).split('/').pop() ?? ''
  if (!name.endsWith('.json')) return null
  if (name.endsWith('.badge.json') || name.endsWith('.indeterminate.json')) return null
  const slug = name.slice(0, -'.json'.length)
  return isPublishedTarget(slug) ? slug : null
}

/** Whether a results file is a target's own run document. */
export function isTargetResultFile(path) {
  return targetResultSlug(path) !== null
}

export function tierOf(filePath) {
  if (filePath.includes('/tier1/')) return 'tier1'
  if (filePath.includes('/tier2/')) return 'tier2'
  if (filePath.includes('/tier3/')) return 'tier3'
  return 'other'
}

// Score classified verdicts into per-tier and overall counts. p/f/s/i are
// pass, fail, skip and indeterminate; `count` is every classified test, so a
// full-suite run reports its true size whatever mix of verdicts it produced.
export function scoreVerdicts(verdicts) {
  const summary = {
    tier1: { p: 0, f: 0, s: 0, i: 0 },
    tier2: { p: 0, f: 0, s: 0, i: 0 },
    tier3: { p: 0, f: 0, s: 0, i: 0 },
  }
  const bucket = { pass: 'p', fail: 'f', skip: 's', indeterminate: 'i' }
  for (const v of verdicts) {
    const tier = summary[tierOf(v.file)]
    if (!tier) continue
    tier[bucket[v.verdict]]++
  }

  const total = (k) => summary.tier1[k] + summary.tier2[k] + summary.tier3[k]
  const passed = total('p')
  const failed = total('f')
  const skipped = total('s')
  const indeterminate = total('i')
  return {
    summary,
    passed,
    failed,
    skipped,
    indeterminate,
    count: passed + failed + skipped + indeterminate,
  }
}

// Score a Vitest JSON result, plus its indeterminate sidecar when the run
// wrote one, by classifying it first. Returns null only for a file that is not
// a target's Vitest output at all (no testResults array, e.g.
// results/tag-manifest.json), so callers can skip it. A real result file with
// no scored tests returns zeroed counts rather than null, so a genuinely empty
// run still renders as "-" instead of vanishing.
export function scoreResults(raw, sidecar = null) {
  if (!Array.isArray(raw?.testResults)) return null
  return scoreVerdicts(classifyResults(raw, sidecar))
}

// Correctness over implemented operations: passed / (passed + failed), as a
// percentage. Null when nothing ran, so callers render "-".
export function passRate(passed, failed) {
  return passed + failed === 0 ? null : (passed / (passed + failed)) * 100
}

// The two published axes over one set of counts, both against the whole
// suite so neither can hide behind the other. Divergence is null when the
// target implemented nothing: diverging nowhere because you attempted
// nothing is the absence of a score, not a good one, and a zero would rank
// an empty target above every real engine. One definition, shared by the
// results table, the badges and the site, so the axes behind a published
// grade cannot drift between surfaces.
export function axesOf({ passed, failed, count, indeterminate = 0 }) {
  const implemented = passed + failed
  // A run that did not observe the whole suite is not scored at all.
  //
  // An indeterminate is a failed observation: nobody knows what the target
  // would have answered. Holding it against coverage let an infrastructure
  // timeout move a published letter, and taking it out of the denominator was
  // worse - divergence then fell further than coverage, so converting a fail
  // into an indeterminate bought a better letter than withdrawing it would,
  // and a target can induce one by answering 503 (see isTransport in
  // src/indeterminate.ts). Both readings grade a partial run.
  //
  // So neither figure is published for one. The row stays in the run and prints
  // "-" for both figures; it is not replaced by the previous measurement and it
  // is not marked carried, because the target did report - it just reported
  // something nobody can score. Carrying the last clean measurement forward is
  // what happens to the baseline's unobserved lanes, a different thing in a
  // nearby place.
  if (indeterminate > 0) return { divergence: null, coverage: null }
  return {
    divergence: count === 0 || implemented === 0 ? null : (failed / count) * 100,
    coverage: count === 0 ? null : (implemented / count) * 100,
  }
}

// ── Per-region scoring ───────────────────────────────────────────────────────
//
// A target has no region; scoring it "against us-east-1" means asserting
// us-east-1's recorded expectations, which come from the split registry. On
// every test with no registry row the expectation is region-invariant and the
// verdict stands as classified, so the common path is a no-op and all
// per-region scores of a split-free run are identical.

/**
 * Re-evaluate classified verdicts against one region's expectations.
 *
 * For a test with a registry row naming this region, the region's recorded
 * answer replaces the committed assertion as the expectation:
 *
 * - a pass matched the committed assertion, which encodes the row's pinned
 *   answer - deliberately tolerant of wording variance - so it passes here
 *   exactly when this region records the pinned answer. Evidence never
 *   revokes a committed pass: the committed assertion is the suite's own
 *   definition of matching the pinned side, and holding a pass to the
 *   byte-exact recorded string as well would silently tighten every split
 *   test to a strictness the suite never asserts anywhere else. The one
 *   exception is a pass whose observation is another region's recorded
 *   answer, which an assertion accepts only where the pinned region gives
 *   both; it is read as the fail it would have been against the pinned
 *   answer alone (verdictAgainstPin) and scored on that evidence below;
 * - a fail carrying `observed` (the target's recorded answer for the split
 *   behaviour) is redeemed exactly when the observation matches this
 *   region's recorded answer, byte-exactly - a region match is only ever
 *   earned on evidence;
 * - a fail without an observation is evidence of nothing beyond "not the
 *   pinned answer". It stays a fail: the conservative reading can only
 *   under-score a target, never launder a non-conformance into a pass.
 *
 * Skips and indeterminates pass through untouched - an absence is the same
 * absence in every region - as does any test in a region the row does not
 * name, where the region-invariant expectation still applies.
 */
export function verdictsForRegion(verdicts, registry, region) {
  return verdicts.map((v) => {
    if (v.verdict !== 'pass' && v.verdict !== 'fail') return v
    const row = splitFor(registry, v)
    const expected = row?.regions?.[region]
    if (!expected) return v
    if (verdictAgainstPin(row, v.verdict, v.observed) === 'pass') {
      return {
        ...v,
        verdict: sameObservation(expected, row.regions[row.pinned]) ? 'pass' : 'fail',
      }
    }
    if (v.observed !== undefined) {
      return { ...v, verdict: sameObservation(v.observed, expected) ? 'pass' : 'fail' }
    }
    return v
  })
}

/** scoreVerdicts, with the verdicts re-evaluated against one region. */
export function scoreAgainstRegion(verdicts, registry, region) {
  return scoreVerdicts(verdictsForRegion(verdicts, registry, region))
}

/**
 * Score a target against every region in the observed set, and take the
 * best of them as the headline. Removing a region from a max() can only lower
 * a score or leave it unchanged, so a target only ever fails a behaviour in
 * the headline when no observed region matches what it did.
 *
 * The observed set comes from scripts/lib/observed.mjs. An empty set is an
 * error: a score computed against nothing would be a silent 0% or 100%, and
 * neither is an answer.
 *
 * Returns { regions: { [region]: scored }, headline: { region, rate } }, with
 * ties preferring a region the registry characterises and then broken by
 * region name, so a re-run is byte-identical (scoring is deterministic and
 * offline by requirement).
 */
export function scoreAcrossRegions(verdicts, registry, observedRegions) {
  if (!Array.isArray(observedRegions) || observedRegions.length === 0) {
    throw new Error('cannot score against an empty observed region set')
  }

  const regions = {}
  for (const region of observedRegions) {
    regions[region] = scoreAgainstRegion(verdicts, registry, region)
  }

  // Regions named in at least one split row. An observed region absent from
  // every row is scored as if every expectation were region-invariant, so it
  // can tie the best characterised region without the suite knowing anything
  // region-specific about it. On a tie the headline must name a region whose
  // recorded answers actually did the work: a Region column answering
  // "conformant to what?" with a region the suite has never characterised is
  // worse than no column.
  const characterised = new Set(
    registry.splits.flatMap((row) => Object.keys(row.regions)),
  )
  let headline = null
  for (const region of [...observedRegions].sort()) {
    const rate = passRate(regions[region].passed, regions[region].failed)
    if (rate === null) continue
    if (
      headline === null ||
      rate > headline.rate ||
      (rate === headline.rate &&
        characterised.has(region) &&
        !characterised.has(headline.region))
    ) {
      headline = { region, rate }
    }
  }
  // A run where nothing scored in any region has no headline rate; the first
  // region (by name) keeps the shape stable for renderers.
  if (headline === null) headline = { region: [...observedRegions].sort()[0], rate: null }
  return { regions, headline }
}

// The historical single-region baseline. Before per-region scoring this was the
// sole ground truth; now it is just the region a reader already knows, so a
// headline cohort that includes it is named against it rather than an arbitrary
// alphabetical member.
export const PINNED_REGION = 'eu-west-2'

/**
 * Classify how a target's headline should read from its per-region rates, so
 * the Region column names the cohort a target actually matched rather than the
 * lone tie-break winner (which, being alphabetical, is almost always the same
 * region and tells a reader nothing). `entries` is `[{ region, rate }]` for
 * every observed region; `pinned` is the baseline.
 *
 *   - none          nothing scored                -> no label
 *   - all           every region ties at the top  -> "all regions"
 *   - pinned-plus   the baseline is in the top    -> "eu-west-2 + N regions"
 *   - beats-pinned  the top cohort excludes it    -> the region, or "N regions"
 *
 * Ties are decided on the rates as published (rounded), so this reads the same
 * numbers a viewer sees.
 *
 * The site imports this rather than keeping its own copy. Both existed, and the
 * comments on each said it mirrored the other, which is a duplicate with a note
 * attached: the board and the README have to label a headline identically or
 * one of them is wrong.
 */
export function cohortOf(entries, pinned = PINNED_REGION) {
  const rated = entries.filter((e) => e.rate != null)
  if (rated.length === 0) return { kind: 'none', regions: [], rate: null, others: 0, observed: 0 }

  const top = Math.max(...rated.map((e) => e.rate))
  const cohort = rated
    .filter((e) => e.rate === top)
    .map((e) => e.region)
    .sort()

  // Every observed region ties at the top: the target conforms equally
  // everywhere, so no region is worth singling out.
  if (cohort.length === rated.length) {
    return { kind: 'all', regions: cohort, rate: top, others: cohort.length - 1, observed: rated.length }
  }
  // The pinned region is among the best: anchor on it (the reader knows it as
  // the historical baseline) and count the rest of the cohort.
  if (cohort.includes(pinned)) {
    return { kind: 'pinned-plus', regions: cohort, rate: top, others: cohort.length - 1, pinned, observed: rated.length }
  }
  // The best cohort excludes the pinned region: the target genuinely matches a
  // real region the pin disagrees with. Name it and carry the pinned rate so a
  // display can show the gap.
  const pinnedEntry = rated.find((e) => e.region === pinned)
  return {
    kind: 'beats-pinned',
    regions: cohort,
    rate: top,
    others: cohort.length - 1,
    pinned,
    pinnedRate: pinnedEntry?.rate ?? null,
    observed: rated.length,
  }
}

/** Display text for a cohort label. */
export function regionLabel(label) {
  if (!label || label.kind === 'none') return '-'
  switch (label.kind) {
    case 'all':
      return 'all regions'
    case 'pinned-plus':
      return label.others === 0
        ? label.pinned
        : `${label.pinned} + ${label.others} region${label.others === 1 ? '' : 's'}`
    case 'beats-pinned':
      return label.regions.length === 1 ? label.regions[0] : `${label.regions.length} regions`
    default:
      return '-'
  }
}

/**
 * Score one target's raw Vitest JSON (plus its indeterminate sidecar, when the
 * run wrote one) across the observed region set. This is the single entry
 * point the results table, the badges and the summary artefact all share, so
 * the badge percentage, the table headline and results/summary.json can never
 * disagree - the same invariant scoreResults was written to protect, extended
 * to per-region scoring.
 *
 * Returns null only for a document that is not a target's Vitest output at all
 * (no testResults array), so directory-scanning callers can skip it.
 */
export function scoreTarget(raw, sidecar, { registry, observed }) {
  if (!Array.isArray(raw?.testResults)) return null
  return scoreAcrossRegions(classifyResults(raw, sidecar), registry, observed)
}

/**
 * The shared scoring inputs, loaded from their committed homes: the split
 * registry (per-region expectations) and the region-health record (which
 * regions a score may draw on). A thin fs loader over the pure logic above,
 * mirroring registry.mjs and observed.mjs, so every consumer - table, badges,
 * summary, tests - scores against the same committed state.
 */
export function loadScoringContext({
  registryPath = 'registry/splits.json',
  regionHealthPath = 'registry/regions.json',
} = {}) {
  const registry = loadRegistry(registryPath)
  const health = loadRegionHealth(regionHealthPath)
  return { registry, health, observed: observedRegions(health) }
}
