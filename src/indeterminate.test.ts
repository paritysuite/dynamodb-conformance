import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DynamoDBServiceException,
  InternalServerError,
  ProvisionedThroughputExceededException,
  ResourceNotFoundException,
  ThrottlingException,
} from '@aws-sdk/client-dynamodb'
import {
  IndeterminateError,
  indeterminateFrom,
  indeterminateReasonOf,
} from './indeterminate.js'

// The wait helpers talk to the shared client; mock it so these tests are pure
// logic with no AWS access and no network.
vi.mock('./client.js', () => ({
  ddb: { send: vi.fn() },
  ddbStreams: { send: vi.fn() },
}))

import { ddb } from './client.js'
import { waitForGsiConsistency, waitForReadsToSettle, waitUntilActive } from './helpers.js'
import { waitUntilActiveInRegion } from './infra.js'

const send = vi.mocked(ddb.send)

beforeEach(() => {
  send.mockReset()
})

// Respond after a couple of milliseconds so a 1ms ceiling deterministically
// expires after exactly one poll, keeping the timeout tests fast.
function slowResponse<T>(value: T): () => Promise<T> {
  return async () => {
    await new Promise((r) => setTimeout(r, 5))
    return value
  }
}

describe('IndeterminateError', () => {
  it('carries a reason code and a conventional name', () => {
    const err = new IndeterminateError('transport', 'socket hang up')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('IndeterminateError')
    expect(err.reason).toBe('transport')
    expect(err.message).toBe('socket hang up')
  })

  it('preserves the underlying cause when given one', () => {
    const cause = new Error('boom')
    const err = new IndeterminateError('throttle-exhausted', 'rate exceeded', { cause })
    expect(err.cause).toBe(cause)
  })
})

describe('indeterminateReasonOf', () => {
  it('reads the reason from a live IndeterminateError', () => {
    const err = new IndeterminateError('gsi-consistency-timeout', 'timed out')
    expect(indeterminateReasonOf(err)).toBe('gsi-consistency-timeout')
  })

  it('reads the reason from a serialised copy (name + reason survive, instanceof does not)', () => {
    // Vitest's error processing clones errors into plain objects before hooks
    // see them, so detection must not depend on the prototype chain.
    const serialised = {
      name: 'IndeterminateError',
      reason: 'table-active-timeout',
      message: 'Timeout waiting for table x to become ACTIVE',
    }
    expect(indeterminateReasonOf(serialised)).toBe('table-active-timeout')
  })

  it('rejects a serialised copy carrying an unknown reason', () => {
    expect(
      indeterminateReasonOf({ name: 'IndeterminateError', reason: 'not-a-reason' }),
    ).toBeNull()
  })

  it('is null for anything else', () => {
    expect(indeterminateReasonOf(new Error('plain'))).toBeNull()
    expect(indeterminateReasonOf(undefined)).toBeNull()
    expect(indeterminateReasonOf('IndeterminateError')).toBeNull()
  })
})

describe('indeterminateFrom', () => {
  it('passes an existing IndeterminateError through unchanged', () => {
    const err = new IndeterminateError('transport', 'socket hang up')
    expect(indeterminateFrom(err)).toBe(err)
  })

  it('rebuilds a typed error from a serialised IndeterminateError', () => {
    const serialised = {
      name: 'IndeterminateError',
      reason: 'gsi-consistency-timeout',
      message: 'timed out',
    }
    const err = indeterminateFrom(serialised)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect(err?.reason).toBe('gsi-consistency-timeout')
  })

  it('classifies a throttle that survived SDK retry as indeterminate', () => {
    const throttle = new ThrottlingException({
      message: 'Rate exceeded',
      $metadata: { httpStatusCode: 400 },
    })
    const err = indeterminateFrom(throttle)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect(err?.reason).toBe('throttle-exhausted')
    expect(err?.cause).toBe(throttle)
  })

  it('classifies a provisioned-throughput throttle as indeterminate', () => {
    const throttle = new ProvisionedThroughputExceededException({
      message: 'The level of configured provisioned throughput for the table was exceeded',
      $metadata: { httpStatusCode: 400 },
    })
    expect(indeterminateFrom(throttle)?.reason).toBe('throttle-exhausted')
  })

  it('classifies a throttle marked by the retry trait, whatever its name', () => {
    const marked = {
      name: 'SomethingBespoke',
      message: 'slow down',
      $retryable: { throttling: true },
    }
    expect(indeterminateFrom(marked)?.reason).toBe('throttle-exhausted')
  })

  it('classifies a 5xx service fault as indeterminate', () => {
    const ise = new InternalServerError({
      message: 'Internal server error',
      $metadata: { httpStatusCode: 500 },
    })
    expect(indeterminateFrom(ise)?.reason).toBe('transport')
  })

  it('classifies a transport-level failure as indeterminate', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), {
      code: 'ECONNREFUSED',
    })
    expect(indeterminateFrom(refused)?.reason).toBe('transport')

    const socketTimeout = Object.assign(new Error('socket timed out'), {
      name: 'TimeoutError',
    })
    expect(indeterminateFrom(socketTimeout)?.reason).toBe('transport')
  })

  it('never classifies a ValidationException: it is a definite answer', () => {
    // The edge case that matters most. A validation error is DynamoDB answering,
    // and it must remain eligible to mint a split.
    const validation = new DynamoDBServiceException({
      name: 'ValidationException',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
      message:
        'One or more parameter values were invalid: Null attribute value types must have the value of true',
    } as ConstructorParameters<typeof DynamoDBServiceException>[0])
    expect(indeterminateFrom(validation)).toBeNull()
  })

  it('never classifies a ResourceNotFoundException: an absent table is a real answer', () => {
    const notFound = new ResourceNotFoundException({
      message: 'Requested resource not found',
      $metadata: { httpStatusCode: 400 },
    })
    expect(indeterminateFrom(notFound)).toBeNull()
  })

  it('never classifies an HTTP 501 unsupported operation, despite it being a 5xx', () => {
    // 501 sits inside the range isTransport reads as "may never have been
    // evaluated", but it means "not implemented" - a definite answer about
    // scope. A target signalling unimplemented operations this way would
    // otherwise have every one of those answers silently dropped from its
    // denominator, flattering its score. Regression cover for exactly that.
    const unsupported = new DynamoDBServiceException({
      name: 'UnsupportedOperation',
      $fault: 'server',
      $metadata: { httpStatusCode: 501 },
      message: "Operation 'TransactWriteItems' is not supported by the wasm preview engine",
    } as ConstructorParameters<typeof DynamoDBServiceException>[0])
    expect(indeterminateFrom(unsupported)).toBeNull()
  })

  it('never classifies an UnknownOperationException, even when it arrives as a 5xx', () => {
    // Exercises the guard's name arm specifically: a 5xx server fault would be
    // classified 'transport' by isTransport, so this only returns null because
    // isUnsupportedFault recognises the name and short-circuits first. Reverting
    // the guard would regress this to a transport indeterminate. (The canonical
    // 400 shape falls through to null with or without the guard, so it would not
    // catch a regression - hence the deliberate 5xx here.)
    const unknown = new DynamoDBServiceException({
      name: 'UnknownOperationException',
      $fault: 'server',
      $metadata: { httpStatusCode: 500 },
      message: 'Unknown operation',
    } as ConstructorParameters<typeof DynamoDBServiceException>[0])
    expect(indeterminateFrom(unknown)).toBeNull()
  })

  it('still classifies a genuine 500 as transport, so the 501 carve-out is narrow', () => {
    // The carve-out must not become "any 5xx is a real answer". A 500 with no
    // unsupported wording stays indeterminate.
    const ise = new DynamoDBServiceException({
      name: 'InternalServerError',
      $fault: 'server',
      $metadata: { httpStatusCode: 500 },
      message: 'Internal server error',
    } as ConstructorParameters<typeof DynamoDBServiceException>[0])
    expect(indeterminateFrom(ise)?.reason).toBe('transport')
  })

  it('treats a 5xx whose message says "not implemented" as unsupported, not transport', () => {
    // The precise edge that defines the carve-out's width: isUnsupportedFault
    // matches the message anywhere, so a 5xx carrying unsupported wording (not
    // just a 501) is a scored fail, never a dropped observation. This is the
    // honest direction - a would-be-dropped answer becomes a real result, so it
    // can only count against a target, never flatter it - but pin it so the
    // width is deliberate rather than incidental.
    const oddball = new DynamoDBServiceException({
      name: 'InternalServerError',
      $fault: 'server',
      $metadata: { httpStatusCode: 500 },
      message: "Operation 'Foo' is not supported by this engine",
    } as ConstructorParameters<typeof DynamoDBServiceException>[0])
    expect(indeterminateFrom(oddball)).toBeNull()
  })

  it('is null for a plain error and for an assertion failure', () => {
    expect(indeterminateFrom(new Error('expected 1 to be 2'))).toBeNull()
    expect(
      indeterminateFrom({ name: 'AssertionError', message: 'expected 1 to be 2' }),
    ).toBeNull()
  })
})

describe('waitUntilActive', () => {
  it('returns cleanly when the table and its GSIs reach ACTIVE (no error, no annotation)', async () => {
    send.mockResolvedValue({
      Table: {
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexStatus: 'ACTIVE' }],
      },
    } as never)
    await expect(waitUntilActive('t', 1_000)).resolves.toBeUndefined()
  })

  it('throws IndeterminateError with the table-ACTIVE reason on timeout, not a bare Error', async () => {
    send.mockImplementation(slowResponse({ Table: { TableStatus: 'CREATING' } }) as never)
    const err = await waitUntilActive('t', 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('table-active-timeout')
  })

  it('times out with the typed error while a GSI is still backfilling', async () => {
    send.mockImplementation(
      slowResponse({
        Table: {
          TableStatus: 'ACTIVE',
          GlobalSecondaryIndexes: [{ IndexStatus: 'CREATING' }],
        },
      }) as never,
    )
    const err = await waitUntilActive('t', 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('table-active-timeout')
  })

  it('still throws a plain error when DescribeTable returns no table: that is an answer', async () => {
    send.mockResolvedValue({} as never)
    const err = await waitUntilActive('t', 1_000).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(IndeterminateError)
  })
})

describe('waitForGsiConsistency', () => {
  const opts = {
    tableName: 't',
    indexName: 'gsi1',
    partitionKey: { name: 'pk', value: { S: 'x' } },
    expectedCount: 1,
  }

  it('returns cleanly once the index reflects the expected count', async () => {
    send.mockResolvedValue({ Count: 1 } as never)
    await expect(waitForGsiConsistency({ ...opts, timeoutMs: 1_000 })).resolves.toBeUndefined()
  })

  it('throws IndeterminateError with the GSI-consistency reason on timeout', async () => {
    send.mockImplementation(slowResponse({ Count: 0 }) as never)
    const err = await waitForGsiConsistency({ ...opts, timeoutMs: 1 }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('gsi-consistency-timeout')
  })
})

describe('waitForReadsToSettle', () => {
  const opts = {
    tableName: 't',
    partitionKey: { name: 'pk', value: { S: 'x' } },
    expectedCount: 3,
    timeoutMs: 1,
  }

  /** Answer each read by kind: eventual PartiQL, consistent PartiQL, consistent Query. */
  function answer(rows: { eventual: number | Error; partiql?: number; query?: number }) {
    send.mockImplementation((async (cmd: { constructor: { name: string }; input: { ConsistentRead?: boolean } }) => {
      await new Promise((r) => setTimeout(r, 5))
      const items = (n: number) => ({ Items: Array.from({ length: n }, () => ({})) })
      if (cmd.constructor.name === 'QueryCommand') return { Count: rows.query }
      if (cmd.input.ConsistentRead) return items(rows.partiql!)
      if (rows.eventual instanceof Error) throw rows.eventual
      return items(rows.eventual)
    }) as never)
  }
  const kinds = () =>
    send.mock.calls.map(([cmd]) => {
      const c = cmd as unknown as { constructor: { name: string }; input: { ConsistentRead?: boolean } }
      return `${c.constructor.name}${c.input.ConsistentRead ? ':consistent' : ''}`
    })

  it('returns once three eventually consistent reads running see every row', async () => {
    answer({ eventual: 3 })
    await expect(waitForReadsToSettle({ ...opts, timeoutMs: 1_000 })).resolves.toBeUndefined()
    expect(kinds()).toEqual(Array(3).fill('ExecuteStatementCommand'))
  })

  it('returns on the first read that sees too many rows, which is an answer', async () => {
    answer({ eventual: 4 })
    await expect(waitForReadsToSettle({ ...opts, timeoutMs: 1_000 })).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('throws the read-settle reason when consistent reads see every row and eventual ones never do', async () => {
    answer({ eventual: 2, query: 3, partiql: 3 })
    const err = await waitForReadsToSettle(opts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('read-settle-timeout')
  })

  it('returns when a consistent Query is short too: the rows are not there to see', async () => {
    answer({ eventual: 2, query: 2, partiql: 3 })
    await expect(waitForReadsToSettle(opts)).resolves.toBeUndefined()
  })

  it('returns when a consistent PartiQL read is short: PartiQL itself is wrong', async () => {
    answer({ eventual: 2, query: 3, partiql: 2 })
    await expect(waitForReadsToSettle(opts)).resolves.toBeUndefined()
    expect(kinds()).toEqual(['ExecuteStatementCommand', 'QueryCommand:consistent', 'ExecuteStatementCommand:consistent'])
  })

  it('returns on a rejection, which the tests then meet themselves', async () => {
    answer({
      eventual: new DynamoDBServiceException({
        name: 'ValidationException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
        message: 'Statement wasn\'t well formed',
      } as ConstructorParameters<typeof DynamoDBServiceException>[0]),
    })
    await expect(waitForReadsToSettle(opts)).resolves.toBeUndefined()
  })

  it('rethrows a failed observation rather than reading it as a rejection', async () => {
    answer({ eventual: new ThrottlingException({ message: 'slow down', $metadata: {} }) })
    const err = await waitForReadsToSettle(opts).catch((e: unknown) => e)
    expect(indeterminateFrom(err)?.reason).toBe('throttle-exhausted')
  })
})

describe('waitUntilActiveInRegion', () => {
  it('throws IndeterminateError with the table-ACTIVE reason on timeout', async () => {
    const client = {
      send: slowResponse({ Table: { TableStatus: 'CREATING' } }),
    }
    const err = await waitUntilActiveInRegion(client as never, 't', { timeoutMs: 1 }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('table-active-timeout')
  })
})
