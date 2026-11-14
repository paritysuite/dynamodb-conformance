import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { axesOf } from "./scoring.mjs";

// The committed fallback stores a *derived* model, not raw upstream data: each
// row carries figures and a movement object computed by lib/. So a change to
// how any of those are derived leaves the fallback serving the old values until
// someone regenerates it, and the site renders them without complaint.
//
// That is not hypothetical. Changing movement from correctness to divergence
// inverted its meaning - lower is now better - while the fallback still held
// movement computed the old way. The page showed a red-flavoured "fell 0.2
// percentage points" beside a legend that reads a fall as an improvement, on a
// target whose failures had just gone from 16 to 18. The board said a
// regression was an improvement.
//
// This checks the stored values against the row's own raw counts, so it fails
// on a stale fallback without needing the network or a rebuild. Regenerate with
// `node scripts/snapshot.mjs` from site/.

const here = dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(readFileSync(join(here, "..", "data", "conformance-history.json"), "utf8"));

// Through the suite's own axesOf, not a local copy of the formula. A test that
// re-implements the thing it is checking shares any drift it exists to catch:
// this one would have kept agreeing with a stale fallback if both had dropped
// the same guard.
const divergenceOf = (row) =>
  axesOf({
    passed: row.passed ?? 0,
    failed: row.failed ?? 0,
    count: row.count ?? 0,
    indeterminate: row.indeterminate ?? 0,
  }).divergence;

const scored = (row) => !row.synthesised && row.count > 0 && row.passed + row.failed > 0;

test("committed fallback: every row carries the figures the board publishes", () => {
  const missing = [];
  for (const run of model.runs ?? []) {
    for (const row of run.standings ?? []) {
      if (!scored(row)) continue;
      if (row.divergence === undefined || row.coverage === undefined) {
        missing.push(`${run.date}/${row.slug}`);
      }
    }
  }
  assert.deepEqual(
    missing.slice(0, 5),
    [],
    `rows with no divergence/coverage - regenerate the fallback (${missing.length} rows)`,
  );
});

test("committed fallback: stored divergence matches the row's own counts", () => {
  const wrong = [];
  for (const run of model.runs ?? []) {
    for (const row of run.standings ?? []) {
      if (!scored(row) || row.divergenceValue == null) continue;
      const derived = divergenceOf(row);
      // A row whose headline came from the region overlay legitimately differs
      // from its raw-count divergence, so only flag a row with no overlay.
      if (row.hasRegions) continue;
      if (Math.abs(derived - row.divergenceValue) > 0.05) {
        wrong.push(`${run.date}/${row.slug}: stored ${row.divergenceValue} vs ${derived}`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 5), [], `stale divergence in the fallback (${wrong.length} rows)`);
});

test("committed fallback: movement direction agrees with the change in divergence", () => {
  // The one that actually broke. Movement is stored, so a change to how it is
  // derived can leave an arrow pointing the wrong way against a figure that
  // moved the other direction.
  const wrong = [];
  const byTarget = new Map();
  for (const run of [...(model.runs ?? [])].reverse()) {
    for (const row of run.standings ?? []) {
      // A move into or out of a run with no figure has no direction either,
      // but it does have to agree with the figure the row publishes: none on
      // the run that lost its score, one on the run that is scored. The run
      // with no figure also resets the comparison, as it does in the model.
      const state = row.movement?.state;
      if (state === "unscored" || state === "scored") {
        const published = row.divergenceValue ?? null;
        if ((state === "unscored") !== (published === null)) {
          wrong.push(`${run.date}/${row.slug}: ${state} beside a divergence of ${published}`);
        }
        byTarget.set(row.slug, published);
        continue;
      }
      if (!scored(row)) continue;
      const prev = byTarget.get(row.slug);
      byTarget.set(row.slug, row.divergenceValue ?? divergenceOf(row));
      const cur = row.divergenceValue ?? divergenceOf(row);
      if (prev == null || cur == null || !state) continue;
      // `carried` (not re-tested this run), `new` and `baseline` describe the
      // run rather than a change, so there is no direction to check.
      if (["carried", "new", "baseline"].includes(state)) continue;
      if (!["improved", "regressed", "flat"].includes(state)) {
        wrong.push(`${run.date}/${row.slug}: unknown movement state "${state}"`);
        continue;
      }
      const delta = Math.round((cur - prev) * 10) / 10;
      const expected = delta < 0 ? "improved" : delta > 0 ? "regressed" : "flat";
      if (state !== expected) {
        wrong.push(`${run.date}/${row.slug}: ${state} but divergence moved ${delta}`);
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 5), [], `movement disagrees with divergence (${wrong.length} rows)`);
});

// The same failure mode one level down. Tier figures are derived and stored, so
// a fallback written before the tier conversion serves correctness under the
// keys the pages now read as divergence - or, once the old keys are gone,
// serves nothing and renders blank tier bars.
test("committed fallback: every tier carries divergence, and none the pre-conversion keys", () => {
  const wrong = [];
  for (const run of model.runs ?? []) {
    for (const row of run.standings ?? []) {
      if (!scored(row)) continue;
      for (const [key, tier] of Object.entries(row.tiers ?? {})) {
        if (!tier) continue;
        if (tier.divergence === undefined || tier.coverage === undefined) {
          wrong.push(`${run.date}/${row.slug}/${key}: no divergence or coverage`);
        } else if ("pct" in tier || "value" in tier) {
          wrong.push(`${run.date}/${row.slug}/${key}: still carries pct/value`);
        }
      }
    }
  }
  assert.deepEqual(
    wrong.slice(0, 5),
    [],
    `stale tier figures in the fallback - regenerate it (${wrong.length} tiers)`,
  );
});

test("committed fallback: stored tier divergence matches that tier's own counts", () => {
  const wrong = [];
  for (const run of model.runs ?? []) {
    for (const row of run.standings ?? []) {
      if (!scored(row)) continue;
      for (const [key, tier] of Object.entries(row.tiers ?? {})) {
        if (!tier || tier.divergenceValue == null || !tier.total) continue;
        const derived = axesOf({
          passed: tier.passed ?? 0,
          failed: tier.failed ?? 0,
          count: tier.total,
          indeterminate: tier.indeterminate ?? 0,
        }).divergence;
        if (derived == null) continue;
        if (Math.abs(derived - tier.divergenceValue) > 0.05) {
          wrong.push(`${run.date}/${row.slug}/${key}: stored ${tier.divergenceValue} vs ${derived}`);
        }
      }
    }
  }
  assert.deepEqual(wrong.slice(0, 5), [], `tier divergence disagrees with its counts (${wrong.length} tiers)`);
});

test("committed fallback: no row still carries a pre-rename movement state", () => {
  const stale = new Set();
  for (const run of model.runs ?? []) {
    for (const row of run.standings ?? []) {
      const s = row.movement?.state;
      if (s === "up" || s === "down") stale.add(`${run.date}/${row.slug}`);
    }
  }
  assert.deepEqual([...stale].slice(0, 5), [], `movement states from before the rename (${stale.size} rows)`);
});

// ── The other committed fallback ────────────────────────────────────────────
//
// summary-history.json stores a derived model too, and it is where every field
// this release added lives: the per-region entries, the grade inputs, the
// ground-truth lane provenance, and the failing test identities the build's
// A+ check reads. The documented failure mode is exactly the one above - a
// field is added, a template reads it, the fallback does not carry it, and an
// empty span ships - and it has happened twice on this branch. Shape rather
// than arithmetic: whether the stored model still has what the templates and
// the guard now read.

const summaryFallback = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "summary-history.json"), "utf8"),
);

test("the summary fallback carries the fields the pages and the guard read", () => {
  const latest = summaryFallback.latest;
  assert.ok(latest, "no latest summary in the fallback");

  for (const key of ["regions", "targets", "groundTruth"]) {
    assert.ok(latest[key], `summary fallback has no ${key}`);
  }
  // The control strip reads these off groundTruth; without them it silently
  // falls back to the pinned baseline row it was written to stop reading.
  for (const key of ["testsObserved", "suiteSize", "lanes", "missingLanes"]) {
    assert.ok(key in latest.groundTruth, `groundTruth is missing ${key}`);
  }

  const targets = Object.entries(latest.targets);
  assert.ok(targets.length > 0, "summary fallback has no targets");
  for (const [slug, t] of targets) {
    for (const key of ["regions", "label", "divergenceBest", "divergenceWorst", "regionFailures"]) {
      assert.ok(key in t, `${slug} is missing ${key}`);
    }
  }
});

test("every named regional failure in the fallback is a test identity, not a bare title", () => {
  // The build's A+ check joins these against the split registry by identity,
  // so a fallback predating the identity change fails the build.
  //
  // This used to look only at zero-divergence rows, which is the subset the A+
  // check runs on - and since 2026-08-12 there are none, so it checked nothing
  // and passed. The shape claim holds for every row that names failures at all,
  // which is both a wider net and one that does not go quiet the moment the
  // board stops holding an A+ candidate. The rule itself is exercised by
  // lib/premise.test.mjs against fixtures.
  let checked = 0;
  for (const [slug, t] of Object.entries(summaryFallback.latest.targets)) {
    for (const [region, names] of Object.entries(t.regionFailures ?? {})) {
      for (const id of names) {
        checked++;
        assert.match(id, /^tests\/.+\.test\.ts::.+/, `${slug}/${region} carries a bare title: ${id}`);
      }
    }
  }
  // Said out loud rather than passing silently, so "clean" and "nothing to
  // look at" are not the same green tick.
  if (checked === 0) console.log("    (no row in the fallback names a regional failure)");
});
