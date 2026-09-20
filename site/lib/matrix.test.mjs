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

test("renderTargetOperations is empty when a target has no areas", async () => {
  const { renderTargetOperations } = await import("./matrix.mjs");
  assert.equal(renderTargetOperations([]), "");
});
