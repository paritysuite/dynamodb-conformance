// Each target's cross-cutting capability support - the "can it do what I need?"
// view - built from the per-capability tally in lib/scoring.mjs. Rendered to
// HTML here rather than as a WebC component: the target -> capability loop
// doesn't fit WebC's one-loop templates.
//
// The wide targets-by-capabilities grid this module also used to build
// (renderCapabilities) backed the standalone /capabilities page. That page is
// now a redirect to the emulator directory, which lists capabilities per
// project, so the grid went with it; the per-target card and the directory's
// compact summary are what remain.

import { formatNumber } from "./numbers.mjs";
import { CAPABILITIES, CAPABILITY_GROUPS } from "./scoring.mjs";

// Glyph, colour and spoken label per state, shared by both renderers below.
// Colour never carries meaning alone: an sr-only label states it in words.
const STATE = {
  supported: { glyph: "✓", cls: "text-pass-700 dark:text-pass-400", label: "supported" },
  partial: { glyph: "◑", cls: "text-partial-700 dark:text-partial-400", label: "partially supported" },
  failing: { glyph: "✗", cls: "text-fail-700 dark:text-fail-400", label: "failing" },
  unsupported: { glyph: "–", cls: "text-zinc-500 dark:text-zinc-400", label: "not supported" },
};
const FALLBACK = { glyph: "·", cls: "text-zinc-300 dark:text-zinc-700", label: "not tested" };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function counts(c) {
  const parts = [];
  if (c.passed) parts.push(formatNumber(c.passed) + " pass");
  if (c.failed) parts.push(formatNumber(c.failed) + " fail");
  if (c.skipped) parts.push(formatNumber(c.skipped) + " skip");
  return parts.join(", ");
}

// One row per target: display + version, then a cell per capability.
//
// The baseline is left out: its row was supported in every column by
// definition, so it read as a row of ticks a reader could do nothing with.
function rowsFor(model) {
  return (model.targets || []).filter((slug) => !model.perTarget?.[slug]?.baseline).map((slug) => {
    const t = model.perTarget?.[slug] || {};
    const byKey = Object.fromEntries((t.capabilities || []).map((c) => [c.key, c]));
    const cells = CAPABILITIES.map((cap) => byKey[cap.key] || { ...cap, state: "n/a", passed: 0, failed: 0, skipped: 0 });
    return { slug, display: t.display || slug, version: t.currentVersion || "-", cells };
  });
}

// One card per target, listing its capabilities under the two group headings
// with a glyph beside each. This was the phone fold of a 14-column grid; with
// that grid gone it is the only capability rendering at any width, and it backs
// a target's own page. Colour never carries meaning alone: an sr-only label
// states the support level in words, and a tooltip carries the pass/fail counts.
export function renderCapabilityCards(model) {
  return rowsFor(model)
    .map((r) => {
      const byKey = Object.fromEntries(r.cells.map((c) => [c.key, c]));
      const groups = CAPABILITY_GROUPS.map((g, gi) => {
        const items = CAPABILITIES.filter((cap) => cap.group === g.key)
          .map((cap) => {
            const c = byKey[cap.key] || { state: "n/a", passed: 0, failed: 0, skipped: 0 };
            const s = STATE[c.state] || FALLBACK;
            const ct = counts(c);
            const describe = `${r.display} ${cap.label}: ${s.label}${ct ? ` (${ct})` : ""}`;
            return `<div class="flex items-start justify-between gap-2">
              <dt class="text-sm text-zinc-600 dark:text-zinc-300">${esc(cap.label)}</dt>
              <dd class="shrink-0 text-base font-bold leading-none ${s.cls}" title="${esc(describe)}">
                <span aria-hidden="true">${s.glyph}</span><span class="sr-only">${esc(describe)}</span>
              </dd>
            </div>`;
          })
          .join("");
        const sep = gi > 0 ? " mt-5 pt-5 border-t border-zinc-200/60 dark:border-white/5" : "";
        return `<div class="${sep}">
          <h3 class="mb-3 text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">${esc(g.label)}</h3>
          <dl class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3">${items}</dl>
        </div>`;
      }).join("");

      return `<div class="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50/70 dark:bg-white/[0.03] overflow-hidden">
        <a href="/targets/${esc(r.slug)}" class="flex items-baseline justify-between gap-3 px-4 py-3 border-b border-zinc-200 dark:border-white/10 hover:text-brand-700 dark:hover:text-brand-300">
          <span class="font-semibold text-zinc-800 dark:text-zinc-100">${esc(r.display)}</span>
          <span class="font-mono text-xs text-zinc-500 dark:text-zinc-400 truncate" title="${esc(r.version)}">${esc(r.version)}</span>
        </a>
        <div class="px-4 py-4">${groups}</div>
      </div>`;
    })
    .join("");
}

// A compact feature list for a project's directory entry. It consumes the
// existing capability states; it does not derive a second support classifier.
export function renderFeatureSummary(target, group = "core") {
  const measured = new Map((target?.capabilities || []).map(c => [c.key, c]));
  const capabilities = CAPABILITIES.filter(c => c.group === group);
  return `<dl class="project-feature-list">${capabilities.map(cap => {
    const c = measured.get(cap.key);
    const state = STATE[c?.state] || FALLBACK;
    const detail = c ? counts(c) : "";
    return `<div><dt>${esc(cap.label)}</dt><dd class="${state.cls}"${detail ? ` title="${esc(detail)}"` : ""}><span aria-hidden="true">${state.glyph}</span> ${esc(state.label)}</dd></div>`;
  }).join("")}</dl>`;
}

// One target's capability card, for its own page. The card renderer above takes
// a whole model and draws one card per target, so a single-target page has to
// hand it a model of one - which is the shape adapter, and it lives here rather
// than in the config so the filter stays the one-line delegate the rest are.
export function renderTargetCapabilities(target) {
  if (!target?.slug) return "";
  return renderCapabilityCards({ targets: [target.slug], perTarget: { [target.slug]: target } });
}
