import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMeasuredSuite } from '../summarise.mjs'
import { suiteIdentities } from '../suite-manifest.mjs'
import {
  committedGradingInputs,
  gradingInputsAtRef,
  measuredOf,
  readMeasuredDir,
  validateMeasured,
} from './measured.mjs'

const WHOLE = {
  ref: 'v3.1.0',
  kind: 'tag',
  commit: '9129f0fbfb6fb5ff01aadf5f9f957fa0bf1871ad',
  version: '3.1.0',
  region: 'eu-west-2',
  measuredAt: '2026-08-17T04:36:04Z',
}

const dir = (files) => {
  const d = mkdtempSync(join(tmpdir(), 'measured-'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(d, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return d
}

describe('validateMeasured', () => {
  it('accepts a whole identity', () => {
    expect(validateMeasured(WHOLE)).toBe(WHOLE)
  })

  it('refuses a partial identity rather than filling it in', () => {
    for (const field of Object.keys(WHOLE)) {
      const partial = { ...WHOLE }
      delete partial[field]
      expect(() => validateMeasured(partial), `missing ${field} was accepted`).toThrow(field)
    }
  })

  it('refuses a blank field, which JSON round-trips as present', () => {
    expect(() => validateMeasured({ ...WHOLE, region: '  ' })).toThrow(/region/)
  })

  it('refuses a non-object', () => {
    expect(() => validateMeasured(null)).toThrow(/expected an object/)
  })
})

describe('measuredOf', () => {
  it('reads the identity a board carries', () => {
    expect(measuredOf({ suite: WHOLE })).toEqual(WHOLE)
  })

  it('reads a board written before the field existed as carrying none', () => {
    // An older summary still has to load, or the site breaks between deploys.
    expect(measuredOf({ schemaVersion: 1 })).toBeNull()
  })

  it('refuses a board carrying a half-written identity', () => {
    expect(() => measuredOf({ suite: { ref: 'v3.1.0' } })).toThrow(/incomplete/)
  })
})

describe('readMeasuredDir', () => {
  it('reads the identity and both suite-definition files', () => {
    const d = dir({
      'suite.json': WHOLE,
      'suite-manifest.json': { tests: ['a', 'b'] },
      'splits.json': { splits: [] },
    })
    const out = readMeasuredDir(d)
    expect(out.measured).toEqual(WHOLE)
    expect(out.manifest.tests).toEqual(['a', 'b'])
    expect(out.registry.splits).toEqual([])
  })

  it('refuses an identity with no manifest beside it', () => {
    const d = dir({ 'suite.json': WHOLE, 'splits.json': { splits: [] } })
    expect(() => readMeasuredDir(d)).toThrow(/suite manifest/)
  })

  it('refuses an identity with no split registry beside it', () => {
    const d = dir({ 'suite.json': WHOLE, 'suite-manifest.json': { tests: [] } })
    expect(() => readMeasuredDir(d)).toThrow(/split registry/)
  })

  it('refuses a directory with no identity at all', () => {
    expect(() => readMeasuredDir(dir({}))).toThrow(/no measured suite identity/)
  })
})

describe('gradingInputsAtRef', () => {
  it('reads both suite-definition files at the identity\'s commit, not its ref', () => {
    // The ref is a mutable name; the commit is what was measured. A re-cut tag
    // must not regrade a board that was published before it moved.
    const seen = []
    const git = (spec) => {
      seen.push(spec)
      return spec.endsWith('suite-manifest.json') ? '{"tests":["x"]}' : '{"splits":[]}'
    }
    const out = gradingInputsAtRef(WHOLE, { git })
    expect(seen).toEqual([
      `${WHOLE.commit}:registry/splits.json`,
      `${WHOLE.commit}:registry/suite-manifest.json`,
    ])
    expect(out.manifest.tests).toEqual(['x'])
  })

  it('validates the registry it read, rather than scoring against a malformed one', () => {
    const git = (spec) =>
      spec.endsWith('suite-manifest.json') ? '{"tests":[]}' : '{"splits":[{"id":"broken"}]}'
    expect(() => gradingInputsAtRef(WHOLE, { git })).toThrow(/invalid split registry/)
  })

  it('reads what it is given, not whatever is newer', () => {
    // A rebuild recomputes an existing measurement. The sweep that triggers it
    // may have resolved a newer tag; that tag is not this board's.
    const seen = []
    gradingInputsAtRef(WHOLE, {
      git: (spec) => {
        seen.push(spec.split(':')[0])
        return '{"tests":[],"splits":[]}'
      },
    })
    expect(new Set(seen)).toEqual(new Set([WHOLE.commit]))
  })

  it('refuses rather than falling back when what it names no longer resolves', () => {
    const git = () => {
      throw new Error('fatal: invalid object name')
    }
    expect(() => gradingInputsAtRef(WHOLE, { git })).toThrow(
      /Refusing to fall back to the working tree/,
    )
  })
})

describe('committedGradingInputs', () => {
  // The working tree's suite definition, and a measured one that differs from
  // it in exactly one test name and one recorded answer. Main is expected to
  // run ahead of the release the board was measured at, so this is the normal
  // case, and anything that reads the tree instead of the board's commit
  // returns the wrong half of each pair.
  const tree = {
    manifest: JSON.parse(readFileSync('registry/suite-manifest.json', 'utf8')),
    registry: JSON.parse(readFileSync('registry/splits.json', 'utf8')),
  }
  const onlyOnMain = tree.manifest.tests[0]
  const onlyMeasured = `${onlyOnMain} (as released)`
  const measuredManifest = {
    ...tree.manifest,
    tests: [onlyMeasured, ...tree.manifest.tests.slice(1)].sort(),
  }
  // A row whose pinned answer is a refusal, so the recorded error message is a
  // real field to change rather than one invented beside it.
  const at = tree.registry.splits.findIndex((r) => r.regions[r.pinned]?.outcome === 'rejected')
  const row = tree.registry.splits[at]
  const pinned = row.regions[row.pinned]
  const released = { ...pinned, error: { ...pinned.error, message: 'the released answer' } }
  const measuredRegistry = {
    ...tree.registry,
    splits: tree.registry.splits.map((r, i) =>
      i === at ? { ...row, regions: { ...row.regions, [row.pinned]: released } } : r,
    ),
  }
  const git = (spec) => {
    const [at, path] = spec.split(':')
    if (at !== WHOLE.commit) throw new Error(`unexpected read at ${at}`)
    if (path === 'registry/suite-manifest.json') return JSON.stringify(measuredManifest)
    if (path === 'registry/splits.json') return JSON.stringify(measuredRegistry)
    throw new Error(`unexpected read of ${path}`)
  }
  const board = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'committed-')), 'summary.json')
    writeFileSync(path, JSON.stringify({ suite: WHOLE }))
    return path
  }
  const ran = (id) => {
    const [file, fullName] = id.split('::')
    return {
      slug: 'alpha',
      raw: { testResults: [{ name: `/repo/${file}`, assertionResults: [{ fullName, status: 'passed' }] }] },
    }
  }

  it('returns the suite definition at the board\'s commit, not the working tree\'s', () => {
    const out = committedGradingInputs(board(), { git })
    expect(out.measured).toEqual(WHOLE)
    expect(out.manifest.tests).toContain(onlyMeasured)
    expect(out.manifest.tests).not.toContain(onlyOnMain)
    expect(at, 'no row in the working tree pins a refusal').toBeGreaterThan(-1)
    expect(out.registry.splits[at].regions[row.pinned].error.message).toBe('the released answer')
    expect(tree.registry.splits[at].regions[row.pinned].error.message).not.toBe('the released answer')
    expect(out.registry).not.toEqual(tree.registry)
  })

  it('accepts a committed run naming a test only the measured suite defines', () => {
    const { manifest } = committedGradingInputs(board(), { git })
    expect(() => assertMeasuredSuite([ran(onlyMeasured)], suiteIdentities(manifest))).not.toThrow()
  })

  it('refuses a committed run naming a test only main defines', () => {
    const { manifest } = committedGradingInputs(board(), { git })
    expect(() => assertMeasuredSuite([ran(onlyOnMain)], suiteIdentities(manifest))).toThrow(
      /no longer defines/,
    )
  })

  it('refuses a board that names no measurement rather than reading the tree', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'committed-')), 'summary.json')
    writeFileSync(path, JSON.stringify({}))
    expect(() => committedGradingInputs(path, { git })).toThrow(/Refusing to fall back/)
  })
})
