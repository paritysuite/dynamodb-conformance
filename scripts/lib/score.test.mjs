import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Every file under a directory, recursively. */
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
import {
  cohortOf,
  GROUND_TRUTH_LANES,
  GROUND_TRUTH_SLUG,
  isPublishedTarget,
  isTargetResultFile,
  loadScoringContext,
  RESERVED_SLUGS,
  passRate,
  targetResultSlug,
  PINNED_REGION,
  regionLabel,
  scoreAcrossRegions,
  scoreAgainstRegion,
  scoreResults,
  scoreTarget,
  scoreVerdicts,
  tierOf,
  verdictsForRegion,
} from './score.mjs'

// Build a minimal Vitest-shaped result: one test file per named tier directory,
// each carrying the given passed/failed/skipped assertion counts.
function result(tiers) {
  const fill = (status, n) => Array.from({ length: n }, () => ({ status }))
  const testResults = Object.entries(tiers).map(([tier, { p = 0, f = 0, s = 0 }]) => ({
    name: `/repo/tests/${tier}/x.test.ts`,
    assertionResults: [...fill('passed', p), ...fill('failed', f), ...fill('skipped', s)],
  }))
  return { testResults }
}

describe('tierOf', () => {
  it('maps tier directories and falls back to other', () => {
    expect(tierOf('/repo/tests/tier1/a.test.ts')).toBe('tier1')
    expect(tierOf('/repo/tests/tier2/a.test.ts')).toBe('tier2')
    expect(tierOf('/repo/tests/tier3/a.test.ts')).toBe('tier3')
    expect(tierOf('/repo/tests/misc/a.test.ts')).toBe('other')
  })
})

describe('scoreResults', () => {
  it('returns null for a file that is not a Vitest result', () => {
    expect(scoreResults({ schema: 1, describes: {} })).toBeNull()
    expect(scoreResults({})).toBeNull()
    expect(scoreResults(null)).toBeNull()
  })

  it('sums passed/failed/skipped across the three tiers', () => {
    const scored = scoreResults(
      result({ tier1: { p: 3 }, tier2: { p: 2, f: 1 }, tier3: { p: 1, s: 4 } }),
    )
    expect(scored).toMatchObject({ passed: 6, failed: 1, skipped: 4, count: 11 })
  })

  it('excludes the "other" tier from the counts', () => {
    const scored = scoreResults(result({ tier1: { p: 2 }, other: { p: 5, f: 5 } }))
    expect(scored).toMatchObject({ passed: 2, failed: 0, skipped: 0, count: 2 })
  })

  it('returns zeroed counts (not null) for a real result with no scored tests', () => {
    expect(scoreResults({ testResults: [] })).toMatchObject({
      passed: 0,
      failed: 0,
      skipped: 0,
      count: 0,
    })
  })

  it('classifies a failed test carrying meta.indeterminate out of both sides of the rate', () => {
    // AE2: a failed observation counts neither for nor against a target, so
    // the rate is unchanged by a region (or a run) having a bad day.
    const raw = {
      testResults: [
        {
          name: '/repo/tests/tier1/x.test.ts',
          assertionResults: [
            { title: 'a', fullName: 'a', status: 'passed', meta: {} },
            {
              title: 'b',
              fullName: 'b',
              status: 'failed',
              meta: { indeterminate: { reason: 'gsi-consistency-timeout', at: 'test' } },
            },
          ],
        },
      ],
    }
    const scored = scoreResults(raw)
    expect(scored).toMatchObject({ passed: 1, failed: 0, skipped: 0, indeterminate: 1, count: 2 })
    expect(passRate(scored.passed, scored.failed)).toBe(100)
  })

  it('a run-level sidecar makes the whole run indeterminate, not failed', () => {
    const raw = {
      testResults: [
        {
          name: '/repo/tests/tier1/x.test.ts',
          assertionResults: [{ title: 'a', fullName: 'a', status: 'passed', meta: {} }],
        },
      ],
    }
    const sidecar = { runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning' }] }
    const scored = scoreResults(raw, sidecar)
    expect(scored).toMatchObject({ passed: 0, failed: 0, indeterminate: 1 })
    expect(passRate(scored.passed, scored.failed)).toBeNull()
  })
})

describe('scoreVerdicts', () => {
  it('buckets the four verdicts per tier and counts them all', () => {
    const v = (tier, verdict) => ({ file: `/repo/tests/${tier}/x.test.ts`, verdict })
    const scored = scoreVerdicts([
      v('tier1', 'pass'),
      v('tier1', 'indeterminate'),
      v('tier2', 'fail'),
      v('tier3', 'skip'),
      v('misc', 'pass'), // outside the tiers, not counted
    ])
    expect(scored.summary.tier1).toEqual({ p: 1, f: 0, s: 0, i: 1 })
    expect(scored).toMatchObject({ passed: 1, failed: 1, skipped: 1, indeterminate: 1, count: 4 })
  })
})

// Shared split fixtures for the per-region describes below. One admitted
// split: the committed test asserts the accepting side (pinned eu-west-2),
// eu-central-1 agrees with it, us-east-1 rejects.
const accepted = { outcome: 'accepted', detail: 'stored and normalised' }
const rejected = {
  outcome: 'rejected',
  error: { name: 'ValidationException', message: 'must have the value of true' },
}
const registry = {
  splits: [
    {
      id: 'example-split',
      test: { file: 'tests/tier3/split.test.ts', fullName: 'suite splits' },
      pinned: 'eu-west-2',
      regions: { 'eu-west-2': accepted, 'eu-central-1': accepted, 'us-east-1': rejected },
    },
  ],
}
const REGIONS = ['eu-west-2', 'eu-central-1', 'us-east-1']
const rateIn = (scored) => passRate(scored.passed, scored.failed)

describe('per-region scoring', () => {
  // A suite of verdicts: `others` region-invariant passes, plus the split test.
  const suite = (splitVerdict) => [
    { file: '/repo/tests/tier1/a.test.ts', fullName: 'a', verdict: 'pass' },
    { file: '/repo/tests/tier2/b.test.ts', fullName: 'b', verdict: 'pass' },
    { file: '/repo/tests/tier3/split.test.ts', fullName: 'suite splits', ...splitVerdict },
  ]

  it('an engine matching every region scores 100% everywhere and 100% headline', () => {
    const verdicts = suite({ verdict: 'pass' })
    const { regions, headline } = scoreAcrossRegions(verdicts, { splits: [] }, REGIONS)
    for (const region of REGIONS) expect(rateIn(regions[region])).toBe(100)
    expect(headline.rate).toBe(100)
  })

  it('takes the best observed region as the headline (AE3)', () => {
    // The engine matches us-east-1 on every behaviour: it fails the committed
    // (eu-west-2-pinned) assertion, and its recorded observation is exactly
    // what us-east-1 returns.
    const verdicts = suite({ verdict: 'fail', observed: rejected })
    const { regions, headline } = scoreAcrossRegions(verdicts, registry, REGIONS)
    expect(rateIn(regions['us-east-1'])).toBe(100)
    expect(rateIn(regions['eu-west-2'])).toBeCloseTo((2 / 3) * 100, 5)
    expect(headline).toEqual({ region: 'us-east-1', rate: 100 })
  })

  it('an engine doing something no region does fails everywhere, and the failure survives the headline (AE4)', () => {
    // Accepts { NULL: false } but returns it unchanged on read: not what any
    // region records, so no observed region can rescue it.
    const frankenstein = { outcome: 'accepted', detail: 'stored without normalising' }
    const verdicts = suite({ verdict: 'fail', observed: frankenstein })
    const { regions, headline } = scoreAcrossRegions(verdicts, registry, REGIONS)
    for (const region of REGIONS) {
      expect(regions[region].failed).toBe(1)
    }
    expect(headline.rate).toBeCloseTo((2 / 3) * 100, 5)
  })

  it('a pass without an observation is a match with the pinned answer, and only that answer', () => {
    // Passing the committed assertion proves the target does what eu-west-2
    // does; the row says eu-central-1 records the same answer and us-east-1
    // does not.
    const verdicts = suite({ verdict: 'pass' })
    const byRegion = (region) =>
      verdictsForRegion(verdicts, registry, region).at(-1).verdict
    expect(byRegion('eu-west-2')).toBe('pass')
    expect(byRegion('eu-central-1')).toBe('pass')
    expect(byRegion('us-east-1')).toBe('fail')
  })

  it('a fail without an observation stays a fail in every region: a match is only awarded on evidence', () => {
    const verdicts = suite({ verdict: 'fail' })
    for (const region of REGIONS) {
      expect(verdictsForRegion(verdicts, registry, region).at(-1).verdict).toBe('fail')
    }
  })

  it('evidence never revokes a committed pass: an observation matching no recorded answer leaves the pinned credit alone', () => {
    // The committed assertions are deliberately tolerant of wording variance,
    // so a target can pass them while its verbatim answer byte-matches no
    // recorded string. Holding the pass to the exact string as well would
    // silently tighten every split test the moment evidence started flowing.
    const wordingVariant = { outcome: 'accepted', detail: 'stored, then normalised on read' }
    const verdicts = suite({ verdict: 'pass', observed: wordingVariant })
    const byRegion = (region) =>
      verdictsForRegion(verdicts, registry, region).at(-1).verdict
    expect(byRegion('eu-west-2')).toBe('pass')
    expect(byRegion('eu-central-1')).toBe('pass')
    expect(byRegion('us-east-1')).toBe('fail')
  })

  it('a pass carrying another region\'s recorded answer is scored on that answer, not as the pinned one', () => {
    // Where the pinned region gives both answers, the committed assertion
    // accepts both, so a pass no longer says which one the target gave. Its
    // observation does: this target answered as us-east-1 records.
    const verdicts = suite({ verdict: 'pass', observed: rejected })
    const byRegion = (region) =>
      verdictsForRegion(verdicts, registry, region).at(-1).verdict
    expect(byRegion('eu-west-2')).toBe('fail')
    expect(byRegion('eu-central-1')).toBe('fail')
    expect(byRegion('us-east-1')).toBe('pass')
  })

  it('a pass carrying the pinned answer is credited exactly where the pinned answer is recorded', () => {
    const verdicts = suite({ verdict: 'pass', observed: accepted })
    const byRegion = (region) =>
      verdictsForRegion(verdicts, registry, region).at(-1).verdict
    expect(byRegion('eu-west-2')).toBe('pass')
    expect(byRegion('eu-central-1')).toBe('pass')
    expect(byRegion('us-east-1')).toBe('fail')
  })

  it('indeterminate and skip pass through untouched: an absence is the same absence in every region (AE2)', () => {
    for (const verdict of ['indeterminate', 'skip']) {
      const verdicts = suite({ verdict })
      for (const region of REGIONS) {
        const scored = scoreAgainstRegion(verdicts, registry, region)
        expect(rateIn(scored)).toBe(100)
        expect(scored.count).toBe(3)
      }
    }
  })

  it('a region the row does not name keeps the region-invariant expectation', () => {
    const verdicts = suite({ verdict: 'pass' })
    expect(verdictsForRegion(verdicts, registry, 'sa-east-1').at(-1).verdict).toBe('pass')
  })

  it('a target with no split-relevant tests scores identically in every region', () => {
    // The common path is a no-op: nothing here matches the registry row, so
    // per-region re-evaluation changes no verdict.
    const verdicts = [
      { file: '/repo/tests/tier1/a.test.ts', fullName: 'a', verdict: 'pass' },
      { file: '/repo/tests/tier2/b.test.ts', fullName: 'b', verdict: 'fail' },
    ]
    const { regions } = scoreAcrossRegions(verdicts, registry, REGIONS)
    for (const region of REGIONS) {
      expect(regions[region]).toEqual(regions['eu-west-2'])
    }
  })

  it('scoring against an empty observed set is an error, not a silent 0% or 100%', () => {
    expect(() => scoreAcrossRegions(suite({ verdict: 'pass' }), registry, [])).toThrow(
      /empty observed region set/,
    )
    expect(() => scoreAcrossRegions(suite({ verdict: 'pass' }), registry)).toThrow(
      /empty observed region set/,
    )
  })

  it('breaks headline ties by region name, so a re-run is byte-identical', () => {
    const verdicts = suite({ verdict: 'pass' })
    const { headline } = scoreAcrossRegions(verdicts, { splits: [] }, [
      'us-east-1',
      'eu-west-2',
      'eu-central-1',
    ])
    expect(headline.region).toBe('eu-central-1')
  })

  it('a tie goes to a characterised region, never one the registry has no answers for', () => {
    // ap-east-2 appears in no split row, so every verdict passes through
    // untouched and it ties the best characterised region by knowing nothing.
    // It sorts first alphabetically; the headline must still name a region
    // whose recorded answers actually did the work.
    const verdicts = suite({ verdict: 'pass' })
    const { regions, headline } = scoreAcrossRegions(verdicts, registry, [
      'ap-east-2',
      ...REGIONS,
    ])
    expect(rateIn(regions['ap-east-2'])).toBe(100)
    expect(headline).toEqual({ region: 'eu-central-1', rate: 100 })
  })

  it('an uncharacterised region that strictly wins still headlines: only ties are re-ordered', () => {
    // Two rows pinned to regions that disagree with each other, and a target
    // passing both committed assertions: each pinned region fails the other
    // row, while ap-east-2 (in no row) passes both verdicts through and
    // strictly wins. The max is the max; the tie-break must not distort it.
    const twoPins = {
      splits: [
        registry.splits[0],
        {
          id: 'counter-split',
          test: { file: 'tests/tier3/counter.test.ts', fullName: 'suite counters' },
          pinned: 'us-east-1',
          regions: { 'eu-west-2': accepted, 'eu-central-1': accepted, 'us-east-1': rejected },
        },
      ],
    }
    const verdicts = [
      ...suite({ verdict: 'pass' }),
      { file: '/repo/tests/tier3/counter.test.ts', fullName: 'suite counters', verdict: 'pass' },
    ]
    const { headline } = scoreAcrossRegions(verdicts, twoPins, ['ap-east-2', ...REGIONS])
    expect(headline).toEqual({ region: 'ap-east-2', rate: 100 })
  })

})

describe('scoreTarget', () => {
  const context = { registry: { splits: [] }, observed: ['eu-west-2'] }

  it('returns null for a document that is not a Vitest result', () => {
    expect(scoreTarget({ schema: 1 }, null, context)).toBeNull()
    expect(scoreTarget(null, null, context)).toBeNull()
  })

  it('classifies with the sidecar before scoring across regions', () => {
    const raw = result({ tier1: { p: 5 } })
    const sidecar = { runLevel: [{ reason: 'table-active-timeout' }] }
    const clean = scoreTarget(raw, null, context)
    expect(clean.headline.rate).toBe(100)
    const doomed = scoreTarget(raw, sidecar, context)
    expect(doomed.headline.rate).toBeNull()
    expect(doomed.regions['eu-west-2'].indeterminate).toBe(5)
  })
})

describe('observed evidence through the pipeline', () => {
  // The regression that let 2.0.0 ship with per-region scoring only able to
  // subtract: the per-region tests above set `observed` on verdicts by hand,
  // proving verdictsForRegion but never the pipeline feeding it, and nothing
  // in the pipeline populated it. Here the observation enters through the raw
  // document's `assertionResults[].meta`, the way a run's results file
  // carries what src/observation-sink.ts stamped.

  // One region-invariant pass plus the split test, as a raw Vitest document
  // with the runner's absolute file path.
  const raw = (splitAssertion) => ({
    testResults: [
      {
        name: '/repo/tests/tier3/split.test.ts',
        assertionResults: [
          { title: 'other', fullName: 'suite other', status: 'passed', meta: {} },
          { title: 'splits', fullName: 'suite splits', ...splitAssertion },
        ],
      },
    ],
  })

  it('a fail whose recorded answer matches a non-pinned region scores higher there than in the pinned one', () => {
    const doc = raw({ status: 'failed', meta: { observed: rejected } })
    const { regions, headline } = scoreTarget(doc, null, { registry, observed: REGIONS })
    expect(rateIn(regions['us-east-1'])).toBe(100)
    expect(rateIn(regions['eu-west-2'])).toBe(50)
    expect(headline).toEqual({ region: 'us-east-1', rate: 100 })
  })

  it('a pass carrying its observation stays a pass in the pinned region and fails where regions disagree', () => {
    const doc = raw({ status: 'passed', meta: { observed: accepted } })
    const { regions } = scoreTarget(doc, null, { registry, observed: REGIONS })
    expect(rateIn(regions['eu-west-2'])).toBe(100)
    expect(rateIn(regions['eu-central-1'])).toBe(100)
    expect(rateIn(regions['us-east-1'])).toBe(50)
  })

  it('a fail without an observation still stays a fail everywhere', () => {
    const doc = raw({ status: 'failed', meta: {} })
    const { regions, headline } = scoreTarget(doc, null, { registry, observed: REGIONS })
    for (const region of REGIONS) expect(rateIn(regions[region])).toBe(50)
    expect(headline.rate).toBe(50)
  })
})

describe('loadScoringContext', () => {
  it('loads the committed registry and region health into one context', () => {
    const { registry, health, observed } = loadScoringContext()
    expect(registry.splits.length).toBeGreaterThan(0)
    expect(health.regions['eu-west-2']).toBeDefined()
    expect(observed).toContain('eu-west-2')
  })
})

describe('passRate', () => {
  it('is passed / (passed + failed) as a percentage', () => {
    expect(passRate(99, 1)).toBeCloseTo(99, 5)
    expect(passRate(2, 1)).toBeCloseTo(66.6667, 3)
  })

  it('returns null when nothing ran', () => {
    expect(passRate(0, 0)).toBeNull()
  })
})

describe('GROUND_TRUTH_SLUG', () => {
  it('is dynamodb', () => {
    expect(GROUND_TRUTH_SLUG).toBe('dynamodb')
  })
})

describe('isPublishedTarget', () => {
  it('excludes the reserved local scratch slug', () => {
    expect(isPublishedTarget('local')).toBe(false)
  })

  it('excludes the summary artefact: pipeline output, not a target', () => {
    expect(isPublishedTarget('summary')).toBe(false)
  })

  it('excludes the ground-truth lanes: evidence behind one row, not rows', () => {
    // These are real Vitest documents covering a slice of the suite, so
    // whatever scores or badges a results file would happily publish one as a
    // target holding a fraction of it.
    for (const lane of GROUND_TRUTH_LANES) {
      expect(isPublishedTarget(`${GROUND_TRUTH_SLUG}.${lane}`)).toBe(false)
    }
  })

  it('keeps real targets, matching the slug exactly rather than by prefix', () => {
    // dynamodb-local contains "local" but is a real target; an exact-match
    // reservation must not catch it.
    expect(isPublishedTarget('dynamodb-local')).toBe(true)
    expect(isPublishedTarget('dynoxide')).toBe(true)
    expect(isPublishedTarget(GROUND_TRUTH_SLUG)).toBe(true)
  })
})

describe('cohortOf / regionLabel', () => {
  it('the pinned baseline is eu-west-2', () => {
    expect(PINNED_REGION).toBe('eu-west-2')
  })

  it('reads "all regions" when every region ties at the top, not a tie-break winner', () => {
    const entries = [
      { region: 'af-south-1', rate: 80 },
      { region: 'eu-west-2', rate: 80 },
      { region: 'us-east-1', rate: 80 },
    ]
    const label = cohortOf(entries)
    expect(label.kind).toBe('all')
    expect(regionLabel(label)).toBe('all regions')
  })

  it('anchors on eu-west-2 and counts the rest when the baseline is in the top cohort', () => {
    const entries = [
      { region: 'af-south-1', rate: 90 },
      { region: 'eu-west-2', rate: 90 },
      { region: 'us-east-1', rate: 80 },
    ]
    const label = cohortOf(entries)
    expect(label.kind).toBe('pinned-plus')
    expect(regionLabel(label)).toBe('eu-west-2 + 1 region')
  })

  it('names a single region only when it beats eu-west-2', () => {
    const entries = [
      { region: 'eu-west-2', rate: 90 },
      { region: 'eu-central-1', rate: 90 },
      { region: 'us-east-1', rate: 92 },
    ]
    const label = cohortOf(entries)
    expect(label.kind).toBe('beats-pinned')
    expect(label.regions[0]).toBe('us-east-1')
    expect(regionLabel(label)).toBe('us-east-1')
  })

  it('counts a beating cohort of several rather than crowning one representative', () => {
    const entries = [
      { region: 'eu-west-2', rate: 88 },
      { region: 'ap-south-1', rate: 91 },
      { region: 'us-east-1', rate: 91 },
    ]
    const label = cohortOf(entries)
    expect(label.kind).toBe('beats-pinned')
    expect(regionLabel(label)).toBe('2 regions')
  })

  it('ignores unrated regions and reads "-" when nothing scored', () => {
    expect(regionLabel(cohortOf([{ region: 'eu-west-2', rate: null }]))).toBe('-')
    const label = cohortOf([
      { region: 'eu-west-2', rate: 75 },
      { region: 'us-east-1', rate: null },
    ])
    expect(label.kind).toBe('all')
    expect(regionLabel(label)).toBe('all regions')
  })
})

// ── What counts as a target's results file ──────────────────────────────────

describe('targetResultSlug', () => {
  it('classifies every kind of file the results directory holds', () => {
    // Built from the real listing rather than a hand-written sample, so a kind
    // nobody has classified fails here instead of surprising a caller. Three
    // defects came from callers rebuilding a subset of this rule from memory.
    const listing = readdirSync('results')
    const kinds = {
      run: (f) => /^[a-z0-9-]+\.json$/.test(f) && !RESERVED_SLUGS.has(basename(f, '.json')),
      lane: (f) => GROUND_TRUTH_LANES.some((l) => f === `${GROUND_TRUTH_SLUG}.${l}.json`),
      badge: (f) => f.endsWith('.badge.json'),
      sidecar: (f) => f.endsWith('.indeterminate.json'),
      version: (f) => f.endsWith('.version'),
      reserved: (f) => f.endsWith('.json') && RESERVED_SLUGS.has(basename(f, '.json')),
    }
    const unclassified = listing.filter((f) => !Object.values(kinds).some((is) => is(f)))
    expect(unclassified, 'a file kind nobody has classified is in results/').toEqual([])

    for (const file of listing) {
      const expected = kinds.lane(file) || !kinds.run(file) ? null : basename(file, '.json')
      expect(targetResultSlug(file), file).toBe(expected)
    }
    // And the directory must actually contain the kinds this is guarding, or
    // the loop above proves nothing.
    for (const kind of ['run', 'badge', 'version', 'reserved']) {
      expect(listing.some(kinds[kind]), `no ${kind} file in results/ to test against`).toBe(true)
    }
  })

  it('reads a path or a bare name, and never splits a lane into a target', () => {
    expect(targetResultSlug('results/dynoxide.json')).toBe('dynoxide')
    expect(targetResultSlug('dynoxide.json')).toBe('dynoxide')
    // `dynamodb.gsi.json` is a lane document, not a target called dynamodb.gsi.
    expect(targetResultSlug('dynamodb.gsi.json')).toBeNull()
    expect(targetResultSlug('tag-manifest.json')).toBeNull()
    expect(isTargetResultFile('results/dynalite.json')).toBe(true)
    expect(isTargetResultFile('results/dynalite.version')).toBe(false)
  })

  it('nothing enumerates results/ without going through the predicate', () => {
    // A grep, deliberately. The failure mode is a new caller writing its own
    // extension filter, which no unit test of this module can see.
    //
    // The list is discovered rather than written down. It used to name three
    // files, so a caller that was not one of them was invisible - which is how
    // badges.test.mjs came to walk results/ with its own filter, pick up the
    // summary, the tag manifest and the gitignored scratch slug, and change its
    // own case count depending on whether the suite had been run locally. A
    // hand-maintained list of callers is the same bug this guard exists to
    // catch, one level up.
    const sources = walk('scripts').filter((f) => f.endsWith('.mjs'))
    for (const file of sources) {
      // Imports stripped first. Checking the whole file only proves the name
      // was imported, which stays true when a caller stops calling it.
      const body = readFileSync(file, 'utf8').replace(/^import[\s\S]*?from\s+'[^']+'$/gm, '')
      // The constant form too: badges.test.mjs walked `readdirSync(RESULTS_DIR)`
      // and the pattern did not know the name.
      if (!/readdirSync\((?:'results'|resultsDir|RESULTS_DIR)\)/.test(body)) continue
      expect(
        /targetResultSlug|isTargetResultFile/.test(body),
        `${file} walks results/ without the shared predicate`,
      ).toBe(true)
    }
  })
})
