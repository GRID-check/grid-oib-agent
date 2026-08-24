/**
 * Choosing between the two element-page plans.
 *
 * The arithmetic is small; what matters is which way it errs. The GIN bitmap
 * plan's worst case is bounded by how many candidates exist. The ordered
 * walk's worst case is the whole model — 5 877 ms on a seeded 200 000-element
 * one. So every uncertain case has to land on the bitmap, and the walk is
 * taken only when it is provably cheap.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { PLAN_ROW_BUDGET, shouldWalkOrdered } = await import('./repository')

const decide = (over: Partial<Parameters<typeof shouldWalkOrdered>[0]>): boolean =>
  shouldWalkOrdered({
    matched: 0,
    candidates: null,
    rowsNeeded: 25,
    elementCount: 200_000,
    ...over,
  })

describe('choosing an element-page plan', () => {
  it('keeps the pre-filter when there is no pre-filter to weigh', () => {
    // `candidates: null` means no property filter contributed an indexable
    // condition — `missing`/`neq` only, or a model that is not indexed. There
    // are not two plans, so there is nothing to choose.
    expect(decide({ candidates: null, matched: 100_000 })).toBe(false)
  })

  it('keeps the pre-filter when it is narrow enough to be cheap on its own', () => {
    // 2 000 candidates is ~66 ms of bitmap. Walking instead could only lose.
    expect(decide({ candidates: PLAN_ROW_BUDGET, matched: 1 })).toBe(false)
    expect(decide({ candidates: 1, matched: 1 })).toBe(false)
  })

  it('walks when the pre-filter admits everything and matches are dense', () => {
    // A quarter of the model matches: the walk reads ~100 rows and stops.
    // This is the case the pre-filter is actively bad at — 1 692 ms measured,
    // against 3 ms for the walk.
    expect(decide({ candidates: PLAN_ROW_BUDGET + 1, matched: 50_000 })).toBe(true)
  })

  it('refuses to walk when the candidates are broad but the matches are not', () => {
    // The trap: `FireRating > 900` on a model where 50 000 elements carry a
    // FireRating and none exceed 900. The pre-filter is only key-existence, so
    // candidates are broad — but the walk would read the entire model to find
    // nothing. Proving a negative is expensive either way; the bitmap at least
    // bounds it by the candidate count.
    expect(decide({ candidates: PLAN_ROW_BUDGET + 1, matched: 0 })).toBe(false)
    expect(decide({ candidates: 100_000, matched: 10 })).toBe(false)
  })

  it('accounts for the offset, not just the page size', () => {
    // Page 1 of a filter matching 5 % is a 500-row walk; page 40 of the same
    // filter is a 20 000-row walk, and by then the bitmap is the cheaper one.
    const matched = 10_000
    expect(decide({ candidates: 100_000, matched, rowsNeeded: 25 })).toBe(true)
    expect(decide({ candidates: 100_000, matched, rowsNeeded: 25 + 1_000 })).toBe(false)
  })

  it('scales with the model, not with a fixed row count', () => {
    // The same match RATIO on a small model is a much shorter walk, so the
    // budget has to be spent against the table size rather than a constant.
    expect(decide({ candidates: 5_000, matched: 100, elementCount: 200_000 })).toBe(false)
    expect(decide({ candidates: 5_000, matched: 100, elementCount: 5_000 })).toBe(true)
  })
})
