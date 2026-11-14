#!/usr/bin/env node

/**
 * Enumerate the suite's own tests and write registry/suite-manifest.json.
 *
 * The suite size, and the population the ground-truth derivation compares
 * against, used to be taken from the widest emulator run: the largest number of
 * tests any target executed. That is second-hand. Divergence and coverage are
 * both "over the whole suite", which is the sentence the two-figure model rests
 * on, and the denominator was supplied by one of the things being measured.
 * Today they agree because at least one target runs everything. Nothing
 * enforces that, and if it stopped being true the board would quietly start
 * grading against a smaller suite than it has.
 *
 * Identity is `<repo-relative file>::<fullName>`, the key
 * scripts/ground-truth-coverage.mjs already reconciles on, because fullName is
 * unique only within a file.
 *
 * ## Why this runs the tests rather than listing them
 *
 * `vitest list --json` collects without executing, which is what we want, but
 * it reports one flat string per test with ` > ` between the describe levels.
 * The JSON reporter builds fullName by joining the same levels with a space, so
 * reconstructing one from the other means splitting on ` > ` - and six of this
 * suite's titles contain that sequence themselves ("supports > comparison on
 * binary sort key"), which the split silently corrupts. The structured form
 * lives behind Vitest's internal prepareVitest, not its public API.
 *
 * So this does a collection-only run instead, against an endpoint nothing is
 * listening on: every test is collected and reported with its exact
 * ancestorTitles and title, and none of them can reach a database. The tests
 * fail or skip and that is fine - only their identities are read. It costs a
 * few seconds and depends on nothing but the reporter's published shape.
 *
 * The run is hermetic with respect to results/. A suite run writes two things
 * there: the reporter's JSON, and the run-level sidecar
 * (<slug>.indeterminate.json, src/indeterminate-sink.ts), which globalSetup
 * clears before the run and the dead endpoint then guarantees is rewritten as a
 * transport failure. The reporter is pointed at a temporary file, and the
 * sidecar follows CONFORMANCE_TARGET and CONFORMANCE_RESULTS_DIR, so the child
 * gets neither from the caller: its results directory is the run's own
 * temporary one. Left to inherit them, an exported CONFORMANCE_TARGET would
 * mark that target not scored, and even with nothing set a real local run's
 * sidecar would be replaced by this one's. Every AWS_* and DYNAMODB_* variable
 * is dropped too and replaced with the dead endpoint and dummy credentials, so
 * no caller environment can point the run at a real database, and the results
 * cache is off so an all-failing collection run does not reorder the next real
 * one.
 *
 * Usage:
 *   node scripts/suite-manifest.mjs            # enumerate and write
 *   node scripts/suite-manifest.mjs --check    # verify the committed manifest
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testIdentities } from './lib/identity.mjs'

export const MANIFEST_PATH = 'registry/suite-manifest.json'

// Port 1 is reserved and nothing binds it, so every request fails fast rather
// than hanging on a DNS or connect timeout.
const DEAD_ENDPOINT = 'http://127.0.0.1:1'

/**
 * The child environment for the enumeration run: the caller's, less anything
 * that names a target, a results directory or a database, plus the dead
 * endpoint and dummy credentials. Exported so the rule can be tested without a
 * run.
 */
export function enumerationEnv(scratchDir, env = process.env) {
  const kept = Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^(CONFORMANCE_|AWS_|DYNAMODB_)/.test(name)),
  )
  return {
    ...kept,
    DYNAMODB_ENDPOINT: DEAD_ENDPOINT,
    CONFORMANCE_RESULTS_DIR: scratchDir,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'fakeAccessKeyId',
    AWS_SECRET_ACCESS_KEY: 'fakeSecretAccessKey',
  }
}

/**
 * The vitest arguments for the enumeration run. `--no-cache` keeps an
 * all-failing collection run out of the results cache the next real run
 * orders its files by.
 */
export function enumerationArgs(outputFile) {
  return ['vitest', 'run', '--reporter=json', `--outputFile=${outputFile}`, '--silent', '--no-cache']
}

/** Collect every test the suite defines, as sorted `file::fullName` identities. */
export function enumerateSuite() {
  const scratch = mkdtempSync(join(tmpdir(), 'suite-manifest-'))
  const out = join(scratch, 'collected.json')
  try {
    try {
      execFileSync(
        'npx',
        enumerationArgs(out),
        { env: enumerationEnv(scratch), stdio: ['ignore', 'ignore', 'ignore'] },
      )
    } catch {
      // A collection run is expected to exit non-zero: nothing answers. The
      // document is still written, and an unreadable one is caught below.
    }
    const doc = JSON.parse(readFileSync(out, 'utf8'))
    const ids = [...testIdentities(doc)].sort()
    if (ids.length === 0) throw new Error('collected no tests; the run produced nothing to enumerate')
    return ids
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** The committed manifest. */
export function readManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The suite's own test count, first-hand. */
export function suiteSizeOf(manifest = readManifest()) {
  return manifest.tests.length
}

/** The suite's own test identities, as a Set. */
export function suiteIdentities(manifest = readManifest()) {
  return new Set(manifest.tests)
}

/**
 * What `--check` prints when the manifest and the suite disagree. A rename
 * removes one identity and adds another, so the totals alone can match while
 * dozens of tests have moved: the counts of each side say how many, and only
 * the first few of each are listed.
 */
export function staleReport(defined, recorded, shown = 5) {
  const missing = defined.filter((id) => !recorded.includes(id))
  const extra = recorded.filter((id) => !defined.includes(id))
  if (missing.length === 0 && extra.length === 0) return null
  const lines = [
    `registry/suite-manifest.json is stale: ${defined.length} tests defined, ${recorded.length} recorded; ` +
      `${missing.length} defined but not recorded, ${extra.length} recorded but not defined.`,
  ]
  for (const [ids, label] of [[missing, 'defined but not recorded'], [extra, 'recorded but not defined']]) {
    for (const id of ids.slice(0, shown)) lines.push(`  ${label}: ${id}`)
    if (ids.length > shown) lines.push(`  ...and ${ids.length - shown} more ${label}`)
  }
  return lines
}

function main(argv) {
  const check = argv.includes('--check')
  const ids = enumerateSuite()

  if (check) {
    const report = staleReport(ids, readManifest().tests)
    if (!report) {
      console.log(`registry/suite-manifest.json matches the suite: ${ids.length} tests.`)
      return
    }
    for (const line of report) console.error(line)
    console.error('\nRun: node scripts/suite-manifest.mjs')
    process.exit(1)
  }

  const commit = (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  })()

  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), commit, count: ids.length, tests: ids }, null, 2)}\n`,
  )
  console.error(`wrote ${ids.length} test identities to ${MANIFEST_PATH}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
