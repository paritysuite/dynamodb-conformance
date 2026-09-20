import { formatNumber } from "./numbers.mjs";
// Build the per-region model from the suite's results/summary.json.
//
// summary.json (schemaVersion 1) is the suite's 2.0.0 addition: every target
// scored against every observed region, its headline the best-matching region.
// This module turns one raw summary into the shape the templates and the
// history join consume, and it owns the one presentation rule that the raw data
// can't express on its own: how to name the region a headline matched.
//
// The region label follows the "honest cohort" rule. The suite's own Region
// column crowns a single tie-break winner even when a target scores identically
// everywhere, which reads as "conformant to af-south-1" when the truth is
// "conformant to every region equally". Instead:
//   - all         every observed region ties at the top rate -> "all regions"
//   - pinned-plus eu-west-2 is in the top cohort              -> "eu-west-2 + N regions"
//   - beats-pinned the top cohort excludes eu-west-2          -> name it, and flag
//                 that the target beats eu-west-2 there (the release's reason to
//                 exist; no live instances today, but the display must handle it)
// This never disagrees with the suite on a figure - the rate is the suite's
// headline rate - only on how the matched region is described.

import { asPct, axesOf, pct } from "./scoring.mjs";
import { GATING_LANE } from "dynamodb-conformance/scripts/summarise.mjs";
import { cohortOf, regionLabel } from "dynamodb-conformance/scripts/lib/score.mjs";

const PINNED = "eu-west-2";

// Normalise the summary's compact tier shape { p, f, s, i } into the per-tier
// counts plus divergence and coverage, matching how scoreEmulator reports tiers
// so the drilldown and the standings read the same. Correctness is kept under
// its own name for anyone who still wants it.
//
// The denominator counts indeterminates, which this used to leave out of
// `total` while scoreEmulator counted them. A tier's divergence has to be over
// the same denominator on both sides or the drilldown would disagree with the
// tier bar above it on the same page.
function tierOf(t) {
  const passed = t?.p ?? 0;
  const failed = t?.f ?? 0;
  const skipped = t?.s ?? 0;
  const indeterminate = t?.i ?? 0;
  const total = passed + failed + skipped + indeterminate;
  const { divergence: divergenceValue, coverage: coverageValue } = axesOf({
    passed,
    failed,
    count: total,
    indeterminate,
  });
  return {
    passed,
    failed,
    skipped,
    indeterminate,
    total,
    divergenceValue,
    divergence: asPct(divergenceValue),
    coverageValue,
    coverage: asPct(coverageValue),
    correctness: pct(passed, failed),
    correctnessValue: passed + failed === 0 ? null : (passed / (passed + failed)) * 100,
  };
}

// One region's entry for a target, from summary.targets[slug].regions[region].
// `rate` stays as the suite published it (correctness in that region); the
// divergence beside it is what the drilldown now shows.
function regionEntry(region, r) {
  // Every guard the board applies, because it is the board's own function:
  // diverging nowhere because you attempted nothing is the absence of a score
  // rather than a good one, and a region carrying indeterminates has no score
  // to publish at all. Restating the formula here dropped the second of those.
  const { divergence: divergenceValue } = axesOf({
    passed: r?.passed ?? 0,
    failed: r?.failed ?? 0,
    count: r?.count ?? 0,
    indeterminate: r?.indeterminate ?? 0,
  });
  return {
    region,
    rate: r?.rate ?? null,
    divergenceValue,
    divergence: asPct(divergenceValue),
    passed: r?.passed ?? 0,
    failed: r?.failed ?? 0,
    skipped: r?.skipped ?? 0,
    indeterminate: r?.indeterminate ?? 0,
    count: r?.count ?? 0,
    tiers: {
      tier1: tierOf(r?.tiers?.tier1),
      tier2: tierOf(r?.tiers?.tier2),
      tier3: tierOf(r?.tiers?.tier3),
    },
  };
}

// Classify how a target's headline region should read, from its per-region
// rates. `entries` is every observed region's entry; `pinned` is the historical
// baseline region (eu-west-2). Returns the structured label; regionLabel() turns
// it into display text. See the module header for the three kinds.
// cohortOf and regionLabel come from the suite. Both used to be defined here
// too, each carrying a comment saying it mirrored the other - a duplicate with
// a note attached. The board and the README have to label a headline
// identically or one of them is wrong, so there is one of each now.
export { cohortOf, regionLabel };

export function regionCount(label) {
  if (!label || label.kind === "none" || !label.observed) return null;
  return `${label.regions.length} of ${label.observed}`;
}

// Per-target model: every region's entry (rate desc, then name), the headline
// rate and its cohort label, and flags the drilldown reads.
function targetOf(slug, t, pinned) {
  // Best first, which on divergence means lowest first. A region with no
  // figure sorts last rather than ahead of every measured one.
  const entries = Object.entries(t?.regions ?? {})
    .map(([region, r]) => regionEntry(region, r))
    .sort((a, b) => (a.divergenceValue ?? Infinity) - (b.divergenceValue ?? Infinity) || a.region.localeCompare(b.region));

  const label = cohortOf(entries, pinned);
  const cohortSet = new Set(label.regions);
  const regions = entries.map((e) => ({
    ...e,
    pinned: e.region === pinned,
    inCohort: cohortSet.has(e.region),
    indeterminatePresent: e.indeterminate > 0,
  }));

  // How much the regions disagree about this target's divergence. Carried as a
  // spread on the figure itself rather than a count of matching regions: a
  // count is not a quality measure and was read as one, since a target equally
  // wrong in all 33 regions counted higher than one perfect in 6 and
  // near-perfect in the rest.
  const perRegion = regions.map((e) => e.divergenceValue).filter((v) => v != null);

  return {
    slug,
    // The suite's headline rate is authoritative; cohortOf derives the label
    // from the same per-region data, so the two agree by construction.
    rate: t?.headline?.rate ?? label.rate,
    suiteHeadlineRegion: t?.headline?.region ?? null,
    label,
    regions,
    divergenceBest: perRegion.length ? Math.min(...perRegion) : null,
    divergenceWorst: perRegion.length ? Math.max(...perRegion) : null,
    version: t?.version ?? null,
    runDate: t?.runDate ?? null,
    // Evidence rather than a figure: the tests a zero-divergence target fails
    // outside its headline region, by name, for the build to check against the
    // split registry. Null where the suite published nothing, which for a
    // target that fails somewhere means the artefact is too old to check.
    regionFailures: t?.regionFailures ?? null,
  };
}

// Group a target's region entries by divergence (lowest, i.e. best, first) for
// the drilldown. The 33-region set clusters into a handful of figures, so
// grouping is far more scannable than a flat list, and it makes a genuine split
// obvious.
export function groupRegionsByDivergence(regions) {
  const byValue = new Map();
  for (const r of regions) {
    if (r.divergenceValue == null) continue;
    if (!byValue.has(r.divergenceValue)) byValue.set(r.divergenceValue, []);
    byValue.get(r.divergenceValue).push(r);
  }
  return [...byValue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([divergenceValue, rs]) => ({
      divergenceValue,
      divergence: asPct(divergenceValue),
      count: rs.length,
      regions: rs,
    }));
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Render the per-region drilldown for a target as grouped rate bands. WebC can't
// nest a webc:for over a property of an outer loop variable (the groups, then
// the regions in each), so the grouped view is built here as HTML, the same way
// lib/matrix.mjs and lib/capabilities.mjs build theirs.
export function renderRegionGroups(regions) {
  const groups = groupRegionsByDivergence(regions);
  if (groups.length === 0) return "";
  return groups
    .map((g) => {
      const chips = g.regions
        .map((r) => {
          const marks = [];
          if (r.pinned) marks.push("baseline");
          if (r.indeterminatePresent) marks.push(`${r.indeterminate} indeterminate`);
          const suffix = marks.length ? ` <span class="text-zinc-400 dark:text-zinc-500">· ${esc(marks.join(" · "))}</span>` : "";
          const strong = r.pinned || r.inCohort ? "text-zinc-700 dark:text-zinc-200 font-medium" : "text-zinc-500 dark:text-zinc-400";
          return `<span class="font-mono ${strong}">${esc(r.region)}${suffix}</span>`;
        })
        .join("");
      return `
      <div class="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50/70 dark:bg-white/[0.03] p-4">
        <div class="flex items-baseline justify-between mb-2">
          <span class="font-mono font-bold tnum text-zinc-900 dark:text-zinc-100">${esc(g.divergence)}</span>
          <span class="text-xs text-zinc-500 dark:text-zinc-400 tnum">${g.count} ${g.count === 1 ? "region" : "regions"}</span>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs">${chips}</div>
      </div>`;
    })
    .join("");
}

/**
 * What the real-AWS run actually observed, for the control strip.
 *
 * Real DynamoDB is measured in three lanes - the gating run plus the slower
 * integrations and GSI lanes - and the baseline row is pinned at the full suite
 * until all three have published. The strip was reading the pinned row, so it
 * said "998 of 998 reproduced" about a run that recorded 981.
 *
 * The counts and the lanes come from the artefact rather than the row, so the
 * strip states what was seen and names the lanes behind it. Three captures at
 * different times rendered as one measurement would be worse than a disclosed
 * literal, because it looks derived.
 */
export function controlObservation(groundTruth) {
  if (!groundTruth) return null;
  const observed = groundTruth.testsObserved ?? null;
  const suite = groundTruth.suiteSize ?? null;
  const lanes = groundTruth.lanes ?? [];
  const missing = groundTruth.missingLanes ?? [];
  return {
    observed,
    suite,
    shortfall: suite != null && observed != null ? Math.max(0, suite - observed) : null,
    missingLanes: missing,
    // One capture date per lane: three captures under a single date would read
    // as one measurement.
    dated: lanes.filter((l) => l.runDate).map((l) => ({ name: l.name, runDate: l.runDate, tests: l.tests })),
    // By name. Positionally it is first today, and a reordering would have the
    // strip date the whole observation to whichever pass happened to lead.
    mainRun: lanes.find((l) => l.name === GATING_LANE) ?? null,
  };
}

// Plain names, because the page around this one explains the three passes in
// words. "gating lane" is what CI calls it, not what a reader would.
const COUNT_WORDS = ["", "one", "two", "three", "four"];
const LANE_NAMES = { gating: "the main run", integrations: "integrations", gsi: "GSI" };
const listOf = (items) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * The strip's one-line split: how the whole-suite count divides between the run
 * that reported and the passes that have not.
 *
 * The headline counts the suite, not the artefact. "981 of 998 checked against
 * live AWS" reads as 17 tests nobody validated, which is the opposite of what
 * the suite guarantees: all 998 run against real AWS, and 17 of them run in
 * slower passes whose results have not reached this artefact.
 */
export function controlSplit(obs) {
  if (!obs || !obs.shortfall) return "";
  const n = obs.missingLanes.length;
  const word = COUNT_WORDS[n] ?? String(n);
  const passes = `${word} slower pass${n === 1 ? "" : "es"}`;
  // No date of its own: the line it sits on is already labelled with the run
  // this refers back to, and repeating it there read as two measurements.
  return `${formatNumber(obs.observed)} in that run, ${formatNumber(obs.shortfall)} in ${passes}`;
}

/** Which passes have reported, when, and what is still outstanding. */
export function controlProvenance(obs, dateLabel = (d) => d) {
  if (!obs) return "";
  const seen = listOf(obs.dated.map((l) => `${LANE_NAMES[l.name] ?? l.name} on ${dateLabel(l.runDate)}`));
  if (!obs.shortfall) return seen ? `Measured by ${seen}.` : "";
  const missing = listOf(obs.missingLanes.map((n) => LANE_NAMES[n] ?? n));
  const tests = `${formatNumber(obs.shortfall)} test${obs.shortfall === 1 ? "" : "s"}`;
  const tail = missing
    ? `${tests} sit in the ${missing} passes, which have not reported yet.`
    : `${tests} have not been observed yet.`;
  return seen ? `Measured by ${seen}. ${tail}` : tail;
}

// Turn a raw summary.json into the per-region model, or an unavailable marker
// when the payload is missing or not the schema we understand. Never throws: an
// absent or malformed summary degrades the site to its eu-west-2-only story
// rather than failing the build.
export function buildSummaryModel(raw, { pinned = PINNED } = {}) {
  if (!raw || raw.schemaVersion !== 1 || !raw.targets) {
    return { available: false, targets: {}, regions: { observed: [], unresolved: [], dropped: [], detail: {} } };
  }

  const targets = {};
  for (const [slug, t] of Object.entries(raw.targets)) targets[slug] = targetOf(slug, t, pinned);

  return {
    available: true,
    schemaVersion: raw.schemaVersion,
    // What produced this board. Absent on a board written before the field
    // existed, which reads as "not stated" rather than as an error so an older
    // summary still renders.
    suite: raw.suite ?? null,
    groundTruth: raw.groundTruth ?? null,
    runDate: raw.groundTruth?.runDate ?? null,
    regions: {
      observed: raw.regions?.observed ?? [],
      unresolved: raw.regions?.unresolved ?? [],
      dropped: raw.regions?.dropped ?? [],
      detail: raw.regions?.detail ?? {},
    },
    targets,
    pinned,
  };
}
