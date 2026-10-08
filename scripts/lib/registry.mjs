// Loader, validator and query interface for the split registry
// (registry/splits.json). See registry/README.md for what a row means and why
// the file is only ever written by hand.
//
// The validator is deliberately loud. The registry is the single source of
// per-region expectations, so a malformed row must fail the tooling tests
// rather than quietly widening or narrowing what the suite accepts.
//
// Pure logic plus a thin fs loader, so everything here unit-tests with no AWS
// and no network.

import { readFileSync } from 'node:fs'

// Syntactic shape of an AWS region name (e.g. eu-west-2, ap-southeast-3).
const REGION_NAME = /^[a-z]{2,3}(-[a-z]+)+-\d+$/

/** Whether a string is syntactically an AWS region name. */
export function isRegionName(name) {
  return typeof name === 'string' && REGION_NAME.test(name)
}

// Key-order-insensitive serialisation, so two observations count as "the
// same answer" regardless of attribute order (same posture as drift.mjs).
function stableKey(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableKey).join(',') + ']'
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableKey(v[k]))
      .join(',') +
    '}'
  )
}

/** True when two recorded observations are the same answer. */
export function sameObservation(a, b) {
  return stableKey(a ?? null) === stableKey(b ?? null)
}

/**
 * The shape of one recorded answer, shared by a registry row's per-region
 * observations and the observed marker a split test stamps
 * (src/observation-sink.ts). Defined once, next to sameObservation, because
 * both sides of that comparison must hold the same shape: a malformed answer
 * on either side can never match anything, which silently turns region
 * matches into misses.
 */
export function isWellFormedObservation(observation) {
  if (observation?.outcome === 'rejected') {
    return (
      typeof observation.error?.name === 'string' &&
      typeof observation.error?.message === 'string'
    )
  }
  return observation?.outcome === 'accepted' && typeof observation.detail === 'string'
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

function fail(id, problem) {
  throw new Error(`invalid split registry row ${id ?? '(missing id)'}: ${problem}`)
}

/**
 * Validate a registry document. Returns the document when valid, throws
 * otherwise. When `knownRegions` is provided, every region named in a row
 * must be a member; without it, names are checked syntactically only.
 *
 * Staleness is deliberately not validated here: a stale `lastRefreshed` is
 * the trust module's business, and a stale row must remain readable.
 */
export function validateRegistry(doc, { knownRegions } = {}) {
  if (!Array.isArray(doc?.splits)) {
    throw new Error('invalid split registry: expected { splits: [...] }')
  }

  const seenIds = new Set()
  const seenTests = new Set()
  for (const row of doc.splits) {
    const id = typeof row?.id === 'string' && row.id !== '' ? row.id : null
    if (!id) fail(id, 'missing id')
    if (seenIds.has(id)) fail(id, 'duplicate id')
    seenIds.add(id)

    if (typeof row.test?.file !== 'string' || row.test.file === '') {
      fail(id, 'missing test.file')
    }
    if (typeof row.test?.fullName !== 'string' || row.test.fullName === '') {
      fail(id, 'missing test.fullName')
    }
    const testKey = `${row.test.file}\0${row.test.fullName}`
    if (seenTests.has(testKey)) fail(id, 'duplicate row for the same test')
    seenTests.add(testKey)

    for (const field of ['firstObserved', 'lastRefreshed']) {
      if (!DATE_SHAPE.test(row[field] ?? '')) fail(id, `missing or malformed ${field}`)
    }

    const regions = Object.keys(row.regions ?? {})
    if (regions.length < 2) {
      fail(id, 'a split needs at least two regions with definite answers')
    }
    for (const region of regions) {
      if (!REGION_NAME.test(region)) fail(id, `malformed region name "${region}"`)
      if (knownRegions && !knownRegions.includes(region)) {
        fail(id, `unknown region "${region}"`)
      }
      if (!isWellFormedObservation(row.regions[region])) {
        fail(id, `region ${region} carries a malformed observation`)
      }
    }

    // At least two of the named regions must actually disagree, or the row
    // is not a split.
    const distinct = new Set(regions.map((r) => stableKey(row.regions[r])))
    if (distinct.size < 2) {
      fail(id, 'every named region returns the same answer; that is not a split')
    }

    // The committed test asserts one side of the split, and per-region scoring
    // needs to know which: a target that passes the committed assertion has
    // matched the answer recorded for the pinned region, and nothing else is
    // known about it. The field names a region in the row whose recorded
    // answer the committed assertion encodes.
    if (!regions.includes(row.pinned)) {
      fail(id, 'pinned must name a region recorded in the row')
    }
  }
  return doc
}

/** Read, parse and validate the registry from disk. */
export function loadRegistry(path = 'registry/splits.json', opts = {}) {
  return validateRegistry(JSON.parse(readFileSync(path, 'utf8')), opts)
}

// Rows record repo-relative test paths, but Vitest's JSON output records the
// absolute path of the runner that produced it, so a row matches a result on
// path suffix at a path-segment boundary.
function sameTestFile(rowFile, file) {
  return file === rowFile || file.endsWith(`/${rowFile}`)
}

/** The registry row for a test, or null when the test is region-invariant. */
export function splitFor(doc, { file, fullName }) {
  return (
    doc.splits.find(
      (row) => sameTestFile(row.test.file, file) && row.test.fullName === fullName,
    ) ?? null
  )
}

/**
 * The answer a region is recorded as giving for a test, or null when the test
 * has no row (region-invariant: the suite's pinned expectation applies) or
 * the row does not name this region.
 */
export function expectedFor(doc, { file, fullName }, region) {
  const row = splitFor(doc, { file, fullName })
  return row?.regions?.[region] ?? null
}

/**
 * The verdict a row's test earned, read as "gave the pinned answer" or not.
 *
 * Scoring and the sweep both read a pass that way, which holds while the
 * committed assertion accepts the pinned answer and no other recorded one.
 * Where the pinned region itself gives more than one answer, the assertion
 * has to accept each of them, and a pass then says only that the target gave
 * one of them. The recorded observation says which: a pass whose observation
 * is one of the row's recorded answers counts as a pass only when that answer
 * is the pinned one. Any other verdict, and a pass whose observation matches
 * nothing recorded (a wording variant a tolerant assertion let through),
 * stands as it is.
 */
export function verdictAgainstPin(row, verdict, observed) {
  if (verdict !== 'pass' || observed === undefined) return verdict
  const recorded = Object.values(row.regions)
  if (!recorded.some((answer) => sameObservation(answer, observed))) return verdict
  return sameObservation(observed, row.regions[row.pinned]) ? 'pass' : 'fail'
}
