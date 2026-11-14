import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isTargetResultFile } from './lib/score.mjs'
import { committedGradingInputs } from './lib/measured.mjs'
import { enumerationArgs, enumerationEnv, readManifest, staleReport, suiteIdentities, suiteSizeOf } from './suite-manifest.mjs'
import { assertMeasuredSuite, assertOneDenominator, readTargets } from './summarise.mjs'

const MANIFEST = readManifest()

// The tests a committed run may name: those the suite defined at the commit the
// board was measured at, not this tree's. One function so that the check below
// and the test pinning its source cannot disagree.
const committedSuite = (options) => suiteIdentities(committedGradingInputs(undefined, options).manifest)

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

  // A committed run and the manifest it was measured against are two
  // inventories of the same suite, so a run naming a test that manifest does
  // not define is a stale or forged row. Calls the publishing gate rather than
  // restating it, so the two cannot drift apart.
  //
  // The manifest is the one at the measured ref, not this tree's. Main runs
  // ahead of the released suite, so grading the committed runs against main's
  // manifest would refuse every rename or removal of a released test until a
  // release re-measured the board, and a release cannot be cut from a red main.
  // That main's own manifest matches main's own tests is `suite:manifest:check`.
  it('names the same tests every committed run does', () => {
    const files = readdirSync('results').filter(isTargetResultFile)
    expect(files.length, 'no committed results to check').toBeGreaterThan(0)
    expect(() =>
      assertMeasuredSuite(readTargets(files.map((f) => join('results', f))), committedSuite()),
    ).not.toThrow()
  })

  it('takes those tests from the measured commit, not from main', () => {
    const renamed = `${MANIFEST.tests[0]} (as released)`
    const git = (spec) =>
      spec.endsWith('suite-manifest.json')
        ? JSON.stringify({ ...MANIFEST, tests: [renamed, ...MANIFEST.tests.slice(1)] })
        : readFileSync('registry/splits.json', 'utf8')
    const suite = committedSuite({ git })
    expect(suite.has(renamed)).toBe(true)
    expect(suite.has(MANIFEST.tests[0])).toBe(false)
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

describe('the enumeration run', () => {
  it('names no target and no results directory, and cannot reach a database', () => {
    const env = enumerationEnv('/scratch', {
      PATH: '/bin',
      CONFORMANCE_TARGET: 'dynoxide',
      CONFORMANCE_RESULTS_DIR: 'results',
      CONFORMANCE_RETRY: '2',
      DYNAMODB_ENDPOINT: 'http://localhost:8000',
      AWS_PROFILE: 'prod',
      AWS_SESSION_TOKEN: 'token',
      AWS_ENDPOINT_URL_DYNAMODB: 'https://dynamodb.eu-west-2.amazonaws.com',
    })
    expect(env).toEqual({
      PATH: '/bin',
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:1',
      CONFORMANCE_RESULTS_DIR: '/scratch',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'fakeAccessKeyId',
      AWS_SECRET_ACCESS_KEY: 'fakeSecretAccessKey',
    })
  })

  it('keeps its collection run out of the results cache', () => {
    expect(enumerationArgs('/scratch/out.json')).toContain('--no-cache')
  })

  // The run executes the suite, so its run-level sidecar (globalSetup clears
  // it, the dead endpoint rewrites it) lands wherever the caller's environment
  // says. Each case is one real enumeration, run side by side to keep the
  // wall time to a single run's.
  it('leaves results/ and a caller\'s results directory exactly as they were', async () => {
    const snapshot = (dir) =>
      Object.fromEntries(
        readdirSync(dir)
          .filter((f) => statSync(join(dir, f)).isFile())
          .sort()
          .map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]),
      )

    let requests = 0
    const server = createServer((req, res) => {
      requests += 1
      res.writeHead(500).end()
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const live = `http://127.0.0.1:${server.address().port}`

    const callerDir = mkdtempSync(join(tmpdir(), 'suite-manifest-caller-'))
    writeFileSync(join(callerDir, 'local.indeterminate.json'), '{"real":"local"}\n')
    writeFileSync(join(callerDir, 'x.indeterminate.json'), '{"real":"x"}\n')

    // The children's own temp dir, so a leftover there can only be theirs.
    const childTmp = mkdtempSync(join(tmpdir(), 'suite-manifest-children-'))

    const bare = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(CONFORMANCE_|AWS_|DYNAMODB_)/.test(name)),
    )
    bare.TMPDIR = childTmp
    const cases = {
      neither: bare,
      target: {
        ...bare,
        CONFORMANCE_TARGET: 'x',
        // A caller pointed at a live endpoint, with credentials of its own.
        DYNAMODB_ENDPOINT: live,
        AWS_ENDPOINT_URL: live,
        AWS_ENDPOINT_URL_DYNAMODB: live,
        AWS_ACCESS_KEY_ID: 'AKIACALLER',
        AWS_SECRET_ACCESS_KEY: 'caller',
        AWS_SESSION_TOKEN: 'caller',
        AWS_PROFILE: 'caller',
        AWS_REGION: 'eu-west-2',
      },
      resultsDir: { ...bare, CONFORMANCE_RESULTS_DIR: callerDir },
      both: { ...bare, CONFORMANCE_TARGET: 'x', CONFORMANCE_RESULTS_DIR: callerDir },
    }

    const script = resolve('scripts/suite-manifest.mjs')
    const enumerate = (env) =>
      promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', `const m = await import(${JSON.stringify(script)}); process.stdout.write(JSON.stringify(m.enumerateSuite()))`],
        { env, maxBuffer: 64 * 1024 * 1024 },
      ).then(({ stdout }) => JSON.parse(stdout))

    // The only names a regressed enumeration writes under results/: the
    // sidecar for the scratch slug and for the target the cases name.
    const strays = ['local.indeterminate.json', 'x.indeterminate.json'].filter(
      (f) => !existsSync(join('results', f)),
    )
    const resultsBefore = snapshot('results')
    const callerBefore = snapshot(callerDir)
    try {
      const names = Object.keys(cases)
      const runs = await Promise.all(names.map((name) => enumerate(cases[name])))
      expect(snapshot('results')).toEqual(resultsBefore)
      expect(snapshot(callerDir)).toEqual(callerBefore)
      expect(requests).toBe(0)
      expect(readdirSync(childTmp).filter((f) => f.startsWith('suite-manifest-'))).toEqual([])
      for (const [i, ids] of runs.entries()) {
        expect(ids, `${names[i]} enumerated a different suite from neither`).toEqual(runs[0])
      }
      expect(runs[0], 'registry/suite-manifest.json is stale. Run: npm run suite:manifest').toEqual(MANIFEST.tests)
    } finally {
      server.close()
      rmSync(callerDir, { recursive: true, force: true })
      rmSync(childTmp, { recursive: true, force: true })
      // Undo only what a regressed enumeration would have left, so a red run
      // here does not go on to mark a target not scored. Anything else new in
      // results/ belongs to someone else's run.
      for (const f of strays) rmSync(join('results', f), { force: true })
    }
  }, 120_000)
})
