// Where the board seats a row with no letter. Read by scripts/check-build.mjs
// over the rendered board, and pure so it can be tested on any model.
import { BASELINE_LABEL } from "dynamodb-conformance/scripts/lib/grade.mjs";

const LETTERED = /^(A\+|[A-DF])$/;

/**
 * The ways a board's order breaks the rule that every lettered row comes before
 * every letterless one, as messages; empty when it holds. `seated` is
 * `[{ name, chip, qualifier }]` in page order, `chip` being the mark the grade
 * chip shows and `qualifier` what a row without a letter says instead. The
 * baseline has no letter either but heads the board as the yardstick, so it
 * is left out. Any number of not-scored rows may sit at the bottom, in any
 * order among themselves: the rule is a partition, not a position.
 */
export function partitionProblems(seated) {
  const targets = seated.filter((r) => r.qualifier !== BASELINE_LABEL);
  const first = targets.findIndex((r) => !LETTERED.test(r.chip));
  if (first === -1) return [];
  return targets
    .slice(first)
    .filter((r) => LETTERED.test(r.chip))
    .map((r) => `${r.name} (${r.chip}) sits below a row with no letter`);
}

/** Whether a chip shows a letter. */
export const hasLetter = (chip) => LETTERED.test(chip);
