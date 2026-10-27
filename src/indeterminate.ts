// The third result state, typed at the moment it happens.
//
// A conformance result is only meaningful when the target actually answered.
// A timeout, a throttle the SDK's retry could not outlast, or a transport
// failure is not a different answer - it is the absence of one, and it must
// stay structurally distinct from a real pass or fail all the way into the
// published artefact. This module is where that distinction is minted:
// anything that carries a real DynamoDB answer (a ValidationException, a
// ResourceNotFoundException, a ConditionalCheckFailedException) is never
// classified here, because a definite answer - even a rejection - is a result.
//
// Dependency-light and duck-typed on purpose: the error objects inspected in
// afterEach hooks have been cloned into plain objects by the test runner, so
// nothing in this file may rely on instanceof for detection. The one import is
// the unsupported-fault predicate, which is dependency-free for this reason.

import { isUnsupportedFault } from './unsupported.js'

export const INDETERMINATE_REASONS = [
  /** A table (or one of its GSIs) never reached ACTIVE within its ceiling. */
  'table-active-timeout',
  /** A GSI never reflected the expected items within its ceiling. */
  'gsi-consistency-timeout',
  /** A vector index never reached ACTIVE (backfill done) within its ceiling. */
  'vector-index-timeout',
  /** A vector index never reflected the expected items within its ceiling. */
  'vector-consistency-timeout',
  /** An S3 import never left IN_PROGRESS within its ceiling. */
  'import-timeout',
  /** A throttle survived the SDK's configured retry (see src/client.ts). */
  'throttle-exhausted',
  /** A transport failure or 5xx: the request may never have been evaluated. */
  'transport',
] as const

export type IndeterminateReason = (typeof INDETERMINATE_REASONS)[number]

/** A failed observation: the target was never definitively heard from. */
export class IndeterminateError extends Error {
  override name = 'IndeterminateError'
  readonly reason: IndeterminateReason

  constructor(reason: IndeterminateReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.reason = reason
  }
}

// Error names the AWS SDK's standard retry mode treats as throttling
// (@smithy/core retry classification). If one of these reaches us, the SDK's
// retry has already been exhausted, so the request never got a real answer.
const THROTTLING_ERROR_NAMES = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'LimitExceededException',
  'RequestThrottled',
  'RequestThrottledException',
  'ThrottledException',
  'Throttling',
  'TooManyRequestsException',
])

// Names the SDK classifies as request-timeout transients.
const TRANSIENT_ERROR_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
])

// Node syscall-level failures: the request may never have left the machine.
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
])

interface ErrorLike {
  name?: unknown
  code?: unknown
  message?: unknown
  reason?: unknown
  $fault?: unknown
  $metadata?: { httpStatusCode?: unknown }
  $retryable?: { throttling?: unknown }
}

function asErrorLike(error: unknown): ErrorLike | null {
  return typeof error === 'object' && error !== null ? (error as ErrorLike) : null
}

/**
 * The indeterminate reason carried by an error, or null. Works on both a live
 * IndeterminateError and the plain-object clone the test runner hands to
 * afterEach hooks, which keeps own enumerable properties but not the
 * prototype chain.
 */
export function indeterminateReasonOf(error: unknown): IndeterminateReason | null {
  const e = asErrorLike(error)
  if (!e || e.name !== 'IndeterminateError') return null
  return (INDETERMINATE_REASONS as readonly unknown[]).includes(e.reason)
    ? (e.reason as IndeterminateReason)
    : null
}

function isThrottle(e: ErrorLike): boolean {
  return (
    e.$metadata?.httpStatusCode === 429 ||
    e.$retryable?.throttling === true ||
    (typeof e.name === 'string' && THROTTLING_ERROR_NAMES.has(e.name))
  )
}

function isTransport(e: ErrorLike): boolean {
  const status = e.$metadata?.httpStatusCode
  return (
    (typeof status === 'number' && status >= 500 && status <= 599) ||
    e.$fault === 'server' ||
    (typeof e.name === 'string' && TRANSIENT_ERROR_NAMES.has(e.name)) ||
    (typeof e.code === 'string' && TRANSPORT_ERROR_CODES.has(e.code))
  )
}

/**
 * Classify a failure as indeterminate, or return null for anything that is -
 * or even might be - a definite answer. Deliberately conservative: an error
 * this function does not recognise stays a real failure, because demoting a
 * genuine result out of the score is worse than letting a flake go red.
 */
export function indeterminateFrom(error: unknown): IndeterminateError | null {
  if (error instanceof IndeterminateError) return error

  const e = asErrorLike(error)
  if (!e) return null

  // A carried indeterminate reason (a serialised IndeterminateError the runner
  // cloned past `instanceof`) is honoured before anything else, so an already
  // classified observation keeps its reason even if its message would match a
  // later check.
  const carried = indeterminateReasonOf(error)
  if (carried) {
    return new IndeterminateError(
      carried,
      typeof e.message === 'string' ? e.message : 'indeterminate result',
      { cause: error },
    )
  }

  // "Not implemented" is a definite answer about scope, so it is never a failed
  // observation. isUnsupportedFault recognises it in any shape - an
  // UnknownOperationException name, a "not implemented" / "is not supported"
  // message, or HTTP 501 - and 501 is the one that matters here: it sits inside
  // the 5xx range isTransport reads as "the request may never have been
  // evaluated", so without this a target signalling unimplemented operations
  // with 501 would have every one of those answers dropped from its denominator
  // as unknowable, which flatters it. Caught here rather than in isTransport so
  // the rule holds however the fault is shaped. A test that meets one of these
  // without a capability probe stays a real failure, which is the honest
  // outcome: the suite asked a question the target declined, and nothing has
  // recorded that as deliberate scope.
  if (isUnsupportedFault(error)) return null

  // Node's syscall failures (e.g. ECONNREFUSED as an AggregateError) can carry
  // an empty message; fall back to the code or name so the record says something.
  const message =
    (typeof e.message === 'string' && e.message !== '' && e.message) ||
    (typeof e.code === 'string' && e.code) ||
    String(e.name ?? 'failure')
  if (isThrottle(e)) {
    return new IndeterminateError('throttle-exhausted', message, { cause: error })
  }
  if (isTransport(e)) {
    return new IndeterminateError('transport', message, { cause: error })
  }
  return null
}
