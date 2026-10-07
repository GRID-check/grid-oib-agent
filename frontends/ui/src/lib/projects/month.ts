/**
 * A month, as the Steckbrief keeps its dates (ADR-0083): Beginn and Abschluss
 * of a project, and from–to of each person on it, are months. On the wire a
 * month is `YYYY-MM`; in Postgres it is a `date` on the first of that month
 * (migration 0115 CHECKs the day). Pure, shared by the service and the form.
 */

/** `YYYY-MM`, the month on the wire and in the form's `<input type="month">`. */
export type Month = `${number}-${number}`

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonth(value: string): value is Month {
  return MONTH.test(value)
}

/** The `date` a month is stored as: its first day. */
export function monthToDate(month: Month): string {
  return `${month}-01`
}

/** The month a stored `date` (or any ISO date) falls in; null for null or a malformed value. */
export function dateToMonth(date: string | Date | null | undefined): Month | null {
  if (!date) return null
  const iso = typeof date === 'string' ? date : date.toISOString()
  const month = iso.slice(0, 7)
  return isMonth(month) ? month : null
}

/** Whether a period runs forwards (or is open at either end). */
export function isOrderedPeriod(from: Month | null, to: Month | null): boolean {
  return from === null || to === null || from <= to
}
