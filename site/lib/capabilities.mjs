// The capability grid: targets (rows) x cross-cutting capabilities (columns) -
// the "can it do what I need?" chooser view. Distinct from the support matrix
// (operation x target): capabilities are the axes a directory tree fragments,
// chiefly GSI/LSI support (spread across createTable, query, scan, updateTable)
// and legacy parameters, which the per-operation matrix can't show as one line.
//
// Built from each target's per-capability tally (lib/scoring.mjs), with
// DynamoDB the supported-everywhere baseline. Rendered to HTML here rather than
// as a WebC component, for the same reason as renderSupportCards: the nested
// target -> capability loop doesn't fit WebC's one-loop templates.

import { CAPABILITIES, CAPABILITY_GROUPS } from "./scoring.mjs";

// Glyph, colour and spoken label per state - shared with the support matrix.
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
  if (c.passed) parts.push(c.passed + " pass");
  if (c.failed) parts.push(c.failed + " fail");
  if (c.skipped) parts.push(c.skipped + " skip");
  return parts.join(", ");
}

// One row per target: display + version, then a cell per capability.
//
// The baseline is left out, as it is on the support matrix: its row was
// supported in every column by definition, so it read as a row of ticks a
// reader could do nothing with.
function rowsFor(model) {
  return (model.targets || []).filter((slug) => !model.perTarget?.[slug]?.baseline).map((slug) => {
    const t = model.perTarget?.[slug] || {};
    const byKey = Object.fromEntries((t.capabilities || []).map((c) => [c.key, c]));
    const cells = CAPABILITIES.map((cap) => byKey[cap.key] || { ...cap, state: "n/a", passed: 0, failed: 0, skipped: 0 });
    return { slug, display: t.display || slug, version: t.currentVersion || "-", cells };
  });
}

export function renderCapabilities(model) {
  const rows = rowsFor(model);

  // The first column of the second group carries a left border, so the two groups
  // read as distinct blocks rather than one undifferentiated run of 13 columns.
  const firstWider = CAPABILITIES.findIndex((c) => c.group === "wider");
  const divider = (i) => (i === firstWider ? "border-l border-zinc-200 dark:border-white/10 " : "");

  // Group-header row: an empty sticky corner, then one heading cell spanning its
  // group's columns. Separates DynamoDB's own surface from features that lean on
  // other AWS services, so a "–" in the second block reads as "needs S3/Kinesis/
  // IAM/etc.", not a plain fault.
  const groupRow =
    `<div class="sticky left-0 z-20 bg-white dark:bg-surface-950 border-b border-zinc-200 dark:border-white/10"></div>` +
    CAPABILITY_GROUPS.map((g) => {
      const span = CAPABILITIES.filter((c) => c.group === g.key).length;
      if (span === 0) return "";
      const wider = g.key === "wider";
      return `<div class="${wider ? "border-l border-zinc-200 dark:border-white/10 bg-zinc-50/70 dark:bg-white/[0.03] " : ""}border-b border-zinc-200 dark:border-white/10 px-2 py-1.5 text-center text-[0.65rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400" style="grid-column: span ${span}">${esc(g.label)}</div>`;
    }).join("");

  const header = CAPABILITIES.map(
    (c, i) =>
      `<div class="${divider(i)}capability-heading border-b border-zinc-200 dark:border-white/10 px-2 py-3 self-end text-center text-xs font-medium leading-tight text-zinc-600 dark:text-zinc-300">${esc(c.label)}</div>`,
  ).join("");

  const body = rows
    .map((r) => {
      const head = `<a href="/targets/${esc(r.slug)}" class="sticky left-0 z-10 bg-white dark:bg-surface-950 border-t border-zinc-100 dark:border-white/5 px-3 py-2.5 hover:text-brand-700 dark:hover:text-brand-300">
        <span class="block truncate text-zinc-800 dark:text-zinc-200">${esc(r.display)}</span>
        <span class="block font-mono text-[0.65rem] font-normal text-zinc-500 dark:text-zinc-400 truncate" title="${esc(r.version)}">${esc(r.version)}</span>
      </a>`;
      const cells = r.cells
        .map((c, i) => {
          const s = STATE[c.state] || FALLBACK;
          const ct = counts(c);
          const describe = `${r.display} ${c.label}: ${s.label}${ct ? ` (${ct})` : ""}`;
          return `<div class="${divider(i)}border-t border-zinc-100 dark:border-white/5 px-2 py-2.5 text-center">
          <span class="text-base font-bold ${s.cls}" title="${esc(describe)}" aria-hidden="true">${s.glyph}</span>
          <span class="sr-only">${esc(describe)}</span>
        </div>`;
        })
        .join("");
      return head + cells;
    })
    .join("");

  return `<div class="overflow-x-auto rounded-xl border border-zinc-200 dark:border-white/10">
  <div class="grid text-sm min-w-full" style="grid-template-columns: minmax(140px, 1.4fr) repeat(${CAPABILITIES.length}, minmax(0, 1fr))">
    ${groupRow}
    <div class="sticky left-0 z-20 bg-white dark:bg-surface-950 border-b border-zinc-200 dark:border-white/10 px-3 py-3 font-medium text-zinc-500 dark:text-zinc-400">Target</div>
    ${header}
    ${body}
  </div>
</div>`;
}

// Mobile rendering of the capability grid. A 14-column grid is unreadable on a
// phone, so it folds to one card per target - mirroring the support matrix's
// per-row fold. Each card lists its capabilities under the two group headings,
// the glyph beside each. Colour never carries meaning alone: an sr-only label
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
