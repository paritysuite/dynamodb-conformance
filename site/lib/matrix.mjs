import { formatNumber } from "./numbers.mjs";
// One target's per-operation support, rendered to HTML here rather than as a
// WebC component because the tier -> operation loop doesn't fit WebC's one-loop
// templates.
//
// This module used to also build the cross-target operation grid (buildMatrix /
// renderSupportCards) for the standalone /support page. That page is now a
// redirect to the emulator directory, which presents operation support per
// project instead, so the grid and its mobile card fold were removed with it.

import { axesOf } from "./scoring.mjs";

const TIER_LABEL = { tier1: "Tier 1 - Core", tier2: "Tier 2 - Complete", tier3: "Tier 3 - Strict" };

// The cell glyph, colour and spoken label per state. Colour never carries
// meaning alone: an sr-only label states the support level in words.
const STATE = {
  supported: { glyph: "✓", cls: "text-pass-700 dark:text-pass-400", label: "supported" },
  partial: { glyph: "◑", cls: "text-partial-700 dark:text-partial-400", label: "partially supported" },
  failing: { glyph: "✗", cls: "text-fail-700 dark:text-fail-400", label: "failing" },
  unsupported: { glyph: "–", cls: "text-zinc-500 dark:text-zinc-400", label: "unsupported" },
};
const STATE_FALLBACK = { glyph: "·", cls: "text-zinc-300 dark:text-zinc-700", label: "not tested" };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function cellCounts(cell) {
  const parts = [];
  if (cell.passed) parts.push(formatNumber(cell.passed) + " pass");
  if (cell.failed) parts.push(formatNumber(cell.failed) + " fail");
  if (cell.skipped) parts.push(formatNumber(cell.skipped) + " skip");
  return parts.join(", ");
}

// A single target's per-operation scorecard: every operation area it touches,
// grouped by tier, each with its support state, divergence and coverage. This is
// the per-operation map the tier headline rolls up, so a reader can see exactly
// which operations a target is weak on, not just which tier. Built here (not in
// a template) because WebC cannot nest a webc:for over a property of an
// outer loop variable.
//
// The figures are divergence over each area's whole size, the same axis as the
// tier above and the headline above that. They were a pass rate over what the
// area attempted, which on a page whose every other percentage had inverted
// left the most detailed table on it reading in the opposite direction.
export function renderTargetOperations(areas) {
  if (!areas || areas.length === 0) return "";
  const byTier = { tier1: [], tier2: [], tier3: [] };
  for (const a of areas) if (byTier[a.tier]) byTier[a.tier].push(a);
  return ["tier1", "tier2", "tier3"]
    .filter((t) => byTier[t].length)
    .map((t) => {
      const rows = byTier[t]
        .slice()
        .sort((a, b) => a.group.localeCompare(b.group))
        .map((a) => {
          const s = STATE[a.state] || STATE_FALLBACK;
                  // `divergence`, not `rate`. It held a divergence figure under a name
          // the board used for the retired pass rate, so the one variable read
          // as the opposite direction to the number in it.
          const axes = axesOf({ passed: a.passed, failed: a.failed, count: a.total, indeterminate: a.indeterminate ?? 0 });
          const divergence = axes.divergence == null ? "n/a" : `${axes.divergence.toFixed(1)}%`;
          const cover = axes.coverage == null ? "n/a" : `${axes.coverage.toFixed(1)}%`;
          const counts = cellCounts(a);
          // An area a target implements none of has no divergence to read out,
          // so the description says that rather than "diverges on n/a".
          const figures = divergence === "n/a" ? `implements none of it` : `diverges on ${divergence} of it, covers ${cover}`;
          const describe = `${a.group}: ${s.label}, ${figures}${counts ? ` (${counts})` : ""}`;
          return `
          <li class="flex items-center justify-between gap-3 py-1.5">
            <span class="flex items-center gap-2 min-w-0">
              <span class="text-base font-bold leading-none ${s.cls}" aria-hidden="true">${s.glyph}</span>
              <span class="font-mono text-sm text-zinc-700 dark:text-zinc-200 truncate">${esc(a.group)}</span>
            </span>
            <span class="flex items-center gap-3 shrink-0 text-xs tnum" title="${esc(describe)}">
              <span class="text-zinc-500 dark:text-zinc-400">${formatNumber(a.failed)}/${formatNumber(a.total)}${a.skipped ? ` · ${formatNumber(a.skipped)} skip` : ""}</span>
              <span class="w-14 text-right font-mono font-medium text-zinc-700 dark:text-zinc-200">${divergence}</span>
              <span class="w-14 text-right font-mono text-zinc-500 dark:text-zinc-400">${cover}</span>
              <span class="sr-only">${esc(describe)}</span>
            </span>
          </li>`;
        })
        .join("");
      // Two adjacent percentages need naming: the same pair of figures read
      // either way round without a label, and they are not interchangeable.
      // Right-anchored to the same fixed widths as the rows, so the heads sit
      // over their own columns.
      return `
      <section>
        <h3 class="text-xs uppercase tracking-wide font-semibold text-zinc-500 dark:text-zinc-400 mb-1">${esc(TIER_LABEL[t] || t)}</h3>
        <div class="flex items-center justify-end gap-3 pb-1 text-[0.6rem] uppercase tracking-wide text-zinc-400 dark:text-zinc-500" aria-hidden="true">
          <span class="w-14 text-right">diverges</span>
          <span class="w-14 text-right">covered</span>
        </div>
        <ul class="divide-y divide-zinc-100 dark:divide-white/5">${rows}</ul>
      </section>`;
    })
    .join("");
}
