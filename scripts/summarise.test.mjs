import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBadge, writeBadges } from './badges.mjs'
import { testIdentities } from './lib/identity.mjs'
import { GROUND_TRUTH_SLUG, axesOf, isTargetResultFile, loadScoringContext, scoreTarget, verdictsForRegion } from './lib/score.mjs'
import { classifyResults } from './lib/classify.mjs'
import { splitFor } from './lib/registry.mjs'
import { committedGradingInputs } from './lib/measured.mjs'
import { BASELINE_LABEL, gradeOf } from './lib/grade.mjs'
import { readManifest, suiteIdentities, suiteSizeOf } from './suite-manifest.mjs'
import {
  DISPLAY,
  REPO,
  SUMMARY_PATH,
  SUMMARY_SCHEMA_VERSION,
  assertMeasuredManifest,
  assertMeasuredSuite,
  assertOneDenominator,
  assertPublishableMeasurement,
  buildSummary,
  display,
  label,
  mergeLanes,
  publish,
  readTargets,
  regionStanding,
  renderTable,
  repoUrl,
  tableCaption,
  tableDateOf,
  healthLabel,
  measuredLabel,
  resolveMeasurement,
  tableRows,
  writeSummaryFile,
} from './summarise.mjs'

const DAY = '2026-07-06'
const health = (regions) => ({ regions })
const entry = (consecutiveUnresolved, lastResolved = DAY) => ({
  lastResolved,
  consecutiveUnresolved,
})

// Two healthy regions, one admitted split between them. The committed
// assertion encodes us-east-1's answer (pinned), so a target passing it
// matches us-east-1 and not eu-west-2.
const HEALTHY = health({ 'eu-west-2': entry(0), 'us-east-1': entry(0) })
const REGISTRY = {
  splits: [
    {
      id: 'example-split',
      test: { file: 'tests/tier3/split.test.ts', fullName: 'suite splits' },
      pinned: 'us-east-1',
      regions: {
        'us-east-1': { outcome: 'accepted' },
        'eu-west-2': { outcome: 'rejected' },
      },
    },
  ],
}

// Minimal Vitest-shaped result: { '<file>': [['fullName', 'status'], ...] }.
function rawDoc(files, startTime = Date.UTC(2026, 6, 6)) {
  return {
    startTime,
    testResults: Object.entries(files).map(([name, assertions]) => ({
      name,
      assertionResults: assertions.map(([fullName, status]) => ({
        title: fullName,
        fullName,
        status,
        meta: {},
      })),
    })),
  }
}

const target = (slug, raw, overrides = {}) => ({
  slug,
  raw,
  sidecar: null,
  version: '1.0.0',
  runDate: DAY,
  ...overrides,
})

// Two region-invariant passes plus the split test with the given status.
const suiteDoc = (splitStatus) =>
  rawDoc({
    '/repo/tests/tier1/a.test.ts': [
      ['a', 'passed'],
      ['b', 'passed'],
    ],
    '/repo/tests/tier3/split.test.ts': [['suite splits', splitStatus]],
  })

// These fixtures are their own suite. Derived from the doc rather than written
// out, so a change to suiteDoc cannot leave the guards measuring against a
// population the fixtures no longer have.
const FIXTURE_SUITE = testIdentities(suiteDoc('passed'))

describe('regionStanding', () => {
  it('keeps healthy regions observed with nothing unresolved or dropped', () => {
    expect(regionStanding(HEALTHY)).toEqual({
      observed: ['eu-west-2', 'us-east-1'],
      unresolved: [],
      dropped: [],
    })
  })

  it('a region that missed one sweep stays observed but is named unresolved', () => {
    const standing = regionStanding(health({ 'eu-west-2': entry(0), 'us-east-1': entry(1) }))
    expect(standing.observed).toEqual(['eu-west-2', 'us-east-1'])
    expect(standing.unresolved).toEqual(['us-east-1'])
    expect(standing.dropped).toEqual([])
  })

  it('two consecutive misses drop a region out of the observed set', () => {
    const standing = regionStanding(health({ 'eu-west-2': entry(0), 'us-east-1': entry(2) }))
    expect(standing.observed).toEqual(['eu-west-2'])
    expect(standing.dropped).toEqual(['us-east-1'])
  })

  it('a region that has never resolved is not observed', () => {
    const standing = regionStanding(
      health({ 'eu-west-2': entry(0), 'ap-southeast-2': entry(0, null) }),
    )
    expect(standing.observed).toEqual(['eu-west-2'])
    expect(standing.dropped).toEqual(['ap-southeast-2'])
  })

  it('every region dropping at once is loud, not a silently empty set', () => {
    expect(() => regionStanding(health({ 'eu-west-2': entry(2) }))).toThrow(
      /no observed regions/,
    )
  })
})

describe('buildSummary', () => {
  it('scores each target in every observed region and headlines the max (per-region columns)', () => {
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: HEALTHY,
    })
    const t = summary.targets.alpha

    // One entry per observed region, and the headline is their max - here
    // us-east-1, whose recorded answer the passing committed assertion encodes.
    expect(Object.keys(t.regions)).toEqual(['eu-west-2', 'us-east-1'])
    expect(t.regions['us-east-1'].rate).toBe(100)
    expect(t.regions['eu-west-2'].rate).toBe(66.7)
    expect(t.headline).toEqual({ region: 'us-east-1', rate: 100 })
    expect(summary.schemaVersion).toBe(SUMMARY_SCHEMA_VERSION)
  })

  it('carries the ground-truth run date and pins its rate at 100 (self-agreement)', () => {
    const summary = buildSummary(
      [target(GROUND_TRUTH_SLUG, suiteDoc('passed')), target('alpha', suiteDoc('passed'))],
      { registry: REGISTRY, health: HEALTHY },
    )
    expect(summary.groundTruth).toMatchObject({
      slug: GROUND_TRUTH_SLUG,
      rate: 100,
      runDate: DAY,
    })
    // The ground truth is never listed as a target of itself.
    expect(Object.keys(summary.targets)).toEqual(['alpha'])
  })

  it('an unresolved region appears explicitly and is still scored against (AE6)', () => {
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: health({ 'eu-west-2': entry(0), 'us-east-1': entry(1) }),
    })
    expect(summary.regions.unresolved).toEqual(['us-east-1'])
    // Its registry rows are retained: the target's headline still draws on it.
    expect(summary.targets.alpha.headline.region).toBe('us-east-1')
    expect(renderTable(summary)).toContain('`us-east-1` did not resolve the latest sweep')
  })

  it('a dropped region is excluded from the headline max and labelled dropped (AE5)', () => {
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: health({ 'eu-west-2': entry(0), 'us-east-1': entry(2) }),
    })
    expect(summary.regions.dropped).toEqual(['us-east-1'])
    // us-east-1 would give this target 100%, but a dropped region cannot
    // contribute: the headline falls back to the best remaining region.
    expect(summary.targets.alpha.headline).toEqual({ region: 'eu-west-2', rate: 66.7 })
    expect(summary.targets.alpha.regions['us-east-1']).toBeUndefined()
    expect(renderTable(summary)).toContain(
      '`us-east-1` has been dropped from the observed set',
    )
  })

  it('a run-level indeterminate empties the rate rather than failing the target', () => {
    const sidecar = { runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning' }] }
    const summary = buildSummary([target('alpha', suiteDoc('failed'), { sidecar })], {
      registry: REGISTRY,
      health: HEALTHY,
    })
    const t = summary.targets.alpha
    expect(t.headline.rate).toBeNull()
    expect(t.regions['eu-west-2']).toMatchObject({ rate: null, indeterminate: 3, failed: 0 })
  })

  it('skips files that are not a target run (e.g. the tag manifest)', () => {
    const summary = buildSummary(
      [target('tag-manifest', { schema: 1, describes: {} }), target('alpha', suiteDoc('passed'))],
      { registry: REGISTRY, health: HEALTHY },
    )
    expect(Object.keys(summary.targets)).toEqual(['alpha'])
  })

  // The evidence the site build checks the A+ premise from. Publish the names
  // and it can check identity; publish nothing and a count is all it has.
  describe('the failing test identities behind a zero-divergence row', () => {
    it('names the tests a zero-divergence target fails outside its headline region', () => {
      // Passes the split in us-east-1 (which accepts) and so fails it in
      // eu-west-2 (which rejects): zero divergence in its headline, one fail
      // elsewhere, and that fail is the registry's split.
      const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
        registry: REGISTRY,
        health: HEALTHY,
      })
      const t = summary.targets.alpha
      expect(t.headline.region).toBe('us-east-1')
      expect(t.regionFailures).toEqual({
        'eu-west-2': ['tests/tier3/split.test.ts::suite splits'],
      })
    })

    it('names every fail the row declares, so the build can check the count adds up', () => {
      const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
        registry: REGISTRY,
        health: HEALTHY,
      })
      const t = summary.targets.alpha
      for (const [region, names] of Object.entries(t.regionFailures)) {
        expect(names.length, `${region} names as many tests as it declares failed`).toBe(
          t.regions[region].failed,
        )
      }
    })

    it('names each fail by file and title, the identity splitFor matches on', () => {
      // A title is unique only within its file, so a bare name would let a
      // same-named test in another file satisfy the build's split check.
      const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
        registry: REGISTRY,
        health: HEALTHY,
      })
      for (const names of Object.values(summary.targets.alpha.regionFailures)) {
        for (const id of names) expect(id).toMatch(/^tests\/.+\.test\.ts::.+/)
      }
    })

    it('omits the field for a target that diverges in its headline region', () => {
      // The A+ claim is not about this row, so publishing the evidence for it
      // would grow the artefact for every target on the board to no purpose.
      const summary = buildSummary([target('alpha', suiteDoc('failed'))], {
        registry: REGISTRY,
        health: HEALTHY,
      })
      expect(summary.targets.alpha.regionFailures).toBeUndefined()
    })

    it('omits regions where a zero-divergence target fails nothing', () => {
      const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
        registry: REGISTRY,
        health: HEALTHY,
      })
      expect(Object.keys(summary.targets.alpha.regionFailures)).not.toContain('us-east-1')
    })

    it('the committed board publishes evidence for every zero-divergence row', () => {
      // A change that stopped emitting the names would leave the build check
      // with nothing to check. It reports that rather than passing, but this
      // fails first, against the tree, while someone is working.
      const context = loadScoringContext()
      const summary = buildSummary(
        readTargets(
          readdirSync('results')
            .filter(isTargetResultFile)
            .map((f) => join('results', f)),
        ),
        context,
      )
      let zeroDivergence = 0
      for (const [slug, t] of Object.entries(summary.targets)) {
        const headline = t.regions[t.headline.region]
        if (!headline || headline.count === 0 || axesOf(headline).divergence !== 0) continue
        zeroDivergence++
        const failing = Object.entries(t.regions).filter(([, r]) => r.failed > 0)
        if (failing.length === 0) continue
        expect(t.regionFailures, `${slug} fails somewhere and published no identities`).toBeTruthy()
        for (const [region, r] of failing) {
          expect(t.regionFailures[region]?.length, `${slug}/${region}`).toBe(r.failed)
        }
      }
      // 2026-08-12: the index write-capacity tests (#124) took the board's
      // last zero-divergence rows, so this sweep can legitimately find
      // nothing to check. Vacuous is a real state now, not a bug: the per-row
      // assertions re-arm the moment any row returns to zero divergence.
      if (zeroDivergence === 0) return
    })
  })
})

// ── The real-AWS lanes behind the baseline row ──────────────────────────────

describe('the ground truth as three lanes', () => {
  const laneDir = () => mkdtempSync(join(tmpdir(), 'lanes-'))

  it('a lane that shipped an indeterminate sidecar is not merged', () => {
    // Otherwise the lane's failures read as observed answers, `unobserved`
    // empties, the row derives, and the board publishes real DynamoDB
    // diverging from itself.
    const dir = laneDir()
    const file = join(dir, 'dynamodb.json')
    writeFileSync(file, JSON.stringify(suiteDoc('passed')))
    writeFileSync(join(dir, 'dynamodb.gsi.json'), JSON.stringify(suiteDoc('passed')))
    writeFileSync(
      join(dir, 'dynamodb.gsi.indeterminate.json'),
      JSON.stringify({ runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning' }] }),
    )
    const [target] = readTargets([file])
    expect(target.missingLanes).toContain('gsi')
  })

  it('an unreadable lane degrades rather than aborting the regeneration', () => {
    const dir = laneDir()
    const file = join(dir, 'dynamodb.json')
    writeFileSync(file, JSON.stringify(suiteDoc('passed')))
    writeFileSync(join(dir, 'dynamodb.gsi.json'), '{"testResults": [truncated')
    expect(() => readTargets([file])).not.toThrow()
    expect(readTargets([file])[0].missingLanes).toContain('gsi')
  })

  // Real AWS is observed in three runs: the gating job plus the two slower
  // lanes. The fixture is split the same way, and each lane's paths carry a
  // different absolute prefix because each lane runs in its own CI job.
  const LANE_TESTS = {
    gating: { 'tests/tier1/a.test.ts': [['a', 'passed'], ['b', 'passed']] },
    integrations: {
      'tests/tier2/export/exportImport.test.ts': [['export > writes to S3', 'passed']],
    },
    gsi: {
      'tests/tier2/updateTable/gsi.test.ts': [['updateTable > adds a GSI', 'passed']],
    },
  }
  const under = (prefix, files) =>
    Object.fromEntries(Object.entries(files).map(([f, a]) => [`${prefix}/${f}`, a]))

  const gating = rawDoc(under('/gate', LANE_TESTS.gating), Date.UTC(2026, 6, 6))
  const integrations = rawDoc(under('/int', LANE_TESTS.integrations), Date.UTC(2026, 6, 7))
  const gsi = rawDoc(under('/gsi', LANE_TESTS.gsi), Date.UTC(2026, 6, 8))
  // Every test the fixture's suite contains, standing in for the manifest.
  const whole = rawDoc(
    under('/repo', { ...LANE_TESTS.gating, ...LANE_TESTS.integrations, ...LANE_TESTS.gsi }),
  )

  // Lay out a results directory and read it back the way the CLI does.
  const readDir = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'lanes-'))
    for (const [name, doc] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(doc))
    }
    return readTargets(readdirSync(dir).map((f) => join(dir, f)))
  }
  // `whole` is this fixture's suite manifest: the four tests the lanes divide
  // between them.
  const summaryOf = (targets) =>
    buildSummary(targets, { registry: REGISTRY, health: HEALTHY, suiteTests: testIdentities(whole) })
  const baselineRow = (summary) => tableRows(summary).find((r) => r.slug === GROUND_TRUTH_SLUG)

  it('unions the lanes into one document, with no test counted twice', () => {
    // The gating document passed in twice over: a lane that repeats what the
    // gate already ran must add nothing.
    const merged = mergeLanes(gating, [integrations, gsi, gating])
    expect(testIdentities(merged)).toEqual(testIdentities(whole))
    expect(merged.testResults).toHaveLength(3)
    expect(merged.testResults.flatMap((tr) => tr.assertionResults)).toHaveLength(4)
  })

  it('lets the gating run keep the answer when a lane restates it', () => {
    const restated = rawDoc(under('/int', { 'tests/tier1/a.test.ts': [['a', 'failed']] }))
    const merged = mergeLanes(gating, [restated])
    const verdicts = merged.testResults.flatMap((tr) => tr.assertionResults)
    expect(verdicts.filter((ar) => ar.fullName === 'a')).toEqual([
      expect.objectContaining({ status: 'passed' }),
    ])
  })

  it('leaves the document and the published row untouched when no lane is present', () => {
    const targets = readDir({ 'dynamodb.json': gating, 'alpha.json': whole })
    expect(targets.find((t) => t.slug === GROUND_TRUTH_SLUG).raw).toEqual(gating)

    // The pinned row: the whole suite at 100%, which is what the lanes not
    // being merged in has always published.
    expect(baselineRow(summaryOf(targets))).toMatchObject({
      total: '100.0%',
      divergence: '0.0%',
      coverage: '100.0%',
      tier1: '0.0%',
      passed: 4,
      failed: 0,
      skipped: 0,
      count: 4,
    })
  })

  it('stays pinned when the lanes fall short of the suite, and says which are missing', () => {
    const gt = summaryOf(
      readDir({ 'dynamodb.json': gating, 'dynamodb.gsi.json': gsi, 'alpha.json': whole }),
    ).groundTruth

    // Three of the suite's four tests were observed, so a row derived from
    // them would span less than the figures beneath it are divided by. The pin
    // is honest here; a narrower measurement would not be.
    expect(gt).toMatchObject({
      derived: false,
      testsObserved: 3,
      suiteSize: 4,
      missingLanes: ['integrations'],
      counts: null,
    })
  })

  it('derives the row from the merge once it spans the suite', () => {
    const summary = summaryOf(
      readDir({
        'dynamodb.json': gating,
        'dynamodb.gsi.json': gsi,
        'dynamodb.integrations.json': integrations,
        'alpha.json': whole,
      }),
    )
    expect(summary.groundTruth).toMatchObject({
      derived: true,
      testsObserved: 4,
      suiteSize: 4,
      missingLanes: [],
      rate: 100,
      counts: { passed: 4, failed: 0, skipped: 0, indeterminate: 0, count: 4 },
    })
    // Measured, not pinned: the row's counts are the merged document's.
    expect(baselineRow(summary)).toMatchObject({ passed: 4, count: 4, total: '100.0%' })
    // And a lane document is evidence, never a row of its own.
    expect(Object.keys(summary.targets)).toEqual(['alpha'])
  })

  it('dates each lane it merged, so three captures never read as one', () => {
    const summary = summaryOf(
      readDir({
        'dynamodb.json': gating,
        'dynamodb.gsi.json': gsi,
        'dynamodb.integrations.json': integrations,
        'alpha.json': whole,
      }),
    )
    expect(summary.groundTruth.lanes).toEqual([
      { name: 'gating', runDate: '2026-07-06', tests: 2 },
      { name: 'integrations', runDate: '2026-07-07', tests: 1 },
      { name: 'gsi', runDate: '2026-07-08', tests: 1 },
    ])
  })
})

describe('tableRows / renderTable', () => {
  const docs = {
    [GROUND_TRUTH_SLUG]: suiteDoc('passed'),
    alpha: suiteDoc('passed'),
    beta: suiteDoc('failed'),
    empty: rawDoc({ '/repo/tests/tier1/a.test.ts': [] }),
  }
  const summary = buildSummary(
    Object.entries(docs).map(([slug, doc]) => target(slug, doc)),
    { registry: REGISTRY, health: HEALTHY, suiteTests: testIdentities(suiteDoc('passed')) },
  )
  const rows = tableRows(summary)

  it('renders the ground-truth row first, ungraded, at an earned 100% across all regions', () => {
    // 100% by self-agreement: each real region scores 100% against its own
    // recorded behaviour, so the max over any observed set is 100%. Its figures
    // publish and its grade does not: a letter measures distance from real
    // DynamoDB, so the yardstick has none to wear. The table had kept grading it
    // A+ after the site moved it out of the board, which put a letter nothing
    // could beat on the first row a reader meets.
    expect(rows[0]).toMatchObject({
      target: label(GROUND_TRUTH_SLUG),
      grade: BASELINE_LABEL,
      total: '100.0%',
      divergence: '0.0%',
      coverage: '100.0%',
      failed: 0,
      passed: 3, // the suite size, from the manifest
    })
  })

  it('sorts targets by headline rate, dateless "-" rates last', () => {
    expect(rows.map((r) => r.target)).toEqual([
      label(GROUND_TRUTH_SLUG),
      'alpha',
      'beta',
      'empty',
    ])
    // A target that implemented nothing has no divergence to grade, so its
    // grade is the same "-" as its figures rather than an invented letter.
    expect(rows.at(-1)).toMatchObject({ total: '-', divergence: '-', grade: '-' })
  })

  it('publishes the best-matching region\'s divergence, with the cohort kept for the drilldown', () => {
    // Regional variation is not published beside the figure. A count of
    // matching regions is not a quality measure and was read as one: a target
    // equally wrong in every region counted higher than one perfect in a few
    // and near-perfect in the rest - even where the first diverges less in its
    // worst region than the second does in its best. What the README publishes
    // is the count - "N of M observed" - with the naming label kept alongside
    // for surfaces that name the regions.
    //
    // alpha matches us-east-1 alone (it beats the eu-west-2 baseline).
    const alpha = rows.find((r) => r.target === 'alpha')
    expect(alpha).toMatchObject({
      grade: 'A+',
      total: '100.0%',
      divergence: '0.0%',
      coverage: '100.0%',
      cohort: '1 of 2',
      cohortLabel: 'us-east-1',
      passed: 3,
      failed: 0,
    })
    // beta fails the split test everywhere (a fail without an observation is
    // evidence of nothing beyond "not the pinned answer"), so it ties across
    // every region: a full count, earned by being indistinguishable rather
    // than by being right.
    // Diverging on a third of the suite lands in the D band however much of
    // it the target covers - the grade restates divergence, coverage can only
    // cap it further.
    const beta = rows.find((r) => r.target === 'beta')
    expect(beta).toMatchObject({
      grade: 'D',
      total: '66.7%',
      divergence: '33.3%',
      cohort: '2 of 2',
      cohortLabel: 'all regions',
      passed: 2,
      failed: 1,
    })
  })

  it('orders by divergence ascending, so a narrow but correct target is not ranked below a broad wrong one', () => {
    // beta diverges on a third of the suite; alpha on none of it. Coverage
    // breaks ties, and neither figure is folded into the other.
    const order = rows.map((r) => r.target)
    expect(order.indexOf('alpha')).toBeLessThan(order.indexOf('beta'))
  })

  it('counts the observed regions in the caption rather than naming every one', () => {
    // Naming all of them was most of the caption's length, and the set is in
    // registry/regions.json. The exceptions are still named - the unresolved
    // and dropped cases above assert exactly that - because a name earns its
    // space where it marks something out.
    const caption = tableCaption(summary.regions)
    expect(caption).toContain('each of the 2 observed regions')
    expect(caption).not.toContain('`eu-west-2`, `us-east-1`')
  })

  it('states the known defect in the Regions column rather than publishing it bare', () => {
    expect(tableCaption(summary.regions)).toMatch(/over-credits.*issues\/138/s)
  })

  it('dates the table from the newest row, and only carried rows carry a date', () => {
    // Repeating one date down every row hid the rows worth spotting. The
    // caption states the run's date; a row that shows one is carried from an
    // earlier run.
    const carried = [{ runDate: '2026-08-12' }, { runDate: '2026-07-24' }, { runDate: '-' }]
    expect(tableDateOf(carried)).toBe('2026-08-12')
    expect(tableDateOf([{ runDate: '-' }])).toBe(null)

    // Every row here was measured in the same run, so there is no exception for
    // the column to carry and it is not rendered at all. An empty column under a
    // header promising dates is worse than no column: it reads as data missing
    // rather than as nothing to report. The caption still dates the table, and
    // drops the clause pointing at a column that is no longer there.
    const table = renderTable(summary)
    // No identity on this fixture, so the line falls back to the bare date;
    // health is dated separately because it can move without a re-measure.
    expect(table).toContain('_Measured 2026-07-06. Region health as of 2026-07-06._')
    expect(table).not.toContain('except where a row carries its own date')
    expect(table).not.toContain('| Measured |')
    // No row ends on an empty cell, which is what the dropped column left behind.
    for (const line of table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Target'))) {
      expect(line.endsWith('|  |'), line).toBe(false)
    }
  })

  it('brings the Measured column back for the first row carried forward', () => {
    const carried = buildSummary(
      Object.entries(docs).map(([slug, doc]) =>
        target(slug, doc, slug === 'beta' ? { runDate: '2026-07-01' } : {}),
      ),
      { registry: REGISTRY, health: HEALTHY, suiteTests: testIdentities(suiteDoc('passed')) },
    )
    const table = renderTable(carried)
    expect(table).toContain(
      '_Measured 2026-07-06, except where a row carries its own date. Region health as of 2026-07-06._',
    )
    expect(table).toContain('| Regions | Measured |')
    // And only the carried row restates a date; the rest leave the cell empty.
    const dated = table.split('\n').filter((l) => /\| 2026-07-01 \|$/.test(l))
    expect(dated).toHaveLength(1)
    expect(dated[0]).toContain('beta')
  })

  it('orders the columns identity, headline, counts, tiers, then evidence', () => {
    expect(renderTable(summary)).toContain(
      '| Target | Grade | Version | Divergence | Coverage | Fail | Skip | Tier 1 | Tier 2 | Tier 3 | Regions |',
    )
  })

  it('badge and table cannot disagree: every grade equals the badge letter', () => {
    // Both surfaces are rendered from the one shared headline (scoreTarget),
    // the shared axes (axesOf) and the shared grading (gradeOf), so the
    // invariant is structural; this pins it against a future caller
    // reintroducing its own scoring.
    const context = { registry: REGISTRY, observed: summary.regions.observed }
    for (const slug of Object.keys(summary.targets)) {
      const badge = buildBadge(slug, docs[slug], context)
      const row = rows.find((r) => r.target === label(slug))
      expect(row.grade).toBe(badge === null ? '-' : badge.message)
    }
  })

  it('a badge is deleted when its target stops being gradeable', () => {
    // Third parties embed these in their own READMEs, so a badge left behind
    // after its results file goes serves a letter about someone else from a
    // URL they do not control. The freshness test spots the drift; only the
    // delete fixes it.
    const dir = mkdtempSync(join(tmpdir(), 'badges-'))
    const context = { registry: REGISTRY, observed: ['eu-west-2', 'us-east-1'] }
    writeFileSync(join(dir, 'alpha.json'), JSON.stringify(suiteDoc('passed')))
    writeFileSync(join(dir, 'departed.badge.json'), '{"message":"A"}\n')

    const { written, pruned } = writeBadges(dir, context, FIXTURE_SUITE)

    expect(written).toBe(1)
    expect(pruned).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['alpha.badge.json', 'alpha.json'])
  })

  it('leaves the badge of a target that is still gradeable alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'badges-'))
    const context = { registry: REGISTRY, observed: ['eu-west-2', 'us-east-1'] }
    writeFileSync(join(dir, 'alpha.json'), JSON.stringify(suiteDoc('passed')))
    writeFileSync(join(dir, 'alpha.badge.json'), '{"message":"stale"}\n')

    const { pruned } = writeBadges(dir, context, FIXTURE_SUITE)

    expect(pruned).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'alpha.badge.json'), 'utf8')).message).not.toBe('stale')
  })
})

describe('tableRows tie-break', () => {
  // A target scoring identically to the engine it is a variant of must sort
  // below it, never above. The two Dynoxide rows are the live case: a partial
  // wasm preview can tie native on the surface it implements, and the table
  // must not read as the preview outranking the engine.
  const tied = (rate) => ({
    headline: { region: 'eu-west-2', rate },
    regions: {
      'eu-west-2': {
        rate,
        passed: 785,
        failed: 0,
        skipped: 10,
        indeterminate: 0,
        count: 795,
        tiers: {
          tier1: { p: 1, f: 0, s: 0, i: 0 },
          tier2: { p: 1, f: 0, s: 0, i: 0 },
          tier3: { p: 1, f: 0, s: 0, i: 0 },
        },
      },
    },
    version: '-',
    runDate: '2026-07-24',
  })

  // The tier columns sit beside a headline that is divergence and a sort that
  // runs on divergence. Left as correctness they read in the opposite
  // direction, so a target improving down the Divergence column climbs up the
  // tier ones.
  it('reports each tier as divergence over the whole tier, not correctness', () => {
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      targets: {
        alpha: {
          headline: { region: 'eu-west-2', rate: 90 },
          regions: {
            'eu-west-2': {
              rate: 90,
              passed: 9,
              failed: 1,
              skipped: 2,
              indeterminate: 0,
              count: 12,
              tiers: {
                // 1 of 4 fails: 25% divergence, where correctness over the two
                // attempted would have been 50%.
                tier1: { p: 1, f: 1, s: 2, i: 0 },
                tier2: { p: 4, f: 0, s: 0, i: 0 },
                tier3: { p: 4, f: 0, s: 0, i: 0 },
              },
            },
          },
          version: '-',
          runDate: '2026-07-29',
        },
      },
    }
    const alpha = tableRows(summary).find((r) => r.slug === 'alpha')
    expect(alpha.tier1).toBe('25.0%')
    expect(alpha.tier2).toBe('0.0%')
    expect(alpha.tier3).toBe('0.0%')
  })

  // The baseline diverges from itself nowhere, so its tier columns read 0.0%
  // rather than the 100% they read while the columns were correctness.
  it('renders the ground truth row as diverging nowhere in every tier', () => {
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '2026-07-29' },
      targets: {},
    }
    const gt = tableRows(summary).find((r) => r.slug === GROUND_TRUTH_SLUG)
    expect([gt.tier1, gt.tier2, gt.tier3]).toEqual(['0.0%', '0.0%', '0.0%'])
    expect(gt.divergence).toBe('0.0%')
  })

  it('nests a variant under its project instead of seating it as a rival', () => {
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      // wasm listed first, so a build that competed for its own place would
      // take the higher slot.
      targets: { 'dynoxide-wasm': tied(100), dynoxide: tied(100) },
    }
    const rows = tableRows(summary)
    // One row for the project, not two. A reader chooses between projects; the
    // build follows from where their code runs.
    expect(rows.map((r) => r.slug)).toEqual([GROUND_TRUTH_SLUG, 'dynoxide'])
    const dynoxide = rows.find((r) => r.slug === 'dynoxide')
    expect(dynoxide.variants.map((v) => v.slug)).toEqual(['dynoxide-wasm'])
  })

  it('keeps a variant scored, not merely mentioned', () => {
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      targets: { dynoxide: tied(100), 'dynoxide-wasm': tied(100) },
    }
    // Nesting must not cost a variant its own figures: a build that implements
    // less has to say so where it is read.
    const wasm = tableRows(summary).find((r) => r.slug === 'dynoxide').variants[0]
    expect(wasm.divergence).toBe('0.0%')
    expect(wasm.coverage).toBe('98.7%')
  })
})

describe('renderTable variant nesting', () => {
  // A build of a project is rendered beneath it, labelled by what makes it
  // distinct. Markdown has no nested tables, so the indent carries the
  // relationship - and it is derived from declared metadata rather than from a
  // bracket in the display name, which is what used to stand in for it.
  // `rate` is the headline pass rate; it does not feed divergence or coverage,
  // which come from the counts. A build that should read as different from its
  // parent therefore has to differ in `over`, not in `rate`.
  const one = (rate, over = {}) => ({
    headline: { region: 'eu-west-2', rate },
    regions: {
      'eu-west-2': {
        rate,
        passed: 785,
        failed: 0,
        skipped: 213,
        indeterminate: 0,
        count: 998,
        tiers: {
          tier1: { p: 1, f: 0, s: 0, i: 0 },
          tier2: { p: 1, f: 0, s: 0, i: 0 },
          tier3: { p: 1, f: 0, s: 0, i: 0 },
        },
        ...over,
      },
    },
    version: '-',
    runDate: over.runDate ?? '2026-07-24',
  })

  // A build that scores differently from its parent. Same suite size, so it is
  // the figures rather than the totals guard that earns it the row.
  const differing = (rate) => one(rate, { passed: 700, failed: 10, skipped: 288 })

  it('indents a variant under its project and labels it by configuration', () => {
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      regions: { observed: ['eu-west-2'], unresolved: [], dropped: [] },
      targets: { 'dynoxide-wasm': differing(100), dynoxide: one(96.3) },
    }
    const table = renderTable(summary)
    // Named by what distinguishes it, not by repeating the project name.
    expect(table).toContain('| ↳ WebAssembly / OPFS |')
    expect(table).not.toMatch(/\[Dynoxide \(wasm\)\]/)
    // The parent names the configuration its own figures were measured on, so
    // the row does not go ambiguous the moment a second one ships.
    expect(table).toMatch(/\[Dynoxide\]\([^)]+\) · self-contained binary/)
    // Directly beneath its project, not sorted away from it.
    const lines = table.split('\n').filter((l) => l.startsWith('|'))
    const parent = lines.findIndex((l) => l.includes('[Dynoxide]'))
    expect(lines[parent + 1]).toContain('↳ WebAssembly / OPFS')
  })

  it('adds no footnote when no variant row is present', () => {
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      regions: { observed: ['eu-west-2'], unresolved: [], dropped: [] },
      targets: { dynoxide: one(96.3) },
    }
    const table = renderTable(summary)
    expect(table).not.toContain('†')
    expect(table).not.toContain('preview')
  })

  it('gives a build that scored the same its own row, carrying its own figures', () => {
    // Markdown has no disclosure to put a matching build behind, so the table
    // shows it. A redundant row says both were measured and they agree; a row
    // naming a build whose figures it does not carry says something nobody
    // checked. Only one of those can be wrong.
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      regions: { observed: ['eu-west-2'], unresolved: [], dropped: [] },
      targets: { 'extenddb-sqlite': one(97.7), extenddb: one(97.7) },
    }
    const table = renderTable(summary)
    const lines = table.split('\n').filter((l) => l.startsWith('|'))
    const parent = lines.findIndex((l) => l.includes('[ExtendDB]'))
    // A nested row is labelled by its configuration alone, so it is found by
    // position rather than by the project name.
    expect(parent).toBeGreaterThan(-1)
    expect(lines[parent + 1]).toContain('↳ SQLite')
    // The parent names its own configuration, never the other build's.
    expect(table).toMatch(/\[ExtendDB\]\([^)]+\) · PostgreSQL \|/)
    expect(table).not.toContain('and SQLite')
  })

  it('renders every build of a project with three of them', () => {
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      regions: { observed: ['eu-west-2'], unresolved: [], dropped: [] },
      targets: { dynoxide: one(96.3), 'dynoxide-wasm': one(96.3), extenddb: one(97.7) },
    }
    const table = renderTable(summary)
    expect(table).toContain('↳ WebAssembly / OPFS')
    const nested = table.split('\n').filter((l) => l.includes('↳'))
    expect(nested).toHaveLength(1)
  })

  it('does not print a promoted build\u2019s configuration twice', () => {
    // With no result for the reference build, the grouping promotes a build to
    // stand for the project. Its display name already carries the
    // configuration, so appending it again read "ExtendDB (SQLite) · SQLite".
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      regions: { observed: ['eu-west-2'], unresolved: [], dropped: [] },
      targets: { 'extenddb-sqlite': one(97.7), dynoxide: one(96.3) },
    }
    const row = renderTable(summary).split('\n').find((l) => l.includes('ExtendDB'))

    expect(row).toContain('ExtendDB (SQLite)')
    expect(row).not.toContain('· SQLite')
  })

  it('gives a build carried from an earlier run its own row and its own date', () => {
    // Two builds measured weeks apart were never shown to agree, whatever their
    // percentages say. This table nests every build outright, so what matters
    // here is that the carried one states its own date rather than borrowing
    // the caption's.
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      regions: { observed: ['eu-west-2'], unresolved: [], dropped: [] },
      targets: {
        'extenddb-sqlite': one(97.7, { runDate: '2026-07-20' }),
        extenddb: one(97.7),
        dynoxide: one(96.3),
      },
    }
    const table = renderTable(summary)
    // The column, not the caption: the caption says "Measured <date>" on every
    // render, so asserting the bare word passed whether or not the column came
    // back. This is the header the column adds.
    expect(table).toContain('| Regions | Measured |')
    // Rendered as its own nested row, carrying its own date.
    const nested = table.split('\n').find((l) => l.includes('↳'))
    expect(nested).toContain('2026-07-20')
    // And the parent is not relabelled as though it spoke for both.
    const parent = table.split('\n').find((l) => l.includes('[ExtendDB]'))
    expect(parent).not.toContain('and SQLite')
  })

  it('gives a build one extra failure its own row, though both print the same divergence', () => {
    // 0 and 1 failures over 998 both round to a printed figure the other could
    // claim. Comparing counts rather than the printed figure is what stops the
    // row publishing the parent's fail count for a build that failed more.
    const summary = {
      groundTruth: { slug: GROUND_TRUTH_SLUG, runDate: '-' },
      regions: { observed: ['eu-west-2'], unresolved: [], dropped: [] },
      targets: {
        'extenddb-sqlite': one(97.7, { passed: 784, failed: 1, skipped: 213 }),
        extenddb: one(97.7),
      },
    }
    const table = renderTable(summary)
    expect(table).toContain('↳')
    const parent = table.split('\n').find((l) => l.includes('[ExtendDB]'))
    expect(parent).not.toContain('and SQLite')
  })

})

// ── The committed artefacts: freshness, no-drift, and the shape contract ────

describe('committed results pipeline', () => {
  const context = loadScoringContext()
  const files = readdirSync('results')
    .filter(isTargetResultFile)
    .map((f) => join('results', f))
  const targets = readTargets(files)
  // The committed board carries the identity of the run that measured it, and
  // was graded against the suite definition at that ref. Reproducing it means
  // using both: grading from the working tree instead would turn this test red
  // the first time main's manifest or registry moved past the measured ref,
  // reporting the board stale when it is exactly right.
  const { measured: committedMeasured, ...measuredInputs } = committedGradingInputs(SUMMARY_PATH)
  const fresh = buildSummary(targets, {
    ...context,
    registry: measuredInputs.registry,
    suiteTests: suiteIdentities(measuredInputs.manifest),
    measured: committedMeasured,
  })

  it('results/summary.json matches a fresh build (and a re-run is deterministic)', () => {
    const committed = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'))
    expect(committed, `${SUMMARY_PATH} is stale — run \`node scripts/summarise.mjs --write\``).toEqual(
      fresh,
    )
  })

  it('badge letter equals the summary headline grade for every target (the no-drift invariant)', () => {
    for (const [slug, t] of Object.entries(fresh.targets)) {
      const badge = JSON.parse(readFileSync(join('results', `${slug}.badge.json`), 'utf8'))
      const { divergence, coverage } = axesOf(t.regions[t.headline.region])
      const expected = gradeOf(divergence, coverage).letter
      expect(badge.message, `${slug} badge disagrees with the summary headline`).toBe(expected)
    }
    // And the table's Total column is rendered from the same headline.
    // Variants nest, so flatten before asserting: the invariant covers every
    // scored target, including the ones that are not their own row.
    const rows = tableRows(fresh).flatMap((r) => [r, ...(r.variants ?? [])])
    for (const [slug, t] of Object.entries(fresh.targets)) {
      const row = rows.find((r) => r.slug === slug)
      expect(row.total).toBe(t.headline.rate === null ? '-' : `${t.headline.rate.toFixed(1)}%`)
    }
  })

  it('every published results file covers the full suite - one denominator under every figure', () => {
    // Divergence, coverage, the cap and the A+ tripwire all divide by the
    // whole-suite count, and "the denominator never moves" is a published
    // claim. A partial run (a file-level crash, or a filtered capture) would
    // shrink one target's denominator, inflate its coverage past the cap and
    // sail through the tripwire vacuously - so full-suite coverage is
    // asserted, not assumed.
    //
    // Carried rows are in scope without a fixture of their own. Every file in
    // results/ is measured against the suite manifest, so a target that missed
    // a run while the suite grew keeps its old count and fails here, which is
    // the stale-denominator case: it would otherwise publish a letter earned
    // over a smaller suite and outrank a re-tested peer.
    //
    // This calls the publishing gate rather than restating it, so the assertion
    // and the thing that runs before every write cannot drift apart.
    //
    // Both of these divide by the manifest at the MEASURED ref, not the working
    // tree's. Main is expected to run ahead of the released suite now - that is
    // the whole point of the change - so grading the committed board against
    // whatever main currently defines would turn this file red on the first
    // test merged after a release. It would also deadlock: a red main fails the
    // release workflow's own green-checks precondition, and cutting a release
    // is the only thing that moves the measured ref forward again.
    const measuredSize = suiteSizeOf(measuredInputs.manifest)
    expect(() => assertOneDenominator(fresh, measuredSize)).not.toThrow()
    expect(measuredSize).toBe(
      Math.max(
        0,
        ...Object.values(fresh.targets).map((t) => t.regions[t.headline.region]?.count ?? 0),
      ),
    )
  })

  it('a zero-divergence headline stays honest across regions (the A+ tripwire)', () => {
    // Two facts hold today and the top grade leans on both, so they are
    // asserted rather than assumed.
    //
    // First, the identity: a target with zero fails in its headline region
    // may fail elsewhere only on the registry's confirmed splits - and that
    // is checked by name, not by count. A count match would hold just as
    // well for a target failing three unrelated tests while passing the
    // three splits; asserting the failing tests ARE the split tests turns
    // the target page's "only where real DynamoDB itself disagrees between
    // regions" from an inference into a checked fact. A breach here means a
    // non-split behaviour is varying by region - the scoring model changed
    // underneath the claim the methodology makes.
    //
    // Second, the tripwire: the letter survives the target's worst region. If
    // real DynamoDB's regions ever drift far enough apart that a target can be
    // perfect in one and grade lower in another, an unconditional A+ stops
    // being honest. This failing is the signal to revisit the criteria in the
    // open, under a bumped GRADING_VERSION, not to loosen the assertion.
    let guarded = 0
    for (const [slug, t] of Object.entries(fresh.targets)) {
      const headline = t.regions[t.headline.region];
      if (!headline || headline.count === 0) continue;
      if (axesOf(headline).divergence !== 0) continue;
      guarded++

      const target = targets.find((x) => x.slug === slug);
      const verdicts = classifyResults(target.raw, target.sidecar ?? null);
      for (const [region, r] of Object.entries(t.regions)) {
        const fails = verdictsForRegion(verdicts, measuredInputs.registry, region).filter(
          (v) => v.verdict === 'fail',
        );
        expect(fails.length, `${slug}'s scored fail count in ${region}`).toBe(r.failed);
        for (const f of fails) {
          expect(
            splitFor(measuredInputs.registry, f),
            `${slug} fails "${f.fullName}" in ${region}, and it is not one of the registry's confirmed splits - a non-split behaviour is varying by region`,
          ).toBeTruthy();
        }
      }

      // A note on the day this first fires. The comparison is the published
      // letter against the worst region's, so at full coverage it reads A+
      // versus A: the first target ever to earn A+ while any confirmed split
      // exists will fail this, and the trigger is the ordinary A+ case rather
      // than an anomaly. That is deliberate - an A+ that holds only in the
      // headline region is the claim this guard exists to question - but read
      // it as a prompt to revisit the criteria in the open, not as a defect in
      // the target that tripped it.
      // The tolerance is the row's own letter, not the A band. Three splits in
      // a thousand tests is 0.3% against 5%, so the band could not bind until
      // the registry grew seventeenfold. Comparing the letter the headline
      // publishes against the one its worst region earns binds from the first
      // split that would move it.
      const coverage = axesOf(headline).coverage;
      const worst = Math.max(
        ...Object.values(t.regions).map((r) => axesOf(r).divergence ?? 0),
      )
      expect(
        gradeOf(worst, coverage).letter,
        `${slug} publishes ${gradeOf(0, coverage).letter} from ${t.headline.region} but its worst region earns less - revisit the A+ criteria before publishing`,
      ).toBe(gradeOf(0, coverage).letter);
    }

    // The loop above only runs for a target at exactly zero headline
    // divergence, so without this the whole guard could go quiet on a sweep
    // where no target holds A+ - green, having checked nothing, with no signal
    // that its coverage had dropped to zero. If this ever fails it is not a
    // licence to delete it: it means nothing on the board currently exercises
    // the A+ claim. That became a real state on 2026-08-12, when the index
    // write-capacity tests (#124) took the last zero-divergence rows, so a
    // quiet pass here is the honest verdict rather than a fault. The tripwire
    // re-arms automatically the moment any row returns to zero divergence.
    if (guarded === 0) return
  })

  it('the ground truth earns its 100%: the real run scores 100% against its own region', () => {
    // Not an assumption: results/dynamodb.json is a real eu-west-2 run, and
    // scored against eu-west-2's recorded expectations it passes everything.
    // Self-agreement is what pins the row, so assert it from the data.
    const dynamodb = targets.find((t) => t.slug === GROUND_TRUTH_SLUG)
    const scored = scoreTarget(dynamodb.raw, dynamodb.sidecar, context)
    const own = scored.regions['eu-west-2']
    expect(own.failed).toBe(0)
    expect(own.passed).toBeGreaterThan(0)
  })

  it('leaves every results/*.json byte-identical: summary.json is additive', () => {
    // The per-target files are a de facto public contract (the site reads
    // them, and joins results/tag-manifest.json on file path + top-level
    // describe). The whole pipeline - read, score, render, write the summary -
    // must never rewrite them, or the site's current reader and its tag lens
    // would break silently.
    const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
    const before = Object.fromEntries(files.map((f) => [f, hash(f)]))

    const read = readTargets(files)
    // A publishable identity and the manifest it was measured against: both
    // guards refuse without them, and this test is about what the pipeline
    // writes, not about the guards.
    const measured = { ...committedMeasured, kind: 'tag', ref: 'v3.1.0' }
    const summary = buildSummary(read, { ...context, measured })
    renderTable(summary)
    writeSummaryFile(summary, read, join(mkdtempSync(join(tmpdir(), 'summarise-')), 'summary.json'), {
      manifest: measuredInputs.manifest,
    })

    for (const f of files) {
      expect(hash(f), `${f} was modified by the results pipeline`).toBe(before[f])
    }
  })
})

describe('readTargets', () => {
  it('pairs sidecars and versions, and skips reserved and companion files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'targets-'))
    const doc = suiteDoc('passed')
    writeFileSync(join(dir, 'alpha.json'), JSON.stringify(doc))
    writeFileSync(join(dir, 'alpha.version'), '9.9.9\n')
    writeFileSync(
      join(dir, 'alpha.indeterminate.json'),
      JSON.stringify({ target: 'alpha', runLevel: [{ reason: 'table-active-timeout' }] }),
    )
    writeFileSync(join(dir, 'alpha.badge.json'), JSON.stringify({ schemaVersion: 1 }))
    writeFileSync(join(dir, 'local.json'), JSON.stringify(doc))
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ schemaVersion: 1 }))

    const targets = readTargets(readdirSync(dir).map((f) => join(dir, f)))
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      slug: 'alpha',
      version: '9.9.9',
      runDate: '2026-07-06',
      sidecar: { runLevel: [{ reason: 'table-active-timeout' }] },
    })
  })
})

// The surface the site workspace imports. It used to keep its own copies of
// these maps and they drifted, so the site now imports them from here and the
// two can only disagree if one of these exports goes missing or changes shape.
// A rename that looks harmless on this side breaks a build nobody ran, so the
// contract is pinned here rather than left to the site's own tests.
describe('the shared target surface', () => {
  it('exports the maps and helpers the site imports', () => {
    for (const [name, value] of [
      ['DISPLAY', DISPLAY],
      ['REPO', REPO],
    ]) {
      expect(value, `${name} must stay exported`).toBeTypeOf('object')
      expect(Object.keys(value).length, `${name} must not be empty`).toBeGreaterThan(0)
    }
    for (const [name, fn] of [
      ['display', display],
      ['repoUrl', repoUrl],
      ['label', label],
    ]) {
      expect(fn, `${name} must stay exported`).toBeTypeOf('function')
    }
  })

  it('names and links every target it scores', () => {
    // Every slug the table can render must be nameable and linkable, so a
    // target added to one map and not the other is caught here rather than
    // showing up on the published board as a bare slug.
    for (const slug of Object.keys(DISPLAY)) {
      expect(display(slug), `${slug} needs a display name`).toBe(DISPLAY[slug])
      expect(repoUrl(slug), `${slug} needs a project URL`).toBeTruthy()
      expect(label(slug)).toBe(`[${DISPLAY[slug]}](${REPO[slug]})`)
    }
    expect(Object.keys(REPO).sort()).toEqual(Object.keys(DISPLAY).sort())
  })

  it('degrades predictably for a slug it has never seen', () => {
    // The site renders whatever the results directory contains, so an unknown
    // slug has to produce something printable rather than undefined.
    expect(display('some-new-thing')).toBe('some new thing')
    expect(repoUrl('some-new-thing')).toBeNull()
    expect(label('some-new-thing')).toBe('some new thing')
  })
})

describe('the publishing gate refuses a forged population', () => {
  // Every check here works on a copy of a real committed run, because the
  // attacks these guards exist to stop are edits to a results file, not
  // synthetic shapes. A fixture that only looks like a run would let the guard
  // pass on the fixture and fail on the thing.
  const genuine = () => JSON.parse(readFileSync('results/dynoxide.json', 'utf8'))
  // Every check here copies a real committed run, so the population it carries
  // is the one the board was measured against - the manifest at that ref, not
  // the working tree's, which main is expected to run ahead of.
  const measuredSuite = (() => {
    const { manifest } = committedGradingInputs(SUMMARY_PATH)
    return { identities: suiteIdentities(manifest), size: suiteSizeOf(manifest) }
  })()

  it('rejects a result counted twice, which keeps the total and lowers divergence', () => {
    // The cheapest forgery there is: drop a failing result, put a passing one
    // in its place. The file still reports 1054 results and still names only
    // tests the suite defines, so the count check and the stray check both
    // pass - the population is wrong only in its multiplicity.
    const raw = genuine()
    const file = raw.testResults.find((tr) => (tr.assertionResults?.length ?? 0) >= 2)
    file.assertionResults[1] = { ...file.assertionResults[0] }

    const before = testIdentities(genuine()).size
    expect(testIdentities(raw).size).toBe(before - 1)
    expect(
      raw.testResults.reduce((n, tr) => n + tr.assertionResults.length, 0),
      'the forgery must keep the total, or the count check would catch it first',
    ).toBe(measuredSuite.size)

    expect(() => assertMeasuredSuite([{ slug: 'dynoxide', raw }], measuredSuite.identities)).toThrow(
      /twice/,
    )
  })

  it('rejects a test the suite no longer defines', () => {
    const raw = genuine()
    raw.testResults[0].assertionResults[0].fullName = 'a test that was renamed away'
    expect(() => assertMeasuredSuite([{ slug: 'dynoxide', raw }], measuredSuite.identities)).toThrow(
      /no longer defines/,
    )
  })

  it('accepts the committed board, including the deliberately partial lanes', () => {
    // The repeat check runs on every target, so the ground-truth lanes - which
    // legitimately carry a handful of tests each - have to pass it.
    const files = readdirSync('results').filter(isTargetResultFile).map((f) => join('results', f))
    expect(() => assertMeasuredSuite(readTargets(files), measuredSuite.identities)).not.toThrow()
  })

  it('rejects a headline naming a region the row has no results for', () => {
    // Previously `?? 0` read this as a target that scored nothing and waved it
    // through, so a scorer bug could publish a row with no denominator at all.
    const summary = {
      targets: { dynoxide: { headline: { region: 'eu-west-2' }, regions: {} } },
    }
    expect(() => assertOneDenominator(summary)).toThrow(/no results for its headline region/)
  })

  it('leaves README.md untouched when the board is refused', () => {
    // The ordering is the point: the guards run before anything published is
    // written, so a refusal is a no-op rather than a half-published board.
    const dir = mkdtempSync(join(tmpdir(), 'publish-gate-'))
    const readme = join(dir, 'README.md')
    const original = '# Board\n\n<!-- results:start -->\nold table\n<!-- results:end -->\n'
    writeFileSync(readme, original)

    const summary = {
      targets: { dynoxide: { headline: { region: 'eu-west-2' }, regions: { 'eu-west-2': { count: 3 } } } },
    }
    expect(() => publish(summary, [], { readmePath: readme, summaryPath: join(dir, 's.json') })).toThrow()
    expect(readFileSync(readme, 'utf8')).toBe(original)
  })
})

describe('the table discloses a pinned baseline', () => {
  // The site's control strip says when the baseline row is carried rather than
  // measured. The README table rendered a pinned row and a fully measured one
  // identically - same 0.0% over the same coverage - so the one surface this
  // script generates was the one that did not disclose it.
  const regions = { observed: ['eu-west-2'], unresolved: [], dropped: [] }

  it('says so when a real-AWS pass has not reported', () => {
    const caption = tableCaption(regions, {
      suiteSize: 1054,
      testsObserved: 1036,
      missingLanes: ['integrations', 'gsi'],
    })
    expect(caption).toContain('pinned to its last clean measurement')
    expect(caption).toContain('1036 of 1054')
    expect(caption).toContain('the other 18 are carried')
    expect(caption).toContain('`integrations`, `gsi`')
  })

  it('stays quiet when every pass has reported', () => {
    const caption = tableCaption(regions, {
      suiteSize: 1054,
      testsObserved: 1054,
      missingLanes: [],
    })
    expect(caption).not.toContain('pinned')
  })

  it('stays quiet for a summary with no ground truth at all', () => {
    expect(tableCaption(regions)).not.toContain('pinned')
    expect(tableCaption(regions, null)).not.toContain('pinned')
  })
})

describe('buildSummary refuses the option name it used to take', () => {
  it('throws rather than silently grading against the working tree', () => {
    // The rename's own hazard: `suiteTests` defaults to the working tree's
    // manifest, so a caller left on the old key would be graded against main
    // while stamped with a tag, and nothing would say so. The CLI itself was
    // one such caller for the length of a single edit.
    expect(() =>
      buildSummary([], { registry: REGISTRY, health: HEALTHY, suite: new Set(['a::b']) }),
    ).toThrow(/no longer takes `suite`/)
  })
})

describe('the measurement a board carries', () => {
  const MEASURED = {
    ref: 'v3.1.0',
    kind: 'tag',
    commit: '9129f0fbfb6fb5ff01aadf5f9f957fa0bf1871ad',
    version: '3.1.0',
    region: 'eu-west-2',
    measuredAt: '2026-08-17T04:36:04Z',
  }

  it('stamps the identity it is given, without disturbing schemaVersion', () => {
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: HEALTHY,
      measured: MEASURED,
    })
    expect(summary.suite).toEqual(MEASURED)
    // The block is additive, which is what lets schemaVersion stay put.
    expect(summary.schemaVersion).toBe(SUMMARY_SCHEMA_VERSION)
  })

  it('omits the block rather than emitting nulls when nothing was supplied', () => {
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: HEALTHY,
    })
    expect('suite' in summary).toBe(false)
  })

  it('refuses a half-written identity rather than stamping it', () => {
    expect(() =>
      buildSummary([target('alpha', suiteDoc('passed'))], {
        registry: REGISTRY,
        health: HEALTHY,
        measured: { ref: 'v3.1.0', kind: 'tag' },
      }),
    ).toThrow(/incomplete/)
  })

  it('divides by the manifest it is handed, not the one on disk', () => {
    // The publishing job stands on main because it commits back, so the
    // manifest in its tree is main's rather than the measured suite's.
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: HEALTHY,
      suiteTests: new Set(['only::one::test']),
    })
    expect(summary.groundTruth.suiteSize).toBe(1)
  })
})

// A minimal valid registry carrying the row main retired, so a rebuild's read
// can be told apart from a working-tree read without needing tags in CI.
const RETIRED_ROW_REGISTRY = [
  {
    id: 'batch-get-item-empty-request-items-ordering',
    test: { file: 'tests/tier3/validation-ordering/batchOperations.test.ts', fullName: 'x y' },
    pinned: 'eu-west-2',
    firstObserved: '2026-08-08',
    lastRefreshed: '2026-08-12',
    regions: {
      'eu-west-2': { outcome: 'rejected', error: { name: 'ValidationException', message: 'a' } },
      'us-east-1': { outcome: 'rejected', error: { name: 'ValidationException', message: 'b' } },
    },
  },
]

describe('resolveMeasurement', () => {
  const board = (suite) => {
    const d = mkdtempSync(join(tmpdir(), 'summary-'))
    const p = join(d, 'summary.json')
    writeFileSync(p, JSON.stringify(suite === null ? { schemaVersion: 1 } : { schemaVersion: 1, suite }))
    return p
  }

  it('refuses when neither a measuring run nor a committed board supplies one', () => {
    expect(() => resolveMeasurement({ summaryPath: board(null) })).toThrow(
      /no measured suite identity/,
    )
  })

  it('refuses when the summary file does not exist at all', () => {
    expect(() =>
      resolveMeasurement({ summaryPath: join(mkdtempSync(join(tmpdir(), 'none-')), 'summary.json') }),
    ).toThrow(/no measured suite identity/)
  })

  it('carries a committed identity forward on a rebuild, reading its inputs at its commit', () => {
    const committed = {
      ref: 'v3.0.0',
      kind: 'tag',
      commit: 'cad170f7aff40b450fff1df7415532b19fae1c96',
      version: '3.0.0',
      region: 'eu-west-2',
      measuredAt: '2026-08-13T09:00:00Z',
    }
    // Injected rather than shelling out: CI checks out at depth 1 with no tags,
    // so a real `git show v3.0.0:...` here would pass locally and fail there.
    // The stub answers only for the recorded commit, which is the assertion.
    const asked = []
    const git = (spec) => {
      asked.push(spec)
      const [at, path] = spec.split(':')
      if (at !== committed.commit) throw new Error(`unexpected read at ${at}`)
      return path.endsWith('splits.json')
        ? JSON.stringify({ splits: RETIRED_ROW_REGISTRY })
        : JSON.stringify({ tests: ['a::b'] })
    }
    const out = resolveMeasurement({ summaryPath: board(committed), git })
    expect(out.rebuild).toBe(true)
    expect(out.measured).toEqual(committed)
    expect(asked.every((s) => s.startsWith(committed.commit))).toBe(true)
    // What it read is the measured suite's registry, which still carries the
    // validation-ordering row main has since retired.
    expect(out.registry.splits.map((r) => r.id)).toContain('batch-get-item-empty-request-items-ordering')
    expect(loadScoringContext().registry.splits.map((r) => r.id)).not.toContain(
      'batch-get-item-empty-request-items-ordering',
    )
  })
})

describe('the measured line', () => {
  const at = (over) => ({
    ref: 'v3.2.0',
    kind: 'tag',
    commit: '9aa0337b455ed4c0ccdf71d9e4e8bb306991d778',
    version: '3.2.0',
    region: 'eu-west-2',
    measuredAt: '2026-08-19T04:36:04Z',
    ...over,
  })

  it('names a tag as the release it is', () => {
    expect(measuredLabel(at({}), '2026-08-19')).toBe(
      'Suite v3.2.0, measured against real DynamoDB on 2026-08-19',
    )
  })

  it('refuses to call a commit on main a release, even though it reads a version', () => {
    // package.json at a commit past v3.1.0 still says 3.1.0. Printing "Suite
    // v3.1.0" there would name a release this board is not.
    const label = measuredLabel(at({ kind: 'sha', ref: '9aa0337b455e', version: '3.1.0' }), '2026-08-17')
    expect(label).toContain('(unreleased)')
    expect(label).toContain('9aa0337b')
    expect(label).not.toContain('v3.1.0')
  })

  it('falls back to the bare date for a board carrying no identity', () => {
    expect(measuredLabel(null, '2026-08-19')).toBe('Measured 2026-08-19')
  })

  it('dates region health from the most recently resolved region', () => {
    const regions = {
      detail: {
        'eu-west-2': { lastResolved: '2026-08-15' },
        'us-east-1': { lastResolved: '2026-08-22' },
      },
    }
    expect(healthLabel(regions)).toBe(' Region health as of 2026-08-22.')
  })

  it('dates health from the observed set, not from a region that was dropped', () => {
    // A dropped region stays in `detail` carrying the date it stopped
    // answering, and that date can be newer than anything still scored. Dating
    // the line from it would report health the board does not use. The
    // scoping exists for this and nothing covered it, so a regression that
    // collapsed it back to every entry would have passed every test here.
    const regions = {
      observed: ['eu-west-2', 'us-east-1'],
      detail: {
        'eu-west-2': { lastResolved: '2026-08-15' },
        'us-east-1': { lastResolved: '2026-08-16' },
        'ap-south-2': { lastResolved: '2026-08-17' },
      },
    }
    expect(healthLabel(regions)).toBe(' Region health as of 2026-08-16.')
  })

  it('says nothing about health when no region has resolved', () => {
    expect(healthLabel({ detail: {} })).toBe('')
    expect(healthLabel(undefined)).toBe('')
  })
})

describe('what may be published', () => {
  const tagged = {
    ref: 'v3.2.0',
    kind: 'tag',
    commit: 'abc1234',
    version: '3.2.0',
    region: 'eu-west-2',
    measuredAt: '2026-08-19T04:00:00Z',
  }

  it('publishes a board measured at a release tag', () => {
    expect(() => assertPublishableMeasurement(tagged)).not.toThrow()
  })

  it('refuses a board measured at a pushed sha', () => {
    // A push validates the tests as they land. Publishing it would move every
    // target's denominator with no dated changelog entry behind it.
    expect(() => assertPublishableMeasurement({ ...tagged, kind: 'sha' })).toThrow(/Only a release tag/)
  })

  it('refuses a board measured at a ref git would not confirm as a tag', () => {
    expect(() => assertPublishableMeasurement({ ...tagged, kind: 'other' })).toThrow(/Only a release tag/)
  })

  it('refuses a board carrying no measurement at all', () => {
    expect(() => assertPublishableMeasurement(undefined)).toThrow(/Only a release tag/)
  })

  it('refuses to grade against the working tree when no manifest is supplied', () => {
    // `manifest && suiteSizeOf(manifest)` used to hand undefined to a parameter
    // whose own default reads registry/suite-manifest.json from disk, restoring
    // the fallback this whole mechanism exists to remove.
    expect(() => assertMeasuredManifest(undefined)).toThrow(/no suite manifest from the measured ref/)
    expect(() => assertMeasuredManifest({})).toThrow(/no suite manifest from the measured ref/)
  })

  it('accepts a manifest that came from the measurement', () => {
    expect(() => assertMeasuredManifest({ tests: ['a'] })).not.toThrow()
  })
})
