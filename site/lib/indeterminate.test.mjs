import { test } from "node:test";
import assert from "node:assert/strict";

import { axesOf, gradeForRow, gradeLineOf, regionClauseOf, scoreEmulator } from "./scoring.mjs";
import { buildSummaryModel } from "./summary.mjs";
import { assemble } from "./summary-source.mjs";
import { buildSummary } from "dynamodb-conformance/scripts/summarise.mjs";
import { testIdentities } from "dynamodb-conformance/scripts/lib/identity.mjs";
import { buildModel } from "./history.mjs";
import { buildLatest, buildRuns } from "./dataset.mjs";

// A run carrying indeterminates is not scored. The suite decides that once, in
// axesOf, because both other readings let an infrastructure fault move a
// published letter: counting an indeterminate against coverage lets a timeout
// lower a grade, and taking it out of the denominator makes converting a fail
// into a 503 cheaper than withdrawing the test.
//
// Four surfaces restated `failed / count` inline instead of calling axesOf, so
// four surfaces quietly dropped that decision - the site published figures and
// a letter for a run the README printed "-" for. Nothing caught it because no
// fixture anywhere carried an indeterminate. This is that fixture, and it holds
// the contract on each surface rather than on the helper, since the helper was
// never the thing that was wrong.

const REGION = "eu-west-2";

// Half the suite observed, half lost to transport faults: 4 passed, 2 failed,
// 4 indeterminate. Under the old inline formula the site read this as 20.0%
// divergence at 60.0% coverage and graded it. It must read as unscored.
const P = (n) => Array.from({ length: n }, () => ({ status: "passed", meta: {} }));
const F = (n) => Array.from({ length: n }, () => ({ status: "failed", meta: {} }));
const I = (n) =>
  Array.from({ length: n }, () => ({
    status: "failed",
    meta: { indeterminate: { reason: "transport", phase: "request" } },
  }));

const START = "2026-08-01T10:00:00Z";
const rawDoc = {
  startTime: Date.parse(START),
  testResults: [
    { name: "/x/tests/tier1/a.test.ts", assertionResults: [...P(4), ...F(2), ...I(4)] },
    { name: "/x/tests/tier2/b.test.ts", assertionResults: [] },
    { name: "/x/tests/tier3/c.test.ts", assertionResults: [] },
  ],
};

const scored = scoreEmulator("alpha", rawDoc, "1.0.0");
const snapshot = { ...scored, startTime: Date.parse(START), sha: "abc123" };

const summaryDoc = {
  schemaVersion: 1,
  available: true,
  regions: { observed: [REGION], unresolved: [], dropped: [] },
  groundTruth: { slug: "dynamodb", rate: 100, runDate: "2026-08-01", suiteSize: 10 },
  targets: {
    alpha: {
      headline: { region: REGION, rate: null },
      runDate: "2026-08-01",
      version: "1.0.0",
      regions: {
        [REGION]: {
          region: REGION,
          rate: null,
          passed: 4,
          failed: 2,
          skipped: 0,
          indeterminate: 4,
          count: 10,
          tiers: {
            tier1: { p: 4, f: 2, s: 0, i: 4 },
            tier2: { p: 0, f: 0, s: 0, i: 0 },
            tier3: { p: 0, f: 0, s: 0, i: 0 },
          },
        },
      },
    },
  },
};

// The overlay as buildModel consumes it: keyed by sweep date, each target entry
// carrying its own run date and its regions as a list. `suiteHeadlineRegion` is
// what makes enrichSnapshot rewrite the row from that region rather than
// leaving the snapshot on its own basis.
const overlay = {
  available: true,
  byRunDate: {
    "2026-08-01": {
      targets: {
        alpha: {
          runDate: "2026-08-01",
          label: "1 region",
          suiteHeadlineRegion: REGION,
          regions: [
            {
              region: REGION,
              divergenceValue: null,
              passed: 4,
              failed: 2,
              skipped: 0,
              indeterminate: 4,
              count: 10,
              tiers: { tier1: {}, tier2: {}, tier3: {} },
            },
          ],
        },
      },
    },
  },
};

test("the fixture really does carry indeterminates", () => {
  // Guards the guard: if the marker stopped being honoured, every assertion
  // below would pass vacuously against a run with nothing indeterminate in it.
  assert.equal(scored.indeterminate, 4);
  assert.equal(scored.count, 10);
  assert.deepEqual(axesOf(scored), { divergence: null, coverage: null });
});

test("the scored snapshot withholds both figures", () => {
  assert.equal(scored.divergenceValue, null);
  assert.equal(scored.coverageValue, null);
  assert.equal(scored.divergence, "-");
  assert.equal(scored.coverage, "-");
});

test("the region entry and its tiers withhold the figure, not just the headline", () => {
  const model = buildSummaryModel(summaryDoc);
  const region = model.targets.alpha.regions.find((r) => r.region === REGION);

  assert.equal(region.divergenceValue, null, "region divergence must be withheld");
  assert.equal(region.divergence, "-");
  // The tier under it has to agree, or the drilldown contradicts the row above.
  assert.equal(region.tiers.tier1.divergenceValue, null, "tier divergence must be withheld");
  assert.equal(region.tiers.tier1.coverageValue, null, "tier coverage must be withheld");
  assert.equal(region.tiers.tier1.divergence, "-");
});

test("the standings row carries no figures for a refused run", () => {
  const row = buildModel([snapshot]).latest.standings.find((r) => r.slug === "alpha");

  assert.equal(row.divergenceValue, null, "a refused run must not publish divergence");
  assert.equal(row.coverageValue, null, "a refused run must not publish coverage");
  assert.equal(row.divergence, "-");
  assert.equal(row.coverage, "-");
});

test("the overlay cannot reintroduce a figure the scorer withheld", () => {
  // enrichSnapshot rewrites a row from its headline region and derived its own
  // divergence while doing so, so the withheld figure came back as 20.0% - a
  // number for a run where four of ten observations failed to happen.
  const row = buildModel([snapshot], overlay).latest.standings.find((r) => r.slug === "alpha");

  assert.equal(row.hasRegions, true, "the overlay must have been applied at all");
  assert.equal(row.divergenceValue, null, "the overlay must not recompute a withheld figure");
  assert.equal(row.coverageValue, null);
});

test("a not-scored row keeps the counts its lists are read from, not another region's", () => {
  // The page lists a not-scored run's failures and unanswered tests from the
  // results file. A region that answered one of those failures differently
  // must not move the counts above the lists, or the sentence says 2 failed
  // over a list of 3.
  const elsewhere = structuredClone(overlay);
  const entry = elsewhere.byRunDate["2026-08-01"].targets.alpha;
  entry.regions = [{ ...entry.regions[0], region: "us-east-1", passed: 5, failed: 1 }];
  entry.suiteHeadlineRegion = "us-east-1";
  const row = buildModel([snapshot], elsewhere).latest.standings.find((r) => r.slug === "alpha");

  assert.equal(row.hasRegions, true, "the overlay must have been applied at all");
  assert.deepEqual(
    [row.passed, row.failed, row.skipped, row.indeterminate, row.count],
    [scored.passed, scored.failed, scored.skipped, scored.indeterminate, scored.count],
  );
  assert.deepEqual(row.tiers, scored.tiers, "the tiers stay on the same basis as the counts");
  assert.equal(row.headlineRegion, null, "no region earned a headline the row does not have");
});

test("a refused run in a target's timeline carries no figure either", () => {
  // The per-target series and the run-over-run movement both read their figures
  // through figuresOf, which derived its own pair. A clean run followed by a
  // refused one is the shape that exercises it.
  const clean = {
    ...scoreEmulator("alpha", {
      startTime: Date.parse("2026-07-01T10:00:00Z"),
      testResults: [
        { name: "/x/tests/tier1/a.test.ts", assertionResults: [...P(8), ...F(2)] },
        { name: "/x/tests/tier2/b.test.ts", assertionResults: [] },
        { name: "/x/tests/tier3/c.test.ts", assertionResults: [] },
      ],
    }, "1.0.0"),
    startTime: Date.parse("2026-07-01T10:00:00Z"),
    sha: "clean1",
  };

  const model = buildModel([clean, snapshot]);
  const series = model.perTarget.alpha.series;
  assert.equal(series.length, 2, "both runs must be in the timeline");
  assert.equal(series[0].divergenceValue, 20, "the clean run keeps its figure");
  assert.equal(series[1].divergenceValue, null, "the refused run must publish none");
  assert.equal(series[1].divergence, "-");
  assert.equal(series[1].coverageValue, null, "coverage is withheld on the same terms");
  assert.equal(series[1].coverage, "-");
  // Movement between a measured run and an unmeasured one is not a delta.
  assert.equal(series[1].movement.delta, null, "there is no movement to or from a non-figure");
});

test("the JSON endpoints withhold the same figures the pages do", () => {
  // The endpoints are the surface an agent reads. A consumer recomputing a
  // grade from the envelope must not be handed a number the board declined to
  // stand behind.
  const conformance = buildModel([snapshot], overlay);
  const site = { url: "https://example.test", description: "d", dataAttribution: "a" };

  const latest = buildLatest(conformance, site);
  const inLatest = latest.targets.find((t) => t.slug === "alpha");
  assert.equal(inLatest.divergence.value, null, "latest.json must withhold divergence");
  assert.equal(inLatest.coverage.value, null, "latest.json must withhold coverage");

  const runs = buildRuns(conformance, site);
  const inRuns = runs.runs[0].targets.find((t) => t.slug === "alpha");
  assert.equal(inRuns.divergence.value, null, "runs.json must withhold divergence");
  assert.equal(inRuns.coverage.value, null, "runs.json must withhold coverage");
});

// ── A not-scored row end to end, from the suite's own summary ───────────────
//
// The fixture above hand-writes the summary with a null region rate, but the
// suite does not publish one: a region's `rate` is correctness over what was
// observed, so a run with one indeterminate still carries a rate in every
// region, and the cohort label the board prints is built from those rates.
// This builds the summary with the suite's buildSummary instead, so the row
// reaching the board is the one a real not-scored run produces.

const unscoredDoc = (startTime) => ({
  startTime,
  testResults: [
    { name: "/x/tests/tier1/a.test.ts", assertionResults: [...P(8), ...F(1), ...I(1)] },
    { name: "/x/tests/tier2/b.test.ts", assertionResults: [] },
    { name: "/x/tests/tier3/c.test.ts", assertionResults: [] },
  ],
});
const letteredDoc = (startTime) => ({
  startTime,
  testResults: [
    { name: "/x/tests/tier1/a.test.ts", assertionResults: [...P(9), ...F(1)] },
    { name: "/x/tests/tier2/b.test.ts", assertionResults: [] },
    { name: "/x/tests/tier3/c.test.ts", assertionResults: [] },
  ],
});

const RUN = "2026-09-01";
const RUN_START = Date.parse(`${RUN}T10:00:00Z`);
// Named to sort first by name, so a row placed last is the grade order at work.
const FIXTURE = { lettered: "zz-lettered-fixture", unscored: "aa-unscored-fixture" };

function endToEnd() {
  const docs = { [FIXTURE.lettered]: letteredDoc(RUN_START), [FIXTURE.unscored]: unscoredDoc(RUN_START) };
  const health = { regions: { [REGION]: { lastResolved: RUN, consecutiveUnresolved: 0 }, "us-east-1": { lastResolved: RUN, consecutiveUnresolved: 0 } } };
  const summary = buildSummary(
    [
      // The ground truth dates the sweep the overlay is keyed on.
      { slug: "dynamodb", raw: letteredDoc(RUN_START), sidecar: null, version: "live", runDate: RUN },
      ...Object.entries(docs).map(([slug, raw]) => ({ slug, raw, sidecar: null, version: "1.0.0", runDate: RUN })),
    ],
    { registry: { splits: [] }, health, suiteTests: testIdentities(letteredDoc(RUN_START)) },
  );
  const overlay = { available: true, ...assemble([{ raw: summary, sha: "fixture" }]) };
  const snapshots = Object.entries(docs).map(([slug, raw]) => ({ ...scoreEmulator(slug, raw, "1.0.0"), startTime: RUN_START, sha: "fixture" }));
  return { summary, conformance: buildModel(snapshots, overlay) };
}

test("the suite publishes a region rate for a not-scored run", () => {
  // Guards the premise of the tests below: if this ever went null, the cohort
  // label would be empty for the suite's reasons rather than the board's.
  const { summary } = endToEnd();
  const t = summary.targets[FIXTURE.unscored];
  assert.equal(t.regions[REGION].indeterminate, 1);
  assert.notEqual(t.regions[REGION].rate, null);
});

test("a not-scored row reads as not scored, with no figures and no region cohort", () => {
  const { conformance } = endToEnd();
  const row = conformance.latest.standings.find((r) => r.slug === FIXTURE.unscored);
  assert.equal(row.hasRegions, true, "the overlay must have been applied at all");
  assert.equal(gradeForRow(row).letter, null);
  assert.equal(gradeForRow(row).qualifier, "not scored");
  assert.equal(gradeLineOf(row), "not scored");
  // A cohort is the regions a scored headline matched. "not scored in 2 of 2
  // regions" reads as though it were scored somewhere.
  assert.equal(regionClauseOf(row), "", "a not-scored row has no region cohort to state");
  assert.equal(row.divergence, "-");
  assert.equal(row.coverage, "-");
});

test("a not-scored row sorts below every lettered row, whatever its name", () => {
  const { conformance } = endToEnd();
  const order = conformance.latest.standings.filter((r) => !r.synthesised).map((r) => r.slug);
  assert.deepEqual(order, [FIXTURE.lettered, FIXTURE.unscored]);
});

test("the JSON endpoints carry the not-scored grade and no NaN", () => {
  const { conformance } = endToEnd();
  const site = { url: "https://example.test", description: "d", dataAttribution: "a" };
  const latest = buildLatest(conformance, site);
  const inLatest = latest.targets.find((t) => t.slug === FIXTURE.unscored);
  assert.equal(inLatest.grade.letter, null);
  assert.equal(inLatest.grade.qualifier, "not scored");
  const runs = buildRuns(conformance, site);
  const inRuns = runs.runs[0].targets.find((t) => t.slug === FIXTURE.unscored);
  // No cohort either, on any field a consumer could read one from: the cohort
  // is the regions a scored headline matched, and there is no scored headline.
  for (const region of [inLatest.region, inRuns.region]) {
    assert.equal(region.kind, "none");
    assert.equal(region.headline, null);
    assert.deepEqual(region.cohort, []);
    assert.equal(region.cohortSize, 0);
  }
  assert.ok(inLatest.regions.length > 0, "the per-region detail is still published");
  assert.ok(inLatest.regions.every((r) => !r.inCohort), "no region is in a cohort");
  // The lettered row beside it keeps its cohort.
  const lettered = latest.targets.find((t) => t.slug === FIXTURE.lettered);
  assert.ok(lettered.region.cohortSize > 0);
  assert.ok(lettered.region.headline);
  const json = JSON.stringify([latest, runs]);
  assert.doesNotMatch(json, /NaN/);
});
