import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreEmulator } from "./scoring.mjs";
import { buildModel, assignRunIds, targetRunsOf, leanForFallback, gradedUnderCriteria } from "./history.mjs";
import { GRADING_CRITERIA_EFFECTIVE } from "./scoring.mjs";
import { SCENARIOS } from "../fixtures/not-scored-models.mjs";
import { buildRuns } from "./dataset.mjs";

test("targetRunsOf pairs each target with the runs that measured it", () => {
  const model = {
    targets: ["dynoxide", "dynalite"],
    perTarget: {
      dynoxide: { series: [{ runId: "2026-07-01", date: "2026-07-01" }, { runId: "2026-07-20", date: "2026-07-20" }] },
      dynalite: { series: [{ runId: "2026-07-20", date: "2026-07-20" }] },
    },
  };
  assert.deepEqual(targetRunsOf(model), [
    { slug: "dynoxide", runId: "2026-07-01", date: "2026-07-01" },
    { slug: "dynoxide", runId: "2026-07-20", date: "2026-07-20" },
    { slug: "dynalite", runId: "2026-07-20", date: "2026-07-20" },
  ]);
});

test("targetRunsOf degrades to an empty list rather than throwing", () => {
  // A committed fallback predating per-(target, run) pages has no targetRuns.
  // Missing pagination data fails the entire build, not just those pages, so
  // this has to be derivable from any model shape.
  assert.deepEqual(targetRunsOf(undefined), []);
  assert.deepEqual(targetRunsOf({}), []);
  assert.deepEqual(targetRunsOf({ targets: ["x"], perTarget: {} }), []);
  assert.deepEqual(targetRunsOf({ targets: ["x"], perTarget: { x: {} } }), []);
});

// Craft a Vitest-shaped raw whose tier tallies produce a known total, then
// score it the same way the real pipeline does, so test snapshots share the
// exact shape history.mjs consumes in production.
function raw(startTimeISO, { t1 = [], t2 = [], t3 = [] }) {
  return {
    startTime: Date.parse(startTimeISO),
    testResults: [
      { name: "/x/tier1/a.test.ts", assertionResults: t1.map((status) => ({ status })) },
      { name: "/x/tier2/b.test.ts", assertionResults: t2.map((status) => ({ status })) },
      { name: "/x/tier3/c.test.ts", assertionResults: t3.map((status) => ({ status })) },
    ],
  };
}

const P = (n) => Array(n).fill("passed");
const F = (n) => Array(n).fill("failed");

// A snapshot is a scored row plus its run identity (startTime epoch) and sha.
function snap(slug, startTimeISO, sha, tiers, version = "-") {
  const scored = scoreEmulator(slug, raw(startTimeISO, tiers), version);
  return { ...scored, startTime: Date.parse(startTimeISO), sha };
}

// Whole-tier-1 snapshot at a chosen pass rate (passed of 100), keeps totals tidy.
const at = (slug, iso, sha, passed, version = "-") =>
  snap(slug, iso, sha, { t1: [...P(passed), ...F(100 - passed)] }, version);

const rowFor = (run, slug) => run.standings.find((r) => r.slug === slug);

test("groups snapshots into runs by startTime date, newest first", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a1", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b2", 100),
    at("dynoxide", "2026-01-03T10:00:00Z", "c3", 90),
  ]);
  assert.deepEqual(
    model.runs.map((r) => r.date),
    ["2026-01-03", "2026-01-02", "2026-01-01"],
  );
  assert.equal(model.latest.date, "2026-01-03");
});

test("a single commit touching a subset, and one date carrying different startTimes, group by date not commit", () => {
  // Same date, 12h apart, different shas (the 90-min intra-run spread case).
  const model = buildModel([
    at("dynoxide", "2026-02-01T08:00:00Z", "aaa", 100),
    at("localstack", "2026-02-01T20:00:00Z", "bbb", 88),
    at("floci", "2026-02-01T09:30:00Z", "aaa", 60),
  ]);
  assert.equal(model.runs.length, 1);
  assert.equal(model.runs[0].date, "2026-02-01");
  assert.equal(model.runs[0].emulatorCount, 3);
});

test("the latest snapshot of a target on a date wins; counts are not duplicated", () => {
  // The 2026-04-27 case: floci added at 13:30, re-run at 21:30 the same day.
  const model = buildModel([
    at("floci", "2026-04-27T13:30:00Z", "early", 60),
    at("floci", "2026-04-27T21:30:00Z", "late", 75),
  ]);
  assert.equal(model.runs.length, 1);
  const floci = rowFor(model.runs[0], "floci");
  assert.equal(floci.totalValue, 75); // the later run won
  assert.equal(model.runs[0].emulatorCount, 1); // not duplicated
});

test("movement: diverging less is an improvement, diverging more a regression", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 92), // +12.0pp
    at("dynoxide", "2026-01-03T10:00:00Z", "c", 92), // unchanged
    at("dynoxide", "2026-01-04T10:00:00Z", "d", 70), // -22.0pp
  ]);
  const move = (date) => rowFor(model.runs.find((r) => r.date === date), "dynoxide").movement;
  // 20 fails of 100 -> 8: divergence fell 12 points, which is an improvement.
  // The old states were named for which way the number went, and reusing them
  // would have painted this red once the published figure inverted.
  assert.equal(move("2026-01-02").state, "improved");
  assert.equal(move("2026-01-02").delta, -12);
  assert.equal(move("2026-01-02").deltaLabel, "-12.0pp");
  // The rendered reading drops the sign: the arrow already carries direction,
  // and the word is the only cue that does not depend on colour.
  assert.equal(move("2026-01-02").deltaReading, "12.0pp less");
  assert.equal(move("2026-01-03").state, "flat");
  // 8 fails -> 30: diverging more, and signed as published.
  assert.equal(move("2026-01-04").state, "regressed");
  assert.equal(move("2026-01-04").deltaLabel, "+22.0pp");
  assert.equal(move("2026-01-04").deltaReading, "22.0pp more");
});

test("movement: a letter change travels with the delta; an in-band move carries none", () => {
  // Dated on and after the criteria: a transition between two runs that never
  // carried a letter is withheld, which the next test covers.
  const d = (n) => {
    const t = new Date(`${GRADING_CRITERIA_EFFECTIVE}T10:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString();
  };
  const model = buildModel([
    at("dynoxide", d(0), "a", 80), // 20% diverges: C
    at("dynoxide", d(1), "b", 92), // 8%: crosses into B
    at("dynoxide", d(2), "c", 90), // 10%: still B
    at("dynoxide", d(3), "d", 100), // 0% at full coverage: A+
  ]);
  const on = (n) => d(n).slice(0, 10);
  const move = (date) => rowFor(model.runs.find((r) => r.date === date), "dynoxide").movement;
  assert.deepEqual(move(on(1)).grade, { from: "C", to: "B", label: "grade C to B" });
  // A move inside a band changes no letter, so nothing is attached: the
  // absence of a grade shift is itself a statement.
  assert.equal(move(on(2)).grade, undefined);
  assert.deepEqual(move(on(3)).grade, { from: "B", to: "A+", label: "grade B to A+" });
  // The per-target series must agree with the standings about the same run.
  const series = model.perTarget.dynoxide.series;
  assert.deepEqual(series[1].movement.grade, { from: "C", to: "B", label: "grade C to B" });
});

test("a run predating the criteria reports no letter transition", () => {
  // Stronger than withholding the letter: a transition asserts two letters
  // existed and one became the other, and neither did.
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 92),
  ]);
  const mv = rowFor(model.runs.find((r) => r.date === "2026-01-02"), "dynoxide").movement;
  assert.equal(mv.grade, undefined);
  // The delta itself still publishes; it is a figure, not a claim about a letter.
  assert.ok(mv.deltaReading);
});

test("movement: a target absent from earlier runs is flagged new", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 90),
    at("floci", "2026-01-02T10:00:00Z", "b", 55), // first appears in run 2
  ]);
  assert.equal(rowFor(model.runs.find((r) => r.date === "2026-01-02"), "floci").movement.state, "new");
  assert.equal(model.movement.floci.state, "new");
});

test("carry-forward: a target not re-tested in a later run is carried, not dropped or moved", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynalite", "2026-01-01T10:00:00Z", "a", 50),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 95), // only dynoxide re-tested in run 2
  ]);
  const run2 = model.runs.find((r) => r.date === "2026-01-02");
  const dynalite = rowFor(run2, "dynalite");
  assert.ok(dynalite, "carried-forward target still present in the later run");
  assert.equal(dynalite.carried, true);
  assert.equal(dynalite.totalValue, 50); // its last measured value
  assert.equal(dynalite.movement.state, "carried");
  assert.equal(dynalite.movement.arrow, "–");
});

test("every run carries a synthesised DynamoDB baseline at 100% across that run's suite size", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80), // 100 tests
  ]);
  const dynamodb = rowFor(model.runs[0], "dynamodb");
  assert.ok(dynamodb);
  assert.equal(dynamodb.total, "100.0%");
  assert.equal(dynamodb.passed, 100); // suite size of the run
  assert.equal(dynamodb.version, "live (AWS)");
  assert.equal(model.runs[0].standings[0].slug, "dynamodb"); // sorted first
});

test("standings sort by total descending with DynamoDB first", () => {
  const model = buildModel([
    at("dynalite", "2026-01-01T10:00:00Z", "a", 50),
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 95),
    at("floci", "2026-01-01T10:00:00Z", "a", 70),
  ]);
  assert.deepEqual(
    model.runs[0].standings.map((r) => r.slug),
    ["dynamodb", "dynoxide", "floci", "dynalite"],
  );
});

test("single run: every target is new and the build still succeeds", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("floci", "2026-01-01T10:00:00Z", "a", 55),
  ]);
  assert.equal(model.runs.length, 1);
  assert.equal(model.movement.dynoxide.state, "new");
  assert.equal(model.perTarget.dynoxide.series.length, 1);
});

test("per-target series holds distinct re-tests oldest-first; gaps don't crash", () => {
  const model = buildModel([
    at("floci", "2026-01-01T10:00:00Z", "a", 60),
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 90), // floci absent this run
    at("floci", "2026-01-03T10:00:00Z", "c", 70), // floci reappears, no crash
  ]);
  const floci = model.perTarget.floci;
  assert.deepEqual(floci.series.map((p) => p.date), ["2026-01-01", "2026-01-03"]);
  assert.equal(floci.series[1].movement.state, "improved"); // 40 fails -> 30
  assert.equal(floci.series[0].movement.state, "new");
});

test("DynamoDB per-target series is a flat 100% baseline, not a trend", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 90),
  ]);
  const dynamodb = model.perTarget.dynamodb;
  assert.equal(dynamodb.baseline, true);
  assert.ok(dynamodb.series.every((p) => p.totalValue === 100));
});

test("an all-skipped target has a null total, sorts last, and doesn't break movement or movers", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 90),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 80), // a real mover
    snap("ghost", "2026-01-02T10:00:00Z", "b", { t1: Array(10).fill("skipped") }), // implements nothing
  ]);
  const run2 = model.runs.find((r) => r.date === "2026-01-02");
  const ghost = rowFor(run2, "ghost");
  assert.equal(ghost.totalValue, null);
  assert.equal(ghost.total, "-");
  // sorts last (a no-score target trails the scored ones)
  assert.equal(run2.standings[run2.standings.length - 1].slug, "ghost");
  // movers is computed without NaN and never includes the null-total target
  assert.ok(model.movers.every((m) => m.slug !== "ghost"));
});

test("movers lists the latest run's biggest changes, ordered by size", () => {
  const m = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 90),
    at("floci", "2026-01-01T10:00:00Z", "a", 50),
    at("dynalite", "2026-01-01T10:00:00Z", "a", 90),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 85), // -5
    at("floci", "2026-01-02T10:00:00Z", "b", 62), // +12
    at("dynalite", "2026-01-02T10:00:00Z", "b", 89), // -1
  ]);
  assert.deepEqual(m.movers.map((x) => x.slug), ["floci", "dynoxide", "dynalite"]);
  assert.equal(m.movers[0].state, "improved");
  assert.equal(m.movers[0].delta, -12);
});

test("each run records its suite growth vs the previous run", () => {
  const model = buildModel([
    snap("dynoxide", "2026-01-01T10:00:00Z", "a", { t1: P(100) }), // 100 tests
    snap("dynoxide", "2026-01-02T10:00:00Z", "b", { t1: P(120) }), // grew to 120
    snap("dynoxide", "2026-01-03T10:00:00Z", "c", { t1: P(120) }), // unchanged
  ]);
  const r = (date) => model.runs.find((x) => x.date === date);
  // First run: no previous run to compare against.
  assert.equal(r("2026-01-01").prevSuiteSize, null);
  assert.equal(r("2026-01-01").suiteGrowth, 0);
  assert.equal(r("2026-01-01").suiteGrew, false);
  // Grew 100 -> 120.
  assert.equal(r("2026-01-02").prevSuiteSize, 100);
  assert.equal(r("2026-01-02").suiteGrowth, 20);
  assert.equal(r("2026-01-02").suiteGrew, true);
  // Flat run: no growth.
  assert.equal(r("2026-01-03").suiteGrowth, 0);
  assert.equal(r("2026-01-03").suiteGrew, false);
});

test("assignRunIds: distinct runs sharing a date get sha-disambiguated ids", () => {
  const ids = assignRunIds([
    { date: "2026-05-23", sha: "abcdef1234" },
    { date: "2026-05-23", sha: "999fff8888" },
    { date: "2026-05-24", sha: "1234567890" },
  ]);
  assert.deepEqual(ids, ["2026-05-23-abcdef1", "2026-05-23-999fff8", "2026-05-24"]);
});

// The per-region overlay. Without a summary the model is the eu-west-2-only
// result, byte-for-byte; with one, the best-match rate drives the headline.
test("without a summary overlay the model is unchanged (characterisation)", () => {
  const snaps = [
    at("dynoxide", "2026-01-01T10:00:00Z", "a1", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b2", 90),
    at("localstack", "2026-01-02T11:00:00Z", "b2", 70),
  ];
  const base = buildModel(snaps);
  assert.deepEqual(buildModel(snaps, null), base);
  assert.deepEqual(buildModel(snaps, { available: false }), base);
});

test("with a summary overlay, best-match drives total, sort and movement", () => {
  const snaps = [
    at("dynoxide", "2026-01-01T10:00:00Z", "a1", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b2", 80),
  ];
  const label = { kind: "beats-pinned", regions: ["us-east-1"], rate: 92, others: 0, pinned: "eu-west-2", pinnedRate: 80 };
  // The shape summary.mjs's targetOf really produces: each region entry carries
  // its own counts and tier split, and the row is built from the headline
  // region's entry in full rather than from the scalars alone. The port scored
  // 80 (20 fails of 100); us-east-1 scores 92 (8 fails of 100).
  const region = {
    region: "us-east-1",
    rate: 92,
    passed: 92,
    failed: 8,
    skipped: 0,
    indeterminate: 0,
    count: 100,
    tiers: {
      tier1: { passed: 92, failed: 8, skipped: 0, indeterminate: 0, total: 100, divergence: "8.0%", divergenceValue: 8, coverage: "100.0%", coverageValue: 100, correctness: "92.0%", correctnessValue: 92 },
      tier2: { passed: 0, failed: 0, skipped: 0, indeterminate: 0, total: 0, divergence: "-", divergenceValue: null, coverage: "-", coverageValue: null, correctness: "-", correctnessValue: null },
      tier3: { passed: 0, failed: 0, skipped: 0, indeterminate: 0, total: 0, divergence: "-", divergenceValue: null, coverage: "-", coverageValue: null, correctness: "-", correctnessValue: null },
    },
  };
  const target = {
    rate: 92,
    label,
    suiteHeadlineRegion: "us-east-1",
    regions: [region],
    divergenceBest: 8,
    divergenceWorst: 8,
    runDate: "2026-01-02",
  };
  const summary = {
    available: true,
    latest: { targets: { dynoxide: target } },
    byRunDate: { "2026-01-02": { targets: { dynoxide: target } } },
  };
  const model = buildModel(snaps, summary);
  const row = rowFor(model.latest, "dynoxide");
  assert.equal(row.total, "92.0%");
  assert.equal(row.totalValue, 92);
  assert.equal(row.portTotalValue, 80, "keeps the eu-west-2 score");
  assert.equal(row.regionLabel.kind, "beats-pinned");
  // 20 fails of 100 in the port, 8 in the best-matching region: an improvement
  // only visible if movement reads the overlay rather than the raw counts.
  assert.equal(row.movement.state, "improved", "movement follows the best-match number");
  assert.equal(model.perTarget.dynoxide.hasRegions, true);
  assert.equal(model.perTarget.dynoxide.regionLabel.kind, "beats-pinned");
  // The earlier run has no summary, so it stays on its eu-west-2 score.
  const earlier = model.runs.find((r) => r.date === "2026-01-01");
  assert.equal(rowFor(earlier, "dynoxide").total, "80.0%");

  // The row is one region's measurement throughout: its counts reproduce its
  // published divergence, and its tiers decompose it. Overlaying the headline
  // scalar while leaving the counts on the port's basis is what made
  // `failed / count` disagree with the published figure in public.
  assert.equal(row.headlineRegion, "us-east-1");
  assert.equal(row.failed, 8);
  assert.equal(row.count, 100);
  assert.equal(row.divergence, "8.0%");
  assert.ok(Math.abs(row.failed / row.count * 100 - row.divergenceValue) < 1e-9,
    "counts must reproduce the published divergence");
  assert.equal(row.tiers.tier1.divergence, "8.0%");
});

// The join. `byRunDate` is keyed on the sweep date while each target entry
// carries its own run date, and a summary committed after a later target run
// holds that later run's numbers under the earlier key. Applying it put one
// run's figures on another's page for every target.
test("an overlay entry describing a different run is not applied", () => {
  const snaps = [at("dynoxide", "2026-01-01T10:00:00Z", "a1", 80), at("dynoxide", "2026-01-02T10:00:00Z", "b2", 80)];
  const stale = {
    rate: 99,
    label: { kind: "all", regions: ["us-east-1"], rate: 99, others: 0, observed: 1 },
    suiteHeadlineRegion: "us-east-1",
    regions: [{ region: "us-east-1", rate: 99, passed: 99, failed: 1, skipped: 0, indeterminate: 0, count: 100, tiers: {} }],
    divergenceBest: 1,
    divergenceWorst: 1,
    // Measured on a later run than the snapshot this would be applied to.
    runDate: "2026-01-09",
  };
  const model = buildModel(snaps, {
    available: true,
    latest: { targets: { dynoxide: stale } },
    byRunDate: { "2026-01-02": { targets: { dynoxide: stale } } },
  });
  const row = rowFor(model.latest, "dynoxide");
  assert.equal(row.hasRegions, undefined, "no overlay applied");
  assert.equal(row.failed, 20, "the row keeps its own measured counts");
  assert.equal(row.divergence, "20.0%", "and its own figure, not the later run's 1.0%");
});

test("an overlay entry without a run date is never applied, even under the matching sweep key", () => {
  // Every committed sweep stamps runDate on its entries; an undated entry is
  // a malformed record, and accepting it would re-admit the cross-run graft
  // the guarded join removes.
  const snaps = [at("dynoxide", "2026-01-02T10:00:00Z", "b2", 80)];
  const undated = {
    rate: 99,
    label: { kind: "all", regions: ["us-east-1"], rate: 99, others: 0, observed: 1 },
    suiteHeadlineRegion: "us-east-1",
    regions: [{ region: "us-east-1", rate: 99, passed: 99, failed: 1, skipped: 0, indeterminate: 0, count: 100, tiers: {} }],
    divergenceBest: 1,
    divergenceWorst: 1,
    // No runDate.
  };
  const model = buildModel(snaps, {
    available: true,
    latest: { targets: { dynoxide: undated } },
    byRunDate: { "2026-01-02": { targets: { dynoxide: undated } } },
  });
  const row = rowFor(model.latest, "dynoxide");
  assert.equal(row.hasRegions, undefined, "no overlay applied");
  assert.equal(row.divergence, "20.0%", "the row keeps its own measured figure");
  // The per-target drilldown holds the same line: no regions from an entry
  // that cannot prove which run it describes.
  assert.ok(!model.perTarget.dynoxide.hasRegions, "drilldown stays unenriched too");
});

test("the headline region falls back to the least-diverging entry when the suite's pick is absent", () => {
  const snaps = [at("dynoxide", "2026-01-02T10:00:00Z", "b2", 80)];
  const entry = {
    rate: 92,
    label: { kind: "beats-pinned", regions: ["us-east-1"], rate: 92, others: 0, observed: 2 },
    // Names a region the entry does not carry, so the join must fall back to
    // the least-diverging region rather than dropping the overlay.
    suiteHeadlineRegion: "ap-south-1",
    regions: [
      { region: "eu-west-2", rate: 90, divergenceValue: 10, passed: 90, failed: 10, skipped: 0, indeterminate: 0, count: 100, tiers: {} },
      { region: "us-east-1", rate: 92, divergenceValue: 8, passed: 92, failed: 8, skipped: 0, indeterminate: 0, count: 100, tiers: {} },
    ],
    divergenceBest: 8,
    divergenceWorst: 10,
    runDate: "2026-01-02",
  };
  const model = buildModel(snaps, {
    available: true,
    latest: { targets: { dynoxide: entry } },
    byRunDate: { "2026-01-02": { targets: { dynoxide: entry } } },
  });
  const row = rowFor(model.latest, "dynoxide");
  assert.equal(row.headlineRegion, "us-east-1", "least-diverging region wins the fallback");
  assert.equal(row.divergence, "8.0%");
});

test("movement to or from an unscored run carries no grade shift", () => {
  // A target that skipped everything has no divergence and so no letter; a
  // movement bordering that run must not invent a grade transition.
  const allSkipped = (slug, iso, sha) =>
    snap(slug, iso, sha, { t1: Array(100).fill("skipped") });
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 92),
    allSkipped("dynoxide", "2026-01-02T10:00:00Z", "b"),
  ]);
  const move = rowFor(model.runs.find((r) => r.date === "2026-01-02"), "dynoxide").movement;
  assert.equal(move.state, "flat", "no divergence on one side means no delta");
  assert.equal(move.grade, undefined, "and no letter shift either");
});

// The converse of the stale-entry guard above: an entry that DOES describe
// this exact run must be applied even when it is filed under a different
// sweep's key. The live case is a build tested between sweeps - run date the
// 24th, sweeps keyed the 26th and 29th - whose row silently lost its region
// enrichment because the same-key lookup missed.
test("an overlay entry filed under a later sweep key still applies when it names this run", () => {
  const snaps = [at("dynoxide", "2026-01-02T10:00:00Z", "b2", 100)];
  const entry = {
    rate: 100,
    label: { kind: "pinned-plus", regions: ["eu-west-2", "us-east-1"], rate: 100, others: 1, observed: 3 },
    suiteHeadlineRegion: "eu-west-2",
    regions: [{ region: "eu-west-2", rate: 100, passed: 100, failed: 0, skipped: 0, indeterminate: 0, count: 100, tiers: {} }],
    divergenceBest: 0,
    divergenceWorst: 0.3,
    // Names the snapshot's run exactly, but is filed under the 05th's sweep.
    runDate: "2026-01-02",
  };
  const model = buildModel(snaps, {
    available: true,
    latest: { targets: { dynoxide: entry } },
    byRunDate: { "2026-01-05": { targets: { dynoxide: entry } } },
  });
  const row = rowFor(model.latest, "dynoxide");
  assert.equal(row.hasRegions, true, "the matching-run entry is applied");
  assert.equal(row.regionLabel.kind, "pinned-plus");
  assert.equal(row.divergenceWorstLabel, "0.3%", "the worst-region range reaches the row");
});

test("targetRunsOf excludes the synthesised baseline", () => {
  // DynamoDB's series is one synthetic point per run, never a measurement, so a
  // page per date would claim real DynamoDB had been tested and scored.
  const model = {
    targets: ["dynamodb", "dynoxide"],
    perTarget: {
      dynamodb: { baseline: true, series: [{ runId: "2026-07-20", date: "2026-07-20" }] },
      dynoxide: { baseline: false, series: [{ runId: "2026-07-20", date: "2026-07-20" }] },
    },
  };
  assert.deepEqual(targetRunsOf(model), [{ slug: "dynoxide", runId: "2026-07-20", date: "2026-07-20" }]);
});

// A model shaped like buildModel's output, with findings on all four references
// that carry them, so the strip can be checked reference by reference.
function modelWithFindings() {
  const F = (id) => ({ id, fullName: id, file: `tests/tier1/x.test.ts`, line: 1 });
  const row = (slug, findings) => ({ slug, total: "90%", findings });
  return {
    runs: [
      { id: "2026-07-20", standings: [row("dynoxide", [F("newA"), F("newB")])] },
      { id: "2026-07-06", standings: [row("dynoxide", [F("oldA")])] },
    ],
    latest: { id: "2026-07-20", standings: [row("dynoxide", [F("newA"), F("newB")])] },
    perTarget: {
      dynoxide: {
        findings: [F("newA"), F("newB")],
        current: { slug: "dynoxide", findings: [F("newA"), F("newB")] },
        series: [
          { runId: "2026-07-06", findings: [F("oldA")] },
          { runId: "2026-07-20", findings: [F("newA"), F("newB")] },
        ],
      },
    },
  };
}

const findingCount = (arr) => (arr ?? []).length;

test("leanForFallback keeps findings only where the site renders them", () => {
  const lean = leanForFallback(modelWithFindings());
  // Kept: the target page's own findings, and the newest series point.
  assert.equal(findingCount(lean.perTarget.dynoxide.findings), 2);
  const series = lean.perTarget.dynoxide.series;
  assert.equal(findingCount(series[series.length - 1].findings), 2, "newest series point keeps findings");
  // Dropped everywhere else: the copies nothing renders from.
  assert.equal(findingCount(series[0].findings), 0, "older series points are thinned");
  assert.equal(findingCount(lean.perTarget.dynoxide.current.findings), 0, "current is a copy nothing reads");
  assert.equal(findingCount(lean.runs[0].standings[0].findings), 0, "run standings only feed the digest");
  assert.equal(findingCount(lean.latest.standings[0].findings), 0, "latest standings likewise");
});

test("leanForFallback leaves everything but findings intact", () => {
  const lean = leanForFallback(modelWithFindings());
  assert.equal(lean.runs[0].standings[0].total, "90%");
  assert.equal(lean.runs[0].standings[0].slug, "dynoxide");
  assert.equal(lean.latest.id, "2026-07-20");
  assert.equal(lean.perTarget.dynoxide.series.length, 2);
});

test("leanForFallback degrades on absent sections rather than throwing", () => {
  assert.doesNotThrow(() => leanForFallback({}));
  assert.doesNotThrow(() => leanForFallback({ runs: [], perTarget: {}, latest: null }));
});

// ── The feed stops grading history ──────────────────────────────────────────
//
// The one artefact designed to be archived by third parties, whose entries keep
// their original <updated> so a subscriber never re-notifies. A letter attached
// to a run that predates the criteria restates that run silently.

test("a run measured before the criteria took effect carries no letter", () => {
  const before = new Date(Date.parse(`${GRADING_CRITERIA_EFFECTIVE}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const model = buildModel([at("dynoxide", `${before}T10:00:00Z`, "aaa", 90)]);
  assert.equal(model.runs[0].headline.graded, false);
});

test("a run measured on the day the criteria took effect carries one", () => {
  const model = buildModel([at("dynoxide", `${GRADING_CRITERIA_EFFECTIVE}T10:00:00Z`, "bbb", 90)]);
  assert.equal(model.runs[0].headline.graded, true);
  assert.ok(model.runs[0].headline.topGrade, "a graded run still derives its letter");
});

test("a run measured after it carries one", () => {
  const after = new Date(Date.parse(`${GRADING_CRITERIA_EFFECTIVE}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  const model = buildModel([at("dynoxide", `${after}T10:00:00Z`, "ccc", 90)]);
  assert.equal(model.runs[0].headline.graded, true);
});

test("the grading predicate is the criteria date, not the retired-metric flag", () => {
  // These mark different sets. A run scored on divergence but published before
  // the letter existed passes scoredOnCorrectness and would still be graded.
  assert.equal(gradedUnderCriteria("2026-07-29"), false);
  assert.equal(gradedUnderCriteria(GRADING_CRITERIA_EFFECTIVE), true);
  assert.equal(gradedUnderCriteria(undefined), false);
  assert.equal(gradedUnderCriteria(null), false);
});

test("withholding the letter leaves the entry's timestamp alone", () => {
  // The whole reason the retro-grade is a problem: <updated> does not move, so
  // a changed summary is a silent rewrite. The fix must not move it either.
  const iso = "2026-07-20T10:00:00Z";
  const model = buildModel([at("dynoxide", iso, "ddd", 90)]);
  assert.equal(model.runs[0].headline.graded, false);
  assert.equal(model.runs[0].startTime, Date.parse(iso));
});

// ── The rendered movement reading ───────────────────────────────────────────

test("an unchanged row reads as a magnitude with no direction word", () => {
  const model = buildModel([at("dynoxide", "2026-07-20T10:00:00Z", "a", 90), at("dynoxide", "2026-07-21T10:00:00Z", "b", 90)]);
  const mv = model.runs[0].standings.find((r) => r.slug === "dynoxide").movement;
  assert.equal(mv.state, "flat");
  assert.equal(mv.deltaReading, "0.0pp");
});

test("every movement state carries a reading, so no row renders a blank", () => {
  // The templates print deltaReading unconditionally in the default branch, so
  // a state without one would render an empty span rather than fail.
  const model = buildModel([
    at("dynoxide", "2026-07-20T10:00:00Z", "a", 90),
    at("dynoxide", "2026-07-21T10:00:00Z", "b", 95),
    at("floci", "2026-07-21T10:00:00Z", "b", 80),
  ]);
  for (const run of model.runs) {
    for (const row of run.standings) {
      assert.ok(row.movement.deltaReading, `${row.slug} in ${run.date} has no deltaReading`);
    }
  }
});

test("the reading never contradicts the sign the endpoints publish", () => {
  // deltaLabel stays signed for consumers; deltaReading is the same magnitude
  // with a word. A drift between them would put two different numbers on one row.
  const model = buildModel([at("dynoxide", "2026-07-20T10:00:00Z", "a", 80), at("dynoxide", "2026-07-21T10:00:00Z", "b", 90)]);
  const mv = model.runs[0].standings.find((r) => r.slug === "dynoxide").movement;
  assert.equal(mv.deltaReading, `${Math.abs(mv.delta).toFixed(1)}pp less`);
  assert.equal(mv.deltaLabel, `${mv.delta.toFixed(1)}pp`);
});

// A target tested between sweeps has its entry filed only under a later
// sweep's key, and the latest sweep may observe a different set again. A
// run-level fault rates no region, so its own label counts none observed; the
// count it publishes is the one from the sweep its entry was found in. A
// scored row keeps its own count.
test("a run's observed region count comes from its own sweep, never the latest one", () => {
  const OBSERVED_THEN = ["us-east-1", "eu-west-2", "ap-south-1"];
  const OBSERVED_NOW = [...OBSERVED_THEN, "us-west-2", "sa-east-1"];
  const runLevel = {
    rate: null,
    label: { kind: "none", regions: [], rate: null, others: 0, observed: 0 },
    suiteHeadlineRegion: "us-east-1",
    regions: [{ region: "us-east-1", rate: null, passed: 0, failed: 0, skipped: 0, indeterminate: 100, count: 100, tiers: {} }],
    divergenceBest: null,
    divergenceWorst: null,
    runDate: "2026-01-01",
  };
  const scored = {
    rate: 92,
    label: { kind: "all", regions: ["us-east-1", "eu-west-2"], rate: 92, others: 1, observed: 2 },
    suiteHeadlineRegion: "us-east-1",
    regions: [{ region: "us-east-1", rate: 92, passed: 92, failed: 8, skipped: 0, indeterminate: 0, count: 100, tiers: {} }],
    divergenceBest: 8,
    divergenceWorst: 8,
    runDate: "2026-01-01",
  };
  const snaps = [at("dynoxide", "2026-01-01T10:00:00Z", "a1", 80), at("dynalite", "2026-01-01T10:00:00Z", "a1", 80)];
  const model = buildModel(snaps, {
    available: true,
    latest: { regions: { observed: OBSERVED_NOW }, targets: { dynoxide: runLevel, dynalite: scored } },
    // No sweep is keyed on the run's own date.
    byRunDate: {
      "2026-01-03": { regions: { observed: OBSERVED_THEN }, targets: { dynoxide: runLevel, dynalite: scored } },
      "2026-01-05": { regions: { observed: OBSERVED_NOW }, targets: {} },
    },
  });
  const run = model.runs.find((r) => r.date === "2026-01-01");
  assert.ok(run, "the run is on the board under its own date");
  assert.equal(rowFor(run, "dynoxide").regionLabel.observed, OBSERVED_THEN.length);
  assert.equal(rowFor(run, "dynalite").regionLabel.observed, 2, "a scored row keeps its own count");
  const published = buildRuns(model, { url: "https://example.com" }).runs.find((r) => r.date === "2026-01-01").targets;
  assert.equal(published.find((t) => t.slug === "dynoxide").region.observed, OBSERVED_THEN.length);
  assert.equal(published.find((t) => t.slug === "dynoxide").region.kind, "none");
  assert.equal(published.find((t) => t.slug === "dynalite").region.observed, 2);
});

// The run-history table and a run's own page print a target's series point.
// A run-level fault rates no test, so its counts read 0 of N implemented, and
// only the indeterminate count beside them stops that reading as 0.0% coverage
// under a board that says "-".
test("a not-scored run's series point withholds both figures, as the board does", () => {
  for (const s of SCENARIOS) {
    const { model } = s.build();
    for (const slug of s.notScored) {
      const point = model.perTarget[slug].series.at(-1);
      assert.equal(point.coverageValue, null, `${s.name}: ${slug} coverage`);
      assert.equal(point.coverage, "-", `${s.name}: ${slug} coverage`);
      assert.equal(point.divergenceValue, null, `${s.name}: ${slug} divergence`);
    }
  }
});
