import { test } from "node:test";
import assert from "node:assert/strict";

import { TARGETS, configurationOf, isVariant, rowConfigurationOf } from "./scoring.mjs";

// The standings name a project's row the way the README table does: the
// project, then the configuration its figures belong to. Both read one
// definition, so these pin what that definition says for every target in the
// registry rather than for a hand-picked pair.

const slugs = Object.keys(TARGETS);
const projectRowsWithConfiguration = slugs.filter((s) => !isVariant(s) && configurationOf(s));
const variants = slugs.filter((s) => isVariant(s));

test("the registry has project rows with a configuration and builds nested below them", () => {
  // Asserted so the per-target checks below cannot pass over an empty list.
  assert.ok(projectRowsWithConfiguration.length > 0, `${slugs.length} targets, none a project row with a configuration`);
  assert.ok(variants.length > 0, `${slugs.length} targets, no builds`);
});

test("every project row with a configuration names it on the standings", () => {
  for (const slug of projectRowsWithConfiguration) {
    assert.equal(rowConfigurationOf(slug), configurationOf(slug), slug);
  }
});

test("a build never names its configuration a second time beside its own name", () => {
  // A build stands for its project only when the reference build recorded
  // nothing, and its display name already carries the configuration.
  for (const slug of variants) assert.equal(rowConfigurationOf(slug), null, slug);
});

test("a target with no configuration is named by its display name alone", () => {
  for (const slug of slugs.filter((s) => !configurationOf(s))) {
    assert.equal(rowConfigurationOf(slug), null, slug);
  }
});
