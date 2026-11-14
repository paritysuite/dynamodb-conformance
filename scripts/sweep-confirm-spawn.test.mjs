// The sweep's confirmation re-run selection, asked of vitest for real. Kept
// apart from sweep-detect.test.mjs so these few spawns run beside the rest of
// the tooling tests rather than after them.
//
// The selection tests run against a fixture config that loads only
// scripts/fixtures/sweep-confirm/names.fixture.mjs: no suite setup, no
// endpoint, no network. One lists a real suite file, and proves the listing
// sends nothing to the endpoint the environment names. The last stops a
// plain node process on its time limit and checks the worker it started
// went with it, and the spawnGroup tests after it use plain node processes.
import { spawn as spawnAsync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listSelected, makeVitestRunner, spawnGroup, testNamePattern, testNamesPattern } from './sweep-detect.mjs'

const FIXTURE_DIR = 'scripts/fixtures/sweep-confirm'
const FIXTURE_FILE = `${FIXTURE_DIR}/names.fixture.mjs`
const FIXTURE_ARGS = ['--config', `${FIXTURE_DIR}/vitest.config.mjs`]
const list = (pattern) => listSelected({ file: FIXTURE_FILE, pattern, vitestArgs: FIXTURE_ARGS })
const joined = (names) => names.join(' > ')

// Every fixture test's name parts, as the sweep reads them: from a JSON run's
// ancestorTitles and title.
let everyTest
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-fixture-'))
  const out = join(dir, 'names.json')
  try {
    spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', FIXTURE_FILE, ...FIXTURE_ARGS, `--outputFile=${out}`],
      { encoding: 'utf8' },
    )
    everyTest = JSON.parse(readFileSync(out, 'utf8')).testResults[0].assertionResults.map((a) => [
      ...a.ancestorTitles,
      a.title,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

describe('confirmation re-run selection, asked of vitest', () => {
  it('selects every fixture test exactly once, except names two tests share', async () => {
    expect(everyTest).toHaveLength(27)
    const distinct = [...new Map(everyTest.map((n) => [joined(n), n])).values()]
    const selected = await list(testNamesPattern(distinct))
    const counts = Object.fromEntries(distinct.map((n) => [joined(n), 0]))
    for (const s of selected) {
      expect(s.file).toBe(FIXTURE_FILE)
      counts[s.name]++
    }
    const shared = ['duplicates > same name', 'collides > here > x']
    for (const [name, count] of Object.entries(counts)) {
      expect(count, JSON.stringify(name)).toBe(shared.includes(name) ? 2 : 1)
    }
    // The awkward ones are all there to be counted.
    for (const name of [
      'describe.each alpha > runs once per row',
      'formatted names > index 1 of the list',
      'formatted names > object { a: 1, b: [ 2 ] }',
      'formatted names > json {"a":1,"b":"two"}',
      'formatted names > template k.v and 2',
      'whitespace >   leading spaces',
      'whitespace > trailing spaces  ',
      'whitespace > double  spaces',
      'whitespace > a newline\nin the name',
      'parameterised > reads key a',
    ]) {
      expect(counts[name], JSON.stringify(name)).toBe(1)
    }
  }, 60_000)

  it('selects a name that prefixes another without the longer one', async () => {
    const short = [
      ['a top-level test'],
      ['parameterised', 'reads key a'],
      ['parameterised', 'handles 1 items'],
      ['whitespace', 'double spaces'],
      ['Item size limit by surface — UpdateItem', 'charges each kind of clause', 'charges a REMOVE one byte plus its path'],
    ]
    expect((await list(testNamesPattern(short))).map((s) => s.name).sort()).toEqual(short.map(joined).sort())
  }, 60_000)

  it('a pattern built from the space-joined name selects nothing at all', async () => {
    const names = ['Item size limit by surface — UpdateItem', 'charges each kind of clause', 'charges a REMOVE one byte plus its path']
    const spaceJoined = names.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    expect(await list(spaceJoined)).toEqual([])
    expect(await list(testNamePattern(names))).toHaveLength(1)
  }, 60_000)

  it('the runner re-runs a group in one process, and tells a missing test apart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-runner-'))
    const names = new Map([
      ['a', ['a top-level test']],
      ['b', ['whitespace', 'a newline\nin the name']],
      ['c', ['formatted names', 'template k.v and 2']],
      ['gone', ['renamed since the sweep']],
    ])
    const tests = [...names.keys()].map((k) => ({ file: FIXTURE_FILE, fullName: names.get(k).join(' '), k }))
    const runTests = makeVitestRunner({
      namesFor: (t) => names.get(t.k),
      vitestArgs: FIXTURE_ARGS,
      tmpRoot: root,
      measuredRef: 'v0.0.0',
    })
    try {
      const results = await runTests('eu-west-2', tests)
      const by = (k) => results.get(`${FIXTURE_FILE}\n${tests.find((t) => t.k === k).fullName}`)
      expect(by('a')).toEqual({ verdict: 'pass' })
      expect(by('b')).toEqual({ verdict: 'pass' })
      expect(by('c')).toEqual({ verdict: 'pass' })
      expect(by('gone')).toMatchObject({ kind: 'not-found' })
      expect(by('gone').error).toMatch(/renamed or removed since v0\.0\.0$/)
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
// Poll until no pid in the list is running, with a generous bound for a slow
// machine; the caller asserts on what is left.
async function awaitGone(pids) {
  for (let i = 0; i < 400 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 25))
  return pids.filter(alive)
}
const nodeScript = (code) => [process.execPath, ['-e', code]]

describe('a re-run stopped on its time limit', () => {
  // A parent that starts a worker of its own and waits, the shape of vitest
  // and its forks pool: the worker records its pid, and both would sleep for
  // half a minute if nothing stopped them.
  const parent = (pidFile) => `
    const { spawn } = require('node:child_process')
    spawn(process.execPath, ['-e', ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000)`,
    )}], { stdio: 'ignore' })
    setTimeout(() => {}, 30_000)`

  it('takes the worker its process started down with it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-kill-'))
    const pidFile = join(root, 'worker.pid')
    let pid = null
    try {
      // A few hundred milliseconds is usually enough for the worker to start;
      // on a slow machine the limit doubles until it has, so the kill is
      // always tested against a worker that exists.
      let res
      for (let limit = 300; !existsSync(pidFile) && limit <= 20_000; limit *= 2) {
        res = await spawnGroup(process.execPath, ['-e', parent(pidFile)], { timeout: limit })
      }
      expect(res.timedOut).toBe(true)
      // Stopped by the kill, not by running out of things to do.
      expect(res.signal).toBe('SIGKILL')
      pid = Number(readFileSync(pidFile, 'utf8'))
      expect(pid).toBeGreaterThan(0)
      // SIGKILL is immediate, but reaping is not: poll for the exit, with a
      // generous bound for a slow machine and no claim about how long it takes.
      for (let i = 0; i < 200 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25))
      expect(alive(pid), `worker ${pid} survived its re-run`).toBe(false)
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('the real runner, listing and re-run alike, leaves no process behind once vitest exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-orphan-'))
    const pidFile = join(root, 'stray.pid')
    const saved = process.env.SWEEP_ORPHAN_PID_FILE
    process.env.SWEEP_ORPHAN_PID_FILE = pidFile
    let pids = []
    try {
      const test = { file: `${FIXTURE_DIR}/orphan.fixture.mjs`, fullName: 'leaves a process behind' }
      const runTests = makeVitestRunner({
        namesFor: () => ['leaves a process behind'],
        vitestArgs: FIXTURE_ARGS,
        tmpRoot: root,
      })
      const results = await runTests('eu-west-2', [test])
      expect(results.get(`${test.file}\n${test.fullName}`)).toEqual({ verdict: 'pass' })
      // And a listing on its own, through listSelected's own default.
      expect(await listSelected({ file: test.file, vitestArgs: FIXTURE_ARGS, tmpRoot: root })).toHaveLength(1)
      // One stray from each listing, one from the re-run.
      pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)
      expect(pids).toHaveLength(3)
      for (let i = 0; i < 200 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 25))
      expect(pids.filter(alive), 'strays still running').toEqual([])
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
      if (saved === undefined) delete process.env.SWEEP_ORPHAN_PID_FILE
      else process.env.SWEEP_ORPHAN_PID_FILE = saved
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('listing a real suite file', () => {
  // A logging endpoint in its own process (a spawnSync would block one in
  // this process from ever answering): it counts every request it receives.
  let server
  let url
  const requests = () => fetch(`${url}/__count`).then((r) => r.json())
  beforeAll(async () => {
    server = spawnAsync(
      process.execPath,
      [
        '-e',
        `let n = 0
        const s = require('node:http').createServer((req, res) => {
          if (req.url === '/__count') return res.end(JSON.stringify(n))
          n++
          res.statusCode = 500
          res.end('{}')
        })
        s.listen(0, '127.0.0.1', () => console.log(s.address().port))`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const port = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())))
    url = `http://127.0.0.1:${port}`
  })
  afterAll(() => server?.kill())

  it('sends nothing to the endpoint in the environment, and is read despite the failing teardown', async () => {
    const selected = await listSelected({
      file: 'tests/tier1/listTables/basic.test.ts',
      env: { ...process.env, DYNAMODB_ENDPOINT: url },
    })
    expect(selected.length).toBeGreaterThan(0)
    expect(new Set(selected.map((s) => s.file))).toEqual(new Set(['tests/tier1/listTables/basic.test.ts']))
    expect(await requests()).toBe(0)
    // The endpoint does count: a request to it is seen.
    await fetch(`${url}/`, { method: 'POST' })
    expect(await requests()).toBe(1)
  }, 60_000)
})

describe('spawnGroup', () => {
  const SWEEP_DETECT = pathToFileURL(join(process.cwd(), 'scripts/sweep-detect.mjs')).href
  let root
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sweep-group-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('keeps the end of a long output, not the start', async () => {
    const res = await spawnGroup(
      ...nodeScript(`process.stdout.write('x'.repeat(5 * 1024 * 1024) + '\\nMARKER\\n')`),
      { timeout: 30_000 },
    )
    expect(res.status).toBe(0)
    expect(res.stdout.endsWith('\nMARKER\n')).toBe(true)
    expect(res.stdout.length).toBeLessThanOrEqual(64 * 1024)
  }, 60_000)

  it('settles on the command exiting, though a process it started still holds its output', async () => {
    const holderPid = join(root, 'holder.pid')
    let pids = []
    try {
      const res = await spawnGroup(
        ...nodeScript(`
          const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'],
            { stdio: ['ignore', 'inherit', 'inherit'] })
          require('node:fs').writeFileSync(${JSON.stringify(holderPid)}, String(c.pid))
          process.exit(0)`),
        { timeout: 20_000 },
      )
      expect(res).toMatchObject({ status: 0, timedOut: false })
      pids = [Number(readFileSync(holderPid, 'utf8'))]
      // The holder was in the group, so it went with it.
      expect(await awaitGone(pids)).toEqual([])
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 60_000)

  it('settles within its grace period when the holder has left the group', async () => {
    const holderPid = join(root, 'holder.pid')
    let pid = null
    try {
      const res = await spawnGroup(
        ...nodeScript(`
          const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'],
            { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
          require('node:fs').writeFileSync(${JSON.stringify(holderPid)}, String(c.pid))
          process.exit(0)`),
        { timeout: 20_000, graceMs: 200 },
      )
      expect(res).toMatchObject({ status: 0, timedOut: false })
      pid = Number(readFileSync(holderPid, 'utf8'))
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 15_000)

  it('leaves no timer behind: a script that waits on a quick command exits at once', () => {
    const res = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { spawnGroup } = await import(${JSON.stringify(SWEEP_DETECT)})
         const r = await spawnGroup(process.execPath, ['-e', ''], { timeout: 60_000 })
         console.log(r.status)`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    )
    expect(res.error).toBeUndefined()
    expect(res.stdout.trim()).toBe('0')
  }, 60_000)

  it('installs signal handlers only while a group is running', async () => {
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s))
    const running = spawnGroup(...nodeScript(''), { timeout: 30_000 })
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1))
    await running
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s))).toEqual(before)
  }, 60_000)

  it('a signal to the script takes its running groups down, and the script ends by that signal', async () => {
    const parentPid = join(root, 'parent.pid')
    const workerPid = join(root, 'worker.pid')
    const worker = `require('node:fs').writeFileSync(${JSON.stringify(workerPid)}, String(process.pid)); setTimeout(() => {}, 30_000)`
    const parent = `
      require('node:fs').writeFileSync(${JSON.stringify(parentPid)}, String(process.pid))
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'ignore' })
      setTimeout(() => {}, 30_000)`
    const script = spawnAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { spawnGroup } = await import(${JSON.stringify(SWEEP_DETECT)})
         await spawnGroup(process.execPath, ['-e', ${JSON.stringify(parent)}], { timeout: 60_000 })`,
      ],
      // Its own group, as a terminal gives a foreground job.
      { detached: true, stdio: 'ignore' },
    )
    let pids = []
    try {
      for (let i = 0; i < 400 && !existsSync(workerPid); i++) await new Promise((r) => setTimeout(r, 25))
      pids = [Number(readFileSync(parentPid, 'utf8')), Number(readFileSync(workerPid, 'utf8'))]
      const ended = new Promise((r) => script.on('exit', (status, signal) => r({ status, signal })))
      process.kill(-script.pid, 'SIGTERM')
      expect(await ended).toEqual({ status: null, signal: 'SIGTERM' })
      expect(await awaitGone(pids)).toEqual([])
    } finally {
      for (const pid of [script.pid, ...pids]) if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 60_000)
})
