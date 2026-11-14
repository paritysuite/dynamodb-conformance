// The commercial region set and per-region wait-ceiling profiles.
//
// Every ceiling in the suite (time to table ACTIVE, the cross-region helper's
// tighter bound, GSI read consistency, an added index's backfill) was tuned in
// eu-west-2, a large mature region. A ceiling tuned in one region can
// manufacture timeouts in another, so the ceilings live behind a per-region
// profile with a default and per-region overrides.
//
// This is a noise remedy and nothing more. It reduces how often a valid slow
// operation gets misread as absent; it is NOT what stops a timeout from being
// read as a behavioural disagreement. That guarantee is structural and lives
// in src/indeterminate.ts and the result classification, regardless of any
// number in this file.
//
// One ceiling also depends on whether the target is real DynamoDB or an
// emulator: the wait for an index added to an existing table.
//
// This file has no imports, and has to stay that way. scripts/cleanup-orphans.mjs
// loads it under plain node, which strips the types but does not map a
// `./x.js` specifier to `x.ts`.

/**
 * The commercial (aws partition) regions. GovCloud and China are separate
 * partitions needing separate accounts, and are out of scope. This enumeration
 * is a starting set, refreshed as regions launch; an unlisted region still
 * resolves ceilings via the default, so staleness here is never a correctness
 * problem (see ceilingsFor).
 */
export const COMMERCIAL_REGIONS = [
  'af-south-1',
  'ap-east-1',
  'ap-east-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-6',
  'ap-southeast-7',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'mx-central-1',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
] as const

export interface WaitCeilings {
  /** waitUntilActive: table and all GSIs ACTIVE. */
  tableActiveMs: number
  /** waitUntilActiveInRegion: the cross-region helper's tighter bound. */
  crossRegionActiveMs: number
  /** waitForGsiConsistency: a GSI reflecting written items. */
  gsiConsistencyMs: number
  /**
   * An index added to an existing table by UpdateTable becoming ACTIVE. On
   * real DynamoDB this is an online backfill, observed taking 25+ minutes
   * (eu-west-2, 2026-07-12) even on an empty table, so the ceiling is long.
   */
  indexBackfillMs: number
}

/** Today's values, tuned in eu-west-2. The default for every region. */
export const DEFAULT_CEILINGS: WaitCeilings = {
  tableActiveMs: 120_000,
  crossRegionActiveMs: 60_000,
  gsiConsistencyMs: 10_000,
  indexBackfillMs: 2_400_000,
}

/**
 * The index backfill ceiling on any emulator. No emulator in the published
 * results has needed more than about 31 seconds for an index test to pass, so
 * two minutes is generous, and an index that never completes costs two minutes
 * rather than forty. Every emulator gets the same ceiling.
 */
export const EMULATOR_INDEX_BACKFILL_MS = 120_000

/**
 * Per-region overrides, deliberately empty. Nobody has measured what these
 * numbers should be outside eu-west-2, and a guess would be worse than the
 * default; entries are added from observed behaviour, not speculation.
 */
export const REGION_CEILING_OVERRIDES: Readonly<
  Record<string, Partial<WaitCeilings>>
> = {}

/**
 * The wait ceilings for a region: the default, with any per-region override
 * applied on top. An unknown or unset region gets the default rather than an
 * error, so a newly-launched AWS region can never break a run. On an emulator
 * the index backfill ceiling is the emulator one; a per-region override still
 * applies on top of either.
 */
export function ceilingsFor(
  region?: string,
  overrides: Readonly<Record<string, Partial<WaitCeilings>>> = REGION_CEILING_OVERRIDES,
  // The same test as isEmulator in src/aws-config.ts, repeated here because
  // this file cannot import it.
  emulator: boolean = Boolean(process.env.DYNAMODB_ENDPOINT),
): WaitCeilings {
  const base = emulator
    ? { ...DEFAULT_CEILINGS, indexBackfillMs: EMULATOR_INDEX_BACKFILL_MS }
    : DEFAULT_CEILINGS
  const override = region ? overrides[region] : undefined
  return { ...base, ...override }
}

/**
 * The vitest timeout for a test that creates a table and then waits on an
 * index added to it: every bounded wait inside the test, plus a minute. The
 * test timeout has to outlast the waits, or vitest ends the test as a failure
 * before an expired wait can be reported as no answer.
 */
export function indexTestTimeoutMs(
  ceilings: WaitCeilings,
  { indexWaits = 1, otherWaitsMs = 0 }: { indexWaits?: number; otherWaitsMs?: number } = {},
): number {
  return ceilings.tableActiveMs + indexWaits * ceilings.indexBackfillMs + otherWaitsMs + 60_000
}
