// Models a not-scored run actually produces, built from the committed results
// files through the same steps as the publish: summarise's buildSummary for the
// per-region overlay, and the site's own scoring and buildModel for the board.
// Each scenario edits the results documents in memory first; nothing on disk
// is touched. Read by the site's tests, which run their invariants over every
// scenario rather than over a row with only its headline figures nulled.
//
// The scenarios start from the results with every indeterminate cleared, so
// they do not depend on which targets results/ holds scored today: every
// project is a candidate, and each scenario's edit is what leaves it not
// scored. A scenario that cannot be built throws when its model is first read,
// inside the test that reads it, never on import.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildSummary, readTargets } from "dynamodb-conformance/scripts/summarise.mjs";
import { GROUND_TRUTH_SLUG, isTargetResultFile, loadScoringContext, tierOf } from "dynamodb-conformance/scripts/lib/score.mjs";
import { testIdentities } from "dynamodb-conformance/scripts/lib/identity.mjs";
import { areaTallies, breakdownOf, capabilityTallies, isVariant, scoreEmulator } from "../lib/scoring.mjs";
import { findingsOf } from "../lib/findings.mjs";
import { assemble } from "../lib/summary-source.mjs";
import { buildModel } from "../lib/history.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULTS = join(ROOT, "results");

// Every indeterminate cleared: no sidecar, no test-level marker. A marked test
// keeps its recorded status, which for a marker is a fail.
function sanitised(targets) {
  const copy = structuredClone(targets);
  for (const t of copy) {
    t.sidecar = null;
    for (const tr of t.raw.testResults) {
      for (const ar of tr.assertionResults ?? []) if (ar.meta?.indeterminate) delete ar.meta.indeterminate;
    }
  }
  return copy;
}

const baseTargets = sanitised(readTargets(readdirSync(RESULTS).filter(isTargetResultFile).map((f) => join(RESULTS, f))));
const context = loadScoringContext({
  registryPath: join(ROOT, "registry", "splits.json"),
  regionHealthPath: join(ROOT, "registry", "regions.json"),
});
const manifest = JSON.parse(readFileSync(join(RESULTS, "tag-manifest.json"), "utf8"));
const groundTruth = baseTargets.find((t) => t.slug === GROUND_TRUTH_SLUG);

/** A test-level indeterminate: one answer the target gave was a fault, not a verdict. */
export function markTestLevel(raw) {
  for (const tr of raw.testResults) {
    const ar = (tr.assertionResults ?? []).find((a) => a.status === "passed");
    if (ar) {
      ar.status = "failed";
      ar.meta = { ...(ar.meta ?? {}), indeterminate: { reason: "transport", at: "test" } };
      return;
    }
  }
  throw new Error("no passed assertion to mark indeterminate");
}

/** A run-level indeterminate, carried by the sidecar beside the results file. */
export const RUN_LEVEL = { runLevel: [{ reason: "table-active-timeout", phase: "provisioning" }] };

/**
 * The board built from the results, indeterminates cleared, with `edit`
 * applied to a copy of the targets first. `edit` receives the target list ({ slug, raw, sidecar,
 * version, runDate }) and may change it in place.
 */
export function pipelineModel(edit = () => {}) {
  const targets = structuredClone(baseTargets);
  edit(targets);
  const summary = buildSummary(targets, {
    registry: context.registry,
    health: context.health,
    suiteTests: testIdentities(groundTruth.raw),
  });
  const overlay = { available: true, ...assemble([{ raw: summary, sha: "scenario" }]) };
  const snapshots = targets
    .filter((t) => t.slug !== GROUND_TRUTH_SLUG && !t.lane)
    .map(({ slug, raw, version }) => ({
      ...scoreEmulator(slug, raw, version),
      startTime: raw.startTime,
      sha: "scenario",
      breakdown: breakdownOf(raw),
      areas: areaTallies(raw),
      capabilities: capabilityTallies(raw, manifest),
      findings: findingsOf(raw, { slug, version, sha: "scenario" }),
    }));
  return { summary, model: buildModel(snapshots, overlay) };
}

const SKIPPED = new Set(["skipped", "pending", "todo"]);
const indeterminate = (ar) => {
  ar.status = "failed";
  ar.meta = { ...(ar.meta ?? {}), indeterminate: { reason: "http-5xx", at: "test" } };
};

/**
 * A realistic mixed run, set tier by tier rather than left to where a counter
 * lands: every tier holds passes, fails and indeterminates (one pass in nine,
 * and at least one), and the row keeps a skip. Where a tier lacks a fail or
 * three passes, its own tests are made them, so any target will do.
 */
export function markMixed(raw) {
  const tiers = ["tier1", "tier2", "tier3"].map((tier) =>
    raw.testResults.filter((tr) => tierOf(tr.name) === tier).flatMap((tr) => tr.assertionResults ?? []),
  );
  for (const [i, tests] of tiers.entries()) {
    if (tests.length < 4) throw new Error(`markMixed needs four tests in tier${i + 1}, found ${tests.length}`);
    // One fail the tier keeps, whichever it already had or else its last test.
    const keep = tests.find((a) => a.status === "failed") ?? tests.at(-1);
    keep.status = "failed";
    for (const a of tests) {
      if (tests.filter((x) => x.status === "passed").length >= 3) break;
      if (a.status !== "passed" && a !== keep) a.status = "passed";
    }
    // Every ninth pass from the first: at least one, and at least two stay.
    tests.filter((a) => a.status === "passed").filter((a, k) => k % 9 === 0).forEach(indeterminate);
  }
  const all = tiers.flat();
  // A pass the tier can spare, so the row keeps a skip and every tier a pass.
  if (!all.some((a) => SKIPPED.has(a.status))) all.find((a) => a.status === "passed").status = "skipped";
}

// The target a scenario edits, or a named error when results/ has none to give.
function target(targets, slug, what = "a target") {
  const found = slug && targets.find((t) => t.slug === slug);
  if (!found) throw new Error(`the scenario needs ${what} in results/, and there is none`);
  return found;
}
const projects = baseTargets.filter((t) => t.slug !== GROUND_TRUTH_SLUG && !isVariant(t.slug)).map((t) => t.slug);
const builds = baseTargets.filter((t) => isVariant(t.slug)).map((t) => t.slug);
// The mixed run goes on a second project where there is one, so it is not the
// project the other scenarios edit.
const mixed = projects[1] ?? projects[0];

// A new target, not scored on its first run: a copy of an existing project's
// results, under a made-up slug, with one test-level indeterminate.
const NEW_SLUG = "aa-new-not-scored";
function addNewTarget(targets, mark) {
  const from = target(targets, projects[0], "a project");
  const added = { ...structuredClone(from), slug: NEW_SLUG, version: "0.1.0" };
  mark(added);
  targets.push(added);
}

/**
 * Each scenario: a name, the slugs it leaves not scored, and the edit. Every
 * one goes through the full pipeline above.
 */
const scenario = (name, notScored, edit, extra = {}) => {
  let built;
  // Built on first read and kept, so each test file pays for a scenario once.
  return { name, notScored, edit, ...extra, build: () => (built ??= pipelineModel(edit)) };
};

export const SCENARIOS = [
  scenario("a new target not scored at test level", [NEW_SLUG], (ts) => addNewTarget(ts, (t) => markTestLevel(t.raw))),
  scenario("an existing project not scored at test level", projects.slice(0, 1), (ts) => markTestLevel(target(ts, projects[0], "a project").raw)),
  scenario("an existing project not scored at run level", projects.slice(0, 1), (ts) => { target(ts, projects[0], "a project").sidecar = RUN_LEVEL; }),
  scenario("an existing project with indeterminates in every tier", projects.length ? [mixed] : [], (ts) => markMixed(target(ts, mixed, "a project").raw), { mixed: true }),
  scenario("every build not scored at run level", builds, (ts) => {
    if (!builds.length) throw new Error("the scenario needs a build in results/, and there is none");
    builds.forEach((slug) => { target(ts, slug).sidecar = RUN_LEVEL; });
  }),
];
