import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  ceilingsFor,
  indexTestTimeoutMs,
  VECTOR_INDEX_WAITS,
  type WaitCeilings,
} from './regions.js'

// A test whose vitest timeout is shorter than the waits inside it is ended by
// vitest as a plain failure before an expired wait can be reported as no
// answer. The slow online-index lane is where both are long enough to cross,
// so this checks the two files in it. It reads them as source rather than
// importing them, which would register their tests and build a client, and
// evaluates each test's timeout and waits from the expressions in the file,
// against the same constants the file uses, on a real-DynamoDB and an emulator
// ceiling profile.
//
// What it enforces, for every `it` or `test` in the two files (including
// `.each`, `.skipIf`, `.concurrent` and the like):
//
//  - The timeout, from the options object or the trailing argument, or the
//    vitest.config.ts default. A test with any wait must outlast the sum of its
//    waits by a minute.
//  - Waits in the test body and in any helper it calls that the file declares,
//    as a function or as an arrow-function const:
//      - waitUntilActive, waitForGsiConsistency, deleteTable,
//        retryWhileBackupsEnabling and enablePitr, at their ceilings, however
//        they are imported (by name, renamed, or as `helpers.x`);
//      - a deadline: `Date.now() + x`, `x + Date.now()`, `Date.now() - start
//        < x` or `Date.now() < start + x` counts x;
//      - a sleep (`setTimeout` or a function named sleep) whose delay is a
//        literal under 10 seconds. Inside a loop bounded by a deadline the
//        sleep is covered by that deadline; anywhere else it counts.
//    A wait inside a loop counts once per iteration when the loop is
//    `for (...; i < N; ...)` with a literal N.
//
// What fails closed: it throws, rather than counting zero, on any other call
// imported from src/ that is not on the wait-free list below; a callee named
// wait*, sleep* or poll* it does not recognise; any other use of Date.now(),
// performance.now() or new Date(); a sleep with a non-literal or long delay; a
// wait in any other loop; and a timeout or wait expression it cannot evaluate.
// A Date.now() that is data rather than a deadline takes a `// not a wait`
// comment on its line.
//
// What it does not enforce: hooks and their timeouts, describe-level timeouts,
// time spent in single requests and the SDK's own retries, a loop that polls
// without sleeping or reading the clock (it costs nothing here and never ends
// there), the one extra sleep and request a deadline loop can run past its
// deadline (well inside the minute's margin), timers other than setTimeout
// (setInterval), and waits behind calls on objects (ddb.send and the like),
// which are taken to be single requests unless the method is named wait*,
// sleep* or poll*. A new test of any of those shapes is still caught by the
// pinned test count, which has to be raised by hand.

const FILES = [
  'tests/tier2/updateTable/gsi.test.ts',
  'tests/tier2/vectorSearch/updateLifecycle.test.ts',
] as const

const MARGIN_MS = 60_000
const SLEEP_LIMIT_MS = 10_000
const NOT_A_WAIT = '// not a wait'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

const DEFAULT_TEST_TIMEOUT_MS = Number(
  /testTimeout:\s*([\d_]+)/.exec(read('vitest.config.ts'))![1].replaceAll('_', ''),
)

const PROFILES = [
  ['real DynamoDB', ceilingsFor('eu-west-2', undefined, false)],
  ['an emulator', ceilingsFor('eu-west-2', undefined, true)],
] as const

// Calls imported from src/ that wait, at their default ceilings. The ceilings
// for the first two are checked against src/helpers.ts below.
type KnownWait = (args: Node[], c: WaitCeilings, evaluate: (n: Node) => any) => number
const optionTimeout = (opts: Node | undefined, evaluate: (n: Node) => any): number | undefined => {
  const p = opts && unwrap(opts).properties?.find((x: Node) => x.key?.name === 'timeoutMs')
  return p ? evaluate(p.value) : undefined
}
const KNOWN_WAITS: Record<string, KnownWait> = {
  waitUntilActive: (a, c, ev) => (a[1] ? ev(a[1]) : c.tableActiveMs),
  waitForGsiConsistency: (a, c, ev) => optionTimeout(a[0], ev) ?? c.gsiConsistencyMs,
  deleteTable: () => 30_000,
  retryWhileBackupsEnabling: (a, _c, ev) => (a[1] ? ev(a[1]) : 120_000),
  enablePitr: () => 120_000,
}

// Calls imported from src/ that do not wait.
const WAIT_FREE = new Set([
  'uniqueTableName',
  'expectDynamoError',
  'assertDynamoError',
  'describeVectorIndex',
  'skipUnlessVectorIndexes',
  'isUnsupportedFault',
  'indeterminateFrom',
  'ceilingsFor',
  'indexTestTimeoutMs',
])

type Node = { type: string; start: number; end: number; [k: string]: any }
type Wait = { what: string; ms: number }

function unwrap(n: Node): Node {
  while (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression' || n.type === 'AwaitExpression') {
    n = n.expression ?? n.argument
  }
  return n
}

function childrenOf(n: Node): Node[] {
  const out: Node[] = []
  for (const [k, v] of Object.entries(n)) {
    if (k === 'start' || k === 'end') continue
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') out.push(c)
    } else if (v && typeof v.type === 'string') out.push(v)
  }
  return out
}

function* walk(n: Node): Generator<Node> {
  yield n
  for (const c of childrenOf(n)) yield* walk(c)
}

/** `it` in it(...), it.skipIf(c)(...), it.each(x)(...), it.concurrent(...). */
function baseIdentifier(callee: Node): string | undefined {
  let c = unwrap(callee)
  while (c.type === 'MemberExpression' || c.type === 'CallExpression') {
    c = unwrap(c.type === 'MemberExpression' ? c.object : c.callee)
  }
  return c.type === 'Identifier' ? c.name : undefined
}

const isFunction = (n: Node | undefined) =>
  n !== undefined && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression')

interface Measured {
  file: string
  title: string
  timeoutMs: number
  waits: Wait[]
}

/** Every test in a file, with its timeout and its waits under one profile. */
function measure(file: string, ceilings: WaitCeilings): Measured[] {
  const src = read(file)
  const ast = parseAst(src, { lang: 'ts' }) as unknown as Node
  const text = (n: Node) => src.slice(n.start, n.end)
  const lineOf = (n: Node) => {
    const from = src.lastIndexOf('\n', n.start) + 1
    const to = src.indexOf('\n', n.start)
    return src.slice(from, to === -1 ? undefined : to)
  }
  const fail = (n: Node, why: string): never => {
    throw new Error(`${file}: ${why}: ${text(n).slice(0, 80)}`)
  }

  // Imports from src/: local name to the exported name, and namespaces.
  const imported = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const stmt of ast.body as Node[]) {
    if (stmt.type !== 'ImportDeclaration' || !/\/src\//.test(stmt.source.value)) continue
    for (const s of stmt.specifiers as Node[]) {
      if (s.type === 'ImportSpecifier') imported.set(s.local.name, s.imported.name)
      if (s.type === 'ImportNamespaceSpecifier') namespaces.add(s.local.name)
    }
  }

  // The file's own helpers, declared either way.
  const helpers = new Map<string, Node>()
  for (const n of walk(ast)) {
    if (n.type === 'FunctionDeclaration' && n.id) helpers.set(n.id.name, n)
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isFunction(unwrap(n.init))) {
      helpers.set(n.id.name, unwrap(n.init))
    }
  }

  // Module-level constants, evaluated in order. CEILINGS is the profile under
  // test rather than ceilingsFor(region), which would read the environment.
  const scope: Record<string, unknown> = { CEILINGS: ceilings, VECTOR_INDEX_WAITS, indexTestTimeoutMs }

  function evaluate(e: Node): any {
    e = unwrap(e)
    switch (e.type) {
      case 'Literal':
        return e.value
      case 'Identifier':
        if (!(e.name in scope)) fail(e, `unknown name ${e.name}`)
        return scope[e.name]
      case 'MemberExpression':
        if (e.computed) fail(e, 'computed member')
        return evaluate(e.object)[e.property.name]
      case 'BinaryExpression': {
        const a = evaluate(e.left)
        const b = evaluate(e.right)
        if (e.operator === '+') return a + b
        if (e.operator === '*') return a * b
        return fail(e, `operator ${e.operator}`)
      }
      case 'ObjectExpression':
        return Object.fromEntries(e.properties.map((p: Node) => [p.key.name, evaluate(p.value)]))
      case 'CallExpression':
        if (evaluate(e.callee) !== indexTestTimeoutMs) fail(e, 'call')
        return indexTestTimeoutMs(...(e.arguments.map(evaluate) as Parameters<typeof indexTestTimeoutMs>))
    }
    return fail(e, `cannot evaluate ${e.type}`)
  }

  for (const stmt of ast.body as Node[]) {
    if (stmt.type !== 'VariableDeclaration' || stmt.kind !== 'const') continue
    for (const d of stmt.declarations as Node[]) {
      if (d.id.type === 'Identifier' && d.id.name === 'CEILINGS') continue
      if (d.id.type === 'ObjectPattern') {
        const value = evaluate(d.init)
        for (const p of d.id.properties) scope[p.value.name] = value[p.key.name]
      } else if (d.id.type === 'Identifier' && !isFunction(unwrap(d.init))) {
        try {
          scope[d.id.name] = evaluate(d.init)
        } catch {
          // Not a number this check reads (a table list, a client). Left out
          // of scope, so a timeout or wait that uses it fails loudly below.
        }
      }
    }
  }

  // ── The clock ──────────────────────────────────────────────────────────────
  const isDateNow = (n: Node) => {
    n = unwrap(n)
    return n.type === 'CallExpression' && text(n.callee) === 'Date.now' && n.arguments.length === 0
  }
  const COMPARE = new Set(['<', '<=', '>', '>='])

  /** The waits in one function body, following the file's own helpers. */
  function waitsIn(fn: Node, seen: Set<string>): Wait[] {
    // Deadline and start variables, wherever in the body they are declared.
    const deadlines = new Set<string>()
    const starts = new Set<string>()
    for (const n of walk(fn.body)) {
      if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier' || !n.init) continue
      const init = unwrap(n.init)
      if (isDateNow(init)) starts.add(n.id.name)
      else if (init.type === 'BinaryExpression' && init.operator === '+' && (plusChainFromNow(init) || isDateNow(init.right))) {
        deadlines.add(n.id.name)
      }
    }
    const isStart = (n: Node) => unwrap(n).type === 'Identifier' && starts.has(unwrap(n).name)
    const isDeadline = (n: Node) => unwrap(n).type === 'Identifier' && deadlines.has(unwrap(n).name)

    /** For Date.now() + a + b: [a, b]. Undefined if the chain does not start at Date.now(). */
    function plusChainFromNow(n: Node): Node[] | undefined {
      const added: Node[] = []
      while (n.type === 'BinaryExpression' && n.operator === '+') {
        added.unshift(n.right)
        n = unwrap(n.left)
      }
      return isDateNow(n) ? added : undefined
    }

    /** A recognised deadline comparison, and what it adds. */
    function deadlineCompare(n: Node): { ms: number; what: string } | undefined {
      if (n.type !== 'BinaryExpression' || !COMPARE.has(n.operator)) return undefined
      const l = unwrap(n.left)
      const r = unwrap(n.right)
      // Date.now() - start < x
      if (l.type === 'BinaryExpression' && l.operator === '-' && isDateNow(l.left) && isStart(l.right)) {
        return { ms: evaluate(r), what: `Date.now() - start ${n.operator} ${text(r)}` }
      }
      // Date.now() < start + x
      if (isDateNow(l) && r.type === 'BinaryExpression' && r.operator === '+' && isStart(r.left)) {
        return { ms: evaluate(r.right), what: `Date.now() ${n.operator} start + ${text(r.right)}` }
      }
      // Date.now() > deadline, deadline < Date.now()
      if ((isDateNow(l) && isDeadline(r)) || (isDeadline(l) && isDateNow(r))) return { ms: 0, what: '' }
      return undefined
    }

    const hasDeadline = (loop: Node) => [...walk(loop)].some((n) => deadlineCompare(n) !== undefined)

    function literalBound(loop: Node): number | undefined {
      if (loop.type !== 'ForStatement' || !loop.test) return undefined
      const t = unwrap(loop.test)
      if (t.type !== 'BinaryExpression' || (t.operator !== '<' && t.operator !== '<=')) return undefined
      const r = unwrap(t.right)
      if (r.type !== 'Literal' || typeof r.value !== 'number') return undefined
      return t.operator === '<' ? r.value : r.value + 1
    }

    function sleepDelay(call: Node, name: string | undefined): Node | undefined {
      if (name === 'setTimeout') return call.arguments[1]
      if (name && /^sleep/i.test(name)) return call.arguments[0]
      return undefined
    }

    function visit(n: Node, inDeadlineLoop: boolean): Wait[] {
      n = unwrap(n)
      if (lineOf(n).includes(NOT_A_WAIT)) return []

      if (n.type === 'ForStatement' || n.type === 'WhileStatement' || n.type === 'DoWhileStatement' ||
          n.type === 'ForOfStatement' || n.type === 'ForInStatement') {
        const bounded = inDeadlineLoop || hasDeadline(n)
        const inner = childrenOf(n).flatMap((c) => visit(c, bounded))
        const loopWaits = inner.filter((w) => !w.what.startsWith('deadline'))
        if (bounded || loopWaits.length === 0) return inner
        const times = literalBound(n)
        if (times === undefined) fail(n, `a wait inside a loop with no literal bound (${loopWaits.map((w) => w.what).join(', ')})`)
        return inner.map((w) => ({ what: `${times} x ${w.what}`, ms: times! * w.ms }))
      }

      if (n.type === 'VariableDeclarator' && n.init && isDateNow(n.init)) return [] // a start
      if (n.type === 'BinaryExpression' && n.operator === '+') {
        const added = plusChainFromNow(n)
        if (added) {
          return [{ what: `deadline ${added.map(text).join(' + ')}`, ms: added.reduce((s, a) => s + evaluate(a), 0) }]
        }
        if (isDateNow(n.right)) return [{ what: `deadline ${text(n.left)}`, ms: evaluate(n.left) }]
      }
      const compared = deadlineCompare(n)
      if (compared) return compared.ms ? [{ what: `deadline ${compared.what}`, ms: compared.ms }] : []

      if (isDateNow(n)) fail(n, 'Date.now() outside a recognised deadline')
      if (n.type === 'NewExpression' && text(n.callee) === 'Date') fail(n, 'new Date() in a test')
      if (n.type === 'CallExpression' && text(n.callee) === 'performance.now') fail(n, 'performance.now() in a test')

      if (n.type === 'CallExpression') {
        const callee = unwrap(n.callee)
        const local = callee.type === 'Identifier' ? callee.name : undefined
        const viaNamespace =
          callee.type === 'MemberExpression' && !callee.computed && unwrap(callee.object).type === 'Identifier' &&
          namespaces.has(unwrap(callee.object).name)
            ? callee.property.name
            : undefined
        const exported = viaNamespace ?? (local !== undefined ? imported.get(local) : undefined)
        const shown = local ?? (callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : undefined)
        const args = n.arguments.flatMap((a: Node) => visit(a, inDeadlineLoop))

        const delay = sleepDelay(n, shown)
        if (delay !== undefined) {
          const d = unwrap(delay)
          if (d.type !== 'Literal' || typeof d.value !== 'number' || d.value >= SLEEP_LIMIT_MS) {
            fail(n, `a sleep whose delay is not a literal under ${SLEEP_LIMIT_MS / 1000} s`)
          }
          // A sleep inside a deadline loop is covered by the deadline.
          return inDeadlineLoop ? args : [...args, { what: `sleep ${d.value}`, ms: d.value }]
        }
        if (exported !== undefined) {
          if (KNOWN_WAITS[exported]) {
            if (inDeadlineLoop) fail(n, `${exported} inside a deadline loop`)
            return [...args, { what: text(n).slice(0, 60), ms: KNOWN_WAITS[exported](n.arguments, ceilings, evaluate) }]
          }
          if (!WAIT_FREE.has(exported)) fail(n, `${exported} is imported from src/ and is neither a known wait nor known not to wait`)
          return args
        }
        if (local !== undefined && helpers.has(local)) {
          if (seen.has(local)) fail(n, `recursive helper ${local}`)
          return [...args, ...waitsIn(helpers.get(local)!, new Set([...seen, local]))]
        }
        if (shown && /^(wait|sleep|poll)/i.test(shown)) fail(n, `unrecognised wait ${shown}()`)
        return [...args, ...visit(callee, inDeadlineLoop)]
      }

      return childrenOf(n).flatMap((c) => visit(c, inDeadlineLoop))
    }

    return visit(fn.body, false)
  }

  const tests: Measured[] = []
  for (const n of walk(ast)) {
    if (n.type !== 'CallExpression') continue
    const name = baseIdentifier(n.callee)
    if (name !== 'it' && name !== 'test') continue
    const args = n.arguments as Node[]
    const fnIndex = args.findIndex(isFunction)
    if (fnIndex === -1) continue // it.each(rows): the call that takes the function is the outer one
    let timeoutMs = DEFAULT_TEST_TIMEOUT_MS
    const opts = fnIndex === 2 ? unwrap(args[1]) : undefined
    const timeoutProp = opts?.properties?.find((p: Node) => p.key?.name === 'timeout')
    if (timeoutProp) timeoutMs = evaluate(timeoutProp.value)
    if (args[fnIndex + 1]) timeoutMs = evaluate(args[fnIndex + 1])
    const title = args[0].type === 'Literal' ? String(args[0].value) : text(args[0])
    tests.push({ file, title, timeoutMs, waits: waitsIn(args[fnIndex], new Set()) })
  }
  return tests
}

describe('index test timeouts', () => {
  it('reads the defaults it assumes from the source', () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(30_000)
    const helpersSrc = read('src/helpers.ts')
    expect(helpersSrc).toMatch(/export async function waitUntilActive\(\s*tableName: string,\s*timeoutMs = ceilingsFor\(region\)\.tableActiveMs,/)
    expect(helpersSrc).toMatch(/export async function waitForGsiConsistency[\s\S]{0,200}timeoutMs = ceilingsFor\(region\)\.gsiConsistencyMs,/)
    expect(helpersSrc).toMatch(/export async function deleteTable[\s\S]{0,300}Date\.now\(\) - start < 30_000/)
    expect(helpersSrc).toMatch(/export async function retryWhileBackupsEnabling[\s\S]{0,120}timeoutMs = 120_000,/)
  })

  describe.each(PROFILES)('on %s', (_name, ceilings) => {
    const all = FILES.flatMap((f) => measure(f, ceilings))

    it('finds every test in the slow online-index lane', () => {
      // An empty or shrunken set would pass the checks below for nothing, so
      // the parse has to agree with a plain count of the lines opening a test.
      for (const file of FILES) {
        const opened = read(file).match(/^\s*(it|test)\b[.(]/gm)?.length ?? 0
        expect(opened).toBeGreaterThan(0)
        expect(all.filter((t) => t.file === file)).toHaveLength(opened)
      }
      expect(all).toHaveLength(17)
    })

    it.each(all.map((t) => [t.title, t] as const))('gives "%s" a timeout a minute longer than its waits', (_title, t) => {
      expect(Number.isFinite(t.timeoutMs)).toBe(true)
      if (t.waits.length === 0) return
      const waited = t.waits.reduce((sum, w) => sum + w.ms, 0)
      expect(t.timeoutMs, JSON.stringify(t.waits)).toBeGreaterThanOrEqual(waited + MARGIN_MS)
    })

    // The tests whose timeouts were once shorter than their waits, pinned by
    // name with the waits they are expected to hold, so the check above cannot
    // pass them by finding fewer waits than are there.
    const expected: Record<string, number[]> = {
      'refuses to delete the table while a vector index is still being created': [
        ceilings.tableActiveMs,
        VECTOR_INDEX_WAITS.activeTableBesideCreatingIndexMs,
        VECTOR_INDEX_WAITS.indexGoneMs,
      ],
      'reports UPDATING with Backfilling false while allocating, and takes a cancel only once backfilling starts': [
        ceilings.tableActiveMs,
        VECTOR_INDEX_WAITS.backfillStartMs,
        VECTOR_INDEX_WAITS.indexGoneMs,
      ],
      'rejects adding a GSI with an attribute not in AttributeDefinitions': [ceilings.tableActiveMs],
      'rejects a GSI keyed on a table attribute omitted from the request AttributeDefinitions': [
        ceilings.tableActiveMs,
      ],
      'rejects removing a non-existent GSI': [ceilings.tableActiveMs],
    }

    it.each(Object.entries(expected))('counts every wait in "%s"', (title, waits) => {
      const t = all.find((x) => x.title === title)
      expect(t).toBeDefined()
      expect(t!.waits.map((w) => w.ms)).toEqual(waits)
      expect(t!.timeoutMs).toBeGreaterThanOrEqual(waits.reduce((a, b) => a + b, 0) + MARGIN_MS)
    })
  })
})
