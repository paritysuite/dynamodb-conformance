import { test } from "node:test";
import assert from "node:assert/strict";

import { targetLinks, urlLabel, targetRunHref } from "./links.mjs";

test("urlLabel strips the scheme, www and a trailing slash", () => {
  assert.equal(urlLabel("https://dynoxide.dev"), "dynoxide.dev");
  assert.equal(urlLabel("https://extenddb.org/"), "extenddb.org");
  assert.equal(urlLabel("https://www.example.com/path/"), "example.com/path");
  assert.equal(urlLabel(null), null);
});

test("a code-host URL becomes the source, with the site listed alongside", () => {
  const links = targetLinks("dynoxide", "https://github.com/nubo-db/dynoxide");
  assert.equal(links.source.url, "https://github.com/nubo-db/dynoxide");
  assert.equal(links.source.label, "github.com/nubo-db/dynoxide");
  assert.equal(links.source.host, "github.com");
  assert.equal(links.website.url, "https://dynoxide.dev");
  assert.equal(links.website.label, "dynoxide.dev");
});

// The two AWS rows carry a product or docs page where the emulators carry a
// repo. It's a site, not source, and must not be labelled as source.
test("a non-code URL becomes the site, leaving no source", () => {
  const links = targetLinks("dynamodb", "https://aws.amazon.com/dynamodb/");
  assert.equal(links.source, null);
  assert.equal(links.website.url, "https://aws.amazon.com/dynamodb/");
  assert.equal(links.website.label, "aws.amazon.com/dynamodb");
});

test("a target with source but no site offers only the source", () => {
  const links = targetLinks("dynalite", "https://github.com/architect/dynalite");
  assert.equal(links.website, null);
  assert.equal(links.source.label, "github.com/architect/dynalite");
});

test("a target with no URL at all offers neither", () => {
  assert.deepEqual(targetLinks("mystery", null), { website: null, source: null });
});

test("source is recognised on code hosts other than GitHub", () => {
  for (const url of [
    "https://gitlab.com/acme/engine",
    "https://codeberg.org/acme/engine",
    "https://bitbucket.org/acme/engine",
  ]) {
    const links = targetLinks("acme", url);
    assert.equal(links.source.url, url, `${url} should read as source`);
    assert.equal(links.website, null);
  }
});

test("a malformed URL is not mistaken for source", () => {
  const links = targetLinks("acme", "not a url");
  assert.equal(links.source, null);
  assert.equal(links.website.url, "not a url");
});

// Every target the board scores, so a new engine landing without a site or
// source is caught here rather than rendering a blank pair of links.
test("every scored target resolves at least one link", async () => {
  const { REPO } = await import("./scoring.mjs");
  for (const slug of Object.keys(REPO)) {
    const links = targetLinks(slug, REPO[slug]);
    assert.ok(links.website || links.source, `${slug} should resolve a link`);
  }
});

// LocalStack's registry URL is its site: the GitHub repository is archived and
// its licence file is not the licence of the image measured, so the row offers
// no source link beside a licence that is not that repository's.
test("LocalStack resolves to its site and no source", async () => {
  const { REPO } = await import("./scoring.mjs");
  const links = targetLinks("localstack", REPO.localstack);
  assert.equal(links.source, null);
  assert.equal(links.website.label, "localstack.cloud");
});

test("targetRunHref sends a run's row to that target's results for that date", () => {
  assert.equal(targetRunHref({ slug: "dynoxide", reTested: true }, "2026-07-20"), "/targets/dynoxide/2026-07-20");
});

test("targetRunHref sends the latest table's row to the target's current page", () => {
  // The homepage passes no run, because its table is always the newest run.
  assert.equal(targetRunHref({ slug: "dynoxide", reTested: true }, null), "/targets/dynoxide");
});

test("targetRunHref sends a carried-forward row to the current page, not a page that was never built", () => {
  assert.equal(targetRunHref({ slug: "dynalite", reTested: false }, "2026-07-20"), "/targets/dynalite");
});

test("targetRunHref sends the baseline to its current page, since no dated page exists for it", () => {
  // Keyed on `baseline`, the same flag targetRunsOf/matrix/capabilities exclude
  // pages by, so a target that gets no dated pages also gets no dated links and
  // cannot 404. Before this, linking keyed on `synthesised` and page-building on
  // `baseline`, so a baseline-but-not-synthesised row would have linked to an
  // unbuilt page.
  assert.equal(targetRunHref({ slug: "dynamodb", reTested: true, baseline: true }, "2026-07-20"), "/targets/dynamodb");
});
