/**
 * The cron expansion the timetable and the wizard both stand on.
 *
 * Deliberately NOT mocked: what is being checked is that the same library the
 * BFF validates and advances schedules with (`lib/jobs/schedule.ts`) is the one
 * answering here. A stub would pin the shape of this module's own arithmetic
 * and prove nothing about whether the grid shows the week that will actually
 * happen — which is the only claim it makes.
 */

import { describe, expect, test } from 'vitest'
import { expandWindow, nextOccurrences } from './occurrences'

const schedule = (overrides: Partial<Parameters<typeof expandWindow>[0][number]> = {}) => ({
  id: 'j1',
  cron: '0 6 * * *',
  timezone: 'Europe/Vienna',
  enabled: true,
  ...overrides,
})

describe('expandWindow', () => {
  // A Monday-to-Monday window in Vienna time.
  const from = new Date('2026-09-14T00:00:00+02:00')
  const to = new Date('2026-09-21T00:00:00+02:00')

  test('a daily schedule fires once per day inside the window', async () => {
    const { occurrences } = await expandWindow([schedule()], from, to)
    expect(occurrences).toHaveLength(7)
  })

  test('a firing exactly on the window edge is inside it', async () => {
    // Midnight Monday — the left edge itself, which cron-parser's exclusive
    // `currentDate` would otherwise drop.
    const { occurrences } = await expandWindow([schedule({ cron: '0 0 * * 1' })], from, to)
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0].at.toISOString()).toBe(from.toISOString())
  })

  test('the right edge is exclusive, so a week never shows the next Monday', async () => {
    const { occurrences } = await expandWindow([schedule({ cron: '0 0 * * 1' })], from, to)
    expect(occurrences.every((occurrence) => occurrence.at < to)).toBe(true)
  })

  test('a one-shot due inside the window is placed, exactly once', async () => {
    // The week grid answers "what is happening this week". A task due on
    // Thursday is one of the most important answers it has, and while the
    // expander keyed on a cron it could not draw one at all.
    const dueAt = new Date('2026-09-17T09:00:00+02:00')
    const { occurrences, invalid, truncated } = await expandWindow(
      [schedule({ id: 'once-1', cron: null, dueAt })],
      from,
      to,
    )

    expect(occurrences).toEqual([{ jobId: 'once-1', at: dueAt }])
    // There is no expression to be wrong about and no cap to hit.
    expect(invalid).toEqual([])
    expect(truncated).toEqual([])
  })

  test('a one-shot outside the window is not placed in it', async () => {
    const { occurrences } = await expandWindow(
      [schedule({ id: 'once-1', cron: null, dueAt: new Date('2026-09-28T09:00:00+02:00') })],
      from,
      to,
    )
    expect(occurrences).toEqual([])
  })

  test('a paused one-shot contributes nothing, like a paused schedule', async () => {
    const { occurrences } = await expandWindow(
      [
        schedule({
          id: 'once-1',
          cron: null,
          dueAt: new Date('2026-09-17T09:00:00+02:00'),
          enabled: false,
        }),
      ],
      from,
      to,
    )
    expect(occurrences).toEqual([])
  })

  test('a manual task has no time and is simply absent', async () => {
    const { occurrences, invalid } = await expandWindow(
      [schedule({ id: 'manual-1', cron: null, dueAt: null })],
      from,
      to,
    )
    expect(occurrences).toEqual([])
    // Absent is not broken: a manual task is not an unreadable cron.
    expect(invalid).toEqual([])
  })

  test('each schedule fires in ITS timezone, onto one absolute grid', async () => {
    const { occurrences } = await expandWindow(
      [
        schedule({ id: 'vienna', cron: '0 6 * * 2', timezone: 'Europe/Vienna' }),
        schedule({ id: 'ny', cron: '0 6 * * 2', timezone: 'America/New_York' }),
      ],
      from,
      to,
    )
    const [first, second] = occurrences
    // Same wall clock, six hours apart in real time — and sorted by instant, so
    // Vienna lands first.
    expect(first.jobId).toBe('vienna')
    expect(second.jobId).toBe('ny')
    expect(second.at.getTime() - first.at.getTime()).toBe(6 * 60 * 60 * 1000)
  })

  test('a paused schedule contributes nothing: it is not going to happen', async () => {
    const { occurrences } = await expandWindow([schedule({ enabled: false })], from, to)
    expect(occurrences).toHaveLength(0)
  })

  test('a schedule with no cron contributes nothing and is not an error', async () => {
    const { occurrences, invalid } = await expandWindow([schedule({ cron: null })], from, to)
    expect(occurrences).toHaveLength(0)
    expect(invalid).toEqual([])
  })

  test('an unreadable cron is REPORTED, never silently left off the grid', async () => {
    const { occurrences, invalid } = await expandWindow(
      [schedule({ id: 'broken', cron: 'not a cron' })],
      from,
      to,
    )
    expect(occurrences).toHaveLength(0)
    expect(invalid).toEqual(['broken'])
  })

  test('one dense schedule is capped, and says so, instead of drawing a wall', async () => {
    const { occurrences, truncated } = await expandWindow(
      [schedule({ id: 'hourly', cron: '0 * * * *' })],
      from,
      to,
    )
    // 168 hours in a week; the per-schedule cap is lower on purpose.
    expect(occurrences.length).toBeLessThan(168)
    expect(truncated).toEqual(['hourly'])
  })

  test('returns one sorted stream, so the grid never re-sorts it', async () => {
    const { occurrences } = await expandWindow(
      [schedule({ id: 'late', cron: '0 18 * * *' }), schedule({ id: 'early', cron: '0 6 * * *' })],
      from,
      to,
    )
    const times = occurrences.map((occurrence) => occurrence.at.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})

describe('nextOccurrences', () => {
  const after = new Date('2026-09-14T00:00:00+02:00')

  test('returns the next n firings, strictly after the given instant', async () => {
    const dates = await nextOccurrences('0 6 * * *', 'Europe/Vienna', 3, after)
    expect(dates).toHaveLength(3)
    expect(dates.every((date) => date > after)).toBe(true)
    expect(dates[1].getTime() - dates[0].getTime()).toBe(24 * 60 * 60 * 1000)
  })

  test('an unreadable expression yields nothing — the caller renders a sentence', async () => {
    expect(await nextOccurrences('not a cron', 'UTC', 3, after)).toEqual([])
  })

  test('a finite expression runs out instead of throwing', async () => {
    // February 30th never comes round.
    expect(await nextOccurrences('0 6 30 2 *', 'UTC', 3, after)).toEqual([])
  })
})
