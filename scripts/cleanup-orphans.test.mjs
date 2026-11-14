import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_AGE_HOURS,
  DEFAULT_PREFIXES,
  KNOWN_PREFIXES,
  exitVerdict,
  parseArgs,
  cleanupAll,
  selectOrphans,
} from './cleanup-orphans.mjs'
import { COMMERCIAL_REGIONS } from '../src/regions.ts'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-07-11T12:00:00Z')
const maxAgeMs = DEFAULT_MAX_AGE_HOURS * HOUR

function table(name, ageHours) {
  return { name, creationDateTime: new Date(NOW - ageHours * HOUR).toISOString() }
}

describe('selectOrphans', () => {
  it('selects stray _conformance_ tables older than the threshold', () => {
    // Ages are relative to the threshold so this tracks the credential ceiling
    // rather than pinning a number the workflows can move out from under it.
    const tables = [
      table('_conformance_users_170000_1', DEFAULT_MAX_AGE_HOURS + 23),
      table('_conformance_orders_170000_2', DEFAULT_MAX_AGE_HOURS + 1),
    ]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([
      '_conformance_orders_170000_2',
      '_conformance_users_170000_1',
    ])
  })

  it('never selects a table young enough to belong to a run still in flight', () => {
    // A live run's tables cannot outlive its six-hour credential ceiling, so
    // anything under the seven-hour default might still be in use.
    const tables = [table('_conformance_live_170000_3', DEFAULT_MAX_AGE_HOURS - 1)]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([])
  })

  it('a table exactly at the threshold is not yet an orphan: selection is strictly older-than', () => {
    const tables = [table('_conformance_edge_170000_4', DEFAULT_MAX_AGE_HOURS)]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([])
    expect(
      selectOrphans([table('_conformance_edge_170000_4', DEFAULT_MAX_AGE_HOURS + 0.001)], {
        now: NOW,
        maxAgeMs,
      }),
    ).toEqual(['_conformance_edge_170000_4'])
  })

  it('never selects a table without the _conformance_ prefix, however old', () => {
    const tables = [
      table('production-users', 24 * 365),
      table('conformance_missing_underscore', 100),
      table('_conformance_stray_170000_5', 100),
    ]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([
      '_conformance_stray_170000_5',
    ])
  })

  it('sweeps only the prefixes it is asked for: a capture table survives a conformance sweep', () => {
    // The whole point of the prefix split: the run's cleanup must not reach
    // into the capture identity's namespace, however old the table looks.
    const tables = [
      table('_capture_20260812_wk1_dup', 100),
      table('_conformance_stray_170000_5', 100),
    ]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([
      '_conformance_stray_170000_5',
    ])
    expect(selectOrphans(tables, { now: NOW, maxAgeMs, prefixes: ['_capture_'] })).toEqual([
      '_capture_20260812_wk1_dup',
    ])
  })

  it('sweeps both namespaces when asked for both, and neither owns a foreign table', () => {
    const tables = [
      table('_capture_20260812_wk2_vidx', 100),
      table('_conformance_stray_170000_5', 100),
      table('production-users', 24 * 365),
      table('capture_missing_underscore', 100),
    ]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs, prefixes: KNOWN_PREFIXES })).toEqual([
      '_capture_20260812_wk2_vidx',
      '_conformance_stray_170000_5',
    ])
  })

  it('age-gates the capture prefix on the same threshold, convention or not', () => {
    // Seven hours is a hard bound for _conformance_ (the OIDC credential
    // ceiling) and a convention for _capture_ (nothing stops a local session
    // running longer). Selection does not care which: both are gated.
    const young = [table('_capture_20260812_wk1_live', DEFAULT_MAX_AGE_HOURS - 1)]
    expect(selectOrphans(young, { now: NOW, maxAgeMs, prefixes: ['_capture_'] })).toEqual([])
    const old = [table('_capture_20260812_wk1_dead', DEFAULT_MAX_AGE_HOURS + 1)]
    expect(selectOrphans(old, { now: NOW, maxAgeMs, prefixes: ['_capture_'] })).toEqual([
      '_capture_20260812_wk1_dead',
    ])
  })

  it('leaves a table whose age cannot be established alone: no deletion on missing evidence', () => {
    const tables = [
      { name: '_conformance_undated_170000_6' },
      { name: '_conformance_garbled_170000_7', creationDateTime: 'not a date' },
    ]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([])
  })

  it('a region with no strays is a clean no-op', () => {
    expect(selectOrphans([], { now: NOW, maxAgeMs })).toEqual([])
  })
})

describe('cleanupAll', () => {
  it('an unreachable region is reported and skipped, never aborting the others', async () => {
    const visited = []
    const { cleaned, failures } = await cleanupAll(['eu-west-2', 'sa-east-1', 'us-east-1'], {
      cleanup: async (region) => {
        visited.push(region)
        if (region === 'sa-east-1') throw new Error('connect ETIMEDOUT')
        return { deleted: [], failed: [] }
      },
    })
    expect(visited).toEqual(['eu-west-2', 'sa-east-1', 'us-east-1'])
    expect(Object.keys(cleaned)).toEqual(['eu-west-2', 'us-east-1'])
    expect(failures).toEqual([{ region: 'sa-east-1', message: 'connect ETIMEDOUT' }])
  })
})

describe('parseArgs', () => {
  it('defaults to every commercial region, the default age threshold, and _conformance_ alone', () => {
    const args = parseArgs([])
    expect(args.regions).toEqual([...COMMERCIAL_REGIONS])
    expect(args.maxAgeHours).toBe(DEFAULT_MAX_AGE_HOURS)
    expect(args.dryRun).toBe(false)
    // A silently widening default would hand back the race the prefix split
    // removed: an unasked-for sweep of the capture namespace.
    expect(args.prefixes).toEqual(['_conformance_'])
    expect(DEFAULT_PREFIXES).toEqual(['_conformance_'])
  })

  it('accepts a region subset, a threshold override, and dry-run', () => {
    const args = parseArgs(['--dry-run', '--max-age-hours', '6', 'eu-west-2', 'us-east-1'])
    expect(args).toEqual({
      regions: ['eu-west-2', 'us-east-1'],
      prefixes: ['_conformance_'],
      maxAgeHours: 6,
      dryRun: true,
    })
  })

  it('takes a prefix repeated, comma-separated, or on its own', () => {
    expect(parseArgs(['--prefix', '_capture_']).prefixes).toEqual(['_capture_'])
    expect(parseArgs(['--prefix', '_capture_,_conformance_']).prefixes).toEqual([
      '_capture_',
      '_conformance_',
    ])
    expect(
      parseArgs(['--prefix', '_conformance_', '--prefix', ' _capture_ ']).prefixes,
    ).toEqual(['_conformance_', '_capture_'])
  })

  it('names a prefix once however often it is repeated', () => {
    expect(parseArgs(['--prefix', '_capture_,_capture_', '--prefix', '_capture_']).prefixes)
      .toEqual(['_capture_'])
  })

  it('rejects a prefix outside the allowlist rather than sweeping under it', () => {
    // The script holds DeleteTable in every commercial region, so a typo must
    // not become the prefix it deletes by.
    expect(() => parseArgs(['--prefix', '_conformance'])).toThrow(/unknown prefix/)
    expect(() => parseArgs(['--prefix', '_'])).toThrow(/unknown prefix/)
    expect(() => parseArgs(['--prefix', ''])).toThrow(/at least one prefix/)
    expect(() => parseArgs(['--prefix'])).toThrow(/at least one prefix/)
  })

  it('rejects a threshold that is not a positive number', () => {
    expect(() => parseArgs(['--max-age-hours', '0'])).toThrow(/positive number/)
    expect(() => parseArgs(['--max-age-hours', 'soon'])).toThrow(/positive number/)
  })

  it('rejects unknown options rather than ignoring them', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown option/)
  })
})

// The daily-cron alarm contract: red means a human must look. Unreachable
// regions (opt-in enablement pending, a regional wobble) warn instead, so the
// alarm never trains anyone to ignore it - but nothing walked at all stays
// loudly red, and an undeletable orphan always wins.
describe('exitVerdict', () => {
  it('one unreachable region among reachable ones warns rather than fails', () => {
    expect(exitVerdict({ stuck: 0, unreachable: 1, regionCount: 34 })).toEqual({
      code: 0,
      reason: null,
      warn: true,
    })
  })

  it('a majority of regions unreachable is a systemic failure and exits 1', () => {
    const all = exitVerdict({ stuck: 0, unreachable: 34, regionCount: 34 })
    expect(all.code).toBe(1)
    expect(all.reason).toMatch(/systemic, not regional/)
    // The boundary: 17 of 34 warns, 18 of 34 fails.
    expect(exitVerdict({ stuck: 0, unreachable: 17, regionCount: 34 })).toEqual({
      code: 0,
      reason: null,
      warn: true,
    })
    expect(exitVerdict({ stuck: 0, unreachable: 18, regionCount: 34 }).code).toBe(1)
  })

  it('the opt-in enablement window stays on the warning path', () => {
    // Six disabled opt-in regions must not redden the daily run.
    expect(exitVerdict({ stuck: 0, unreachable: 6, regionCount: 34 })).toEqual({
      code: 0,
      reason: null,
      warn: true,
    })
  })

  it('an undeletable orphan fails the run even with unreachable regions present', () => {
    const verdict = exitVerdict({ stuck: 2, unreachable: 1, regionCount: 34 })
    expect(verdict.code).toBe(1)
    expect(verdict.reason).toMatch(/2 undeletable/)
  })

  it('a clean run exits 0 with no warning, an undeletable-only run exits 1: the old contract holds', () => {
    expect(exitVerdict({ stuck: 0, unreachable: 0, regionCount: 34 })).toEqual({
      code: 0,
      reason: null,
      warn: false,
    })
    expect(exitVerdict({ stuck: 1, unreachable: 0, regionCount: 34 }).code).toBe(1)
  })
})

describe('running under plain node', () => {
  // The sweep runs this script as `node scripts/cleanup-orphans.mjs`, with no
  // bundler. It imports src/regions.ts, and Node strips the types but does not
  // map a `./x.js` specifier to `x.ts`, so a relative import added to that file
  // stops the script at link time while vitest, which does map it, stays green.
  it('loads with its imports resolved', { timeout: 30_000 }, () => {
    // Imported, not executed: the script only sweeps when it is the entry
    // point, so this touches no network.
    const script = new URL('./cleanup-orphans.mjs', import.meta.url).href
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(script)}); console.log(m.parseArgs([]).regions.length)`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    )
    expect(Number(out.trim())).toBe(COMMERCIAL_REGIONS.length)
  })
})
