import { describe, test, expect } from 'vitest'
import { formatEur } from './format'

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
