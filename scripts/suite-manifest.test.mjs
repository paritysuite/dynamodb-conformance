import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isTargetResultFile } from './lib/score.mjs'
import { readManifest, staleReport, suiteIdentities, suiteSizeOf } from './suite-manifest.mjs'
import { assertMeasuredSuite, assertOneDenominator, readTargets } from './summarise.mjs'

const MANIFEST = readManifest()

describe('the committed suite manifest', () => {
  it('is a sorted, deduplicated list of file-qualified identities', () => {
    expect(MANIFEST.count).toBe(MANIFEST.tests.length)
    expect(new Set(MANIFEST.tests).size).toBe(MANIFEST.tests.length)
    expect([...MANIFEST.tests].sort()).toEqual(MANIFEST.tests)
    for (const id of MANIFEST.tests) {
      // fullName is unique only within a file, so the path is half the key.
      expect(id, `${id} is not <file>::<fullName>`).toMatch(/^tests\/tier[123]\/.+\.test\.ts::.+/)
    }
  })

  it('reads back through the accessors the scorer uses', () => {
    expect(suiteSizeOf()).toBe(MANIFEST.tests.length)
    expect(suiteIdentities().size).toBe(MANIFEST.tests.length)
  })

  // Regenerating the manifest without re-running the targets, or the reverse,
  // leaves two inventories of the same suite disagreeing. Calls the publishing
  // gate rather than restating it, so the two cannot drift apart.
  it('names the same tests every committed run does', () => {
    const files = readdirSync('results').filter(isTargetResultFile)
    expect(files.length, 'no committed results to check').toBeGreaterThan(0)
    expect(() => assertMeasuredSuite(readTargets(files.map((f) => join('results', f))))).not.toThrow()
  })
})

describe('staleReport', () => {
  const id = (n) => `tests/tier1/a.test.ts::A ${n}`
  const recorded = Array.from({ length: 8 }, (_, n) => id(`'${n}'`))

  it('says nothing when the suite and the manifest agree', () => {
    expect(staleReport(recorded, [...recorded])).toBeNull()
  })

  // A rename leaves both totals at 8, so only the per-side counts show that all
  // eight moved, not the five that get listed.
  it('counts every renamed test, not only the ones it lists', () => {
    const defined = Array.from({ length: 8 }, (_, n) => id(n))
    const report = staleReport(defined, recorded)
    expect(report[0]).toBe(
      'registry/suite-manifest.json is stale: 8 tests defined, 8 recorded; ' +
        '8 defined but not recorded, 8 recorded but not defined.',
    )
    expect(report.filter((l) => l.startsWith('  defined but not recorded: '))).toHaveLength(5)
    expect(report).toContain('  ...and 3 more defined but not recorded')
    expect(report).toContain('  ...and 3 more recorded but not defined')
  })

  it('lists everything, with no remainder line, when there are few', () => {
    const report = staleReport([...recorded, id('new')], recorded)
    expect(report).toEqual([
      'registry/suite-manifest.json is stale: 9 tests defined, 8 recorded; ' +
        '1 defined but not recorded, 0 recorded but not defined.',
      `  defined but not recorded: ${id('new')}`,
    ])
  })
})

describe('assertMeasuredSuite', () => {
  const suite = new Set(['tests/tier1/a.test.ts::A one', 'tests/tier1/a.test.ts::A two'])
  const ran = (slug, names) => ({
    slug,
    raw: {
      testResults: [
        {
          name: '/repo/tests/tier1/a.test.ts',
          assertionResults: names.map((fullName) => ({ fullName, status: 'passed' })),
        },
      ],
    },
  })

  it('passes when every row names tests the suite defines', () => {
    expect(() => assertMeasuredSuite([ran('alpha', ['A one', 'A two'])], suite)).not.toThrow()
  })

  // The case the count check cannot see: the same total, a different
  // population. A results file carried across a rename looks exactly like this.
  it('refuses a row naming a test the suite no longer defines, at the same count', () => {
    expect(() => assertMeasuredSuite([ran('beta', ['A one', 'A moved'])], suite)).toThrow(
      /beta ran 1 \(tests\/tier1\/a\.test\.ts::A moved\).*predate a change to the tests/s,
    )
  })

  // The tag manifest rides in the same namespace and holds no run.
  it('ignores a companion file that carries no test results', () => {
    expect(() => assertMeasuredSuite([{ slug: 'tag-manifest', raw: { tags: [] } }], suite)).not.toThrow()
  })
})

describe('assertOneDenominator against the manifest', () => {
  const summaryOf = (counts) => ({
    targets: Object.fromEntries(
      Object.entries(counts).map(([slug, count]) => [
        slug,
        { headline: { region: 'eu-west-2' }, regions: { 'eu-west-2': { count } } },
      ]),
    ),
  })

  it('passes when every scored row divides by the suite', () => {
    expect(() => assertOneDenominator(summaryOf({ alpha: 10, beta: 10, empty: 0 }), 10)).not.toThrow()
  })

  // A short results file is the cheap lever: it lowers divergence and raises
  // coverage at once, and reads as a target that simply ran fewer tests.
  it('refuses a row that ran fewer tests than the suite defines', () => {
    expect(() => assertOneDenominator(summaryOf({ alpha: 10, beta: 7 }), 10)).toThrow(
      /beta scored 7.*lowers divergence and raises coverage/s,
    )
  })

  // The same check read the other way. A row above the manifest cannot be a
  // short file, so the manifest is behind the tests it claims to enumerate -
  // and every published figure is dividing by a number too small.
  it('refuses a row above the suite, and blames the manifest rather than the row', () => {
    expect(() => assertOneDenominator(summaryOf({ alpha: 10, beta: 12 }), 10)).toThrow(
      /beta scored 12.*suite-manifest\.json is stale/s,
    )
  })
})
