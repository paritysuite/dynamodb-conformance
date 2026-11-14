import { describe, it, expect } from 'vitest'
import {
  DynamoDBServiceException,
  InternalServerError,
  LimitExceededException,
  ProvisionedThroughputExceededException,
  RequestLimitExceeded,
  ResourceNotFoundException,
  ThrottlingException,
} from '@aws-sdk/client-dynamodb'
import {
  assertDynamoError,
  expectDynamoError,
  createTableRegistry,
  isSuiteTable,
  uniqueTableName,
  absentTableName,
  compositeIndexedTableDef,
  partiqlIndexTableDef,
  PARTIQL_UNPROJECTED_ATTR,
} from './helpers.js'
import { resolveTablePrefix, CI_TABLE_PREFIX, LOCAL_TABLE_NAMESPACE } from './table-namespace.js'
import {
  INDETERMINATE_REASONS,
  IndeterminateError,
  indeterminateFrom,
} from './indeterminate.js'
import { stampIndeterminateMarker } from './indeterminate-sink.js'
import type { TestTableDef } from './types.js'

// The declaration registry behind demand-driven provisioning. Asserted against
// a synthetic creator: what needs proving is how many times a table is created
// and how many times the sweep runs, neither of which the suite can observe
// about itself.

const def = (name: string): TestTableDef => ({
  name,
  hashKey: { name: 'pk', type: 'S' },
})

// Declarations are keyed by the file that made them, which under vitest is this
// test file.
const thisFile = expect.getState().testPath ?? 'unknown'

/** A creator that records what it was asked to create. */
function recordingCreator() {
  const calls: string[] = []
  return {
    calls,
    create: async (d: TestTableDef) => {
      calls.push(d.name)
    },
  }
}

describe('createTableRegistry — declarations', () => {
  it('collects the defs a file declares', () => {
    const r = createTableRegistry()
    r.declare(def('a'), def('b'))
    expect(r.declaredDefs().map((d) => d.name)).toEqual(['a', 'b'])
  })

  it('attributes declarations to the declaring file', () => {
    const r = createTableRegistry()
    r.declare(def('a'))
    expect(r.declaredBy(thisFile).map((d) => d.name)).toEqual(['a'])
    expect(r.declaredBy('some/other/file.test.ts')).toEqual([])
  })

  it('deduplicates a def declared by several files', () => {
    const r = createTableRegistry()
    const shared = def('shared')
    r.declare(shared)
    r.declare(shared)
    r.declare(shared)
    expect(r.declaredDefs()).toHaveLength(1)
  })

  it('starts empty, so a run that selects nothing creates nothing', () => {
    expect(createTableRegistry().declaredDefs()).toEqual([])
  })
})

describe('createTableRegistry — provisioning', () => {
  it('creates each declared table exactly once across repeated provisions', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    r.declare(def('a'), def('b'))

    // The shared beforeAll runs per test file; forty files declaring the same
    // def must still create it once.
    await r.provision(create)
    await r.provision(create)
    await r.provision(create)

    expect(calls).toEqual(['a', 'b'])
  })

  it('creates only what a later file newly declared', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()

    r.declare(def('first'))
    await r.provision(create)
    r.declare(def('first'), def('second'))
    await r.provision(create)

    expect(calls).toEqual(['first', 'second'])
  })

  it('creates only the declared subset, not every table in the suite', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    r.declare(def('only-this-one'))
    await r.provision(create)
    expect(calls).toEqual(['only-this-one'])
  })

  it('creates nothing for a file that declared nothing', async () => {
    // The property that makes an excluded axis honest. `--tags-filter` skips
    // tests but still imports the file, so an excluded file's declaration is
    // registered; only its hook never runs. Provisioning the whole registry
    // would create its tables on behalf of whichever file runs next.
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    r.declare(def('declared-by-an-excluded-file'))
    await r.provision(create, 'a/file/that/declared/nothing.test.ts')
    expect(calls).toEqual([])
  })

  it('creates only the requesting file\'s tables, not another file\'s', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    r.declare(def('ours'))
    await r.provision(create, thisFile)
    expect(calls).toEqual(['ours'])
  })

  it('does not create concurrently for a def already in flight', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    r.declare(def('a'))

    await Promise.all([r.provision(create), r.provision(create), r.provision(create)])

    expect(calls).toEqual(['a'])
  })

  it('propagates a creation failure so setup can record it at run level', async () => {
    const r = createTableRegistry()
    r.declare(def('a'))
    await expect(
      r.provision(async () => {
        throw new Error('CreateTable exploded')
      }),
    ).rejects.toThrow('CreateTable exploded')
  })

  it('retries a failed creation on the next attempt rather than replaying the rejection', async () => {
    const r = createTableRegistry()
    r.declare(def('a'))
    let attempts = 0
    const flaky = async () => {
      attempts++
      if (attempts === 1) throw new Error('transient')
    }

    await expect(r.provision(flaky)).rejects.toThrow('transient')
    await expect(r.provision(flaky)).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('does not retry a table that already succeeded when a sibling failed', async () => {
    const r = createTableRegistry()
    r.declare(def('good'), def('bad'))
    const seen: string[] = []
    const create = async (d: TestTableDef) => {
      seen.push(d.name)
      if (d.name === 'bad' && seen.filter((n) => n === 'bad').length === 1) {
        throw new Error('transient')
      }
    }

    await expect(r.provision(create)).rejects.toThrow('transient')
    await r.provision(create)

    expect(seen).toEqual(['good', 'bad', 'bad'])
  })
})

describe('createTableRegistry — the leftover sweep', () => {
  it('sweeps once however many files call it', async () => {
    const r = createTableRegistry()
    let sweeps = 0
    const sweep = async () => {
      sweeps++
    }

    await r.sweepOnce(sweep)
    await r.sweepOnce(sweep)
    await r.sweepOnce(sweep)

    expect(sweeps).toBe(1)
  })

  it('does not sweep again once tables have been provisioned', async () => {
    // A sweep sharing provisioning's guard would delete tables still in use.
    const r = createTableRegistry()
    const { create } = recordingCreator()
    let sweeps = 0
    const sweep = async () => {
      sweeps++
    }

    r.declare(def('a'))
    await r.sweepOnce(sweep)
    await r.provision(create)
    r.declare(def('b'))
    await r.sweepOnce(sweep)
    await r.provision(create)

    expect(sweeps).toBe(1)
  })

  it('sweeps once under concurrent callers', async () => {
    const r = createTableRegistry()
    let sweeps = 0
    const sweep = async () => {
      sweeps++
    }

    await Promise.all([r.sweepOnce(sweep), r.sweepOnce(sweep), r.sweepOnce(sweep)])

    expect(sweeps).toBe(1)
  })

  it('retries a failed sweep, so a transient fault does not skip cleanup for the run', async () => {
    const r = createTableRegistry()
    let attempts = 0
    const flaky = async () => {
      attempts++
      if (attempts === 1) throw new Error('ListTables exploded')
    }

    await expect(r.sweepOnce(flaky)).rejects.toThrow('ListTables exploded')
    await r.sweepOnce(flaky)
    await r.sweepOnce(flaky)

    expect(attempts).toBe(2)
  })

  it('sweeps before any table is created, on every file', async () => {
    // src/setup.ts awaits the sweep then provisions. This pins the ordering
    // that sequence exists to guarantee: nothing may be created before the
    // one sweep has finished, or the sweep deletes it again.
    const r = createTableRegistry()
    const order: string[] = []
    const sweep = async () => {
      await Promise.resolve()
      order.push('sweep')
    }
    const create = async (d: TestTableDef) => {
      order.push(`create:${d.name}`)
    }

    r.declare(def('a'))
    await r.sweepOnce(sweep)
    await r.provision(create)
    r.declare(def('b'))
    await r.sweepOnce(sweep)
    await r.provision(create)

    expect(order).toEqual(['sweep', 'create:a', 'create:b'])
  })

  it('keeps its guard independent of the provisioning memo', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    let sweeps = 0

    r.declare(def('a'))
    await expect(
      r.sweepOnce(async () => {
        sweeps++
        throw new Error('transient')
      }),
    ).rejects.toThrow('transient')
    await r.provision(create)
    await r.sweepOnce(async () => {
      sweeps++
    })

    expect({ sweeps, calls }).toEqual({ sweeps: 2, calls: ['a'] })
  })
})

describe('isSuiteTable', () => {
  it('selects a table in the given namespace', () => {
    expect(isSuiteTable(`${CI_TABLE_PREFIX}hash_1_0`, CI_TABLE_PREFIX)).toBe(true)
  })

  it('rejects a table in the other namespace, which is what protects a live run', () => {
    expect(isSuiteTable(`${CI_TABLE_PREFIX}hash_1_0`, '_capture_20260818_abcdef_')).toBe(false)
    expect(isSuiteTable(`${LOCAL_TABLE_NAMESPACE}hash_1_0`, CI_TABLE_PREFIX)).toBe(false)
  })

  it('rejects another local session in the same namespace', () => {
    expect(isSuiteTable('_capture_20260818_aaaaaa_hash_1_0', '_capture_20260818_bbbbbb_')).toBe(false)
  })

  it('rejects a table belonging to nobody', () => {
    expect(isSuiteTable('orders', CI_TABLE_PREFIX)).toBe(false)
  })
})

describe('uniqueTableName', () => {
  it('names into the namespace this run resolved', () => {
    expect(isSuiteTable(uniqueTableName('hash'))).toBe(true)
  })

  it('leaves at least three characters after the prefix, which some targets require', () => {
    const name = uniqueTableName('h')
    expect(name.slice(resolveTablePrefix().length).length).toBeGreaterThanOrEqual(3)
  })

  it('does not repeat a name within a run', () => {
    expect(uniqueTableName('hash')).not.toBe(uniqueTableName('hash'))
  })
})

describe('absentTableName', () => {
  // A name outside the namespace is refused by IAM before DynamoDB can answer
  // that the table is missing, so the test sees the wrong exception.
  it('sits inside the namespace this run can reach', () => {
    expect(isSuiteTable(absentTableName('nonexistent_table'))).toBe(true)
  })

  it('keeps the suffix it was given', () => {
    expect(absentTableName('nonexistent_table').endsWith('nonexistent_table')).toBe(true)
  })
})

// The fixture the PartiQL index-qualifier cases are captured against. Asserted
// here because the rules those cases encode are properties of the fixture as
// much as of DynamoDB: an index that projects everything cannot demonstrate a
// reach-back, and an attribute some index carries cannot demonstrate a
// rejection.
describe('partiqlIndexTableDef', () => {
  const gsis = partiqlIndexTableDef.gsis ?? []
  const lsis = partiqlIndexTableDef.lsis ?? []

  it('carries the five indexes the capture used, at the capture projections', () => {
    expect(gsis.map((g) => [g.indexName, g.projectionType])).toEqual([
      ['gsi-all', 'ALL'],
      ['gsi-inc', 'INCLUDE'],
      ['gsi-keys', 'KEYS_ONLY'],
    ])
    expect(lsis.map((l) => [l.indexName, l.projectionType])).toEqual([
      ['lsi-all', 'ALL'],
      ['lsi-keys', 'KEYS_ONLY'],
      ['lsi-inc', 'INCLUDE'],
    ])
  })

  // Two GSIs on one partition key is what lets a token minted against one be
  // replayed against the other, which is a case in its own right.
  it('gives two GSIs the same partition key attribute', () => {
    expect(gsis.find((g) => g.indexName === 'gsi-inc')!.hashKey.name).toBe('gsiPk2')
    expect(gsis.find((g) => g.indexName === 'gsi-keys')!.hashKey.name).toBe('gsiPk2')
  })

  // Scoped to the non-ALL indexes on purpose. An ALL index projects everything,
  // so it carries this attribute too and declares no NonKeyAttributes to say so:
  // asserting over every index would be an assertion that cannot fail rather
  // than one that holds.
  it('leaves the unprojected attribute out of every non-ALL index', () => {
    const partial = [
      ...gsis.filter((g) => g.projectionType !== 'ALL'),
      ...lsis.filter((l) => l.projectionType !== 'ALL'),
    ]
    expect(partial.length).toBeGreaterThan(0)

    for (const idx of partial) {
      const carried = [
        'hashKey' in idx ? idx.hashKey.name : undefined,
        idx.rangeKey?.name,
        ...(idx.nonKeyAttributes ?? []),
      ].filter(Boolean)
      expect(carried, idx.indexName).not.toContain(PARTIQL_UNPROJECTED_ATTR)
    }
  })

  // The other half of the same contract: the ALL indexes do carry it, which is
  // why a rejection case must not name one of them.
  it('records which indexes do project it, so a later case does not name one', () => {
    const all = [
      ...gsis.filter((g) => g.projectionType === 'ALL').map((g) => g.indexName),
      ...lsis.filter((l) => l.projectionType === 'ALL').map((l) => l.indexName),
    ]
    expect(all).toEqual(['gsi-all', 'lsi-all'])
  })

  // An ALL index projects everything, so it can never reject a projection or a
  // filter. The rules need an index that does not.
  it('includes an index projecting a named attribute and not that one', () => {
    const inc = gsis.find((g) => g.indexName === 'gsi-inc')!
    expect(inc.nonKeyAttributes).toEqual(['projattr'])
    expect(inc.nonKeyAttributes).not.toContain(PARTIQL_UNPROJECTED_ATTR)
  })

  // Separating rows walked from rows kept needs an LSI carrying a non-key
  // attribute to filter on: a KEYS_ONLY index has none, and its sort key is a
  // key condition rather than a filter.
  it('includes an LSI projecting a non-key attribute', () => {
    const inc = lsis.find((l) => l.indexName === 'lsi-inc')!
    expect(inc.nonKeyAttributes).toEqual(['projattr'])
    expect(inc.rangeKey.name).not.toBe('projattr')
  })

  it('is a separate table from the shared indexed def', () => {
    expect(partiqlIndexTableDef.name).not.toBe(compositeIndexedTableDef.name)
  })

  it('is a composite-key table, since the LSIs need a range key', () => {
    expect(partiqlIndexTableDef.hashKey.name).toBe('pk')
    expect(partiqlIndexTableDef.rangeKey?.name).toBe('sk')
  })
})

// expectDynamoError sits under a third of the suite, so these pin what it does
// with every outcome a request can have: accepted, the expected answer, a
// different answer, and no answer at all. No network: each request is a
// promise settled with a constructed error, shaped the way the SDK throws it.

/** What a call settled with: the value it threw, or 'resolved'. */
async function outcomeOf(run: () => Promise<unknown>): Promise<{ threw: unknown } | 'resolved'> {
  try {
    await run()
    return 'resolved'
  } catch (e) {
    return { threw: e }
  }
}

/** The message the helper failed with, or a marker if it did not fail. */
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  const outcome = await outcomeOf(run)
  if (outcome === 'resolved') return '<did not fail>'
  return (outcome.threw as Error).message
}

/** The message assertDynamoError alone gives for an error: the old helper's whole catch. */
function mismatchOf(error: unknown, name: string, message?: string | RegExp): string {
  try {
    assertDynamoError(error, name, message)
  } catch (e) {
    return (e as Error).message
  }
  return '<did not fail>'
}

function serviceError(
  name: string,
  status: number,
  extra: Record<string, unknown> = {},
): DynamoDBServiceException {
  return new DynamoDBServiceException({
    name,
    message: `${name} message`,
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status },
    ...extra,
  } as ConstructorParameters<typeof DynamoDBServiceException>[0])
}

/**
 * A copy of a thrown value as the test runner hands it to afterEach hooks.
 * Mirrors vitest's serializeValue (vitest/dist/chunks/source-map.*.js, which
 * can't be imported outside browser mode): every own property name along the
 * prototype chain, stopping at Object.prototype, copied recursively into an
 * object with no prototype, so nothing downstream can rely on instanceof.
 */
function runnerClone(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const v of value) out.push(runnerClone(v, seen))
    return out
  }
  const out = Object.create(null) as Record<string, unknown>
  seen.set(value, out)
  for (let o: object | null = value; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key in out) continue
      const v = (value as Record<string, unknown>)[key]
      out[key] = typeof v === 'function' ? `Function<${v.name || 'anonymous'}>` : runnerClone(v, seen)
    }
  }
  return out
}

function systemError(code: string): Error {
  // Node's syscall failures, as the SDK passes them up: the code is the only
  // identifying field, and an AggregateError can leave the message empty.
  return Object.assign(new Error(''), { code, $metadata: { attempts: 3 } })
}

// Every shape src/indeterminate.ts classifies as no answer, one entry per
// classification arm and per listed name or code.
const NO_ANSWER: [label: string, error: () => unknown][] = [
  ...INDETERMINATE_REASONS.map(
    (reason): [string, () => unknown] => [
      `IndeterminateError (${reason})`,
      () => new IndeterminateError(reason, `${reason} expired`),
    ],
  ),
  [
    'ThrottlingException',
    () => new ThrottlingException({ message: 'Rate exceeded', $metadata: { httpStatusCode: 400 } }),
  ],
  [
    'ProvisionedThroughputExceededException',
    () =>
      new ProvisionedThroughputExceededException({
        message: 'The level of configured provisioned throughput for the table was exceeded.',
        $metadata: { httpStatusCode: 400 },
      }),
  ],
  [
    'RequestLimitExceeded',
    () =>
      new RequestLimitExceeded({
        message: 'Throughput exceeds the current throughput limit for your account.',
        $metadata: { httpStatusCode: 400 },
      }),
  ],
  [
    'LimitExceededException',
    () =>
      new LimitExceededException({
        message: 'Subscriber limit exceeded',
        $metadata: { httpStatusCode: 400 },
      }),
  ],
  ...[
    'RequestThrottled',
    'RequestThrottledException',
    'ThrottledException',
    'Throttling',
    'TooManyRequestsException',
  ].map((name): [string, () => unknown] => [name, () => serviceError(name, 400)]),
  ['HTTP 429, any name', () => serviceError('SlowDown', 429)],
  [
    'retry trait marks it as a throttle',
    () => Object.assign(new Error('slow down'), { name: 'Bespoke', $retryable: { throttling: true } }),
  ],
  [
    'InternalServerError (HTTP 500, JSON body)',
    () =>
      new InternalServerError({ message: 'Internal server error', $metadata: { httpStatusCode: 500 } }),
  ],
  ['HTTP 503, unmodelled name', () => serviceError('ServiceUnavailable', 503)],
  ['server fault with no status', () => serviceError('InternalFailure', 0, { $fault: 'server', $metadata: {} })],
  [
    'HTML 500 body that fails to deserialise',
    () =>
      Object.assign(new SyntaxError(`Unexpected token '<', "<html><bod"... is not valid JSON`), {
        $metadata: { httpStatusCode: 500 },
      }),
  ],
  ...['TimeoutError', 'RequestTimeout', 'RequestTimeoutException'].map(
    (name): [string, () => unknown] => [
      name,
      () => Object.assign(new Error('socket hang up'), { name }),
    ],
  ),
  ...['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].map(
    (code): [string, () => unknown] => [code, () => systemError(code)],
  ),
]

describe('expectDynamoError', () => {
  it('passes when the expected error is thrown', async () => {
    const err = serviceError('ValidationException', 400)
    expect(
      await outcomeOf(() => expectDynamoError(() => Promise.reject(err), 'ValidationException', 'message')),
    ).toBe('resolved')
  })

  it('passes on a regex match, as before', async () => {
    const err = serviceError('ValidationException', 400)
    expect(
      await outcomeOf(() =>
        expectDynamoError(() => Promise.reject(err), 'ValidationException', /^ValidationException message$/),
      ),
    ).toBe('resolved')
  })

  it('fails an accepted request with a message saying it was accepted', async () => {
    const message = await failureOf(() =>
      expectDynamoError(() => Promise.resolve({}), 'ValidationException'),
    )
    expect(message).toBe('expected ValidationException, but the request was accepted')
  })

  it('names the expected message or pattern when an accepted request was meant to fail', async () => {
    expect(
      await failureOf(() =>
        expectDynamoError(() => Promise.resolve({}), 'ValidationException', 'Invalid KeyConditionExpression'),
      ),
    ).toBe(
      'expected ValidationException with a message containing "Invalid KeyConditionExpression", but the request was accepted',
    )
    expect(
      await failureOf(() => expectDynamoError(() => Promise.resolve({}), 'ValidationException', /^Bad/)),
    ).toBe('expected ValidationException with a message matching /^Bad/, but the request was accepted')
  })

  it('keeps an accepted request a real failure, not a no-answer', async () => {
    const outcome = await outcomeOf(() =>
      expectDynamoError(() => Promise.resolve({}), 'ValidationException'),
    )
    expect(outcome).not.toBe('resolved')
    const thrown = (outcome as { threw: unknown }).threw
    expect((thrown as Error).name).toBe('AssertionError')
    expect(indeterminateFrom(thrown)).toBeNull()
  })

  it.each(NO_ANSWER)(
    'rethrows %s unchanged, so the run records no answer',
    async (_label, make) => {
      const original = make()
      const raw = indeterminateFrom(original)
      // The table above is only worth something if every entry really is a
      // no-answer shape to the classifier.
      expect(raw).not.toBeNull()

      const outcome = await outcomeOf(() =>
        expectDynamoError(() => Promise.reject(original), 'ValidationException'),
      )
      expect(outcome).not.toBe('resolved')
      const thrown = (outcome as { threw: unknown }).threw
      expect(thrown).toBe(original)
      expect(indeterminateFrom(thrown)?.reason).toBe(raw!.reason)
    },
  )

  // The afterEach hook in src/setup.ts never sees the thrown value itself: the
  // runner clones it first. This pins the whole helper -> marker path for every
  // shape, on the clone the hook actually gets.
  it.each(NO_ANSWER)(
    'stamps the no-answer marker for %s rethrown by the helper, once the runner has cloned it',
    async (_label, make) => {
      const original = make()
      const outcome = await outcomeOf(() =>
        expectDynamoError(() => Promise.reject(original), 'ConditionalCheckFailedException'),
      )
      const clone = runnerClone((outcome as { threw: unknown }).threw)
      expect(Object.getPrototypeOf(clone)).toBeNull()

      const task: Parameters<typeof stampIndeterminateMarker>[0] = {
        meta: {},
        result: { state: 'fail', errors: [clone] },
      }
      stampIndeterminateMarker(task)
      expect(task.meta.indeterminate).toEqual({ reason: indeterminateFrom(original)!.reason, at: 'test' })
    },
  )

  it('rethrows a no-answer error that fn throws synchronously', async () => {
    const original = new ThrottlingException({ message: 'Rate exceeded', $metadata: { httpStatusCode: 400 } })
    const fn = (() => {
      throw original
    }) as () => Promise<unknown>
    const outcome = await outcomeOf(() => expectDynamoError(fn, 'ValidationException'))
    expect((outcome as { threw: unknown }).threw).toBe(original)
  })

  it('passes when fn synchronously throws the expected error', async () => {
    const fn = (() => {
      throw serviceError('ValidationException', 400)
    }) as () => Promise<unknown>
    expect(await outcomeOf(() => expectDynamoError(fn, 'ValidationException'))).toBe('resolved')
  })

  it('reports an fn that returns a plain value, not a promise, as accepted', async () => {
    const fn = (() => 42) as unknown as () => Promise<unknown>
    expect(await failureOf(() => expectDynamoError(fn, 'ValidationException'))).toBe(
      'expected ValidationException, but the request was accepted',
    )
  })

  // An expected error wins: when a test asks for an error that also sits in the
  // no-answer set, getting it is the answer.
  it.each([
    ['LimitExceededException', () => new LimitExceededException({ message: 'Subscriber limit exceeded', $metadata: { httpStatusCode: 400 } })],
    ['ThrottlingException', () => new ThrottlingException({ message: 'Rate exceeded', $metadata: { httpStatusCode: 400 } })],
    ['InternalServerError', () => new InternalServerError({ message: 'Internal server error', $metadata: { httpStatusCode: 500 } })],
  ] as const)('passes when the expected error is %s, which is otherwise no answer', async (name, make) => {
    expect(
      await outcomeOf(() => expectDynamoError(() => Promise.reject(make()), name)),
    ).toBe('resolved')
  })

  it('fails, not no-answer, when the expected name is in the no-answer set but the message differs', async () => {
    const err = new LimitExceededException({ message: 'some other limit', $metadata: { httpStatusCode: 400 } })
    const outcome = await outcomeOf(() =>
      expectDynamoError(() => Promise.reject(err), 'LimitExceededException', 'Subscriber limit exceeded'),
    )
    const thrown = (outcome as { threw: unknown }).threw
    expect((thrown as Error).message).toBe("expected 'some other limit' to contain 'Subscriber limit exceeded'")
    expect(indeterminateFrom(thrown)).toBeNull()
  })

  // A different definite answer fails exactly as it always has. The expected
  // strings are the old helper's messages, captured before the change.
  it.each([
    [
      'a different error name',
      () => new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: { httpStatusCode: 400 } }),
      'ValidationException',
      undefined,
      "expected 'ResourceNotFoundException' to be 'ValidationException' // Object.is equality",
    ],
    [
      'the right name with the wrong message',
      () => serviceError('ValidationException', 400),
      'ValidationException',
      'nope',
      "expected 'ValidationException message' to contain 'nope'",
    ],
    [
      'the right name failing a pattern',
      () => serviceError('ValidationException', 400),
      'ValidationException',
      /^nope$/,
      "expected 'ValidationException message' to match /^nope$/",
    ],
    [
      'HTTP 501, which is a definite answer about scope',
      () => serviceError('NotImplemented', 501),
      'ValidationException',
      undefined,
      "expected 'NotImplemented' to be 'ValidationException' // Object.is equality",
    ],
    [
      'a 400 body that fails to deserialise',
      () => Object.assign(new SyntaxError('Unexpected token'), { $metadata: { httpStatusCode: 400 } }),
      'ValidationException',
      undefined,
      'expected SyntaxError: Unexpected token { …(1) } to be an instance of DynamoDBServiceException',
    ],
    [
      'a TypeError from the test code',
      () => new TypeError('x is not a function'),
      'ValidationException',
      undefined,
      'expected TypeError: x is not a function to be an instance of DynamoDBServiceException',
    ],
    [
      'a thrown undefined',
      () => undefined,
      'ValidationException',
      undefined,
      'expected undefined to be defined',
    ],
    [
      'a thrown null',
      () => null,
      'ValidationException',
      undefined,
      'expected null to be an instance of DynamoDBServiceException',
    ],
    [
      'a thrown string',
      () => 'a string',
      'ValidationException',
      undefined,
      "expected 'a string' to be an instance of DynamoDBServiceException",
    ],
  ] as [string, () => unknown, string, string | RegExp | undefined, string][])('fails on %s with the same message as before', async (_label, make, name, message, expected) => {
    const err = make()
    const got = await failureOf(() => expectDynamoError(() => Promise.reject(err), name, message))
    expect(got).toBe(expected)
    expect(got).toBe(mismatchOf(err, name, message))
  })
})
