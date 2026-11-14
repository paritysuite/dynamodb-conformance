// What the build check reads a not-scored statement against: the row as the
// data endpoints publish it. Every figure in a statement is parsed back out of
// the built page and compared with the endpoint, so a sentence that drifts
// from the JSON, or from the lists printed under it, fails the build rather
// than reading plausibly.

const fmt = (n) => n.toLocaleString("en-GB");
const num = (s) => Number(String(s).replace(/,/g, ""));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tests = (n) => (n === 1 ? "test" : "tests");

// Page text and attribute values as a reader hears them. A tag is a word
// break, except before punctuation or after an opening bracket, where the
// link that ends "got no answer" would otherwise read "got no answer , so".
export const plainText = (h) =>
  h
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:)])/g, "$1")
    .replace(/\( /g, "(")
    .trim();

// The text of every element carrying data-not-scored="<slug>".
export const statedIn = (html, slug) =>
  [...html.matchAll(new RegExp(`<(\\w+)[^>]*data-not-scored="${escRe(slug)}"[^>]*>([\\s\\S]*?)</\\1>`, "g"))].map((m) => plainText(m[2]));

// Why an endpoint row is not scored: "run" when the run got no answer as a
// whole (nothing passed, failed or was skipped), "tests" when some tests got
// no answer, "none" when it implements none of the suite, or null when it is
// scored or is the baseline.
export function kindOf(t) {
  if (t.baseline || t.grade?.letter != null) return null;
  const c = t.counts;
  const answered = c.passed + c.failed + c.skipped;
  const unanswered = c.indeterminate ?? c.total - answered;
  if (answered === 0) return "run";
  if (unanswered > 0) return "tests";
  if (c.passed + c.failed === 0) return "none";
  return null;
}

export const unansweredOf = (t) => t.counts.indeterminate ?? t.counts.total - t.counts.passed - t.counts.failed - t.counts.skipped;

const RUN = "Not scored: the run got no answer, so the suite gives no letter or figures for it.";
const TESTS = /^Not scored: ([\d,]+) of ([\d,]+) (tests?) got no answer(?: \(([^)]*)\))?, so the suite gives no letter or figures for this run\. ([\d,]+) passed, ([\d,]+) failed, ([\d,]+) not attempted\.$/;

// The statement a page makes for a row, parsed, or null if it is not one.
export function parseStatement(s) {
  const m = TESTS.exec(s);
  if (!m) return null;
  const reasons = m[4] == null ? null : m[4].split(", ").map((r) => /^([\d,]+) (.+)$/.exec(r)).map((x) => (x ? { count: num(x[1]), words: x[2] } : null));
  return { unanswered: num(m[1]), total: num(m[2]), noun: m[3], reasons, passed: num(m[5]), failed: num(m[6]), skipped: num(m[7]) };
}

// Everything wrong with a page's statements for a row, as short notes; empty
// when the page says exactly what the endpoint counts.
export function statementProblems(sentences, t) {
  const kind = kindOf(t);
  if (!kind) return sentences.length ? ["states a not-scored sentence for a row that is scored"] : [];
  if (sentences.length !== 1) return [`${sentences.length} statements, wanted 1`];
  const [s] = sentences;
  if (kind === "run") return s === RUN ? [] : [`"${s}" is not the run-level statement`];
  if (kind === "none") {
    const want = `Not scored: it implements none of the suite's ${fmt(t.counts.total)} ${tests(t.counts.total)}.`;
    return s === want ? [] : [`"${s}", wanted "${want}"`];
  }
  const p = parseStatement(s);
  if (!p) return [`"${s}" does not parse`];
  const c = t.counts;
  const out = [];
  const want = { unanswered: unansweredOf(t), total: c.total, passed: c.passed, failed: c.failed, skipped: c.skipped };
  for (const [k, v] of Object.entries(want)) if (p[k] !== v) out.push(`${k} ${p[k]}, endpoint ${v}`);
  if (p.noun !== tests(c.total)) out.push(`"${p.noun}" for a total of ${c.total}`);
  if (p.reasons) {
    if (p.reasons.some((r) => !r)) out.push(`reasons "${s}" do not parse`);
    else {
      const sum = p.reasons.reduce((n, r) => n + r.count, 0);
      if (sum !== want.unanswered) out.push(`reasons sum to ${sum}, endpoint ${want.unanswered}`);
    }
  }
  return out;
}

// Whether a short form (board cell, variant line, directory entry) states the
// row's count, as a whole number on both sides: "410 of 1,678" is found in
// neither "1,410 of 1,678" nor "410 of 1,6789".
export function shortStates(texts, t) {
  const kind = kindOf(t);
  const phrase = kind === "run" ? "the run got no answer" : kind === "none" ? `none of ${fmt(t.counts.total)}` : `${fmt(unansweredOf(t))} of ${fmt(t.counts.total)}`;
  const re = new RegExp(`(?:^|[^\\d,])${escRe(phrase)}(?![\\d,])`);
  const tail = kind === "none" ? /implement/ : /got no answer/;
  return texts.some((x) => re.test(x) && tail.test(x));
}

// Each tier bar a page draws for a row, read back: the tier, the visible
// figure and the words a screen reader hears. Matched on the row's display
// name, so a page holding other rows' bars reads only this row's.
export function tierBars(html, display) {
  const bars = [];
  for (const chunk of html.split('class="tier-metric"').slice(1)) {
    const aria = /role="meter"[^>]*?aria-label="([^"]*)"|aria-label="([^"]*)"[^>]*?role="meter"/.exec(chunk);
    const label = plainText(aria?.[1] ?? aria?.[2] ?? "");
    if (!label.startsWith(`${display} Tier `)) continue;
    const tier = /Tier (\d)/.exec(label.slice(display.length))?.[1];
    const meter = chunk.indexOf('role="meter"');
    const visible = plainText(chunk.slice(chunk.indexOf(">") + 1, chunk.lastIndexOf("<", meter)));
    bars.push({ tier: Number(tier), visible, label });
  }
  return bars;
}

// Everything wrong with a row's tier bars on a page: each tier holding a test
// that got no answer says how many, of how many, as the endpoint's tier
// counts them, in what it shows and what it reads out; each other tier says
// nothing of the kind.
export function tierProblems(html, t) {
  const out = [];
  const bars = tierBars(html, t.display);
  for (const k of [1, 2, 3]) {
    const tier = t.tiers?.[`tier${k}`];
    if (!tier) continue;
    const mine = bars.filter((b) => b.tier === k);
    if (!mine.length) {
      out.push(`no Tier ${k} bar`);
      continue;
    }
    const n = tier.indeterminate ?? 0;
    for (const b of mine) {
      if (n > 0) {
        const figure = new RegExp(`(?:^|[^\\d,])${escRe(`${fmt(n)} of ${fmt(tier.total)}`)} got no answer(?![\\d,])`);
        if (!figure.test(b.visible)) out.push(`Tier ${k} shows "${b.visible}", endpoint ${n} of ${tier.total}`);
        if (b.label !== `${t.display} Tier ${k}: not scored, ${fmt(n)} of ${fmt(tier.total)} ${tests(tier.total)} got no answer`) out.push(`Tier ${k} reads "${b.label}"`);
      } else if (/got no answer/.test(b.visible + b.label)) out.push(`Tier ${k} says a test got no answer, endpoint none`);
    }
  }
  return out;
}

// The divergences a target page lists under "Where it falls short": the sum
// of each operation's "N diverging".
export function divergingTotal(html) {
  const at = html.indexOf('id="findings"');
  if (at < 0) return 0;
  const section = html.slice(at, html.indexOf("<h2", at + 1) < 0 ? undefined : html.indexOf("<h2", at + 1));
  return [...section.matchAll(/>([\d,]+) diverging</g)].reduce((n, m) => n + num(m[1]), 0);
}
