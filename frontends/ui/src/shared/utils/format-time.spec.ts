/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { formatTime } from './format-time'

describe('formatTime', () => {
  // Local-time constructor so the wall-clock value is TZ-independent: both the
  // Date and the formatter use the runtime's local timezone.
  const date = new Date(2024, 0, 15, 15, 35)

  test('renders German times in 24-hour format', () => {
    expect(formatTime(date, 'de')).toBe('15:35')
  })

  test('renders US English times in 12-hour format', () => {
    const out = formatTime(date, 'en-US')
    expect(out).toMatch(/PM/)
    expect(out).toContain('03:35')
  })

  test('locale changes the output (de vs en differ)', () => {
    expect(formatTime(date, 'de')).not.toBe(formatTime(date, 'en-US'))
  })

  test('accepts ISO string input', () => {
    expect(formatTime(date.toISOString(), 'de')).toMatch(/^\d{2}:\d{2}$/)
  })

  test('omitting the locale still returns a valid time string (runtime default)', () => {
    expect(formatTime(date)).toMatch(/\d{1,2}:\d{2}/)
  })
})
