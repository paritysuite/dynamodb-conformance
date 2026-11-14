import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadRegistry, sameObservation } from './lib/registry.mjs'
import { PROVISIONAL_ACCEPTED_DETAIL } from '../src/observation-sink.js'

// Per-region scoring joins three hand-maintained artefacts on prose
// identity: a registry row names its test by (file, fullName), the wired
// test records the target's answer via src/observation-sink.ts, and an
// accepted answer is credited only when the detail string the test stamps
// byte-matches the row's. None of those joins fails loudly on its own - a
// renamed test, an unwired row, or a reworded detail just degrades scoring
// back to the conservative fail-everywhere path with nothing going red,
// which is exactly how 2.0.0 shipped with the evidence half missing. These
// assertions are what make that drift loud.

const registry = loadRegistry()

// Titles as they appear in source: the first string literal argument of a
// describe()/it() call. The split tests use plain single-quoted titles; a
// row whose test moves to a template literal or computed title will fail the
// fullName join below, which is the correct moment for a human to strengthen
// this extraction.
const titleLiterals = (source, kind) =>
  [...source.matchAll(new RegExp(`\\b${kind}\\(\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map(
    (m) => m[1].replaceAll("\\'", "'"),
  )

// The source of one test: from its it() call to the next test-structure call
// (it, test or describe, with or without a modifier such as .each or .skipIf,
// and whatever its title is written as), or the end of the file. Several rows
// can key to tests in one file, so the wiring checks read the named test's
// block rather than the whole file, which would let one wired test vouch for
// its unwired neighbours.
//
// The test is found by its describe title as well as its own: the nearest
// describe() above it plus its it() title must end the row's fullName. Two
// describes can hold tests with the same title, and matching on the it()
// title alone would hand both rows the first one's block. A test this cannot
// place resolves to null and fails its row loudly rather than borrowing a
// neighbour's block.
const TEST_CALL = /(?<![.\w])(it|test|describe)((?:\.\w+)*)\(\s*(?:'((?:[^'\\]|\\.)*)')?/g
const testBlock = (source, fullName) => {
  const calls = [...source.matchAll(TEST_CALL)].map((m) => ({
    kind: m[1],
    plain: m[2] === '',
    title: m[3] === undefined ? null : m[3].replaceAll("\\'", "'"),
    index: m.index,
  }))
  let describeTitle = null
  let at = -1
  let matched = ''
  calls.forEach((call, i) => {
    if (call.kind === 'describe') {
      describeTitle = call.plain ? call.title : null
      return
    }
    if (call.kind !== 'it' || !call.plain || call.title === null || describeTitle === null) return
    const name = `${describeTitle} ${call.title}`
    if (fullName !== name && !fullName.endsWith(` ${name}`)) return
    if (name.length > matched.length) {
      at = i
      matched = name
    }
  })
  if (at === -1) return null
  const start = calls[at].index
  const end = calls[at + 1]?.index ?? source.length
  return { start, text: source.slice(start, end) }
}

// Whether a block calls observeSplit or recordObserved, ignoring comments: the
// row id lives in a comment by convention, and a comment that merely mentions
// the helper must not pass for a test that never records its answer.
const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const recordsObservation = (block) =>
  /\b(?:observeSplit|recordObserved)\s*\(/.test(withoutComments(block))

// A split test may hand its task to a helper instead of calling the sink itself.
// This follows the hand-off through the file's own function declarations: from
// a call that passes the task, into the function it names, to the parameter
// that received it, and on until something passes that parameter to
// recordObserved or observeSplit. Anything it cannot read (a computed callee,
// an arrow function, a spread) counts as not recording, which fails the row
// loudly rather than letting a sibling test's recorder vouch for it.
const SINKS = new Set(['recordObserved', 'observeSplit'])

const skipString = (text, i) => {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === text[i]) return j
  }
  return text.length
}

/** The text inside the bracket at `open`, up to its match. */
const bracketed = (text, open) => {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') i = skipString(text, i)
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c) && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

/** Top-level comma-separated parts. Angle brackets count as nesting in a parameter list. */
const splitTopLevel = (inner, { angles = false } = {}) => {
  const parts = []
  let depth = 0
  let from = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === "'" || c === '"' || c === '`') i = skipString(inner, i)
    else if ('([{'.includes(c) || (angles && c === '<')) depth++
    else if (')]}'.includes(c) || (angles && c === '>' && inner[i - 1] !== '=')) depth--
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(from, i).trim())
      from = i + 1
    }
  }
  if (inner.slice(from).trim()) parts.push(inner.slice(from).trim())
  return parts
}

/** Every call in `text` passing `arg` as a whole argument, with its position. */
const callsPassing = (text, arg) => {
  const found = []
  for (const m of text.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const inner = bracketed(text, m.index + m[0].length - 1)
    if (inner === null) continue
    splitTopLevel(inner).forEach((part, index) => {
      if (part === arg) found.push({ name: m[1], index })
    })
  }
  return found
}

/** A function declaration's parameter names and body, or null. */
const functionIn = (source, name) => {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const params = bracketed(source, open)
  const bodyOpen = source.indexOf('{', open + params.length + 2)
  return {
    params: splitTopLevel(params, { angles: true }).map((p) => p.match(/^[A-Za-z_$][\w$]*/)?.[0]),
    body: withoutComments(bracketed(source, bodyOpen) ?? ''),
  }
}

/** The bodies that pass the task to a sink, reached from `name`'s parameter at `index`. */
const recordersVia = (source, name, index, depth = 4) => {
  const fn = functionIn(source, name)
  const param = fn?.params[index]
  if (!param) return []
  const reached = []
  for (const call of callsPassing(fn.body, param)) {
    if (SINKS.has(call.name)) {
      if (call.index === 0) reached.push(fn.body)
    } else if (depth > 0) {
      reached.push(...recordersVia(source, call.name, call.index, depth - 1))
    }
  }
  return reached
}

/** The recording code a test's block reaches: its own sink calls, or a helper's. */
const recordersReached = (block, source) => {
  const code = withoutComments(block)
  const reached = recordsObservation(block) ? [code] : []
  for (const call of callsPassing(code, 'ctx.task')) {
    if (!SINKS.has(call.name)) reached.push(...recordersVia(source, call.name, call.index))
  }
  return reached
}

/** The accepted details the reached recording code actually stamps, constants resolved. */
const stampedDetails = (recorders, source) => {
  const code = withoutComments(source)
  const details = new Set()
  for (const text of recorders) {
    for (const m of text.matchAll(/\bdetail\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)/g)) {
      const value = m[1]
      if (/^['"]/.test(value)) details.add(value.slice(1, -1))
      else {
        const constant = new RegExp(`\\bconst\\s+${value}\\s*=\\s*('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`).exec(code)
        if (constant) details.add(constant[1].slice(1, -1))
      }
    }
  }
  return details
}

describe('every registry row resolves to a wired split test', () => {
  it('no two rows share a test block, which keeps per-test assertions exact', () => {
    // The wiring checks below read only the named test's own block, so rows
    // may share a file. Two rows resolving to one block would let one wired
    // test satisfy both rows' checks, which is what this guards against.
    const blocks = registry.splits.map((row) => {
      const source = existsSync(row.test.file) ? readFileSync(row.test.file, 'utf8') : ''
      return `${row.test.file}\0${testBlock(source, row.test.fullName)?.start}`
    })
    expect(new Set(blocks).size).toBe(blocks.length)
  })

  for (const row of registry.splits) {
    describe(row.id, () => {
      const source = existsSync(row.test.file) ? readFileSync(row.test.file, 'utf8') : null
      const block = source === null ? null : testBlock(source, row.test.fullName)?.text ?? null
      const acceptedDetails = Object.values(row.regions)
        .filter((observation) => observation.outcome === 'accepted')
        .map((observation) => observation.detail)

      it('names a test file that exists', () => {
        expect(source, `${row.test.file} does not exist`).not.toBeNull()
      })

      it('joins on a fullName composed of a real describe/it pair in that file', () => {
        // Scoring and drift detection join rows to results on fullName
        // (describe title + space + it title). A renamed title silently
        // un-joins the row - every target then scores the conservative
        // fail-everywhere path - so the composition is asserted here.
        const titles = titleLiterals(source, 'it')
        const title = titles.find((t) => row.test.fullName.endsWith(` ${t}`))
        expect(title, `no it() title in ${row.test.file} ends ${row.test.fullName}`)
          .toBeDefined()
        const prefix = row.test.fullName.slice(0, -(title.length + 1))
        expect(titleLiterals(source, 'describe')).toContain(prefix)
      })

      it('is named by its test, which records an observation', () => {
        // Convention: a split test carries its registry row id in a comment,
        // and captures the target's answer. A row admitted without wiring
        // the test would score as fail-everywhere for every target.
        expect(block, `no it() block in ${row.test.file} for ${row.test.fullName}`).not.toBeNull()
        expect(block).toContain(row.id)
        expect(
          recordersReached(block, source).length,
          `${row.test.fullName} never records an observation`,
        ).toBeGreaterThan(0)
      })

      it('has every accepted detail it records stamped by the code the test reaches', () => {
        // An accepted answer is stamped from a literal, so a reworded registry
        // detail silently stops matching unless the test moves in lockstep. The
        // literal has to be in the recording code this test actually reaches,
        // its own block or a helper it hands its task to, not merely somewhere
        // in the file. Rejected answers are captured verbatim from the target at
        // run time and need no literal.
        const stamped = stampedDetails(recordersReached(block ?? '', source ?? ''), source ?? '')
        for (const detail of acceptedDetails) {
          expect([...stamped], `detail "${detail}" is not stamped by what ${row.test.fullName} reaches`).toContain(detail)
        }
      })

      it('never records the provisional accepted detail as a real answer', () => {
        // The provisional detail exists to match nothing; a row recording it
        // would let an unverified acceptance claim a region match.
        expect(acceptedDetails).not.toContain(PROVISIONAL_ACCEPTED_DETAIL)
      })
    })
  }
})

describe('testBlock finds the named test and nothing else', () => {
  // Fixtures stand in for split test files. Each test body carries a marker so
  // an assertion can say which block came back.
  const source = [
    "describe('Outer one', () => {",
    "  it('writes the item', async () => { /* A */ })",
    "  it('full error', async () => { /* B */ })",
    "  it('error', async () => { /* C */ })",
    "  it.each([1, 2])('parameterised %i', async () => { /* D */ })",
    "  it('before a template title', async () => { /* E */ })",
    "  it(`template ${1}`, async () => { /* F */ })",
    "})",
    "describe('Outer two', () => {",
    "  it('writes the item', async () => { /* G */ })",
    "})",
  ].join('\n')
  const text = (fullName) => testBlock(source, fullName)?.text ?? null

  it('tells apart two tests with one title under different describes', () => {
    expect(text('Outer one writes the item')).toContain('/* A */')
    expect(text('Outer two writes the item')).toContain('/* G */')
    expect(text('Outer two writes the item')).not.toContain('/* A */')
  })

  it('does not let a short title claim a longer one that ends with it', () => {
    expect(text('Outer one full error')).toContain('/* B */')
    expect(text('Outer one error')).toContain('/* C */')
    expect(text('Outer one error')).not.toContain('/* B */')
  })

  it('ends a block at a modified or template-titled neighbour', () => {
    expect(text('Outer one error')).not.toContain('/* D */')
    expect(text('Outer one before a template title')).not.toContain('/* F */')
  })

  it('resolves a name it cannot place to null', () => {
    expect(text('Outer three writes the item')).toBeNull()
    expect(text('writes the item')).toBeNull()
  })

  it('ignores .test( on a regex inside a block', () => {
    const withRegex = [
      "describe('Suite', () => {",
      "  it('checks', () => { expect(/x/.test('x')).toBe(true); /* H */ })",
      '})',
    ].join('\n')
    expect(testBlock(withRegex, 'Suite checks')?.text).toContain('/* H */')
  })
})

describe('recordsObservation', () => {
  it('counts a real call', () => {
    expect(recordsObservation('await observeSplit(ctx.task, () => send())')).toBe(true)
    expect(recordsObservation('recordObserved(ctx.task, observation)')).toBe(true)
  })

  it('does not count a helper named only in a comment', () => {
    expect(recordsObservation('// wired through observeSplit(ctx.task, ...) later\nawait send()')).toBe(false)
    expect(recordsObservation('/* observeSplit( */ await send()')).toBe(false)
  })
})

describe('recordersReached and stampedDetails', () => {
  const file = [
    "const STAMP = 'stamped here'",
    'function outer(a, task) { inner(task, a) }',
    "function inner(t, a) { recordObserved(t, { outcome: 'accepted', detail: STAMP }) }",
    'function inert(task) { return task }',
    "function other(t) { recordObserved(t, { outcome: 'accepted', detail: 'elsewhere' }) }",
  ].join('\n')
  const reached = (block) => recordersReached(block, file)

  it('follows the task through a helper to the one that records', () => {
    expect(reached('await outer(1, ctx.task)')).toHaveLength(1)
    expect([...stampedDetails(reached('await outer(1, ctx.task)'), file)]).toEqual(['stamped here'])
  })

  it('does not count a helper that receives the task and never records it', () => {
    expect(reached('await inert(ctx.task)')).toHaveLength(0)
  })

  it('does not count ctx.task that is named but not passed to anything', () => {
    expect(reached('void ctx.task; await outer(1, undefined)')).toHaveLength(0)
    expect(reached('// hands ctx.task to outer(1, ctx.task)\nawait outer(1)')).toHaveLength(0)
  })

  it('does not count the task passed in a position the helper does not record', () => {
    expect(reached('await outer(ctx.task, 1)')).toHaveLength(0)
  })

  it('counts a block that records directly, with the details it stamps', () => {
    const block = "recordObserved(ctx.task, { outcome: 'accepted', detail: 'inline' })"
    expect([...stampedDetails(reached(block), file)]).toEqual(['inline'])
  })

  it('does not count a detail that appears only in a comment', () => {
    const commented = "function c(t) {\n  // detail: 'ghost'\n  recordObserved(t, { outcome: 'accepted', detail: STAMP })\n}\nconst STAMP = 'real'"
    const found = stampedDetails(recordersReached('c(ctx.task)', commented), commented)
    expect([...found]).toEqual(['real'])
  })
})

// The transaction value-layer tests (tests/tier3/error-messages/valueLayers.test.ts)
// send several requests each, and a row holds one answer per region: the older
// layer's answer to the test's last request. recordOlderLayer stamps that answer
// as the target gave it, once every answer matched the older layer's list. Nothing
// else ties the two, so a row recording a different member of the list, or a
// recorder stamping a different element, would leave every region on the older
// layer unmatched with nothing going red. These assertions make that drift loud.
describe('rows recorded by recordOlderLayer hold the end of the older-layer list', () => {
  const file = 'tests/tier3/error-messages/valueLayers.test.ts'
  const source = readFileSync(file, 'utf8')
  const code = withoutComments(source)

  // The file's own older-layer lists and wrapper, evaluated from its source so a
  // change to either reaches this check.
  const literal = (name) => new RegExp(`^const ${name} = ('(?:[^'\\\\]|\\\\.)*')$`, 'm').exec(code)?.[1]
  const list = (name) => {
    const m = new RegExp(`^const ${name} = \\[`, 'm').exec(code)
    return m ? bracketed(code, m.index + m[0].length - 1) : null
  }
  const wrapper = /^const forKey = \((\w+): string, (\w+): string\) => (`[^`]*`)$/m.exec(code)
  const consts = ['NOT_NUMERIC', 'OVERFLOW', 'UNDERFLOW', 'INVALID']
  const values = consts.map((name) => Function(`return ${literal(name)}`)())
  const evalList = (name) => Function(...consts, `return [${list(name)}]`)(...values)
  const forKey = wrapper ? Function(wrapper[1], wrapper[2], `return ${wrapper[3]}`) : null
  const lists = { OLDER: evalList('OLDER'), DUPE_OLDER: evalList('DUPE_OLDER') }
  const keys = [...code.matchAll(/forKey\(\w+, '([^']+)'\)/g)].map((m) => m[1])

  // Every (list, key) pair whose last answer a row could legitimately record.
  const endings = Object.entries(lists).flatMap(([name, l]) => [
    { name, key: null, message: l.at(-1) },
    ...keys.map((key) => ({ name, key, message: forKey(l.at(-1), key) })),
  ])

  const rows = registry.splits.filter((row) => {
    if (row.test.file !== file) return false
    const block = testBlock(source, row.test.fullName)?.text ?? ''
    return /\brecordOlderLayer\s*\(/.test(withoutComments(block))
  })

  it('reads the lists and the wrapper from the test file, and finds the rows', () => {
    expect(values.every((v) => typeof v === 'string')).toBe(true)
    expect(lists.OLDER).toHaveLength(4)
    expect(lists.DUPE_OLDER).toHaveLength(3)
    expect(forKey).not.toBeNull()
    expect(rows).toHaveLength(6)
  })

  it('stamps the last answer of the list it compared', () => {
    const fn = functionIn(source, 'recordOlderLayer')
    const [, got] = fn.params
    expect(fn.body).toMatch(new RegExp(`message:\\s*${got}\\[${got}\\.length - 1\\]`))
  })

  for (const row of rows) {
    it(`${row.id} records, off the pin, the end of the list its test compares`, () => {
      const block = withoutComments(testBlock(source, row.test.fullName).text)
      const pinned = row.regions[row.pinned]
      const others = Object.values(row.regions).filter((answer) => !sameObservation(answer, pinned))
      expect(others.length).toBeGreaterThan(0)
      for (const answer of others) {
        const ending = endings.find((e) => e.message === answer.error?.message)
        expect(ending, `${answer.error?.message} ends no older-layer list in ${file}`).toBeDefined()
        expect(block).toMatch(new RegExp(`(?<![\\w])${ending.name}\\b`))
        if (ending.key) expect(block).toContain(`forKey(m, '${ending.key}')`)
        else expect(block).not.toMatch(/forKey\(/)
      }
    })
  }
})
