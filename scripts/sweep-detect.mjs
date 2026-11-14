#!/usr/bin/env node

/**
 * Detect regional splits from a sweep's per-region ground truth, confirm them
 * with targeted re-runs, and hand a human the evidence.
 *
 * Reads a directory of per-region results (`ground-truth/<region>.json` plus
 * `<region>.indeterminate.json` sidecars), classifies each region's run,
 * health-gates it, and compares classified verdicts across the resolved
 * regions. A test where regions disagree - and EVERY side returned a definite
 * answer - is a split candidate. A test where any side was indeterminate is
 * not a candidate, full stop: absence is not disagreement, and a timeout must
 * never be read as a behavioural difference.
 *
 * Candidates do not approach the registry on one observation. With --confirm,
 * each candidate is re-run - only that test, in only the disagreeing regions,
 * several times - and survives only if every re-run reproduces the first
 * observation. This targeted repeat is the flake remedy: re-running one test
 * five times costs less than one extra whole-suite pass, and repeating a whole
 * noisy suite would sample the same noise three times, not denoise it.
 * Candidates sharing a file and a region share each re-run process, and the
 * whole step runs inside a wall-clock budget. A candidate that could not be
 * re-run (its selector picks out no test or several, the test is gone from
 * the checked-out commit, it did not run, its process timed out, or the
 * budget ran out first) is not a verdict on the candidate: it is listed in
 * the report, annotated as an error in the run log, and filed on a
 * `confirmation-error` issue. Those are the signal. The script still exits 0
 * for it, because the sweep gates nothing and a red run on main's head would
 * hold up the release.
 *
 * THE SCRIPT NEVER WRITES registry/splits.json, UNDER ANY CODE PATH. Confirmed
 * candidates, and drift on already-admitted rows (regions that converged, or
 * now disagree differently), become GitHub issues carrying the evidence and
 * provenance; a human adjudicates and commits the row by hand. That gate is
 * the whole integrity story - see registry/README.md. Automated writes here
 * would launder a regional AWS defect, or plain noise, straight into the
 * baseline every target is scored against. A row that drifted and now
 * answers as recorded again gets a comment on its open drift issue, so an
 * earlier verdict does not stand unchallenged; closing it is still a human's
 * call.
 *
 * The health verdicts also drive the observed-set bookkeeping: with
 * --record-health the per-region resolved/unresolved outcome is recorded into
 * registry/regions.json via scripts/lib/observed.mjs, and a region dropped by
 * this sweep (two consecutive misses) produces a paging issue in the same act.
 *
 * Usage:
 *   node scripts/sweep-detect.mjs <ground-truth-dir>
 *     [--expect r1,r2,...]        regions the sweep was meant to cover; one with
 *                                 no results file is unresolved, never silent
 *     [--registry <path>]         split registry to read (default registry/splits.json)
 *     [--record-health <path>]    record per-region outcomes (registry/regions.json)
 *     [--date YYYY-MM-DD]         sweep date for --record-health (default: today, UTC)
 *     [--confirm]                 targeted re-runs against real AWS (needs credentials)
 *     [--confirm-runs N]          re-runs per region per candidate (default 5)
 *     [--confirm-budget-minutes N] wall-clock budget for the whole confirmation
 *                                 step (default 75, or SWEEP_CONFIRM_BUDGET_MINUTES)
 *     [--measured-ref <commit>]   the commit the sweep measured, named when a
 *                                 candidate's test is gone from the checkout
 *     [--out <path>]              write the machine-readable sweep report
 *     [--file-issues]             file/refresh GitHub issues via `gh`; without it,
 *                                 issue bodies are printed (a dry run)
 *     [--run-url <url>]           provenance link for issue bodies
 */

import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { classifyResults } from './lib/classify.mjs'
import { assessRegion } from './lib/health.mjs'
import {
  isRegionName,
  loadRegistry,
  sameObservation,
  splitFor,
  verdictAgainstPin,
} from './lib/registry.mjs'
import { loadRegionHealth, recordSweep, validateRegionHealth } from './lib/observed.mjs'
import { DEAD_ENDPOINT } from './suite-manifest.mjs'

// The one file this script must never write, whatever it was asked to read.
const SPLIT_REGISTRY = 'registry/splits.json'

// ── Reading a sweep directory ────────────────────────────────────────────────

/**
 * Read every per-region result in a sweep directory: `<region>.json` and, when
 * the run wrote one, its `<region>.indeterminate.json` sidecar. Non-region
 * files (README.md, sweep reports, the ad-hoc `latest.json` capture) are
 * ignored. Returns { [region]: { results, sidecar } }.
 */
export function readSweepDir(dir) {
  const docs = {}
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry.endsWith('.indeterminate.json')) continue
    const region = basename(entry, '.json')
    if (!isRegionName(region)) continue
    const results = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
    const sidecarFile = join(dir, `${region}.indeterminate.json`)
    const sidecar = existsSync(sidecarFile)
      ? JSON.parse(readFileSync(sidecarFile, 'utf8'))
      : null
    docs[region] = { results, sidecar }
  }
  return docs
}

// Vitest records the runner's absolute file paths; regions ran in separate CI
// jobs, so cross-region joins (and registry rows) use the repo-relative path.
export function relativeTestFile(file) {
  const ix = file.lastIndexOf('/tests/')
  return ix === -1 ? file : file.slice(ix + 1)
}

// ── Detection ────────────────────────────────────────────────────────────────

function byTest(verdictsByRegion) {
  const tests = new Map()
  for (const [region, verdicts] of Object.entries(verdictsByRegion)) {
    for (const v of verdicts) {
      const file = relativeTestFile(v.file)
      const key = `${file}\n${v.fullName}`
      let entry = tests.get(key)
      if (!entry) {
        entry = { test: { file, fullName: v.fullName, title: v.title }, regions: {}, observed: {} }
        tests.set(key, entry)
      }
      entry.regions[region] = v.verdict
      if (v.observed !== undefined) entry.observed[region] = v.observed
    }
  }
  return tests
}

/**
 * Split candidates: tests where resolved regions returned definite, differing
 * answers. Callers must pass only resolved regions' verdicts - an unresolved
 * region contributes nothing, not even its passes (see scripts/lib/health.mjs).
 *
 * Ineligible, by design:
 * - any region indeterminate on the test: absence is not disagreement;
 * - a skip anywhere: a probe that declined is not an answer to compare;
 * - tests with an admitted registry row: expected to disagree; whether they
 *   still disagree the recorded way is detectRegistryDrift's business.
 */
export function detectSplitCandidates(verdictsByRegion, registry) {
  const candidates = []
  for (const entry of byTest(verdictsByRegion).values()) {
    const verdicts = Object.values(entry.regions)
    if (verdicts.includes('indeterminate') || verdicts.includes('skip')) continue
    if (!verdicts.includes('pass') || !verdicts.includes('fail')) continue
    if (splitFor(registry, entry.test)) continue
    candidates.push(entry)
  }
  return candidates.sort((a, b) =>
    `${a.test.file}\n${a.test.fullName}`.localeCompare(`${b.test.file}\n${b.test.fullName}`),
  )
}

/**
 * Drift on admitted rows. Each row implies a verdict per named region: the
 * committed assertion encodes the pinned region's answer, so a region recorded
 * as agreeing with the pinned answer should pass it, and a region recorded as
 * answering differently should fail it. A definite verdict contradicting that
 * is drift; an indeterminate or missing observation says nothing and draws no
 * conclusion.
 *
 * Findings are `converged` (every named region gave a definite answer and all
 * gave the SAME one, so no region remains on the other side of the recorded
 * split - the row should be retired) or `moved` (a definite answer contradicts
 * the row but the observations do not collapse to one side: either regions
 * remain on both sides, or a named region gave no definite answer and the
 * collapse cannot be claimed). Convergence has two directions - all-pass is
 * convergence onto the pinned answer; all-fail means every region left the
 * pinned side, and whether the off-side answers coincide is for the
 * adjudicator to read from the evidence, since a fail only says "not the
 * pinned answer". Either way the outcome is an issue for a human - reality
 * moving is never a silent registry edit.
 */
export function detectRegistryDrift(verdictsByRegion, registry) {
  const tests = byTest(verdictsByRegion)
  const findings = []
  for (const row of registry.splits) {
    const reading = readRow(row, tests)
    if (!reading) continue
    const { expected, actual, mismatched, definite } = reading
    if (mismatched.length === 0) continue

    const answers = new Set(Object.values(actual))
    const converged = definite && answers.size === 1
    findings.push({
      row: { id: row.id, test: row.test, pinned: row.pinned, behaviour: row.behaviour },
      kind: converged ? 'converged' : 'moved',
      ...(converged ? { convergedOn: answers.has('pass') ? 'pinned' : 'off-pinned' } : {}),
      expected,
      actual,
      mismatched,
    })
  }
  return findings
}

/**
 * Admitted rows the sweep saw answered exactly as recorded: every named region
 * gave a definite verdict and each one is the verdict the row implies.
 *
 * Silence was the old reading of this, and it left a drift issue filed on an
 * earlier sweep standing as if its verdict still held (#179 kept recommending
 * a row be retired after the region that had converged moved back). A row
 * with a named region indeterminate or absent is not reported: the sweep
 * cannot vouch for a region it did not hear from.
 */
export function detectMatchingRows(verdictsByRegion, registry) {
  const tests = byTest(verdictsByRegion)
  const matching = []
  for (const row of registry.splits) {
    const reading = readRow(row, tests)
    if (!reading || !reading.definite || reading.mismatched.length > 0) continue
    matching.push({ id: row.id, test: row.test })
  }
  return matching
}

// What the sweep saw on one admitted row: the verdict the row implies in each
// named region, the definite verdicts observed, which of those contradict the
// row, and whether every named region answered. Null when the sweep did not
// run the row's test at all. A pass is read against the pinned answer from the
// region's recorded observation (verdictAgainstPin), so a test that accepts
// more than one recorded answer does not show every region as on the pinned
// side.
function readRow(row, tests) {
  const entry = tests.get(`${row.test.file}\n${row.test.fullName}`)
  if (!entry) return null

  const expected = {}
  const actual = {}
  for (const region of Object.keys(row.regions)) {
    expected[region] = sameObservation(row.regions[region], row.regions[row.pinned])
      ? 'pass'
      : 'fail'
    const v = verdictAgainstPin(row, entry.regions[region], entry.observed[region])
    if (v === 'pass' || v === 'fail') actual[region] = v
  }
  return {
    expected,
    actual,
    mismatched: Object.keys(actual).filter((r) => actual[r] !== expected[r]),
    definite: Object.keys(row.regions).every((r) => r in actual),
  }
}

/**
 * Every definite failure in a region's verdicts, annotated for the sweep
 * report - { file, fullName, explained, rowId? } - so a human can adjudicate
 * from the report alone.
 *
 * Every region lists every definite failure, resolved or not. An unresolved
 * region's list is the only place its redness is legible. A resolved
 * region's explained failures are the cohort-membership evidence an
 * adjudicator needs to extend an admitted row to regions it does not yet
 * name (they surface nowhere else: candidates skip admitted rows, drift
 * checks only named regions, the health gate excludes them). And a resolved
 * region's novel failures are NOT always candidates - a test every region
 * fails has no pass side and never becomes one - so filtering them out here
 * would be the one place a uniform behaviour change could hide. Nothing here
 * may produce silence.
 *
 * `rowFor(verdict)` returns the admitted registry row or null; injected so
 * explained-ness has exactly one definition, shared with the health gate.
 */
export function reportFailures(verdicts, rowFor) {
  const failures = []
  for (const v of verdicts) {
    if (v.verdict !== 'fail') continue
    const row = rowFor(v)
    failures.push({
      file: relativeTestFile(v.file),
      fullName: v.fullName,
      explained: Boolean(row),
      ...(row ? { rowId: row.id } : {}),
    })
  }
  return failures
}

/** Raw per-region evidence for one test: status and failure messages. */
export function evidenceFor(docs, test) {
  const out = {}
  for (const [region, { results }] of Object.entries(docs)) {
    for (const tr of results.testResults ?? []) {
      if (relativeTestFile(tr.name) !== test.file) continue
      for (const ar of tr.assertionResults ?? []) {
        if (ar.fullName === test.fullName) {
          out[region] = { status: ar.status, failureMessages: ar.failureMessages ?? [] }
        }
      }
    }
  }
  return out
}

// ── Targeted confirmation ────────────────────────────────────────────────────

const testKey = (test) => `${test.file}\n${test.fullName}`

// An error that says which way confirmation broke, so the issue it lands on can
// say what to do about it. Kinds: not-found, selection, not-run, timeout,
// budget, runner.
function confirmationError(kind, message) {
  const e = new Error(message)
  e.kind = kind
  return e
}

/**
 * Re-run each candidate - only that test, in only the regions on the
 * divergent side - `runs` times each, keeping only candidates where every
 * re-run reproduces the sweep's failure. A re-run that ran the test and got
 * something else (a pass, or an indeterminate the test itself recorded: a
 * timeout, throttle or transport fault) discards the candidate: it was
 * non-determinism, not a split, or it could not be re-observed - and in
 * neither case may it approach the registry.
 *
 * A re-run that observed nothing is neither of those, and goes to `errored`
 * with an `errorKind`, never to `discarded`: nothing was observed, so nothing
 * was refuted, and an absence must never confirm a candidate nor quietly
 * discard one. That covers a selector that picks out no test or more than
 * one, a test no longer present on the checked-out commit, a selected test
 * that did not run (reported skipped, absent from the results, a run-level
 * fault, no results file at all), a process that timed out, and candidates
 * the confirmation budget never reached. The remaining candidates are still
 * confirmed.
 *
 * Candidates sharing a test file and a fail-side region are a group, re-run
 * together: one process per attempt selects all of them, and each attempt
 * yields a verdict per test. A candidate is decided as soon as it gives
 * anything but a fail, in any region, and leaves every group it is in, so
 * later attempts run only what is still failing. A wide candidate is
 * confirmed once every one of its fail-side regions has reproduced the
 * failure on every attempt.
 *
 * Groups run narrowest first: the group whose narrowest candidate has the
 * fewest fail-side regions, then by file, then region. Confirmation runs in
 * two phases. In the first, every group gets attempt 1, which is where most
 * candidates that will not reproduce are refuted, and a wide candidate
 * refuted in its first region costs nothing in the others. In the second,
 * each group runs its remaining attempts to the end before the next group
 * starts, so a narrow candidate is confirmed before a wide one can spend the
 * budget, and a budget that runs short falls on the widest candidates.
 *
 * Only the fail side is re-run. A fail verdict contradicts the committed
 * assertion and must reproduce to be believed; a pass verdict is the steady
 * state, re-proven by every sweep of that region. Re-running the pass side
 * too would scale confirmation with the region set instead of the divergent
 * cohort, which on a full-region sweep costs more wall-clock than the sweep
 * itself and busts the detect job's ceiling. The confirmation block records
 * which regions were re-run so downstream provenance never overstates the
 * evidence.
 *
 * `budgetMs` bounds the whole step, measured from its start: no process
 * starts once it is spent, and each one is told how much is left. Everything
 * not yet decided is then recorded as could-not-be-re-run, so the step always
 * finishes and the sweep still files and reports what it has. `onProgress`
 * gets a checkpoint after every process and once at the end.
 *
 * `runTests(region, tests, { remainingMs })` returns a Map from test key
 * (`file\nfullName`) to `{ verdict }` or `{ error, kind }`, and throws (with a
 * `kind`) when the attempt as a whole could not be made. The default runner
 * spawns the real suite (makeVitestRunner). Injected, with `now`, so the logic
 * tests without AWS or a real clock.
 */
export async function confirmCandidates(
  candidates,
  { runs = 5, runTests, onProgress, budgetMs = Infinity, now = Date.now } = {},
) {
  const started = now()
  const order = new Map(candidates.map((c, i) => [c, i]))
  const state = new Map()
  const groups = new Map()
  for (const candidate of candidates) {
    const rerunRegions = Object.keys(candidate.regions)
      .filter((region) => candidate.regions[region] === 'fail')
      .sort()
    // detectSplitCandidates guarantees a mixed pass/fail verdict set. A
    // candidate with no fail side is a broken caller, and it must fail loudly
    // here: discarding it politely would launder the contract violation into
    // an outcome indistinguishable from a legitimate flake.
    if (rerunRegions.length === 0) {
      throw new Error(
        `confirmCandidates: candidate "${candidate.test.fullName}" has no fail-side region; ` +
          'detectSplitCandidates guarantees a mixed verdict set',
      )
    }
    const own = []
    state.set(candidate, { regions: rerunRegions, groups: own, decided: false })
    for (const region of rerunRegions) {
      const key = `${candidate.test.file}\n${region}`
      if (!groups.has(key)) groups.set(key, { file: candidate.test.file, region, members: [], attempts: 0 })
      groups.get(key).members.push(candidate)
      own.push(groups.get(key))
    }
  }

  const confirmed = []
  const discarded = []
  const errored = []
  const byOrder = (a, b) => order.get(a.candidate) - order.get(b.candidate)
  const strip = (list) => [...list].sort(byOrder).map(({ candidate, ...rest }) => ({ ...candidate, ...rest }))
  const decide = (list, candidate, extra) => {
    state.get(candidate).decided = true
    list.push({ candidate, ...extra })
  }
  const snapshot = () => ({ confirmed: strip(confirmed), discarded: strip(discarded), errored: strip(errored) })

  const width = (g) => Math.min(...g.members.map((c) => state.get(c).regions.length))
  const ordered = [...groups.values()].sort(
    (a, b) => width(a) - width(b) || a.file.localeCompare(b.file) || a.region.localeCompare(b.region),
  )

  // Phase 1: attempt 1 for every group. Phase 2: each group's remaining
  // attempts in turn, so it finishes before the next, wider one starts.
  function* schedule() {
    for (const group of ordered) yield [group, 1]
    for (const group of ordered) for (let i = 2; i <= runs; i++) yield [group, i]
  }

  let attempts = 0
  for (const [group, i] of schedule()) {
    const active = group.members.filter((c) => !state.get(c).decided)
    if (active.length === 0) continue
    const remainingMs = budgetMs - (now() - started)
    if (remainingMs <= 0) break
    attempts++
    group.attempts++
    let results
    try {
      results = await runTests(group.region, active.map((c) => c.test), { remainingMs })
    } catch (e) {
      for (const c of active) {
        decide(errored, c, {
          error: `re-run ${i} in ${group.region} could not be made: ${e.message}`,
          errorKind: e.kind ?? 'runner',
        })
      }
      onProgress?.(snapshot())
      continue
    }
    for (const c of active) {
      const r = results.get(testKey(c.test))
      if (r === undefined) {
        decide(errored, c, {
          error: `re-run ${i} in ${group.region} returned no result for this test`,
          errorKind: 'not-run',
        })
      } else if (r.error !== undefined) {
        decide(errored, c, {
          error: `re-run ${i} in ${group.region} could not be made: ${r.error}`,
          errorKind: r.kind ?? 'runner',
        })
      } else if (r.verdict === 'skip') {
        decide(errored, c, {
          error:
            `re-run ${i} in ${group.region} selected the test but it did not run (reported skipped), ` +
            'most likely because the tables it needs could not be provisioned',
          errorKind: 'not-run',
        })
      } else if (r.verdict !== 'fail') {
        decide(discarded, c, {
          reason: `re-run ${i} in ${group.region} returned ${r.verdict}; the sweep observed fail`,
        })
      } else if (state.get(c).groups.every((g) => g.attempts === runs)) {
        // Every attempt in every fail-side region reproduced the failure.
        decide(confirmed, c, { confirmation: { runs, regions: state.get(c).regions } })
      }
    }
    // Checkpoint after every process: a timeout in the tail costs only the
    // candidates not yet decided, never the ones already done.
    onProgress?.(snapshot())
  }

  // A candidate is decided when its last attempt reports, so anything still
  // undecided is one the budget never let finish.
  const minutes = Math.round((budgetMs / 60_000) * 10) / 10
  for (const c of candidates) {
    if (state.get(c).decided) continue
    decide(errored, c, {
      error: `not re-run to the end: the confirmation step's ${minutes}-minute budget ran out after ${attempts} attempt(s)`,
      errorKind: 'budget',
    })
  }
  // The cost data future re-tuning (--confirm-runs, the budget) needs.
  for (const group of ordered) {
    console.log(
      `confirm: ${group.file} in ${group.region}: ${group.attempts} attempt(s) for ${group.members.length} candidate(s)`,
    )
  }
  console.log(`confirm: ${attempts} attempt(s), ${Math.round((now() - started) / 1000)}s`)
  onProgress?.(snapshot())
  return { ...snapshot(), attempts }
}

// Vitest joins a test's describe names and its own name with this when it
// matches --testNamePattern (`fullTestName` in its runner). The JSON
// reporter's `fullName` joins the same parts with a single space instead, so
// a pattern built from `fullName` matches nothing once a test sits in a
// describe block.
const VITEST_NAME_SEPARATOR = ' > '

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function checkNames(names) {
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((n) => typeof n !== 'string' || n === '')
  ) {
    throw new Error(`cannot build a test name pattern from ${JSON.stringify(names)}`)
  }
  return names
}

/**
 * The --testNamePattern that selects one test and nothing else: its name
 * parts (describe names, outermost first, then its own) joined the way vitest
 * joins them, every character literal, anchored at both ends so a test whose
 * name merely starts or ends the same way is not selected too.
 */
export function testNamePattern(names) {
  return testNamesPattern([names])
}

/**
 * The pattern selecting several tests at once: each one's full name as an
 * anchored alternative, so the selection is exactly their union.
 */
export function testNamesPattern(namesList) {
  if (!Array.isArray(namesList) || namesList.length === 0) {
    throw new Error('cannot build a test name pattern from no tests')
  }
  const alternatives = namesList.map((names) =>
    escapeRegExp(checkNames(names).join(VITEST_NAME_SEPARATOR)),
  )
  return `^(?:${alternatives.join('|')})$`
}

/**
 * A test's name parts as the sweep's own results recorded them:
 * `[...ancestorTitles, title]`. Taken from the results rather than recovered
 * from `fullName`, which joins the parts with spaces and so cannot be split
 * back when a name contains one. Throws when no region recorded the parts, or
 * when regions recorded different parts for the same file and full name: two
 * tests the space-joined name cannot tell apart, so no re-run can pick one.
 */
export function testNamesFor(docs, test) {
  const found = new Map()
  for (const { results } of Object.values(docs)) {
    for (const tr of results.testResults ?? []) {
      if (relativeTestFile(tr.name) !== test.file) continue
      for (const ar of tr.assertionResults ?? []) {
        if (ar.fullName !== test.fullName || !Array.isArray(ar.ancestorTitles)) continue
        const names = [...ar.ancestorTitles, ar.title]
        found.set(JSON.stringify(names), names)
      }
    }
  }
  if (found.size === 0) {
    throw new Error(`the sweep's results carry no name parts for "${test.fullName}"`)
  }
  if (found.size > 1) {
    throw new Error(
      `"${test.fullName}" names ${found.size} different tests in ${test.file}: ` +
        [...found.values()].map((n) => n.join(VITEST_NAME_SEPARATOR)).join('; '),
    )
  }
  return [...found.values()][0]
}

// vitest's own entry point, run with this node rather than through npx.
const vitestBin = (cwd) => join(cwd, 'node_modules', 'vitest', 'vitest.mjs')

// Spawn time limits are whole milliseconds, and at least one.
const wholeMs = (ms) => Math.max(1, Math.floor(ms))

// How much of a command's output is kept, per stream: the end of it, which is
// where a hang or a crash shows.
const OUTPUT_TAIL_CHARS = 64 * 1024

/**
 * The last `limit` characters of a stream, decoded as UTF-8 across chunk
 * boundaries so a character split between two chunks is not garbled. Memory
 * stays within twice the limit however much is written.
 */
export function outputTail(limit = OUTPUT_TAIL_CHARS) {
  const decoder = new StringDecoder('utf8')
  let text = ''
  const trim = () => {
    if (text.length > limit) text = text.slice(-limit)
  }
  return {
    push(chunk) {
      text += decoder.write(chunk)
      if (text.length > 2 * limit) trim()
    },
    end() {
      text += decoder.end()
      trim()
      return text
    },
    get size() {
      return text.length
    },
  }
}

// Process groups started here and still running. A signal to this script
// (Ctrl-C on a local run, or a runner stopping it) does not reach them, since
// each is a group of its own, so it is passed on as a kill.
const liveGroups = new Set()
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
function onForwardedSignal(signal) {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  liveGroups.clear()
  for (const s of FORWARDED_SIGNALS) process.removeListener(s, onForwardedSignal)
  // With the handler gone the signal's default applies again: raised once
  // more, it ends this process the conventional way.
  process.kill(process.pid, signal)
}
// Handlers are installed only while a group is running, so importing this
// module changes nothing about how the process handles signals.
function trackGroup(pid) {
  if (liveGroups.size === 0) for (const s of FORWARDED_SIGNALS) process.on(s, onForwardedSignal)
  liveGroups.add(pid)
}
function untrackGroup(pid) {
  if (!liveGroups.delete(pid)) return
  if (liveGroups.size === 0) for (const s of FORWARDED_SIGNALS) process.removeListener(s, onForwardedSignal)
}

/**
 * Run a command in its own process group and wait for it, killing the whole
 * group when `timeout` passes. spawnSync's timeout signals only the process
 * it started; vitest's forks pool leaves its worker behind as an orphan,
 * still running tests against the region's tables, and the suite's global
 * teardown never runs. Tables a killed re-run leaves are removed by the next
 * re-run's prefix sweep in that region, or by the daily orphan cleanup.
 *
 * The result is settled by the command's exit, not by its output closing: on
 * exit the timer stops and the group is killed, so nothing it started
 * outlives it, and the result resolves once the output closes or `graceMs`
 * after the exit, whichever is first. A process outside the group still
 * holding the output cannot hold the result up. Only the tail of each
 * stream is kept (outputTail).
 */
export function spawnGroup(cmd, args, { cwd, env, timeout, graceMs = 1000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawnChild(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = outputTail()
    const err = outputTail()
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    let timedOutFlag = false
    let exited = null
    let settled = false
    let grace = null
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timer =
      timeout === undefined
        ? null
        : setTimeout(() => {
            timedOutFlag = true
            killGroup()
          }, timeout)
    const settle = (extra = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      untrackGroup(child.pid)
      child.stdout.destroy()
      child.stderr.destroy()
      resolvePromise({
        status: exited?.status ?? null,
        signal: exited?.signal ?? null,
        stdout: out.end(),
        stderr: err.end(),
        timedOut: timedOutFlag,
        ...extra,
      })
    }
    child.on('error', (error) => settle({ error }))
    child.on('exit', (status, signal) => {
      exited = { status, signal }
      clearTimeout(timer)
      killGroup()
      grace = setTimeout(settle, graceMs)
    })
    child.on('close', (status, signal) => {
      exited ??= { status, signal }
      settle()
    })
    if (child.pid !== undefined) trackGroup(child.pid)
  })
}

// A spawn result that ended because its time ran out: it did not finish, and
// nothing it wrote can be read as complete.
function timedOut(res) {
  return Boolean(res?.timedOut || res?.error?.code === 'ETIMEDOUT')
}

// A spawn result ended by a signal this script did not send: not a timeout,
// and not a finished run either.
function killedBy(res) {
  return res?.signal != null && res?.status == null && !timedOut(res) ? res.signal : null
}

/**
 * Print the end of a command's output to the run log, folded into a group,
 * so a re-run that timed out or produced nothing can be looked into. The
 * output is the command's own, so workflow commands in it are switched off
 * while it prints.
 */
export function printOutputTail(label, res, { lines = 40, log = console.log } = {}) {
  const token = randomBytes(8).toString('hex')
  log(`::group::${oneLine(label)}`)
  log(`::stop-commands::${token}`)
  for (const [name, text] of [
    ['stdout', res?.stdout],
    ['stderr', res?.stderr],
  ]) {
    const tail = String(text ?? '').trimEnd().split('\n').slice(-lines)
    log(`--- last ${tail.length} line(s) of ${name} ---`)
    for (const line of tail) log(line)
  }
  log(`::${token}::`)
  log('::endgroup::')
}

// The time limit for one spawn: its own limit, or what is left of the budget
// if that is shorter. `binding` says which, so running out is reported as the
// budget's doing when it was.
function spawnLimit(ownMs, deadline, now) {
  const leftMs = deadline - now()
  if (leftMs <= 0) {
    throw confirmationError('budget', "the confirmation step's budget ran out before this re-run could start")
  }
  return leftMs < ownMs
    ? { timeoutMs: wholeMs(leftMs), binding: 'budget' }
    : { timeoutMs: wholeMs(ownMs), binding: 'timeout' }
}

function ranOut(binding, what, timeoutMs) {
  return binding === 'budget'
    ? confirmationError('budget', `${what} was stopped when the confirmation step's budget ran out`)
    : confirmationError('timeout', `${what} ran past its ${Math.round(timeoutMs / 1000)}s limit and was stopped`)
}

/**
 * The tests a re-run would select, asked of vitest itself without running
 * any: `vitest list` with the same file filter and name pattern the re-run
 * passes (no pattern lists the whole file). Collection happens at runtime
 * (--staticParse=false) because the static parser leaves `it.each` names
 * unexpanded, so its answer can differ from what a run selects. Resolves to
 * [{ name, file }] with `file` relative to `cwd` (the repo root).
 *
 * Runtime collection also runs the suite's global teardown, which sweeps the
 * table namespace. A listing must never reach AWS for that, so it runs
 * against a dead endpoint with dummy credentials whatever `env` says. The
 * teardown then fails and vitest exits non-zero, but only after the listing
 * is written: the file is the signal, not the exit status.
 */
export async function listSelected({
  cwd = process.cwd(),
  env = process.env,
  file,
  pattern = null,
  vitestArgs = [],
  spawn = spawnGroup,
  tmpRoot = tmpdir(),
  timeoutMs = 60_000,
  binding = 'timeout',
  region = null,
}) {
  const dir = mkdtempSync(join(tmpRoot, 'sweep-select-'))
  try {
    const listFile = join(dir, 'selected.json')
    const listEnv = {
      ...env,
      DYNAMODB_ENDPOINT: DEAD_ENDPOINT,
      AWS_ACCESS_KEY_ID: 'listing-only',
      AWS_SECRET_ACCESS_KEY: 'listing-only',
    }
    delete listEnv.AWS_SESSION_TOKEN
    delete listEnv.AWS_PROFILE
    const limit = wholeMs(timeoutMs)
    const res = await spawn(
      process.execPath,
      [
        vitestBin(cwd),
        'list',
        file,
        ...vitestArgs,
        '--staticParse=false',
        ...(pattern === null ? [] : [`--testNamePattern=${pattern}`]),
        `--json=${listFile}`,
      ],
      { cwd, env: listEnv, timeout: limit },
    )
    const failed = (error) => {
      printOutputTail(`vitest list ${file}${region ? ` in ${region}` : ''}`, res)
      return error
    }
    if (timedOut(res)) throw failed(ranOut(binding, 'vitest list', limit))
    const signal = killedBy(res)
    if (signal) throw failed(confirmationError('runner', `vitest list was ended by ${signal}`))
    if (!existsSync(listFile)) {
      const tail = `${res?.stderr ?? ''}\n${res?.stdout ?? ''}`.trim().split('\n').slice(-5).join(' | ')
      throw failed(confirmationError('runner', `vitest list produced no listing (exit ${res?.status}): ${tail}`))
    }
    return JSON.parse(readFileSync(listFile, 'utf8')).map((t) => ({
      name: t.name,
      file: relative(cwd, t.file),
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The suite's own test and hook timeouts, read from its vitest config so a
 * re-run's time limit follows the config rather than a copy of it. Throws if
 * either cannot be found: a guessed limit could kill a healthy re-run.
 */
export function readSuiteTimeouts(path = 'vitest.config.ts') {
  const text = readFileSync(path, 'utf8')
  const read = (name) => {
    const m = text.match(new RegExp(`${name}:\\s*([\\d_]+)`))
    if (!m) throw new Error(`${path} sets no ${name}; cannot bound a confirmation re-run`)
    return Number(m[1].replace(/_/g, ''))
  }
  return { testTimeout: read('testTimeout'), hookTimeout: read('hookTimeout') }
}

/**
 * How long one re-run process may take: start-up, the file's beforeAll and
 * the teardown at the suite's hook timeout each, and every selected test at
 * the test timeout for each of its attempts, capped by `ceilingMs`.
 */
export function rerunTimeoutMs(testCount, { testTimeout, hookTimeout, retry = 0, ceilingMs = 20 * 60_000 }) {
  return wholeMs(Math.min(ceilingMs, 60_000 + 2 * hookTimeout + testCount * testTimeout * (retry + 1)))
}

/**
 * The real confirmation runner: one fresh suite process per attempt against
 * real AWS (so DYNAMODB_ENDPOINT is stripped), re-running every test it is
 * given from one file in one region, each classified from the process's own
 * results file and sidecar. Requires AWS credentials, except when tests point
 * it at a fixture config through `vitestArgs`.
 *
 * Before a test's first re-run, the runner asks vitest which tests the
 * group's pattern selects (listSelected) and accepts only an exact match:
 * every test it asked for, once each, in its own file, and nothing else. A
 * test selected nowhere is looked for in a listing of the whole file, to tell
 * a test that is gone from the checked-out commit apart from a selector that
 * cannot find one that is there. The check is cached per test, so a group
 * that shrinks between attempts is not listed again.
 *
 * A result is read back by the test's name parts and file, the identity the
 * listing checked, not by its space-joined name: a twin added since the
 * measured commit can share that name, and its skipped result must never be
 * read as the selected test's. Anything that leaves the selected test without
 * an observation of its own - no results file, a run-level fault in the
 * sidecar, the test absent from the results - is `not-run`. A test-level
 * indeterminate is an observation, and is returned as one.
 *
 * Every spawn is limited by its own time limit and by `remainingMs`, the
 * confirmation budget left when the call began; time spent listing comes off
 * the budget before the re-run is capped.
 *
 * `namesFor(test)` returns the test's name parts (testNamesFor, bound to the
 * sweep's results). `measuredRef` names the commit the sweep measured, for the
 * message on a test that is no longer there.
 */
export function makeVitestRunner({
  cwd = process.cwd(),
  namesFor,
  measuredRef = null,
  vitestArgs = [],
  spawn = spawnGroup,
  tmpRoot = tmpdir(),
  timeouts = null,
  listTimeoutMs = 60_000,
  ceilingMs = 20 * 60_000,
  now = Date.now,
} = {}) {
  if (typeof namesFor !== 'function') throw new Error('makeVitestRunner needs namesFor')
  const checked = new Map()
  return async function runTests(region, tests, { remainingMs = Infinity } = {}) {
    const deadline = now() + remainingMs
    const files = new Set(tests.map((t) => t.file))
    if (files.size !== 1) throw new Error(`runTests takes tests from one file, got ${files.size}`)
    const [file] = files
    const env = {
      ...process.env,
      AWS_REGION: region,
      CONFORMANCE_TARGET: `confirm-${region}`,
    }
    delete env.DYNAMODB_ENDPOINT
    const results = new Map()
    const list = (pattern) => {
      const { timeoutMs, binding } = spawnLimit(listTimeoutMs, deadline, now)
      return listSelected({ cwd, env, file, pattern, vitestArgs, spawn, tmpRoot, timeoutMs, binding, region })
    }

    const fresh = tests.filter((t) => !checked.has(testKey(t)))
    if (fresh.length > 0) {
      const wanted = []
      for (const test of fresh) {
        try {
          const names = checkNames(namesFor(test))
          wanted.push({ test, names, name: names.join(VITEST_NAME_SEPARATOR) })
        } catch (e) {
          results.set(testKey(test), { error: e.message, kind: 'selection' })
        }
      }
      if (wanted.length > 0) {
        const selected = await list(testNamesPattern(wanted.map((w) => w.names)))
        const unasked = selected.filter((s) => s.file !== file || !wanted.some((w) => w.name === s.name))
        if (unasked.length > 0) {
          throw confirmationError(
            'selection',
            `the re-run would also select ${unasked.length} test(s) nobody asked for: ` +
              unasked.slice(0, 3).map((s) => `${s.file}: ${s.name}`).join('; '),
          )
        }
        let whole = null
        for (const w of wanted) {
          const count = selected.filter((s) => s.name === w.name).length
          if (count === 1) {
            checked.set(testKey(w.test), w.names)
          } else if (count > 1) {
            results.set(testKey(w.test), {
              error: `the re-run would select ${count} tests named "${w.name}" in ${file}, not one`,
              kind: 'selection',
            })
          } else {
            whole ??= await list(null)
            results.set(
              testKey(w.test),
              whole.some((s) => s.file === file && s.name === w.name)
                ? {
                    error: `${file} has a test named "${w.name}", but the re-run's selector does not pick it out`,
                    kind: 'selection',
                  }
                : {
                    error:
                      `no test with this name in ${file} on the checked-out commit; it may have been ` +
                      `renamed or removed since ${measuredRef ?? 'the measured commit'}`,
                    kind: 'not-found',
                  },
            )
          }
        }
      }
    }

    const toRun = tests.filter((t) => checked.has(testKey(t)) && !results.has(testKey(t)))
    if (toRun.length === 0) return results

    const dir = mkdtempSync(join(tmpRoot, 'sweep-confirm-'))
    try {
      const slug = `confirm-${region}`
      const outputFile = join(dir, `${slug}.json`)
      const limits = timeouts ?? readSuiteTimeouts(join(cwd, 'vitest.config.ts'))
      const own = rerunTimeoutMs(toRun.length, {
        ...limits,
        retry: Number(env.CONFORMANCE_RETRY ?? 0),
        ceilingMs,
      })
      const { timeoutMs, binding } = spawnLimit(own, deadline, now)
      const res = await spawn(
        process.execPath,
        [
          vitestBin(cwd),
          'run',
          file,
          ...vitestArgs,
          `--testNamePattern=${testNamesPattern(toRun.map((t) => checked.get(testKey(t))))}`,
          '--reporter=json',
          `--outputFile=${outputFile}`,
        ],
        { cwd, env: { ...env, CONFORMANCE_RESULTS_DIR: dir }, timeout: timeoutMs },
      )
      const showOutput = () => printOutputTail(`re-run ${file} in ${region}`, res)
      if (timedOut(res)) {
        showOutput()
        throw ranOut(binding, 'the re-run process', timeoutMs)
      }
      const signal = killedBy(res)
      if (signal) {
        showOutput()
        throw confirmationError('runner', `the re-run process was ended by ${signal}`)
      }

      const notRun = (why) => {
        for (const t of toRun) results.set(testKey(t), { error: why, kind: 'not-run' })
        return results
      }
      if (!existsSync(outputFile)) {
        showOutput()
        return notRun(`the re-run wrote no results file (exit ${res?.status})`)
      }
      const doc = JSON.parse(readFileSync(outputFile, 'utf8'))
      const sidecarFile = join(dir, `${slug}.indeterminate.json`)
      const sidecar = existsSync(sidecarFile) ? JSON.parse(readFileSync(sidecarFile, 'utf8')) : null
      // classifyResults yields one verdict per assertion, in document order,
      // so each verdict lines up with the assertion it came from.
      const verdicts = classifyResults(doc, sidecar)
      const runLevel = verdicts.find((v) => v.reason?.at === 'run')
      if (runLevel) return notRun(`the re-run failed as a whole (${runLevel.reason.reason}), so no test was observed`)
      const assertions = (doc.testResults ?? []).flatMap((tr) =>
        (tr.assertionResults ?? []).map((ar) => ({ file: relative(cwd, tr.name), names: [...(ar.ancestorTitles ?? []), ar.title] })),
      )
      for (const t of toRun) {
        const wantedNames = JSON.stringify(checked.get(testKey(t)))
        const matches = assertions
          .map((a, i) => ({ ...a, i }))
          .filter((a) => a.file === t.file && JSON.stringify(a.names) === wantedNames)
        if (matches.length === 0) {
          results.set(testKey(t), { error: 'the selected test is absent from the re-run\'s results', kind: 'not-run' })
        } else if (matches.length > 1) {
          results.set(testKey(t), {
            error: `the re-run's results hold ${matches.length} tests with this name in ${t.file}; which one ran cannot be told`,
            kind: 'selection',
          })
        } else {
          results.set(testKey(t), { verdict: verdicts[matches[0].i].verdict })
        }
      }
      return results
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ── Issue bodies ─────────────────────────────────────────────────────────────

const HUMAN_GATE =
  'Nothing here is automatic: the sweep never writes `registry/splits.json`. ' +
  'A maintainer reviews the evidence and decides - see `registry/README.md` ' +
  'for what a row means and what admitting one commits the project to.'

function provenance({ date, runUrl }) {
  const run = runUrl ? ` ([sweep run](${runUrl}))` : ''
  return `Detected by the weekly ground-truth sweep on ${date}${run}.`
}

export function buildCandidateIssue(candidate, { date, runUrl, evidence = {} }) {
  const { test, regions, confirmation } = candidate
  const lines = [
    `## Split candidate: regions disagree on a behaviour`,
    '',
    provenance({ date, runUrl }),
    '',
    `- **Test:** \`${test.file}\``,
    `- **Name:** ${test.fullName}`,
    confirmation
      ? `- **Confirmation:** the divergent side (${confirmation.regions.join(', ')}) was re-run ${confirmation.runs}× each; every run reproduced the failure. Pass-side verdicts are single sweep observations.`
      : `- **Confirmation:** none - this candidate has NOT been re-confirmed and must not be admitted on this evidence alone.`,
    '',
    '| Region | Verdict against the committed assertion |',
    '| --- | --- |',
  ]
  for (const region of Object.keys(regions).sort()) {
    lines.push(`| ${region} | ${regions[region]} |`)
  }
  const withMessages = Object.keys(evidence)
    .sort()
    .filter((r) => (evidence[r]?.failureMessages ?? []).length > 0)
  if (withMessages.length > 0) {
    lines.push('', '### Evidence')
    for (const region of withMessages) {
      lines.push('', `**${region}**`, '', '```')
      lines.push(...evidence[region].failureMessages.map((m) => m.trim()))
      lines.push('```')
    }
  }
  lines.push('', '### Next step', '', HUMAN_GATE)
  return {
    title: `Split candidate: ${test.fullName}`,
    labels: ['split-candidate'],
    body: lines.join('\n'),
  }
}

// What each way of failing to re-run a candidate means, and what to do.
const ERROR_KINDS = {
  'not-found': {
    heading: 'The test is not on the checked-out commit',
    advice:
      'The sweep measures a release, but confirmation runs from main, and main no longer has a test under this name. ' +
      "Check main's history for the rename or removal. A renamed test can be re-run by hand under its new name in " +
      'the regions that failed it; a removed one needs nothing more than closing this.',
  },
  selection: {
    heading: 'The re-run could not pick out exactly this test',
    advice:
      "The re-run's selector matched no test, or more than one, although the test is there. Either two tests share " +
      'this name and need telling apart, or the selection in `scripts/sweep-detect.mjs` is broken and every ' +
      'candidate will land here until it is fixed. Re-run the test by hand in the regions that failed it meanwhile.',
  },
  'not-run': {
    heading: 'The test was selected but nothing was observed',
    advice:
      'The re-run started but produced no observation of the test: it reported the test as skipped, failed as a ' +
      'whole, left the test out of its results, or wrote no results at all. Against real DynamoDB that most often ' +
      'means the tables its file declares could not be provisioned in that region. Re-run it by hand there; if ' +
      'provisioning fails again, look at the region rather than the test.',
  },
  timeout: {
    heading: 'The re-run timed out',
    advice:
      'The re-run process ran past its time limit and was stopped. The end of its output is in the run log, ' +
      'folded under "re-run <file> in <region>", and shows where it stalled. Re-run the test by hand in the ' +
      'regions that failed it.',
  },
  budget: {
    heading: "The confirmation step's budget ran out first",
    advice:
      'Confirmation has a fixed wall-clock budget so that the job always finishes and files what it has. These ' +
      'candidates were not reached, or not finished, before it ran out. Nothing is wrong with them: re-run them by ' +
      'hand, or raise the budget if this keeps happening.',
  },
  runner: {
    heading: 'The re-run could not be started',
    advice:
      'The reason is in the table below; where vitest ran and failed, the end of its output is in the run log, ' +
      'folded under the file and region. Re-run the test by hand in the regions that failed it.',
  },
}
const KIND_ORDER = Object.keys(ERROR_KINDS)

// A kind this file does not know is reported as the generic one, never dropped.
export const errorKindOf = (c) => (Object.hasOwn(ERROR_KINDS, c.errorKind ?? '') ? c.errorKind : 'runner')

// GitHub refuses an issue or comment body over 65,536 characters.
const ISSUE_BODY_LIMIT = 65_536

// A workflow command is one line; anything after a newline would be lost.
const oneLine = (s) => String(s).replace(/\s*\n\s*/g, ' ')

/**
 * The run log's error annotations for candidates that could not be re-run:
 * one per kind, with a count and the first few names, so the at most ten a
 * step shows are always complete.
 */
export function confirmationAnnotations(errored) {
  return KIND_ORDER.flatMap((kind) => {
    const rows = errored.filter((c) => errorKindOf(c) === kind)
    if (rows.length === 0) return []
    const shown = rows.slice(0, 3).map((c) => c.test.fullName)
    const more = rows.length > shown.length ? `, and ${rows.length - shown.length} more` : ''
    return [
      `::error title=Sweep confirmation::${rows.length} candidate(s) could not be re-run - ` +
        `${ERROR_KINDS[kind].heading.toLowerCase()}: ${oneLine(shown.join('; '))}${more}. ` +
        'The confirmation-error issue lists them all.',
    ]
  })
}

/**
 * One issue for every candidate this sweep could not re-run. The title is
 * stable on purpose: fileIssue deduplicates on it, so a confirmation step that
 * stays broken comments on the same open issue each week rather than opening
 * a new one, and the issue stays open until a maintainer closes it.
 */
export function buildConfirmationErrorIssue(errored, { date, runUrl, limit = ISSUE_BODY_LIMIT }) {
  const cell = (s) => {
    const text = String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
    return text.length > 500 ? `${text.slice(0, 500)}...` : text
  }
  const kinds = KIND_ORDER.filter((k) => errored.some((c) => errorKindOf(c) === k))
  const build = (maxRows) => {
    const lines = [
      '## Sweep confirmation could not re-run every candidate',
      '',
      provenance({ date, runUrl }),
      '',
      `The targeted re-run that confirms a split candidate could not be made for ${errored.length} candidate(s). ` +
        'This says nothing about DynamoDB: these candidates were neither confirmed nor refuted, they stand ' +
        'exactly as the sweep observed them, and none may be admitted on this evidence. The sweep run itself ' +
        'still finishes green, so this issue and the error annotations in the run log are the only signal.',
    ]
    for (const kind of kinds) {
      const { heading, advice } = ERROR_KINDS[kind]
      const rows = errored.filter((c) => errorKindOf(c) === kind)
      lines.push('', `### ${heading}`, '', advice, '')
      lines.push('| Test | Name | Failed in | Why the re-run could not be made |', '| --- | --- | --- | --- |')
      for (const c of rows.slice(0, maxRows)) {
        const failedIn = Object.keys(c.regions ?? {})
          .filter((r) => c.regions[r] === 'fail')
          .sort()
          .join(', ')
        lines.push(`| \`${cell(c.test.file)}\` | ${cell(c.test.fullName)} | ${cell(failedIn)} | ${cell(c.error)} |`)
      }
      if (rows.length > maxRows) {
        lines.push('', `...and ${rows.length - maxRows} more, listed under \`errored\` in the sweep report artefact.`)
      }
    }
    lines.push(
      '',
      '### Next step',
      '',
      'Nothing here was admitted or discarded, and the sweep never writes `registry/splits.json`. Once each ' +
        'candidate above has been re-run by hand, or has stopped appearing in later sweeps, this issue can be closed.',
    )
    return lines.join('\n')
  }
  // Keep every row while it fits; otherwise cut each table back until it does.
  let maxRows = errored.length
  let body = build(maxRows)
  while (body.length > limit && maxRows > 0) {
    maxRows = Math.floor(maxRows / 2)
    body = build(maxRows)
  }
  return {
    title: 'Sweep confirmation could not re-run every candidate',
    labels: ['confirmation-error'],
    body: body.length > limit ? body.slice(0, limit) : body,
  }
}

export function buildDriftIssue(finding, { date, runUrl }) {
  const { row, kind, convergedOn, expected, actual } = finding
  const explanation =
    kind === 'converged'
      ? convergedOn === 'pinned'
        ? 'Every region named in the row now returns a definite answer matching the pinned one. The split may have healed; if so, the row should be retired.'
        : 'Every region named in the row now returns a definite answer, and none matches the pinned one: every region has left the pinned side, so the recorded split no longer exists. The row should be retired and the committed assertion re-pointed at what regions now return, not re-pinned.'
      : 'At least one region named in the row no longer answers the way the row records. The registry may be describing a divergence that has moved.'
  const lines = [
    `## Registry drift: \`${row.id}\``,
    '',
    provenance({ date, runUrl }),
    '',
    explanation,
    '',
    `- **Test:** \`${row.test.file}\``,
    `- **Name:** ${row.test.fullName}`,
    `- **Pinned region:** ${row.pinned}`,
    '',
    '| Region | Row implies | Sweep observed |',
    '| --- | --- | --- |',
  ]
  for (const region of Object.keys(expected).sort()) {
    lines.push(`| ${region} | ${expected[region]} | ${actual[region] ?? 'no definite answer'} |`)
  }
  lines.push('', '### Next step', '', HUMAN_GATE)
  return {
    title: `${driftTitlePrefix(row.id)}${kind})`,
    labels: ['registry-drift'],
    body: lines.join('\n'),
  }
}

// Every drift issue for a row starts with this, whichever kind it was filed
// as. The opening parenthesis keeps one row id from matching another it
// happens to prefix.
const driftTitlePrefix = (id) => `Registry drift: ${id} (`

export function buildMatchComment(match, { date, runUrl }) {
  return [
    `## Registry drift: \`${match.id}\` matches again`,
    '',
    provenance({ date, runUrl }),
    '',
    'Every region named in the row gave a definite answer, and each one matches what the row records, whether because the drift reverted or because the row has been re-recorded since. The row is accurate as it stands, so this issue can be closed once a maintainer has checked.',
    '',
    `- **Test:** \`${match.test.file}\``,
    `- **Name:** ${match.test.fullName}`,
    '',
    '### Next step',
    '',
    HUMAN_GATE,
  ].join('\n')
}

export function buildPageIssue(page, { date, runUrl }) {
  const reasons = (page.reasons ?? [])
    .map((r) => `- ${r.kind}: ${r.detail}`)
    .join('\n')
  const body = [
    `## Region dropped from the observed set: ${page.region}`,
    '',
    provenance({ date, runUrl }),
    '',
    `\`${page.region}\` has now been unresolved for two consecutive sweeps, so it has been dropped from the observed region set - scores no longer draw on its data. Dropping and paging happen in this same act, deliberately: holding the region in the set while waiting for a human would keep scoring on data nobody can vouch for.`,
    '',
    "This sweep's health verdict:",
    '',
    reasons || '- (no per-run detail: the region produced no results at all)',
    '',
    'The region rejoins the observed set automatically on its next resolved sweep. The follow-up here is operational: find out why the region cannot complete a sweep.',
  ].join('\n')
  return {
    title: `Region dropped from the observed set: ${page.region}`,
    labels: ['region-dropped'],
    body,
  }
}

// ── Filing (the only GitHub-touching path; opt-in via --file-issues) ─────────

function gh(args, opts = {}) {
  const res = spawnSync('gh', args, { encoding: 'utf8', ...opts })
  if (res.status !== 0) {
    throw new Error(`gh ${args[0]} failed: ${res.stderr || res.stdout}`)
  }
  return res.stdout
}

const LABELS = {
  'split-candidate': 'Sweep-confirmed regional split awaiting a human decision',
  'registry-drift': 'An admitted split no longer matches what regions return',
  'region-dropped': 'A region missed two consecutive sweeps and left the observed set',
  'confirmation-error': 'The sweep could not re-run a split candidate to confirm it',
}

/**
 * File one issue via the `gh` CLI, deduplicating on exact title: a candidate
 * confirmed again next week comments on its open issue rather than opening a
 * second one.
 */
export function fileIssue(issue, { exec = gh } = {}) {
  const label = issue.labels[0]
  try {
    exec(['label', 'create', label, '--description', LABELS[label] ?? '', '--color', 'D93F0B'])
  } catch {
    // The label already existing is the steady state.
  }
  const existing = listOpenIssues(label, { exec }).find((i) => i.title === issue.title)
  if (existing) {
    exec(['issue', 'comment', String(existing.number), '--body', issue.body])
    return { action: 'commented', number: existing.number }
  }
  exec([
    'issue',
    'create',
    '--title',
    issue.title,
    '--label',
    issue.labels.join(','),
    '--body',
    issue.body,
  ])
  return { action: 'created' }
}

function listOpenIssues(label, { exec = gh } = {}) {
  return JSON.parse(
    exec(['issue', 'list', '--label', label, '--state', 'open', '--json', 'number,title']),
  )
}

/**
 * Comment on every open drift issue for a row that matches again. Never
 * creates one: a row behaving as recorded is the steady state, and an issue
 * per row per week would bury the ones that need a decision. Closing is left
 * to a maintainer, as with every other issue the sweep raises. Most rows match
 * most weeks, so a caller handling several passes `open` in, listed once.
 */
export function commentOnOpenDriftIssue(match, body, { exec = gh, open = listOpenIssues('registry-drift', { exec }) } = {}) {
  const numbers = open
    .filter((i) => i.title.startsWith(driftTitlePrefix(match.id)))
    .map((i) => i.number)
  for (const number of numbers) {
    exec(['issue', 'comment', String(number), '--body', body])
  }
  return { action: numbers.length ? 'commented' : 'none', numbers }
}

/**
 * Note every matching row on its open drift issue, best-effort. These comments
 * are a courtesy to whoever reads the issue, so a gh failure is logged and the
 * sweep carries on: it must not cost the week's report or the confirmation of
 * a real split candidate, both of which come after this in run().
 */
export function noteMatchesAgain(matching, { date, runUrl, exec = gh } = {}) {
  const outcome = { noted: [], failed: [] }
  if (matching.length === 0) return outcome
  let open
  try {
    open = listOpenIssues('registry-drift', { exec })
  } catch (e) {
    outcome.failed.push(...matching.map((m) => ({ id: m.id, error: e.message })))
    return outcome
  }
  for (const match of matching) {
    try {
      const body = buildMatchComment(match, { date, runUrl })
      const { numbers } = commentOnOpenDriftIssue(match, body, { exec, open })
      if (numbers.length) outcome.noted.push({ id: match.id, numbers })
    } catch (e) {
      outcome.failed.push({ id: match.id, error: e.message })
    }
  }
  return outcome
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    dir: null,
    expect: null,
    registry: SPLIT_REGISTRY,
    recordHealth: null,
    date: new Date().toISOString().slice(0, 10),
    confirm: false,
    confirmRuns: 5,
    // Inside the detect job's 115 minutes: the rest of the job takes about
    // 10, so 75 leaves 30 to spare (see the detect step in sweep.yml).
    confirmBudgetMinutes: Number(process.env.SWEEP_CONFIRM_BUDGET_MINUTES || 75),
    measuredRef: null,
    out: null,
    fileIssues: false,
    runUrl: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--expect') {
      args.expect = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
      // An empty expectation would make every region silently out of scope,
      // and nothing here may produce silence.
      if (args.expect.length === 0) throw new Error('--expect needs at least one region')
    }
    else if (a === '--registry') args.registry = argv[++i]
    else if (a === '--record-health') args.recordHealth = argv[++i]
    else if (a === '--date') args.date = argv[++i]
    else if (a === '--confirm') args.confirm = true
    else if (a === '--confirm-runs') args.confirmRuns = Number(argv[++i])
    else if (a === '--confirm-budget-minutes') args.confirmBudgetMinutes = Number(argv[++i])
    else if (a === '--measured-ref') args.measuredRef = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--file-issues') args.fileIssues = true
    else if (a === '--run-url') args.runUrl = argv[++i]
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (args.dir === null) args.dir = a
    else throw new Error(`unexpected argument ${a}`)
  }
  if (!args.dir) throw new Error('usage: sweep-detect.mjs <ground-truth-dir> [options]')
  if (!(args.confirmBudgetMinutes > 0)) {
    throw new Error('the confirmation budget must be a positive number of minutes')
  }
  if (!Number.isInteger(args.confirmRuns) || args.confirmRuns < 1) {
    throw new Error('usage: --confirm-runs takes a whole number of re-runs, at least 1')
  }

  // Belt and braces on the integrity guarantee: no output path this script
  // accepts may ever be the split registry.
  for (const path of [args.out, args.recordHealth]) {
    // Both the file that was read and the real registry in the repo. The sweep
    // now reads splits.json at the measured ref, out of a temp file, so
    // comparing against args.registry alone would leave the guard protecting a
    // scratch copy while the file the header promises never to write went
    // unchecked.
    if (path && [args.registry, SPLIT_REGISTRY].some((p) => resolve(path) === resolve(p))) {
      throw new Error(`refusing to write the split registry: only a human edits ${path}`)
    }
  }
  return args
}

/**
 * The whole pipeline for one sweep, exported so the write ordering is
 * testable with an injected runner. `runTests` overrides the confirmation
 * runner; omitted, --confirm builds the real one (makeVitestRunner), whose
 * spawns `spawn` overrides. `exec` stands in for `gh`, and `now` for the clock.
 */
export async function run(args, { runTests, spawn, now, exec } = {}) {
  const registry = loadRegistry(args.registry)
  const rowFor = (v) => splitFor(registry, v)
  const docs = readSweepDir(args.dir)
  const regions = args.expect ?? Object.keys(docs).sort()

  // Health-gate every expected region. A region with no results file at all is
  // unresolved, never silently absent: nothing may produce silence.
  const health = {}
  const verdictsByRegion = {}
  for (const region of regions) {
    if (!docs[region]) {
      health[region] = {
        resolved: false,
        reasons: [{ kind: 'missing-results', detail: 'the sweep produced no results file for this region' }],
        counts: null,
        failures: [],
      }
      continue
    }
    const verdicts = classifyResults(docs[region].results, docs[region].sidecar)
    // A failure on a test with an admitted registry row is a recorded
    // regional difference, not sickness - it must not spend the region's
    // sick-failure budget (see assessRegion). rowFor is the one definition of
    // explained-ness, shared by the gate and the report.
    const assessed = assessRegion(verdicts, { isExplained: (v) => Boolean(rowFor(v)) })
    health[region] = {
      ...assessed,
      failures: reportFailures(verdicts, rowFor),
    }
    if (assessed.resolved) verdictsByRegion[region] = verdicts
  }

  const candidates = detectSplitCandidates(verdictsByRegion, registry)
  const drift = detectRegistryDrift(verdictsByRegion, registry)
  const matching = detectMatchingRows(verdictsByRegion, registry)

  // Record each region's outcome; a region dropped by this sweep pages in the
  // same act (see scripts/lib/observed.mjs for why the two must not be split).
  const pages = []
  if (args.recordHealth) {
    let healthDoc = existsSync(args.recordHealth)
      ? loadRegionHealth(args.recordHealth)
      : validateRegionHealth({ regions: {} })
    for (const region of regions) {
      const outcome = recordSweep(healthDoc, {
        region,
        resolved: health[region].resolved,
        date: args.date,
      })
      healthDoc = outcome.doc
      if (outcome.page) pages.push({ region, reasons: health[region].reasons })
    }
    writeFileSync(args.recordHealth, JSON.stringify(healthDoc, null, 2) + '\n')
  }

  const emitIssues = (issues) => {
    for (const issue of issues) {
      if (args.fileIssues) {
        const outcome = fileIssue(issue, exec ? { exec } : {})
        console.log(`${outcome.action}: ${issue.title}`)
      } else {
        console.log(`\n--- would file: ${issue.title} [${issue.labels.join(', ')}] ---\n`)
        console.log(issue.body)
      }
    }
  }

  // Pages and drift file NOW, before the confirmation tail: the drop was
  // just recorded, and the drop and the page are one act (see
  // scripts/lib/observed.mjs) - a crash or timeout during the long
  // confirmation loop must never leave a recorded drop unpaged. Neither
  // depends on confirmation; only candidate issues wait for it.
  emitIssues([
    ...drift.map((f) => buildDriftIssue(f, { date: args.date, runUrl: args.runUrl })),
    ...pages.map((p) => buildPageIssue(p, { date: args.date, runUrl: args.runUrl })),
  ])

  // A row that matches again closes the loop on any drift issue still open
  // for it, in the same pass that files new drift, so the two cannot disagree
  // about the same sweep.
  if (args.fileIssues) {
    const { noted, failed } = noteMatchesAgain(matching, {
      date: args.date,
      runUrl: args.runUrl,
      ...(exec ? { exec } : {}),
    })
    for (const { id, numbers } of noted) console.log(`noted as matching again on #${numbers.join(', #')}: ${id}`)
    for (const { id, error } of failed) console.log(`::warning::could not note ${id} as matching again: ${error}`)
  } else {
    for (const match of matching) {
      console.log(`would comment "matches again" on an open drift issue for ${match.id}, if there is one`)
    }
  }

  const writeReport = (confirmationState, confirmed = [], discarded = [], errored = []) => {
    if (!args.out) return
    mkdirSync(dirname(args.out), { recursive: true })
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          date: args.date,
          confirmationState,
          regions: health,
          candidates,
          confirmed,
          discarded,
          errored,
          drift,
          matching,
          pages,
        },
        null,
        2,
      ) + '\n',
    )
  }

  // Health, pages and an initial report all land BEFORE confirmation: the
  // confirmation loop is the long tail of a wide sweep, and the job timeout
  // killing the process mid-loop must cost only the not-yet-confirmed
  // candidates - never the sweep's health record or its report artefact.
  // Confirmation then checkpoints the report after every re-run process, so
  // the candidates already decided survive too.
  writeReport(args.confirm ? 'pending' : 'not-requested')

  let confirmed = []
  let discarded = []
  let errored = []
  let attempts = 0
  if (args.confirm) {
    ;({ confirmed, discarded, errored, attempts } = await confirmCandidates(candidates, {
      runs: args.confirmRuns,
      budgetMs: args.confirmBudgetMinutes * 60_000,
      ...(now ? { now } : {}),
      runTests:
        runTests ??
        makeVitestRunner({
          namesFor: (test) => testNamesFor(docs, test),
          measuredRef: args.measuredRef,
          ...(spawn ? { spawn } : {}),
          ...(now ? { now } : {}),
        }),
      onProgress: (progress) =>
        writeReport('pending', progress.confirmed, progress.discarded, progress.errored),
    }))
    writeReport('complete', confirmed, discarded, errored)
  }

  const unresolved = regions.filter((r) => !health[r].resolved)
  console.log(
    `${regions.length} region(s): ${regions.length - unresolved.length} resolved` +
      (unresolved.length ? `, unresolved: ${unresolved.join(', ')}` : ''),
  )
  console.log(
    `${candidates.length} split candidate(s)` +
      (args.confirm
        ? ` (${confirmed.length} confirmed, ${discarded.length} discarded, ${errored.length} could not be re-run; ${attempts} re-run attempt(s))`
        : ' (unconfirmed)') +
      `, ${drift.length} drift finding(s), ${pages.length} region(s) paged`,
  )
  // One annotation per kind, not per candidate: GitHub shows at most ten
  // error annotations per step, and a list cut at ten would read as complete.
  // The issue carries every candidate.
  for (const line of confirmationAnnotations(errored)) console.log(line)

  emitIssues(
    (args.confirm ? confirmed : []).map((c) =>
      buildCandidateIssue(c, {
        date: args.date,
        runUrl: args.runUrl,
        evidence: evidenceFor(docs, c.test),
      }),
    ),
  )
  // Filing this one must not cost the run: the report is already written, and
  // a gh failure here is reported, not thrown.
  if (errored.length > 0) {
    try {
      emitIssues([buildConfirmationErrorIssue(errored, { date: args.date, runUrl: args.runUrl })])
    } catch (e) {
      console.log(`::error title=Sweep confirmation::could not file the confirmation-error issue: ${oneLine(e.message)}`)
    }
  }

  // A candidate that could not be re-run does not change the exit status. The
  // sweep gates nothing, and its run is attributed to main's head, where a
  // red check would hold up the release. The issue and the annotations above
  // are the signal.
  return { errored: errored.length, attempts }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
