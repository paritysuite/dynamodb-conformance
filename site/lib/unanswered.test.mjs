import { test } from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS } from "../fixtures/not-scored-models.mjs";
import { findingsOf, unansweredOf } from "./findings.mjs";
import { notScoredScope, notScoredShort, notScoredStatement, reasonCounts, reasonWords, unansweredByArea } from "./unanswered.mjs";

// A row shaped like a board row: counts and the two withheld figures.
const row = (passed, failed, skipped, indeterminate) => ({
  passed,
  failed,
  skipped,
  indeterminate,
  count: passed + failed + skipped + indeterminate,
  divergenceValue: indeterminate > 0 ? null : 1,
  coverageValue: indeterminate > 0 ? null : 50,
});
const records = (byReason) => Object.entries(byReason).flatMap(([reason, n]) => Array.from({ length: n }, () => ({ reason })));

test("a test-level statement says how many tests got no answer, why, and what the rest did", () => {
  const r = row(437, 710, 121, 410);
  const s = notScoredStatement(r, { records: records({ transport: 401, "table-active-timeout": 9 }) });
  assert.equal(
    s.text,
    "Not scored: 410 of 1,678 tests got no answer (401 a transport failure or 5xx, 9 a table that never became active), so the suite gives no letter or figures for this run. 437 passed, 710 failed, 121 not attempted.",
  );
  assert.match(s.html, /^<span aria-hidden="true">Not scored: <\/span>410 of 1,678 <a href="\/methodology#when-a-test-gets-no-answer"[^>]*>tests got no answer<\/a> \(/);
  assert.doesNotMatch(s.text, /(^|\s)-(\s|$)/, "no dash stands in for a figure");
});

test("one unanswered test reads in the singular where it counts, and keeps the suite's total", () => {
  const r = row(1500, 300, 119, 1);
  const s = notScoredStatement(r, { records: records({ transport: 1 }) });
  assert.match(s.text, /^Not scored: 1 of 1,920 tests got no answer \(1 a transport failure or 5xx\), so/);
  assert.equal(notScoredShort(r).text, "1 of 1,920 tests got no answer");
  const one = { ...row(0, 0, 0, 1), passed: 0 };
  assert.equal(notScoredStatement(one).text, "Not scored: the run got no answer, so the suite gives no letter or figures for it.", "one test of one is the whole run");
  const lone = { passed: 0, failed: 0, skipped: 1, indeterminate: 0, count: 1, divergenceValue: null, coverageValue: 0 };
  assert.equal(notScoredStatement(lone).text, "Not scored: it implements none of the suite's 1 test.");
});

test("the reasons are stated only when the records account for every unanswered test", () => {
  const r = row(10, 0, 0, 3);
  assert.equal(reasonCounts(r, records({ transport: 2 })), null, "two records for three tests says nothing about the third");
  assert.doesNotMatch(notScoredStatement(r, { records: records({ transport: 2 }) }).text, /\(/);
  assert.doesNotMatch(notScoredStatement(r, { records: null }).text, /\(/);
  assert.deepEqual(reasonCounts(r, records({ transport: 2, "import-timeout": 1 })).map((x) => [x.reason, x.count]), [["transport", 2], ["import-timeout", 1]]);
});

test("a reason with no words is named neutrally, never printed as its code", () => {
  assert.equal(reasonWords("http-5xx"), "another reason");
  assert.equal(reasonWords(null), "another reason");
  assert.equal(reasonWords("throttle-exhausted"), "throttling that outlasted the retries");
  const s = notScoredStatement(row(10, 0, 0, 3), { records: records({ transport: 1, "http-5xx": 1, "disk-on-fire": 1 }) });
  assert.match(s.text, /\(2 another reason, 1 a transport failure or 5xx\)/, "two unworded codes are one reason to a reader");
});

test("a row that implements none of the suite says so, in place of its dashes", () => {
  const none = { display: "Zed", passed: 0, failed: 0, skipped: 1678, unsupported: 1678, indeterminate: 0, count: 1678, divergenceValue: null, coverageValue: 0 };
  const s = notScoredStatement(none);
  assert.equal(s.text, "Not scored: it implements none of the suite's 1,678 tests.");
  assert.doesNotMatch(s.html, /<a /, "nothing here went unanswered, so nothing links to that rule");
  assert.equal(notScoredShort(none).text, "implements none of 1,678 tests");
  assert.equal(notScoredScope(none), "Zed implements none of the suite's 1,678 tests.");
});

test("a not-scored row's scope note counts what it answered, not a score", () => {
  const r = { ...row(437, 710, 121, 410), display: "Phoenix-Adapters", unsupported: 121 };
  assert.equal(notScoredScope(r), "Phoenix-Adapters answered 1,147 of 1,678 tests; 121 cover operations it does not support; 410 got no answer.");
  const one = { ...row(10, 0, 1, 1), display: "One", unsupported: 1 };
  assert.equal(notScoredScope(one), "One answered 10 of 12 tests; 1 covers an operation it does not support; 1 got no answer.");
  const run = { display: "Run", passed: 0, failed: 0, skipped: 0, indeterminate: 9, count: 9, divergenceValue: null, coverageValue: null };
  assert.equal(notScoredScope(run), "Run's run got no answer, so none of its tests counted.");
  assert.doesNotMatch(notScoredScope(run), /\d/, "a run that got no answer has no figures to give");
  assert.equal(notScoredScope(row(90, 10, 0, 0)), null);
});

test("a run that got no answer says so, with no count and no reason", () => {
  const r = { passed: 0, failed: 0, skipped: 0, indeterminate: 1678, count: 1678, divergenceValue: null, coverageValue: null };
  assert.equal(notScoredStatement(r).text, "Not scored: the run got no answer, so the suite gives no letter or figures for it.");
  assert.equal(notScoredShort(r).text, "the run got no answer");
  const empty = { passed: 0, failed: 0, skipped: 0, indeterminate: 0, count: 0, divergenceValue: null, coverageValue: null };
  assert.equal(notScoredStatement(empty).text, "Not scored: the run got no answer, so the suite gives no letter or figures for it.");
});

test("a scored row has no statement", () => {
  assert.equal(notScoredStatement(row(90, 10, 0, 0)), null);
  assert.equal(notScoredShort(row(90, 10, 0, 0)), null);
});

// From the pipeline: the tests that got no answer are listed with their
// reasons, apart from the findings, and the two lists never share a test. The
// findings were read from the raw status, which an unanswered test also
// records as "failed", so a not-scored page listed every one of them as a
// divergence.
for (const s of SCENARIOS) {
  test(`unanswered tests are listed apart from the findings, each with its reason (${s.name})`, () => {
    const { model } = s.build();
    let checked = 0;
    for (const slug of s.notScored) {
      const pt = model.perTarget[slug];
      const current = pt.current;
      if (pt.runUnanswered) {
        assert.deepEqual(pt.unanswered, [], `${slug}: a run with no answer lists no test, having no marker on any`);
        continue;
      }
      checked++;
      assert.equal(pt.unanswered.length, current.indeterminate, `${slug}: one record per unanswered test`);
      for (const u of pt.unanswered) assert.ok(u.reason, `${slug}: ${u.fullName} carries a reason`);
      const ids = new Set(pt.findings.map((f) => `${f.file}\0${f.fullName}`));
      for (const u of pt.unanswered) assert.ok(!ids.has(`${u.file}\0${u.fullName}`), `${slug}: ${u.fullName} is not also a finding`);
      const failed = pt.breakdown.reduce((n, a) => n + a.failed, 0);
      assert.equal(pt.findings.length, failed, `${slug}: the findings are the failures and nothing else`);
      assert.equal(unansweredByArea(pt.unanswered).reduce((n, a) => n + a.tests.length, 0), pt.unanswered.length);
      const said = notScoredStatement(current, { records: pt.unanswered }).text;
      // The sentence counts what the lists under it hold: its failures are the
      // findings, from the same results file, whatever another region said.
      assert.equal(current.failed, pt.findings.length, `${slug}: the row's failed count is its findings`);
      assert.ok(said.includes(`, ${current.failed.toLocaleString("en-GB")} failed,`), `${slug}: "${said}"`);
      for (const { reason, count } of reasonCounts(current, pt.unanswered)) {
        assert.ok(said.includes(`${count} ${reasonWords(reason)}`), `${slug}: "${said}" names ${count} ${reason}`);
      }
    }
    if (s.notScored.length && !/run level/.test(s.name)) assert.ok(checked > 0, `${s.name}: ${checked} rows checked`);
  });
}

test("findingsOf and unansweredOf split a results file by verdict, not by status", () => {
  const ar = (title, status, meta) => ({ title, fullName: title, status, failureMessages: [], ...(meta ? { meta } : {}) });
  const raw = {
    testResults: [
      {
        name: "/ci/tests/tier1/putItem/basic.test.ts",
        assertionResults: [
          ar("fails", "failed"),
          ar("no answer", "failed", { indeterminate: { reason: "transport", at: "test" } }),
          ar("passes", "passed"),
        ],
      },
    ],
  };
  assert.deepEqual(findingsOf(raw).map((f) => f.fullName), ["fails"]);
  const u = unansweredOf(raw);
  assert.deepEqual(u.map((f) => [f.fullName, f.reason]), [["no answer", "transport"]]);
});
