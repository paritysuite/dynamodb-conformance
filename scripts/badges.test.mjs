import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBadge, colour, gradeFor } from './badges.mjs'
import { BASELINE_GRADE } from './lib/grade.mjs'
import { isTargetResultFile, loadScoringContext } from './lib/score.mjs'
import { gradingInputsAtRef, measuredOf } from './lib/measured.mjs'

const RESULTS_DIR = 'results'

// A split-free scoring context: with no registry rows, per-region scoring is
// the identity, so one region is enough for the plain-grade tests.
const CONTEXT = { registry: { splits: [] }, observed: ['eu-west-2'] }

// Minimal Vitest-shaped result with the given tier 1 passed/failed/skipped
// counts. Skips widen the suite without being implemented, which is how a
// coverage cap is reached.
function result(passed, failed, skipped = 0) {
  const fill = (status, n) => Array.from({ length: n }, () => ({ status }))
  return {
    testResults: [
      {
        name: '/repo/tests/tier1/x.test.ts',
        assertionResults: [
          ...fill('passed', passed),
          ...fill('failed', failed),
          ...fill('skipped', skipped),
        ],
      },
    ],
  }
}

describe('colour', () => {
  it.each([
    ['A+', 'brightgreen'],
    ['A', 'green'],
    ['B', 'yellow'],
    ['C', 'orange'],
    ['D', 'red'],
    ['F', 'red'],
    [null, 'lightgrey'],
  ])('%s -> %s', (letter, expected) => {
    expect(colour(letter)).toBe(expected)
  })
})

describe('gradeFor', () => {
  it('gives the ground truth the baseline label, not a letter', () => {
    // The yardstick is not graded against itself. It reads the shared
    // BASELINE_GRADE rather than a locally-derived gradeOf(0, 100), so the
    // badge cannot say A+ while the results table and the site decline to
    // grade the same row. The badge was still saying A+ after the site had
    // stopped, which is the drift this pins.
    expect(gradeFor('dynamodb', {}, CONTEXT)).toEqual(BASELINE_GRADE)
    expect(gradeFor('dynamodb', {}, CONTEXT).letter).toBeNull()
  })

  it('returns null for a non-result file', () => {
    expect(gradeFor('tag-manifest', { schema: 1 }, CONTEXT)).toBeNull()
  })

  it('returns null for the reserved scratch and summary slugs', () => {
    // Real, well-formed run output - excluded by slug, not by structure.
    expect(gradeFor('local', result(5, 0), CONTEXT)).toBeNull()
    expect(gradeFor('summary', result(5, 0), CONTEXT)).toBeNull()
  })

  it('grades a real target from the two published axes', () => {
    // 1 fail over 3 tests is 33.3% divergence: the D band, whatever the
    // coverage - the same letter the results table publishes for the row.
    expect(gradeFor('dynoxide', result(2, 1), CONTEXT)).toMatchObject({ letter: 'D' })
    expect(gradeFor('dynoxide', result(3, 0), CONTEXT)).toMatchObject({ letter: 'A+' })
  })

  it('a target that implemented nothing is not scored, not given a letter', () => {
    // All skips: coverage exists as a denominator but divergence is null, so
    // there is no letter to badge. The grade is the unscored shape the
    // summary carries for the same row, and the badge says so.
    expect(gradeFor('dynoxide', result(0, 0, 5), CONTEXT)).toMatchObject({
      letter: null,
      qualifier: 'not scored',
    })
    expect(buildBadge('dynoxide', result(0, 0, 5), CONTEXT)).toMatchObject({ message: 'not scored' })
  })

  it('lowers the grade on a narrow surface', () => {
    // A clean pass over 3 of 10 tests is zero divergence at 30% coverage. A
    // third of the 70 points it declines joins its divergence, so it grades C.
    expect(gradeFor('dynoxide', result(3, 0, 7), CONTEXT)).toMatchObject({
      letter: 'C',
      capped: true,
      capAt: 'C',
    })
  })

  it('takes the headline: the best observed region, not the pinned one', () => {
    // The committed assertion encodes us-east-1's answer for the one split
    // test, so a target passing it diverges nowhere against us-east-1 and
    // does diverge against eu-west-2; the badge grades the best of them.
    const context = {
      registry: {
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
      },
      observed: ['eu-west-2', 'us-east-1'],
    }
    const raw = {
      testResults: [
        { name: '/repo/tests/tier1/a.test.ts', assertionResults: [{ status: 'passed' }] },
        {
          name: '/repo/tests/tier3/split.test.ts',
          assertionResults: [{ fullName: 'suite splits', status: 'passed' }],
        },
      ],
    }
    expect(gradeFor('dynoxide', raw, context)).toMatchObject({ letter: 'A+' })
  })

  it('does not grade a run that recorded a failed observation', () => {
    // A partial run is not graded. Counting the indeterminate against coverage
    // let a timeout cost the target its letter; excluding it from the
    // denominator was worse, because divergence then fell further than
    // coverage, so converting a fail into an indeterminate beat withdrawing
    // it - and a target can induce one by answering 503. Neither figure is
    // published, and the board carries the last clean measurement.
    const raw = result(30, 0)
    raw.testResults[0].assertionResults.push({
      status: 'failed',
      meta: { indeterminate: { reason: 'gsi-consistency-timeout', at: 'test' } },
    })
    // Same answer as the run-level sidecar below: not scored, rather than a
    // letter derived from a run that did not observe the whole suite.
    expect(gradeFor('dynoxide', raw, CONTEXT)).toMatchObject({ letter: null, qualifier: 'not scored' })
  })

  it('a run-level sidecar empties the grade rather than failing the target', () => {
    const sidecar = { runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning' }] }
    expect(gradeFor('dynoxide', result(5, 0), { ...CONTEXT, sidecar })).toMatchObject({
      letter: null,
      qualifier: 'not scored',
    })
  })
})

describe('buildBadge', () => {
  it('returns null when there is nothing to show', () => {
    expect(buildBadge('tag-manifest', { schema: 1 }, CONTEXT)).toBeNull()
  })

  it('returns null for the reserved local scratch slug', () => {
    expect(buildBadge('local', result(5, 0), CONTEXT)).toBeNull()
  })

  it('emits the shields endpoint shape for the ground truth', () => {
    // A letterless row still emits a badge - the endpoint URL is a published
    // contract and dropping the file would 404 anything pointing at it - but it
    // says what the row is rather than inventing a grade for it, and takes the
    // neutral colour because there is no band to colour by.
    expect(buildBadge('dynamodb', {}, CONTEXT)).toEqual({
      schemaVersion: 1,
      label: 'parity',
      message: 'baseline',
      color: 'lightgrey',
    })
  })

  it('badges a run that is not scored as not scored, in the neutral colour', () => {
    // One indeterminate and the run is not scored. The badge still publishes,
    // because a results file exists and the URL may already sit in someone's
    // README, but it says what the row says rather than keeping a letter the
    // latest run does not support.
    const raw = result(30, 0)
    raw.testResults[0].assertionResults.push({
      status: 'failed',
      meta: { indeterminate: { reason: 'transport', at: 'test' } },
    })
    const notScored = {
      schemaVersion: 1,
      label: 'parity',
      message: 'not scored',
      color: 'lightgrey',
    }
    expect(buildBadge('alpha', raw, CONTEXT)).toEqual(notScored)
    const sidecar = { runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning' }] }
    expect(buildBadge('alpha', result(5, 0), { ...CONTEXT, sidecar })).toEqual(notScored)
  })

  it('badges the letter, coloured by its band', () => {
    // 197/199 with 2 fails is ~1% divergence: an A, green - the letter and
    // colour move together because both derive from the one grade.
    expect(buildBadge('dynoxide', result(197, 2), CONTEXT)).toEqual({
      schemaVersion: 1,
      label: 'parity',
      message: 'A',
      color: 'green',
    })
  })
})

describe('committed badges are fresh', () => {
  // The same committed inputs the CLI writer uses: the observed region set from
  // the working tree, plus each run's indeterminate sidecar if present - and the
  // split registry at the ref the board was measured from, not the tree's.
  // Grading from the tree instead would report every badge stale the first time
  // a split row was admitted to main after a release, when the committed badges
  // are exactly right.
  const measured = measuredOf(JSON.parse(readFileSync(join(RESULTS_DIR, 'summary.json'), 'utf8')))
  const context = { ...loadScoringContext(), registry: gradingInputsAtRef(measured).registry }
  // The shared predicate, not a hand-rolled filter. Spelling it out here caught
  // summary.json and tag-manifest.json, which are companions rather than runs
  // and only ever asserted that they had no badge, and results/local.json,
  // which is the gitignored scratch slug - so the case count moved depending on
  // whether the person running the tests had run the suite locally.
  const resultFiles = readdirSync(RESULTS_DIR).filter(isTargetResultFile)

  it.each(resultFiles)('%s matches a fresh build', (file) => {
    const slug = file.replace(/\.json$/, '')
    const raw = JSON.parse(readFileSync(join(RESULTS_DIR, file), 'utf8'))
    const sidecarPath = join(RESULTS_DIR, `${slug}.indeterminate.json`)
    const sidecar = existsSync(sidecarPath)
      ? JSON.parse(readFileSync(sidecarPath, 'utf8'))
      : null
    const expected = buildBadge(slug, raw, { ...context, sidecar })
    const badgePath = join(RESULTS_DIR, `${slug}.badge.json`)

    // Every target result file has a target to badge, scored or not.
    expect(expected, `${slug} produced no badge`).not.toBeNull()
    expect(
      existsSync(badgePath),
      `${slug}.badge.json missing — run \`npm run results:badges\``,
    ).toBe(true)
    const committed = JSON.parse(readFileSync(badgePath, 'utf8'))
    expect(committed, `${slug}.badge.json is stale — run \`npm run results:badges\``).toEqual(
      expected,
    )
  })
})
