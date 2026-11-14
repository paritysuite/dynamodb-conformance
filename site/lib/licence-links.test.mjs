import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import config from "../eleventy.config.js";
import { TARGETS, licenceOf } from "./scoring.mjs";
import { directoryEntriesIn, licenceGaps, licenceLinkIn } from "./licence-links.mjs";

// The filters as the templates see them, from the real config (the same stub
// filters.test.mjs uses), so a filter that is not registered, or registered
// with the wrong argument, fails here rather than rendering nothing.
function registeredFilters() {
  const filters = {};
  const anything = () => new Proxy(function () {}, { get: () => anything(), apply: () => undefined });
  const stub = new Proxy({}, { get: (_t, prop) => (prop === "addFilter" ? (name, fn) => void (filters[name] = fn) : anything()) });
  config(stub);
  return filters;
}

// The component, rendered by hand with the registered filter: it has one
// conditional link and two text slots, so substituting them is the whole of
// what WebC does to it. Kept honest by reading the component's own source, so
// an attribute renamed there breaks this rather than passing on a copy.
const COMPONENT = await readFile(new URL("../src/_includes/components/licence-link.webc", import.meta.url), "utf8");
const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function renderLicenceLink(licence, slug, name) {
  const l = licence(slug);
  if (!l) return "";
  const markup = COMPONENT.replace(/<!--[\s\S]*?-->/, "").trim();
  return markup
    .replace(/\swebc:if="[^"]*"/, "")
    .replace(/:href="licence\(slug\)\.url"/, `href="${escape(l.url)}"`)
    .replace(/(<span data-licence-name) @text="licence\(slug\)\.name"><\/span>/, `$1>${escape(l.name)}</span>`)
    .replace(/(<span class="sr-only") @text="[^"]*"><\/span>/, `$1>, licence of ${escape(name)} (opens in a new tab)</span>`);
}

test("the licence filter resolves a licence for every target in the registry", () => {
  // Every slug, not only those with a row on the committed board, so a target
  // has its licence before its first run puts it on the board.
  const { licence } = registeredFilters();
  assert.ok(licence, "licence filter is registered");
  const slugs = Object.keys(TARGETS);
  assert.ok(slugs.length >= 15, `${slugs.length} targets in the registry`);
  for (const slug of slugs) assert.deepEqual(licence(slug), licenceOf(slug), slug);
});

test("every target renders a licence link that reads back as its own licence", () => {
  const { licence } = registeredFilters();
  const pages = Object.keys(TARGETS).map((slug) => ({ slug, html: `<p>Licence: ${renderLicenceLink(licence, slug, TARGETS[slug].display)}</p>` }));
  assert.deepEqual(licenceGaps(pages, licenceOf), []);
  for (const { slug, html } of pages) assert.equal(licenceLinkIn(html).name, licenceOf(slug).name, slug);
});

test("a page with no licence link, or the wrong one, is reported", () => {
  const right = { name: "MIT", url: "https://example.com/LICENSE" };
  const link = (name, url) => `<p>Licence: <a href="${url}" data-licence><span data-licence-name>${name}</span><span class="sr-only"> (opens in a new tab)</span></a></p>`;
  const published = () => right;
  assert.deepEqual(licenceGaps([{ slug: "a", html: link("MIT", right.url) }], published), []);
  assert.equal(licenceGaps([{ slug: "a", html: "<p>MIT</p>" }], published).length, 1, "a bare name is not a link");
  assert.equal(licenceGaps([{ slug: "a", html: link("Apache-2.0", right.url) }], published).length, 1, "wrong name");
  assert.equal(licenceGaps([{ slug: "a", html: link("MIT", "https://example.com/other") }], published).length, 1, "wrong url");
  assert.equal(licenceGaps([{ slug: "a", html: link("MIT", right.url) }], () => null).length, 1, "nothing published");
});

test("the licence line carries its label and link and nothing else", () => {
  const right = { name: "MIT", url: "https://example.com/LICENSE" };
  const a = `<a href="${right.url}" data-licence><span data-licence-name>MIT</span><span class="sr-only">, licence of X (opens in a new tab)</span></a>`;
  const published = () => right;
  // Both rendered shapes: the target page's labelled span, the directory's bare label.
  assert.deepEqual(licenceGaps([{ slug: "a", html: `<p class="x"><span class="font-medium">Licence:</span>\n  ${a}\n</p>` }], published), []);
  assert.deepEqual(licenceGaps([{ slug: "a", html: `<p class="project-licence">Licence: ${a}</p>` }], published), []);
  // A classification after the link, a glyph before it, or one inside it.
  assert.equal(licenceGaps([{ slug: "a", html: `<p>Licence: ${a} (not open source)</p>` }], published).length, 1);
  assert.equal(licenceGaps([{ slug: "a", html: `<p>Licence: <svg aria-hidden="true"></svg>${a}</p>` }], published).length, 1);
  assert.equal(licenceGaps([{ slug: "a", html: `<p>Licence: ${a.replace("</a>", "<span>✓</span></a>")}</p>` }], published).length, 1);
  // A link that is not in a paragraph of its own.
  assert.equal(licenceGaps([{ slug: "a", html: a }], published).length, 1);
});

test("entity-encoded names and links read back as published", () => {
  const html = `<a href="https://example.com/?a=1&amp;b=2" data-licence><span data-licence-name>A &amp; B</span></a>`;
  assert.deepEqual(licenceLinkIn(html), { name: "A & B", url: "https://example.com/?a=1&b=2" });
});

test("the directory splits into one entry per project", () => {
  const html = `<article class="project-entry" id="project-a"><a data-licence href="u"><span data-licence-name>X</span></a></article><article class="project-entry" id="project-b"></article>`;
  assert.deepEqual(directoryEntriesIn(html).map((e) => e.slug), ["a", "b"]);
  assert.equal(licenceLinkIn(directoryEntriesIn(html)[1].html), null, "an entry does not borrow its neighbour's link");
});
