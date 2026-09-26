/**
 * Shared timestamp formatting utility
 *
 * Formats Date objects or ISO string dates into a short time display (e.g. "03:35 PM").
 * Handles both Date objects and ISO string dates (from Zustand persist).
 *
 * Pass the active app locale so the rendered time matches the UI language
 * (e.g. 24-hour "15:35" for `de`). The param is optional — omitting it falls
 * back to the runtime default, so non-React callers and tests keep working.
 */

// One formatter per locale. `toLocaleTimeString` with options builds a new
// `Intl.DateTimeFormat` on every call, and an answer's footer formats its time
// on every render: 107–145 ms of self time per streamed answer on a 4×
// throttled phone (React performance audit, 2026-09).
const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterFor = (locale: string | undefined): Intl.DateTimeFormat => {
  const key = locale ?? ''
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
    formatters.set(key, formatter)
  }
  return formatter
}

export const formatTime = (date: Date | string, locale?: string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return formatterFor(locale).format(dateObj)
}
