import { test } from "node:test";
import assert from "node:assert/strict";

import { formatNumber } from "./numbers.mjs";

// The suite passed 1000 tests in 2026-09, so every published count is now in
// the range where grouping applies. These pin the boundary rather than the
// locale: the formatter is en-GB, and a build that picked up the runner's
// locale instead would group differently or not at all.
test("counts group at the thousand boundary", () => {
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(7), "7");
  assert.equal(formatNumber(999), "999");
  assert.equal(formatNumber(1000), "1,000");
  assert.equal(formatNumber(1251), "1,251");
  assert.equal(formatNumber(1234567), "1,234,567");
});

// An absent figure is a dash, not "null" and not "0". check-build scans every
// built page for "undefined" and "NaN" appearing as a figure, so the shape of
// this branch is what keeps a missing value from reading as a measurement.
test("an absent count renders as a dash, never as a number", () => {
  assert.equal(formatNumber(null), "–");
  assert.equal(formatNumber(undefined), "–");
  assert.notEqual(formatNumber(null), "0");
});

// Presentation only: the formatter never sees a value the scorer derived, so a
// string coming back out of it must never be fed to arithmetic or to a figure a
// consumer parses. These assert it is the presentation layer, not a converter.
test("formatting is a string, and leaves the numeric value alone", () => {
  assert.equal(typeof formatNumber(1000), "string");
  assert.equal(Number(formatNumber(1000).replace(/,/g, "")), 1000);
});
