/** Shared display formatters. */

/**
 * EUR currency — the app's single money-display rule. Pass the active locale
 * so German users see "12,34 €" and English users "€12.34". Locale is
 * optional so non-React callers without locale context keep working (they
 * get the runtime default).
 */
export const formatEur = (value: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value)

/**
 * Byte sizes for humans ("1.4 GB" / "1,4 GB").
 *
 * Decimal units (1000-based), not binary: the number sits next to a quota an
 * administrator typed in GB, and showing 1 GB of quota as "0.93 GiB used" reads
 * as a bug. `Intl.NumberFormat`'s `unit` style handles the locale's separator
 * and spacing, so German gets "1,4 GB" without a second code path.
 *
 * One decimal place from MB up, none below: "1.4 GB" is a size, "1.4 kB" is
 * noise. Negative input is clamped — a size is never below zero, and a bad
 * subtraction upstream should not render as "-2 MB".
 */
export const formatBytes = (bytes: number, locale?: string): string => {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const units: Array<{ unit: string; scale: number }> = [
    { unit: 'byte', scale: 1 },
    { unit: 'kilobyte', scale: 1e3 },
    { unit: 'megabyte', scale: 1e6 },
    { unit: 'gigabyte', scale: 1e9 },
    { unit: 'terabyte', scale: 1e12 },
  ]

  let chosen = units[0]
  for (const candidate of units) {
    if (safe >= candidate.scale) chosen = candidate
  }

  const value = safe / chosen.scale
  const fractionDigits = chosen.scale >= 1e6 && value < 1000 ? 1 : 0

  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: chosen.unit,
    unitDisplay: 'short',
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/**
 * Localized relative timestamp ("3 hours ago" / "vor 3 Stunden"). Falls back
 * to the raw ISO string for unparseable input. Truncates toward zero at unit
 * boundaries so a value never rounds up into a misleading "in 60 minutes".
 * Shared by the research-runs list and the sessions-panel Deep Research section.
 */
export const formatRelativeTime = (isoDate: string, locale?: string): string => {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate

  const diffMs = date.getTime() - Date.now()
  const diffSeconds = Math.round(diffMs / 1000)
  const absSeconds = Math.abs(diffSeconds)

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  const thresholds: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [2592000, 'day'],
    [31536000, 'month'],
    [Infinity, 'year'],
  ]

  const divisors: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
    year: 31536000,
    quarter: 7776000,
  }

  for (const [limit, unit] of thresholds) {
    if (absSeconds < limit) {
      const divisor = divisors[unit]
      const value = Math.trunc(diffSeconds / divisor)
      return rtf.format(value, unit)
    }
  }

  return rtf.format(Math.round(diffSeconds / divisors.year), 'year')
}

/**
 * Localized time of day ("09:30" / "9:30 AM"). Used where the surrounding
 * layout already states the DAY — the sessions panel groups rows under a day
 * heading, so a row repeating "18 days ago" under "12 Jul 2026" says the same
 * thing twice while the actual time of the chat goes missing.
 */
export const formatTimeOfDay = (isoDate: string, locale?: string): string => {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate

  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date)
}

/**
 * Localized absolute date/time ("14 Jul 2026, 09:30"), used as the hover
 * tooltip that pins a relative timestamp to an exact moment.
 */
export const formatAbsoluteTime = (isoDate: string, locale?: string): string => {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate

  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/**
 * A short, localized span of time ("45 sec", "3 min", "1.2 hr" / "45 Sek.",
 * "3 Min.", "1,2 Std."), for elapsed timers and transfer estimates.
 *
 * Quantized, not exact: an estimate that reads 47, then 44, then 45 seconds
 * spends its precision on jitter and reads as unreliable even when it is
 * right. Under a minute it steps in fives, above it in whole minutes — the
 * resolution a person actually acts on.
 *
 * Built on `Intl.NumberFormat`'s `unit` style so the unit word, the separator
 * and the spacing come from the locale rather than from a dictionary entry
 * that would have to be kept in step with it.
 */
export const formatDurationShort = (seconds: number, locale?: string): string => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const unit: Intl.NumberFormatOptions['unit'] =
    safe < 60 ? 'second' : safe < 3600 ? 'minute' : 'hour'

  const value =
    unit === 'second'
      ? Math.max(5, Math.ceil(safe / 5) * 5)
      : unit === 'minute'
        ? Math.ceil(safe / 60)
        : safe / 3600

  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    minimumFractionDigits: 0,
    maximumFractionDigits: unit === 'hour' ? 1 : 0,
  }).format(value)
}

/**
 * A transfer rate ("4.2 MB/s" / "4,2 MB/s"), built from the shared byte
 * formatter so a speed and a size are punctuated identically on the same row.
 */
export const formatTransferRate = (bytesPerSecond: number, locale?: string): string =>
  `${formatBytes(bytesPerSecond, locale)}/s`
