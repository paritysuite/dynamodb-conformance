import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DISPLAY,
  REPO,
  areaOf,
  areaState,
  areaTallies,
  breakdownOf,
  display,
  dynamodbRow,
  isSelfMaintained,
  label,
  pct,
  scoreEmulator,
  tierFigures,
  tierOf,
  GROUND_TRUTH_SLUG,
  capClauseOf,
  gradeForRow,
  gradeLineOf,
  regionClauseOf,
  sortRows,
  buildsAgree,
} from "./scoring.mjs";
import { figuresDiffer } from "dynamodb-conformance/scripts/lib/standings.mjs";
import * as suite from "dynamodb-conformance/scripts/summarise.mjs";
import * as suiteScore from "dynamodb-conformance/scripts/lib/score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "test", "fixtures");

test("tierOf classifies by /tierN/ regardless of path prefix", () => {
  assert.equal(tierOf("/home/runner/work/x/tests/tier1/foo.test.ts"), "tier1");
  assert.equal(tierOf("/Users/martin/Projects/x/tests/tier2/foo.test.ts"), "tier2");
  assert.equal(tierOf("/anything/tier3/foo.test.ts"), "tier3");
  assert.equal(tierOf("/no/tier/here.test.ts"), "other");
});

test("pct is correctness over implemented (passed, failed) - skips excluded", () => {
  assert.equal(pct(1, 1), "50.0%"); // 1 passed, 1 failed
  assert.equal(pct(625, 0), "100.0%"); // all implemented passed
  assert.equal(pct(0, 0), "-"); // nothing implemented
  assert.equal(pct(2, 1), "66.7%"); // 2 of 3 implemented pass
});

test("display proper-cases known slugs and humanises unknown ones", () => {
  assert.equal(display("dynamodb-local"), "DynamoDB Local");
  assert.equal(display("dynoxide"), "Dynoxide");
  assert.equal(display("some-new-thing"), "some new thing");
});

test("label links known targets and leaves unknown ones bare", () => {
  assert.equal(label("dynoxide"), "[Dynoxide](https://github.com/nubo-db/dynoxide)");
  assert.equal(label("some-new-thing"), "some new thing");
});

test("scoreEmulator buckets tiers, counts statuses, derives date + version", () => {
  const raw = {
    startTime: Date.parse("2026-05-24T07:18:15.825Z"),
    testResults: [
      { name: "/x/tier1/a.test.ts", assertionResults: [{ status: "passed" }, { status: "failed" }] },
      { name: "/x/tier2/b.test.ts", assertionResults: [{ status: "passed" }, { status: "skipped" }] },
      { name: "/x/tier3/c.test.ts", assertionResults: [{ status: "passed" }] },
    ],
  };
  const r = scoreEmulator("dynoxide", raw, "0.9.13");
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.count, 5); // count still includes the skip
  // Tiers report divergence over the whole tier, the same axis as the headline.
  assert.equal(r.tiers.tier1.divergence, "50.0%"); // 1 of 2 failed
  assert.equal(r.tiers.tier2.divergence, "0.0%"); // nothing failed; the skip is coverage, not divergence
  assert.equal(r.tiers.tier3.divergence, "0.0%");
  // Coverage sits beside it, and is what shows tier 2's skip.
  assert.equal(r.tiers.tier1.coverage, "100.0%");
  assert.equal(r.tiers.tier2.coverage, "50.0%");
  // Correctness is still available, under its own name.
  assert.equal(r.tiers.tier1.correctness, "50.0%");
  assert.equal(r.tiers.tier2.correctness, "100.0%");
  assert.equal(r.total, "75.0%"); // 3 passed / (3 + 1 failed); skip excluded
  assert.equal(r.totalValue, 75);
  assert.equal(r.version, "0.9.13");
  assert.equal(r.runDate, "2026-05-24");
});

test("scoreEmulator treats any non-passed/failed status as a skip", () => {
  const raw = {
    startTime: Date.parse("2026-01-01T00:00:00Z"),
    testResults: [
      { name: "/x/tier1/a.test.ts", assertionResults: [{ status: "todo" }, { status: "pending" }] },
    ],
  };
  const r = scoreEmulator("x", raw, "-");
  assert.equal(r.skipped, 2);
  assert.equal(r.failed, 0);
});

test("scoreEmulator surfaces a missing version as '-' and missing startTime as '-'", () => {
  const raw = { testResults: [] };
  const r = scoreEmulator("x", raw, "-");
  assert.equal(r.version, "-");
  assert.equal(r.runDate, "-");
  assert.equal(r.total, "-");
  assert.equal(r.totalValue, null);
});

test("skips are excluded from the score, raising it above the skip-inclusive figure", () => {
  // 8 passed, 2 failed, 90 skipped: correctness is 8/10 = 80%, not 8/100.
  const raw = {
    startTime: Date.parse("2026-05-24T00:00:00Z"),
    testResults: [
      {
        name: "/x/tier1/a.test.ts",
        assertionResults: [
          ...Array(8).fill({ status: "passed" }),
          ...Array(2).fill({ status: "failed" }),
          ...Array(90).fill({ status: "skipped" }),
        ],
      },
    ],
  };
  const r = scoreEmulator("x", raw, "-");
  assert.equal(r.total, "80.0%"); // 8 / (8 + 2)
  assert.equal(r.totalValue, 80);
  assert.equal(r.skipped, 90); // still reported
  assert.equal(r.count, 100); // count still includes skips
  // Scope axis: 10 of 100 operations implemented, 90 unsupported.
  assert.equal(r.implemented, 10);
  assert.equal(r.unsupported, 90);
  assert.equal(r.coverage, "10.0%");
  assert.equal(r.coverageValue, 10);
});

test("a target with everything skipped has no score (passed + failed === 0)", () => {
  const raw = {
    startTime: Date.parse("2026-05-24T00:00:00Z"),
    testResults: [{ name: "/x/tier2/partiql/a.test.ts", assertionResults: [{ status: "skipped" }, { status: "skipped" }] }],
  };
  const r = scoreEmulator("x", raw, "-");
  assert.equal(r.total, "-");
  assert.equal(r.totalValue, null);
  assert.equal(r.skipped, 2);
});

test("areaOf extracts the tier/group from a test path", () => {
  assert.deepEqual(areaOf("/x/tests/tier2/transactions/basic.test.ts"), {
    tier: "tier2",
    group: "transactions",
    key: "tier2/transactions",
  });
  assert.equal(areaOf("/no/tier/here.test.ts"), null);
});

test("breakdownOf lists only areas with gaps, with titles, sorted by gap size", () => {
  const raw = {
    testResults: [
      {
        name: "/x/tier2/transactions/a.test.ts",
        assertionResults: [
          { status: "failed", fullName: "Transactions writes atomically" },
          { status: "failed", fullName: "Transactions roll back" },
          { status: "skipped", fullName: "Transactions support idempotency" },
        ],
      },
      {
        name: "/x/tier1/putItem/b.test.ts",
        assertionResults: [
          { status: "passed", fullName: "PutItem stores an item" },
          { status: "failed", fullName: "PutItem rejects oversized items" },
        ],
      },
      {
        name: "/x/tier1/getItem/c.test.ts",
        assertionResults: [{ status: "passed", fullName: "GetItem returns an item" }],
      },
    ],
  };
  const b = breakdownOf(raw);
  // getItem is all-passing, so it's excluded; transactions (3 gaps) before putItem (1 gap).
  assert.deepEqual(b.map((a) => a.key), ["tier2/transactions", "tier1/putItem"]);
  assert.equal(b[0].failed, 2);
  assert.equal(b[0].skipped, 1);
  assert.deepEqual(b[0].skips, ["Transactions support idempotency"]);
  assert.equal(b[1].failures[0], "PutItem rejects oversized items");
});

test("areaState classifies supported / partial / unsupported / failing", () => {
  assert.equal(areaState({ passed: 5, failed: 0, skipped: 0 }), "supported"); // clean pass
  assert.equal(areaState({ passed: 5, failed: 0, skipped: 2 }), "partial"); // passes what it runs, skips some
  assert.equal(areaState({ passed: 4, failed: 1, skipped: 0 }), "partial"); // mostly passes, one gap
  assert.equal(areaState({ passed: 4, failed: 1, skipped: 2 }), "partial"); // passes, fails and skips mixed
  assert.equal(areaState({ passed: 0, failed: 0, skipped: 3 }), "unsupported"); // implements none of it
  assert.equal(areaState({ passed: 0, failed: 2, skipped: 0 }), "failing"); // implemented, nothing passes
  assert.equal(areaState({ passed: 0, failed: 2, skipped: 9 }), "failing"); // implemented but every run fails
});

test("areaTallies keeps every area with counts + state, sorted by tier then group", () => {
  const raw = {
    testResults: [
      { name: "/x/tier1/getItem/a.test.ts", assertionResults: [{ status: "passed" }, { status: "passed" }] },
      { name: "/x/tier2/transactions/b.test.ts", assertionResults: [{ status: "skipped" }, { status: "skipped" }] },
      { name: "/x/tier1/putItem/c.test.ts", assertionResults: [{ status: "passed" }, { status: "failed" }] },
    ],
  };
  const a = areaTallies(raw);
  assert.deepEqual(a.map((x) => x.key), ["tier1/getItem", "tier1/putItem", "tier2/transactions"]);
  assert.equal(a.find((x) => x.group === "getItem").state, "supported");
  assert.equal(a.find((x) => x.group === "putItem").state, "partial"); // 1 pass, 1 fail: a mix
  assert.equal(a.find((x) => x.group === "transactions").state, "unsupported");
});

// The ground-truth row is synthesised, never scored from a file, so it must
// appear at a definitional 100% across the full suite size even on a run that
// never reached AWS. Asserted against the row itself: the markdown table this
// used to be read out of was a second renderer of the suite's own, and it is
// gone.
test("the DynamoDB row is synthesised at 100% across the suite size", () => {
  const row = dynamodbRow(526, "-");
  assert.equal(row.total, "100.0%");
  assert.equal(row.totalValue, 100);
  assert.equal(row.passed, 526);
  assert.equal(row.failed, 0);
  assert.equal(row.skipped, 0);
  assert.equal(row.count, 526);
  assert.equal(row.version, "live (AWS)");
  assert.equal(row.runDate, "-");
  assert.equal(row.baseline, true);
  for (const t of ["tier1", "tier2", "tier3"]) {
    assert.equal(row.tiers[t].divergence, "0.0%", `${t} must diverge nowhere`);
    assert.equal(row.tiers[t].coverage, "100.0%", `${t} must cover the whole tier`);
  }
});

// The live consistency guard, and the only one that can observe a suite-side
// change. The headline number comes from the suite's summary.json so it cannot
// disagree by construction; what can drift is the number the site still derives
// itself, the eu-west-2 column. This pins that score for each target to
// summary.json's eu-west-2 rate for the same run, reading a captured summary
// plus its matching results verbatim. Keep it through any refactor.
test("parity: the port's score equals summary.json's eu-west-2 rate for every target", () => {
  const dir = join(fixtures, "regions");
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  const round1 = (n) => Math.round(n * 10) / 10;
  let checked = 0;
  for (const slug of Object.keys(summary.targets)) {
    const euw2 = summary.targets[slug].regions["eu-west-2"];
    if (!euw2) continue; // a target absent from eu-west-2 this run is not a mismatch
    const raw = JSON.parse(readFileSync(join(dir, "results", `${slug}.json`), "utf8"));
    const scored = scoreEmulator(slug, raw, "-");
    assert.equal(round1(scored.totalValue), euw2.rate, `${slug}: port ${scored.totalValue} vs summary eu-west-2 ${euw2.rate}`);
    checked++;
  }
  assert.ok(checked >= 7, `expected every target checked, got ${checked}`);
});

test("isSelfMaintained flags the board author's own engine for the disclosure", () => {
  assert.equal(isSelfMaintained("dynoxide"), true);
  // A build of the engine carries the same conflict of interest: the
  // disclosure must travel to the wasm page and its maintainedByAuthor field.
  assert.equal(isSelfMaintained("dynoxide-wasm"), true);
  assert.equal(isSelfMaintained("dynalite"), false);
});

// The maps must be the suite's own objects, not a copy that happens to agree
// today. Comparing values would pass the moment someone reintroduced a local
// literal with the same contents, which is precisely the drift this module was
// changed to prevent; comparing identity fails the instant the import is
// replaced by a declaration.
test("the target maps are the suite's objects rather than a local copy", () => {
  assert.strictEqual(DISPLAY, suite.DISPLAY);
  assert.strictEqual(REPO, suite.REPO);
  assert.strictEqual(display, suite.display);
  assert.strictEqual(label, suite.label);
  assert.strictEqual(tierOf, suiteScore.tierOf);
});

test("every scored target is nameable and linkable from the shared maps", () => {
  // A slug present in one map and not the other renders as a bare slug or an
  // unlinked name on the board. Cheap to assert, invisible until published.
  for (const slug of Object.keys(DISPLAY)) {
    assert.equal(display(slug), DISPLAY[slug], `${slug} lost its display name`);
    assert.ok(REPO[slug], `${slug} has a display name but no project URL`);
  }
  assert.deepEqual(Object.keys(REPO).sort(), Object.keys(DISPLAY).sort());
});

// The identity the methodology page now states, asserted from the arithmetic
// rather than from a fixture, and through the real code path.
//
// Two non-gameability claims have been published and both were false. What is
// true is narrower and checkable: because the denominator is the whole suite
// either way, a test moving from failing to skipped leaves the divergence
// numerator and the coverage numerator together, so both figures fall by exactly
// the same amount. If that ever stops holding, the page is wrong again.
test("moving a fail to a skip moves divergence and coverage by identical deltas", () => {
  const cases = [];
  for (const p of [0, 1, 7, 130, 673]) {
    for (const f of [1, 2, 41, 213]) {
      for (const s of [0, 3, 112]) {
        for (const i of [0, 5]) cases.push({ p, f, s, i });
      }
    }
  }

  for (const t of cases) {
    const before = tierFigures(t);
    // One fail becomes a skip. Nothing is fixed; the tally size is unchanged.
    const after = tierFigures({ ...t, f: t.f - 1, s: t.s + 1 });
    const total = t.p + t.f + t.s + t.i;

    // A tally carrying an indeterminate is not scored at all, so there is no
    // invariant to check on it. That is the point: an unobserved test must not
    // be a cheaper lever than a withdrawn one.
    if (t.i > 0) {
      assert.equal(before.divergenceValue, null, `partial run scored: ${JSON.stringify(t)}`);
      assert.equal(before.coverageValue, null, `partial run scored: ${JSON.stringify(t)}`);
      continue;
    }

    assert.equal(before.total, after.total, "the denominator must not move");

    const dDiv = after.divergenceValue - before.divergenceValue;
    const dCov = after.coverageValue - before.coverageValue;

    // Both fall, by the same amount, and that amount is one test's worth.
    assert.ok(Math.abs(dDiv - dCov) < 1e-9, `deltas differ for ${JSON.stringify(t)}: ${dDiv} vs ${dCov}`);
    assert.ok(
      Math.abs(dDiv - -100 / total) < 1e-9,
      `delta is not -1/total for ${JSON.stringify(t)}`,
    );
    assert.ok(dDiv < 0 && dCov < 0, "withdrawal lowers both, never raises either");
  }
});

// The contrast the page draws, on the same tallies: the figure this replaced
// moved the other way, because those tests left its denominator too.
test("the correctness figure this replaced rises on the same withdrawal", () => {
  for (const t of [{ p: 673, f: 213, s: 112, i: 0 }, { p: 7, f: 41, s: 3, i: 0 }, { p: 130, f: 2, s: 0, i: 0 }]) {
    const before = tierFigures(t);
    const after = tierFigures({ ...t, f: t.f - 1, s: t.s + 1 });
    assert.ok(
      after.correctnessValue > before.correctnessValue,
      `correctness should rise on withdrawal for ${JSON.stringify(t)}`,
    );
    // Which is the whole problem: it rose while divergence fell, so neither
    // figure alone could tell a withdrawal from a fix.
    assert.ok(after.divergenceValue < before.divergenceValue);
  }
});

// A target that withdraws its last remaining fail has no divergence left to
// report, so the identity's endpoint is null rather than a spurious zero.
test("withdrawing the last fail leaves no divergence, not zero", () => {
  const after = tierFigures({ p: 0, f: 0, s: 10, i: 0 });
  assert.equal(after.divergenceValue, null);
  assert.equal(after.divergence, "-");
  assert.equal(after.coverage, "0.0%");
});

// ── The layer between the grade and the template ────────────────────────────
//
// gradeOf and axesOf are thoroughly covered; the copy helpers that turn their
// output into the sentences on a card are not. A branch inversion here renders
// as plausible prose and passes every build check, because the checks assert
// shape rather than meaning. regionClauseOf prints the strongest claim on the
// board - "no divergence in 6 regions" - and the count it pairs with the
// figure is the thing that read backwards before.

test("regionClauseOf pairs the cohort with its worst-region figure", () => {
  const row = {
    regionLabel: { regions: ["a", "b", "c", "d", "e", "f"], observed: 32 },
    divergenceWorstLabel: "0.3%",
  };
  assert.equal(regionClauseOf(row), "in 6 regions · up to 0.3% in the other 26");
});

// A cohort of one is live on today's board - several rows match exactly one
// region - and the plural read as a typo rather than as a measurement.
test("regionClauseOf pluralises the region count", () => {
  assert.equal(
    regionClauseOf({
      regionLabel: { regions: ["a"], observed: 33 },
      divergenceWorstLabel: "2.0%",
    }),
    "in 1 region · up to 2.0% in the other 32",
  );
  assert.equal(
    regionClauseOf({ regionLabel: { regions: ["a"], observed: 1 } }),
    "in all 1 region",
  );
  // The plural stays plural: this is a singular special case, not a rewrite.
  assert.equal(
    regionClauseOf({ regionLabel: { regions: ["a", "b"], observed: 2 } }),
    "in all 2 regions",
  );
});

test("regionClauseOf says all regions only when the cohort is every one", () => {
  assert.equal(
    regionClauseOf({ regionLabel: { regions: Array(32).fill("r"), observed: 32 } }),
    "in all 32 regions",
  );
  // One short is not all, and must not round up to it.
  assert.match(
    regionClauseOf({ regionLabel: { regions: Array(31).fill("r"), observed: 32 }, divergenceWorstLabel: "1.0%" }),
    /^in 31 regions/,
  );
});

test("regionClauseOf drops the remainder clause when no worst figure is known", () => {
  // Rather than claiming a range it cannot evidence.
  assert.equal(
    regionClauseOf({ regionLabel: { regions: ["a"], observed: 32 } }),
    "in 1 of 32 regions",
  );
  assert.equal(regionClauseOf({}), "");
});

test("gradeLineOf names the qualifier and only prints a figure when there is one", () => {
  assert.equal(gradeLineOf({ divergenceValue: 0, coverageValue: 100, divergence: "0.0%" }), "no divergence");
  assert.match(gradeLineOf({ divergenceValue: 12.3, coverageValue: 80, divergence: "12.3%" }), /\(12\.3%\)$/);
});

test("capClauseOf speaks only when coverage is holding the letter down", () => {
  // Dynalite: B on divergence alone, C once coverage is read.
  assert.match(capClauseOf({ divergenceValue: 12.3, coverageValue: 80 }), /lowers this row to C/);
  // Ministack: full coverage, nothing to say.
  assert.equal(capClauseOf({ divergenceValue: 11.2, coverageValue: 100 }), "");
});

test("the baseline is never given a letter by any of them", () => {
  const baseline = { divergenceValue: 0, coverageValue: 100, slug: GROUND_TRUTH_SLUG };
  assert.equal(gradeForRow(baseline, GROUND_TRUTH_SLUG).letter, null);
  assert.equal(capClauseOf(baseline, GROUND_TRUTH_SLUG), "");
});

// ── Which builds of a project start visible ─────────────────────────────────
//
// The standings nest a project's builds under it, behind a disclosure. Every
// build draws its own row whatever it scored; the annotation these tests cover
// is what the template reads to decide whether that disclosure starts open.

// The shape a real site row has. It deliberately carries no `grade`: the site
// computes the letter at render time, so a fixture that invented one would
// exercise a shape this surface never produces.
const buildRow = (over = {}) => ({
  slug: "extenddb-sqlite",
  version: "v0.1.3",
  runDate: "2026-08-14",
  passed: 904,
  failed: 21,
  skipped: 129,
  count: 1054,
  divergenceValue: 2.0,
  coverageValue: 87.8,
  tiers: { tier1: { divergence: "0.8%" }, tier2: { divergence: "2.7%" }, tier3: { divergence: "3.2%" } },
  ...over,
});

test("sortRows returns every build, annotating which of them start closed", () => {
  // The full list stays: the target index, the per-target pages and the JSON
  // endpoints all want every build whatever the disclosure does with it.
  const parent = buildRow({ slug: "extenddb" });
  const matching = buildRow({ slug: "extenddb-sqlite" });
  const rows = sortRows([parent, matching]);

  assert.deepEqual(rows.map((r) => r.slug), ["extenddb", "extenddb-sqlite"]);
  assert.equal(matching.collapsed, true);
  assert.deepEqual(parent.variants.map((r) => r.slug), ["extenddb-sqlite"]);
});

test("a build that scores differently keeps its own row", () => {
  // Dynoxide's wasm build today: the same failures as the native one, but a lot
  // more of the suite it cannot run, which is what drops it a grade.
  const parent = buildRow({ slug: "dynoxide", passed: 988, failed: 10, skipped: 56, coverageValue: 94.7 });
  const wasm = buildRow({ slug: "dynoxide-wasm", passed: 869, failed: 10, skipped: 175, coverageValue: 83.4 });
  sortRows([parent, wasm]);

  assert.equal(wasm.collapsed, false);
  assert.deepEqual(parent.variants.map((r) => r.slug), ["dynoxide-wasm"]);
});

test("sortRows annotates the caller's own rows rather than copies", () => {
  // history.mjs relies on a standings row and the matching perTarget[].current
  // being the same object when it back-fills a version. Copies would break that
  // quietly, which is why the assignment is deliberate rather than tidyable.
  const parent = buildRow({ slug: "extenddb" });
  const variant = buildRow({ slug: "extenddb-sqlite" });
  const rows = sortRows([parent, variant]);

  assert.equal(rows[0], parent);
  assert.equal(rows[1], variant);
});

test("sorting the same rows twice gives the same answer", () => {
  const parent = buildRow({ slug: "extenddb" });
  const variant = buildRow({ slug: "extenddb-sqlite" });
  const first = sortRows([parent, variant]).map((r) => r.slug);
  const second = sortRows([parent, variant]).map((r) => r.slug);

  assert.deepEqual(second, first);
  assert.equal(variant.collapsed, true);
});

test("the collapse annotation adds no second reference to a build's row", () => {
  // leanForFallback strips findings by walking `variants`. A parallel array
  // holding the same row objects would carry every finding it had just removed
  // back into the committed fallback through the second reference, so the split
  // is derived from a flag rather than stored beside them.
  const parent = buildRow({ slug: "extenddb" });
  const variant = buildRow({ slug: "extenddb-sqlite" });
  sortRows([parent, variant]);

  const extra = Object.keys(parent).filter((k) => Array.isArray(parent[k]) && k !== "variants");
  assert.deepEqual(extra, [], `sortRows added row-bearing arrays beside variants: ${extra}`);
});

test("a build starting closed is still in the standings, so its history is unbroken", () => {
  // history.mjs builds each target's series by looking its slug up in every
  // run's standings. Dropping a matching build from that list rather than
  // flagging it would end its trend on the run it converged, which reads as the
  // target disappearing rather than as it agreeing with the build above it.
  const parent = buildRow({ slug: "extenddb" });
  const build = buildRow({ slug: "extenddb-sqlite" });
  const standings = sortRows([parent, build]);

  assert.equal(build.collapsed, true);
  assert.ok(standings.find((r) => r.slug === "extenddb-sqlite"));
});

test("a build not re-tested this run starts open, however its figures read", () => {
  // A carried build's figures are frozen at the run that measured it, and the
  // date saying so renders inside the disclosure - so closing it would take
  // the date with it and leave a summary saying the two agree, when they were
  // measured weeks apart. Dynoxide's wasm build was in exactly this state on
  // 2026-08-12: carried from 24 July under a parent measured that day.
  const parent = buildRow({ slug: "extenddb" });
  const build = buildRow({ slug: "extenddb-sqlite", carried: true });
  sortRows([parent, build]);

  assert.equal(build.collapsed, false, "a carried build was closed over");
});

test("a build re-tested this run still starts closed when its figures match", () => {
  // The complement of the test above, and the reason it is here: a guard that
  // returned false for every build would satisfy that one on its own. This is
  // the case the disclosure exists for, and it has to keep working.
  const parent = buildRow({ slug: "extenddb" });
  const build = buildRow({ slug: "extenddb-sqlite", carried: false });
  sortRows([parent, build]);

  assert.equal(build.collapsed, true, "a build measured this run and reading the same figures was left open");
});

test("a parent not re-tested this run opens its builds, however they read", () => {
  // The other half of the same rule. A carried parent's figures are frozen at
  // the run that measured it, so a build matching them was not measured beside
  // it either - and the guard used to ask only about the build.
  const parent = buildRow({ slug: "extenddb", carried: true });
  const build = buildRow({ slug: "extenddb-sqlite", carried: false });
  sortRows([parent, build]);

  assert.equal(build.collapsed, false, "a build under a carried parent was closed over");
});

test("one build disagreeing opens the disclosure for all of them", () => {
  // The disclosure holds every build of a project and opens as a whole, so the
  // answer has to be the project's, not each build's - otherwise a build that
  // agrees publishes "starts closed" while a disagreeing sibling has already
  // forced it open.
  //
  // Exercised through buildsAgree rather than sortRows, and that is a real
  // limit rather than a preference: no project in the registry ships two
  // builds, and an unregistered slug forms a project of its own, so a mixed
  // group cannot be built through sortRows at all. sortRows takes this one
  // answer and assigns it to every build, so the property holds structurally
  // there; here is where the rule itself is pinned.
  const parent = buildRow({ slug: "extenddb" });
  const agrees = buildRow({ slug: "extenddb-sqlite" });
  const differs = buildRow({ slug: "extenddb-mongo", divergenceValue: 19.9, coverageValue: 50 });

  assert.equal(buildsAgree({ ...parent, variants: [agrees] }), true, "an agreeing build alone should close");
  assert.equal(buildsAgree({ ...parent, variants: [agrees, differs] }), false, "one disagreeing build must open all of them");
  assert.equal(buildsAgree({ ...parent, variants: [] }), false, "a project with no builds has no disclosure to close");
  assert.equal(buildsAgree({ ...parent, carried: true, variants: [agrees] }), false, "a carried parent must open its builds");
});

test("a build promoted to parent carries no closed flag", () => {
  // It stands for its project and nothing holds it behind a disclosure. Its
  // safety rests on the flag never reading true, rather than on the template
  // filter treating an absent flag as open, so it is asserted here.
  const wasm = buildRow({ slug: "dynoxide-wasm", collapsed: true });
  sortRows([wasm]);

  assert.equal(wasm.isParent, true);
  assert.equal(wasm.collapsed, false, "a promoted build kept a closed flag from an earlier grouping");
});

test("a build promoted to parent is marked so the board still shows its project", () => {
  // When the reference build has no result, the grouping promotes a build to
  // stand for the project. The standings used to skip anything isVariant(slug),
  // which dropped the row it had just promoted and lost the whole project -
  // while the README, grouping the same way, still printed it.
  const wasm = buildRow({ slug: "dynoxide-wasm" });
  const rows = sortRows([wasm]);

  assert.equal(rows.length, 1);
  assert.equal(wasm.isParent, true, "the promoted build stands for its project");
});

test("a build travelling under its parent is not marked as standing for the project", () => {
  const parent = buildRow({ slug: "extenddb" });
  const variant = buildRow({ slug: "extenddb-sqlite", failed: 40, passed: 885 });
  sortRows([parent, variant]);

  assert.equal(parent.isParent, true);
  assert.equal(variant.isParent, false);
});


