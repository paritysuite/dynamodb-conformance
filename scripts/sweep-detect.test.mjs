import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitFor } from './lib/registry.mjs'
import {
  buildCandidateIssue,
  buildDriftIssue,
  buildMatchComment,
  buildPageIssue,
  commentOnOpenDriftIssue,
  confirmCandidates,
  detectMatchingRows,
  detectRegistryDrift,
  detectSplitCandidates,
  evidenceFor,
  fileIssue,
  noteMatchesAgain,
  parseArgs,
  relativeTestFile,
  reportFailures,
  run,
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

describe('confirmCandidates', () => {
  const candidate = { test: TEST, regions: { 'eu-west-2': 'pass', 'us-east-1': 'fail' } }

  it('confirms a candidate every fail-side re-run reproduces, and never re-runs the pass side', async () => {
    const calls = []
    const runTest = (region) => {
      calls.push(region)
      return 'fail'
    }
    const { confirmed, discarded } = await confirmCandidates([candidate], { runs: 3, runTest })
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0].confirmation).toEqual({ runs: 3, regions: ['us-east-1'] })
    expect(discarded).toEqual([])
    // Targeted: only the divergent side, only that test, runs× each.
    expect(calls.filter((r) => r === 'us-east-1')).toHaveLength(3)
    expect(calls.filter((r) => r === 'eu-west-2')).toHaveLength(0)
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
    const calls = []
    const runTest = (region) => {
      calls.push(region)
      return 'fail'
    }
    const { confirmed } = await confirmCandidates([wide], { runs: 5, runTest })
    expect(calls).toHaveLength(10)
    expect(new Set(calls)).toEqual(new Set(['us-east-1', 'ap-southeast-2']))
    expect(confirmed[0].confirmation.regions).toEqual(['ap-southeast-2', 'us-east-1'])
  })

  it('discards a candidate that fails to reproduce: it was non-determinism, not a split', async () => {
    let n = 0
    const runTest = () => (++n === 2 ? 'pass' : 'fail')
    const { confirmed, discarded } = await confirmCandidates([candidate], { runs: 3, runTest })
    expect(confirmed).toEqual([])
    expect(discarded).toHaveLength(1)
    expect(discarded[0].reason).toMatch(/us-east-1 returned pass/)
  })

  it('an indeterminate re-run discards the candidate: absence cannot confirm anything', async () => {
    const runTest = () => 'indeterminate'
    const { confirmed, discarded } = await confirmCandidates([candidate], { runs: 5, runTest })
    expect(confirmed).toEqual([])
    expect(discarded).toHaveLength(1)
  })

  it('a candidate with no fail-side region breaks the caller contract loudly', async () => {
    const noFailSide = { test: TEST, regions: { 'eu-west-2': 'pass', 'us-east-1': 'pass' } }
    await expect(
      confirmCandidates([noFailSide], { runs: 5, runTest: () => 'fail' }),
    ).rejects.toThrow(/no fail-side region/)
  })

  it('reports progress after every candidate, so a checkpoint can persist decided ones', async () => {
    const a = { test: TEST, regions: { 'eu-west-2': 'pass', 'us-east-1': 'fail' } }
    const b = {
      test: { ...TEST, fullName: 'another split test' },
      regions: { 'eu-west-2': 'pass', 'ap-southeast-2': 'fail' },
    }
    const snapshots = []
    await confirmCandidates([a, b], {
      runs: 1,
      runTest: () => 'fail',
      onProgress: (p) => snapshots.push(p.confirmed.length),
    })
    expect(snapshots).toEqual([1, 2])
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
          title: TEST.title,
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

function runCli(args, cwd) {
  return spawnSync('node', [join(process.cwd(), 'scripts/sweep-detect.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  })
}

describe('run: write ordering under confirmation', () => {
  it('the health record and an initial report land before any confirmation run, and the report is rewritten after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
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
    const runTest = () => {
      observed ??= {
        health: JSON.parse(readFileSync(healthPath, 'utf8')),
        report: JSON.parse(readFileSync(out, 'utf8')),
      }
      return 'fail'
    }
    await run(args, { runTest })

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

describe('the CLI, end to end on fixtures', () => {
  it('detects, reports, records health, and never touches the split registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
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

  it('a region failing only an admitted-split test resolves: admission must never spend the sick budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
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
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
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
