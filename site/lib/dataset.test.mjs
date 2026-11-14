import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CAPABILITIES, isNotScored, sortRows } from "./scoring.mjs";
import { buildIndex, buildLatest, buildRuns, TIERS, DATA_SCHEMA_VERSION } from "./dataset.mjs";
import { RUN_LEVEL, SCENARIOS, markMixed, pipelineModel } from "../fixtures/not-scored-models.mjs";
import { renderFeatureSummary, renderTargetCapabilities } from "./capabilities.mjs";

// The committed history fallback is a real, fully-built model, so it doubles as
// a fixture for the data endpoints without re-deriving one here.
const MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "conformance-history.json");
const model = JSON.parse(await readFile(MODEL_PATH, "utf8"));

const site = {
  url: "https://paritysuite.org",
  sourceRepo: "https://github.com/paritysuite/dynamodb-conformance",
  dataLicense: "https://creativecommons.org/licenses/by/4.0/",
  dataLicenseName: "CC BY 4.0",
  dataAttribution: "paritysuite.org",
};

const sortedKeys = (obj) => Object.keys(obj).sort();

// The invariants below hold on every board, so they run over the committed
// model and over each board a not-scored run produces, built from the results
// files through the publish's own steps (fixtures/not-scored-models.mjs).
// A scenario's model is built when a test first reads it, so one that cannot
// be built fails that test by name rather than the whole file on import.
const MODELS = [
  { name: "committed", model, notScored: [], observed: null },
  ...SCENARIOS.map((s) => ({
    name: s.name,
    notScored: s.notScored,
    mixed: s.mixed,
    get model() {
      return s.build().model;
    },
    // Every scenario is one sweep, so this is how many regions it observed.
    get observed() {
      return s.build().summary.regions.observed.length;
    },
  })),
];

test("markMixed leaves every tier mixed whatever the run held, and the row a skip", () => {
  const tier = (n, statuses) => ({ name: `/x/tests/tier${n}/a.test.ts`, assertionResults: statuses.map((status) => ({ status, meta: {} })) });
  const runs = [
    [
      tier(1, ["skipped", "skipped", "skipped", "skipped"]),
      tier(2, ["passed", "passed", "passed", "passed", "passed"]),
      tier(3, ["failed", "failed", "failed", "failed"]),
    ],
    // Fewer than three passes, with the tier's one fail ahead of a last test
    // that is not a fail: making passes must not spend that fail.
    [
      tier(1, ["failed", "passed", "skipped", "passed"]),
      tier(2, ["passed", "failed", "passed", "passed"]),
      tier(3, ["passed", "passed", "failed", "skipped"]),
    ],
  ];
  for (const testResults of runs) {
    const raw = { testResults };
    markMixed(raw);
    for (const tr of raw.testResults) {
      const by = (test) => tr.assertionResults.filter(test).length;
      const statuses = tr.assertionResults.map((a) => (a.meta?.indeterminate ? "indeterminate" : a.status)).join(",");
      assert.ok(by((a) => a.meta?.indeterminate) > 0, `${tr.name} has an indeterminate: ${statuses}`);
      assert.ok(by((a) => a.status === "passed") > 0, `${tr.name} keeps a pass: ${statuses}`);
      assert.ok(by((a) => a.status === "failed" && !a.meta?.indeterminate) > 0, `${tr.name} keeps a fail: ${statuses}`);
    }
    assert.ok(raw.testResults.some((tr) => tr.assertionResults.some((a) => a.status === "skipped")), "the row keeps a skip");
  }
});

test("each not-scored scenario really leaves its targets not scored", () => {
  for (const entry of MODELS.slice(1)) {
    const { name, model: m, notScored, mixed } = entry;
    assert.ok(notScored.length > 0, `${name}: names a target it leaves not scored`);
    const latest = buildLatest(m, site);
    for (const slug of notScored) {
      const t = latest.targets.find((x) => x.slug === slug);
      assert.ok(t, `${name}: no row for ${slug}`);
      assert.equal(t.grade.qualifier, "not scored", `${name}: ${slug}`);
      // The mixed run really is mixed: every tier holds indeterminates beside
      // passes and fails, and skips stay somewhere on the row.
      if (!mixed) continue;
      for (const [key, tier] of Object.entries(m.latest.standings.find((r) => r.slug === slug).tiers)) {
        assert.ok(tier.indeterminate > 0 && tier.passed > 0 && tier.failed > 0, `${name}: ${key} is mixed`);
      }
      assert.ok(t.counts.skipped > 0, `${name}: skips stay`);
    }
  }
});

test("every endpoint carries the self-describing envelope", () => {
  for (const doc of [buildIndex(model, site), buildLatest(model, site), buildRuns(model, site)]) {
    assert.equal(doc.schemaVersion, DATA_SCHEMA_VERSION);
    assert.equal(doc.source, site.url);
    assert.equal(doc.license, site.dataLicense);
    assert.equal(doc.licenseName, "CC BY 4.0");
    assert.equal(doc.attribution, "paritysuite.org");
    assert.equal(doc.baseline.slug, "dynamodb");
    assert.equal(doc.baseline.region, "all");
  }
});

test("the measurement identity reaches every endpoint, and absence is tolerated", () => {
  // envelope() is an explicit field whitelist, so a new top-level field does not
  // reach /data/ just because it is on the board - it has to be added by name.
  // Nothing asserted that, and the field is how a machine consumer tells which
  // suite produced the figures and how stale they are.
  //
  // The identity arrives on the summary model, the third argument, not on the
  // conformance history - the endpoints take both.
  const measured = {
    ref: "v3.2.0",
    kind: "tag",
    commit: "0123456789abcdef0123456789abcdef01234567",
    version: "3.2.0",
    region: "eu-west-2",
    measuredAt: "2026-08-18T04:00:00Z",
  };
  const summary = { latest: { suite: measured } };

  for (const build of [buildIndex, buildLatest, buildRuns]) {
    assert.deepEqual(build(model, site, summary).suite, measured, `${build.name} drops the identity`);
  }

  // A board written before the block existed still has to load: the site
  // deploys on its own schedule, so it reads summaries older than itself.
  for (const build of [buildIndex, buildLatest, buildRuns]) {
    for (const older of [null, { latest: {} }]) {
      assert.ok(
        !("suite" in build(model, site, older)),
        `${build.name} publishes an absent identity instead of omitting it`,
      );
    }
  }
});

test("each historical run says which suite measured it", () => {
  // The envelope's identity describes only the current board. A consumer
  // walking run-over-run history could see the denominator move and have no way
  // to attribute it to the release that moved it.
  const runs = buildRuns(model, site).runs;
  assert.ok(runs.length > 0);
  for (const r of runs) {
    assert.ok("suite" in r, `run ${r.id} carries no suite field`);
  }

  const dated = runs.find((r) => r.date);
  const summary = {
    byRunDate: { [dated.date]: { suite: { ref: "v3.0.0", kind: "tag", version: "3.0.0" } } },
  };
  const joined = buildRuns(model, site, summary).runs.find((r) => r.id === dated.id);
  assert.equal(joined.suite.ref, "v3.0.0");
  // A run with no identity recorded reads null rather than borrowing another's.
  const others = buildRuns(model, site, summary).runs.filter((r) => r.id !== dated.id);
  for (const r of others) assert.equal(r.suite, null, `run ${r.id} borrowed another run's identity`);
});

test("index documents the measurement identity it publishes", () => {
  // A consumer branching on `kind` needs the field described where the schema
  // describes itself, not only in prose on the site.
  const index = buildIndex(model, site);
  assert.ok(index.schema, "index.json no longer carries a self-describing schema block");
  assert.ok(
    JSON.stringify(index.schema).includes("suite"),
    "index.json's schema block does not mention the suite identity",
  );
});

for (const entry of MODELS) {
  const { name } = entry;
  test(`latest exposes every target on an identical schema, baseline included (${name})`, () => {
    const { model: m } = entry;
    const latest = buildLatest(m, site);
    assert.ok(latest.targets.length >= 2);
  
    const shape = sortedKeys(latest.targets[0]);
    for (const t of latest.targets) {
      assert.deepEqual(sortedKeys(t), shape, `target ${t.slug} diverges from the shared schema`);
      assert.deepEqual(Object.keys(t.tiers).sort(), ["tier1", "tier2", "tier3"]);
      assert.equal(t.capabilities.length, CAPABILITIES.length);
      // The two published axes always travel together, and the legacy
      // correctness percentage sits beside them under its own name rather than
      // sharing "total" with the raw count in `counts`.
      assert.ok("divergence" in t && "coverage" in t);
      assert.ok("correctness" in t && !("total" in t));
      assert.equal(typeof t.counts.total, "number");
      // Every tier reports on the same axes as the headline, so a tier figure
      // and the figure above it can't run in opposite directions.
      for (const tier of Object.values(t.tiers)) {
        if (!tier) continue;
        assert.ok("divergence" in tier && "coverage" in tier && "correctness" in tier);
        assert.ok(!("pct" in tier) && !("value" in tier));
      }
    }
  
    const baselines = latest.targets.filter((t) => t.baseline);
    assert.equal(baselines.length, 1, "exactly one baseline row");
    assert.equal(baselines[0].slug, "dynamodb");
  });
}

for (const entry of MODELS) {
  const { name } = entry;
  test(`runs endpoint mirrors the model's runs, newest first, shared target schema (${name})`, () => {
    const { model: m } = entry;
    const runs = buildRuns(m, site);
    assert.equal(runs.runs.length, m.runs.length);
    assert.equal(runs.runs[0].id, m.latest.id);
    assert.equal(runs.latestRun, m.latest.id);
  
    const shape = sortedKeys(runs.runs[0].targets[0]);
    for (const run of runs.runs) {
      for (const t of run.targets) {
        assert.deepEqual(sortedKeys(t), shape, `run ${run.id} target ${t.slug} diverges`);
      }
    }
  });
}

test("index documents the tier and capability vocabularies and the endpoints", () => {
  const index = buildIndex(model, site);
  assert.equal(index.tiers.length, 3);
  assert.deepEqual(index.tiers.map((t) => t.key), TIERS.map((t) => t.key));
  assert.equal(index.capabilities.length, CAPABILITIES.length);
  assert.equal(index.latestRun, model.latest.id);
  assert.equal(index.runCount, model.runs.length);
  assert.equal(index.documentation, site.url + "/for-agents");

  const urls = index.endpoints.map((e) => e.url);
  assert.ok(urls.includes(site.url + "/data/latest.json"));
  assert.ok(urls.includes(site.url + "/data/runs.json"));
  assert.ok(urls.includes(site.url + "/feed.xml"));
});

// 3 is the tier conversion plus the `total` -> `correctness` rename. Both
// change what a field means rather than adding one, so a consumer pinned to 2
// has to be told rather than left to read an inverted figure. 4 adds the
// letter grade and its criteria, additively.
test("schema version 4 reflects the grade addition", () => {
  assert.equal(DATA_SCHEMA_VERSION, 4);
});

// The grade travels with the two values it reads, and the criteria travel in
// the envelope, so a consumer can regrade and check the letter it was handed.
// This is the methodology's testability claim made literal: every published
// letter is recomputed here from the envelope's own criteria - a separate
// implementation from gradeOf - and must match. No graded target is graded by
// different rules. The baseline is the one row with no letter to reproduce, and
// it is asserted to be that rather than skipped, so an ungraded row can only
// ever be the yardstick and never a target that quietly lost its grade.
for (const entry of MODELS) {
  const { name } = entry;
  test(`every published letter is reproducible from the envelope's criteria alone (${name})`, () => {
    const { model: m } = entry;
    const latest = buildLatest(m, site);
    const criteria = latest.metrics.grade;
    assert.ok(criteria.bands.length > 0);
    assert.equal(criteria.gradingVersion, 1);
    const ORDER = ["A+", "A", "B", "C", "D", "F"];
    const regrade = (d, c) => {
      if (d == null || c == null) return { letter: null, capAt: null };
      // The bands read the figures at the published one-decimal precision; only
      // the A+ gate reads raw values, on both axes. Mirrors
      // metrics.grade.description, deliberately written from the published
      // criteria rather than by importing gradeOf.
      const d1 = Number(d.toFixed(1));
      const c1 = Number(c.toFixed(1));
      const band = (x) => criteria.bands.find((b) => x < b.under)?.letter ?? "F";
      const effective = Number((d1 + (100 - c1) / criteria.coverageDivisor).toFixed(1));
      const perfect =
        d === criteria.aPlus.divergence && c === criteria.aPlus.coverage;
      const base = d === criteria.aPlus.divergence ? "A+" : band(d1);
      const letter = perfect ? "A+" : band(effective);
      // The ceiling is published only where coverage lowered the letter.
      const capped = letter !== base;
      return { letter, capAt: capped ? letter : null };
    };
  
    let baselines = 0;
    for (const t of latest.targets) {
      assert.ok("grade" in t, `${t.slug} missing grade`);
      if (t.baseline) {
        baselines++;
        assert.equal(t.grade.letter, null, "the baseline must carry no letter");
        assert.equal(t.grade.qualifier, "baseline");
        assert.ok(t.divergence.value != null && t.coverage.value != null,
          "the baseline's figures still publish - they are what every other row is read against");
        continue;
      }
      const expected = regrade(t.divergence.value, t.coverage.value);
      assert.equal(
        t.grade.letter,
        expected.letter,
        `${t.slug}'s published letter must equal one rederived from its own figures`,
      );
      assert.equal(
        t.grade.capAt,
        expected.capAt,
        `${t.slug}'s published ceiling must equal one rederived from its own coverage`,
      );
    }
    assert.equal(baselines, 1, "exactly one row is the baseline");
  });
}

// Every level of this schema pre-computes the published pair. Leaving one level
// as raw counts made a consumer reimplement the one formula the schema otherwise
// hands them, and a consumer computing it themselves can silently desync.
for (const entry of MODELS) {
  const { name } = entry;
  test(`every level publishes the same divergence/coverage pair, not just some (${name})`, () => {
    const { model: m } = entry;
    const latest = buildLatest(m, site);
    for (const t of latest.targets) {
      for (const tier of Object.values(t.tiers)) {
        if (!tier) continue;
        assert.ok("value" in tier.correctness, "a tier's correctness carries a value");
      }
      for (const a of t.areas) {
        assert.ok(a.divergence && a.coverage, `area ${a.key} carries both figures`);
        if (a.total && a.passed + a.failed + a.skipped < a.total) {
          // The rest are indeterminate, so the area is not scored either.
          assert.equal(a.divergence.value, null, `area ${a.key} holds an indeterminate, so has no divergence`);
          assert.equal(a.coverage.value, null, `area ${a.key} holds an indeterminate, so has no coverage`);
        } else if (a.total && a.passed + a.failed > 0) {
          assert.ok(Math.abs(a.divergence.value - (a.failed / a.total) * 100) < 0.001);
          assert.ok(Math.abs(a.coverage.value - ((a.passed + a.failed) / a.total) * 100) < 0.001);
        } else {
          assert.equal(a.divergence.value, null, `area ${a.key} implements nothing, so has no divergence`);
        }
      }
      for (const r of t.regions) {
        assert.ok(r.divergence && r.coverage, `region ${r.region} carries both figures`);
        for (const tier of Object.values(r.tiers)) {
          if (tier) assert.ok("value" in tier.correctness, "a region tier's correctness carries a value");
        }
      }
    }
  });
}

for (const entry of MODELS) {
  const { name } = entry;
  test(`a target's region summary says how wide the cohort behind its headline is (${name})`, () => {
    const { model: m } = entry;
    const latest = buildLatest(m, site);
    for (const t of latest.targets) {
      if (!t.region) continue;
      assert.equal(t.region.cohortSize, t.region.cohort.length);
      assert.ok(t.region.observed === null || t.region.cohortSize <= t.region.observed);
    }
  });
}

function assertUniformRegionSummaries(source, observed) {
  const latest = buildLatest(source, site);
  for (const t of latest.targets) {
    assert.ok("region" in t, `${t.slug} missing region key`);
    if (!t.region) continue;
    assert.ok(Array.isArray(t.region.cohort));
    assert.equal(t.region.pinned, "eu-west-2");
    assert.equal(t.region.beatsPinned, t.region.kind === "beats-pinned");
    if (t.grade.letter === null && !t.baseline) {
      // A not-scored row has no scored headline, so no cohort behind one.
      assert.equal(t.region.kind, "none", `${t.slug} is not scored`);
      assert.equal(t.region.headline, null);
      assert.deepEqual(t.region.cohort, []);
      assert.equal(t.region.cohortSize, 0);
      assert.equal(t.region.beatsPinned, false);
      // The regions its sweep observed, the same count a scored row reports,
      // whether the fault was in one test or in the whole run.
      if (observed !== null) assert.equal(t.region.observed, observed, `${t.slug} observed`);
    } else {
      assert.ok(["all", "pinned-plus", "beats-pinned"].includes(t.region.kind), `${t.slug} kind ${t.region.kind}`);
    }
  }
  const ddb = latest.targets.find((t) => t.baseline);
  assert.equal(ddb.region.kind, "all");
}

for (const entry of MODELS) {
  const { name } = entry;
  test(`every target carries a uniform region summary; baseline is 'all' (${name})`, () => {
    const { model: m, observed } = entry;
    assertUniformRegionSummaries(m, observed);
  });
}

test("latest exposes the per-region breakdown and the run's region health", () => {
  const latest = buildLatest(model, site);
  assert.ok("regionHealth" in latest);
  if (latest.regionHealth) {
    for (const k of ["observed", "unresolved", "dropped"]) assert.ok(Array.isArray(latest.regionHealth[k]));
  }
  const dz = latest.targets.find((t) => t.slug === "dynoxide");
  assert.ok(Array.isArray(dz.regions) && dz.regions.length > 0, "dynoxide has a per-region breakdown");
  const r = dz.regions[0];
  for (const k of ["region", "rate", "pinned", "inCohort", "indeterminate", "total", "tiers"]) assert.ok(k in r, `region entry missing ${k}`);
  assert.deepEqual(Object.keys(r.tiers).sort(), ["tier1", "tier2", "tier3"]);
  assert.ok(dz.regions.some((x) => x.region === "eu-west-2" && x.pinned === true), "eu-west-2 flagged as the baseline region");
});

test("index documents the region model and health vocabulary", () => {
  const index = buildIndex(model, site);
  assert.equal(index.regions.pinned, "eu-west-2");
  assert.deepEqual(index.regions.health.map((h) => h.key), ["observed", "unresolved", "dropped"]);
});

test("targets carry the maintainer disclosure, derived from the slug", () => {
  const latest = buildLatest(model, site);
  assert.equal(latest.targets.find((t) => t.slug === "dynoxide").maintainedByAuthor, true);
  assert.equal(latest.targets.find((t) => t.slug === "dynalite").maintainedByAuthor, false);
});

test("every target on the latest endpoint carries its licence, in the one shape", () => {
  const latest = buildLatest(model, site);
  assert.ok(latest.targets.length >= 2);
  for (const t of latest.targets) {
    assert.ok(t.licence, `${t.slug} has no licence`);
    assert.equal(typeof t.licence.name, "string", `${t.slug}: licence.name`);
    assert.ok(t.licence.name.length > 0, `${t.slug}: empty licence.name`);
    assert.match(t.licence.url, /^https:\/\//, `${t.slug}: licence.url`);
    // name and url always; spdx only where the licence has an identifier.
    for (const key of Object.keys(t.licence)) assert.ok(["name", "spdx", "url"].includes(key), `${t.slug}: licence.${key}`);
  }
  // A build reads its project's licence.
  const wasm = latest.targets.find((t) => t.slug === "dynoxide-wasm");
  const parent = latest.targets.find((t) => t.slug === "dynoxide");
  if (wasm && parent) assert.deepEqual(wasm.licence, parent.licence);
});

test("the runs endpoint carries no licence, since today's licence is not a historical fact", () => {
  const runs = buildRuns(model, site);
  for (const run of runs.runs) for (const t of run.targets) assert.ok(!("licence" in t), `run ${run.id} ${t.slug}`);
});

// The baseline row is synthesised at zero divergence across the whole suite,
// which is only honest while every real-AWS pass has reported. The homepage and
// /ground-truth disclose when one has not; without the same fact here, an agent
// reading the endpoints could not tell a fully measured baseline from a pinned
// one, and would have to know about a build-time file that is not a site path.
const summaryWith = (groundTruth) => ({ latest: { groundTruth } });

test("every endpoint discloses how much of the suite the baseline was measured on", () => {
  const summary = summaryWith({
    suiteSize: 1000,
    testsObserved: 983,
    lanes: [
      { name: "gating", runDate: "2026-08-09", tests: 983 },
      { name: "gsi", runDate: "2026-08-10", tests: 0 },
    ],
    missingLanes: ["integrations"],
  });

  for (const [name, doc] of [
    ["index", buildIndex(model, site, summary)],
    ["latest", buildLatest(model, site, summary)],
    ["runs", buildRuns(model, site, summary)],
  ]) {
    const obs = doc.baseline.observation;
    assert.ok(obs, `${name} carries no baseline observation`);
    assert.equal(obs.suiteSize, 1000);
    assert.equal(obs.testsObserved, 983);
    assert.equal(obs.unobserved, 17, `${name} must publish the shortfall, not just the counts`);
    assert.deepEqual(obs.missingLanes, ["integrations"]);
    // One capture date per pass: three passes under a single date would read
    // as one measurement.
    assert.deepEqual(
      obs.lanes.map((l) => l.name),
      ["gating", "gsi"],
    );
    assert.equal(obs.lanes[0].runDate, "2026-08-09");
  }
});

test("a fully observed baseline reports nothing outstanding rather than omitting the block", () => {
  const doc = buildLatest(
    model,
    site,
    summaryWith({
      suiteSize: 1000,
      testsObserved: 1000,
      lanes: [{ name: "gating", runDate: "2026-08-12", tests: 1000 }],
      missingLanes: [],
    }),
  );
  assert.equal(doc.baseline.observation.unobserved, 0);
  assert.deepEqual(doc.baseline.observation.missingLanes, []);
});

test("the split registry is discoverable from the data index", () => {
  // The methodology's grading section leans on it and the A+ premise is checked
  // against it, but it was reachable only by knowing the raw URL.
  const endpoint = buildIndex(model, site).endpoints.find((e) => /split/i.test(e.name));
  assert.ok(endpoint, "the index does not name the split registry");
  assert.match(endpoint.url, /registry\/splits\.json$/);
});

for (const entry of MODELS) {
  const { name } = entry;
  test(`every target says whether its row starts closed on the board (${name})`, () => {
    const { model: m } = entry;
    // A consumer reading the endpoints beside the board would otherwise find a
    // build here that the board did not appear to show, with nothing to say why.
    const latest = buildLatest(m, site);
    for (const t of latest.targets) {
      assert.equal(
        typeof t.collapsedIntoProject,
        "boolean",
        `target ${t.slug} does not say whether its row starts closed`,
      );
    }
    // A build reading different figures from its project's reference build
    // starts open.
    const wasm = latest.targets.find((t) => t.slug === "dynoxide-wasm");
    assert.equal(wasm.collapsedIntoProject, false);
  });
}

for (const entry of MODELS) {
  const { name } = entry;
  test(`every target says which row stands for its project (${name})`, () => {
    const { model: m } = entry;
    // `isVariant` cannot answer it. When a project's reference build records no
    // result a build is promoted to stand for it, and every row of that project
    // then reads `isVariant: true` - so a consumer grouping by `project` and
    // looking for the one that is not a variant would find none. That is the
    // mistake the board itself made before it read this flag.
    const latest = buildLatest(m, site);
    for (const t of latest.targets) {
      assert.equal(typeof t.standsForProject, "boolean", `target ${t.slug} does not say`);
    }
    assert.equal(latest.targets.find((t) => t.slug === "dynoxide").standsForProject, true);
    assert.equal(latest.targets.find((t) => t.slug === "dynoxide-wasm").standsForProject, false);
  
    // Every project has exactly one row standing for it.
    const byProject = new Map();
    for (const t of latest.targets.filter((t) => t.slug !== "dynamodb")) {
      byProject.set(t.project, (byProject.get(t.project) ?? 0) + (t.standsForProject ? 1 : 0));
    }
    for (const [project, standing] of byProject) {
      assert.equal(standing, 1, `${project} has ${standing} rows standing for it`);
    }
  });
}

test("a promoted build says it stands for its project, though it is a variant", () => {
  // The case the field exists for: drop the reference build's row and the
  // grouping promotes the one below it.
  const seeded = structuredClone(model);
  seeded.latest.standings = seeded.latest.standings.filter((r) => r.slug !== "dynoxide");
  sortRows(seeded.latest.standings);

  const wasm = buildLatest(seeded, site).targets.find((t) => t.slug === "dynoxide-wasm");
  assert.equal(wasm.isVariant, true, "it is still a build by the registry");
  assert.equal(wasm.standsForProject, true, "but it is the row standing for the project");
});

test("a build reading the same figures as its reference build starts closed", () => {
  // No committed run holds a matching pair, so make one: copy the reference
  // build's figures onto its variant and re-derive. Without this the true
  // branch of the flag is never taken by anything in the repo, and a change
  // that stopped it ever being true would look exactly like today's data.
  const seeded = structuredClone(model);
  const rows = seeded.latest.standings;
  const parent = rows.find((r) => r.slug === "dynoxide");
  const build = rows.find((r) => r.slug === "dynoxide-wasm");
  // The parent is seeded too. The rule reads its flag as well, so leaving it
  // to the committed model made this assertion depend on which run the
  // snapshot came from rather than on the code it is testing.
  Object.assign(parent, { carried: false, reTested: true });
  // A pair that is not scored never closes, so give such a parent figures.
  if (isNotScored(parent)) Object.assign(parent, { divergence: "1.2%", coverage: "95.0%", divergenceValue: 1.2, coverageValue: 95 });
  Object.assign(build, {
    divergence: parent.divergence,
    coverage: parent.coverage,
    divergenceValue: parent.divergenceValue,
    coverageValue: parent.coverageValue,
    // Measured in the same run as the row above it. The committed model has
    // this build carried from an earlier one, and a carried build starts open
    // whatever it reads - so seeding the figures alone leaves it open, which
    // is the guard working rather than the seed failing.
    carried: false,
    reTested: true,
    runDate: parent.runDate,
  });
  sortRows(rows);

  const targets = buildLatest(seeded, site).targets;
  assert.equal(targets.find((t) => t.slug === "dynoxide-wasm").collapsedIntoProject, true);
  // The build is still published in full, which is the whole point of the flag
  // meaning "starts closed" rather than "withheld".
  assert.ok(targets.find((t) => t.slug === "dynoxide-wasm").counts.total > 0);
  assert.equal(targets.find((t) => t.slug === "dynoxide").collapsedIntoProject, false);
});

// A row's counts sum to its total, overall and per tier, on both endpoints:
// passed, failed, skipped and the tests that got no answer. Before
// `indeterminate` was published a not-scored row's counts fell short of its
// total, and a consumer had no way to tell the shortfall from a bad sum.
for (const entry of MODELS) {
  const { name } = entry;
  test(`every row's counts sum to its total, overall and per tier (${name})`, () => {
    const { model: m } = entry;
    const sums = (c) => c.passed + c.failed + c.skipped + c.indeterminate;
    const rows = [
      ...buildLatest(m, site).targets.map((t) => ["latest", t]),
      ...buildRuns(m, site).runs.flatMap((r) => r.targets.map((t) => [r.id, t])),
    ];
    let tiers = 0;
    for (const [where, t] of rows) {
      assert.equal(typeof t.counts.indeterminate, "number", `${where} ${t.slug}: counts carry indeterminate`);
      assert.equal(sums(t.counts), t.counts.total, `${where} ${t.slug}: counts sum to the total`);
      assert.equal(t.counts.implemented, t.counts.passed + t.counts.failed, `${where} ${t.slug}: implemented`);
      for (const [key, tier] of Object.entries(t.tiers)) {
        if (!tier) continue;
        tiers++;
        assert.equal(typeof tier.indeterminate, "number", `${where} ${t.slug} ${key}: carries indeterminate`);
        assert.equal(sums(tier), tier.total, `${where} ${t.slug} ${key}: sums to the total`);
      }
    }
    assert.ok(rows.length > 0 && tiers > 0, `${rows.length} rows and ${tiers} tiers were checked`);
  });

  // Correctness is withheld beside "not scored", as the two figures are. A
  // tier holding an unanswered test publishes none either; a scored row and an
  // answered tier keep theirs.
  test(`a not-scored row publishes no correctness figure (${name})`, () => {
    const { model: m } = entry;
    const rows = [...buildLatest(m, site).targets, ...buildRuns(m, site).runs.flatMap((r) => r.targets)];
    for (const t of rows) {
      if (t.baseline) continue;
      if (t.grade.qualifier === "not scored") {
        assert.deepEqual(t.correctness, { pct: "-", value: null }, `${t.slug}: no correctness beside "not scored"`);
      } else if (t.counts.implemented > 0) {
        assert.equal(typeof t.correctness.value, "number", `${t.slug}: a scored row keeps its correctness`);
      }
      for (const [key, tier] of Object.entries(t.tiers)) {
        if (tier?.indeterminate > 0) assert.deepEqual(tier.correctness, { pct: "-", value: null }, `${t.slug} ${key}`);
      }
    }
    for (const slug of entry.notScored) {
      const t = buildLatest(m, site).targets.find((x) => x.slug === slug);
      assert.deepEqual(t.correctness, { pct: "-", value: null }, `${name}: ${slug}`);
    }
  });

  // A run with no answer at all has nothing to tally beneath its headline:
  // every area and capability is unanswered, with no figure, and there are no
  // findings. And on every row an area's counts fit inside the row's.
  test(`a row not scored at run level has no area or capability figure and no findings (${name})`, () => {
    const { model: m } = entry;
    const latest = buildLatest(m, site);
    let runLevel = 0;
    let areas = 0;
    for (const t of latest.targets) {
      for (const a of t.areas) {
        areas++;
        assert.equal(a.passed + a.failed + a.skipped + a.indeterminate, a.total, `${t.slug} ${a.key}: sums to its total`);
        // The counts that are the same in every region. Passes and fails are
        // not compared one by one: an area is tallied from the results file,
        // on the pinned region's answers, while the row is its headline
        // region's, and a split test is a pass in one and a fail in the other.
        const counts = { implemented: a.passed + a.failed, skipped: a.skipped, indeterminate: a.indeterminate, total: a.total };
        for (const [k, v] of Object.entries(counts)) {
          assert.ok(v <= t.counts[k], `${t.slug} ${a.key}: ${k} ${v} exceeds the row's ${t.counts[k]}`);
        }
      }
      for (const c of t.capabilities) {
        assert.equal(c.passed + c.failed + c.skipped + c.indeterminate, c.total, `${t.slug} ${c.key}: sums to its total`);
      }
      if (t.baseline || !(t.counts.total > 0 && t.counts.indeterminate === t.counts.total)) continue;
      runLevel++;
      const pt = m.perTarget[t.slug];
      assert.ok(t.areas.length > 0, `${t.slug}: keeps its areas, without figures`);
      for (const a of t.areas) {
        assert.equal(a.divergence.value, null, `${t.slug} ${a.key}: no divergence`);
        assert.equal(a.coverage.value, null, `${t.slug} ${a.key}: no coverage`);
        assert.equal(a.passed + a.failed + a.skipped, 0, `${t.slug} ${a.key}: no answered test counted`);
      }
      for (const c of t.capabilities) {
        assert.equal(c.passed + c.failed + c.skipped, 0, `${t.slug} ${c.key}: no answered test counted`);
      }
      assert.deepEqual(pt.findings, [], `${t.slug}: no findings`);
      assert.deepEqual(pt.breakdown, [], `${t.slug}: no breakdown`);
      assert.deepEqual(pt.supports, [], `${t.slug}: supports nothing it was not seen to`);
      assert.equal(pt.runUnanswered, true, `${t.slug}: the page is told why`);
      assert.deepEqual(pt.series.at(-1).findings, [], `${t.slug}: its run's page lists no findings`);
    }
    assert.ok(areas > 0, `${areas} areas were checked`);
    // A scenario named for a run-level refusal must reach the check above.
    if (/run level/.test(name)) assert.equal(runLevel, entry.notScored.length, `${name}: every refused row was checked`);
  });

  // A region's `rate` is the suite's pass rate there, and a region holding a
  // test that got no answer has no figure, so it publishes no rate either.
  test(`no region with an unanswered test publishes a rate (${name})`, () => {
    const { model: m } = entry;
    let regions = 0;
    let unanswered = 0;
    for (const t of buildLatest(m, site).targets) {
      for (const r of t.regions) {
        regions++;
        if (!(r.indeterminate > 0)) continue;
        unanswered++;
        assert.equal(r.rate, null, `${t.slug} ${r.region}: rate beside ${r.indeterminate} unanswered`);
        assert.equal(r.divergence.value, null, `${t.slug} ${r.region}: divergence`);
      }
    }
    assert.ok(regions > 0, `${regions} regions were checked`);
    if (entry.notScored.length) assert.ok(unanswered > 0, `${name}: ${unanswered} regions hold an unanswered test`);
  });

  // An area or capability where nothing was observed, no test passing or
  // failing and at least one unanswered, reads `unanswered`, never
  // `unsupported`: nobody saw the target decline it. One with an answer to
  // some of its tests keeps the state those answers give.
  test(`nothing observed reads unanswered, not unsupported (${name})`, () => {
    const { model: m } = entry;
    let entries = 0;
    let unobserved = 0;
    for (const t of buildLatest(m, site).targets) {
      for (const x of [...t.areas, ...t.capabilities]) {
        entries++;
        const observed = x.passed + x.failed > 0;
        if (!observed && x.indeterminate > 0) {
          unobserved++;
          assert.equal(x.state, "unanswered", `${t.slug} ${x.key}: ${x.state}`);
        } else {
          assert.notEqual(x.state, "unanswered", `${t.slug} ${x.key}: observed, or nothing unanswered`);
        }
      }
    }
    assert.ok(entries > 0, `${entries} areas and capabilities were checked`);
    // A run-level refusal leaves every one of them unobserved, and so does an
    // operation whose every test got no answer, so a scenario built for either
    // has to reach the check above.
    if (/run level/.test(name) || entry.wholeArea) assert.ok(unobserved > 0, `${name}: ${unobserved} had nothing observed`);
    // At test level the whole-area scenario is the only route to the state,
    // so it is checked on the area itself, not only somewhere on the board.
    if (entry.wholeArea) {
      const t = buildLatest(m, site).targets.find((x) => x.slug === entry.notScored[0]);
      const whole = t.areas.filter((a) => a.indeterminate > 0 && a.indeterminate === a.total);
      assert.ok(whole.length > 0, `${t.slug}: an area whose every test got no answer`);
      for (const a of whole) assert.equal(a.state, "unanswered", `${t.slug} ${a.key}`);
      assert.ok(t.areas.some((a) => a.passed + a.failed > 0), `${t.slug}: the rest of the run was answered`);
    }
  });
}

// A results file holding no test, with a run-level sidecar beside it. The
// suite counts nothing for it, so the row's counts are all zero, and it is not
// scored. Its features were never observed, so it reads as a run that got no
// answer rather than as "not supported" fourteen times, and it has no
// operation figure and no finding.
test("a run that recorded no test reads as a run that got no answer", () => {
  for (const sidecar of [RUN_LEVEL, null]) {
    const { model: m } = pipelineModel((ts) => {
      const t = ts.find((x) => x.slug === "dynalite");
      t.raw.testResults = t.raw.testResults.map((tr) => ({ ...tr, assertionResults: [] }));
      t.sidecar = sidecar;
    });
    const label = sidecar ? "with a sidecar" : "without one";
    const pt = m.perTarget.dynalite;
    const row = buildLatest(m, site).targets.find((t) => t.slug === "dynalite");
    assert.deepEqual(row.counts, { passed: 0, failed: 0, skipped: 0, indeterminate: 0, implemented: 0, total: 0 }, label);
    assert.equal(row.grade.qualifier, "not scored", label);
    assert.deepEqual(row.correctness, { pct: "-", value: null }, label);
    assert.equal(pt.runUnanswered, true, label);
    assert.deepEqual(pt.findings, [], label);
    assert.equal(row.capabilities.length, CAPABILITIES.length, label);
    for (const c of row.capabilities) assert.equal(c.passed + c.failed + c.skipped + c.indeterminate, 0, `${label}: ${c.key}`);
    for (const a of row.areas) assert.equal(a.divergence.value, null, `${label}: ${a.key}`);
    // No test at all, but a run that got no answer: `unanswered`, as any such
    // run's areas and capabilities read, rather than `unsupported`.
    for (const x of [...row.areas, ...row.capabilities]) assert.equal(x.state, "unanswered", `${label}: ${x.key}`);
    assert.ok(row.areas.length > 0, `${label}: ${row.areas.length} areas`);
    const card = renderTargetCapabilities(pt);
    const said = [...card.matchAll(/sr-only">([^<]*)</g)].map((x) => x[1]);
    assert.equal(said.filter((l) => l.endsWith(": not scored, because the run got no answer")).length, CAPABILITIES.length, `${label}: ${said[0]}`);
    const entry = renderFeatureSummary(pt, "core") + renderFeatureSummary(pt, "wider");
    assert.doesNotMatch(card + entry, /not supported|supported|not tested/, label);
  }
});
