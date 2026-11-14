import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { splitFor } from './lib/registry.mjs'
import { DEAD_ENDPOINT } from './suite-manifest.mjs'
import {
  buildCandidateIssue,
  buildConfirmationErrorIssue,
  buildDriftIssue,
  buildMatchComment,
  buildPageIssue,
  commentOnOpenDriftIssue,
  confirmationAnnotations,
  confirmCandidates,
  detectMatchingRows,
  detectRegistryDrift,
  detectSplitCandidates,
  evidenceFor,
  fileIssue,
  makeVitestRunner,
  noteMatchesAgain,
  outputTail,
  parseArgs,
  printOutputTail,
  readSuiteTimeouts,
  relativeTestFile,
  reportFailures,
  rerunTimeoutMs,
  run,
  testNamePattern,
  testNamesFor,
  testNamesPattern,
} from './sweep-detect.mjs'

const TEST = {
  file: 'tests/tier3/error-messages/putItem.test.ts',
  fullName: 'PutItem — exact error messages accepts a null attribute',
  title: 'accepts a null attribute',
}

function verdict(v, overrides = {}) {
  return {
    file: `/home/runner/work/suite/${TEST.file}`,
    fullName: TEST.fullName,
    title: TEST.title,
    verdict: v,
    ...overrides,
  }
}

const emptyRegistry = { splits: [] }

// A registry row matching TEST, pinned to eu-west-2 (the accepting side).
const rowFor = (test = TEST) => ({
  splits: [
    {
      id: 'row-1',
      test: { file: test.file, fullName: test.fullName },
      behaviour: 'a split behaviour',
      pinned: 'eu-west-2',
      firstObserved: '2026-06-09',
      lastRefreshed: '2026-07-06',
      regions: {
        'eu-west-2': { outcome: 'accepted', detail: 'stored' },
        'us-east-1': {
          outcome: 'rejected',
          error: { name: 'ValidationException', message: 'not here' },
        },
      },
    },
  ],
})

describe('relativeTestFile', () => {
  it('strips the runner prefix and keeps an already-relative path', () => {
    expect(relativeTestFile(`/home/runner/work/suite/${TEST.file}`)).toBe(TEST.file)
    expect(relativeTestFile(TEST.file)).toBe(TEST.file)
  })
})

describe('detectSplitCandidates', () => {
  it('two regions returning definite, differing answers produce exactly one candidate', () => {
    const candidates = detectSplitCandidates(
      { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('fail')] },
      emptyRegistry,
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0].test).toEqual(TEST)
    expect(candidates[0].regions).toEqual({ 'eu-west-2': 'pass', 'us-east-1': 'fail' })
  })

  it('all regions agreeing produce no candidate', () => {
    expect(
      detectSplitCandidates(
        { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('pass')] },
        emptyRegistry,
      ),
    ).toEqual([])
    expect(
      detectSplitCandidates(
        { 'eu-west-2': [verdict('fail')], 'us-east-1': [verdict('fail')] },
        emptyRegistry,
      ),
    ).toEqual([])
  })

  it('one region indeterminate produces NO candidate: absence is not disagreement', () => {
    const candidates = detectSplitCandidates(
      {
        'eu-west-2': [verdict('pass')],
        'us-east-1': [verdict('indeterminate', { reason: { reason: 'transport', at: 'test' } })],
        'eu-central-1': [verdict('fail')],
      },
      emptyRegistry,
    )
    expect(candidates).toEqual([])
  })

  it('a skip anywhere disqualifies the test: a declined probe is not an answer to compare', () => {
    expect(
      detectSplitCandidates(
        {
          'eu-west-2': [verdict('pass')],
          'us-east-1': [verdict('skip')],
          'eu-central-1': [verdict('fail')],
        },
        emptyRegistry,
      ),
    ).toEqual([])
  })

  it('a test with an admitted registry row is not a candidate: that disagreement is expected', () => {
    expect(
      detectSplitCandidates(
        { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('fail')] },
        rowFor(),
      ),
    ).toEqual([])
  })
})

describe('detectRegistryDrift', () => {
  it('regions still behaving as recorded produce no finding', () => {
    expect(
      detectRegistryDrift(
        { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('fail')] },
        rowFor(),
      ),
    ).toEqual([])
  })

  it('an admitted row whose regions have converged produces a reconciliation finding, not a registry edit', () => {
    const findings = detectRegistryDrift(
      { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('pass')] },
      rowFor(),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('converged')
    expect(findings[0].convergedOn).toBe('pinned')
    expect(findings[0].mismatched).toEqual(['us-east-1'])
  })

  it('every region leaving the pinned side is convergence too, not a moved boundary', () => {
    // The #91 shape: the accepting (pinned) region reverted to rejecting, so
    // every named region now fails the committed assertion. No region sits on
    // the pinned side any more - there is no split left to re-pin.
    const findings = detectRegistryDrift(
      { 'eu-west-2': [verdict('fail')], 'us-east-1': [verdict('fail')] },
      rowFor(),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('converged')
    expect(findings[0].convergedOn).toBe('off-pinned')
  })

  it('a region changing sides while both sides remain occupied is drift of kind moved', () => {
    const row = rowFor()
    row.splits[0].regions['eu-central-1'] = { outcome: 'accepted', detail: 'stored' }
    const findings = detectRegistryDrift(
      {
        'eu-west-2': [verdict('pass')],
        'eu-central-1': [verdict('fail')],
        'us-east-1': [verdict('fail')],
      },
      row,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('moved')
    expect(findings[0].convergedOn).toBeUndefined()
    expect(findings[0].mismatched).toEqual(['eu-central-1'])
  })

  it('a named region with no definite answer blocks a convergence claim: the finding stays moved', () => {
    // eu-west-2 contradicts the row and us-east-1 answered nothing definite.
    // The observations do not prove the split collapsed, so the finding must
    // not claim convergence.
    const findings = detectRegistryDrift(
      {
        'eu-west-2': [verdict('fail')],
        'us-east-1': [
          verdict('indeterminate', { reason: { reason: 'throttle-exhausted', at: 'test' } }),
        ],
      },
      rowFor(),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('moved')
    expect(findings[0].convergedOn).toBeUndefined()
  })

  it('a named region wholly absent from the sweep blocks a convergence claim too', () => {
    // us-east-1 produced no verdict at all (an unresolved region contributes
    // nothing). Same rule as an indeterminate: absence cannot prove collapse.
    const findings = detectRegistryDrift({ 'eu-west-2': [verdict('fail')] }, rowFor())
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('moved')
    expect(findings[0].convergedOn).toBeUndefined()
  })

  describe('a test whose assertion accepts every recorded answer', () => {
    // Where the pinned region gives both answers, the committed assertion
    // accepts both and every region passes. Each region's recorded
    // observation says which answer it gave.
    const row = rowFor()
    const [stored, notHere] = [row.splits[0].regions['eu-west-2'], row.splits[0].regions['us-east-1']]

    it('reads each region from its observation, so regions answering as recorded are no drift', () => {
      const verdicts = {
        'eu-west-2': [verdict('pass', { observed: stored })],
        'us-east-1': [verdict('pass', { observed: notHere })],
      }
      expect(detectRegistryDrift(verdicts, row)).toEqual([])
      expect(detectMatchingRows(verdicts, row)).toEqual([
        { id: 'row-1', test: { file: TEST.file, fullName: TEST.fullName } },
      ])
    })

    it('still reports a region that moved from one recorded answer to the other', () => {
      const findings = detectRegistryDrift(
        {
          'eu-west-2': [verdict('pass', { observed: stored })],
          'us-east-1': [verdict('pass', { observed: stored })],
        },
        row,
      )
      expect(findings).toHaveLength(1)
      expect(findings[0].kind).toBe('converged')
      expect(findings[0].convergedOn).toBe('pinned')
      expect(findings[0].mismatched).toEqual(['us-east-1'])
    })
  })

  it('an indeterminate observation draws no drift conclusion', () => {
    const findings = detectRegistryDrift(
      {
        'eu-west-2': [verdict('pass')],
        'us-east-1': [
          verdict('indeterminate', { reason: { reason: 'throttle-exhausted', at: 'test' } }),
        ],
      },
      rowFor(),
    )
    expect(findings).toEqual([])
  })
})

describe('detectMatchingRows', () => {
  it('reports a row every named region answers as recorded', () => {
    expect(
      detectMatchingRows(
        { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('fail')] },
        rowFor(),
      ),
    ).toEqual([{ id: 'row-1', test: { file: TEST.file, fullName: TEST.fullName } }])
  })

  it('does not report a row a region contradicts: that is drift', () => {
    expect(
      detectMatchingRows(
        { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('pass')] },
        rowFor(),
      ),
    ).toEqual([])
  })

  it('does not report a row a named region gave no definite answer on', () => {
    // An indeterminate or absent region cannot vouch for the row, so "matches
    // again" would claim more than the sweep saw.
    const indeterminate = verdict('indeterminate', {
      reason: { reason: 'throttle-exhausted', at: 'test' },
    })
    expect(
      detectMatchingRows({ 'eu-west-2': [verdict('pass')], 'us-east-1': [indeterminate] }, rowFor()),
    ).toEqual([])
    expect(detectMatchingRows({ 'eu-west-2': [verdict('pass')] }, rowFor())).toEqual([])
  })
})

describe('reportFailures', () => {
  const novel = verdict('fail', {
    file: '/home/runner/work/suite/tests/tier3/limits/nestingDepth.test.ts',
    fullName: 'Nesting depth — rejects a 32-level value',
  })
  // The tests exercise exactly the matcher production injects (splitFor),
  // never a hand-rolled variant that could drift from it.
  const doc = rowFor()
  const rowForVerdict = (v) => splitFor(doc, v)

  it('lists every definite failure with the explained flag and matched row id', () => {
    const failures = reportFailures([verdict('fail'), novel, verdict('pass')], rowForVerdict)
    expect(failures).toEqual([
      { file: TEST.file, fullName: TEST.fullName, explained: true, rowId: 'row-1' },
      {
        file: 'tests/tier3/limits/nestingDepth.test.ts',
        fullName: 'Nesting depth — rejects a 32-level value',
        explained: false,
      },
    ])
  })

  it('a uniform failure no candidate can carry still appears: nothing may produce silence', () => {
    // A rowless test failing in every region has no pass side and never
    // becomes a candidate; this list is its only trace in the sweep's output.
    expect(reportFailures([novel], rowForVerdict)).toEqual([
      {
        file: 'tests/tier3/limits/nestingDepth.test.ts',
        fullName: 'Nesting depth — rejects a 32-level value',
        explained: false,
      },
    ])
  })

  it('indeterminates and skips never appear: only definite failures are evidence', () => {
    const absent = [
      verdict('indeterminate', { reason: { reason: 'transport', at: 'test' } }),
      verdict('skip'),
    ]
    expect(reportFailures(absent, rowForVerdict)).toEqual([])
  })
})

// runTests built from a per-test answer, shaped as the real runner returns
// them. `fn(region, test, attempt)` returns a verdict string or
// { error, kind }; a throw fails the whole attempt.
const keyOf = (t) => `${t.file}\n${t.fullName}`
// runTests built from a per-test answer, shaped as the real runner returns
// them. `fn(region, test, attempt)` returns a verdict string, { error, kind },
// or undefined to leave the test out of the Map; a throw fails the attempt.
function perTest(fn, log = []) {
  return async (region, tests, opts) => {
    log.push({ region, tests: tests.map((t) => t.fullName), opts })
    const out = new Map()
    for (const t of tests) {
      const r = fn(region, t, log.length)
      if (r !== undefined) out.set(keyOf(t), typeof r === 'string' ? { verdict: r } : r)
    }
    return out
  }
}
const named = (fullName, regions) => ({ test: { ...TEST, fullName, title: fullName }, regions })
const failIn = (...regions) =>
  Object.fromEntries([['eu-west-2', 'pass'], ...regions.map((r) => [r, 'fail'])])

describe('confirmCandidates', () => {
  const candidate = { test: TEST, regions: { 'eu-west-2': 'pass', 'us-east-1': 'fail' } }

  it('confirms a candidate every fail-side re-run reproduces, and never re-runs the pass side', async () => {
    const log = []
    const { confirmed, discarded, errored, attempts } = await confirmCandidates([candidate], {
      runs: 3,
      runTests: perTest(() => 'fail', log),
    })
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0].confirmation).toEqual({ runs: 3, regions: ['us-east-1'] })
    expect(discarded).toEqual([])
    expect(errored).toEqual([])
    expect(attempts).toBe(3)
    expect(log.map((l) => l.region)).toEqual(['us-east-1', 'us-east-1', 'us-east-1'])
  })

  it('re-runs only the fail side of a wide candidate: cost scales with the cohort, not the region set', async () => {
    const wide = {
      test: TEST,
      regions: Object.fromEntries([
        ['ap-southeast-2', 'fail'],
        ['us-east-1', 'fail'],
        ...Array.from({ length: 28 }, (_, i) => [`eu-fake-${i}`, 'pass']),
      ]),
    }
    const log = []
    const { confirmed } = await confirmCandidates([wide], { runs: 5, runTests: perTest(() => 'fail', log) })
    expect(log).toHaveLength(10)
    expect(new Set(log.map((l) => l.region))).toEqual(new Set(['us-east-1', 'ap-southeast-2']))
    expect(confirmed[0].confirmation.regions).toEqual(['ap-southeast-2', 'us-east-1'])
  })

  it('discards a candidate that fails to reproduce: it was non-determinism, not a split', async () => {
    const { confirmed, discarded } = await confirmCandidates([candidate], {
      runs: 3,
      runTests: perTest((r, t, n) => (n === 2 ? 'pass' : 'fail')),
    })
    expect(confirmed).toEqual([])
    expect(discarded).toHaveLength(1)
    expect(discarded[0].reason).toBe('re-run 2 in us-east-1 returned pass; the sweep observed fail')
  })

  it("a test-level indeterminate discards the candidate: the test's own observation failed", async () => {
    const { confirmed, discarded, errored } = await confirmCandidates([candidate], {
      runs: 5,
      runTests: perTest(() => 'indeterminate'),
    })
    expect(confirmed).toEqual([])
    expect(errored).toEqual([])
    expect(discarded).toHaveLength(1)
  })

  it('a selected test reported skipped did not run: an error, never a discard', async () => {
    const { discarded, errored } = await confirmCandidates([candidate], {
      runs: 3,
      runTests: perTest(() => 'skip'),
    })
    expect(discarded).toEqual([])
    expect(errored).toHaveLength(1)
    expect(errored[0].errorKind).toBe('not-run')
    expect(errored[0].error).toMatch(/^re-run 1 in us-east-1 selected the test but it did not run/)
  })

  it('a test the runner returned no result for was not observed: an error, never a fail', async () => {
    const { confirmed, discarded, errored } = await confirmCandidates([candidate], {
      runs: 3,
      runTests: perTest(() => undefined),
    })
    expect(confirmed).toEqual([])
    expect(discarded).toEqual([])
    expect(errored[0]).toMatchObject({
      errorKind: 'not-run',
      error: 're-run 1 in us-east-1 returned no result for this test',
    })
  })

  it('a candidate with no fail-side region breaks the caller contract loudly', async () => {
    const noFailSide = { test: TEST, regions: { 'eu-west-2': 'pass', 'us-east-1': 'pass' } }
    await expect(
      confirmCandidates([noFailSide], { runs: 5, runTests: perTest(() => 'fail') }),
    ).rejects.toThrow(/no fail-side region/)
  })

  it('checkpoints after every process and once at the end, errored candidates included', async () => {
    const a = named('a', failIn('us-east-1'))
    const b = named('b', failIn('ap-southeast-2'))
    const snapshots = []
    await confirmCandidates([a, b], {
      runs: 2,
      runTests: perTest((r) => (r === 'ap-southeast-2' ? { error: 'gone', kind: 'not-found' } : 'fail')),
      onProgress: (p) => snapshots.push([p.confirmed.length, p.errored.length]),
    })
    // ap-southeast-2 then us-east-1 on attempt 1, us-east-1 on attempt 2
    // (which confirms it), end.
    expect(snapshots).toEqual([
      [0, 1],
      [0, 1],
      [1, 1],
      [1, 1],
    ])
  })

  it('an attempt that cannot be made is an error carrying its kind, and other groups still confirm', async () => {
    const broken = named('broken', failIn('us-east-1'))
    const fine = named('fine', failIn('ap-southeast-2'))
    const runTests = async (region, tests) => {
      if (region === 'us-east-1') {
        const e = new Error('the re-run process ran past its 780s limit and was stopped')
        e.kind = 'timeout'
        throw e
      }
      return new Map(tests.map((t) => [keyOf(t), { verdict: 'fail' }]))
    }
    const checkpoints = []
    const { confirmed, discarded, errored } = await confirmCandidates([broken, fine], {
      runs: 3,
      runTests,
      onProgress: (p) => checkpoints.push(p.errored.length),
    })
    // A checkpoint after the failed attempt too, not only the ones that ran.
    expect(checkpoints).toEqual([0, 1, 1, 1, 1])
    expect(discarded).toEqual([])
    expect(errored).toEqual([
      {
        ...broken,
        error: 're-run 1 in us-east-1 could not be made: the re-run process ran past its 780s limit and was stopped',
        errorKind: 'timeout',
      },
    ])
    expect(confirmed.map((c) => c.test.fullName)).toEqual(['fine'])
  })

  it('a per-test error leaves the rest of its group running', async () => {
    const gone = named('renamed since', failIn('us-east-1'))
    const { confirmed, errored } = await confirmCandidates([candidate, gone], {
      runs: 2,
      runTests: perTest((r, t) => (t === gone.test ? { error: 'no test with this name', kind: 'not-found' } : 'fail')),
    })
    expect(confirmed.map((c) => c.test.fullName)).toEqual([TEST.fullName])
    expect(errored).toHaveLength(1)
    expect(errored[0]).toMatchObject({ errorKind: 'not-found', error: 're-run 1 in us-east-1 could not be made: no test with this name' })
  })

  // Twelve candidates in one file failing in one region, the shape of the
  // 2026-11-14 item-size candidates.
  const twelve = Array.from({ length: 12 }, (_, i) => named(`${TEST.fullName} #${i}`, failIn('eu-north-1')))

  it('re-runs candidates sharing a file and region in one process per attempt', async () => {
    const log = []
    const { confirmed, attempts } = await confirmCandidates(twelve, {
      runs: 5,
      runTests: perTest(() => 'fail', log),
    })
    expect(attempts).toBe(5)
    expect(log.map((l) => l.tests.length)).toEqual([12, 12, 12, 12, 12])
    expect(confirmed.map((c) => c.test.fullName)).toEqual(twelve.map((c) => c.test.fullName))
  })

  it('a test that passes on attempt 2 leaves the group, and the rest are re-run five times', async () => {
    const flaky = twelve[4].test
    const log = []
    const { confirmed, discarded, attempts } = await confirmCandidates(twelve, {
      runs: 5,
      runTests: perTest((r, t, n) => (t === flaky && n === 2 ? 'pass' : 'fail'), log),
    })
    expect(attempts).toBe(5)
    expect(log.map((l) => l.tests.length)).toEqual([12, 12, 11, 11, 11])
    expect(discarded.map((c) => c.test)).toEqual([flaky])
    expect(discarded[0].reason).toBe('re-run 2 in eu-north-1 returned pass; the sweep observed fail')
    expect(confirmed).toHaveLength(11)
  })

  it('a group that empties stops: no attempt runs nothing', async () => {
    const { discarded, attempts } = await confirmCandidates(twelve, { runs: 5, runTests: perTest(() => 'pass') })
    expect(attempts).toBe(1)
    expect(discarded).toHaveLength(12)
  })

  const regionsAH = ['ap-east-2', 'ap-northeast-2', 'ap-southeast-4', 'ap-southeast-5', 'eu-central-1', 'eu-north-1', 'eu-west-1', 'us-west-1']

  it('every group gets attempt 1 before any gets attempt 2, then each group finishes in turn, narrowest first', async () => {
    const wide = named('wide', failIn(...regionsAH))
    const narrow = named('narrow', failIn('ca-central-1'))
    const log = []
    await confirmCandidates([wide, narrow], { runs: 3, runTests: perTest(() => 'fail', log) })
    expect(log.map((l) => l.region)).toEqual([
      // Phase 1: attempt 1 everywhere, narrowest first.
      'ca-central-1',
      ...regionsAH,
      // Phase 2: each group's attempts 2 and 3 back to back, narrowest first.
      'ca-central-1',
      'ca-central-1',
      ...regionsAH.flatMap((r) => [r, r]),
    ])
  })

  // The 2026-10-31 shape: one candidate failing in 8 regions, one in 1, on a
  // fake clock where every process takes `secs`.
  async function shape1031({ secs, wideRefutedFirst, budgetMinutes = 75 }) {
    const wide = named('wide', failIn(...regionsAH))
    const narrow = { ...named('narrow', failIn('ca-central-1')), test: { ...TEST, file: 'tests/tier1/q.test.ts', fullName: 'narrow' } }
    let clock = 0
    let wideRuns = 0
    const out = await confirmCandidates([wide, narrow], {
      runs: 5,
      budgetMs: budgetMinutes * 60_000,
      now: () => clock,
      runTests: perTest((region, t) => {
        clock += secs * 1000
        if (t.fullName !== 'wide') return 'fail'
        wideRuns++
        return wideRefutedFirst && wideRuns === 1 ? 'pass' : 'fail'
      }),
    })
    const fate = (name) =>
      out.confirmed.some((c) => c.test.fullName === name)
        ? 'confirmed'
        : out.discarded.some((c) => c.test.fullName === name)
          ? 'discarded'
          : out.errored.find((c) => c.test.fullName === name).errorKind
    return { attempts: out.attempts, narrow: fate('narrow'), wide: fate('wide') }
  }

  it.each([
    [60, false, 45, 'confirmed'],
    [75, false, 45, 'confirmed'],
    [95, false, 45, 'confirmed'],
    [60, true, 6, 'discarded'],
    [75, true, 6, 'discarded'],
    [95, true, 6, 'discarded'],
  ])('the 2026-10-31 shape at %ss a process (wide refuted first: %s): %i processes, wide %s, narrow confirmed', async (secs, wideRefutedFirst, attempts, wide) => {
    expect(await shape1031({ secs, wideRefutedFirst })).toEqual({ attempts, narrow: 'confirmed', wide })
  })

  it('when the budget falls short, it falls on the wide candidate, never the narrow one', async () => {
    // 45 minutes at 95s a process: 29 processes, phase 1 (9), the narrow
    // group's last four, then 16 of the wide one's 32.
    expect(await shape1031({ secs: 95, wideRefutedFirst: false, budgetMinutes: 45 })).toEqual({
      attempts: 29,
      narrow: 'confirmed',
      wide: 'budget',
    })
  })

  it('orders a group by its narrowest member, then by file', async () => {
    // us-west-2's group holds a wide candidate and a narrow one: it goes by
    // the narrow one, ahead of a two-region candidate in an earlier file.
    const wide = named('wide', failIn('us-west-2', 'aa-fake-1', 'aa-fake-2'))
    const narrow = named('narrow', failIn('us-west-2'))
    const two = { ...named('two', failIn('aa-fake-0', 'aa-fake-3')), test: { ...TEST, file: 'tests/a.test.ts', fullName: 'two' } }
    // Same width, files either side of TEST.file (tests/tier3/...): by file,
    // whatever the region.
    const laterFile = { ...named('later', failIn('ab-fake')), test: { ...TEST, file: 'tests/z.test.ts', fullName: 'later' } }
    const earlierFile = { ...named('earlier', failIn('zz-fake')), test: { ...TEST, file: 'tests/b.test.ts', fullName: 'earlier' } }
    const log = []
    await confirmCandidates([wide, narrow, two, laterFile, earlierFile], { runs: 1, runTests: perTest(() => 'fail', log) })
    expect(log.map((l) => `${l.region} ${l.tests.join('+')}`)).toEqual([
      'zz-fake earlier',
      'us-west-2 wide+narrow',
      'ab-fake later',
      'aa-fake-0 two',
      'aa-fake-3 two',
      'aa-fake-1 wide',
      'aa-fake-2 wide',
    ])
  })

  it('a wide candidate refuted in its first region costs nothing in the others', async () => {
    const wide = named('wide', failIn(...regionsAH))
    const log = []
    const { discarded, attempts } = await confirmCandidates([wide], {
      runs: 5,
      runTests: perTest((r) => (r === regionsAH[0] ? 'pass' : 'fail'), log),
    })
    expect(attempts).toBe(1)
    expect(log.map((l) => l.region)).toEqual([regionsAH[0]])
    expect(discarded).toHaveLength(1)
  })

  it('narrow candidates are decided before a 19-region one spends the budget', async () => {
    // The wide candidate's regions sort before the narrow ones and its file
    // is the same, so only ordering by width puts the narrow groups first.
    const nineteen = Array.from({ length: 19 }, (_, i) => `aa-fake-${String(i).padStart(2, '0')}`)
    const wide = named('wide', failIn(...nineteen))
    const narrowA = named('narrow a', failIn('us-east-1'))
    const narrowB = named('narrow b', failIn('us-west-2'))
    let clock = 0
    const runTests = perTest(() => {
      clock += 60_000
      return 'fail'
    })
    // Phase 1 is 21 processes and each narrow group needs 4 more: room for
    // those and one of the wide candidate's 76.
    const { confirmed, errored } = await confirmCandidates([wide, narrowA, narrowB], {
      runs: 5,
      runTests,
      budgetMs: 30 * 60_000,
      now: () => clock,
    })
    expect(confirmed.map((c) => c.test.fullName)).toEqual(['narrow a', 'narrow b'])
    expect(errored.map((c) => [c.test.fullName, c.errorKind])).toEqual([['wide', 'budget']])
  })

  it('with a budget for N processes, no group has a second attempt before every group has had one', async () => {
    const groups = Array.from({ length: 6 }, (_, i) => named(`g${i}`, failIn(`xx-fake-${i}`)))
    let clock = 0
    const log = []
    await confirmCandidates(groups, {
      runs: 5,
      runTests: perTest(() => {
        clock += 60_000
        return 'fail'
      }, log),
      budgetMs: 9 * 60_000,
      now: () => clock,
    })
    expect(log).toHaveLength(9)
    expect(new Set(log.slice(0, 6).map((l) => l.region)).size).toBe(6)
  })

  it('when the budget runs out, nothing starts, and only undecided candidates are budget errors', async () => {
    const other = { test: { ...TEST, file: 'tests/tier1/other.test.ts' }, regions: failIn('us-east-1') }
    const refuted = { test: { ...TEST, file: 'tests/tier1/refuted.test.ts' }, regions: failIn('us-east-1') }
    let clock = 0
    const minute = 60_000
    const log = []
    const runTests = perTest((r, t) => {
      clock += 10 * minute
      return t === refuted.test ? 'pass' : 'fail'
    }, log)
    const { confirmed, discarded, errored, attempts } = await confirmCandidates([candidate, other, refuted], {
      runs: 5,
      runTests,
      budgetMs: 25 * minute,
      now: () => clock,
    })
    // Started at 0, 10 and 20 minutes, measured from the step's start; the
    // fourth would start at 30.
    expect(attempts).toBe(3)
    expect(log.map((l) => l.opts.remainingMs)).toEqual([25 * minute, 15 * minute, 5 * minute])
    expect(confirmed).toEqual([])
    expect(discarded.map((c) => c.test)).toEqual([refuted.test])
    expect(errored.map((c) => [c.test.file, c.errorKind])).toEqual([
      [TEST.file, 'budget'],
      ['tests/tier1/other.test.ts', 'budget'],
    ])
    expect(errored[0].error).toBe(
      "not re-run to the end: the confirmation step's 25-minute budget ran out after 3 attempt(s)",
    )
  })

  it('at the budget boundary: exactly spent starts nothing, a millisecond left starts one', async () => {
    // The step starts at 0; every later reading of the clock is `at`.
    const clockAt = (at) => {
      let first = true
      return () => (first ? ((first = false), 0) : at)
    }
    const spent = await confirmCandidates([candidate], {
      runs: 1,
      runTests: perTest(() => 'fail'),
      budgetMs: 1000,
      now: clockAt(1000),
    })
    expect(spent.attempts).toBe(0)
    expect(spent.errored[0].errorKind).toBe('budget')
    const left = await confirmCandidates([candidate], {
      runs: 1,
      runTests: perTest(() => 'fail'),
      budgetMs: 1000,
      now: clockAt(999),
    })
    expect(left.attempts).toBe(1)
    expect(left.confirmed).toHaveLength(1)
  })
})

// ── The real runner, with an injected spawn ──────────────────────────────────

const CWD = process.cwd()

// A spawn that answers `vitest list` and `vitest run` as told, writing the
// files vitest would. `listing(pattern)` returns [{ name, file }] with `file`
// repo-relative, or a spawn result to return as is; `rerun(args, opts)`
// returns assertion results for the run, { results, sidecar }, or a spawn
// result, or null for a run that wrote nothing.
function fakeVitest({ listing = () => [], listStatus = 1, writeListing = true, rerun = () => [] } = {}) {
  const calls = []
  const spawn = async (cmd, args, opts) => {
    const verb = args[1]
    const pattern = args.find((a) => a.startsWith('--testNamePattern='))?.slice('--testNamePattern='.length) ?? null
    calls.push({ verb, pattern, opts, args })
    if (verb === 'list') {
      const answer = listing(pattern)
      if (!Array.isArray(answer)) return answer
      const json = args.find((a) => a.startsWith('--json=')).slice('--json='.length)
      if (writeListing) {
        writeFileSync(json, JSON.stringify(answer.map((t) => ({ name: t.name, file: join(CWD, t.file) }))))
      }
      // The suite's teardown fails against the dead endpoint after the
      // listing is written, so a real listing exits non-zero.
      return { status: listStatus, stdout: '', stderr: writeListing ? '' : 'Error: config failed to load' }
    }
    const answer = rerun(args, opts)
    if (answer && !Array.isArray(answer) && !answer.results) return answer
    if (answer !== null) {
      const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length)
      const results = Array.isArray(answer) ? answer : answer.results
      writeFileSync(out, JSON.stringify({ testResults: results }))
      if (answer.sidecar) writeFileSync(join(opts.env.CONFORMANCE_RESULTS_DIR, 'confirm-us-east-1.indeterminate.json'), JSON.stringify(answer.sidecar))
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { spawn, calls }
}

const NAMES = ['PutItem — exact error messages', 'accepts a null attribute']
const WANTED = NAMES.join(' > ')
// Removed after each test by the afterEach below, even when the test fails.
const tmpRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-runner-test-'))
  madeDirs.push(dir)
  return dir
}
const runnerWith = (fake, extra = {}) =>
  makeVitestRunner({
    namesFor: () => NAMES,
    spawn: fake.spawn,
    timeouts: { testTimeout: 30_000, hookTimeout: 180_000 },
    measuredRef: '16ee955',
    // A still clock, so a limit is exactly what the budget left.
    now: () => 0,
    ...extra,
  })
const assertion = (status, { names = NAMES, meta = {} } = {}) => ({
  ancestorTitles: names.slice(0, -1),
  title: names.at(-1),
  fullName: names.join(' '),
  status,
  meta,
  failureMessages: [],
})
const resultFor = (file, status, opts) => ({ name: join(CWD, file), assertionResults: [assertion(status, opts)] })
const listed = () => [{ name: WANTED, file: TEST.file }]

async function thrown(promise) {
  try {
    await promise
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

describe('makeVitestRunner', () => {
  it('re-runs the one selected test and reads its verdict, and leaves no temp directory behind', async () => {
    const root = tmpRoot()
    const fake = fakeVitest({ listing: listed, rerun: () => [resultFor(TEST.file, 'failed')] })
    const results = await runnerWith(fake, { tmpRoot: root })('us-east-1', [TEST])
    expect(results.get(keyOf(TEST))).toEqual({ verdict: 'fail' })
    expect(fake.calls.map((c) => c.verb)).toEqual(['list', 'run'])
    expect(fake.calls[1].pattern).toBe(testNamesPattern([NAMES]))
    expect(readdirSync(root)).toEqual([])
    rmSync(root, { recursive: true })
  })

  it('reads the verdict from the test in its own file, not a same-named test elsewhere', async () => {
    const fake = fakeVitest({
      listing: listed,
      rerun: () => [resultFor('tests/tier1/elsewhere.test.ts', 'failed'), resultFor(TEST.file, 'passed')],
    })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toEqual({ verdict: 'pass' })
  })

  it("reads the selected test's own result, not a twin that shares its space-joined name", async () => {
    // ['PutItem — exact error messages accepts', 'a null attribute'] joins to
    // the same fullName with spaces, but is a different test that was not
    // selected, so it reports skipped.
    const twin = ['PutItem — exact error messages accepts', 'a null attribute']
    const fake = fakeVitest({
      listing: listed,
      rerun: () => [
        { name: join(CWD, TEST.file), assertionResults: [assertion('skipped', { names: twin }), assertion('failed')] },
      ],
    })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toEqual({ verdict: 'fail' })
  })

  it('two results with the selected name in one file are a selection fault', async () => {
    const fake = fakeVitest({
      listing: listed,
      rerun: () => [{ name: join(CWD, TEST.file), assertionResults: [assertion('skipped'), assertion('failed')] }],
    })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toMatchObject({ kind: 'selection' })
  })

  it('a re-run that wrote no results file observed nothing: not-run, never indeterminate', async () => {
    const fake = fakeVitest({ listing: listed, rerun: () => null })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toEqual({
      error: 'the re-run wrote no results file (exit 0)',
      kind: 'not-run',
    })
  })

  it('a selected test absent from the results observed nothing: not-run', async () => {
    const fake = fakeVitest({ listing: listed, rerun: () => [] })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toEqual({
      error: "the selected test is absent from the re-run's results",
      kind: 'not-run',
    })
  })

  it('a run-level fault in the sidecar observed nothing: not-run, naming the fault', async () => {
    const fake = fakeVitest({
      listing: listed,
      rerun: () => ({
        results: [resultFor(TEST.file, 'failed')],
        sidecar: { runLevel: [{ reason: 'provisioning-timeout' }] },
      }),
    })
    const r = (await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))
    expect(r.kind).toBe('not-run')
    expect(r.error).toMatch(/failed as a whole \(provisioning-timeout\)/)
  })

  it("a test-level indeterminate is the test's own observation, returned as one", async () => {
    const fake = fakeVitest({
      listing: listed,
      rerun: () => [resultFor(TEST.file, 'failed', { meta: { indeterminate: { reason: 'throttled' } } })],
    })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toEqual({ verdict: 'indeterminate' })
  })

  it('a test missing from the whole file is not-found, naming the measured commit, and never runs', async () => {
    const root = tmpRoot()
    const fake = fakeVitest({ listing: (p) => (p === null ? [{ name: 'something else', file: TEST.file }] : []) })
    const results = await runnerWith(fake, { tmpRoot: root })('us-east-1', [TEST])
    expect(results.get(keyOf(TEST))).toEqual({
      error: `no test with this name in ${TEST.file} on the checked-out commit; it may have been renamed or removed since 16ee955`,
      kind: 'not-found',
    })
    expect(fake.calls.map((c) => [c.verb, c.pattern])).toEqual([
      ['list', testNamesPattern([NAMES])],
      ['list', null],
    ])
    expect(readdirSync(root)).toEqual([])
    rmSync(root, { recursive: true })
  })

  it('a test the file has but the selector misses is a selection fault, not a missing test', async () => {
    const fake = fakeVitest({ listing: (p) => (p === null ? listed() : []) })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toMatchObject({ kind: 'selection' })
  })

  it('a selection of two same-named tests is a selection fault and never runs', async () => {
    const fake = fakeVitest({ listing: () => [...listed(), ...listed()] })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toEqual({
      error: `the re-run would select 2 tests named "${WANTED}" in ${TEST.file}, not one`,
      kind: 'selection',
    })
    expect(fake.calls.map((c) => c.verb)).toEqual(['list'])
  })

  it('one selected test with the right name in another file is refused', async () => {
    const fake = fakeVitest({ listing: () => [{ name: WANTED, file: 'tests/tier1/elsewhere.test.ts' }] })
    expect((await thrown(runnerWith(fake)('us-east-1', [TEST]))).message).toMatch(
      /nobody asked for: tests\/tier1\/elsewhere/,
    )
    expect(fake.calls.map((c) => c.verb)).toEqual(['list'])
  })

  it('one selected test in the right file with another name is refused', async () => {
    const fake = fakeVitest({ listing: () => [{ name: `${WANTED}, twice`, file: TEST.file }] })
    expect((await thrown(runnerWith(fake)('us-east-1', [TEST]))).message).toMatch(/nobody asked for/)
    expect(fake.calls.map((c) => c.verb)).toEqual(['list'])
  })

  it('a listing that exits non-zero is still read when vitest wrote it', async () => {
    const fake = fakeVitest({ listStatus: 1, listing: listed, rerun: () => [resultFor(TEST.file, 'failed')] })
    expect((await runnerWith(fake)('us-east-1', [TEST])).get(keyOf(TEST))).toEqual({ verdict: 'fail' })
  })

  it('a listing vitest never wrote is an error, not an empty selection', async () => {
    const fake = fakeVitest({ writeListing: false })
    expect((await thrown(runnerWith(fake)('us-east-1', [TEST]))).message).toMatch(
      /produced no listing.*config failed to load/,
    )
  })

  it('a listing that timed out is a timeout, whatever it left behind', async () => {
    const fake = fakeVitest({ listing: () => ({ status: null, signal: 'SIGKILL', timedOut: true }) })
    const e = await thrown(runnerWith(fake)('us-east-1', [TEST]))
    expect(e.kind).toBe('timeout')
    expect(e.message).toBe('vitest list ran past its 60s limit and was stopped')
  })

  it('a re-run ended by a signal we did not send is a runner fault naming the signal, not a timeout', async () => {
    const fake = fakeVitest({ listing: listed, rerun: () => ({ status: null, signal: 'SIGSEGV' }) })
    const e = await thrown(runnerWith(fake)('us-east-1', [TEST]))
    expect(e.kind).toBe('runner')
    expect(e.message).toBe('the re-run process was ended by SIGSEGV')
  })

  it('a listing ended by a signal we did not send is a runner fault too', async () => {
    const fake = fakeVitest({ listing: () => ({ status: null, signal: 'SIGTERM' }) })
    const e = await thrown(runnerWith(fake)('us-east-1', [TEST]))
    expect(e).toMatchObject({ kind: 'runner', message: 'vitest list was ended by SIGTERM' })
  })

  it('a re-run that timed out or wrote nothing has the end of its output folded into the run log', async () => {
    const lines = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s) => lines.push(String(s)))
    try {
      const stdout = Array.from({ length: 100 }, (_, i) => `out ${i}`).join('\n')
      const timeout = fakeVitest({
        listing: listed,
        rerun: () => ({ status: null, signal: 'SIGKILL', timedOut: true, stdout, stderr: '::error::from the child' }),
      })
      await thrown(runnerWith(timeout)('us-east-1', [TEST]))
      expect(lines[0]).toBe(`::group::re-run ${TEST.file} in us-east-1`)
      const token = lines[1].match(/^::stop-commands::([0-9a-f]{16})$/)[1]
      // The last 40 lines of each stream, the child's own workflow commands
      // switched off while they print.
      expect(lines).toContain('out 99')
      expect(lines).toContain('out 60')
      expect(lines).not.toContain('out 59')
      expect(lines.slice(-3)).toEqual(['::error::from the child', `::${token}::`, '::endgroup::'])
      lines.length = 0
      const nothing = fakeVitest({ listing: listed, rerun: () => null })
      await runnerWith(nothing)('us-east-1', [TEST])
      expect(lines[0]).toBe(`::group::re-run ${TEST.file} in us-east-1`)
      lines.length = 0
      const noListing = fakeVitest({ writeListing: false })
      await thrown(runnerWith(noListing)('us-east-1', [TEST]))
      expect(lines[0]).toBe(`::group::vitest list ${TEST.file} in us-east-1`)
      // A re-run that worked prints nothing.
      lines.length = 0
      await runnerWith(fakeVitest({ listing: listed, rerun: () => [resultFor(TEST.file, 'failed')] }))('us-east-1', [TEST])
      expect(lines).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('a budget of 0.4ms left still gives every spawn a limit of at least 1ms', async () => {
    const fake = fakeVitest({ listing: listed, rerun: () => [resultFor(TEST.file, 'failed')] })
    await runnerWith(fake)('us-east-1', [TEST], { remainingMs: 0.4 })
    expect(fake.calls.map((c) => c.opts.timeout)).toEqual([1, 1])
  })

  it('lists against a dead endpoint with dummy credentials, and re-runs against real AWS', async () => {
    const saved = { ...process.env }
    process.env.DYNAMODB_ENDPOINT = 'http://127.0.0.1:9999'
    process.env.AWS_ACCESS_KEY_ID = 'AKIAREALLOOKING'
    process.env.AWS_SESSION_TOKEN = 'session'
    try {
      const fake = fakeVitest({ listing: listed, rerun: () => [resultFor(TEST.file, 'failed')] })
      await runnerWith(fake)('us-east-1', [TEST])
      const [list, rerun] = fake.calls
      expect(list.opts.env.DYNAMODB_ENDPOINT).toBe(DEAD_ENDPOINT)
      expect(list.opts.env.AWS_ACCESS_KEY_ID).toBe('listing-only')
      expect(list.opts.env.AWS_SESSION_TOKEN).toBeUndefined()
      expect(rerun.opts.env.DYNAMODB_ENDPOINT).toBeUndefined()
      expect(rerun.opts.env.AWS_REGION).toBe('us-east-1')
      expect(rerun.opts.env.AWS_ACCESS_KEY_ID).toBe('AKIAREALLOOKING')
      // The results directory is the one the output file is written to, so
      // the sidecar lands where it is read back.
      const out = rerun.args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length)
      expect(join(rerun.opts.env.CONFORMANCE_RESULTS_DIR, 'confirm-us-east-1.json')).toBe(out)
    } finally {
      process.env = saved
    }
  })

  it('a re-run that times out on its own limit is a timeout, its limit following the test count', async () => {
    const fake = fakeVitest({ listing: listed, rerun: () => ({ status: null, signal: 'SIGKILL', timedOut: true }) })
    const e = await thrown(runnerWith(fake)('us-east-1', [TEST]))
    expect(e.kind).toBe('timeout')
    expect(e.message).toBe('the re-run process ran past its 450s limit and was stopped')
    expect(fake.calls.map((c) => c.opts.timeout)).toEqual([60_000, 450_000])
  })

  it('reads CONFORMANCE_RETRY into the re-run limit', async () => {
    const saved = process.env.CONFORMANCE_RETRY
    process.env.CONFORMANCE_RETRY = '1'
    try {
      const fake = fakeVitest({ listing: listed, rerun: () => [resultFor(TEST.file, 'failed')] })
      await runnerWith(fake)('us-east-1', [TEST])
      expect(fake.calls[1].opts.timeout).toBe(480_000)
    } finally {
      if (saved === undefined) delete process.env.CONFORMANCE_RETRY
      else process.env.CONFORMANCE_RETRY = saved
    }
  })

  it('when the budget left is the tighter limit, running out is the budget, not a timeout', async () => {
    const fake = fakeVitest({ listing: listed, rerun: () => ({ status: null, signal: 'SIGKILL', timedOut: true }) })
    const e = await thrown(runnerWith(fake)('us-east-1', [TEST], { remainingMs: 20_000 }))
    expect(e.kind).toBe('budget')
    expect(fake.calls.map((c) => c.opts.timeout)).toEqual([20_000, 20_000])
  })

  it('time spent listing comes off the budget before the re-run is capped', async () => {
    let clock = 0
    const fake = fakeVitest({
      listing: () => {
        clock += 15_000
        return listed()
      },
      rerun: () => [resultFor(TEST.file, 'failed')],
    })
    await runnerWith(fake, { now: () => clock })('us-east-1', [TEST], { remainingMs: 100_000 })
    expect(fake.calls.map((c) => c.opts.timeout)).toEqual([60_000, 85_000])
  })

  it('every limit is a whole number of milliseconds, at least one', async () => {
    const fake = fakeVitest({ listing: listed, rerun: () => [resultFor(TEST.file, 'failed')] })
    // 4.1 minutes is not a whole number of milliseconds in floating point.
    await runnerWith(fake)('us-east-1', [TEST], { remainingMs: 4.1 * 60_000 - 0.4 })
    for (const { opts } of fake.calls) {
      expect(Number.isInteger(opts.timeout), String(opts.timeout)).toBe(true)
      expect(opts.timeout).toBeGreaterThanOrEqual(1)
    }
    expect(fake.calls[1].opts.timeout).toBe(245_999)
  })

  it('lists a group once: a smaller group of already-checked tests runs without listing again', async () => {
    const second = { ...TEST, fullName: 'second test', title: 'second test' }
    const namesFor = (t) => (t === TEST ? NAMES : ['second test'])
    const fake = fakeVitest({
      listing: () => [...listed(), { name: 'second test', file: TEST.file }],
      rerun: () => [resultFor(TEST.file, 'failed')],
    })
    const runTests = runnerWith(fake, { namesFor })
    await runTests('eu-north-1', [TEST, second])
    await runTests('eu-north-1', [TEST])
    expect(fake.calls.map((c) => c.verb)).toEqual(['list', 'run', 'run'])
    expect(fake.calls[2].pattern).toBe(testNamesPattern([NAMES]))
  })

  it('keeps the tail of a stream, bounded, and decodes characters split across chunks', () => {
    const tail = outputTail(1024)
    let peak = 0
    const chunk = Buffer.from('x'.repeat(64 * 1024))
    for (let i = 0; i < 80; i++) {
      tail.push(chunk)
      peak = Math.max(peak, tail.size)
    }
    // A euro sign split between two chunks.
    const euro = Buffer.from('\nend €\n')
    tail.push(euro.subarray(0, 6))
    tail.push(euro.subarray(6))
    tail.push(Buffer.from('MARKER'))
    const text = tail.end()
    expect(text.length).toBe(1024)
    expect(text.endsWith('\nend €\nMARKER')).toBe(true)
    expect(peak).toBeLessThanOrEqual(2 * 1024)
  })

  it('prints at most the last 40 lines of each stream', () => {
    const lines = []
    printOutputTail('re-run f in r', { stdout: Array.from({ length: 50 }, (_, i) => `o${i}`).join('\n'), stderr: '' }, {
      log: (s) => lines.push(s),
    })
    expect(lines.filter((l) => /^o\d+$/.test(l))).toEqual(Array.from({ length: 40 }, (_, i) => `o${i + 10}`))
  })

  it('reads the re-run time limit from the suite config, and bounds it', () => {
    expect(readSuiteTimeouts('vitest.config.ts')).toEqual({ testTimeout: 30_000, hookTimeout: 180_000 })
    const limits = { testTimeout: 30_000, hookTimeout: 180_000 }
    expect(rerunTimeoutMs(1, limits)).toBe(450_000)
    expect(rerunTimeoutMs(12, limits)).toBe(780_000)
    expect(rerunTimeoutMs(12, { ...limits, retry: 1 })).toBe(1_140_000)
    expect(rerunTimeoutMs(100, limits)).toBe(20 * 60_000)
  })
})

// ── Selecting exactly the intended tests ─────────────────────────────────────

describe('testNamePattern', () => {
  const awkward = [
    ['a top-level test'],
    ['Item size limit by surface — UpdateItem', 'charges each kind of clause', 'charges a REMOVE one byte plus its path'],
    ['Regex metacharacters (.*+?^${}|[]\\)', 'costs $1.00 (exactly)? [yes|no]'],
    ['a describe > with the separator in it', 'and a test > with one too'],
    ['naïve café ✓', 'non-ASCII — throughout, 東京'],
    ['whitespace', '  leading spaces'],
    ['whitespace', 'a newline\nin the name'],
  ]

  it('joins the name parts the way vitest does, and matches that name exactly', () => {
    for (const names of awkward) {
      const re = new RegExp(testNamePattern(names))
      expect(re.test(names.join(' > ')), names.join(' > ')).toBe(true)
    }
  })

  it('does not match the space-joined name the JSON reporter records', () => {
    const names = awkward[1]
    expect(new RegExp(testNamePattern(names)).test(names.join(' '))).toBe(false)
  })

  it('is anchored, so a name that only starts or ends the same way is not matched', () => {
    const re = new RegExp(testNamePattern(['parameterised', 'reads key a']))
    expect(re.test('parameterised > reads key a.b')).toBe(false)
    expect(re.test('outer > parameterised > reads key a')).toBe(false)
    const group = new RegExp(testNamesPattern([['a'], ['b', 'c']]))
    expect(group.test('a')).toBe(true)
    expect(group.test('b > c')).toBe(true)
    expect(group.test('a > b > c')).toBe(false)
    expect(group.test('b > c > d')).toBe(false)
  })

  it('treats every regex metacharacter literally', () => {
    const names = awkward[2]
    const re = new RegExp(testNamePattern(names))
    expect(re.test(names.join(' > '))).toBe(true)
    // Unescaped, `.` would match any character and `?` would make `)` optional.
    expect(re.test(names.join(' > ').replace('1.00', '1x00'))).toBe(false)
    expect(re.test(names.join(' > ').replace('(exactly)?', '(exactly'))).toBe(false)
  })

  it('keeps whitespace exactly', () => {
    const re = new RegExp(testNamePattern(['whitespace', 'double  spaces']))
    expect(re.test('whitespace > double  spaces')).toBe(true)
    expect(re.test('whitespace > double spaces')).toBe(false)
  })

  it('refuses name parts it cannot build a selector from', () => {
    expect(() => testNamePattern([])).toThrow(/cannot build/)
    expect(() => testNamePattern(['outer', ''])).toThrow(/cannot build/)
    expect(() => testNamePattern(undefined)).toThrow(/cannot build/)
    expect(() => testNamesPattern([])).toThrow(/cannot build/)
  })
})

describe('testNamesFor', () => {
  const docWith = (assertions) => ({
    results: {
      testResults: [{ name: `/home/runner/work/suite/${TEST.file}`, assertionResults: assertions }],
    },
  })
  const ar = (ancestorTitles, title) => ({
    ancestorTitles,
    title,
    fullName: [...ancestorTitles, title].join(' '),
  })

  it('takes the parts from the results, not by splitting the space-joined name', () => {
    const docs = { 'eu-west-2': docWith([ar(['PutItem — exact error messages'], 'accepts a null attribute')]) }
    expect(testNamesFor(docs, TEST)).toEqual(['PutItem — exact error messages', 'accepts a null attribute'])
  })

  it('throws when two different tests share the space-joined name', () => {
    const docs = {
      'eu-west-2': docWith([ar(['PutItem — exact error messages'], 'accepts a null attribute')]),
      'us-east-1': docWith([ar(['PutItem — exact error messages accepts'], 'a null attribute')]),
    }
    expect(() => testNamesFor(docs, TEST)).toThrow(/names 2 different tests/)
  })

  it('throws when no region recorded the parts', () => {
    const docs = { 'eu-west-2': docWith([{ title: TEST.title, fullName: TEST.fullName }]) }
    expect(() => testNamesFor(docs, TEST)).toThrow(/carry no name parts/)
  })
})

describe('issue bodies', () => {
  const candidate = {
    test: TEST,
    regions: { 'eu-west-2': 'pass', 'us-east-1': 'fail' },
    confirmation: { runs: 5, regions: ['us-east-1'] },
  }

  it('a candidate issue carries the evidence, the provenance, and the human gate', () => {
    const issue = buildCandidateIssue(candidate, {
      date: '2026-07-11',
      runUrl: 'https://example.test/run/1',
      evidence: {
        'us-east-1': { status: 'failed', failureMessages: ['ValidationException: nope'] },
      },
    })
    expect(issue.title).toContain(TEST.fullName)
    expect(issue.labels).toEqual(['split-candidate'])
    expect(issue.body).toContain(TEST.file)
    expect(issue.body).toContain('2026-07-11')
    expect(issue.body).toContain('https://example.test/run/1')
    expect(issue.body).toContain('ValidationException: nope')
    // The confirmation line names exactly what was re-run and never claims
    // pass-side repetition the pipeline did not perform.
    expect(issue.body).toContain('the divergent side (us-east-1) was re-run 5× each')
    expect(issue.body).toContain('Pass-side verdicts are single sweep observations')
    expect(issue.body).toContain('never writes `registry/splits.json`')
  })

  it('a drift issue names the row, both readings, and leaves adjudication to a human', () => {
    const [finding] = detectRegistryDrift(
      { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('pass')] },
      rowFor(),
    )
    const issue = buildDriftIssue(finding, { date: '2026-07-11' })
    expect(issue.title).toBe('Registry drift: row-1 (converged)')
    expect(issue.labels).toEqual(['registry-drift'])
    expect(issue.body).toContain('matching the pinned one')
    expect(issue.body).toContain('| us-east-1 | fail | pass |')
    expect(issue.body).toContain('never writes `registry/splits.json`')
  })

  it('a convergence away from the pinned side says the split is gone, not that it healed', () => {
    const [finding] = detectRegistryDrift(
      { 'eu-west-2': [verdict('fail')], 'us-east-1': [verdict('fail')] },
      rowFor(),
    )
    const issue = buildDriftIssue(finding, { date: '2026-07-11' })
    expect(issue.title).toBe('Registry drift: row-1 (converged)')
    expect(issue.body).toContain('every region has left the pinned side')
    expect(issue.body).toContain('| eu-west-2 | pass | fail |')
    expect(issue.body).toContain('never writes `registry/splits.json`')
  })

  it('a moved finding says the divergence moved and shows the side-changing region', () => {
    const row = rowFor()
    row.splits[0].regions['eu-central-1'] = { outcome: 'accepted', detail: 'stored' }
    const [finding] = detectRegistryDrift(
      {
        'eu-west-2': [verdict('pass')],
        'eu-central-1': [verdict('fail')],
        'us-east-1': [verdict('fail')],
      },
      row,
    )
    const issue = buildDriftIssue(finding, { date: '2026-07-11' })
    expect(issue.title).toBe('Registry drift: row-1 (moved)')
    expect(issue.body).toContain('describing a divergence that has moved')
    expect(issue.body).toContain('| eu-central-1 | pass | fail |')
    expect(issue.body).toContain('never writes `registry/splits.json`')
  })

  it('a page issue says drop and page were one act, and that the region rejoins on recovery', () => {
    const issue = buildPageIssue(
      { region: 'sa-east-1', reasons: [{ kind: 'missing-results', detail: 'no results file' }] },
      { date: '2026-07-11' },
    )
    expect(issue.title).toContain('sa-east-1')
    expect(issue.labels).toEqual(['region-dropped'])
    expect(issue.body).toContain('two consecutive sweeps')
    expect(issue.body).toContain('missing-results')
    expect(issue.body).toContain('rejoins the observed set')
  })

  it('a confirmation-error issue lists each candidate and why, under a stable title', () => {
    const regions = { 'eu-west-2': 'pass', 'us-east-1': 'fail' }
    const issue = buildConfirmationErrorIssue(
      [
        { test: TEST, regions, error: 're-run 1 in us-east-1 could not be made: a | b', errorKind: 'selection' },
        {
          test: { ...TEST, fullName: 'gone' },
          regions,
          error: 'no test with this name in x on the checked-out commit',
          errorKind: 'not-found',
        },
        { test: { ...TEST, fullName: 'late' }, regions, error: 'budget ran out', errorKind: 'budget' },
      ],
      { date: '2026-07-11', runUrl: 'https://example.test/run/1' },
    )
    expect(issue.title).toBe('Sweep confirmation could not re-run every candidate')
    expect(issue.labels).toEqual(['confirmation-error'])
    expect(issue.body).toContain('https://example.test/run/1')
    expect(issue.body).toContain('neither confirmed nor refuted')
    expect(issue.body).toContain('this issue and the error annotations in the run log are the only signal')
    // One section per kind, each saying what to do, in a fixed order.
    const headings = issue.body.split('\n').filter((l) => l.startsWith('### '))
    expect(headings).toEqual([
      '### The test is not on the checked-out commit',
      '### The re-run could not pick out exactly this test',
      "### The confirmation step's budget ran out first",
      '### Next step',
    ])
    expect(issue.body).toContain("Check main's history for the rename or removal")
    // A pipe in the error must not break the table row.
    expect(issue.body).toContain(
      `| \`${TEST.file}\` | ${TEST.fullName} | us-east-1 | re-run 1 in us-east-1 could not be made: a \\| b |`,
    )
    expect(issue.body).toContain('never writes `registry/splits.json`')
    // Each candidate sits under its own kind's section only.
    const sections = issue.body.split('\n### ')
    const sectionOf = (name) => sections.filter((s) => s.includes(`| ${name} |`)).map((s) => s.split('\n')[0])
    expect(sectionOf('gone')).toEqual(['The test is not on the checked-out commit'])
    expect(sectionOf('late')).toEqual(["The confirmation step's budget ran out first"])
    // Its own closing line, not the split-candidate one.
    expect(issue.body).toContain('this issue can be closed')
    expect(issue.body).not.toContain('what admitting one commits the project to')
  })

  it('a kind it does not know is reported under the generic one, never dropped', () => {
    const issue = buildConfirmationErrorIssue(
      [{ test: TEST, regions: { 'us-east-1': 'fail' }, error: 'odd', errorKind: 'mystery' }],
      { date: '2026-07-11' },
    )
    expect(issue.body).toContain('### The re-run could not be started')
    expect(issue.body).toContain('| odd |')
  })

  it('stays inside GitHub’s body limit, saying how many rows it left out', () => {
    const errored = Array.from({ length: 2000 }, (_, i) => ({
      test: { ...TEST, fullName: `test ${i} ${'x'.repeat(200)}` },
      regions: { 'us-east-1': 'fail' },
      error: 'e'.repeat(2000),
      errorKind: i % 2 ? 'timeout' : 'budget',
    }))
    const issue = buildConfirmationErrorIssue(errored, { date: '2026-07-11' })
    expect(issue.body.length).toBeLessThanOrEqual(65_536)
    expect(issue.body).toMatch(/\.\.\.and \d+ more, listed under `errored` in the sweep report artefact\./)
    expect(issue.body).toContain('this issue can be closed')
    // A body that already fits is left whole.
    const small = buildConfirmationErrorIssue(errored.slice(0, 3), { date: '2026-07-11' })
    expect(small.body).not.toContain('more, listed under')
  })

  it('cuts a cell at 500 characters, and a body that cannot fit even without rows to the limit', () => {
    const one = [{ test: TEST, regions: { 'us-east-1': 'fail' }, error: 'y'.repeat(600), errorKind: 'runner' }]
    const issue = buildConfirmationErrorIssue(one, { date: '2026-07-11' })
    expect(issue.body).toContain(`| ${'y'.repeat(500)}... |`)
    expect(issue.body).not.toContain('y'.repeat(501))
    expect(buildConfirmationErrorIssue(one, { date: '2026-07-11', limit: 100 }).body).toHaveLength(100)
  })

  it('annotates once per kind, with a count and the first few names', () => {
    const errored = [
      ...Array.from({ length: 12 }, (_, i) => ({ test: { ...TEST, fullName: `b${i}` }, error: 'x', errorKind: 'budget' })),
      { test: { ...TEST, fullName: 'gone' }, error: 'x', errorKind: 'not-found' },
      { test: { ...TEST, fullName: 'odd\nname' }, error: 'x', errorKind: 'mystery' },
    ]
    const lines = confirmationAnnotations(errored)
    expect(lines).toEqual([
      '::error title=Sweep confirmation::1 candidate(s) could not be re-run - the test is not on the checked-out commit: gone. The confirmation-error issue lists them all.',
      "::error title=Sweep confirmation::12 candidate(s) could not be re-run - the confirmation step's budget ran out first: b0; b1; b2, and 9 more. The confirmation-error issue lists them all.",
      '::error title=Sweep confirmation::1 candidate(s) could not be re-run - the re-run could not be started: odd name. The confirmation-error issue lists them all.',
    ])
  })
})

describe('fileIssue', () => {
  const issue = { title: 'Split candidate: x', labels: ['split-candidate'], body: 'b' }

  it('creates an issue when no open issue carries the title', () => {
    const calls = []
    const exec = (args) => {
      calls.push(args)
      return args[0] === 'issue' && args[1] === 'list' ? '[]' : ''
    }
    expect(fileIssue(issue, { exec })).toEqual({ action: 'created' })
    expect(calls.at(-1).slice(0, 2)).toEqual(['issue', 'create'])
  })

  it('comments on an existing open issue rather than duplicating it', () => {
    const calls = []
    const exec = (args) => {
      calls.push(args)
      return args[0] === 'issue' && args[1] === 'list'
        ? JSON.stringify([{ number: 7, title: issue.title }])
        : ''
    }
    expect(fileIssue(issue, { exec })).toEqual({ action: 'commented', number: 7 })
    expect(calls.at(-1).slice(0, 3)).toEqual(['issue', 'comment', '7'])
  })

  it('creates the confirmation-error label with its own description', () => {
    const calls = []
    const exec = (args) => {
      calls.push(args)
      return args[1] === 'list' ? '[]' : ''
    }
    fileIssue({ title: 't', labels: ['confirmation-error'], body: 'b' }, { exec })
    expect(calls[0]).toEqual([
      'label', 'create', 'confirmation-error',
      '--description', 'The sweep could not re-run a split candidate to confirm it',
      '--color', 'D93F0B',
    ])
  })
})

describe('a drifted row that matches again', () => {
  const match = { id: 'row-1', test: { file: TEST.file, fullName: TEST.fullName } }
  const body = buildMatchComment(match, {
    date: '2026-09-26',
    runUrl: 'https://github.com/o/r/actions/runs/1',
  })

  it('says the row matches again, with the sweep that saw it, and leaves closing to a human', () => {
    expect(body).toContain('matches again')
    expect(body).toContain('2026-09-26')
    expect(body).toContain('https://github.com/o/r/actions/runs/1')
    expect(body).toContain('registry/README.md')
  })

  it('comments on the open drift issue for the row, whichever kind it was filed as', () => {
    // The #179 case: filed as converged, and the row was accurate again by
    // the time a later sweep ran.
    const calls = []
    const exec = (args) => {
      calls.push(args)
      return args[0] === 'issue' && args[1] === 'list'
        ? JSON.stringify([
            { number: 3, title: 'Registry drift: row-10 (moved)' },
            { number: 179, title: 'Registry drift: row-1 (converged)' },
          ])
        : ''
    }
    expect(commentOnOpenDriftIssue(match, body, { exec })).toEqual({
      action: 'commented',
      numbers: [179],
    })
    expect(calls.at(-1)).toEqual(['issue', 'comment', '179', '--body', body])
  })

  it('does nothing when no drift issue is open for the row', () => {
    const calls = []
    const exec = (args) => {
      calls.push(args)
      return args[0] === 'issue' && args[1] === 'list'
        ? JSON.stringify([{ number: 3, title: 'Registry drift: row-10 (moved)' }])
        : ''
    }
    expect(commentOnOpenDriftIssue(match, body, { exec })).toEqual({ action: 'none', numbers: [] })
    expect(calls.some((a) => a[1] === 'comment' || a[1] === 'create')).toBe(false)
  })

  it('does not let a failed lookup stop the sweep: nothing is commented and nothing throws', () => {
    // These comments are a courtesy. A gh failure here used to throw out of
    // run() before the report was written or any candidate confirmed.
    const exec = (args) => {
      if (args[1] === 'list') throw new Error('gh issue list failed: HTTP 502')
      throw new Error('should not comment when the lookup failed')
    }
    const outcome = noteMatchesAgain([match], { date: '2026-09-26', exec })
    expect(outcome.noted).toEqual([])
    expect(outcome.failed).toEqual([{ id: 'row-1', error: 'gh issue list failed: HTTP 502' }])
  })

  it('carries on to the next row when one comment fails', () => {
    const other = { id: 'row-2', test: match.test }
    const exec = (args) => {
      if (args[1] === 'list') {
        return JSON.stringify([
          { number: 179, title: 'Registry drift: row-1 (converged)' },
          { number: 180, title: 'Registry drift: row-2 (moved)' },
        ])
      }
      if (args[2] === '179') throw new Error('gh issue comment failed: rate limited')
      return ''
    }
    const outcome = noteMatchesAgain([match, other], { date: '2026-09-26', exec })
    expect(outcome.failed).toEqual([{ id: 'row-1', error: 'gh issue comment failed: rate limited' }])
    expect(outcome.noted).toEqual([{ id: 'row-2', numbers: [180] }])
  })

  it('uses a list of open issues it is handed rather than asking again', () => {
    const calls = []
    const exec = (args) => {
      calls.push(args)
      return ''
    }
    const open = [{ number: 179, title: 'Registry drift: row-1 (converged)' }]
    expect(commentOnOpenDriftIssue(match, body, { exec, open })).toEqual({
      action: 'commented',
      numbers: [179],
    })
    expect(calls).toEqual([['issue', 'comment', '179', '--body', body]])
  })
})

describe('parseArgs', () => {
  it('refuses any output path that resolves to the split registry', () => {
    expect(() => parseArgs(['gt', '--out', 'registry/splits.json'])).toThrow(
      /only a human edits/,
    )
    expect(() =>
      parseArgs(['gt', '--record-health', './registry/../registry/splits.json']),
    ).toThrow(/only a human edits/)
  })

  it('still refuses the real registry when told to read a copy of it', () => {
    // The sweep now reads splits.json at the measured ref, out of a temp file,
    // so `--registry` no longer names the file in the repo. Comparing output
    // paths against `--registry` alone would leave the guard protecting the
    // scratch copy while `registry/splits.json` - the file this script's own
    // header promises never to write - went unchecked.
    expect(() =>
      parseArgs(['gt', '--registry', '/tmp/splits.json', '--out', 'registry/splits.json']),
    ).toThrow(/only a human edits/)
    expect(() =>
      parseArgs([
        'gt',
        '--registry',
        '/tmp/splits.json',
        '--record-health',
        './registry/../registry/splits.json',
      ]),
    ).toThrow(/only a human edits/)
    // And the copy it was told to read is still protected too, so neither the
    // scratch file nor the real one can be written over.
    expect(() =>
      parseArgs(['gt', '--registry', '/tmp/splits.json', '--out', '/tmp/splits.json']),
    ).toThrow(/only a human edits/)
  })

  it('rejects unknown options rather than ignoring them', () => {
    expect(() => parseArgs(['gt', '--frobnicate'])).toThrow(/unknown option/)
  })

  it('rejects an empty --expect: silently covering no regions is not an option', () => {
    expect(() => parseArgs(['gt', '--expect', ''])).toThrow(/at least one region/)
  })
})

// ── CLI integration: the script end to end, on fixtures, with no AWS ─────────

// A minimal Vitest-shaped results document.
function resultsDoc(assertions) {
  return {
    testResults: [
      {
        name: `/home/runner/work/suite/${TEST.file}`,
        assertionResults: assertions.map((a) => ({
          ...(a.ancestorTitles ? { ancestorTitles: a.ancestorTitles } : {}),
          title: a.title ?? TEST.title,
          fullName: a.fullName ?? TEST.fullName,
          status: a.status,
          meta: a.meta ?? {},
          failureMessages: a.failureMessages ?? [],
        })),
      },
    ],
  }
}

function writeFixtures(dir) {
  const gt = join(dir, 'ground-truth')
  const registryPath = join(dir, 'splits.json')
  const healthPath = join(dir, 'regions.json')
  spawnSync('mkdir', ['-p', gt])
  writeFileSync(
    join(gt, 'eu-west-2.json'),
    JSON.stringify(resultsDoc([{ status: 'passed' }])),
  )
  writeFileSync(
    join(gt, 'us-east-1.json'),
    JSON.stringify(
      resultsDoc([{ status: 'failed', failureMessages: ['ValidationException: nope'] }]),
    ),
  )
  writeFileSync(registryPath, JSON.stringify(rowFor({ ...TEST, fullName: 'some other test' }), null, 2))
  writeFileSync(
    healthPath,
    JSON.stringify({
      regions: { 'sa-east-1': { lastResolved: '2026-06-29', consecutiveUnresolved: 1 } },
    }),
  )
  return { gt, registryPath, healthPath }
}

// Every temp directory a test here makes, removed after it.
const madeDirs = []
const sweepTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
  madeDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runCli(args, cwd) {
  return spawnSync('node', [join(process.cwd(), 'scripts/sweep-detect.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  })
}

describe('run: write ordering under confirmation', () => {
  it('the health record and an initial report land before any confirmation run, and the report is rewritten after', async () => {
    const dir = sweepTmp()
    const { gt, registryPath, healthPath } = writeFixtures(dir)
    const out = join(dir, 'report.json')
    const args = parseArgs([
      gt,
      '--registry', registryPath,
      '--record-health', healthPath,
      '--expect', 'eu-west-2,us-east-1',
      '--date', '2026-07-11',
      '--out', out,
      '--confirm',
      '--confirm-runs', '2',
    ])

    // Snapshot both files at the moment confirmation FIRST runs: a job
    // timeout mid-confirmation must already have both on disk.
    let observed = null
    const runTests = perTest(() => {
      observed ??= {
        health: JSON.parse(readFileSync(healthPath, 'utf8')),
        report: JSON.parse(readFileSync(out, 'utf8')),
      }
      return 'fail'
    })
    await run(args, { runTests })

    expect(observed).not.toBeNull()
    expect(observed.health.regions['eu-west-2']).toEqual({
      lastResolved: '2026-07-11',
      consecutiveUnresolved: 0,
    })
    expect(observed.report.confirmationState).toBe('pending')
    expect(observed.report.candidates).toHaveLength(1)
    expect(observed.report.confirmed).toEqual([])

    const final = JSON.parse(readFileSync(out, 'utf8'))
    expect(final.confirmationState).toBe('complete')
    expect(final.confirmed).toHaveLength(1)
    expect(final.confirmed[0].confirmation).toEqual({ runs: 2, regions: ['us-east-1'] })
  })
})

describe('run: confirmation end to end, in process', () => {
  // Fixture regions whose results carry name parts, as a real sweep's do.
  const withNames = (dir) => {
    const paths = writeFixtures(dir)
    const named = (status, failureMessages = []) =>
      resultsDoc([{ status, failureMessages, ancestorTitles: NAMES.slice(0, -1), title: NAMES.at(-1) }])
    writeFileSync(join(paths.gt, 'eu-west-2.json'), JSON.stringify(named('passed')))
    writeFileSync(join(paths.gt, 'us-east-1.json'), JSON.stringify(named('failed', ['ValidationException: nope'])))
    return paths
  }
  const argsFor = (dir, { gt, registryPath, healthPath }, extra = []) =>
    parseArgs([
      gt,
      '--registry', registryPath,
      '--record-health', healthPath,
      '--expect', 'eu-west-2,us-east-1,sa-east-1',
      '--date', '2026-07-11',
      '--out', join(dir, 'report.json'),
      '--confirm',
      '--confirm-runs', '2',
      ...extra,
    ])
  const logged = async (fn) => {
    const lines = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')))
    try {
      return { result: await fn(), out: lines.join('\n') }
    } finally {
      spy.mockRestore()
    }
  }
  // A spawn that must never be reached.
  const noSpawn = () => {
    throw new Error('spawned')
  }

  it('a candidate that cannot be re-run is reported, annotated and filed, and the run returns normally', async () => {
    // The fixture results carry no name parts, so the real runner cannot
    // build a selector and errors before it spawns anything.
    const dir = sweepTmp()
    const paths = writeFixtures(dir)
    const { result, out } = await logged(() => run(argsFor(dir, paths), { spawn: noSpawn }))
    // The sweep gates nothing, and a red run on main's head would hold up the
    // release: the annotation and the issue are the signal, not the exit status.
    expect(result).toEqual({ errored: 1, attempts: 1 })
    expect(out).toContain('(0 confirmed, 0 discarded, 1 could not be re-run; 1 re-run attempt(s))')
    expect(out).toContain(
      `::error title=Sweep confirmation::1 candidate(s) could not be re-run - the re-run could not pick out exactly this test: ${TEST.fullName}.`,
    )
    expect(out).toContain('would file: Sweep confirmation could not re-run every candidate [confirmation-error]')
    // The rest of the sweep's findings still landed: the page, the health
    // record and the complete report.
    expect(out).toContain('would file: Region dropped from the observed set: sa-east-1')
    expect(JSON.parse(readFileSync(paths.healthPath, 'utf8')).regions['eu-west-2'].lastResolved).toBe('2026-07-11')
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.confirmationState).toBe('complete')
    expect(report.discarded).toEqual([])
    expect(report.errored).toHaveLength(1)
    expect(report.errored[0].error).toMatch(/carry no name parts/)
    expect(report.errored[0].errorKind).toBe('selection')
  })

  it('passes --measured-ref to the runner, to name the commit a missing test was measured on', async () => {
    const dir = sweepTmp()
    const paths = withNames(dir)
    const fake = fakeVitest({ listing: () => [] })
    await logged(() => run(argsFor(dir, paths, ['--measured-ref', 'abc1234']), { spawn: fake.spawn }))
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.errored[0].errorKind).toBe('not-found')
    expect(report.errored[0].error).toMatch(/renamed or removed since abc1234$/)
  })

  it('passes the confirmation budget through: a one-minute budget stops after one minute-long attempt', async () => {
    const dir = sweepTmp()
    const paths = withNames(dir)
    let clock = 0
    const runTests = perTest(() => {
      clock += 61_000
      return 'fail'
    })
    const { result } = await logged(() =>
      run(argsFor(dir, paths, ['--confirm-budget-minutes', '1']), { runTests, now: () => clock }),
    )
    expect(result).toEqual({ errored: 1, attempts: 1 })
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.errored[0].errorKind).toBe('budget')
    expect(report.errored[0].error).toMatch(/1-minute budget/)
  })

  it('a gh failure filing the confirmation-error issue is annotated, and the run and its report survive', async () => {
    const dir = sweepTmp()
    const paths = writeFixtures(dir)
    const exec = (args) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]'
      if (args[1] === 'create' && args.includes('confirmation-error')) throw new Error('HTTP 422: body is too long')
      return ''
    }
    const { result, out } = await logged(() =>
      run({ ...argsFor(dir, paths), fileIssues: true }, { spawn: noSpawn, exec }),
    )
    expect(result.errored).toBe(1)
    expect(out).toContain('created: Region dropped from the observed set: sa-east-1')
    expect(out).toContain(
      '::error title=Sweep confirmation::could not file the confirmation-error issue: HTTP 422: body is too long',
    )
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).confirmationState).toBe('complete')
  })
})

describe('parseArgs: the confirmation budget', () => {
  it('reads --confirm-budget-minutes, then SWEEP_CONFIRM_BUDGET_MINUTES, then 75', () => {
    const saved = process.env.SWEEP_CONFIRM_BUDGET_MINUTES
    try {
      delete process.env.SWEEP_CONFIRM_BUDGET_MINUTES
      expect(parseArgs(['gt']).confirmBudgetMinutes).toBe(75)
      process.env.SWEEP_CONFIRM_BUDGET_MINUTES = '30'
      expect(parseArgs(['gt']).confirmBudgetMinutes).toBe(30)
      expect(parseArgs(['gt', '--confirm-budget-minutes', '4.1']).confirmBudgetMinutes).toBe(4.1)
    } finally {
      if (saved === undefined) delete process.env.SWEEP_CONFIRM_BUDGET_MINUTES
      else process.env.SWEEP_CONFIRM_BUDGET_MINUTES = saved
    }
  })

  it('refuses a re-run count that is not a positive whole number', () => {
    expect(parseArgs(['gt', '--confirm-runs', '3']).confirmRuns).toBe(3)
    for (const bad of ['0', '-1', 'NaN', '2.5', 'five']) {
      expect(() => parseArgs(['gt', '--confirm-runs', bad]), bad).toThrow(/^usage: --confirm-runs/)
    }
  })

  it('refuses a budget that is not a positive number of minutes', () => {
    for (const bad of ['0', '-5', 'soon', 'NaN']) {
      expect(() => parseArgs(['gt', '--confirm-budget-minutes', bad]), bad).toThrow(/positive number of minutes/)
    }
  })
})

describe('the CLI, end to end on fixtures', () => {
  it('detects, reports, records health, and never touches the split registry', () => {
    const dir = sweepTmp()
    const { gt, registryPath, healthPath } = writeFixtures(dir)
    const registryBefore = readFileSync(registryPath, 'utf8')

    const res = runCli(
      [
        gt,
        '--registry', registryPath,
        '--record-health', healthPath,
        '--expect', 'eu-west-2,us-east-1,sa-east-1',
        '--date', '2026-07-11',
        '--out', join(dir, 'report.json'),
      ],
      dir,
    )
    expect(res.status, res.stderr).toBe(0)

    // The integrity guarantee, asserted directly: the registry is byte-identical.
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore)

    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    // Two resolved regions disagree on the one test: one unconfirmed candidate.
    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0].regions).toEqual({ 'eu-west-2': 'pass', 'us-east-1': 'fail' })
    expect(report.confirmed).toEqual([])
    // A region the sweep was meant to cover but produced nothing is unresolved,
    // never silent.
    expect(report.regions['sa-east-1'].resolved).toBe(false)
    expect(report.regions['sa-east-1'].reasons[0].kind).toBe('missing-results')
    expect(report.regions['sa-east-1'].failures).toEqual([])

    // Health recorded: the second consecutive miss drops sa-east-1 and pages in
    // the same act; the resolved regions reset to zero.
    const health = JSON.parse(readFileSync(healthPath, 'utf8'))
    expect(health.regions['sa-east-1']).toEqual({
      lastResolved: '2026-06-29',
      consecutiveUnresolved: 2,
    })
    expect(health.regions['eu-west-2']).toEqual({
      lastResolved: '2026-07-11',
      consecutiveUnresolved: 0,
    })
    expect(report.pages).toEqual([
      { region: 'sa-east-1', reasons: report.regions['sa-east-1'].reasons },
    ])

    // Without --file-issues the page issue is a dry run on stdout; without
    // --confirm the unconfirmed candidate files nothing.
    expect(res.stdout).toContain('would file: Region dropped from the observed set: sa-east-1')
    expect(res.stdout).not.toContain('would file: Split candidate')
    expect(res.stdout).toContain('1 split candidate(s) (unconfirmed)')
  })

  it('without --confirm the CLI never re-runs anything: confirmation is tested in process', () => {
    // Every confirmation test runs `run` in this process with an injected
    // runner or spawn, so none can reach the real suite with whatever AWS
    // credentials the developer has. This one only pins that the CLI path
    // stays opt-in.
    expect(parseArgs(['gt']).confirm).toBe(false)
  })

  it('a region failing only an admitted-split test resolves: admission must never spend the sick budget', () => {
    const dir = sweepTmp()
    const { gt, registryPath } = writeFixtures(dir)
    // Point the registry row at the fixture test itself: us-east-1's failure
    // is now a recorded regional difference, matching the row's rejected side.
    writeFileSync(registryPath, JSON.stringify(rowFor(), null, 2))

    const res = runCli(
      [
        gt,
        '--registry', registryPath,
        '--expect', 'eu-west-2,us-east-1',
        '--date', '2026-07-11',
        '--out', join(dir, 'report.json'),
      ],
      dir,
    )
    expect(res.status, res.stderr).toBe(0)

    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.regions['us-east-1'].resolved).toBe(true)
    expect(report.regions['us-east-1'].counts).toMatchObject({ failed: 1, explainedFailed: 1 })
    // The resolved region's admitted-split failure is the report's
    // cohort-membership evidence, carrying the row it matched.
    expect(report.regions['us-east-1'].failures).toEqual([
      { file: TEST.file, fullName: TEST.fullName, explained: true, rowId: 'row-1' },
    ])
    // The admitted disagreement is not a fresh candidate, and behaving as
    // recorded is not drift.
    expect(report.candidates).toEqual([])
    expect(report.drift).toEqual([])
  })

  it('reports a row that matches, and would note it on an open drift issue, without touching the registry', () => {
    const dir = sweepTmp()
    const { gt, registryPath } = writeFixtures(dir)
    // The fixture regions answer exactly as the row records: eu-west-2 on the
    // pinned side, us-east-1 off it.
    writeFileSync(registryPath, JSON.stringify(rowFor(), null, 2))
    const registryBefore = readFileSync(registryPath, 'utf8')

    const res = runCli(
      [
        gt,
        '--registry', registryPath,
        '--expect', 'eu-west-2,us-east-1',
        '--date', '2026-09-26',
        '--out', join(dir, 'report.json'),
      ],
      dir,
    )
    expect(res.status, res.stderr).toBe(0)
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore)
    expect(res.stdout).toContain(
      'would comment "matches again" on an open drift issue for row-1, if there is one',
    )
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.drift).toEqual([])
    expect(report.matching).toEqual([{ id: 'row-1', test: { file: TEST.file, fullName: TEST.fullName } }])
  })

  it('surfaces drift on an admitted row as an issue body, still without touching the registry', () => {
    const dir = sweepTmp()
    const { gt, registryPath } = writeFixtures(dir)
    // Re-point the registry at the fixture test, recorded as split - but both
    // fixture regions... first make them both pass so the row has converged.
    writeFileSync(registryPath, JSON.stringify(rowFor(), null, 2))
    writeFileSync(
      join(gt, 'us-east-1.json'),
      JSON.stringify(resultsDoc([{ status: 'passed' }])),
    )
    const registryBefore = readFileSync(registryPath, 'utf8')

    const res = runCli(
      [gt, '--registry', registryPath, '--date', '2026-07-11', '--out', join(dir, 'report.json')],
      dir,
    )
    expect(res.status, res.stderr).toBe(0)
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore)
    expect(res.stdout).toContain('would file: Registry drift: row-1 (converged)')
    // The converged test is not simultaneously a fresh candidate.
    expect(res.stdout).toContain('0 split candidate(s)')
    // The persisted report carries the classification a downstream consumer
    // reads, direction included.
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.drift).toHaveLength(1)
    expect(report.drift[0]).toMatchObject({ kind: 'converged', convergedOn: 'pinned' })
  })

  it('a full off-pinned collapse reaches the report and the issue as converged, end to end', () => {
    const dir = sweepTmp()
    const { gt, registryPath } = writeFixtures(dir)
    // The #91 shape through the whole pipeline: the pinned region joins the
    // fail side, so every named region fails the committed assertion.
    writeFileSync(registryPath, JSON.stringify(rowFor(), null, 2))
    writeFileSync(
      join(gt, 'eu-west-2.json'),
      JSON.stringify(
        resultsDoc([{ status: 'failed', failureMessages: ['ValidationException: nope'] }]),
      ),
    )
    const registryBefore = readFileSync(registryPath, 'utf8')

    const res = runCli(
      [gt, '--registry', registryPath, '--date', '2026-07-11', '--out', join(dir, 'report.json')],
      dir,
    )
    expect(res.status, res.stderr).toBe(0)
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore)
    expect(res.stdout).toContain('would file: Registry drift: row-1 (converged)')
    expect(res.stdout).toContain('every region has left the pinned side')
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.drift).toHaveLength(1)
    expect(report.drift[0]).toMatchObject({ kind: 'converged', convergedOn: 'off-pinned' })
  })
})

describe('the evidence a candidate is admitted from', () => {
  it('survives serialisation: the suite does not truncate failure messages', () => {
    // buildCandidateIssue quotes failureMessages verbatim, and a row is
    // admitted from what a region answered, never from the verdict alone.
    // Chai truncates a diff at 40 characters by default, which recorded every
    // answer as "1 validation error detected: Value at…" - so the sweep could
    // prove four regions disagreed while describing what none of them said,
    // and the candidate it raised could not be acted on. A grep, because the
    // failure mode is silent: nothing errors, the evidence is just absent.
    const config = readFileSync('vitest.config.ts', 'utf8')
    const threshold = config.match(/truncateThreshold:\s*(\d+)/)
    expect(
      threshold,
      'vitest.config.ts sets no chaiConfig.truncateThreshold, so chai cuts every recorded answer to 40 characters',
    ).not.toBeNull()
    expect(
      Number(threshold[1]),
      'truncateThreshold is below the length of a real validation message, so the evidence is still being cut',
    ).toBeGreaterThanOrEqual(500)
  })
})
