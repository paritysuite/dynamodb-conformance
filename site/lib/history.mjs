// Assemble the conformance history model from per-target snapshots.
//
// A snapshot is a scored emulator row (see lib/scoring.mjs) plus its run
// identity: { startTime (epoch ms), sha }. Runs are derived from startTime
// dates, never from commits - a single commit often refreshes only some
// targets, and one commit can carry targets whose startTimes belong to
// different runs, so grouping by commit would invent runs that never happened.
//
// Within a run date the latest startTime per target wins (a target re-run later
// the same day supersedes the earlier result), and a target not re-tested in a
// run is carried forward at its last measured value.

import { axesOf, dynamodbRow, gradeOf, label, display, regionalGapOf, repoUrl, sortRows, suiteSizeOf, CAPABILITIES, GRADING_CRITERIA_EFFECTIVE, GROUND_TRUTH_SLUG } from "./scoring.mjs";

/**
 * Whether a run may carry a letter: measured on or after the day the criteria
 * took effect.
 *
 * Not `scoredOnCorrectness`, which marks a different set. That flag says a run
 * was scored under the retired metric, so a run scored on divergence but
 * published before the letter existed passes it and gets a grade it never had.
 * Both dates are ISO, so a string compare orders them.
 */
export const gradedUnderCriteria = (runDate) =>
  typeof runDate === "string" && runDate >= GRADING_CRITERIA_EFFECTIVE;

// Movement in divergence, where lower is better - the opposite sense to the
// correctness figure this replaced. So the state says what happened rather than
// which way the number went: "up" was green while higher meant better, and
// reusing it here would have painted a target getting worse in the colour for
// improvement.
//
// Two labels, because a published field and a rendered one want different
// things. `deltaLabel` stays signed for consumers, so a row carrying +0.2pp
// diverged more. `deltaReading` is what a page shows, and it drops the sign:
// beside the arrow, a minus stated the direction a second time while nothing
// visible stated whether the direction was good. A reader scanning a down arrow
// and a negative number reads decline, because that is what both mean
// everywhere else, and the only word that resolved it was screen-reader-only.
// The magnitude plus "less" or "more" says it without relying on the colour,
// which the roughly one in twelve men with red-green colour blindness do not
// get either.
function deltaMovement(cur, prev) {
  if (cur == null || prev == null) {
    return { state: "flat", arrow: "–", delta: null, deltaLabel: "–", deltaReading: "–", label: "unchanged" };
  }
  const r = Math.round((cur - prev) * 10) / 10;
  if (r < 0) {
    return {
      state: "improved",
      arrow: "▼",
      delta: r,
      deltaLabel: `${r.toFixed(1)}pp`,
      deltaReading: `${Math.abs(r).toFixed(1)}pp less`,
      label: `diverged ${Math.abs(r).toFixed(1)} percentage points less`,
    };
  }
  if (r > 0) {
    return {
      state: "regressed",
      arrow: "▲",
      delta: r,
      deltaLabel: `+${r.toFixed(1)}pp`,
      deltaReading: `${r.toFixed(1)}pp more`,
      label: `diverged ${r.toFixed(1)} percentage points more`,
    };
  }
  return { state: "flat", arrow: "–", delta: 0, deltaLabel: "0.0pp", deltaReading: "0.0pp", label: "unchanged" };
}

// The grade shift behind a movement, attached only when the letter changed.
// Near a band boundary a small pp move flips a letter, and the flip should be
// stated where the delta is rather than left for a reader to rederive from
// the criteria. Both figures feed the grade, so the previous run's coverage
// matters too: a cap can lift or land without divergence moving at all.
function withGradeShift(mv, cur, prev, dates = {}) {
  // A transition is a claim about history, stronger than a letter computed
  // now: it says two letters existed and one became the other. Neither did on
  // a run measured before the criteria, so the shift is withheld on the same
  // grounds the feed withholds the letter. Both ends have to qualify - a move
  // out of a run that never had a letter is not a move.
  const graded = gradedUnderCriteria(dates.cur) && gradedUnderCriteria(dates.prev);
  if (!graded) return mv;
  const to = gradeOf(cur.divergenceValue, cur.coverageValue).letter;
  const from = gradeOf(prev.divergenceValue, prev.coverageValue).letter;
  if (!from || !to || from === to) return mv;
  return { ...mv, grade: { from, to, label: `grade ${from} to ${to}` } };
}

/**
 * Divergence and coverage for a snapshot.
 *
 * Derived from its raw counts, except where the region overlay has already
 * resolved divergence to the target's best-matching region: recomputing then
 * would quietly drop back to the eu-west-2 port's numbers, and a row's movement
 * would disagree with the figure printed beside it.
 */
function figuresOf(s) {
  const derived = axesOf({
    passed: s.passed ?? 0,
    failed: s.failed ?? 0,
    count: s.count ?? 0,
    indeterminate: s.indeterminate ?? 0,
  });
  // `in`, not a typeof check. The overlay resolves divergence to null on
  // purpose for a run the suite refuses to score, and reading that null as
  // "field absent" fell through to the derived figure - which is how a
  // partially observed run came to publish a number and a letter here while
  // the README printed "-" for the same run.
  const divergenceValue = "divergenceValue" in s ? s.divergenceValue : derived.divergence;
  const coverageValue = derived.coverage;
  return {
    divergenceValue,
    divergence: divergenceValue == null ? "-" : `${divergenceValue.toFixed(1)}%`,
    coverageValue,
    coverage: coverageValue == null ? "-" : `${coverageValue.toFixed(1)}%`,
  };
}

const newMovement = () => ({ state: "new", arrow: "–", delta: null, deltaLabel: "new", deltaReading: "new", label: "first run for this target" });
const carriedMovement = () => ({ state: "carried", arrow: "–", delta: null, deltaLabel: "–", deltaReading: "–", label: "not re-tested this run" });
const baselineMovement = () => ({ state: "baseline", arrow: "–", delta: null, deltaLabel: "–", deltaReading: "–", label: "baseline - live AWS DynamoDB" });

const fmtRate = (r) => (r == null ? "-" : `${r.toFixed(1)}%`);

// The baseline's cohort label. Real DynamoDB agrees with itself in every
// region, so its cohort is the observed set - carried as the actual regions
// rather than an empty list, or the count beside its headline would read as
// unknown on the one row where it is certain.
function baselineRegionLabel(overlay, date = null) {
  // That run's own observed set, not today's. The overlay is the summary
  // *history*, so the set lives per run date; falling back to `latest` for every
  // run credited the baseline with 33 of 33 on runs scored against one region.
  const forDate = date ? overlay?.byRunDate?.[date]?.regions?.observed : null;
  const observed = forDate ?? overlay?.latest?.regions?.observed ?? [];
  return { kind: "all", regions: [...observed], rate: 100, others: Math.max(0, observed.length - 1), observed: observed.length };
}

// The region a target's headline was earned in: the suite's own pick when the
// summary records it, otherwise the least-diverging observed region, which is
// the same choice (see the note on region invariance below). What the overlay
// does with the pick is enrichSnapshot's story, documented there.
function headlineRegionOf(sm) {
  const named = sm.regions?.find((r) => r.region === sm.suiteHeadlineRegion);
  if (named) return named;
  const scored = (sm.regions ?? []).filter((r) => r.divergenceValue != null);
  if (!scored.length) return null;
  return scored.reduce((a, b) => (b.divergenceValue < a.divergenceValue ? b : a));
}

/**
 * Overlay a snapshot with the region its headline was earned in.
 *
 * Two things this used to get wrong, both of which published a figure no run
 * measured.
 *
 * The join. `byRunDate` is keyed on the AWS sweep date, while each target entry
 * inside carries its own run date, and they are not always the same: a summary
 * committed after a later target run holds that later run's numbers under the
 * earlier sweep's key. Overlaying on the key alone put 24 July's figures on the
 * 22 July run for all eight targets, so a row published 12.3% beside its own
 * count of 213 fails in 998. The entry now has to agree with the snapshot about
 * which run it describes, or it is not applied at all.
 *
 * The scope. Only the headline scalars were overlaid, leaving `tiers` and the
 * raw counts on the port's own basis. Under correctness that was invisible,
 * because tier figures had their own denominators and nothing had to reconcile.
 * Divergence is additive, so it does reconcile - or fails to in public: the
 * tiers no longer decomposed the headline, `failed / count` no longer equalled
 * the published divergence, and the README (which takes every column from the
 * headline region) disagreed with the board. The whole region entry is applied
 * now, so a row is one region's measurement throughout.
 *
 * Coverage is the same in every region either way. `verdictsForRegion` only ever
 * swaps a pass for a fail and passes skips and indeterminates through untouched,
 * so implemented and total are region-invariant by construction - verified
 * across every committed sweep. Divergence is a property of a target measured
 * against a region; coverage is a property of the target.
 */
// The overlay entry describing exactly this snapshot's run, or null. The
// guard is run-date agreement: an entry that describes a different run is
// never applied. Filing is a separate question - byRunDate is keyed on the
// sweep date, and a target last tested *between* sweeps has its entry filed
// only under later sweeps' keys (the live case: a build tested on the 24th
// carried by sweeps keyed 26th, 28th, 29th, with no sweep keyed the 24th).
// So when the same-key lookup misses, the search widens to any sweep whose
// entry names this exact run, newest sweep first so the freshest statement
// of the same run wins.
function overlayEntryFor(s, summary) {
  return sweepFor(s, summary)?.targets?.[s.slug] ?? null;
}

// The sweep that entry was found in, which also says which regions that sweep
// observed.
function sweepFor(s, summary) {
  // Run-date agreement is required on both sides, with no escape for an
  // undated entry: every committed sweep stamps runDate, so an entry without
  // one is not a legacy shape to accommodate but a malformed record, and
  // accepting it would re-admit the exact cross-run graft this join removes.
  if (!s.runDate) return null;
  const keyed = summary?.byRunDate?.[s.runDate];
  if (keyed?.targets?.[s.slug]?.runDate === s.runDate) return keyed;
  for (const date of Object.keys(summary?.byRunDate ?? {}).sort().reverse()) {
    const sweep = summary.byRunDate[date];
    if (sweep?.targets?.[s.slug]?.runDate === s.runDate) return sweep;
  }
  return null;
}

function enrichSnapshot(s, summary) {
  const sweep = sweepFor(s, summary);
  const sm = sweep?.targets?.[s.slug] ?? null;
  if (!sm) return s;

  const best = headlineRegionOf(sm);
  // A region entry without counts cannot be applied wholly, and applying it
  // partly is the defect this rewrite exists to remove. Leave the snapshot on
  // its own basis instead, where every figure at least agrees with every other.
  if (!best || !best.count) return s;

  const implemented = best.passed + best.failed;
  const { divergence: divergenceValue, coverage: coverageValue } = axesOf({
    passed: best.passed,
    failed: best.failed,
    count: best.count,
    indeterminate: best.indeterminate ?? 0,
  });
  const correctness = implemented === 0 ? null : (best.passed / implemented) * 100;

  return {
    ...s,
    // The port's own eu-west-2 figures, kept for the parity check that holds the
    // site to the suite's published summary.
    portTotalValue: s.totalValue,
    portTotal: s.total,
    headlineRegion: best.region,
    // A run-level fault rates no region, so its label counts none observed;
    // the sweep it was measured in says how many were.
    regionLabel: sm.label?.observed === 0 ? { ...sm.label, observed: sweep.regions?.observed?.length || null } : sm.label,
    tiers: best.tiers ?? s.tiers,
    passed: best.passed,
    failed: best.failed,
    skipped: best.skipped,
    count: best.count,
    // Carried with the counts it qualifies, so anything rederiving a figure
    // from them through axesOf withholds it as the headline does.
    indeterminate: best.indeterminate ?? 0,
    implemented,
    unsupported: best.skipped,
    divergenceValue,
    divergence: divergenceValue == null ? "-" : `${divergenceValue.toFixed(1)}%`,
    coverageValue,
    coverage: coverageValue == null ? "-" : `${coverageValue.toFixed(1)}%`,
    totalValue: correctness,
    total: fmtRate(correctness),
    // The worst region, for the target page to state its headline's range. A
    // bare best-of-33 reads as unconditional, and on the rows where that matters
    // most it is this board's author making the claim about his own engine.
    divergenceWorst: sm.divergenceWorst ?? null,
    divergenceWorstLabel:
      sm.divergenceWorst == null || sm.divergenceWorst === (divergenceValue ?? 0)
        ? null
        : `${sm.divergenceWorst.toFixed(1)}%`,
    // The regions whose answers would give this row a lower letter, if any.
    // Read from the same per-region figures as the range above, against this
    // row's own coverage.
    regionalGap: regionalGapOf(
      divergenceValue,
      coverageValue,
      (sm.regions ?? []).map((r) => ({ region: r.region, divergence: r.divergenceValue })),
    ),
    hasRegions: true,
  };
}

// Distinct runs that share a calendar date get sha-disambiguated ids. Date
// grouping makes collisions impossible in practice, but the capability is kept
// so the run-id scheme stays stable if grouping ever changes.
export function assignRunIds(runs) {
  const counts = {};
  for (const r of runs) counts[r.date] = (counts[r.date] || 0) + 1;
  return runs.map((r) => (counts[r.date] > 1 ? `${r.date}-${r.sha.slice(0, 7)}` : r.date));
}

// Every (target, run) pair that was actually measured, flat, so a page can be
// built per pair. Carried-forward dates aren't pairs: nothing was measured then,
// so a page for one would only repeat an earlier run's numbers under the wrong
// date.
//
// Derived from a model rather than computed inside buildModel, so the committed
// fallback (which is a serialised model, not a rebuilt one) gets it too. Without
// that, a build that falls back would find no pagination data and fail outright.
// The baseline is excluded. Its series is synthesised one point per run, never
// measured, so a page per date would describe a run that never happened for it
// and read as though real DynamoDB had been tested and scored.
export const targetRunsOf = (model) =>
  (model?.targets ?? [])
    .filter((slug) => !model.perTarget?.[slug]?.baseline)
    .flatMap((slug) => (model.perTarget?.[slug]?.series ?? []).map((p) => ({ slug, runId: p.runId, date: p.date })));

// The model with per-failure findings thinned to what the committed fallback
// needs. Carrying every run's findings takes the file from ~1.3 MB to ~30 MB,
// because each failing test's name, tags and path repeat for each target on
// each run.
//
// Only the two references the site renders from keep their findings:
// `perTarget[].findings` feeds the target page, and the newest `series[]` point
// feeds that target's newest per-run page. The same records also reach the file
// through `runs[].standings[]`, `latest.standings[]` and `perTarget[].current`,
// which are separate copies once serialised, so each is dropped or the whole set
// leaks back in. Two of those three were missed on earlier attempts, which is
// what this function and its test exist to stop recurring.
//
// The digest is taken from the full model before this runs, so it still moves
// when only findings change.
export function leanForFallback(model) {
  // Recurses into nested variants: a variant row is the same shape as its
  // parent and carries its own findings, so stopping at the top level would let
  // the whole set back in through the nesting the moment a variant fails a test.
  const drop = ({ findings, variants, ...rest }) =>
    variants ? { ...rest, variants: variants.map(drop) } : rest;
  return {
    ...model,
    runs: (model.runs ?? []).map((r) => ({ ...r, standings: r.standings.map(drop) })),
    latest: model.latest ? { ...model.latest, standings: model.latest.standings.map(drop) } : model.latest,
    perTarget: Object.fromEntries(
      Object.entries(model.perTarget ?? {}).map(([slug, t]) => {
        const series = t.series ?? [];
        return [
          slug,
          {
            ...t,
            current: t.current ? drop(t.current) : t.current,
            series: series.map((p, i) => (i === series.length - 1 ? p : drop(p))),
          },
        ];
      }),
    ),
  };
}

export function buildModel(snapshots, summary = null) {
  const overlay = summary?.available ? summary : null;
  // Valid, time-ordered snapshots (drop anything without a usable startTime),
  // each overlaid with its best-matching region where the summary has one.
  const snaps = snapshots
    .filter((s) => Number.isFinite(s.startTime) && s.runDate && s.runDate !== "-")
    .sort((a, b) => a.startTime - b.startTime)
    .map((s) => (overlay ? enrichSnapshot(s, overlay) : s));

  // Per target, the latest snapshot for each run date (latest startTime wins).
  const byTarget = new Map(); // slug -> Map(date -> snapshot)
  for (const s of snaps) {
    if (!byTarget.has(s.slug)) byTarget.set(s.slug, new Map());
    const m = byTarget.get(s.slug);
    const existing = m.get(s.runDate);
    if (!existing || s.startTime > existing.startTime) m.set(s.runDate, s);
  }

  // Each target's own re-test dates, oldest first (ISO strings sort chronologically).
  const targetDates = new Map();
  for (const [slug, m] of byTarget) targetDates.set(slug, [...m.keys()].sort());

  // Representative sha + startTime per run date: the latest snapshot of that date.
  const runMeta = new Map(); // date -> { sha, startTime }
  for (const s of snaps) {
    const cur = runMeta.get(s.runDate);
    if (!cur || s.startTime > cur.startTime) runMeta.set(s.runDate, { sha: s.sha, startTime: s.startTime });
  }

  const dates = [...runMeta.keys()].sort(); // oldest first

  const movementForRetest = (slug, date) => {
    const ds = targetDates.get(slug);
    const idx = ds.indexOf(date);
    if (idx <= 0) return newMovement();
    const cur = byTarget.get(slug).get(date);
    const prev = byTarget.get(slug).get(ds[idx - 1]);
    // On divergence, like the series below. Two movement computations exist -
    // one for a run's standings, one for a target's own timeline - and they
    // have to agree, or a row and its history would disagree about whether the
    // same run got better.
    const f = figuresOf(cur);
    const p = figuresOf(prev);
    return withGradeShift(deltaMovement(f.divergenceValue, p.divergenceValue), f, p, {
      cur: date,
      prev: ds[idx - 1],
    });
  };

  // Build runs oldest -> newest.
  const runsAsc = dates.map((date) => {
    const meta = runMeta.get(date);
    const emulatorRows = [];
    for (const [slug, m] of byTarget) {
      let eff = m.get(date);
      const reTested = !!eff;
      if (!eff) {
        const before = targetDates.get(slug).filter((d) => d < date);
        if (before.length === 0) continue; // target not yet present
        eff = m.get(before[before.length - 1]);
      }
      const movement = reTested ? movementForRetest(slug, date) : carriedMovement();
      // Keep the per-area data out of run rows; it lives on perTarget only.
      const { breakdown: _bd, areas: _ar, capabilities: _cap, ...effRow } = eff;
      emulatorRows.push({ ...effRow, reTested, carried: !reTested, movement });
    }

    const suiteSize = suiteSizeOf(emulatorRows);
    const sorted = sortRows(emulatorRows);
    // Real DynamoDB agrees with itself in every region, so its label is "all".
    const dynamodb = {
      ...dynamodbRow(suiteSize, date),
      reTested: true,
      carried: false,
      movement: baselineMovement(),
      ...(overlay ? { regionLabel: baselineRegionLabel(overlay, date), hasRegions: false } : {}),
    };
    const standings = [dynamodb, ...sorted];
    const top = sorted[0];

    return {
      date,
      sha: meta.sha,
      startTime: meta.startTime,
      standings,
      suiteSize,
      emulatorCount: emulatorRows.length,
      headline: {
        topSlug: top?.slug ?? GROUND_TRUTH_SLUG,
        topDisplay: top?.display ?? display(GROUND_TRUTH_SLUG),
        // Whether this run may carry a letter at all. The feed is archived by
        // third parties and its entries keep their original <updated>, so a
        // grade attached to a run that predates the criteria restates history
        // silently: no subscriber re-notifies, and the entry now says the run
        // was graded when nothing graded it at the time.
        graded: gradedUnderCriteria(date),
        // The top target's letter, for the feed: every other surface the
        // grade shipped to leads with it, and the feed should not be the one
        // place a reader still meets a bare percentage pair.
        topGrade: top ? (gradeOf(top.divergenceValue, top.coverageValue).letter ?? "-") : "A+",
        topTotal: top?.total ?? "100.0%",
        // The two published figures, so the feed doesn't have to quote the
        // legacy correctness percentage as a bare "%" on a board where every
        // percentage is divergence and 0.0% is the best result.
        topDivergence: top?.divergence ?? "0.0%",
        topCoverage: top?.coverage ?? "100.0%",
        emulatorCount: emulatorRows.length,
      },
    };
  });

  const ids = assignRunIds(runsAsc.map((r) => ({ date: r.date, sha: r.sha })));
  runsAsc.forEach((r, i) => (r.id = ids[i]));
  const idByDate = new Map(runsAsc.map((r) => [r.date, r.id]));

  // Suite growth vs the previous run. When the suite grows under a target, a
  // run-over-run dip can be the new tests biting rather than a regression, so
  // run pages surface the growth and caveat the movement arrows.
  runsAsc.forEach((r, i) => {
    const prev = i > 0 ? runsAsc[i - 1] : null;
    r.prevSuiteSize = prev ? prev.suiteSize : null;
    r.suiteGrowth = prev ? r.suiteSize - prev.suiteSize : 0;
    r.suiteGrew = r.suiteGrowth > 0;
  });

  const runs = [...runsAsc].reverse(); // newest first
  const latest = runs[0] ?? null;

  // Movement map for the latest run, keyed by slug.
  const movement = {};
  if (latest) for (const row of latest.standings) movement[row.slug] = row.movement;

  // Biggest movers in the latest run: re-tested targets that rose or fell,
  // ordered by the size of the change.
  const movers = latest
    ? latest.standings
        .filter((r) => r.movement.state === "improved" || r.movement.state === "regressed")
        .sort((a, b) => Math.abs(b.movement.delta) - Math.abs(a.movement.delta))
        .slice(0, 3)
        .map((r) => ({
          slug: r.slug,
          display: r.display,
          total: r.total,
          arrow: r.movement.arrow,
          deltaLabel: r.movement.deltaLabel,
          // The strip renders this one. A hand-picked field list drops a new
          // one silently, and an absent reading renders as an empty span
          // rather than as an error.
          deltaReading: r.movement.deltaReading,
          delta: r.movement.delta,
          state: r.movement.state,
          label: r.movement.label,
        }))
    : [];

  // Per-target series of distinct re-tests, each with movement vs the previous one.
  const perTarget = {};
  for (const [slug, m] of byTarget) {
    const ds = targetDates.get(slug);
    const series = ds.map((date, i) => {
      const s = m.get(date);
      const f = figuresOf(s);
      const mv =
        i === 0
          ? newMovement()
          : withGradeShift(
              deltaMovement(f.divergenceValue, figuresOf(m.get(ds[i - 1])).divergenceValue),
              f,
              figuresOf(m.get(ds[i - 1])),
              { cur: date, prev: ds[i - 1] },
            );
      return {
        runId: idByDate.get(date),
        date,
        startTime: s.startTime,
        totalValue: s.totalValue,
        total: s.total,
        ...f,
        tiers: s.tiers,
        version: s.version,
        passed: s.passed,
        failed: s.failed,
        skipped: s.skipped,
        count: s.count,
        movement: mv,
        // What this run actually found, so a run's view of this target shows
        // that run's gaps rather than today's.
        findings: s.findings ?? [],
        sha: s.sha,
      };
    });
    const current = latest ? latest.standings.find((r) => r.slug === slug) : null;
    const latestSnap = m.get(ds[ds.length - 1]);
    // The per-region breakdown for the drilldown, through the same guarded
    // join the headline uses: only an entry describing the target's last
    // tested run. The old unguarded `?? overlay.latest` fallback could put a
    // different run's regions under a headline enriched from the right one -
    // the exact mismatch overlayEntryFor exists to prevent.
    const smTarget = overlay
      ? overlayEntryFor({ slug, runDate: ds[ds.length - 1] }, overlay)
      : null;
    perTarget[slug] = {
      slug,
      display: display(slug),
      target: label(slug),
      repoUrl: repoUrl(slug),
      baseline: false,
      current,
      currentVersion: current?.version ?? series[series.length - 1]?.version ?? "-",
      firstDate: ds[0],
      lastDate: ds[ds.length - 1],
      series,
      // Where the target currently falls short, and its full per-area state
      // (both from its latest snapshot).
      breakdown: latestSnap?.breakdown ?? [],
      // The same gaps as records rather than titles, so the target page can link
      // each one to its own assertion. Everything a record needs is already on it
      // from fetch.mjs; nothing is re-stamped here. Older snapshots predate
      // findings and render from the plain titles in `breakdown` instead.
      findings: latestSnap?.findings ?? [],
      areas: latestSnap?.areas ?? [],
      capabilities: latestSnap?.capabilities ?? [],
      supports: (latestSnap?.areas ?? []).filter((a) => a.state === "supported"),
      // Per-region detail and headline cohort for the drilldown (empty when the
      // overlay is unavailable).
      regions: smTarget?.regions ?? [],
      regionLabel: smTarget?.label ?? null,
      hasRegions: !!smTarget,
      runsPresent: runs.filter((r) => r.standings.some((x) => x.slug === slug)).map((r) => r.id),
    };
  }

  // The union of every operation area any target touches in its latest snapshot
  // - the matrix axis, and the set DynamoDB supports by definition.
  const allAreas = [];
  const seenArea = new Set();
  for (const slug of byTarget.keys()) {
    for (const a of perTarget[slug].areas) {
      if (seenArea.has(a.key)) continue;
      seenArea.add(a.key);
      allAreas.push({ key: a.key, tier: a.tier, group: a.group });
    }
  }
  allAreas.sort((a, b) => a.tier.localeCompare(b.tier) || a.group.localeCompare(b.group));

  // DynamoDB: a definitional flat-100% baseline, one point per run, not a trend.
  if (runsAsc.length > 0) {
    const series = runsAsc.map((r) => {
      const ddb = dynamodbRow(r.suiteSize, r.date);
      return {
        runId: r.id,
        date: r.date,
        startTime: r.startTime,
        totalValue: 100,
        total: "100.0%",
        // The baseline renders a note instead of a chart, but its run-history
        // table is the same component every target's is, so it needs the two
        // published figures rather than correctness alone.
        divergenceValue: 0,
        divergence: "0.0%",
        coverageValue: 100,
        coverage: "100.0%",
        tiers: ddb.tiers,
        version: "live (AWS)",
        passed: r.suiteSize,
        failed: 0,
        skipped: 0,
        count: r.suiteSize,
        movement: baselineMovement(),
      };
    });
    perTarget.dynamodb = {
      slug: GROUND_TRUTH_SLUG,
      display: display(GROUND_TRUTH_SLUG),
      target: label("dynamodb"),
      repoUrl: repoUrl("dynamodb"),
      baseline: true,
      current: latest ? latest.standings.find((r) => r.slug === "dynamodb") : null,
      currentVersion: "live (AWS)",
      firstDate: runsAsc[0].date,
      lastDate: latest.date,
      series,
      breakdown: [],
      // DynamoDB is the ground truth: it supports every area by definition.
      areas: allAreas.map((a) => ({ ...a, passed: 0, failed: 0, skipped: 0, total: 0, state: "supported" })),
      capabilities: CAPABILITIES.map((c) => ({ key: c.key, label: c.label, passed: 0, failed: 0, skipped: 0, total: 0, state: "supported" })),
      supports: allAreas.map((a) => ({ ...a, state: "supported" })),
      // The baseline agrees with itself everywhere, so it has no per-region
      // drilldown, only the "all regions" label.
      regions: [],
      regionLabel: overlay ? baselineRegionLabel(overlay) : null,
      hasRegions: false,
      runsPresent: runs.map((r) => r.id),
    };
  }

  // Target order for indexes/pagination: the latest run's standings order
  // (DynamoDB first, then total descending), with any never-in-latest targets
  // appended. Carry-forward guarantees every seen target is in the latest run.
  const inLatest = latest ? latest.standings.map((r) => r.slug) : [];
  const others = [...byTarget.keys()].filter((s) => !inLatest.includes(s));
  const targets = [...inLatest, ...others];

  // The latest run's region health, surfaced on the model so the deploy digest
  // covers region-only changes (a region dropping in or out) even when no
  // headline number moves.
  const regionHealth = overlay?.latest?.regions ?? null;

  // The board shows each target's current build. That version comes from the
  // suite's summary, which the suite keeps current, rather than the version
  // captured at the run's commit. The two differ only when a version is
  // corrected without a fresh run - the wasm row, whose engine shipped in a
  // later release - where re-running just to move the label would cost the
  // target its "new" status. Scoped to the current display: historical runs
  // (runs[].standings and each target's series) keep the version they were
  // tested at.
  if (overlay?.latest?.targets) {
    for (const row of latest?.standings ?? []) {
      const v = overlay.latest.targets[row.slug]?.version;
      if (v) row.version = v; // perTarget[].current references this same row
    }
    for (const [slug, t] of Object.entries(perTarget)) {
      const v = overlay.latest.targets[slug]?.version;
      if (v) t.currentVersion = v;
    }
  }

  return { runs, latest, movement, movers, targets, perTarget, allAreas, regionHealth, targetRuns: targetRunsOf({ targets, perTarget }) };
}
