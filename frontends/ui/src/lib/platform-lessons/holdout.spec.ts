import { describe, expect, it } from 'vitest'
import { isInHoldoutSlice } from './holdout'

describe('isInHoldoutSlice', () => {
  it('is off at 0 and total at 100', () => {
    expect(isInHoldoutSlice('conv-1', 0)).toBe(false)
    expect(isInHoldoutSlice('conv-1', 100)).toBe(true)
  })

  it('treats a missing conversation as treated, never as control', () => {
    // A turn with no conversation key cannot be assigned an arm; counting it
    // as control would silently deny it lessons AND pollute the comparison.
    expect(isInHoldoutSlice('', 50)).toBe(false)
  })

  it('is stable for the same conversation', () => {
    const first = isInHoldoutSlice('conv-stable', 30)
    for (let i = 0; i < 20; i++) expect(isInHoldoutSlice('conv-stable', 30)).toBe(first)
  })

  it('splits roughly at the requested percentage', () => {
    const ids = Array.from({ length: 4000 }, (_, index) => `conv-${index}`)
    const share = ids.filter((id) => isInHoldoutSlice(id, 10)).length / ids.length
    expect(share).toBeGreaterThan(0.08)
    expect(share).toBeLessThan(0.12)
  })

  it('is monotonic — raising the percentage never removes a conversation', () => {
    // Otherwise raising the holdout would reshuffle both arms and invalidate
    // every measurement taken before the change.
    const ids = Array.from({ length: 500 }, (_, index) => `conv-${index}`)
    for (const id of ids) {
      if (isInHoldoutSlice(id, 10)) expect(isInHoldoutSlice(id, 25)).toBe(true)
    }
  })

  it('agrees with the Python twin on a pinned vector', () => {
    // Both tiers must reach the same verdict from the same key: this tier
    // decides whether to INJECT, the BFF decides how to LABEL the vote, and a
    // disagreement mislabels every measurement. The expectations below are
    // produced by src/aiq_agent/common/platform_lessons.py::is_in_holdout_slice
    // and pinned by tests/aiq_agent/common/test_platform_lessons.py.
    expect(isInHoldoutSlice('conv-8', 10)).toBe(true)
    expect(isInHoldoutSlice('conv-12', 10)).toBe(true)
    expect(isInHoldoutSlice('conv-16', 10)).toBe(true)
    expect(isInHoldoutSlice('conv-0', 10)).toBe(false)
    expect(isInHoldoutSlice('conv-13', 10)).toBe(false)
  })
})
