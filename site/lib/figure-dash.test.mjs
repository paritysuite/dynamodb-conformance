import { test } from "node:test";
import assert from "node:assert/strict";

import { FIGURE_DASH, figureDashIn } from "./figure-dash.mjs";

// Every shape a missing figure has taken in a sentence on the site.
const POSITIVES = [
  "answers - of the suite differently from real DynamoDB",
  "implements - of the suite and diverges on -",
  "grade not scored; diverges - of the suite; covers -; diverges per tier",
  "covers -",
  "covers –.",
  "· covers - How to run it",
  "not scored · covers - · capped at C",
  "diverges on - of it, covers 96.7%",
  "up to - in the other 5",
  "Tier 1 · Core - diverges 0.0% covered",
  "- covered",
  "(- of the suite)",
  "- / - / -",
  "tiers - / - / - this run",
];

// Dashes that are not a figure's place.
const NEGATIVES = [
  "implements - and these",
  "BatchGetItem - exact error messages malformed table name",
  "PutItem - ConditionExpression with attribute_exists - rejects a missing item",
  "Phoenix-Adapters - Not scored: 410 of 1,678 tests got no answer",
  "covers 96.7% (50 pass, 38 fail, 3 skip)",
  "diverges on 41.8% of it",
  "up to 2.1% in the other 5",
  "-",
  "Divergence - Coverage",
  "2026-11-09 - 2026-11-14",
  "covers-all",
  "re-covers - the list goes on",
];

test("every crafted missing figure is caught", () => {
  for (const s of POSITIVES) assert.ok(FIGURE_DASH.test(s), `should match: ${s}`);
});

test("no crafted ordinary dash is caught", () => {
  for (const s of NEGATIVES) assert.equal(figureDashIn(s), null, `should not match: ${s}`);
});
