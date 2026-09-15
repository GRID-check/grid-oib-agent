/**
 * Schedule helpers for the wizard and the Zeitplan surfaces.
 *
 * The BFF validates and advances cron authoritatively (5-field, `cron-parser`,
 * per-schedule IANA timezone, min-interval — `lib/jobs/schedule.ts`). Nothing
 * here re-decides any of that. What lives here is the CLIENT's half: turning a
 * person's four answers (how often · at what time · on which day) into a cron
 * string, turning a cron string back into those answers so editing a schedule
 * shows the form that made it, and describing one in words. Real fire times
 * come from `occurrences.ts`, which asks the same library the server does.
 *
 * Why a composer at all, rather than the five fixed presets this file used to
 * offer: those presets all fired at 06:00, so "weekly, Wednesday at 08:00" —
 * an ordinary request — dropped the reader into a raw cron field. A cron
 * expression is recall, not recognition: nobody can check `0 8 * * 3` by
 * reading it, and nobody should have to.
 */

/** How often a schedule fires, in the words the form asks the question in. */
export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly'

/** The frequencies the picker offers, plus the escape hatch. */
export const SCHEDULE_FREQUENCIES: readonly ScheduleFrequency[] = [
  'hourly',
  'daily',
  'weekly',
  'monthly',
]

/**
 * A schedule as the form holds it.
 *
 * Every field is kept across frequency changes on purpose: switching from
 * weekly to monthly and back must not lose the weekday the reader picked. The
 * composer simply ignores the fields its frequency does not use.
 */
export interface CronParts {
  frequency: ScheduleFrequency
  /** 0–59. The only field `hourly` reads. */
  minute: number
  /** 0–23. */
  hour: number
  /**
   * Which days a weekly schedule fires on — 0 = Sunday … 6 = Saturday, matching
   * cron's own day-of-week numbering. Always sorted, never empty.
   *
   * A list rather than one day, because "Montag, Mittwoch und Freitag" and
   * "werktags" are ordinary asks in a planning office, and a single-day picker
   * pushed both of them into the raw cron field — where nobody could check what
   * they had written. `1,3,5` is one expression cron has always understood; it
   * was only this composer that could not say it.
   */
  weekdays: number[]
  /** 1–28. Capped at 28 so a monthly schedule never skips February. */
  monthDay: number
}

/** What a fresh schedule proposes: every weekday morning is the common case. */
export const DEFAULT_CRON_PARTS: CronParts = {
  frequency: 'weekly',
  minute: 0,
  hour: 6,
  weekdays: [1],
  monthDay: 1,
}

/** The composed 5-field expression. */
export function buildCron(parts: CronParts): string {
  const minute = clamp(parts.minute, 0, 59)
  const hour = clamp(parts.hour, 0, 23)
  switch (parts.frequency) {
    case 'hourly':
      return `${minute} * * * *`
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekly':
      return `${minute} ${hour} * * ${normalizeWeekdays(parts.weekdays).join(',')}`
    case 'monthly':
      return `${minute} ${hour} ${clamp(parts.monthDay, 1, 28)} * *`
  }
}

/**
 * The four answers a cron string came from, or null when it came from
 * somewhere else.
 *
 * Null is the signal that the expression is genuinely custom — the form then
 * shows the cron field instead of pretending a stepped weekday range is
 * "weekly".
 * Deliberately strict: it accepts only what {@link buildCron} can emit, so the
 * round trip is exact and editing a schedule never rewrites its cron behind
 * the reader's back.
 */
export function parseCronParts(cron: string | null | undefined): CronParts | null {
  if (!cron) return null
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields
  if (monthField !== '*') return null

  const minute = numberField(minuteField, 0, 59)
  if (minute === null) return null

  if (hourField === '*') {
    // Only a plain "every hour at :mm" round-trips; a stepped hour is custom.
    return dayField === '*' && weekdayField === '*'
      ? { ...DEFAULT_CRON_PARTS, frequency: 'hourly', minute }
      : null
  }

  const hour = numberField(hourField, 0, 23)
  if (hour === null) return null

  if (dayField === '*' && weekdayField === '*') {
    return { ...DEFAULT_CRON_PARTS, frequency: 'daily', minute, hour }
  }
  if (dayField === '*') {
    const weekdays = weekdayListField(weekdayField)
    return weekdays === null
      ? null
      : { ...DEFAULT_CRON_PARTS, frequency: 'weekly', minute, hour, weekdays }
  }
  if (weekdayField === '*') {
    const monthDay = numberField(dayField, 1, 28)
    return monthDay === null
      ? null
      : { ...DEFAULT_CRON_PARTS, frequency: 'monthly', minute, hour, monthDay }
  }
  return null
}

/**
 * Cheap client-side shape validation: exactly five whitespace-separated fields
 * of allowed cron characters. Deliberately permissive — it catches obvious
 * typos for instant feedback and defers real parsing and the minimum-interval
 * rule to the server, which returns the authoritative error.
 */
export function isPlausibleCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((field) => /^[0-9*/,\-]+$/.test(field))
}

/** `HH:MM` for a time input, from the parts. */
export function partsToTimeValue(parts: CronParts): string {
  return `${pad(clamp(parts.hour, 0, 23))}:${pad(clamp(parts.minute, 0, 59))}`
}

/** An `HH:MM` time input back into the two fields, ignoring anything malformed. */
export function timeValueToParts(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/** Browser's IANA timezone, falling back to UTC when unavailable. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Full IANA timezone list, falling back to a small common set on old runtimes. */
export function supportedTimezones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  if (typeof supported === 'function') {
    try {
      return supported('timeZone')
    } catch {
      /* fall through */
    }
  }
  return ['UTC', 'Europe/Vienna', 'Europe/Berlin', 'Europe/London', 'America/New_York']
}

/**
 * The localized name of a cron weekday number (0 = Sunday).
 *
 * Derived from `Intl` against a known week rather than from a dictionary list:
 * seven weekday names in two locales is seven strings the browser already
 * holds, and a hand-kept copy is a translation that can go stale.
 */
export function weekdayName(weekday: number, locale: string, width: 'long' | 'short' = 'long'): string {
  // 2024-01-07 was a Sunday, so +weekday lands on the day cron means.
  const reference = new Date(Date.UTC(2024, 0, 7 + clamp(weekday, 0, 6)))
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' }).format(reference)
}

/** `HH:MM` in the reader's locale, from the two cron fields. */
export function formatTimeOfDay(hour: number, minute: number, locale: string): string {
  const reference = new Date(Date.UTC(2024, 0, 1, clamp(hour, 0, 23), clamp(minute, 0, 59)))
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(reference)
}

type Translate = (key: string, values?: Record<string, string | number>) => string

/**
 * One sentence saying when a schedule fires, in the reader's language.
 *
 * Built from {@link parseCronParts} rather than from a fixed preset table, so
 * "Jeden Mittwoch um 08:00" is a sentence and not `Benutzerdefiniert (0 8 * * 3)`.
 * A genuinely custom expression still shows verbatim — a cron nobody can read
 * is better than a paraphrase that might be wrong.
 */
export function scheduleSummary(
  t: Translate,
  cron: string | null,
  timezone: string,
  locale: string,
  options: { withTimezone?: boolean } = {},
): string {
  if (!cron) return t('list.manualOnly')
  const parts = parseCronParts(cron)
  const summary = parts ? describeParts(t, parts, locale) : t('schedule.summaryCustom', { cron })
  return options.withTimezone === false
    ? summary
    : t('schedule.inTimezone', { summary, timezone })
}

function describeParts(t: Translate, parts: CronParts, locale: string): string {
  const time = formatTimeOfDay(parts.hour, parts.minute, locale)
  switch (parts.frequency) {
    case 'hourly':
      return t('schedule.summaryHourly', { minute: pad(parts.minute) })
    case 'daily':
      return t('schedule.summaryDaily', { time })
    case 'weekly': {
      const days = normalizeWeekdays(parts.weekdays)
      // Every day is "daily" said the long way round, and five weekdays is a
      // phrase people use — both read better than a list of seven names.
      if (days.length === 7) return t('schedule.summaryDaily', { time })
      if (isWeekdays(days)) return t('schedule.summaryWeekdays', { time })
      return t('schedule.summaryWeekly', {
        weekday: days.map((day) => weekdayName(day, locale, days.length > 2 ? 'short' : 'long')).join(', '),
        time,
      })
    }
    case 'monthly':
      return t('schedule.summaryMonthly', { day: parts.monthDay, time })
  }
}

/**
 * A comma-separated day-of-week list, sorted and de-duplicated, or null.
 *
 * Only plain numbers: a RANGE (`1-5`) is deliberately refused even though cron
 * accepts it and the composer could render it, because `buildCron` never emits
 * one — and a parser that accepts more than the writer emits is how editing a
 * schedule silently rewrites it.
 */
function weekdayListField(field: string): number[] | null {
  const parts = field.split(',')
  const days: number[] = []
  for (const part of parts) {
    const value = numberField(part, 0, 6)
    if (value === null) return null
    if (!days.includes(value)) days.push(value)
  }
  return days.length > 0 ? days.sort((a, b) => a - b) : null
}

/** Sorted, de-duplicated, in range — and never empty, which cron cannot express. */
export function normalizeWeekdays(weekdays: readonly number[]): number[] {
  const days = [...new Set(weekdays.map((day) => clamp(day, 0, 6)))].sort((a, b) => a - b)
  return days.length > 0 ? days : [1]
}

/** Monday through Friday, and nothing else. */
function isWeekdays(days: readonly number[]): boolean {
  return days.length === 5 && days.every((day) => day >= 1 && day <= 5)
}

function numberField(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null
  const value = Number(field)
  return value >= min && value <= max ? value : null
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
