import { describe, expect, it } from 'vitest'

import {
  BYTES_PER_GB,
  formatQuotaDraft,
  parseQuotaDraft,
  storageQuotaPutSchema,
} from './contract'

/**
 * The quota contract exists because the same constraint used to be written twice
 * and the copies disagreed. These tests pin the half that had no test at all:
 * what happens to a value that is neither a number nor blank.
 *
 * The failure this prevents is not "the request is rejected". It is that
 * `Number('12x')` → `NaN` → `JSON.stringify` → `null`, and `null` is this API's
 * spelling of UNLIMITED — so a mistyped character REMOVED a tenant's quota and
 * the UI reported success. Every row below that maps to `ok: false` is a value
 * that previously became "unlimited".
 */
describe('parseQuotaDraft', () => {
  it('reads a whole number of GB into bytes', () => {
    expect(parseQuotaDraft('50')).toEqual({ ok: true, quotaBytes: 50 * BYTES_PER_GB })
  })

  it('reads a decimal, because that is what the editor prefills', () => {
    expect(parseQuotaDraft('1.5')).toEqual({ ok: true, quotaBytes: 1_500_000_000 })
  })

  // The one case where a blank field is a decision rather than a mistake:
  // clearing the box is how an operator lifts a limit.
  it.each(['', '   '])('treats %o as a deliberate "unlimited"', (raw) => {
    expect(parseQuotaDraft(raw)).toEqual({ ok: true, quotaBytes: null })
  })

  // Each of these used to serialize to `null` and clear the quota.
  it.each([
    ['a typo', '12x'],
    ['letters', 'fifty'],
    ['a stray unit', '50 GB'],
    ['an overflow that becomes Infinity', '1e999'],
    ['a lone minus sign', '-'],
  ])('refuses %s (%o) rather than reading it as unlimited', (_label, raw) => {
    expect(parseQuotaDraft(raw)).toEqual({ ok: false, reason: 'notANumber' })
  })

  it.each([
    ['zero', '0'],
    ['a negative', '-5'],
    ['a value too small to be one byte', '0.0000000001'],
  ])('refuses %s (%o)', (_label, raw) => {
    expect(parseQuotaDraft(raw)).toEqual({ ok: false, reason: 'notPositive' })
  })

  // Whatever the editor prefills, the parser must accept — otherwise opening the
  // editor and pressing save fails on a value the editor itself chose.
  it('round-trips every quota the editor can prefill', () => {
    for (const bytes of [1, 999, BYTES_PER_GB, 1_500_000_000, 20 * BYTES_PER_GB]) {
      expect(parseQuotaDraft(formatQuotaDraft(bytes))).toEqual({ ok: true, quotaBytes: bytes })
    }
  })
})

describe('storageQuotaPutSchema', () => {
  it('accepts a positive integer of bytes', () => {
    expect(storageQuotaPutSchema.parse({ quotaBytes: 1 })).toEqual({ quotaBytes: 1 })
  })

  it('accepts an explicit null, which means unlimited', () => {
    expect(storageQuotaPutSchema.parse({ quotaBytes: null })).toEqual({ quotaBytes: null })
  })

  // These make the boundary a 400 rather than a 422, which is what leaves 422
  // with exactly one meaning ("below current usage") for the client to report.
  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction of a byte', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '50'],
  ])('rejects %s', (_label, quotaBytes) => {
    expect(storageQuotaPutSchema.safeParse({ quotaBytes }).success).toBe(false)
  })

  it('rejects an absent field, because unlimited must be stated', () => {
    expect(storageQuotaPutSchema.safeParse({}).success).toBe(false)
  })
})
