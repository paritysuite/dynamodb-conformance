#!/usr/bin/env node

/**
 * Emit a shields.io endpoint badge per target into results/<slug>.badge.json.
 *
 * A target's own README can then show its live grade sourced from this repo
 * via a shields endpoint badge, without copying it into its docs (where it
 * goes stale). Regenerated alongside the results table on every conformance
 * run, so the badge always tracks the latest figures.
 *
 * The badge shows the letter grade, and it matches the published results
 * table exactly: both read the target's headline - its best-matching observed
 * region - from the shared scorer (scoreTarget in lib/score.mjs), take the
 * two axes from the shared axesOf, and grade them with the shared gradeOf.
 * Real DynamoDB reads `baseline` rather than a letter, on the same grounds the
 * table and the site use it (BASELINE_LABEL in lib/grade.mjs): the yardstick is
 * what a grade measures distance from. A run that is not scored reads `not
 * scored`, as its table row does. The badge carried the retired
 * correctness percentage until the board moved to divergence and coverage; a
 * letter cannot be mistaken for either axis, where a bare percentage read as
 * whichever one the reader expected.
 *
 * The endpoint URL is a published contract - a target's README points at it and
 * a rename breaks that README silently - so the path is documented on the site's
 * agent guide alongside the JSON endpoints, and stays stable across a relabel.
 * shields pins its own `schemaVersion` to 1, so the path is the only version
 * channel a badge has.
 *
 * Run: `npm run results:badges` (regenerates the committed badges). The badge
 * freshness test fails if a committed file drifts from a fresh build.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  GROUND_TRUTH_SLUG,
  axesOf,
  isPublishedTarget,
  loadScoringContext,
  scoreTarget,
  targetResultSlug,
} from './lib/score.mjs'
import { BASELINE_GRADE, gradeOf } from './lib/grade.mjs'
import { TARGETS } from './lib/targets.mjs'
import { assertMeasuredSuite, SUMMARY_PATH } from './summarise.mjs'
import { suiteIdentities } from './suite-manifest.mjs'
import { committedGradingInputs } from './lib/measured.mjs'
import { loadRegionHealth, observedRegions } from './lib/observed.mjs'

const RESULTS_DIR = 'results'

// shields.io named colours per letter, brightest at the top of the scale. The
// steps track the grade bands, so a badge and the site row it mirrors read the
// same way. A letterless row (the baseline, or a run that is not scored) falls
// through to the neutral grey.
const COLOURS = {
  'A+': 'brightgreen',
  A: 'green',
  B: 'yellow',
  C: 'orange',
  D: 'red',
  F: 'red',
}

export function colour(letter) {
  return COLOURS[letter] ?? 'lightgrey'
}

// A target's grade, or null when there is nothing to show: the slug is a
// reserved scratch slug (e.g. local) or the file is not a target result (e.g.
// tag-manifest.json). A target whose run is not scored - an indeterminate, or
// nothing implemented - gets gradeOf's letterless `not scored` grade, the same
// one its summary row carries. `context` carries the registry and observed
// region set (loadScoringContext) plus the run's indeterminate sidecar, when it
// wrote one.
export function gradeFor(slug, raw, context) {
  if (!isPublishedTarget(slug)) return null
  if (slug === GROUND_TRUTH_SLUG) return BASELINE_GRADE
  const scored = scoreTarget(raw, context.sidecar ?? null, context)
  if (!scored) return null
  const { divergence, coverage } = axesOf(scored.regions[scored.headline.region])
  return gradeOf(divergence, coverage)
}

// Build the shields.io endpoint badge object for a target, or null when there
// is nothing to show. Pure (no I/O) so it backs both the CLI writer and the
// freshness test.
export function buildBadge(slug, raw, context) {
  const grade = gradeFor(slug, raw, context)
  if (grade === null) return null
  // A letterless grade badges its qualifier in the neutral fallback colour:
  // `baseline` for the ground truth, `not scored` for a run with no letter.
  const message = grade.letter ?? grade.qualifier
  return {
    schemaVersion: 1,
    label: 'parity',
    message,
    color: colour(grade.letter),
  }
}

// Write results/<slug>.badge.json for every target result file, scored or
// not, and deal with any badge whose results file is gone: a target still on
// the board gets a `no data` tombstone, and a slug the suite no longer knows
// has its badge deleted. Returns the three counts.
//
// Third parties embed these in their own READMEs, so a badge must not keep
// serving a letter its results no longer support, from a URL they do not
// control. The freshness test notices the drift; only rewriting or deleting
// the file fixes it.
//
// Sidecar and badge files are companions of a target's results file, not
// targets, so they are never scored themselves.
export function writeBadges(resultsDir = RESULTS_DIR, context = loadScoringContext(), suite = suiteIdentities()) {
  // Read every target first, then apply the same population guard the summary
  // does, then write. A badge is the one figure this project puts inside other
  // people's READMEs, so it must not be able to outrun the artefact it mirrors:
  // without this, a results file that summarise.mjs refuses to publish still
  // shipped its letter to every README embedding the badge URL.
  const scored = []
  for (const file of readdirSync(resultsDir)) {
    const slug = targetResultSlug(file)
    if (!slug) continue
    const raw = JSON.parse(readFileSync(join(resultsDir, file), 'utf8'))
    const sidecarFile = join(resultsDir, `${slug}.indeterminate.json`)
    const sidecar = existsSync(sidecarFile)
      ? JSON.parse(readFileSync(sidecarFile, 'utf8'))
      : null
    scored.push({ slug, raw, sidecar })
  }
  assertMeasuredSuite(scored, suite)

  const current = new Set()
  let written = 0
  for (const { slug, raw, sidecar } of scored) {
    const badge = buildBadge(slug, raw, { ...context, sidecar })
    // A results file that exists keeps its badge even when this run produced
    // no letter. A run-level indeterminate - one provisioning timeout - makes
    // the row unscored for that sweep, and deleting the badge would 404 a URL
    // inside a third party's README over an infrastructure fault, so it reads
    // `not scored` instead. Only a target with no results file at all is gone.
    current.add(`${slug}.badge.json`)
    if (!badge) continue
    writeFileSync(
      join(resultsDir, `${slug}.badge.json`),
      `${JSON.stringify(badge, null, 2)}\n`,
    )
    written++
  }

  // A badge whose target is still on the board but has no results this run is
  // a tombstone, not a deletion: the URL sits in someone else's README, and a
  // 404 there reads as the project having vanished rather than as a gap in
  // this board. A slug the suite no longer knows is genuinely gone, so its
  // badge goes with it.
  let pruned = 0
  let retired = 0
  for (const file of readdirSync(resultsDir).filter((f) => f.endsWith('.badge.json'))) {
    if (current.has(file)) continue
    const slug = basename(file, '.badge.json')
    if (TARGETS[slug]) {
      writeFileSync(
        join(resultsDir, file),
        `${JSON.stringify({ schemaVersion: 1, label: 'parity', message: 'no data', color: 'lightgrey' }, null, 2)}\n`,
      )
      retired++
      continue
    }
    rmSync(join(resultsDir, file))
    pruned++
  }
  return { written, pruned, retired }
}

// CLI: regenerate the committed badges.
//
// Badges carry the same letters as the rows they mirror, so they have to be
// graded against the same suite. This runs straight after summarise.mjs in the
// publishing job, which stands on main because it commits back, so the default
// arguments would grade from main's manifest and registry while the table beside
// them graded at the measured ref - and a badge would contradict its own row.
// The board has just recorded what it measured; read it back and use that.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(SUMMARY_PATH)) {
    console.error(`refusing to write badges: ${SUMMARY_PATH} does not exist. Run summarise first.`)
    process.exit(1)
  }
  const { manifest, registry } = committedGradingInputs(SUMMARY_PATH)
  const health = loadRegionHealth()
  const { written, pruned, retired } = writeBadges(
    RESULTS_DIR,
    { registry, health, observed: observedRegions(health) },
    suiteIdentities(manifest),
  )
  const notes = [retired && `${retired} tombstoned`, pruned && `${pruned} pruned`].filter(Boolean)
  console.error(`wrote ${written} badge file(s) to ${RESULTS_DIR}/${notes.length ? `, ${notes.join(', ')}` : ''}`)
}
