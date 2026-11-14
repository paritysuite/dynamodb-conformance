import { test } from "node:test";
import assert from "node:assert/strict";

// The per-operation table is the most detailed set of figures on a target page,
// so it is the last place a correctness percentage could have survived the
// conversion and read as though the target were improving while its headline
// said the opposite.
test("renderTargetOperations reports each area as divergence with coverage beside it", async () => {
  const { renderTargetOperations } = await import("./matrix.mjs");
  const areas = [
    { key: "tier1/getItem", tier: "tier1", group: "getItem", passed: 40, failed: 0, skipped: 0, total: 40, state: "supported" },
    { key: "tier1/createTable", tier: "tier1", group: "createTable", passed: 23, failed: 7, skipped: 0, total: 30, state: "partial" },
    { key: "tier2/transactions", tier: "tier2", group: "transactions", passed: 0, failed: 62, skipped: 0, total: 62, state: "failing" },
    { key: "tier2/streams", tier: "tier2", group: "streams", passed: 0, failed: 0, skipped: 18, total: 18, state: "unsupported" },
  ];
  const html = renderTargetOperations(areas);
  assert.match(html, /Tier 1 - Core/);
  assert.match(html, /Tier 2 - Complete/);
  assert.match(html, /getItem/);
  assert.match(html, /0\.0%/); // getItem diverges nowhere
  assert.match(html, /23\.3%/); // createTable: 7 of 30, not the 76.7% it read as correctness
  assert.match(html, /100\.0%/); // transactions diverges on all of them
  assert.match(html, /n\/a/); // streams: nothing implemented, so no divergence to report
  assert.match(html, /18 skip/);
  // Counts are fails over the operation's whole size, matching the figure.
  assert.match(html, /7\/30/);
});

// An operation a target declines has no divergence, and its coverage is what
// says so. Reporting 0.0% there would read as flawless.
test("renderTargetOperations gives an unimplemented operation no divergence and zero coverage", async () => {
  const { renderTargetOperations } = await import("./matrix.mjs");
  const html = await renderTargetOperations([
    { key: "tier2/streams", tier: "tier2", group: "streams", passed: 0, failed: 0, skipped: 18, total: 18, state: "unsupported" },
  ]);
  assert.match(html, /n\/a/);
  assert.match(html, /0\.0%/);
  assert.doesNotMatch(html, /100\.0%/);
});

// An area holding indeterminates beside passes and fails is not scored, like a
// run holding them. Reading its null figures as "implements none of it" put
// that sentence beside 56 passes.
test("renderTargetOperations says an area with an unanswered test is not scored", async () => {
  const { renderTargetOperations } = await import("./matrix.mjs");
  const html = renderTargetOperations([
    { key: "tier1/putItem", tier: "tier1", group: "putItem", passed: 56, failed: 73, skipped: 0, indeterminate: 1, total: 130, state: "partial" },
    { key: "tier1/getItem", tier: "tier1", group: "getItem", passed: 30, failed: 5, skipped: 2, indeterminate: 3, total: 40, state: "partial" },
  ]);
  const figures = [...html.matchAll(/w-14 text-right font-mono[^"]*">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(figures, ["-", "-", "-", "-"], "both columns of both rows read -");
  assert.match(html, /putItem: not scored, because 1 test got no answer \(56 pass, 73 fail\)/);
  assert.match(html, /getItem: not scored, because 3 tests got no answer \(30 pass, 5 fail, 2 skip\)/);
  assert.doesNotMatch(html, /implements none|n\/a|NaN/);
});

// The state is read from the answered tests alone, so beside an unanswered one
// it can say "supported" with a tick, or "unsupported" with nothing answered at
// all. The row shows a neutral mark and no state word instead.
test("renderTargetOperations gives an area with an unanswered test no state to contradict it", async () => {
  const { renderTargetOperations } = await import("./matrix.mjs");
  const rows = [
    { group: "query", passed: 0, failed: 0, skipped: 0, indeterminate: 4, total: 4, state: "unsupported", line: "query: not scored, because 4 tests got no answer<" },
    { group: "batchGetItem", passed: 1, failed: 0, skipped: 0, indeterminate: 1, total: 2, state: "supported", line: "batchGetItem: not scored, because 1 test got no answer (1 pass)<" },
    { group: "scan", passed: 0, failed: 0, skipped: 3, indeterminate: 2, total: 5, state: "unsupported", line: "scan: not scored, because 2 tests got no answer (3 skip)<" },
  ];
  for (const { line, ...area } of rows) {
    const html = renderTargetOperations([{ key: `tier1/${area.group}`, tier: "tier1", ...area }]);
    assert.ok(html.includes(`sr-only">${line}`), `${area.group}: ${html.match(/sr-only">([^<]*)/)?.[1]}`);
    assert.match(html, /aria-hidden="true">\?</, `${area.group} shows the neutral mark`);
    assert.doesNotMatch(html, /✓|✗|◑|–|supported|failing/, `${area.group} shows no state`);
  }
});

test("renderTargetOperations is empty when a target has no areas", async () => {
  const { renderTargetOperations } = await import("./matrix.mjs");
  assert.equal(renderTargetOperations([]), "");
});
