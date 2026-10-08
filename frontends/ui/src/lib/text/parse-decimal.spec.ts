import { describe, expect, test } from 'vitest'
import { formatDecimalInput, parseDecimalInput } from './parse-decimal'

describe('parseDecimalInput', () => {
  test('blank is its own answer, never a number', () => {
    expect(parseDecimalInput('')).toEqual({ status: 'blank' })
    expect(parseDecimalInput('   ')).toEqual({ status: 'blank' })
  })

  test.each([
    ['2.5', 2.5],
    ['2,5', 2.5],
    ['10', 10],
    [' 0,0001 ', 0.0001],
    ['.5', 0.5],
    ['-1', -1],
    ['0', 0],
  ])('reads %s as %d', (raw, value) => {
    expect(parseDecimalInput(raw, 'de')).toEqual({ status: 'valid', value })
  })

  // Every one of these used to become a number (parseFloat) or `null` (=
  // unlimited) somewhere on the platform surfaces.
  test.each([
    '2.5x',
    'ten',
    '12oops',
    '1e3',
    '0x10',
    'Infinity',
    '1,2,3',
    '1.2.3',
    '1 000',
    '1.000,5',
  ])('refuses %s', (raw) => {
    expect(parseDecimalInput(raw, 'de')).toEqual({ status: 'invalid', reason: 'notANumber' })
  })

  test('refuses a lone group separator before three digits as ambiguous, per locale', () => {
    expect(parseDecimalInput('100.000', 'de')).toEqual({ status: 'invalid', reason: 'ambiguous' })
    expect(parseDecimalInput('1,000', 'en')).toEqual({ status: 'invalid', reason: 'ambiguous' })
    // The locale's own decimal mark is never ambiguous.
    expect(parseDecimalInput('1,125', 'de')).toEqual({ status: 'valid', value: 1.125 })
    expect(parseDecimalInput('1.125', 'en')).toEqual({ status: 'valid', value: 1.125 })
    // A leading zero cannot be a thousands group.
    expect(parseDecimalInput('0.125', 'de')).toEqual({ status: 'valid', value: 0.125 })
  })

  test('refuses a pattern that overflows to Infinity', () => {
    expect(parseDecimalInput('9'.repeat(400))).toEqual({ status: 'invalid', reason: 'notANumber' })
  })
})

describe('formatDecimalInput', () => {
  test('writes the locale decimal mark without grouping, and round-trips', () => {
    expect(formatDecimalInput(2.5, 'de')).toBe('2,5')
    expect(formatDecimalInput(2.5, 'en')).toBe('2.5')
    expect(formatDecimalInput(100000, 'de')).toBe('100000')
    expect(formatDecimalInput(null, 'de')).toBe('')
    for (const value of [1.125, 0.0001, 1e-7, 5000, 0.1]) {
      for (const locale of ['de', 'en']) {
        expect(parseDecimalInput(formatDecimalInput(value, locale), locale)).toEqual({
          status: 'valid',
          value,
        })
      }
    }
  })
})
