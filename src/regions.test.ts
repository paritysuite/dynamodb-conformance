import { describe, expect, it } from 'vitest'
import {
  COMMERCIAL_REGIONS,
  DEFAULT_CEILINGS,
  EMULATOR_INDEX_BACKFILL_MS,
  indexTestTimeoutMs,
  REGION_CEILING_OVERRIDES,
  ceilingsFor,
} from './regions.js'

describe('ceilingsFor', () => {
  it('gives a region with no override the default ceilings', () => {
    expect(ceilingsFor('eu-west-2', undefined, false)).toEqual(DEFAULT_CEILINGS)
  })

  it('defaults are unchanged from the values the suite has always used', () => {
    // Nothing about the eu-west-2 run may change: these are the constants that
    // were previously hardcoded in src/helpers.ts and src/infra.ts.
    expect(DEFAULT_CEILINGS).toEqual({
      tableActiveMs: 120_000,
      crossRegionActiveMs: 60_000,
      gsiConsistencyMs: 10_000,
      indexBackfillMs: 2_400_000,
    })
  })

  it('waits 40 minutes for an added index on real DynamoDB', () => {
    expect(ceilingsFor('eu-west-2', undefined, false).indexBackfillMs).toBe(2_400_000)
  })

  it('waits 2 minutes for an added index on an emulator, leaving every other ceiling alone', () => {
    expect(EMULATOR_INDEX_BACKFILL_MS).toBe(120_000)
    expect(ceilingsFor('us-east-1', undefined, true)).toEqual({
      ...DEFAULT_CEILINGS,
      indexBackfillMs: 120_000,
    })
  })

  it('applies a per-region override on top of either index backfill ceiling', () => {
    const overrides = { 'ap-southeast-7': { indexBackfillMs: 3_600_000 } }
    expect(ceilingsFor('ap-southeast-7', overrides, false).indexBackfillMs).toBe(3_600_000)
    expect(ceilingsFor('ap-southeast-7', overrides, true).indexBackfillMs).toBe(3_600_000)
    // A region without an entry keeps its branch's ceiling.
    expect(ceilingsFor('eu-west-2', overrides, true).indexBackfillMs).toBe(120_000)
    expect(ceilingsFor('eu-west-2', overrides, false).indexBackfillMs).toBe(2_400_000)
  })

  it('applies a per-region override on top of the default', () => {
    const overrides = { 'ap-southeast-7': { tableActiveMs: 300_000 } }
    expect(ceilingsFor('ap-southeast-7', overrides, false)).toEqual({
      ...DEFAULT_CEILINGS,
      tableActiveMs: 300_000,
    })
    // Regions without an entry in the same table still get the default.
    expect(ceilingsFor('eu-west-2', overrides, false)).toEqual(DEFAULT_CEILINGS)
  })

  it('falls back to the default for an unknown region rather than throwing', () => {
    // A newly-launched AWS region must not break a run.
    expect(ceilingsFor('xx-nowhere-9', undefined, false)).toEqual(DEFAULT_CEILINGS)
    expect(ceilingsFor(undefined, undefined, false)).toEqual(DEFAULT_CEILINGS)
  })

  it('ships with an empty override table: numbers come from observation, not guesses', () => {
    expect(Object.keys(REGION_CEILING_OVERRIDES)).toHaveLength(0)
  })
})

describe('ceilingsFor with no emulator argument', () => {
  // Every caller in the suite takes this path, so it gets its own case: the
  // answer follows DYNAMODB_ENDPOINT, the variable that selects an emulator.
  it('reads the target from DYNAMODB_ENDPOINT', () => {
    const saved = process.env.DYNAMODB_ENDPOINT
    try {
      delete process.env.DYNAMODB_ENDPOINT
      expect(ceilingsFor('eu-west-2').indexBackfillMs).toBe(2_400_000)
      process.env.DYNAMODB_ENDPOINT = 'http://localhost:8000'
      expect(ceilingsFor('eu-west-2').indexBackfillMs).toBe(120_000)
      // Set but empty selects no endpoint, so it is still real DynamoDB.
      process.env.DYNAMODB_ENDPOINT = ''
      expect(ceilingsFor('eu-west-2').indexBackfillMs).toBe(2_400_000)
    } finally {
      if (saved === undefined) delete process.env.DYNAMODB_ENDPOINT
      else process.env.DYNAMODB_ENDPOINT = saved
    }
  })
})

describe('indexTestTimeoutMs', () => {
  const targets = [
    ['real DynamoDB', ceilingsFor('eu-west-2', undefined, false)],
    ['an emulator', ceilingsFor('eu-west-2', undefined, true)],
  ] as const

  it.each(targets)('outlasts table creation and one index wait on %s', (_name, c) => {
    expect(indexTestTimeoutMs(c)).toBe(c.tableActiveMs + c.indexBackfillMs + 60_000)
  })

  it.each(targets)('counts every index wait and any other bounded wait on %s', (_name, c) => {
    expect(indexTestTimeoutMs(c, { indexWaits: 2 })).toBe(
      c.tableActiveMs + 2 * c.indexBackfillMs + 60_000,
    )
    expect(indexTestTimeoutMs(c, { otherWaitsMs: 300_000 })).toBe(
      c.tableActiveMs + c.indexBackfillMs + 300_000 + 60_000,
    )
  })

  // Distinct primes, so reading the wrong ceiling changes the answer.
  const synthetic = {
    tableActiveMs: 7,
    crossRegionActiveMs: 11,
    gsiConsistencyMs: 13,
    indexBackfillMs: 17,
  }

  it('is longer than the waits it covers put together, whatever the ceilings', () => {
    expect(indexTestTimeoutMs(synthetic) - (7 + 17)).toBe(60_000)
    expect(indexTestTimeoutMs(synthetic, { indexWaits: 3 }) - (7 + 3 * 17)).toBe(60_000)
    expect(indexTestTimeoutMs(synthetic, { indexWaits: 2, otherWaitsMs: 19 }) - (7 + 2 * 17 + 19)).toBe(60_000)
  })

  it('never falls below the timeouts these tests had before the ceiling existed', () => {
    const real = ceilingsFor('eu-west-2', undefined, false)
    expect(indexTestTimeoutMs(real)).toBeGreaterThanOrEqual(2_460_000)
    expect(indexTestTimeoutMs(real, { indexWaits: 2 })).toBeGreaterThanOrEqual(4_920_000)
    expect(indexTestTimeoutMs(real, { otherWaitsMs: 300_000 })).toBeGreaterThanOrEqual(2_820_000)
  })
})

describe('COMMERCIAL_REGIONS', () => {
  it('is a non-empty set of well-formed commercial region names', () => {
    expect(COMMERCIAL_REGIONS.length).toBeGreaterThan(0)
    for (const region of COMMERCIAL_REGIONS) {
      expect(region).toMatch(/^[a-z]{2}(-[a-z]+)+-\d+$/)
    }
    expect(COMMERCIAL_REGIONS).toContain('eu-west-2')
    expect(COMMERCIAL_REGIONS).toContain('us-east-1')
  })

  it('contains no duplicates', () => {
    expect(new Set(COMMERCIAL_REGIONS).size).toBe(COMMERCIAL_REGIONS.length)
  })
})
