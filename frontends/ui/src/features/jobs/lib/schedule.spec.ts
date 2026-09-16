/**
 * The cron composer, and the round trip that makes editing safe.
 *
 * The rule under test is that `parseCronParts` accepts EXACTLY what `buildCron`
 * emits and nothing else. If it were looser, opening somebody else's schedule
 * in the wizard and pressing save would silently rewrite when it fires — the
 * expression would be re-composed from a reading the composer cannot actually
 * express. Strictness is why a stepped or listed field falls through to the raw
 * cron field instead.
 */

import { describe, expect, test } from 'vitest'
import {
  cadenceOf,
  whenSummary,
  defaultDueAt,
  toDateTimeLocal,
  buildCron,
  DEFAULT_CRON_PARTS,
  isPlausibleCron,
  parseCronParts,
  partsToTimeValue,
  scheduleSummary,
  timeValueToParts,
  weekdayName,
  type CronParts,
} from './schedule'

const parts = (overrides: Partial<CronParts> = {}): CronParts => ({
  ...DEFAULT_CRON_PARTS,
  ...overrides,
})

describe('buildCron', () => {
  test('writes the five fields each cadence needs, and stars the rest', () => {
    expect(buildCron(parts({ frequency: 'hourly', minute: 15 }))).toBe('15 * * * *')
    expect(buildCron(parts({ frequency: 'daily', hour: 6, minute: 0 }))).toBe('0 6 * * *')
    expect(buildCron(parts({ frequency: 'weekly', hour: 8, minute: 30, weekdays: [3] }))).toBe(
      '30 8 * * 3',
    )
    expect(buildCron(parts({ frequency: 'monthly', hour: 6, minute: 0, monthDay: 1 }))).toBe(
      '0 6 1 * *',
    )
  })

  test('clamps out-of-range input rather than emitting an unparseable field', () => {
    expect(buildCron(parts({ frequency: 'daily', hour: 99, minute: -4 }))).toBe('0 23 * * *')
    // 28 is the ceiling: a monthly schedule must never skip February.
    expect(buildCron(parts({ frequency: 'monthly', monthDay: 31 }))).toBe('0 6 28 * *')
  })
})

describe('parseCronParts', () => {
  test('round-trips everything buildCron can emit', () => {
    const cases: CronParts[] = [
      parts({ frequency: 'hourly', minute: 45 }),
      parts({ frequency: 'daily', hour: 17, minute: 5 }),
      parts({ frequency: 'weekly', hour: 8, minute: 30, weekdays: [0] }),
      parts({ frequency: 'monthly', hour: 6, minute: 0, monthDay: 14 }),
    ]
    for (const original of cases) {
      const parsed = parseCronParts(buildCron(original))
      expect(parsed).not.toBeNull()
      expect(buildCron(parsed as CronParts)).toBe(buildCron(original))
    }
  })

  test('several weekdays round-trip — "Mo, Mi, Fr" is one expression, not a custom one', () => {
    const many = parts({ frequency: 'weekly', hour: 6, minute: 0, weekdays: [1, 3, 5] })
    expect(buildCron(many)).toBe('0 6 * * 1,3,5')
    expect(parseCronParts('0 6 * * 1,3,5')?.weekdays).toEqual([1, 3, 5])
  })

  test('a weekday list is sorted and de-duplicated, so two equal schedules read alike', () => {
    expect(buildCron(parts({ frequency: 'weekly', weekdays: [5, 1, 5, 3] }))).toBe('0 6 * * 1,3,5')
  })

  test('an empty weekday list falls back to Monday — cron cannot write "never"', () => {
    expect(buildCron(parts({ frequency: 'weekly', weekdays: [] }))).toBe('0 6 * * 1')
  })

  test('refuses anything the composer cannot express, so the cron field shows instead', () => {
    for (const cron of [
      '*/15 * * * *', // stepped minute
      '0 */2 * * *', // stepped hour
      // A RANGE, even though it means the same as the list the composer emits:
      // a parser that accepts more than the writer emits rewrites schedules.
      '0 6 * * 1-5',
      '0 6,18 * * *', // an hour list
      '0 6 1 3 *', // a specific month
      '0 6 1 * 1', // day-of-month AND weekday
      '0 6 * *', // four fields
      '',
    ]) {
      expect(parseCronParts(cron), cron).toBeNull()
    }
  })

  test('null and undefined are "no schedule", not a parse failure to report', () => {
    expect(parseCronParts(null)).toBeNull()
    expect(parseCronParts(undefined)).toBeNull()
  })
})

describe('time round trip', () => {
  test('pads both halves, so an input element accepts it', () => {
    expect(partsToTimeValue(parts({ hour: 6, minute: 5 }))).toBe('06:05')
  })

  test('reads a time back, and rejects one no clock shows', () => {
    expect(timeValueToParts('08:30')).toEqual({ hour: 8, minute: 30 })
    expect(timeValueToParts('24:00')).toBeNull()
    expect(timeValueToParts('8:3')).toBeNull()
    expect(timeValueToParts('nonsense')).toBeNull()
  })
})

describe('isPlausibleCron', () => {
  test('catches the obvious typo and defers the rest to the server', () => {
    expect(isPlausibleCron('0 6 * * 1')).toBe(true)
    expect(isPlausibleCron('*/15 9-17 * * 1-5')).toBe(true)
    expect(isPlausibleCron('0 6 * *')).toBe(false)
    expect(isPlausibleCron('0 6 * * MON')).toBe(false)
  })
})

describe('weekdayName', () => {
  test('numbers the week the way cron does — 0 is Sunday', () => {
    expect(weekdayName(0, 'en-GB')).toBe('Sunday')
    expect(weekdayName(1, 'en-GB')).toBe('Monday')
    expect(weekdayName(6, 'en-GB')).toBe('Saturday')
  })

  test('is the readers language, not a hand-kept list', () => {
    expect(weekdayName(1, 'de-AT')).toBe('Montag')
  })
})

/**
 * The sentence on a card. The reason it is built from the parsed parts rather
 * than from a preset table is that the table only knew five expressions and
 * called everything else "Benutzerdefiniert (0 8 * * 3)" — which is a cron
 * string with an apology in front of it.
 */
describe('scheduleSummary', () => {
  // A stand-in dictionary: the keys and their interpolations are what matters.
  const t = (key: string, values: Record<string, string | number> = {}): string =>
    `${key}(${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join(',')})`

  test('a schedule with no cron is manual, and says so without inventing a cadence', () => {
    expect(scheduleSummary(t, null, 'Europe/Vienna', 'de-AT')).toBe('list.manualOnly()')
  })

  test('names the weekday and the time for a weekly schedule', () => {
    const summary = scheduleSummary(t, '30 8 * * 3', 'Europe/Vienna', 'de-AT', {
      withTimezone: false,
    })
    expect(summary).toContain('schedule.summaryWeekly')
    expect(summary).toContain('weekday=Mittwoch')
  })

  test('Monday-to-Friday is a PHRASE people use, not five names in a row', () => {
    const summary = scheduleSummary(t, '0 6 * * 1,2,3,4,5', 'UTC', 'de-AT', {
      withTimezone: false,
    })
    expect(summary).toContain('schedule.summaryWeekdays')
  })

  test('all seven days is "daily" said the long way round, so it says daily', () => {
    const summary = scheduleSummary(t, '0 6 * * 0,1,2,3,4,5,6', 'UTC', 'de-AT', {
      withTimezone: false,
    })
    expect(summary).toContain('schedule.summaryDaily')
  })

  test('three or more days abbreviate, so the chip does not become a paragraph', () => {
    const summary = scheduleSummary(t, '0 6 * * 1,3,5', 'UTC', 'de-AT', { withTimezone: false })
    expect(summary).toContain('schedule.summaryWeekly')
    expect(summary).not.toContain('Montag')
  })

  test('shows an inexpressible cron verbatim rather than paraphrasing it', () => {
    const summary = scheduleSummary(t, '*/7 3 * * 1-5', 'UTC', 'de-AT', { withTimezone: false })
    expect(summary).toBe('schedule.summaryCustom(cron=*/7 3 * * 1-5)')
  })

  test('the timezone rides along unless the caller has room for it elsewhere', () => {
    expect(scheduleSummary(t, '0 6 * * *', 'Europe/Vienna', 'de-AT')).toContain(
      'schedule.inTimezone',
    )
  })
})

describe('cadenceOf', () => {
  test('reads the three shapes off the two mutually exclusive wire fields', () => {
    expect(cadenceOf({ scheduleCron: '0 6 * * 1', dueAt: null })).toBe('recurring')
    expect(cadenceOf({ scheduleCron: null, dueAt: '2026-10-02T07:00:00Z' })).toBe('once')
    expect(cadenceOf({ scheduleCron: null, dueAt: null })).toBe('manual')
  })

  test('a cron wins, so a row that somehow has both still reads as one thing', () => {
    // The write boundary refuses both, and the CHECK constraint refuses both.
    // If one ever arrives anyway, the UI must still pick a single reading
    // rather than rendering a task that is two cadences at once.
    expect(cadenceOf({ scheduleCron: '0 6 * * 1', dueAt: '2026-10-02T07:00:00Z' })).toBe('recurring')
  })
})

describe('whenSummary', () => {
  const t = (key: string, values: Record<string, string | number> = {}): string =>
    `${key}(${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join(',')})`

  test('a one-shot reads as its date, not as "manual only"', () => {
    // The bug this exists to prevent: `scheduleSummary` answers "manual only"
    // for anything without a cron, which would describe a task due on Friday
    // as one that never fires by itself.
    const summary = whenSummary(
      t,
      { scheduleCron: null, dueAt: '2026-10-02T07:00:00Z', scheduleTimezone: 'Europe/Vienna' },
      'de-AT',
      { withTimezone: false },
    )
    expect(summary).toContain('list.onceOn')
    expect(summary).not.toContain('manualOnly')
  })

  test('still defers to the cron summary for a recurring task', () => {
    const summary = whenSummary(
      t,
      { scheduleCron: '0 6 * * *', dueAt: null, scheduleTimezone: 'UTC' },
      'de-AT',
      { withTimezone: false },
    )
    expect(summary).toContain('schedule.summaryDaily')
  })

  test('and to manual when there is neither', () => {
    expect(
      whenSummary(t, { scheduleCron: null, dueAt: null, scheduleTimezone: 'UTC' }, 'de-AT')
    ).toBe('list.manualOnly()')
  })
})

describe('defaultDueAt', () => {
  test('is tomorrow at 09:00, never now', () => {
    // "Now" is already in the past by the time the form is submitted, so the
    // first thing a reader would see is a validation error they did not cause.
    const due = defaultDueAt(new Date('2026-09-16T14:37:12'))
    expect(due.getDate()).toBe(17)
    expect(due.getHours()).toBe(9)
    expect(due.getMinutes()).toBe(0)
  })
})

describe('toDateTimeLocal', () => {
  test('formats in local parts, so the input shows the time the reader picked', () => {
    // Slicing toISOString() here would show a reader in Vienna 07:00 for a
    // task they scheduled at 09:00, and saving the form back would walk the
    // task two hours earlier every time somebody opened it.
    const local = new Date(2026, 9, 2, 9, 5)
    expect(toDateTimeLocal(local)).toBe('2026-10-02T09:05')
  })

  test('an invalid date is empty rather than "NaN-NaN-NaN"', () => {
    expect(toDateTimeLocal(new Date('nonsense'))).toBe('')
  })
})
