import { createHash } from "node:crypto";

import { classifyResults } from "dynamodb-conformance/scripts/lib/classify.mjs";

import { areaOf } from "./scoring.mjs";

// A finding is one target failing one test: what a per-run target page lists,
// and what a bug report would point at. Its identity is stable across the things
// that change without the test changing, which are cosmetic edits to the title
// and which run it was measured in.
//
// Skips are deliberately not findings. A skip is the target's own feature probe
// declining because it doesn't implement the operation, which is coverage rather
// than divergence; citing one reads as a defect report for something the
// maintainer never claimed. They stay visible on the target page instead.

// The repo-relative "tests/..." tail of a test file path. Results carry an
// absolute CI path; everything published is relative to the suite's repo root.
const testsKey = (file) => {
  const i = file.indexOf("tests/");
  return i >= 0 ? file.slice(i) : file;
};

// Every regex metacharacter, for escaping a path before it goes into a RegExp.
const RE_META = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s) => s.replace(RE_META, "\\$&");

// The first stack frame in the finding's own test file. Matching any in-suite
// frame would be enough to skip vitest internals, but not enough to be right: a
// helper in another test file, or a path quoted in the assertion's own error
// text, would hand back a line number that gets paired with this finding's file.
// The path is escaped, or its dots would match as wildcards and a frame like
// `gsiXtest.ts:99` could stand in for `gsi.test.ts`.
const frameIn = (file) => new RegExp(`${escapeRe(file)}:(\\d+):\\d+`);

// Identity folds the two things that change without the test changing: dash
// styling (the suite writes em dashes, the site renders hyphens) and runs of
// whitespace. Anything else is a different test.
export const normaliseName = (s) =>
  String(s ?? "")
    .replace(/[‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);

// A finding's id is a pure function of the test's name and the file it lives in,
// plus an ordinal when one file repeats a name (a parameterised test).
//
// The file is always included, not only when a name turns out to be ambiguous.
// Deciding that per run meant asking "did anything else with this name also
// fail?", which made the id depend on the target's whole failing set: the same
// test got one id on a target that failed a same-named sibling and a different
// one on a target that didn't, and an id changed when an unrelated test was
// fixed. Determinism is worth more here than surviving a file move, because
// these ids are page anchors, and an anchor that moves between two pages built
// from the same run is broken in a way a stale one is not.
export const findingId = (fullName, file, nth = 1) =>
  hash(`${normaliseName(fullName)}\0${file ? testsKey(file) : ""}${nth > 1 ? `\0${nth}` : ""}`);

// The test's source, pinned to the commit the results were published at, so a
// citation keeps pointing at the assertion it was made about rather than at
// whatever that file has become. Falls back to file level when no line was
// parseable, and to the default branch when the run carries no sha.
export function sourceUrl(finding, repoBase) {
  if (!finding?.file || !repoBase) return null;
  const ref = finding.sha || "main";
  const at = finding.line ? `#L${finding.line}` : "";
  return `${repoBase}/blob/${ref}/${finding.file}${at}`;
}

// The findings belonging to one operation area, for joining to the existing
// per-area breakdown the target page already renders.
export const findingsForArea = (findings, areaKey) => (findings ?? []).filter((f) => f.areaKey === areaKey);

// One list per area whether or not the snapshot carries finding records.
// Snapshots taken before findings existed still have the area's failure titles,
// so they render as entries with no identity: visible, just not citable. Keeping
// the shape uniform means the template has a single loop and no branching, which
// WebC can't express over a property of an outer loop variable anyway.
export function areaFailures(area, findings) {
  const records = findingsForArea(findings, area?.key);
  if (records.length) return records;
  return (area?.failures ?? []).map((fullName) => ({ id: null, fullName, line: null, file: null, sha: null }));
}

// Every failing assertion in one target's results, as records.
//
// meta carries what the results file itself doesn't: the version measured, and
// the commit the results were published at, so a source link can pin to it.
//
// A failing status is not enough. A test that got no answer records
// `status: "failed"` too, and listing it here put it under "where it falls
// short" as a divergence the target never made. The suite's classifier says
// which is which, as it does for every tally on the site.
export function findingsOf(raw, meta = {}) {
  return recordsOf(raw, meta, "fail");
}

// Every test in one target's results that got no answer, as records shaped
// like findings, each with the reason the suite recorded for it. Only a
// test-level reason is in a results file. A run that got no answer at all
// says so in a sidecar the site does not read, and its tests carry no marker,
// so for such a run this is empty rather than a list of the whole suite.
export function unansweredOf(raw, meta = {}) {
  return recordsOf(raw, meta, "indeterminate");
}

function recordsOf(raw, meta, verdictKept) {
  const rows = [];
  const verdicts = Array.isArray(raw?.testResults) ? classifyResults(raw, null) : [];
  let i = 0;

  for (const tr of raw?.testResults ?? []) {
    const area = areaOf(tr.name);
    const file = testsKey(tr.name);
    for (const ar of tr.assertionResults ?? []) {
      const verdict = verdicts[i++];
      if (!area || verdict?.verdict !== verdictKept) continue;
      const fullName = ar.fullName || ar.title || "(unnamed test)";
      const key = normaliseName(fullName);
      const reason = verdictKept === "indeterminate" ? (verdict.reason?.reason ?? null) : undefined;
      rows.push({ fullName, key, file, area, tags: ar.tags ?? [], messages: (ar.failureMessages ?? []).join("\n"), reason });
    }
  }

  // Occurrences of each name within each file, so a file that repeats a name can
  // separate the repeats by position. Keyed by file as well as name, so the
  // ordinal never depends on what happened in some other file.
  const seen = new Map();
  return rows.map((r) => {
    const perFile = `${r.file}\0${r.key}`;
    const nth = (seen.get(perFile) ?? 0) + 1;
    seen.set(perFile, nth);
    return {
      id: findingId(r.fullName, r.file, nth),
      fullName: r.fullName,
      tier: r.area.tier,
      group: r.area.group,
      areaKey: r.area.key,
      tags: r.tags,
      file: r.file,
      line: lineOf(r.messages, r.file),
      version: meta.version ?? null,
      sha: meta.sha ?? null,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    };
  });

  function lineOf(messages, file) {
    const m = frameIn(file).exec(messages ?? "");
    return m ? Number(m[1]) : null;
  }
}
