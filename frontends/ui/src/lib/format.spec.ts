/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { formatBytes, formatDurationShort, formatEur, formatTransferRate } from './format'

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
