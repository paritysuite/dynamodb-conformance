// What a not-scored row says in place of its figures: how many of its tests
// got no answer, and why, in the suite's own words.
//
// A row with an unanswered test has no letter, divergence or coverage, and the
// sentences built around those figures read "answers - of the suite" with
// nothing in them. The count of unanswered tests is the fact the reader needs,
// and it was published only in the JSON. A row that implements none of the
// suite is not scored for a different reason, and says that instead.

import { reasonWords } from "dynamodb-conformance/scripts/lib/reason-words.mjs";
import { formatNumber } from "./numbers.mjs";
import { isNotScored, isRunUnanswered } from "./scoring.mjs";

export { reasonWords };

// The methodology section that states the rule, linked from every statement.
export const NO_ANSWER_HREF = "/methodology#when-a-test-gets-no-answer";

const plural = (n, one, many) => (n === 1 ? one : many);
const tests = (n) => plural(n, "test", "tests");

// How many tests got no answer: the row's own count where it carries one, or
// what is left of its total once the answered tests are taken away.
export function unansweredCount(row) {
  if (row?.indeterminate != null) return row.indeterminate;
  const n = (row?.count ?? 0) - (row?.passed ?? 0) - (row?.failed ?? 0) - (row?.skipped ?? 0);
  return n > 0 ? n : 0;
}

// The reasons recorded for the unanswered tests, most common first. Only when
// the records account for every unanswered test the row counts: the records
// are read from one results file and the count from the suite's summary, and
// if the two ever disagree the sentence states the count and nothing it
// cannot stand behind.
export function reasonCounts(row, records) {
  const n = unansweredCount(row);
  if (!n || !Array.isArray(records) || records.length !== n) return null;
  const by = new Map();
  for (const r of records) {
    const words = reasonWords(r.reason);
    const seen = by.get(words);
    if (seen) seen.count++;
    else by.set(words, { reason: r.reason ?? null, count: 1, words });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.words.localeCompare(b.words));
}

const reasonClause = (reasons) => reasons.map((r) => `${formatNumber(r.count)} ${r.words}`).join(", ");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Why a not-scored row is not scored, or null for a scored one: "run" when
// the run got no answer as a whole, "tests" when some of its tests did, and
// "none" when it implements none of the suite, so has nothing to score.
export function notScoredKind(row, { runUnanswered = false } = {}) {
  if (!row || !isNotScored(row)) return null;
  if (runUnanswered || isRunUnanswered(row)) return "run";
  if (unansweredCount(row) > 0) return "tests";
  if ((row.passed ?? 0) + (row.failed ?? 0) === 0 && (row.count ?? 0) > 0) return "none";
  return null;
}

// Whether a row is not scored because tests got no answer, rather than for
// having no figures at all.
export const isUnanswered = (row) => ["run", "tests"].includes(notScoredKind(row));

// The statement for a not-scored row, as plain text and as HTML. "Not scored:"
// leads for a sighted reader and is hidden from a screen reader, which has
// just heard the grade chip say it; the words "got no answer" link to the
// rule. `runUnanswered` marks a run that got no answer as a whole; `records`
// are its unanswered tests, for the reasons.
export function notScoredStatement(row, { runUnanswered = false, records = null, thisRun = "this run" } = {}) {
  const kind = notScoredKind(row, { runUnanswered });
  if (!kind) return null;
  const lead = "Not scored: ";
  const leadHtml = `<span aria-hidden="true">${lead}</span>`;
  const link = (t) => `<a href="${NO_ANSWER_HREF}" class="underline decoration-dotted underline-offset-2 hover:text-brand-700 dark:hover:text-brand-300">${t}</a>`;
  if (kind === "run") {
    const tail = `, so the suite gives no letter or figures for it.`;
    return {
      text: `${lead}the run got no answer${tail}`,
      html: `${leadHtml}the run ${link("got no answer")}${esc(tail)}`,
    };
  }
  if (kind === "none") {
    const said = `it implements none of the suite's ${formatNumber(row.count)} ${tests(row.count)}.`;
    return { text: `${lead}${said}`, html: `${leadHtml}${esc(said)}` };
  }
  const n = unansweredCount(row);
  const reasons = reasonCounts(row, records);
  const head = `${formatNumber(n)} of ${formatNumber(row.count)}`;
  const noun = `${tests(row.count)} got no answer`;
  const why = reasons ? ` (${reasonClause(reasons)})` : "";
  const tail = `${why}, so the suite gives no letter or figures for ${thisRun}.`;
  const answered = `${formatNumber(row.passed ?? 0)} passed, ${formatNumber(row.failed ?? 0)} failed, ${formatNumber(row.skipped ?? 0)} not attempted.`;
  return {
    text: `${lead}${head} ${noun}${tail} ${answered}`,
    html: `${leadHtml}${esc(head)} ${link(noun)}${esc(tail)} ${esc(answered)}`,
  };
}

// The unanswered tests grouped by operation, as the findings are, most first,
// each test carrying its reason in words.
export function unansweredByArea(records) {
  const by = new Map();
  for (const r of records ?? []) {
    const key = r.areaKey ?? `${r.tier}/${r.group}`;
    if (!by.has(key)) by.set(key, { key, tier: r.tier, group: r.group, tests: [] });
    by.get(key).tests.push({ ...r, reasonWords: reasonWords(r.reason) });
  }
  return [...by.values()].sort((a, b) => b.tests.length - a.tests.length || a.key.localeCompare(b.key));
}

// The short form, for a board row or a directory entry: the figure and the
// words under it.
export function notScoredShort(row, { runUnanswered = false } = {}) {
  const kind = notScoredKind(row, { runUnanswered });
  if (kind === "run") return { figure: "the run", label: "got no answer", text: "the run got no answer" };
  if (kind === "none") {
    const figure = `none of ${formatNumber(row.count)}`;
    return { figure, label: "implemented", text: `implements none of ${formatNumber(row.count)} ${tests(row.count)}` };
  }
  if (kind !== "tests") return null;
  const n = unansweredCount(row);
  const figure = `${formatNumber(n)} of ${formatNumber(row.count)}`;
  return { figure, label: "got no answer", text: `${figure} ${tests(row.count)} got no answer` };
}

// What the "N unsupported" link on a not-scored board row says when hovered,
// in place of the scored row's "scores the N of T tests it implements",
// which names a score the row does not have.
export function notScoredScope(row, { runUnanswered = false } = {}) {
  const kind = notScoredKind(row, { runUnanswered });
  if (kind === "run") return `${row.display}'s run got no answer, so none of its tests counted.`;
  if (kind === "none") return `${row.display} implements none of the suite's ${formatNumber(row.count)} ${tests(row.count)}.`;
  if (kind !== "tests") return null;
  const answered = (row.passed ?? 0) + (row.failed ?? 0);
  const unsupported = row.unsupported ?? row.skipped ?? 0;
  const n = unansweredCount(row);
  return `${row.display} answered ${formatNumber(answered)} of ${formatNumber(row.count)} ${tests(row.count)}; ${formatNumber(unsupported)} ${plural(unsupported, "covers an operation", "cover operations")} it does not support; ${formatNumber(n)} got no answer.`;
}
