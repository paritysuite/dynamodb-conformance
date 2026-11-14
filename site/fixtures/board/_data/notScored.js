// The not-scored fixture (../not-scored-board.mjs) over the committed model.
// scripts/check-build.mjs builds the pages that read it and asserts on them.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { notScoredBoard } from "../not-scored-board.mjs";

const MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "conformance-history.json");

export default async function () {
  return notScoredBoard(JSON.parse(await readFile(MODEL_PATH, "utf8")));
}
