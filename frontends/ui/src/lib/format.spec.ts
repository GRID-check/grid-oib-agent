/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  formatBytes,
  formatCount,
  formatCredits,
  formatDate,
  formatDayRange,
  formatDurationElapsed,
  formatDurationShort,
  formatEur,
  formatTokens,
  formatTransferRate,
  formatUsd,
} from './format'

describe('formatUsd', () => {
  test('formats cents as currency', () => {
    expect(formatUsd(12.5, 'en')).toBe('$12.50')
    expect(formatUsd(0, 'en')).toBe('$0.00')
  })

  test('shows a sub-cent cost as "< $0.01", not as free', () => {
    expect(formatUsd(0.004, 'en')).toBe('< $0.01')
    expect(formatUsd(0.004, 'de')).toBe('< 0,01\u00a0$')
    expect(formatUsd(0.01, 'en')).toBe('$0.01')
  })

  test('a wider unit for rates moves the floor with it', () => {
    expect(formatUsd(0.0001, 'en', { maximumFractionDigits: 4 })).toBe('$0.0001')
    expect(formatUsd(0.1, 'en', { maximumFractionDigits: 4 })).toBe('$0.10')
    expect(formatUsd(0.00001, 'en', { maximumFractionDigits: 4 })).toBe('< $0.0001')
  })
})

describe('formatCount', () => {
  test('groups for the locale and never compacts', () => {
    expect(formatCount(1720, 'en')).toBe('1,720')
    expect(formatCount(1720, 'de')).toBe('1.720')
    expect(formatCount(12_400_000, 'en')).toBe('12,400,000')
  })
})

describe('formatDate', () => {
  test('a date without a time, per locale', () => {
    expect(formatDate('2026-08-01T09:00:00Z', 'en')).toBe('Aug 1, 2026')
    expect(formatDate('2026-08-01T09:00:00Z', 'de')).toBe('01.08.2026')
    expect(formatDate('not a date', 'en')).toBe('not a date')
  })
})

describe('formatDayRange', () => {
  test('an inclusive range of UTC days in the locale range form', () => {
    expect(formatDayRange('2026-09-01', '2026-09-30', 'de')).toBe('1.–30. Sept. 2026')
    // English sets the dash between thin spaces (U+2009); ICU decides, not us.
    expect(formatDayRange('2026-09-01', '2026-09-30', 'en')).toBe('Sep 1\u2009–\u200930, 2026')
    expect(formatDayRange('2026-12-15', '2027-01-10', 'de')).toMatch(
      /^15\. Dez\. 2026\s–\s10\. Jan\. 2027$/
    )
  })

  test('one day prints once', () => {
    expect(formatDayRange('2026-09-01', '2026-09-01', 'de')).toBe('1. Sept. 2026')
  })

  test('falls back to the raw days for unparseable input', () => {
    expect(formatDayRange('nope', '2026-09-01', 'en')).toBe('nope – 2026-09-01')
  })
})

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

describe('formatCredits', () => {
  test('whole numbers with locale grouping once the value is worth counting', () => {
    expect(formatCredits(1234.6, 'en-US')).toBe('1,235')
    expect(formatCredits(1234.6, 'de')).toBe('1.235')
  })

  test('one decimal below ten, so a cheap call is not shown as nothing', () => {
    expect(formatCredits(0.44, 'en-US')).toBe('0.4')
    expect(formatCredits(9.96, 'en-US')).toBe('10')
  })

  test('non-finite input renders as zero', () => {
    expect(formatCredits(Number.NaN, 'en-US')).toBe('0')
  })
})

describe('formatTokens', () => {
  test('exact below a thousand, compact above', () => {
    expect(formatTokens(812, 'en-US')).toBe('812')
    expect(formatTokens(1_234_567, 'en-US')).toBe('1.2M')
    expect(formatTokens(48_200, 'de')).toBe('48.200')
  })
})

describe('formatDurationElapsed', () => {
  test('keeps the exact seconds — it states what happened, not an estimate', () => {
    expect(formatDurationElapsed(12, 'en-US')).toBe('12 sec')
    expect(formatDurationElapsed(41.4, 'en-US')).toBe('41 sec')
  })

  test('steps up to whole minutes, then to hours with one decimal', () => {
    expect(formatDurationElapsed(102, 'en-US')).toBe('2 min')
    expect(formatDurationElapsed(5400, 'en-US')).toBe('1.5 hr')
    expect(formatDurationElapsed(12, 'de')).toBe('12 Sek.')
  })

  test('a nonsense duration reads as zero rather than NaN', () => {
    expect(formatDurationElapsed(Number.NaN, 'en-US')).toBe('0 sec')
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

describe('formatBytes', () => {
  test('counts in decimal units, matching the numbers configured beside it', () => {
    // A quota is entered in GB (BYTES_PER_GB = 1e9) and an upload ceiling in MB
    // (BYTES_PER_MB = 1e6); a 1024-based formatter renders both as ~93% of what
    // the administrator typed.
    expect(formatBytes(1_000_000_000, 'en-US')).toBe('1 GB')
    expect(formatBytes(100_000_000, 'en-US')).toBe('100 MB')
  })

  test('keeps one decimal from MB up and none below — "1.4 kB" is noise', () => {
    expect(formatBytes(4_800_000, 'en-US')).toBe('4.8 MB')
    expect(formatBytes(878_900, 'en-US')).toBe('879 kB')
  })

  test('takes its separator and unit word from the locale', () => {
    // CLDR picks the space itself — a plain one for MB in German, a
    // non-breaking one for GB — so the assertion normalizes whitespace rather
    // than embedding an invisible character it would be easy to "fix" wrongly.
    const spaces = (value: string) => value.replace(/\s/g, ' ')
    expect(spaces(formatBytes(4_800_000, 'de'))).toBe('4,8 MB')
    expect(spaces(formatBytes(2_400_000_000, 'de'))).toBe('2,4 GB')
  })

  test('renders the byte tier as "B", not as CLDR\'s literal word "byte"', () => {
    // "878 byte" reads as a typo in a column of "4.8 MB".
    expect(formatBytes(878, 'en-US')).toBe('878 B')
    expect(formatBytes(878, 'de')).toBe('878 B')
  })

  test('absorbs the nullable sizes the document rows carry', () => {
    expect(formatBytes(null)).toBe('0 B')
    expect(formatBytes(undefined)).toBe('0 B')
    expect(formatBytes(0)).toBe('0 B')
  })

  test('a bad subtraction upstream never renders as a negative size', () => {
    expect(formatBytes(-2_000_000, 'en-US')).toBe('0 B')
    expect(formatBytes(Number.NaN, 'en-US')).toBe('0 B')
  })

  test('scales past gigabytes', () => {
    expect(formatBytes(3_500_000_000_000, 'en-US')).toBe('3.5 TB')
  })
})
