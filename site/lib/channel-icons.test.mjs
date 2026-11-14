import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNEL_ICONS, channelIcon } from "./channel-icons.mjs";
import { CHANNELS } from "dynamodb-conformance/scripts/summarise.mjs";

// The standings draw a target's channels through channelIcon and drop any that
// come back without a mark. So a channel added to the registry's vocabulary
// with no mark here disappears from every row that claims it, silently - the
// target page still lists it, and nothing else fails. The registry's own test
// keeps every claimed channel inside this vocabulary.

const vocabulary = Object.keys(CHANNELS);

test("every channel in the registry's vocabulary has a mark, labelled as the registry labels it", () => {
  assert.ok(vocabulary.length > 0, "CHANNELS is empty");
  const missing = vocabulary.filter((c) => !channelIcon(c)?.path);
  assert.deepEqual(missing, [], `${vocabulary.length} channels, no mark for: ${missing.join(", ")}`);
  for (const c of vocabulary) assert.equal(CHANNEL_ICONS[c].label, CHANNELS[c], c);
});

test("no mark is kept for a channel the registry does not define", () => {
  const extra = Object.keys(CHANNEL_ICONS).filter((c) => !(c in CHANNELS));
  assert.deepEqual(extra, []);
});
