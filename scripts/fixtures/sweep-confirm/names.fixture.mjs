// Test names chosen to be awkward for a name-pattern selector. The sweep's
// confirmation re-run must select exactly one of these at a time; see the
// "confirmation re-run selection" tests in scripts/sweep-detect.test.mjs. The
// bodies do nothing - only which tests vitest selects matters.
import { describe, it } from 'vitest'

it('a top-level test', () => {})
it('a top-level test, with a longer name', () => {})

describe('Item size limit by surface — UpdateItem', () => {
  describe('charges each kind of clause', () => {
    it('charges a REMOVE one byte plus its path', () => {})
    it('charges a REMOVE one byte plus its path, twice', () => {})
  })
})

describe('Regex metacharacters (.*+?^${}|[]\\)', () => {
  it('costs $1.00 (exactly)? [yes|no]', () => {})
})

describe('a describe > with the separator in it', () => {
  it('and a test > with one too', () => {})
})

describe('naïve café ✓', () => {
  it('non-ASCII — throughout, 東京', () => {})
})

describe('parameterised', () => {
  it.each(['key a', 'key a.b'])('reads %s', () => {})
  it.each([1, 10])('handles %i items', () => {})
})

describe.each([['alpha'], ['beta']])('describe.each %s', () => {
  it('runs once per row', () => {})
})

describe('formatted names', () => {
  it.each(['x', 'y'])('index %# of the list', () => {})
  it.each([[{ a: 1, b: [2] }]])('object %o', () => {})
  it.each([[{ a: 1, b: 'two' }]])('json %j', () => {})
  it.each([{ key: 'k.v', n: 2 }])('template $key and $n', () => {})
})

describe('whitespace', () => {
  it('  leading spaces', () => {})
  it('trailing spaces  ', () => {})
  it('double  spaces', () => {})
  it('double spaces', () => {})
  it('a newline\nin the name', () => {})
})

// Two tests with the same name in one describe. A re-run of either selects
// both, and must say so.
describe('duplicates', () => {
  it('same name', () => {})
  it('same name', () => {})
})

// Two different tests whose names join to the same string. No pattern can
// tell them apart, so a re-run of either must select both and say so.
describe('collides > here', () => {
  it('x', () => {})
})
describe('collides', () => {
  describe('here', () => {
    it('x', () => {})
  })
})
