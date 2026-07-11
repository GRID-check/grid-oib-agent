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

export const formatTime = (date: Date | string, locale?: string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}
