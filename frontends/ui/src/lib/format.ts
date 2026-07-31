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
