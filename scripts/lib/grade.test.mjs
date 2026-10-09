import { axesOf } from './score.mjs'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_GRADE,
  BASELINE_LABEL,
  A_PLUS,
  COVERAGE_DIVISOR,
  GRADE_BANDS,
  GRADING_VERSION,
  compareGrades,
  gradeOf,
} from './grade.mjs'

describe('gradeOf', () => {
  it('grades zero divergence at full coverage A+', () => {
    expect(gradeOf(0, 100)).toEqual({
      letter: 'A+',
      qualifier: 'no divergence',
      band: 'pass',
      capped: false,
      capAt: null,
    })
    // Both halves are exact. A divergence that rounds to 0.0% is not zero, and
    // a target one test short of the suite does not print 100.0% coverage.
    expect(gradeOf(0.04, 100).letter).toBe('A')
    expect(gradeOf(0, 99.9)).toMatchObject({ letter: 'A', capped: true })
  })

  it('letters follow the published divergence bands at full coverage', () => {
    expect(gradeOf(1.8, 100).letter).toBe('A')
    expect(gradeOf(4.9, 100).letter).toBe('A')
    expect(gradeOf(5, 100).letter).toBe('B')
    expect(gradeOf(14.9, 100).letter).toBe('B')
    expect(gradeOf(15, 100).letter).toBe('C')
    expect(gradeOf(24.9, 100).letter).toBe('C')
    expect(gradeOf(25, 100).letter).toBe('D')
    expect(gradeOf(34.9, 100).letter).toBe('D')
    expect(gradeOf(35, 100).letter).toBe('F')
  })

  it('coverage lowers a letter in proportion to what is left unimplemented', () => {
    // A third of the unimplemented share joins divergence before banding, so
    // the cost rises smoothly rather than at three thresholds.
    expect(gradeOf(0, 78.7)).toEqual({
      letter: 'B',
      qualifier: 'no divergence',
      band: 'partial',
      capped: true,
      capAt: 'B',
    })
    expect(gradeOf(1, 65)).toMatchObject({ letter: 'B', capped: true, capAt: 'B' })
    expect(gradeOf(1, 45)).toMatchObject({ letter: 'C', capped: true, capAt: 'C' })
    expect(gradeOf(0, 1)).toMatchObject({ letter: 'D', capped: true, capAt: 'D' })
  })

  it('coverage never raises a letter', () => {
    // effective is never below divergence, so a target can only be moved down
    // the scale by what it declines.
    for (const divergence of [0, 1.8, 12.3, 20.9, 30, 40]) {
      for (const coverage of [100, 99.2, 91.3, 80, 65, 45, 1]) {
        const full = gradeOf(divergence, 100)
        const partial = gradeOf(divergence, coverage)
        const order = ['A+', 'A', 'B', 'C', 'D', 'F']
        expect(
          order.indexOf(partial.letter),
          `${divergence}% divergence at ${coverage}% coverage`,
        ).toBeGreaterThanOrEqual(order.indexOf(full.letter))
      }
    }
  })

  it('capAt is the ceiling coverage imposed, and null when coverage did nothing', () => {
    // Dynalite: divergence alone gives B, coverage takes it to C.
    expect(gradeOf(12.3, 80)).toMatchObject({ letter: 'C', capped: true, capAt: 'C' })
    // LocalStack: graded on its divergence, coverage costs it nothing.
    expect(gradeOf(15.6, 99.2)).toMatchObject({ letter: 'C', capped: false, capAt: null })
    // Full coverage can never report a ceiling.
    expect(gradeOf(12.3, 100)).toMatchObject({ letter: 'B', capped: false, capAt: null })
    expect(gradeOf(40, 100)).toMatchObject({ letter: 'F', capped: false, capAt: null })
  })

  it('qualifiers name the divergence band in plain language', () => {
    // The qualifier reads divergence, not the effective figure: it describes
    // how much the target gets wrong, which coverage does not change.
    expect(gradeOf(1.8, 100).qualifier).toBe('low divergence')
    expect(gradeOf(12.3, 100).qualifier).toBe('moderate divergence')
    expect(gradeOf(16.1, 100).qualifier).toBe('high divergence')
    expect(gradeOf(28, 100).qualifier).toBe('very high divergence')
    expect(gradeOf(40, 100).qualifier).toBe('severe divergence')
    expect(gradeOf(12.3, 80).qualifier).toBe('moderate divergence')
  })

  it('the baseline carries no letter, on every surface that reads one', () => {
    // Real DynamoDB is what a grade measures distance from, so it is not graded
    // against itself. The constant is shared rather than restated per surface:
    // the results table, the badges, the endpoints and the agent corpus each
    // used to derive their own, and the table was still publishing A+ after the
    // site had stopped.
    expect(BASELINE_LABEL).toBe('baseline')
    expect(BASELINE_GRADE).toEqual({
      letter: null,
      qualifier: 'baseline',
      band: 'none',
      capped: false,
      capAt: null,
    })
    // It reuses the null-letter shape a consumer already handles for a target
    // that scored nothing, distinguished by the qualifier rather than by a
    // letter they would have to special-case.
    expect(BASELINE_GRADE.letter).toBe(gradeOf(null, null).letter)
    expect(BASELINE_GRADE.qualifier).not.toBe(gradeOf(null, null).qualifier)
  })

  it('nothing scored grades nothing', () => {
    expect(gradeOf(null, null)).toEqual({
      letter: null,
      qualifier: 'not scored',
      band: 'none',
      capped: false,
      capAt: null,
    })
    expect(gradeOf(null, 100).letter).toBe(null)
    expect(gradeOf(0, null).letter).toBe(null)
  })

  it('letters agree with the printed one-decimal figures at every boundary sliver', () => {
    // 4.96% prints "5.0%", so the letter must be the B a printed 5.0 demands,
    // not the A that raw-value banding would give.
    expect(gradeOf(4.96, 100).letter).toBe('B')
    expect(gradeOf(4.94, 100).letter).toBe('A')
    expect(gradeOf(1, 89.98)).toMatchObject({ letter: 'A', capped: false })
    // A divergence that merely rounds to 0.0% is still not zero: the letter
    // is A, never A+ - the top grade reads the raw count alone.
    expect(gradeOf(0.04, 100).letter).toBe('A')
    expect(gradeOf(0.04, 100).qualifier).toBe('low divergence')
  })

  it('a malformed input grades nothing, never F', () => {
    // NaN falls through every band bound (NaN comparisons are all false), so
    // without the finite guard a data fault would publish the worst letter.
    expect(gradeOf(NaN, 100).letter).toBe(null)
    expect(gradeOf(0, NaN).letter).toBe(null)
    expect(gradeOf(Infinity, 100).letter).toBe(null)
  })

  it('band colours restate the published colour boundaries', () => {
    expect(gradeOf(0, 100).band).toBe('pass')
    expect(gradeOf(4.9, 100).band).toBe('pass')
    expect(gradeOf(5, 100).band).toBe('partial')
    expect(gradeOf(24.9, 100).band).toBe('partial')
    expect(gradeOf(25, 100).band).toBe('fail')
  })

  it('pins the criteria the published grades were computed under', () => {
    // A threshold change moves grades on targets that changed nothing, so the
    // criteria are versioned: retuning bands or caps must bump the version and
    // date the change in the methodology.
    //
    // The criteria are keyed BY version rather than asserted as bare literals.
    // A bare literal is updated in place by whoever changed the threshold - the
    // test goes green and the version never moves, which is the exact failure
    // the versioning exists to prevent, and it would be silent. Keyed this way,
    // changing a band with no matching entry fails with the instruction rather
    // than passing after a one-line edit. Old versions stay listed: they are the
    // record of what published grades were computed under, and the methodology's
    // dated criteria section is the prose half of the same record.
    const CRITERIA_BY_VERSION = {
      1: {
        bands: [
          { letter: 'A', under: 5 },
          { letter: 'B', under: 15 },
          { letter: 'C', under: 25 },
          { letter: 'D', under: 35 },
        ],
        divisor: 3,
        aPlus: { divergence: 0, coverage: 100 },
      },
    }

    const criteria = CRITERIA_BY_VERSION[GRADING_VERSION]
    expect(
      criteria,
      `GRADING_VERSION is ${GRADING_VERSION} with no criteria recorded for it. Add the new bands and divisor to CRITERIA_BY_VERSION and date the change in the methodology's grading criteria section.`,
    ).toBeDefined()

    expect(
      GRADE_BANDS,
      `the divergence bands changed without bumping GRADING_VERSION (still ${GRADING_VERSION}). A retune regrades targets whose results never moved, so bump the version and date it in the methodology.`,
    ).toEqual(criteria.bands)

    expect(
      COVERAGE_DIVISOR,
      `the coverage divisor changed without bumping GRADING_VERSION (still ${GRADING_VERSION}). Bump the version and date it in the methodology.`,
    ).toBe(criteria.divisor)

    // The A+ gate is a rule rather than a table, so it is asserted
    // behaviourally: zero on both axes earns it, and anything that merely
    // rounds to the boundary does not.
    expect(A_PLUS.divergence).toBe(criteria.aPlus.divergence)
    expect(A_PLUS.coverage).toBe(criteria.aPlus.coverage)
    expect(gradeOf(0, 100).letter).toBe('A+')
    expect(gradeOf(0.04, 100).letter).toBe('A')
    expect(gradeOf(0, 99.99).letter).toBe('A')
  })

  it('the board matches the criteria, row by row', () => {
    // The published board, each row as of its own run. A letter here moving
    // without a figure moving means the criteria moved.
    const board = [
      ['dynoxide', 0.0, 98.6, 'A', true],
      ['dynoxide-wasm', 0.0, 86.7, 'A', true],
      ['extenddb', 2.0, 91.3, 'A', false],
      ['ministack', 11.2, 100.0, 'B', false],
      ['dynalite', 12.3, 80.0, 'C', true],
      ['localstack', 15.6, 99.2, 'C', false],
      ['dynamodb-local', 15.9, 97.9, 'C', false],
      ['floci', 20.8, 99.1, 'C', false],
    ]
    for (const [slug, divergence, coverage, letter, capped] of board) {
      const g = gradeOf(divergence, coverage)
      expect(g.letter, `${slug} letter`).toBe(letter)
      expect(g.capped, `${slug} capped`).toBe(capped)
      expect(g.capAt, `${slug} capAt`).toBe(capped ? letter : null)
    }
  })

  it('an unobserved test buys nothing, because a partial run is not scored', () => {
    // A target controls its own responses, and a 503 classifies as
    // indeterminate (src/indeterminate.ts). If an indeterminate were scored it
    // would be a second, cheaper lever than withdrawal: excluded from the
    // denominator, divergence falls further than coverage and the effective
    // figure drops; counted in it, an infrastructure fault moves the letter.
    // Neither figure publishes for such a run, so there is nothing to buy.
    const SUITE = 998
    const clean = axesOf({ passed: 834, failed: 156, count: SUITE })
    expect(gradeOf(clean.divergence, clean.coverage).letter).toBe('C')

    for (const k of [1, 7, 14, 60]) {
      const bought = axesOf({ passed: 834, failed: 156 - k, count: SUITE, indeterminate: k })
      expect(bought, `${k} converted`).toEqual({ divergence: null, coverage: null })
      expect(gradeOf(bought.divergence, bought.coverage).letter, `${k} converted`).toBeNull()
    }
  })

  it('prices a scope withdrawal, and the price is a measurement not a law', () => {
    // Withdrawing a failing test drops divergence and coverage by the same
    // amount, so the effective figure falls by (1 - 1/divisor) of it. The
    // target still gains; it pays more than it used to.
    //
    // The figure below is what today's board costs, not a property of the
    // criteria: a target far enough into F can still reach B by withdrawing
    // everything it fails. When a new target moves this number, re-derive it
    // and disclose the new one - never raise it to make the test pass.
    const SUITE = 998
    const CHEAPEST_BUY_TODAY = 14
    const ORDER = ['A+', 'A', 'B', 'C', 'D', 'F']
    const board = [
      ['dynoxide', 0, 14], ['dynoxide-wasm', 0, 133], ['extenddb', 20, 87],
      ['dynalite', 123, 200], ['localstack', 156, 8], ['dynamodb-local', 159, 21],
      ['ministack', 112, 0], ['floci', 208, 9],
    ]
    const gradeCounts = (failed, skipped) =>
      gradeOf((failed / SUITE) * 100, ((SUITE - skipped) / SUITE) * 100).letter

    let cheapest = Infinity
    for (const [, failed, skipped] of board) {
      const now = gradeCounts(failed, skipped)
      for (let k = 1; k <= failed; k++) {
        if (ORDER.indexOf(gradeCounts(failed - k, skipped + k)) < ORDER.indexOf(now)) {
          cheapest = Math.min(cheapest, k)
          break
        }
      }
    }
    expect(
      cheapest,
      'the cheapest letter a target can buy by declaring failing tests unsupported has moved. Re-derive the published figure rather than editing this one.',
    ).toBe(CHEAPEST_BUY_TODAY)

    // The worked example the methodology publishes.
    expect(gradeCounts(156 - 7, 8 + 7)).toBe('C')
    expect(gradeCounts(156 - 14, 8 + 14)).toBe('B')
  })
})

describe('compareGrades', () => {
  const row = (name, divergenceValue, coverageValue) => ({ name, divergenceValue, coverageValue })
  const order = (rows) => [...rows].sort(compareGrades).map((r) => r.name)

  it('seats a better letter first, even over a row diverging less', () => {
    // 1.8% over 78.9% coverage reads 8.8 effective, a B; 2.4% over 95.7% reads
    // 3.8, an A. Sorting on divergence alone put the B above the A.
    const capped = row('capped', 1.8, 78.9)
    const broad = row('broad', 2.4, 95.7)
    expect(gradeOf(capped.divergenceValue, capped.coverageValue).letter).toBe('B')
    expect(gradeOf(broad.divergenceValue, broad.coverageValue).letter).toBe('A')
    expect(order([capped, broad])).toEqual(['broad', 'capped'])
  })

  it('orders within a letter by the effective figure the letter was read from', () => {
    // Both B: 6.6% over 95.9% reads 8.0 effective, 1.8% over 78.9% reads 8.8.
    expect(order([row('capped', 1.8, 78.9), row('broad', 6.6, 95.9)])).toEqual(['broad', 'capped'])
  })

  it('puts A+ above an A that rounds to the same figures', () => {
    // One fail in a large suite prints 0.0% without being zero.
    expect(order([row('one-fail', 0.04, 100), row('perfect', 0, 100)])).toEqual(['perfect', 'one-fail'])
  })

  it('breaks a tie the rounding leaves on raw divergence, then coverage', () => {
    expect(order([row('more', 1.04, 100), row('less', 1.01, 100)])).toEqual(['less', 'more'])
    expect(order([row('narrower', 1, 99.96), row('wider', 1, 99.99)])).toEqual(['wider', 'narrower'])
  })

  it('seats an unscored row after every letter, and leaves rows it cannot separate tied', () => {
    expect(order([row('empty', null, null), row('worst', 90, 10)])).toEqual(['worst', 'empty'])
    expect(compareGrades(row('a', 3, 97), row('b', 3, 97))).toBe(0)
    expect(compareGrades(row('a', null, null), row('b', null, null))).toBe(0)
  })
})
