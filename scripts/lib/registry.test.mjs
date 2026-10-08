import { describe, expect, it } from 'vitest'
import {
  expectedFor,
  loadRegistry,
  sameObservation,
  splitFor,
  validateRegistry,
  verdictAgainstPin,
} from './registry.mjs'

const accepted = { outcome: 'accepted', detail: 'stored' }
const rejected = {
  outcome: 'rejected',
  error: { name: 'ValidationException', message: 'must have the value of true' },
}

function row(overrides = {}) {
  return {
    id: 'example-split',
    test: { file: 'tests/tier3/x.test.ts', fullName: 'suite behaves' },
    behaviour: 'an example behaviour',
    pinned: 'eu-west-2',
    firstObserved: '2026-06-09',
    lastRefreshed: '2026-07-06',
    regions: { 'eu-west-2': accepted, 'us-east-1': rejected },
    evidence: ['captures/example.json'],
    admitted: { by: 'a maintainer', date: '2026-07-13', issue: 'https://example.test/1' },
    ...overrides,
  }
}

describe('validateRegistry', () => {
  it('accepts a valid registry', () => {
    const doc = { splits: [row()] }
    expect(validateRegistry(doc)).toBe(doc)
  })

  it('accepts an empty registry: no splits is a valid state of the world', () => {
    expect(() => validateRegistry({ splits: [] })).not.toThrow()
  })

  it('a stale lastRefreshed is still readable: staleness belongs to the observed set, not the loader', () => {
    expect(() =>
      validateRegistry({ splits: [row({ lastRefreshed: '2020-01-01' })] }),
    ).not.toThrow()
  })

  it('rejects a document without a splits array', () => {
    expect(() => validateRegistry({})).toThrow(/expected \{ splits/)
    expect(() => validateRegistry(null)).toThrow(/expected \{ splits/)
  })

  it('rejects a row with fewer than two regions: a split needs two definite answers', () => {
    expect(() =>
      validateRegistry({ splits: [row({ regions: { 'eu-west-2': accepted } })] }),
    ).toThrow(/at least two regions/)
  })

  it('rejects a row where every named region returns the same answer', () => {
    expect(() =>
      validateRegistry({
        splits: [row({ regions: { 'eu-west-2': accepted, 'us-east-1': { ...accepted } } })],
      }),
    ).toThrow(/not a split/)
  })

  it('rejects a malformed region name', () => {
    expect(() =>
      validateRegistry({
        splits: [row({ regions: { 'not a region': accepted, 'us-east-1': rejected } })],
      }),
    ).toThrow(/malformed region name/)
  })

  it('rejects a region outside the known set when one is supplied', () => {
    expect(() =>
      validateRegistry(
        { splits: [row()] },
        { knownRegions: ['us-east-1', 'eu-central-1'] },
      ),
    ).toThrow(/unknown region "eu-west-2"/)
  })

  it('rejects missing ids, duplicate ids and duplicate test keys', () => {
    expect(() => validateRegistry({ splits: [row({ id: '' })] })).toThrow(/missing id/)
    expect(() => validateRegistry({ splits: [row(), row()] })).toThrow(/duplicate id/)
    expect(() =>
      validateRegistry({ splits: [row(), row({ id: 'other' })] }),
    ).toThrow(/duplicate row for the same test/)
  })

  it('rejects malformed dates and missing test keys', () => {
    expect(() =>
      validateRegistry({ splits: [row({ firstObserved: 'June 9th' })] }),
    ).toThrow(/malformed firstObserved/)
    expect(() => validateRegistry({ splits: [row({ test: { file: 'x' } })] })).toThrow(
      /missing test.fullName/,
    )
  })

  it('rejects a malformed observation: a shape that can match nothing must not load', () => {
    // The classifier validates the test-side observation against the same
    // shape (scripts/lib/classify.mjs), so a mismatch cannot hide on either
    // side of the sameObservation comparison.
    const malformed = [
      { outcome: 'rejected' },
      { outcome: 'rejected', error: { name: 'ValidationException' } },
      { outcome: 'accepted' },
      { outcome: 'maybe', detail: 'x' },
    ]
    for (const observation of malformed) {
      expect(() =>
        validateRegistry({
          splits: [row({ regions: { 'eu-west-2': observation, 'us-east-1': rejected } })],
        }),
      ).toThrow(/malformed observation/)
    }
  })

  it('rejects a row whose pinned side is absent or not a recorded region', () => {
    expect(() => validateRegistry({ splits: [row({ pinned: undefined })] })).toThrow(
      /pinned must name a region/,
    )
    expect(() => validateRegistry({ splits: [row({ pinned: 'sa-east-1' })] })).toThrow(
      /pinned must name a region/,
    )
  })
})

describe('querying', () => {
  const doc = { splits: [row()] }

  it('returns the recorded answer for a region named in a row', () => {
    const key = { file: 'tests/tier3/x.test.ts', fullName: 'suite behaves' }
    expect(expectedFor(doc, key, 'us-east-1')).toEqual(rejected)
    expect(expectedFor(doc, key, 'eu-west-2')).toEqual(accepted)
  })

  it('returns null for a test with no row: region-invariant, same expectation everywhere', () => {
    const key = { file: 'tests/tier1/other.test.ts', fullName: 'suite other' }
    expect(splitFor(doc, key)).toBeNull()
    expect(expectedFor(doc, key, 'us-east-1')).toBeNull()
    expect(expectedFor(doc, key, 'eu-west-2')).toBeNull()
  })

  it('returns null for a region the row does not name', () => {
    const key = { file: 'tests/tier3/x.test.ts', fullName: 'suite behaves' }
    expect(expectedFor(doc, key, 'sa-east-1')).toBeNull()
  })

  it('matches the absolute paths Vitest records against the repo-relative row path', () => {
    const key = {
      file: '/home/runner/work/repo/tests/tier3/x.test.ts',
      fullName: 'suite behaves',
    }
    expect(splitFor(doc, key)).toBe(doc.splits[0])
    // Suffix matching stops at a path-segment boundary: another file whose
    // name merely ends with the row's path is not the same test.
    expect(
      splitFor(doc, { file: '/repo/other-tests/tier3/x.test.ts', fullName: 'suite behaves' }),
    ).toBeNull()
  })
})

describe('sameObservation', () => {
  it('is key-order-insensitive and value-sensitive', () => {
    expect(
      sameObservation({ outcome: 'rejected', error: { name: 'X', message: 'y' } }, {
        error: { message: 'y', name: 'X' },
        outcome: 'rejected',
      }),
    ).toBe(true)
    expect(sameObservation(accepted, rejected)).toBe(false)
  })
})

describe('verdictAgainstPin', () => {
  it('reads a pass carrying a recorded answer as whether that answer is the pinned one', () => {
    expect(verdictAgainstPin(row(), 'pass', accepted)).toBe('pass')
    expect(verdictAgainstPin(row(), 'pass', rejected)).toBe('fail')
  })

  it('leaves a pass alone when it carries no observation or one no region records', () => {
    expect(verdictAgainstPin(row(), 'pass', undefined)).toBe('pass')
    expect(verdictAgainstPin(row(), 'pass', { outcome: 'accepted', detail: 'request accepted' })).toBe('pass')
  })

  it('never turns any other verdict into a pass', () => {
    for (const verdict of ['fail', 'skip', 'indeterminate']) {
      expect(verdictAgainstPin(row(), verdict, accepted)).toBe(verdict)
    }
  })
})

describe('the committed registry', () => {
  it('loads and validates', () => {
    const doc = loadRegistry()
    expect(doc.splits.length).toBeGreaterThan(0)
  })
})
