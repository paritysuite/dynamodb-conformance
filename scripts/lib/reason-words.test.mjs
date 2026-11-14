import { describe, expect, it } from 'vitest'
import { INDETERMINATE_REASONS } from '../../src/indeterminate.js'
import { OTHER_REASON, REASON_WORDS, reasonWords } from './reason-words.mjs'

describe('reason words', () => {
  it('gives every reason the suite can record its own words', () => {
    expect(INDETERMINATE_REASONS.length).toBeGreaterThan(0)
    const unworded = INDETERMINATE_REASONS.filter((r) => !Object.hasOwn(REASON_WORDS, r))
    expect(unworded).toEqual([])
    for (const r of INDETERMINATE_REASONS) expect(reasonWords(r)).not.toBe(OTHER_REASON)
  })

  it('words no code the suite does not record', () => {
    expect(Object.keys(REASON_WORDS).filter((r) => !INDETERMINATE_REASONS.includes(r))).toEqual([])
  })

  it('names an unknown or missing reason neutrally, never as its code', () => {
    expect(reasonWords('disk-on-fire')).toBe(OTHER_REASON)
    expect(reasonWords(null)).toBe(OTHER_REASON)
    expect(reasonWords(undefined)).toBe(OTHER_REASON)
    expect(reasonWords('toString')).toBe(OTHER_REASON)
  })
})
