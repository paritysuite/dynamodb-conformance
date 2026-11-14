import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { hasLetter, partitionProblems } from "./letterless.mjs";
import { gradeForRow, sortRows } from "./scoring.mjs";
import { notScoredBoard } from "../fixtures/board/not-scored-board.mjs";
import { SCENARIOS, markTestLevel, pipelineModel } from "../fixtures/not-scored-models.mjs";

const MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "conformance-history.json");
const model = JSON.parse(await readFile(MODEL_PATH, "utf8"));

// Rows as the build check reads them off the page: name, chip and the words
// the screen-reader text gives a row without a letter.
const seat = (r) => ({ name: r.display, chip: gradeForRow(r).letter ?? "–", qualifier: gradeForRow(r).qualifier });
const letterlessCount = (seated) => seated.filter((r) => !hasLetter(r.chip)).length;

// Every model the fixture has to build from: the committed one, each board a
// not-scored run produces, and two the fixture has to stand in for itself.
// Each scenario is compared with the same results unedited, never with the
// committed fallback: the two need not agree on who is lettered. Models are
// built when a test first reads them, so one that cannot be built fails that
// test by name rather than the whole file on import.
let unedited;
let modelsBuilt = 0;
const lazy = (name, build, rest, ref) => {
  let built;
  return {
    name,
    ...rest,
    get model() {
      return (built ??= (modelsBuilt++, build()));
    },
    get reference() {
      return ref?.();
    },
  };
};
const uneditedModel = () => (unedited ??= (modelsBuilt++, pipelineModel().model));
const MODELS = [
  { name: "committed", model, notScored: [], reference: model },
  ...SCENARIOS.map((s) => lazy(s.name, () => s.build().model, { notScored: s.notScored }, uneditedModel)),
  lazy("a board with no lettered row", () => pipelineModel((ts) => ts.filter((t) => t.slug !== "dynamodb").forEach((t) => markTestLevel(t.raw))).model, { notScored: null }),
];
// Read before any test runs: setting the table up built nothing.
const builtOnImport = modelsBuilt;

test("listing the models builds none of them; each is built when a test reads it", () => {
  assert.equal(builtOnImport, 0);
});

test("partitionProblems accepts letterless rows in any order below every lettered one", () => {
  assert.deepEqual(partitionProblems([{ name: "a", chip: "A" }, { name: "b", chip: "F" }, { name: "c", chip: "–" }, { name: "d", chip: "–" }]), []);
  assert.deepEqual(partitionProblems([{ name: "a", chip: "A+" }, { name: "b", chip: "C" }]), []);
});

test("partitionProblems names a lettered row below a letterless one", () => {
  assert.deepEqual(partitionProblems([{ name: "a", chip: "–" }, { name: "b", chip: "B" }]), ["b (B) sits below a row with no letter"]);
});

// The board's own rows: the baseline and each project, builds nested below.
const boardOf = (m) =>
  sortRows(structuredClone(m.latest.standings))
    .filter((r) => r.isParent || gradeForRow(r).qualifier === "baseline")
    .map(seat);

test("partitionProblems leaves out the baseline, which heads the real board with no letter", () => {
  // The results with indeterminates cleared, so lettered rows are there to
  // sit below it whatever the committed board holds.
  const seated = boardOf(uneditedModel());
  assert.equal(seated[0].qualifier, "baseline", "the baseline heads the board");
  assert.ok(seated.slice(1).some((r) => hasLetter(r.chip)), "lettered rows sit below it");
  assert.deepEqual(partitionProblems(seated), []);
  // Still read as a row without a letter when it is not the baseline.
  assert.notDeepEqual(partitionProblems([{ ...seated[0], qualifier: "not scored" }, ...seated.slice(1)]), []);
});

for (const entry of MODELS) {
  test(`the real board holds the partition (${entry.name})`, () => {
    assert.deepEqual(partitionProblems(boardOf(entry.model)), []);
  });
}

for (const entry of MODELS) {
  test(`the fixture board holds the partition, with its row and build not scored (${entry.name})`, () => {
    const { model: m, notScored } = entry;
    const board = notScoredBoard(m);
    const seated = board.rows.map(seat);
    const fixture = seated.find((r) => r.name === board.display);
    assert.ok(fixture && !hasLetter(fixture.chip));
    assert.deepEqual(partitionProblems(seated), []);
    if (!notScored) {
      assert.equal(seated.filter((r) => hasLetter(r.chip)).length, 0, "no row is lettered");
    } else {
      // Letterless rows are the reference board's plus each project the
      // scenario took from lettered (or added), so the fixture is not always
      // the last row.
      const before = notScoredBoard(entry.reference).rows;
      const added = notScored.filter((slug) => {
        if (!board.rows.some((r) => r.slug === slug)) return false;
        const was = before.find((r) => r.slug === slug);
        return !was || gradeForRow(was).letter !== null;
      });
      assert.equal(letterlessCount(seated), letterlessCount(before.map(seat)) + added.length);
    }
    // The build and both intro targets are there whatever the model lacked.
    const build = board.rows.flatMap((r) => r.variants ?? []).find((v) => v.slug === board.variant);
    assert.equal(gradeForRow(build).letter, null);
    assert.ok(board.intro.notScored.regionLabel?.regions?.length, "a cohort to withhold");
    assert.ok(gradeForRow(board.intro.lettered.current).letter, "a lettered intro target");
  });
}
