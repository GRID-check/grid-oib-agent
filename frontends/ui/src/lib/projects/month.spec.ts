import { describe, expect, it } from 'vitest'
import { dateToMonth, isMonth, isOrderedPeriod, monthToDate } from './month'

describe('a Steckbrief month', () => {
  it('is YYYY-MM with a real month', () => {
    expect(isMonth('2026-10')).toBe(true)
    expect(isMonth('2026-13')).toBe(false)
    expect(isMonth('2026-1')).toBe(false)
    expect(isMonth('2026-10-01')).toBe(false)
  })

  it('is stored as the first of the month, and read back from any day of it', () => {
    expect(monthToDate('2026-10')).toBe('2026-10-01')
    expect(dateToMonth('2026-10-01')).toBe('2026-10')
    expect(dateToMonth(new Date('2026-10-17T10:00:00Z'))).toBe('2026-10')
    expect(dateToMonth(null)).toBeNull()
    expect(dateToMonth('garbage')).toBeNull()
  })

  it('a period runs forwards, or is open at either end', () => {
    expect(isOrderedPeriod('2023-03', '2025-11')).toBe(true)
    expect(isOrderedPeriod('2023-03', '2023-03')).toBe(true)
    expect(isOrderedPeriod('2025-11', '2023-03')).toBe(false)
    expect(isOrderedPeriod(null, '2023-03')).toBe(true)
  })
})
