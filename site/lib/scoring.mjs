// Scoring for the site, built on the suite's own scoring modules.
//
// The target maps, tier classification and pass-rate maths are imported from
// the suite rather than restated here. They used to be a hand-copied port, and
// the copies drifted: a target added to the suite's maps took a further day to
// reach the site's, so for that day the board scored a target it could not
// name. Anything a reader could see on both surfaces now has one definition.
//
// What stays site-side is what the suite has no use for: the per-area and
// per-capability views, and the display choices behind them.
import {
  DISPLAY,
  REPO,
  TARGETS,
  CHANNELS_SHOWN,
  configurationOf,
  display,
  distributionOf,
  isVariant,
  projectOf,
  repoUrl,
  label,
} from "dynamodb-conformance/scripts/summarise.mjs";
import { GROUND_TRUTH_SLUG, axesOf, passRate, scoreResults, tierOf } from "dynamodb-conformance/scripts/lib/score.mjs";
import { figuresDiffer } from "dynamodb-conformance/scripts/lib/standings.mjs";
import { classifyResults } from "dynamodb-conformance/scripts/lib/classify.mjs";
import {
  A_PLUS,
  BASELINE_GRADE,
  BASELINE_LABEL,
  COVERAGE_DIVISOR,
  GRADE_BANDS,
  GRADING_CRITERIA_EFFECTIVE,
  GRADING_VERSION,
  bandOf,
  effectiveOf,
  gradeOf,
  gradingCriteriaEffectiveLabel,
} from "dynamodb-conformance/scripts/lib/grade.mjs";

export { DISPLAY, REPO, TARGETS, CHANNELS_SHOWN, GROUND_TRUTH_SLUG, configurationOf, display, distributionOf, isVariant, projectOf, repoUrl, label, tierOf };

// The two published figures, from the suite's own definition. Re-exported so
// every site module derives them from one place: each surface that restated
// the formula inline also quietly dropped the guard axesOf applies to a run
// carrying indeterminates.
export { axesOf };

// The letter grade, imported from the suite like the rest of the scoring so
// the board, the README table and the badges grade from one definition. The
// grade is derived from a row's two published values at the point of use -
// never stored on the row - so every surface that shows a letter shows the
// one implied by the figures beside it.
export { A_PLUS, BASELINE_GRADE, BASELINE_LABEL, COVERAGE_DIVISOR, GRADE_BANDS, GRADING_CRITERIA_EFFECTIVE, GRADING_VERSION, bandOf, effectiveOf, gradeOf, gradingCriteriaEffectiveLabel };

// The one-line reading beside a grade chip: the qualifier in words, the
// exact figure after it. The percentage stays for anyone who wants the
// number, but it no longer carries the meaning alone - "0.0% diverges" reads
// as a zero, "no divergence" reads as what it is. Shared by every surface
// that prints the phrase (standings rows, variant rows, the target page's
// other-builds cards), so a build cannot read differently from the board.
export function gradeLineOf(row) {
  const grade = gradeOf(row.divergenceValue, row.coverageValue);
  const div = grade.letter === null || row.divergenceValue === 0 ? "" : ` (${row.divergence})`;
  return grade.qualifier + div;
}

// The grade for a row, and the call every rendering surface should make: the
// baseline's exemption travels with the data rather than being a rule each
// template has to remember. `gradeOf` stays exported for callers that hold only
// the pair, like the legend and the tier bars.
//
// `slug` is for surfaces whose rows are run points: a point carries figures and
// a date but not the identity of the target it belongs to, and without it the
// baseline's definitional 0.0/100.0 grades like any other row.
export function gradeForRow(row, slug) {
  if (!row) return gradeOf(null, null);
  const id = slug ?? row.slug;
  const isBaseline = row.baseline || row.synthesised || id === GROUND_TRUTH_SLUG;
  return isBaseline ? BASELINE_GRADE : gradeOf(row.divergenceValue, row.coverageValue);
}

// The board's grade legend, derived from the criteria rather than typed beside
// them. It is where a reader goes to check a letter, so it is the one place on
// the board that must not be able to drift from what the grader does.
export function gradeLegendOf() {
  return [
    { letter: "A+", bound: "0% at full coverage", band: bandOf("A+") },
    ...GRADE_BANDS.map((b) => ({ letter: b.letter, bound: `<${b.under}%`, band: bandOf(b.letter) })),
    { letter: "F", bound: "beyond", band: bandOf("F") },
  ];
}

// The legend's second sentence: what coverage does to the letter, as arithmetic
// a reader can repeat on the two figures printed on any row. Derived from the
// divisor so it cannot fall behind a retune.
const SHARES = { 2: "half", 3: "a third", 4: "a quarter" };
export function coverageShareSentenceOf() {
  const share = SHARES[COVERAGE_DIVISOR] ?? `one ${COVERAGE_DIVISOR}th`;
  return `Coverage can only lower a letter, never raise it: ${share} of whatever a target leaves unimplemented is added to its divergence before the bands are read.`;
}

// What coverage is doing to a row's letter, or "" when it is doing nothing.
// Shown wherever a letter is read, because a letter held down by scope and one
// earned outright are different facts and the coverage figure alone does not
// separate them.
export function capClauseOf(row, slug) {
  const { capAt } = gradeForRow(row, slug);
  return capAt ? `coverage lowers this row to ${capAt}` : "";
}

// The regional distribution, always with the figures attached: "in all 33
// regions", or "in 6 regions · up to 0.3% in the other 27". A bare count
// read inverted - a target failing identically everywhere showed "33 of 33"
// while one perfect in six showed "6 of 33", so the bigger number read as
// the better target - but paired with its figure the count says what it
// means. "Up to", because the remainder need not be uniform. Empty when the
// row carries no regional data (runs before the per-region overlay).
export function regionClauseOf(row) {
  const cohort = row.regionLabel?.regions?.length;
  const observed = row.regionLabel?.observed;
  if (!cohort || !observed) return "";
  const rest = observed - cohort;
  // A cohort of one is common - a target measured in a single region - and it
  // reads as a typo rather than a measurement when the noun stays plural.
  const regions = (n) => `${n} region${n === 1 ? "" : "s"}`;
  if (rest === 0) return `in all ${regions(observed)}`;
  if (!row.divergenceWorstLabel) return `in ${cohort} of ${regions(observed)}`;
  return `in ${regions(cohort)} · up to ${row.divergenceWorstLabel} in the other ${rest}`;
}

// Targets maintained by the person who also runs this board. The conflict of
// interest is disclosed at the score itself, because that disclosure is the
// board's credibility: the number is produced by the same automated tests as
// every other engine, not adjusted by hand.
// The run on which the board stopped publishing correctness and started
// publishing divergence and coverage. Every earlier run is rebuilt from its own
// results and restated in the new figures, which is right - the results didn't
// change - but someone who cited "Dynalite 84.6%, 22 Jul" can no longer find
// that number anywhere, so runs before this date say so.
// The board stopped publishing correctness on the day the criteria took
// effect, not before it. Pinned to the same constant: set three runs early,
// the runs in between were published under the retired metric and said
// nothing about it.
export const METRIC_CHANGED_ON = GRADING_CRITERIA_EFFECTIVE;
export const scoredOnCorrectness = (date) => !!date && date < METRIC_CHANGED_ON;

// Keyed by project, not slug: a build of a self-maintained engine is the
// same conflict of interest as the engine, and an exact-slug lookup let the
// wasm build's page and its maintainedByAuthor field claim otherwise.
export const SELF_MAINTAINED = new Set(["dynoxide"]);
export const isSelfMaintained = (slug) => SELF_MAINTAINED.has(projectOf(slug));

// The operation group within a tier, e.g. tier2/transactions, taken from the
// test file's directory. Stable across the suite's growth (unlike test titles).
export const areaOf = (filePath) => {
  const m = filePath.match(/\/(tier[123])\/([^/]+)\//);
  return m ? { tier: m[1], group: m[2], key: `${m[1]}/${m[2]}` } : null;
};

// Per-area breakdown of where a target falls short: the operation groups with
// failing or skipped tests, each carrying the exact test titles. Sorted by the
// size of the gap. Used on target pages; not part of the README parity table.
export function breakdownOf(raw) {
  const map = new Map();
  const verdicts = verdictsOf(raw);
  for (const tr of raw?.testResults ?? []) {
    const area = areaOf(tr.name);
    if (!area) continue;
    if (!map.has(area.key)) {
      map.set(area.key, { key: area.key, tier: area.tier, group: area.group, passed: 0, failed: 0, skipped: 0, indeterminate: 0, failures: [], skips: [] });
    }
    const e = map.get(area.key);
    for (const ar of tr.assertionResults ?? []) {
      const title = ar.fullName || ar.title || "(unnamed test)";
      const verdict = verdictFor(verdicts, ar);
      if (verdict === "pass") e.passed++;
      else if (verdict === "fail") { e.failed++; e.failures.push(title); }
      else if (verdict === "indeterminate") e.indeterminate++;
      else { e.skipped++; e.skips.push(title); }
    }
  }
  return [...map.values()]
    .filter((e) => e.failed + e.skipped > 0)
    .map((e) => ({ ...e, total: e.passed + e.failed + e.skipped + e.indeterminate }))
    .sort((a, b) => b.failed + b.skipped - (a.failed + a.skipped) || a.key.localeCompare(b.key));
}

// A breakdown split into the two questions a reader actually has, which the
// single "where it falls short" list ran together. An operation a target
// implements and gets wrong is a defect you find in production; one it never
// attempts is scope you plan around. They were listed together, distinguished
// only by a badge, so a target's gaps read as one undifferentiated pile.
//
// Anything with a failure is a divergence, whatever else it also skips: the
// failure is the part that matters and it belongs in the first list.
export const fallsShort = (breakdown) => (breakdown ?? []).filter((a) => a.failed > 0);

// The rest: nothing wrong, but tests that never ran. `whole` marks an operation
// the target implements none of, as against one it implements in part.
export const notAttempted = (breakdown) =>
  (breakdown ?? [])
    .filter((a) => a.failed === 0 && a.skipped > 0)
    .map((a) => ({ ...a, whole: a.passed === 0 }));

// The support state of an operation area, shared by the badges and the matrix:
//   supported   - passes everything it runs, nothing skipped (fully implemented)
//   partial     - implemented, but not a clean pass: passes some, and fails
//                 and/or skips others (the operation works, with specific gaps)
//   failing     - implemented, but no test passes (every implemented test is wrong)
//   unsupported - every test skipped (the target implements none of it)
//
// A single failing edge case no longer paints a whole operation as failing:
// an area that mostly passes reads as partial, so the matrix distinguishes
// "works, with gaps" from "implemented but wholly wrong". `failing` is reserved
// for the genuinely broken case where nothing the target runs passes.
// Verdicts for a raw document, keyed by test identity.
//
// Every tally below reads these rather than `assertionResults[].status`.
// classify.mjs is the chokepoint and its own docstring forbids reading the raw
// status, for a reason that bites here: an indeterminate test still records
// `status: "failed"`, so a provisioning timeout was counted as a divergence in
// a table that now says "diverges on X% of it". No sidecar is passed - the site
// reads historical results one file at a time and has no run-level document to
// go with them - so only per-test markers are honoured, which is the same input
// scoreEmulator uses.
// Keyed on the assertion object itself, paired up by traversal order, because
// classifyResults walks testResults and assertionResults in exactly this order.
// Keying on `file::fullName` instead would collapse every assertion in a file
// that reports no fullName onto one entry.
const verdictsOf = (raw) => {
  const by = new Map();
  if (!Array.isArray(raw?.testResults)) return by;
  const list = classifyResults(raw, null);
  let i = 0;
  for (const tr of raw.testResults) {
    for (const ar of tr.assertionResults ?? []) by.set(ar, list[i++]?.verdict ?? "skip");
  }
  return by;
};

// One assertion's verdict, defaulting to a skip for anything the classifier did
// not see (it cannot happen from the same document, and counting an unknown as
// a pass would be the wrong direction if it ever did).
const verdictFor = (verdicts, ar) => verdicts.get(ar) ?? "skip";

export function areaState({ passed, failed, skipped }) {
  if (passed === 0 && failed === 0) return "unsupported"; // nothing implemented (all skipped)
  if (failed === 0 && skipped === 0) return "supported"; // every test passes
  if (passed === 0) return "failing"; // implemented, but every run fails
  return "partial"; // a mix: passes some, fails and/or skips others
}

// Every operation area a target's results touch, with counts and derived state.
// Unlike breakdownOf this keeps the fully-supported areas too, so the badges
// (supported areas) and the matrix (all areas) can both build from it.
export function areaTallies(raw) {
  const map = new Map();
  const verdicts = verdictsOf(raw);
  for (const tr of raw?.testResults ?? []) {
    const area = areaOf(tr.name);
    if (!area) continue;
    if (!map.has(area.key)) {
      map.set(area.key, { key: area.key, tier: area.tier, group: area.group, passed: 0, failed: 0, skipped: 0, indeterminate: 0 });
    }
    const e = map.get(area.key);
    for (const ar of tr.assertionResults ?? []) {
      const verdict = verdictFor(verdicts, ar);
      if (verdict === "pass") e.passed++;
      else if (verdict === "fail") e.failed++;
      else if (verdict === "indeterminate") e.indeterminate++;
      else e.skipped++;
    }
  }
  return [...map.values()]
    .map((e) => ({ ...e, total: e.passed + e.failed + e.skipped + e.indeterminate, state: areaState(e) }))
    .sort((a, b) => a.tier.localeCompare(b.tier) || a.group.localeCompare(b.group));
}

// Cross-cutting capability axes surfaced on the capability grid (target x
// capability). These are the chooser-relevant features the operation matrix
// can't show as one line because a directory tree fragments them - GSI support
// is exercised across createTable/query/scan/updateTable, legacy parameters
// span several operations, and so on.
//
// This list is a *display* choice: which tags to surface as columns, and their
// labels. Membership - which tests carry which tag - is NOT decided here. It
// comes from the suite's published tag manifest (results/tag-manifest.json),
// generated from the applied tags in src/tags.ts, so there is one source of
// truth and no path-pattern taxonomy to drift.
//
// Two groups. "core" is DynamoDB's own surface - indexes, PartiQL, transactions,
// streams, TTL, legacy params. "wider" features reach beyond DynamoDB into other
// AWS services: S3 for export/import, Kinesis for streaming, IAM for resource
// policies, CloudWatch for Contributor Insights, plus backups/PITR and the
// account-level APIs. A DynamoDB-only emulator won't have these; one that also
// emulates the surrounding services can, and some do. The group is surfaced
// rather than hidden, so a high score can't imply a feature the suite skipped.
export const CAPABILITIES = [
  { key: "vector", label: "Vector search", group: "core" },
  { key: "gsi", label: "GSI", group: "core" },
  { key: "lsi", label: "LSI", group: "core" },
  { key: "partiql", label: "PartiQL", group: "core" },
  { key: "transactions", label: "Transactions", group: "core" },
  { key: "streams", label: "Streams", group: "core" },
  { key: "ttl", label: "TTL", group: "core" },
  { key: "legacy", label: "Legacy params", group: "core" },
  { key: "backups", label: "Backups / PITR", group: "wider" },
  { key: "export-import", label: "Export / import", group: "wider" },
  { key: "kinesis", label: "Kinesis", group: "wider" },
  { key: "resource-policy", label: "Resource policies", group: "wider" },
  { key: "contributor-insights", label: "Contributor Insights", group: "wider" },
  { key: "account", label: "Account API", group: "wider" },
];

// The capability groups, in display order, with the column heading each spans.
export const CAPABILITY_GROUPS = [
  { key: "core", label: "Core DynamoDB" },
  { key: "wider", label: "Other AWS services" },
];

// The repo-relative "tests/..." tail of a test file path, the manifest's join
// key. Results carry an absolute (CI) or local path; the manifest is keyed
// relative to the repo root.
const testsKey = (file) => {
  const i = file.indexOf("tests/");
  return i >= 0 ? file.slice(i) : file;
};

// Per-capability tally for one target's raw results, joined to the tag manifest:
// for each test, look up its resolved tags by (file, top-level describe title,
// test name), then sum pass/fail/skip into every capability column that tag set
// includes. State is derived the same way areaState does, so the glyphs match
// the matrix. With no manifest (e.g. a fetch fallback) every capability reports
// n/a.
//
// A tag can sit on an individual test rather than on its describe, which is how
// a capability is marked when only some tests in a describe exercise it. Schema
// 2 of the manifest carries those in `tests`, holding only what is added below
// the describe, so the two maps are unioned here. The site fetches the manifest
// live from the suite's main branch at build time, so it can be handed either
// schema; a schema 1 manifest simply has no `tests` and the union is a no-op.
export function capabilityTallies(raw, manifest) {
  const describes = manifest?.describes ?? {};
  const perTest = manifest?.tests ?? {};
  const tally = Object.fromEntries(CAPABILITIES.map((c) => [c.key, { passed: 0, failed: 0, skipped: 0, indeterminate: 0 }]));
  const verdicts = verdictsOf(raw);
  for (const tr of raw?.testResults ?? []) {
    const key = testsKey(tr.name);
    const byTitle = describes[key] ?? {};
    const testsByTitle = perTest[key] ?? {};
    for (const ar of tr.assertionResults ?? []) {
      const describeTitle = ar.ancestorTitles?.[0];
      const tags = [
        ...(byTitle[describeTitle] ?? []),
        ...(testsByTitle[describeTitle]?.[ar.title] ?? []),
      ];
      for (const c of CAPABILITIES) {
        if (!tags.includes(c.key)) continue;
        const e = tally[c.key];
        const verdict = verdictFor(verdicts, ar);
        if (verdict === "pass") e.passed++;
        else if (verdict === "fail") e.failed++;
        else if (verdict === "indeterminate") e.indeterminate++;
        else e.skipped++;
      }
    }
  }
  return CAPABILITIES.map((c) => {
    const e = tally[c.key];
    return { key: c.key, label: c.label, ...e, total: e.passed + e.failed + e.skipped + e.indeterminate, state: areaState(e) };
  });
}

// Numeric correctness for charts / sorting / movement: correctness over
// IMPLEMENTED operations, passed / (passed + failed). Skips are excluded from
// the denominator (an operation the target doesn't implement is scope, not a
// fail). null when nothing was implemented. The suite's passRate under the
// name the site's callers already use.
const value = passRate;

// The same number as a display string, one decimal place, "-" when nothing was
// implemented. Formatting is the only thing the site adds over passRate.
export const pct = (passed, failed) => {
  const rate = passRate(passed, failed);
  return rate === null ? "-" : `${rate.toFixed(1)}%`;
};

export const runDateOf = (raw) =>
  raw?.startTime ? new Date(raw.startTime).toISOString().slice(0, 10) : "-";

// A document with no testResults array scores nothing. The suite's scorer says
// so by returning null; the site still has to render a row, so an empty tally
// stands in and the target shows "-" rather than vanishing from the board.
const NOTHING_SCORED = {
  summary: {
    tier1: { p: 0, f: 0, s: 0, i: 0 },
    tier2: { p: 0, f: 0, s: 0, i: 0 },
    tier3: { p: 0, f: 0, s: 0, i: 0 },
  },
  passed: 0,
  failed: 0,
  skipped: 0,
  indeterminate: 0,
  count: 0,
};

const tierTotal = (t) => t.p + t.f + t.s + t.i;

// A percentage as published, or "-" when there was nothing to measure. Exported
// so the per-region model formats figures identically rather than restating it.
export const asPct = (v) => (v == null ? "-" : `${v.toFixed(1)}%`);

// One tier's figures, on the same two axes as the headline: divergence over the
// whole tier, coverage beside it. Correctness is kept under its own name rather
// than left as the unqualified percentage it used to be, so a consumer reading
// a tier figure cannot get the old meaning from a field that changed under it.
export function tierFigures(t) {
  const total = tierTotal(t);
  const implemented = t.p + t.f;
  // The suite's axes, not a local copy: a tier figure and a headline figure
  // that drifted apart would put two different divergences on one page.
  const { divergence: divergenceValue, coverage: coverageValue } = axesOf({
    passed: t.p,
    failed: t.f,
    count: total,
    indeterminate: t.i,
  });
  return {
    passed: t.p,
    failed: t.f,
    skipped: t.s,
    indeterminate: t.i,
    total,
    divergenceValue,
    divergence: asPct(divergenceValue),
    coverageValue,
    coverage: asPct(coverageValue),
    correctnessValue: passRate(t.p, t.f),
    correctness: pct(t.p, t.f),
  };
}

// Score one target's Vitest JSON into the canonical row the rest of the site
// builds on. Not used for the synthesised DynamoDB ground-truth row.
//
// The tallying is the suite's (scoreResults -> classifyResults), so a test the
// suite counts one way cannot be counted another way here. That matters most
// for the verdict the raw status cannot express: a timeout or an exhausted
// throttle records as "failed" but means nobody observed an answer, and the
// suite excludes it from the score rather than holding it against the target.
// Tallying it here from `status` alone would have scored those runs lower than
// the published table does.
//
// No sidecar is passed. The site reads historical results one file at a time
// from the published tree and has no run-level indeterminate document to go
// with them, so only per-test markers are honoured. That is the same input the
// site has always had; it is now read through the shared classifier.
export function scoreEmulator(slug, raw, version) {
  const scored = scoreResults(raw, null) ?? NOTHING_SCORED;
  const s = scored.summary;

  const tier = tierFigures;

  const { passed, failed, skipped, indeterminate, count } = scored;
  const implemented = passed + failed;
  // Coverage is the scope axis: how much of the suite the target implements at
  // all. Divergence is the risk axis, over the whole suite rather than over
  // what the target attempts. They are kept apart because the consequences
  // differ - a declined operation is discoverable in minutes, a wrong one in
  // production - and one figure would price them the same.
  //
  // Divergence is null when the target implemented nothing: diverging nowhere
  // because you attempted nothing is the absence of a score, and a zero would
  // sort an empty target above every real engine. Both come from the suite's
  // axesOf so the site cannot compute either differently from the board.
  const { divergence: divergenceValue, coverage: coverageValue } = axesOf(scored);

  return {
    slug,
    target: label(slug),
    display: display(slug),
    repoUrl: repoUrl(slug),
    tiers: { tier1: tier(s.tier1), tier2: tier(s.tier2), tier3: tier(s.tier3) },
    passed,
    failed,
    skipped,
    indeterminate,
    count,
    implemented,
    unsupported: skipped,
    coverageValue,
    coverage: coverageValue === null ? "-" : `${coverageValue.toFixed(1)}%`,
    divergenceValue,
    divergence: divergenceValue === null ? "-" : `${divergenceValue.toFixed(1)}%`,
    total: pct(passed, failed),
    totalValue: value(passed, failed),
    version: version || "-",
    runDate: runDateOf(raw),
  };
}

// Synthesise the DynamoDB ground-truth row: real DynamoDB is 100% by
// definition across the full suite, so the row is present and correct even on
// runs that never exercised AWS. suiteSize is the largest emulator count seen.
export function dynamodbRow(suiteSize, date) {
  return {
    slug: GROUND_TRUTH_SLUG,
    target: label(GROUND_TRUTH_SLUG),
    display: display(GROUND_TRUTH_SLUG),
    repoUrl: repoUrl(GROUND_TRUTH_SLUG),
    // Derived the same way every other row's tiers are, so the baseline can't
    // carry a hand-written shape that drifts from the scored one.
    tiers: {
      tier1: tierFigures({ p: suiteSize, f: 0, s: 0, i: 0 }),
      tier2: tierFigures({ p: suiteSize, f: 0, s: 0, i: 0 }),
      tier3: tierFigures({ p: suiteSize, f: 0, s: 0, i: 0 }),
    },
    passed: suiteSize,
    failed: 0,
    skipped: 0,
    count: suiteSize,
    implemented: suiteSize,
    unsupported: 0,
    coverageValue: 100,
    coverage: "100.0%",
    divergenceValue: 0,
    divergence: "0.0%",
    total: "100.0%",
    totalValue: 100,
    version: "live (AWS)",
    runDate: date,
    synthesised: true,
    // The one flag that governs "gets no dated pages, gets no dated links",
    // matching the `baseline` on this target's perTarget entry, so the standings
    // row and the model agree. `synthesised` stays for display only (the movement
    // label and the ground-truth styling).
    baseline: true,
  };
}

// Largest emulator count in a set of scored rows - that run's full-suite size.
//
// This looks like the inference registry/suite-manifest.json replaced in the
// suite, and is not: the manifest says how big the suite is now, while the site
// renders every run ever recorded, and a run from before a test was added had a
// genuinely smaller suite. Reading today's manifest onto a historical run would
// restate history. The publish guard holds every row of a given run to one
// denominator, so the max over a run's rows is that run's size.
export const suiteSizeOf = (rows) => Math.max(0, ...rows.map((r) => r.count));

// Sort emulators by divergence ascending, then coverage descending, exactly as
// summarise.mjs does. The order is a risk ranking, not a verdict on which
// engine is better: a target that diverges nowhere over a narrow surface sits
// high and is described by its own coverage figure, so no minimum-coverage
// floor is needed to keep the order honest.
//
// The tie-break compares the plain name, not the `[name](url)` label:
// comparing the label sorts on the first character after the name - a "]" for
// a bare name, a space for a parenthetical one - so "Dynoxide (wasm)" would
// sort above "Dynoxide" on an equal figure, putting the preview above the
// engine it is a variant of. Comparing names makes a base engine a prefix of
// its variant, so "Dynoxide" sorts above "Dynoxide (wasm)".
const asc = (v) => (v == null ? Number.POSITIVE_INFINITY : v);
const desc = (v) => (v == null ? Number.NEGATIVE_INFINITY : v);
const sortName = (row) => {
  const m = row.target.match(/^\[([^\]]+)\]/);
  return m ? m[1] : row.target;
};
const byRisk = (a, b) =>
  asc(a.divergenceValue) - asc(b.divergenceValue) ||
  desc(b.coverageValue) - desc(a.coverageValue) ||
  sortName(a).localeCompare(sortName(b));

// Only projects compete for a place in the order; a build of one travels with
// it as a nested row. Seating variants in the same list would put builds of one
// engine in consecutive top slots, which reads as a project occupying the board
// rather than as one engine with two shapes. Mirrors summarise.mjs.
// Every row is returned, in project order with each project's builds directly
// behind it, and each parent additionally carrying its builds on `variants`.
// The list stays complete on purpose: the target index, the per-target pages
// and the JSON endpoints all need every scored target, and returning only
// parents silently dropped the variants from those surfaces. Only the standings
// renders the nesting, by skipping rows that are a build of something above.
//
// This assigns `variants` onto the caller's rows rather than returning copies,
// which is deliberate and not an oversight to tidy: history.mjs relies on a
// standings row and the matching `perTarget[].current` being the same object
// (see the note where it back-fills a version), so handing back copies here
// would quietly break that. The assignment always overwrites, so sorting the
// same rows twice gives the same answer.
/**
 * Whether a project's disclosure starts closed.
 *
 * One answer for the project rather than one per build, because the disclosure
 * holds every build and opens as a whole: a per-build answer could say a row
 * starts closed while a disagreeing sibling has already forced it open, and
 * that answer is published.
 *
 * Named rather than inlined so the rule can be read and tested in one place.
 * The mixed case it exists for - one build agreeing, another not - cannot be
 * reached through `sortRows` today, because no project in the registry ships
 * two builds and an unregistered slug forms a project of its own. So this
 * function is where that case is exercised, and `sortRows` assigns its single
 * answer to every build rather than deciding per build.
 */
export function buildsAgree(parent) {
  const builds = parent?.variants ?? [];
  if (!builds.length) return false;
  // A carried row on either side means the two were never measured together.
  if (parent.carried) return false;
  return builds.every((v) => !v.carried && !figuresDiffer(v, parent));
}

export function sortRows(rows) {
  const byProject = new Map();
  for (const row of rows) {
    const project = projectOf(row.slug);
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project).push(row);
  }
  const groups = [];
  for (const group of byProject.values()) {
    const parent = group.find((r) => !isVariant(r.slug)) ?? group[0];
    parent.variants = group.filter((r) => r !== parent).sort(byRisk);
    // Whether this project's builds start visible. Every build renders either
    // way; this only picks what the disclosure does on arrival.
    //
    // One answer for the project, not one per build. The disclosure holds every
    // build of a project and opens as a whole, so a per-build flag could say a
    // row starts closed while a disagreeing sibling has already forced it open -
    // and that flag is published, so the endpoints would have said it too.
    //
    // Three things have to hold. The figures have to match. Both builds have to
    // have been measured in this run, on either side: a build carried from an
    // earlier one has figures frozen at the run that measured it, and so does a
    // parent, so a carried row on either side means the two were never measured
    // beside each other. And a row the suite declined to score is excluded by
    // the predicate itself, since two rows printing "-" are not agreement.
    //
    // Nothing here reads `version`, so the summary overlay that rewrites it
    // further down the build cannot move this answer. That was not always true:
    // an earlier comparison read the whole row, which made the order of the two
    // load-bearing and led to re-deriving the flag after the overlay - which
    // then let a back-fill merge two builds the measurement had kept apart.
    // Widening the comparison would bring that ordering problem back with it.
    //
    // A flag per build rather than the split arrays this first carried. Those
    // arrays held the same row objects a second time, and leanForFallback
    // strips findings by destructuring `variants` alone - so every finding it
    // had just removed travelled back into the committed fallback through the
    // second reference.
    const agree = buildsAgree(parent);
    for (const v of parent.variants) v.collapsed = agree;
    // Which row stands for the project on the board. The standings used to work
    // this out from the slug - anything `isVariant` was a build and got skipped
    // - which dropped a whole project whenever its reference build had no
    // result: the grouping promotes a build to parent in that case, and the
    // board then filtered out the row it had just promoted. The README, deriving
    // its rows from the same grouping rather than from the slug, still printed
    // the project, so the two surfaces disagreed about which targets exist.
    parent.isParent = true;
    // Nothing holds a parent behind a disclosure, and a row promoted to parent may
    // still carry the flag from a grouping where it was a build. Cleared rather
    // than left to every caller passing rows built fresh from a snapshot.
    parent.collapsed = false;
    for (const v of parent.variants) v.isParent = false;
    groups.push(parent);
  }
  return groups.sort(byRisk).flatMap((parent) => [parent, ...parent.variants]);
}

// The site used to carry a second markdown-table renderer here, reproducing the
// suite's published table so a test could diff the two and catch drift. The
// suite has since rewritten its table per region, and the fixtures that pinned
// this one dated from before that, so it was pinning the site against its own
// past rather than against the suite. The scoring it shared with the suite is
// now imported outright, and the guard that does real work is the numeric check
// in scoring.test.mjs against the published summary.
