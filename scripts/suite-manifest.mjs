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
 * The run names no CONFORMANCE_TARGET, so its output goes to the gitignored
 * scratch slug and nothing published is touched.
 *
 * Usage:
 *   node scripts/suite-manifest.mjs            # enumerate and write
 *   node scripts/suite-manifest.mjs --check    # verify the committed manifest
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testIdentities } from './lib/identity.mjs'

export const MANIFEST_PATH = 'registry/suite-manifest.json'

// Port 1 is reserved and nothing binds it, so every request fails fast rather
// than hanging on a DNS or connect timeout.
const DEAD_ENDPOINT = 'http://127.0.0.1:1'

/** Collect every test the suite defines, as sorted `file::fullName` identities. */
export function enumerateSuite() {
  const out = join(mkdtempSync(join(tmpdir(), 'suite-manifest-')), 'collected.json')
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, '--silent'],
      { env: { ...process.env, DYNAMODB_ENDPOINT: DEAD_ENDPOINT }, stdio: ['ignore', 'ignore', 'ignore'] },
    )
  } catch {
    // A collection run is expected to exit non-zero: nothing answers. The
    // document is still written, and an unreadable one is caught below.
  }
  const doc = JSON.parse(readFileSync(out, 'utf8'))
  const ids = [...testIdentities(doc)].sort()
  if (ids.length === 0) throw new Error('collected no tests; the run produced nothing to enumerate')
  return ids
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
