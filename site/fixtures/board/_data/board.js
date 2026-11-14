// Rows for the fixture board: one project whose second build reads the same
// figures as its reference build, and one whose second build differs.
//
// The closed disclosure has never rendered anywhere. No run the suite has
// recorded holds a matching pair, so every build of every project on the real
// board starts open, and the branch a reader meets as a closed disclosure is
// reachable only by seeding one. That is what this does: it takes the committed
// fallback - a real model, with every field a row carries - and gives it a pair
// that agrees, then lets the ordinary pipeline decide what that means.
//
// Both builds are real registry targets rather than invented slugs, because a
// slug the registry does not know is not a build of anything: the nesting, the
// configuration name and the disclosure all read the registry, so a made-up
// variant would render as a project of its own and prove nothing.
//
// Nothing here is published. The pages this renders are built into a temporary
// directory by scripts/check-build.mjs, asserted on, and thrown away.
//
// It sits here rather than beside the JSON fixtures in test/ because node's
// test runner treats every .js file under a test/ directory as a test file,
// and this one would have joined the run as a green tick that asserts nothing.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isNotScored, sortRows } from "../../../lib/scoring.mjs";

// Figures for a reference build whose own run is not scored (see below).
const SCORED = { divergence: "1.2%", coverage: "95.0%", divergenceValue: 1.2, coverageValue: 95 };

const MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "conformance-history.json");

export default async function () {
  const model = JSON.parse(await readFile(MODEL_PATH, "utf8"));
  const rows = structuredClone(model.latest.standings).filter((r) => !r.synthesised);

  const dynoxide = rows.find((r) => r.slug === "dynoxide");
  const wasm = rows.find((r) => r.slug === "dynoxide-wasm");
  const extenddb = rows.find((r) => r.slug === "extenddb");
  if (!dynoxide || !wasm || !extenddb) throw new Error("the fixture lost a target it was built around");

  // Both sides measured in this run, seeded on both rows rather than only the
  // build. The rule reads the parent's flag too, so leaving that one to the
  // committed model made the closed branch depend on which run the snapshot
  // was taken from: it renders closed today because Dynoxide happens to have
  // been re-tested, and a later snapshot catching its row carried forward -
  // which is what the wasm build is doing in this very model - would flip this
  // fixture open and fail the check that asserts it closed, for a reason with
  // nothing to do with disclosures.
  Object.assign(dynoxide, { carried: false, reTested: true });
  // A pair that is not scored never closes, since nobody knows its figures, so
  // a reference build whose latest run is not scored gets scored ones here.
  if (isNotScored(dynoxide)) Object.assign(dynoxide, SCORED);

  // The agreement. Only the three figures the disclosure reads are copied;
  // the version, the tier breakdown and the region cohort stay as measured,
  // because a build agreeing on what is printed and differing underneath is
  // exactly the case a disclosure suits and a fold did not.
  Object.assign(wasm, {
    divergence: dynoxide.divergence,
    coverage: dynoxide.coverage,
    divergenceValue: dynoxide.divergenceValue,
    coverageValue: dynoxide.coverageValue,
    // And measured in the same run as the row above. Both clauses of the rule
    // have to hold: the committed model carries this build from an earlier
    // run, and a carried build starts open however its figures read. The
    // carried case has its own page, carried.webc.
    carried: false,
    reTested: true,
    runDate: dynoxide.runDate,
  });

  // And a build that differs, so both branches render in one page. ExtendDB's
  // SQLite build is in the registry; when it has recorded a run the model
  // already holds its row and only the figures are moved, and until then one
  // is synthesised from its PostgreSQL sibling. Pushing unconditionally would
  // put the slug in twice the moment the first run lands - two links to the
  // same page under "Also built for SQLite and SQLite", with check-build
  // still green.
  const differs = { divergence: "4.8%", coverage: "83.4%", divergenceValue: 4.8, coverageValue: 83.4, carried: false, reTested: true };
  const existing = rows.find((r) => r.slug === "extenddb-sqlite");
  const sqlite = existing
    ? Object.assign(existing, differs)
    : rows[rows.push({
        ...structuredClone(extenddb),
        slug: "extenddb-sqlite",
        display: "ExtendDB (SQLite)",
        target: "[ExtendDB (SQLite)](https://github.com/extenddb/extenddb)",
        ...differs,
      }) - 1];

  sortRows(rows);
  return {
    runId: model.latest.id,
    // Only the projects with a build under them; the rest would render rows
    // with nothing to disclose.
    rows: rows.filter((r) => r.isParent && r.variants?.length),
    closed: wasm.slug,
    open: sqlite.slug,
  };
}
