/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { formatDurationShort, formatEur, formatTransferRate } from './format'

describe('formatEur', () => {
  test('formats German amounts with comma decimal and trailing symbol', () => {
    // Uses a non-breaking space between value and symbol.
    expect(formatEur(12.34, 'de')).toBe('12,34 €')
  })

  test('formats US English amounts with leading symbol and period decimal', () => {
    expect(formatEur(12.34, 'en-US')).toBe('€12.34')
  })

  test('locale changes the output (de vs en differ)', () => {
    expect(formatEur(1234.5, 'de')).not.toBe(formatEur(1234.5, 'en-US'))
  })

  test('omitting the locale still returns a EUR string (runtime default)', () => {
    expect(formatEur(1)).toMatch(/€|EUR/)
  })
})

describe('formatDurationShort', () => {
  test('quantizes seconds to fives, so an estimate stops jittering', () => {
    expect(formatDurationShort(41, 'en-US')).toBe('45 sec')
    expect(formatDurationShort(45, 'en-US')).toBe('45 sec')
  })

  test('never counts down below its own resolution', () => {
    expect(formatDurationShort(1, 'en-US')).toBe('5 sec')
    expect(formatDurationShort(0, 'en-US')).toBe('5 sec')
  })

  test('steps up to whole minutes, then to hours with one decimal', () => {
    expect(formatDurationShort(90, 'en-US')).toBe('2 min')
    expect(formatDurationShort(5400, 'en-US')).toBe('1.5 hr')
  })

  test('takes its unit word and separator from the locale', () => {
    expect(formatDurationShort(5400, 'de')).toMatch(/1,5/)
  })

  test('a nonsense duration degrades to the floor rather than NaN', () => {
    expect(formatDurationShort(Number.NaN, 'en-US')).toBe('5 sec')
    expect(formatDurationShort(-10, 'en-US')).toBe('5 sec')
  })
})

describe('formatTransferRate', () => {
  test('punctuates a speed exactly like the size beside it', () => {
    expect(formatTransferRate(4_200_000, 'en-US')).toBe('4.2 MB/s')
    expect(formatTransferRate(4_200_000, 'de')).toBe('4,2 MB/s')
  })
})
