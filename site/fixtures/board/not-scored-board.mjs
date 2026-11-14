// The fixture behind fixtures/board's not-scored pages: the standings plus one
// made-up target the suite did not score, and one existing build made not
// scored too, sorted by the board's own sortRows, with a not-scored and a
// lettered target for the per-region intro. Pure over a model so a test can
// build it from any model; _data/notScored.js feeds it the committed one.
import { isNotScored, isVariant, sortRows } from "../../lib/scoring.mjs";

// What the model gives a row with no letter: both figures null, printed "-".
const NOT_SCORED = { divergenceValue: null, divergence: "-", coverageValue: null, coverage: "-" };

// Stand-ins for a model that lacks what the fixture shows: a lettered row, or
// a region cohort to withhold (every row not scored, or not scored at run
// level, which rates no region).
const SCORED = { divergenceValue: 1.2, divergence: "1.2%", coverageValue: 95, coverage: "95.0%" };
const COHORT = { kind: "pinned-plus", regions: ["eu-west-2", "us-east-1"], rate: 98.8, others: 1, pinned: "eu-west-2", observed: 2 };

const DISPLAY = "Aa not scored fixture";

const hasCohort = (r) => r.regionLabel?.regions?.length > 0;
const withCohort = (r) => (hasCohort(r) ? r : Object.assign(r, { regionLabel: { ...COHORT }, hasRegions: true }));

export function notScoredBoard(model) {
  const rows = structuredClone(model.latest.standings).filter((r) => !r.synthesised);
  const targets = rows.filter((r) => !r.baseline && r.slug !== "dynamodb");
  // A project and a build, preferring ones that carry a cohort to withhold.
  const like = targets.find((r) => hasCohort(r) && !isVariant(r.slug)) ?? targets.find((r) => !isVariant(r.slug));
  const variant = targets.find((r) => isVariant(r.slug) && hasCohort(r)) ?? targets.find((r) => isVariant(r.slug));
  if (!like || !variant) throw new Error("the fixture needs a project and a build on the board");

  const fixture = withCohort({
    ...structuredClone(like),
    ...NOT_SCORED,
    slug: "aa-not-scored-fixture",
    target: DISPLAY,
    display: DISPLAY,
    // A first run, which is how a target arrives on the board not scored.
    movement: { state: "new", arrow: "–", delta: null, deltaLabel: "new", deltaReading: "new", label: "first run for this target" },
  });
  rows.push(fixture);
  Object.assign(withCohort(variant), NOT_SCORED);
  const lettered =
    targets.find((r) => hasCohort(r) && !isNotScored(r) && r !== variant) ??
    withCohort({ ...structuredClone(like), ...SCORED });

  return {
    runId: model.latest.id,
    // sortRows flags the rows in place and returns them in a new order.
    rows: sortRows(rows).filter((r) => r.isParent),
    slug: fixture.slug,
    display: DISPLAY,
    variant: variant.slug,
    // The shape target.webc hands the per-region intro.
    intro: {
      notScored: { regionLabel: fixture.regionLabel, current: fixture },
      lettered: { regionLabel: lettered.regionLabel, current: lettered },
    },
  };
}
