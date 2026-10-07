// Carries indeterminacy out of the process and into the results artefacts.
//
// Two channels, because there are two blast radii:
//
// - Test level: an afterEach hook (src/setup.ts) stamps `task.meta.indeterminate`
//   on a test whose failure was a failed observation rather than a real answer.
//   Vitest's built-in JSON reporter serialises task.meta verbatim into
//   `assertionResults[].meta`, so the marker lands in `results/<slug>.json`
//   without changing the published file's shape at all.
//
// - Run level: the shared tables are provisioned once per run in a global
//   beforeAll, and Vitest does not retry beforeAll. If provisioning fails with
//   an indeterminate error, no test ever executes, so no test can annotate
//   itself - without this channel one slow region would present as several
//   hundred simultaneous behavioural disagreements. The sink records the
//   failure and writes a sidecar, `<results dir>/<slug>.indeterminate.json`,
//   next to the results file it qualifies. The sidecar is a new file, never a
//   modification to `results/<slug>.json`.
//
// The sidecar is written from the worker process as soon as the failure is
// recorded: provisioning happens in a test worker while global teardown runs
// in the main Vitest process, so in-memory state cannot cross that boundary.
// The stale sidecar from a previous run is cleared by the globalSetup phase
// (src/global-teardown.ts) before any worker starts, which is what makes "no
// sidecar file" mean "nothing was absent" for the run that just finished.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { indeterminateFrom, type IndeterminateReason } from './indeterminate.js'

// Typed shape for the test-level marker, merged into Vitest's TaskMeta so the
// annotation is not an untyped bag. Vitest 5 bundles the runner into the
// vitest package, so 'vitest' is the module to augment.
declare module 'vitest' {
  interface TaskMeta {
    indeterminate?: { reason: IndeterminateReason; at: 'test' }
  }
}

export interface RunLevelIndeterminate {
  reason: IndeterminateReason
  phase: 'provisioning'
  message: string
}

/**
 * The slug the run's results file is named for, mirroring vitest.config.ts so
 * the sidecar always pairs up with the results file it qualifies.
 */
export function resultSlug(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONFORMANCE_TARGET ?? (env.DYNAMODB_ENDPOINT ? 'local' : 'dynamodb')
}

/**
 * The directory the run's results are written to. Overridable so runs whose
 * output is routed elsewhere (a per-region ground-truth capture, an ad-hoc
 * local run) keep the sidecar next to their results file.
 */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONFORMANCE_RESULTS_DIR ?? 'results'
}

/** The sidecar path for a slug: `<dir>/<slug>.indeterminate.json`. */
export function sidecarPath(slug: string, dir: string): string {
  return join(dir, `${slug}.indeterminate.json`)
}

const recorded: RunLevelIndeterminate[] = []

/**
 * Record a run-level indeterminate failure and write the sidecar immediately.
 * Recording the same reason and phase twice (the guarded beforeAll retries
 * provisioning once per test file) keeps a single entry.
 */
export function recordRunLevel(
  entry: RunLevelIndeterminate,
  opts: { slug?: string; dir?: string } = {},
): void {
  const duplicate = recorded.some(
    (r) => r.reason === entry.reason && r.phase === entry.phase,
  )
  if (!duplicate) recorded.push(entry)

  const slug = opts.slug ?? resultSlug()
  const path = sidecarPath(slug, opts.dir ?? resultsDir())
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ target: slug, runLevel: recorded }, null, 2) + '\n',
  )
}

/** Entries recorded so far in this process. */
export function recordedRunLevel(): readonly RunLevelIndeterminate[] {
  return recorded
}

// ── Abandoning an unreachable target ────────────────────────────────────────
//
// The shared tables are provisioned in a beforeAll that vitest runs once per
// test file, and a rejected attempt is dropped from the memo in src/helpers.ts
// so the next file tries again. That retry earns its place: a transient fault
// during one file's provisioning must not take out the hundred files behind
// it.
//
// A target whose endpoint never answers is the other case, and the same retry
// turns it into one failed attempt per test file, each paying the SDK's full
// retry budget before it gives up. The weekly sweep runs inside a two-hour
// credential window, so a region that has gone dark spends the entire window
// re-answering a question already settled by its first failure - and settled in
// the artefact too, because that failure wrote the sidecar.
//
// So the retry is kept and bounded. Consecutive failures, reset by any
// provisioning that succeeds, so a blip costs one attempt and a dark target
// costs this many.
export const ABANDON_PROVISIONING_AFTER = 3

let consecutiveProvisioningFailures = 0

/** Note that provisioning succeeded, clearing any run of failures before it. */
export function noteProvisioningSucceeded(): void {
  consecutiveProvisioningFailures = 0
}

/** Note that provisioning failed on a failed observation. Determinate
 * failures are not counted: a target answering definitely is reachable, and
 * whatever it is refusing is a real result for every file that asks. */
export function noteProvisioningFailed(): void {
  consecutiveProvisioningFailures += 1
}

/** True once provisioning has failed enough files running to call the target
 * unreachable for this run. */
export function provisioningAbandoned(): boolean {
  return consecutiveProvisioningFailures >= ABANDON_PROVISIONING_AFTER
}

/** Remove a previous run's sidecar. A clean run must leave no sidecar behind. */
export function clearStaleSidecar(opts: { slug?: string; dir?: string } = {}): void {
  rmSync(sidecarPath(opts.slug ?? resultSlug(), opts.dir ?? resultsDir()), {
    force: true,
  })
}

/** Test hook: reset the in-memory sink between unit tests. */
export function resetSinkForTesting(): void {
  recorded.length = 0
  consecutiveProvisioningFailures = 0
}

// ── Test-level marker hooks ─────────────────────────────────────────────────
// The bodies of the beforeEach/afterEach hooks installed by src/setup.ts,
// extracted so the attempt/retry semantics can be unit-tested without a
// running Vitest suite around them.

interface TaskLike {
  meta: { indeterminate?: { reason: IndeterminateReason; at: 'test' } }
  result?: { state?: string; errors?: unknown[] }
}

/**
 * Clear the marker at the start of every attempt. CONFORMANCE_RETRY is set on
 * the real-AWS job and task.meta lives on the task, not the attempt, so a
 * marker stamped on a failing first attempt would otherwise survive into a
 * passing retry - silently demoting a healthy test out of the denominator,
 * with nothing ever going red to say so.
 */
export function clearIndeterminateMarker(task: Pick<TaskLike, 'meta'>): void {
  delete task.meta.indeterminate
}

/**
 * Stamp the marker after an attempt whose failure was a failed observation.
 * Only the current attempt's error counts: the runner accumulates errors
 * across retries, so the last entry is this attempt's, and a retry that
 * failed for a real reason must not inherit an earlier attempt's
 * indeterminacy. A passing attempt is never stamped.
 */
export function stampIndeterminateMarker(task: TaskLike): void {
  if (task.result?.state !== 'fail') return
  const errors = task.result.errors ?? []
  const current = errors[errors.length - 1]
  const classified = indeterminateFrom(current)
  if (classified) {
    task.meta.indeterminate = { reason: classified.reason, at: 'test' }
  }
}
