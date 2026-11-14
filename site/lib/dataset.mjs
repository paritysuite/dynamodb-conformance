// Neutral, machine-readable views of the conformance model.
//
// These shape the same build-time model the HTML renders from into JSON a third
// party (or an agent) can consume instead of scraping the pages. Every target,
// including the live-AWS baseline, gets the identical schema: the data exposes
// the numbers and lets the consumer rank, it never editorialises or privileges
// one target's row. Like everything else on the site these are derived from the
// suite's own results at build time, so they can't drift from what's on screen.

import { controlObservation } from "./summary.mjs";
import {
  A_PLUS,
  BASELINE_GRADE,
  CAPABILITIES,
  COVERAGE_DIVISOR,
  GRADE_BANDS,
  GRADING_CRITERIA_EFFECTIVE,
  GRADING_VERSION,
  GROUND_TRUTH_SLUG,
  asPct,
  axesOf,
  configurationOf,
  gradeOf,
  isNotScored,
  isSelfMaintained,
  isVariant,
  licenceOf,
  projectOf,
} from "./scoring.mjs";

// Where a target's badge lives. Served from the suite repo rather than the
// site, so this is the raw path and not a site URL.
const RAW_BASE = "https://raw.githubusercontent.com/paritysuite/dynamodb-conformance/main";
const BADGE_URL_TEMPLATE = `https://img.shields.io/endpoint?url=${RAW_BASE}/results/{slug}.badge.json`;
// Served from the suite repo for the same reason as the badges: it is the
// suite's artefact, and the site renders it rather than owning it.
const SPLITS_URL = `${RAW_BASE}/registry/splits.json`;

// The two published figures for any {passed, failed, total}-shaped tally, from
// the suite's own axesOf so the endpoints cannot compute either differently
// from the board. A tier or area names its denominator `total`; a region row
// names it `count`.
//
// This used to restate the formula inline, which lost the guard axesOf applies
// to a run carrying indeterminates: a partially observed run then published
// figures and a letter here while the suite itself withheld both.
const axesFor = (a) =>
  axesOf({
    passed: a.passed ?? 0,
    failed: a.failed ?? 0,
    count: a.total ?? a.count ?? 0,
    indeterminate: a.indeterminate ?? 0,
  });
const divergenceOf = (a) => axesFor(a).divergence;
const coverageOf = (a) => axesFor(a).coverage;

// 2 adds the per-region dimension (each target's headline region and, on the
// latest endpoint, its full per-region breakdown and the run's region health),
// and corrects the baseline's region from the old single pin to "all".
//
// 3 converts tier figures from correctness to divergence and coverage, the same
// two axes as the headline, and renames the whole-suite correctness percentage
// from `total` to `correctness`. Three changes in it are breaking: a tier's
// `pct` and `value` are gone; `total` now means only the raw test count it also
// meant before; and `movement.state` reports `improved`/`regressed` where it
// reported `up`/`down`, since a rise is now the bad direction. A consumer
// reading any of the three as before would have silently inverted.
//
// 4 adds the letter grade: a `grade` object on every target row and the
// grading criteria in the envelope's metrics, versioned separately from this
// schema (a criteria change regrades targets that changed nothing, so it
// carries its own version). It also adds `baseline.observation`, which says
// how much of the suite the baseline row is currently standing on and which
// real-AWS passes have reported - the pages disclose that, and without it
// here an agent could not tell a fully measured baseline from a pinned one.
// Additive - a schema 3 consumer keeps working.
//
// Also additive, so within 4: `indeterminate` on every row's `counts`, tier,
// area and capability, so the counts sum to `total` on a row that is not
// scored as on any other, the `unscored` and `scored` movement states, and
// the `unanswered` area and capability state.
export const DATA_SCHEMA_VERSION = 4;

// Tier metadata, surfaced so a consumer doesn't have to hard-code the names.
export const TIERS = [
  { key: "tier1", name: "Core", description: "The operations roughly 90% of DynamoDB users rely on: CRUD, queries, scans, batch operations, secondary indexes (GSI and LSI), UpdateTable." },
  { key: "tier2", name: "Complete", description: "Documented but less common features: transactions, PartiQL, TTL, streams, tags, vector search, the online index lifecycle, and the surfaces only real AWS implements (backups, S3 export and import, Kinesis, Contributor Insights, resource policies, account reads)." },
  { key: "tier3", name: "Strict", description: "Validation ordering, error behaviour, limits, and legacy API shapes." },
];

const groupByCapability = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c.group]));

// Correctness as published: withheld where the tally holds an unanswered test,
// in the shape every other withheld figure takes. It is the one figure axesOf
// does not guard, so a not-scored row published a pass rate over the tests
// that did get an answer beside a divergence and coverage of null.
const WITHHELD = { pct: "-", value: null };
const correctnessFor = (pct, value, unanswered) => (unanswered > 0 ? WITHHELD : { pct, value });

// Tier scores as a {tier1, tier2, tier3} map, one shape whether the source row
// carries a tier or not (a missing tier is null, never absent). Each tier
// carries the same two axes as the headline, so a tier figure and the figure
// above it move in the same direction.
function tierScores(tiers) {
  const out = {};
  for (const { key } of TIERS) {
    const t = tiers?.[key];
    out[key] = t
      ? {
          divergence: { pct: t.divergence, value: t.divergenceValue },
          coverage: { pct: t.coverage, value: t.coverageValue },
          correctness: correctnessFor(t.correctness, t.correctnessValue, t.indeterminate ?? 0),
          passed: t.passed,
          failed: t.failed,
          skipped: t.skipped,
          // So the four counts sum to the total, as they do on a region tier.
          indeterminate: t.indeterminate ?? 0,
          total: t.total,
        }
      : null;
  }
  return out;
}

// The headline region a row's total was earned in, compacted for every row
// (latest and historical). `kind` says how the headline relates to the pinned
// baseline region: "all" (ties everywhere), "pinned-plus" (eu-west-2 is in the
// best cohort), "beats-pinned" (the best cohort excludes eu-west-2, so the
// target matches a region eu-west-2 disagrees with) or "none" (the row is not
// scored, so it has no headline and an empty cohort). null before the
// per-region data begins. The full per-region breakdown is on the latest endpoint.
function regionSummary(row) {
  const label = row.regionLabel;
  if (!label) return null;
  // A cohort is the regions a scored headline matched. A not-scored row still
  // carries per-region pass rates to build one from, but no scored headline,
  // so it publishes the empty cohort cohortOf gives a row with nothing scored.
  // `observed` is the row's own count, as on a scored row; the model takes it
  // from the sweep for a run-level fault, which rates no region, and null
  // means that sweep did not say rather than that it observed none.
  if (isNotScored(row)) {
    return { kind: "none", headline: null, cohort: [], cohortSize: 0, observed: label.observed || null, pinned: label.pinned ?? "eu-west-2", beatsPinned: false, worst: null };
  }
  return {
    kind: label.kind,
    // The region this row's figures were measured against. Every figure on the
    // row comes from this one region, so a consumer can name the measurement
    // rather than inferring it from the cohort.
    headline: row.headlineRegion ?? null,
    cohort: label.regions ?? [],
    // How many observed regions the headline was measured against, out of how
    // many were observed at all. The kind alone doesn't say: "all" over six
    // regions and "all" over thirty-three are the same word.
    cohortSize: (label.regions ?? []).length,
    observed: label.observed ?? null,
    pinned: label.pinned ?? "eu-west-2",
    beatsPinned: label.kind === "beats-pinned",
    // The worst observed region's divergence - the figure behind the row's
    // "up to X% in the other N" clause, published so an agent can read what
    // a human sees on the card. Null when the target has no regional spread
    // (or the row predates the per-region overlay).
    worst:
      row.divergenceWorst == null
        ? null
        : { pct: asPct(row.divergenceWorst), value: row.divergenceWorst },
  };
}

// One standings row -> the neutral, identical-schema target object every
// endpoint shares. Divergence and coverage travel together by design, so a
// target that is right about a narrow surface cannot read as broad conformance.
function targetRow(row) {
  const baseline = row.slug === GROUND_TRUTH_SLUG;
  return {
    slug: row.slug,
    display: row.display,
    version: row.version,
    baseline,
    // Conflict-of-interest disclosure: maintained by the board's author. A
    // static fact, derived from the slug, so it can't go stale.
    maintainedByAuthor: isSelfMaintained(row.slug),
    carried: !!row.carried,
    reTested: !!row.reTested,
    // The run that actually measured this row - the "last measured" date a
    // carried row shows on the board. Equals the run's own date unless the
    // row was carried forward.
    runDate: row.runDate ?? null,
    // The two published axes, plus the legacy percentage under a name that
    // says what it is. It used to be `total`, which also names the raw test
    // count in `counts` below, so the same word meant a count in one place and
    // correctness over implemented operations in another.
    divergence: { pct: row.divergence, value: row.divergenceValue },
    coverage: { pct: row.coverage, value: row.coverageValue },
    // Withheld on a row that is not scored, like the two figures above it.
    correctness: isNotScored(row) && !baseline ? WITHHELD : { pct: row.total, value: row.totalValue },
    // The letter grade, derived here from the two values above so it cannot
    // disagree with them. The criteria are in the envelope's metrics.grade.
    // The baseline carries no letter: it is what a grade measures distance
    // from, and the pages, the results table and the badges all decline to
    // grade it, so the endpoints would be the one surface that did.
    grade: baseline ? BASELINE_GRADE : gradeOf(row.divergenceValue, row.coverageValue),
    // Which project this target belongs to, and which configuration it is.
    // Without it a consumer has to infer from the display name that
    // "Dynoxide (wasm)" is a build of "Dynoxide" rather than a rival.
    project: projectOf(row.slug),
    configuration: configurationOf(row.slug),
    isVariant: isVariant(row.slug),
    // Which row stands for the project in this run, which `isVariant` cannot
    // answer: when a project's reference build records no result, a build is
    // promoted to stand for it, and every row of that project then reads
    // `isVariant: true`. A consumer grouping by `project` and looking for the
    // one that is not a variant would find none, which is the same mistake the
    // board itself made before it read this flag.
    standsForProject: row.isParent ?? !isVariant(row.slug),
    // Whether the board starts this build's row closed: it reads the same
    // grade, divergence and coverage as the row standing for its project, and
    // both were measured in the same run. The row above, not the reference
    // build by name - on a run the reference build did not record, a promoted
    // build is what the comparison is made against.
    // Published because a consumer reading the endpoints and the board side by
    // side would otherwise find a build here that the board did not appear to
    // show, with nothing to explain it.
    collapsedIntoProject: row.collapsed === true,
    // `indeterminate` counts the tests that got no answer, so passed, failed,
    // skipped and indeterminate sum to total on every row. Without it a row
    // that is not scored published counts that fell short of its total.
    counts: { passed: row.passed, failed: row.failed, skipped: row.skipped, indeterminate: row.indeterminate ?? 0, implemented: row.implemented, total: row.count },
    tiers: tierScores(row.tiers),
    region: regionSummary(row),
    movement: row.movement
      ? {
          state: row.movement.state,
          delta: row.movement.delta,
          deltaLabel: row.movement.deltaLabel,
          label: row.movement.label,
          // Present only when the letter changed between this run and the
          // previous one the target was tested in; null otherwise.
          gradeChange: row.movement.grade ?? null,
        }
      : null,
  };
}

// A target's per-region breakdown for the latest endpoint: every observed
// region's rate, tier split and counts, with eu-west-2 flagged as the historical
// baseline and each region flagged for whether it's in the best-scoring cohort.
function regionTier(t) {
  return t
    ? {
        divergence: { pct: t.divergence, value: t.divergenceValue },
        coverage: { pct: t.coverage, value: t.coverageValue },
        correctness: correctnessFor(t.correctness, t.correctnessValue, t.indeterminate ?? 0),
        passed: t.passed,
        failed: t.failed,
        skipped: t.skipped,
        indeterminate: t.indeterminate,
        total: t.total,
      }
    : null;
}
function regionDetail(pt, row) {
  // No region is in the cohort of a row that has none (see regionSummary).
  const cohortless = isNotScored(row);
  return (pt.regions || []).map((r) => ({
    region: r.region,
    // The suite's pass rate in that region, withheld where the region holds a
    // test that got no answer, as the divergence and coverage beside it are.
    rate: (r.indeterminate ?? 0) > 0 ? null : r.rate,
    divergence: { pct: r.divergence, value: r.divergenceValue },
    // Coverage is invariant across a target's regions (only pass/fail flip), but
    // it is published per region anyway so a region row carries the same pair as
    // every other level of this schema rather than half of it.
    coverage: { pct: asPct(coverageOf(r)), value: coverageOf(r) },
    pinned: !!r.pinned,
    inCohort: !cohortless && !!r.inCohort,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    indeterminate: r.indeterminate,
    total: r.count,
    tiers: { tier1: regionTier(r.tiers?.tier1), tier2: regionTier(r.tiers?.tier2), tier3: regionTier(r.tiers?.tier3) },
  }));
}

// What each published metric is and which way is good. Carried in the envelope so
// a consumer holding one file can tell that lower divergence is better without
// fetching a prose page: the direction reversed in schema 3, and a consumer that
// re-derived its own ranking on the old assumption would have inverted silently
// with nothing in the payload to catch it.
const METRICS = {
  divergence: {
    formula: "failed / total",
    direction: "lower_is_better",
    description:
      "The share of the whole suite the target answers differently from real DynamoDB. Skips and indeterminates are in the denominator, so it cannot be lowered by shrinking what is attempted without the same fall showing in coverage.",
  },
  coverage: {
    formula: "(passed + failed) / total",
    direction: "higher_is_better",
    description:
      "Null when the run recorded any indeterminate: a failed observation means nobody knows what the target would have answered, so a partial run is not scored. The row is still in the run, reads `carried: false` because the target did report, and publishes null for both figures - so `carried` is not the field to test for whether a figure is real; the null is. A target that reported nothing at all is the separate, carried case. The share of the suite's tests the target implements at all. Weighted by test count, not by a count of features.",
  },
  correctness: {
    formula: "passed / (passed + failed)",
    direction: "higher_is_better",
    legacy: true,
    description:
      "The pass rate over implemented operations, which the board led with before schema 3. Retained for consumers that already read it; its denominator shrinks as a target attempts less. Null, like divergence and coverage, on a row that is not scored and on a tier holding a test that got no answer.",
  },
  grade: {
    direction: "A+ is best, F is worst",
    gradingVersion: GRADING_VERSION,
    description:
      "A reading of the divergence and coverage pair: divergence sets the letter, and one divisor's share of whatever a target leaves unimplemented is added to it before the bands are read, so coverage can only lower a letter. Recompute it from the two values and the criteria below; a criteria change bumps gradingVersion. The letter is weaker than the figures under scope withdrawal - the effective figure falls by (1 - 1/coverageDivisor) of whatever is withdrawn - so rank on divergence and coverage if that matters. Bands read both values rounded to one decimal place; the A+ gate reads them raw. A null on either value means the grade is null ('not scored'): check for it before applying the bands, or a null divergence will coerce and mis-grade.",
    // The criteria themselves, so a consumer can regrade without a prose page:
    // the letter for an effective divergence below each band's bound, the A+
    // gate, and the divisor coverage is weighted by. A divisor rather than a
    // decimal because 0.333... is not representable, and a rounded one lands
    // on the other side of a band boundary from the division.
    bands: GRADE_BANDS,
    // Both halves, because both are required: A+ means nothing failed and
    // nothing was declined. Read exactly, not at the published precision.
    aPlus: { divergence: A_PLUS.divergence, coverage: A_PLUS.coverage, exact: true },
    coverageDivisor: COVERAGE_DIVISOR,
    // The day these criteria took effect. Published because it is a predicate
    // as well as a caption: the feed reads it to decide which runs may carry a
    // letter, and without it a consumer cannot reproduce that cutoff.
    effective: GRADING_CRITERIA_EFFECTIVE,
  },
};

// Self-describing header shared by every endpoint: schema version, provenance,
// licence and the baseline's identity, so any single file stands on its own.
function envelope(conformance, site, summary = null) {
  // What the baseline row is standing on. It is synthesised at zero divergence
  // across the whole suite, which is only honest while every real-AWS pass has
  // reported; when one has not, the row is pinned rather than derived and the
  // shortfall is tests nobody has re-observed yet. The homepage and
  // /ground-truth both say so, and this is the same fact for a reader who is
  // not a person.
  const obs = controlObservation(summary?.latest?.groundTruth);
  // What the board was measured from. A reader following the endpoints rather
  // than the page has no other way to tell a released board from a validation
  // one, and `kind` is the field that says which - the page says "(unreleased)"
  // in prose, and an agent cannot read prose off a table it was told not to
  // scrape.
  const measured = summary?.latest?.suite ?? null;
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    ...(measured ? { suite: measured } : {}),
    metrics: METRICS,
    source: site.url,
    repository: site.sourceRepo,
    license: site.dataLicense,
    licenseName: site.dataLicenseName,
    attribution: site.dataAttribution,
    ...(conformance.generatedAt ? { generatedAt: conformance.generatedAt } : {}),
    baseline: {
      slug: GROUND_TRUTH_SLUG,
      region: "all",
      description: "Live AWS DynamoDB. The ground truth: it agrees with itself by definition, so it diverges nowhere in every region, and it is what every other target is measured against.",
      ...(obs
        ? {
            observation: {
              suiteSize: obs.suite,
              testsObserved: obs.observed,
              unobserved: obs.shortfall,
              // One capture date per pass: three passes under a single date
              // would read as one measurement.
              lanes: obs.dated,
              missingLanes: obs.missingLanes,
              description:
                "Real AWS is measured in three passes, split for runtime. `lanes` is what has reported and when; `missingLanes` names any that have not, and `unobserved` counts the tests still carried on the last clean measurement rather than re-observed this run.",
            },
          }
        : {}),
    },
  };
}

// Discovery manifest: a neutral map of the data surface, the tier and capability
// vocabularies, and where the documentation lives.
export function buildIndex(conformance, site, summary = null) {
  const { latest, runs = [] } = conformance;
  return {
    ...envelope(conformance, site, summary),
    name: "DynamoDB emulator conformance results",
    description:
      "Divergence and coverage for DynamoDB-compatible emulators, overall and per tier, measured against live AWS DynamoDB and recorded run over run. Divergence is failed / total and coverage is implemented / total, reported apart and never summed. Identical schema for every target, including the live-AWS baseline. Use these endpoints instead of scraping the pages.",
    documentation: site.url + "/for-agents",
    latestRun: latest?.id ?? null,
    runCount: runs.length,
    suiteSize: latest?.suiteSize ?? null,
    tiers: TIERS,
    capabilities: CAPABILITIES.map((c) => ({ key: c.key, label: c.label, group: c.group })),
    // What the version number entitles a consumer to, written from their side
    // rather than as a list of things this project promises not to do. The
    // maintainer's rule follows from it; the consumer's rule is the one that
    // tells them whether they have to re-verify.
    schema: {
      version: DATA_SCHEMA_VERSION,
      description:
        "A field you already read will not change type or meaning while `schemaVersion` stays put, so a consumer on this version can keep reading what it reads. New fields may appear at any version: treat one you do not recognise as new rather than as an error. A field holding one of a set of values, such as `movement.state`, can gain values the same way, so treat an unrecognised value as new too. It is removals, renames and changes of meaning that bump the version.",
      suite:
        "A third axis, and the one that says what these figures were measured from. The `suite` block names the ref, its commit, the suite version at that ref, the region measured against, and when. `kind` is the field to branch on: `tag` means a released suite with a dated changelog entry behind it, anything else means a board measured from an unreleased commit. The denominator every figure divides by moves when a release moves it, not when the default branch does, so two boards carrying the same `suite.version` are comparable and two carrying different ones are not. Region health is the exception: it is read live rather than at the measured ref, so a board's regional cohorts can be recomputed after its measurement without the measurement changing.",
      gradingVersion:
        "A separate axis, and the exception that matters. The grading criteria carry their own version (`metrics.grade.version`), and a change to the bands changes what a letter means without `schemaVersion` moving - the shape of the field is unaffected, so a schema bump would say nothing to a consumer parsing it. Anything storing or comparing letters over time should watch both numbers; anything reading only divergence and coverage can ignore the second.",
    },
    // A consumer reading the endpoints beside the board would otherwise find
    // builds here that the board does not appear to show, and nothing to say why.
    projects: {
      description:
        "A project can ship more than one build of the same engine: a storage backend swapped underneath it, or the query layer compiled for somewhere else to run. Every build is its own target here, with its own figures, and `project` groups them while `configuration` names what distinguishes each one. `isVariant` says a target is a build of the project rather than its reference build, and `standsForProject` says which row the board treats as the project's own - normally the reference build, but a build is promoted to stand for the project on any run the reference build did not record.",
      collapsedIntoProject:
        "True when the board starts this build's row closed. That takes three things: the build reads the same grade, divergence and coverage as the row standing for its project - the one `standsForProject` names, normally the reference build but a promoted build on a run the reference build did not record; both were measured in this run, on either side, since a carried row's figures are frozen at the run that measured it; and neither is a row the suite declined to score, because two rows publishing null figures are not agreement. It is one answer per project rather than per build - the disclosure holds every build of a project and opens as a whole - so a project whose builds disagree reads false on all of them. Every build has a row and its own figures either way; this says only whether a reader sees it without opening the disclosure. Re-derived every run.",
    },
    // Not to be confused with the envelope's `license`, which is the data's.
    targetLicence: {
      description:
        "Each target on the latest endpoint carries `licence`: the licence the target itself is offered under. `name` is what the pages show, `url` links to its text or the vendor's terms, and `spdx` is present only when an SPDX identifier or expression exists, in which case it equals `name`. Read from the project's own licence file, or from what the suite runs where that is licensed differently from the source, and named without being classified. Builds of one project carry the project's licence. On the latest endpoint only, because it is a current fact rather than a measurement.",
    },
    regions: {
      pinned: "eu-west-2",
      description:
        "Each target is scored against every observed region, and its headline is its best-matching region. A target's `region` field says how that headline relates to the pinned region (all, pinned-plus or beats-pinned, or none for a target that is not scored, which has no headline and an empty cohort) and lists the cohort it was measured against; the latest endpoint carries every region's divergence and tier split per target, plus the run's region health.",
      health: [
        { key: "observed", description: "Completed this sweep and counts towards scores." },
        { key: "unresolved", description: "Missed this sweep but still trusted." },
        { key: "dropped", description: "Missed twice; out of scoring until it returns." },
      ],
    },
    endpoints: [
      { name: "Latest run", format: "application/json", url: site.url + "/data/latest.json", description: "Current standings: per target, divergence and coverage overall and per tier, capabilities, operation areas, and the full per-region breakdown." },
      { name: "All runs", format: "application/json", url: site.url + "/data/runs.json", description: "Full history: every run's per-target divergence and coverage, overall and per tier, plus movement and headline region." },
      { name: "Runs feed", format: "application/atom+xml", url: site.url + "/feed.xml", description: "Atom feed, one entry per run. Runs measured before the grading criteria took effect carry no letter." },
      // The badge and corpus endpoints are documented on the agent guide, so
      // leaving them out made the manifest disagree with the page it points at.
      { name: "Target badge", format: "application/json", url: BADGE_URL_TEMPLATE, description: "Per-target shields.io endpoint badge carrying the letter grade under a `parity` label, `baseline` for live AWS, or `not scored` for a target whose latest run is not scored. Substitute the target's slug; the path is the contract, and shields' own `schemaVersion` says nothing about this project's." },
      { name: "Corpus", format: "text/plain", url: site.url + "/llms.txt", description: "The site as plain text for language models, with the full corpus at /llms-full.txt." },
      // The registry the A+ premise is checked against. /ground-truth renders
      // it as cards, and the methodology's grading section leans on it, but it
      // was reachable only by knowing the raw URL - so a consumer told to
      // recompute a grade could not see the evidence behind the one guard that
      // qualifies the top of the scale.
      { name: "Split registry", format: "application/json", url: SPLITS_URL, description: "Behaviours where real AWS regions genuinely disagree, with each region's recorded answer and the pinned one. A target passes such a test by matching any observed region, and a zero-divergence row may only fail tests recorded here." },
    ],
  };
}

// The latest run in full: per target, divergence and coverage per tier, plus the per-capability
// and per-operation-area state the matrix and capability grid are built from.
export function buildLatest(conformance, site, summary = null) {
  const { latest, perTarget = {} } = conformance;
  if (!latest) return { ...envelope(conformance, site, summary), run: null, tiers: TIERS, regionHealth: null, targets: [] };
  return {
    ...envelope(conformance, site, summary),
    run: { id: latest.id, date: latest.date, suiteSize: latest.suiteSize, emulatorCount: latest.emulatorCount },
    tiers: TIERS,
    // Which regions scored this run: observed count towards scores, unresolved
    // missed this sweep but are still trusted, dropped are out of scoring. null
    // before the per-region data begins.
    regionHealth: conformance.regionHealth ?? null,
    targets: latest.standings.map((row) => {
      const pt = perTarget[row.slug] || {};
      return {
        ...targetRow(row),
        // The licence the target is offered under today, as the pages show it:
        // `name` as the project gives it, `spdx` only where an SPDX identifier
        // exists, `url` to the text. On this endpoint only, because it is a
        // current fact rather than a measurement: a historical row in the runs
        // endpoint would carry today's licence against a version it may not
        // have applied to.
        licence: licenceOf(row.slug),
        capabilities: (pt.capabilities || []).map((c) => ({
          key: c.key, label: c.label, group: groupByCapability[c.key] ?? null, state: c.state,
          passed: c.passed, failed: c.failed, skipped: c.skipped, indeterminate: c.indeterminate ?? 0, total: c.total,
        })),
        // Per-operation areas carry the computed pair too. Every other level of
        // the schema pre-computes it, so leaving areas as raw counts alone made
        // a consumer reimplement the one formula the schema otherwise gives them.
        areas: (pt.areas || []).map((a) => ({
          key: a.key, tier: a.tier, group: a.group, state: a.state,
          divergence: { pct: asPct(divergenceOf(a)), value: divergenceOf(a) },
          coverage: { pct: asPct(coverageOf(a)), value: coverageOf(a) },
          passed: a.passed, failed: a.failed, skipped: a.skipped, indeterminate: a.indeterminate ?? 0, total: a.total,
        })),
        regions: regionDetail(pt, row),
      };
    }),
  };
}

// The full history: every run's standings, newest first. Tier divergence, coverage
// and movement per target; the per-capability and per-area detail lives on the
// latest endpoint, since the model only carries it for the latest snapshot.
export function buildRuns(conformance, site, summary = null) {
  const { runs = [], latest } = conformance;
  return {
    ...envelope(conformance, site, summary),
    tiers: TIERS,
    latestRun: latest?.id ?? null,
    runs: runs.map((r) => ({
      id: r.id,
      date: r.date,
      sha: r.sha,
      suiteSize: r.suiteSize,
      emulatorCount: r.emulatorCount,
      // Whether this run was measured under the published criteria. Every
      // target below carries a letter regardless, computed under the criteria
      // in force now - the feed instead withholds it, because a feed entry is
      // archived by other people and keeps its original timestamp. Same fact,
      // two correct answers, so the flag says which you are reading.
      gradedUnderCriteria: r.headline?.graded ?? null,
      // Which suite measured this run. The envelope's `suite` describes only the
      // current board, so a consumer walking run-over-run history could see the
      // denominator move and not tell which release moved it. Joined on run date,
      // the same key the history model uses for per-run enrichment. Null for a
      // run measured before the identity existed.
      suite: summary?.byRunDate?.[r.date]?.suite ?? null,
      targets: r.standings.map(targetRow),
    })),
  };
}
