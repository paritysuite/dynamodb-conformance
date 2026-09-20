import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GUARDED_PAGES, KINDS, checkProseLiterals, scanProse } from "./prose-literals.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The rule exists because five claims drifted while the pages around them stayed
// derived. Two things therefore have to be true of it: the pages it guards pass
// today, and it fails the moment one of those claims is typed back in. The
// second is the one worth testing - a scan that has quietly stopped matching
// anything reports a clean page just as loudly as a clean page does.

const page = (body) => `---\nlayout: layouts/prose.webc\nlastmod: "2026-08-13"\n---\n\n${body}\n`;

test("the guarded pages carry no hand-typed figure beside a derived one", async () => {
  const { findings } = await checkProseLiterals(ROOT);
  assert.deepEqual(findings, []);
});

test("every page the rule names is actually scanned", async () => {
  const { findings, exemptions } = await checkProseLiterals(ROOT);
  const scanned = new Set([...findings, ...exemptions.map((e) => e.path)].map((f) => String(f).split(":")[0]));
  for (const p of GUARDED_PAGES) assert.ok(scanned.has(p), `${p} produced neither a finding nor an exemption`);
});

// A guard that can be quieted one benign marker at a time ends up decorative,
// and nothing about adding the sixteenth would have felt like a decision. Pinned
// so it is one. Adding a marker is legitimate - re-count and change this - but
// never raise it to make a red run go green: that is the moment to ask whether
// the figure under the new marker should have been derived instead.
const EXEMPTIONS_TODAY = 16;

test("the number of exempted paragraphs is pinned, so a new one is a deliberate edit", async () => {
  const { exemptions } = await checkProseLiterals(ROOT);
  assert.equal(
    exemptions.length,
    EXEMPTIONS_TODAY,
    `literal-figures exemptions changed:\n${exemptions.map((e) => `  ${e.path}:${e.line} ${e.kind} - ${e.note}`).join("\n")}`,
  );
});

// The synthetic cases below prove the rule. This one proves it on the pages it
// actually guards: each drifted claim is put back into the real file, exactly as
// it was written before, and the scan has to catch it there. A rule that passes
// its own fixtures and misses the page it was written for is the failure mode
// worth spending a test on.
test("each claim that drifted, put back into its own page, fails the scan", () => {
  for (const [page, before, after] of [
    [
      "site/src/about.md",
      "It currently holds {{ splits.count | countWord }} rows",
      "It currently holds three rows",
    ],
    [
      "site/src/methodology.md",
      "against a registry of {{ splits.count | countWord }} confirmed splits",
      "and the registry holds exactly three confirmed splits",
    ],
    [
      "site/src/methodology.md",
      "{{ summary.latest | cappedExamples }}",
      "Dynalite diverged 12.3%, the B band on its own, but implemented 80.0% coverage.",
    ],
    [
      "site/src/methodology.md",
      "carries {{ suite.byOperation.putItem | formatNumber }} of the suite's tests",
      "carries 115 of the suite's tests",
    ],
  ]) {
    const source = readFileSync(join(ROOT, page), "utf8");
    assert.ok(source.includes(before), `${page} no longer contains "${before}"; update this test with it`);
    const { findings } = scanProse(page, source.replace(before, after));
    assert.equal(findings.length > 0, true, `reintroducing "${after}" into ${page} did not fail the scan`);
  }
});

test("a literal split count typed back in fails the scan", () => {
  const { findings } = scanProse(
    "about.md",
    page("The registry is public. It currently holds three rows, and every one of them is confirmed."),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /three rows/);
});

test("a literal figure beside each derived term fails the scan", () => {
  for (const [term, sentence] of [
    ["splits", "The registry holds exactly three confirmed splits."],
    ["divergence", "Dynalite diverged 12.3% on the run before this one."],
    ["coverage", "It implemented 80.0% coverage."],
    ["regions", "The target fails in 26 regions."],
    ["tests", "putItem alone carries 115 of the suite's tests."],
  ]) {
    const { findings } = scanProse("methodology.md", page(sentence));
    assert.equal(findings.length > 0, true, `no finding for the ${term} case: ${sentence}`);
  }
});

test("a derived figure is not a literal", () => {
  const { findings } = scanProse(
    "about.md",
    page("It currently holds {{ splits.count | countWord }} rows{% if splits.count != 1 %}s{% endif %}."),
  );
  assert.deepEqual(findings, []);
});

test("a marker exempts its own paragraph and nothing after it", () => {
  const { findings, exemptions } = scanProse(
    "methodology.md",
    page(
      "<!-- literal-figures: historical, the 24 July 2026 withdrawal -->\n" +
        "On 24 July 2026, 88 of its failing tests became skips.\n\n" +
        "The registry holds exactly three confirmed splits.",
    ),
  );
  assert.equal(exemptions.length, 1);
  assert.equal(exemptions[0].kind, "historical");
  assert.equal(findings.length, 1);
  assert.match(findings[0], /three confirmed splits/);
});

test("a historical marker over a paragraph with no year is itself a failure", () => {
  const { findings, exemptions } = scanProse(
    "methodology.md",
    page("<!-- literal-figures: historical, the 24 July 2026 withdrawal -->\n88 of its failing tests became skips."),
  );
  assert.deepEqual(exemptions, []);
  assert.match(findings[0], /names no year/);
});

test("an unknown marker kind is a failure, not a silent exemption", () => {
  const { findings, exemptions } = scanProse(
    "methodology.md",
    page("<!-- literal-figures: vibes, because I say so -->\nThe registry holds exactly three confirmed splits."),
  );
  assert.deepEqual(exemptions, []);
  assert.match(findings[0], /unknown literal-figures kind/);
  for (const kind of Object.keys(KINDS)) assert.match(findings[0], new RegExp(kind));
});

test("a marker that does not parse is reported rather than treated as a comment", () => {
  const { findings, exemptions } = scanProse(
    "methodology.md",
    page("<!-- literal-figures: historical -->\nOn 24 July 2026, 88 of its failing tests became skips."),
  );
  assert.deepEqual(exemptions, []);
  assert.match(findings[0], /malformed literal-figures marker/);
});

test("a marker with nothing under it is a failure", () => {
  const { findings } = scanProse("methodology.md", page("<!-- literal-figures: criteria, the bands -->"));
  assert.match(findings[0], /exempts nothing/);
});

test("dates, tier labels and code spans are not figures", () => {
  const { findings } = scanProse(
    "methodology.md",
    page(
      "On 24 July 2026 the regions converged again. " +
        'A "0.0% Tier 1" reading means nothing wrong among the Tier 1 tests that exist. ' +
        "The `count` field holds 1054 of them.",
    ),
  );
  assert.deepEqual(findings, []);
});

test("a figure and a term in different sentences are not adjacent", () => {
  const { findings } = scanProse(
    "methodology.md",
    page("Every figure is scored per region. Three passes have to report before the baseline claims the suite."),
  );
  assert.deepEqual(findings, []);
});
