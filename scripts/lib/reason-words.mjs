// Each reason the suite records for a test that got no answer
// (src/indeterminate.ts INDETERMINATE_REASONS), in words a reader can follow,
// taken from the definitions written beside each code. Kept beside the
// classifier rather than in the site, so the test beside this file can hold
// the two lists together: a code added to the suite fails the tooling suite
// until it has words here.

export const REASON_WORDS = Object.freeze({
  'table-active-timeout': 'a table that never became active',
  'gsi-consistency-timeout': 'an index that never caught up',
  'read-settle-timeout': 'a read that never settled',
  'vector-index-timeout': 'a vector index that never became active',
  'vector-consistency-timeout': 'a vector index that never caught up',
  'import-timeout': 'an import that never finished',
  'throttle-exhausted': 'throttling that outlasted the retries',
  transport: 'a transport failure or 5xx',
})

// A reason with no words, or none recorded, is named neutrally rather than
// printed as a code or guessed at.
export const OTHER_REASON = 'another reason'

export const reasonWords = (reason) =>
  Object.hasOwn(REASON_WORDS, reason) ? REASON_WORDS[reason] : OTHER_REASON
