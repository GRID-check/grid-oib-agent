/**
 * The week grid's geometry.
 *
 * Three properties carry the surface, and each is a thing the grid claims about
 * the week that a list cannot: that a COLLISION renders as columns side by side,
 * that the band CROPS to the hours something happens in, and that a day is a
 * calendar day rather than 86 400 000 milliseconds — the difference that puts
 * Sunday's firings in Sunday's column on the weekend a clock changes.
 */

import { describe, expect, test } from 'vitest'
import {
  addDays,
  BLOCK_MINUTES,
  buildTimetable,
  DAY_MINUTES,
  gapMinutes,
  hourMarks,
  minuteOfDay,
  segmentIndexFor,
  segmentMinutes,
  startOfWeek,
} from './timetable'
import type { Occurrence } from './occurrences'

/** A firing at a local wall-clock time on the nth day of the shown week. */
const at = (weekStart: Date, day: number, hour: number, minute = 0, jobId = 'j1'): Occurrence => {
  const date = addDays(weekStart, day)
  date.setHours(hour, minute, 0, 0)
  return { jobId, at: date }
}

describe('startOfWeek', () => {
  test('a week starts on Monday — this product is German and so is its week', () => {
    // 2026-09-16 is a Wednesday.
    const monday = startOfWeek(new Date(2026, 8, 16, 13, 45))
    expect(monday.getDay()).toBe(1)
    expect(monday.getDate()).toBe(14)
    expect([monday.getHours(), monday.getMinutes()]).toEqual([0, 0])
  })

  test('Sunday belongs to the week that started six days ago, not to the next one', () => {
    // 2026-09-20 is a Sunday.
    const monday = startOfWeek(new Date(2026, 8, 20, 23, 30))
    expect(monday.getDate()).toBe(14)
  })

  test('is idempotent — a Monday is already the start of its week', () => {
    const monday = startOfWeek(new Date(2026, 8, 14, 9, 0))
    expect(startOfWeek(monday).getTime()).toBe(monday.getTime())
  })
})

describe('buildTimetable columns', () => {
  const weekStart = startOfWeek(new Date(2026, 8, 14))

  test('lays out seven days, Monday first', () => {
    const { days } = buildTimetable([], weekStart)
    expect(days).toHaveLength(7)
    expect(days[0].date.getDay()).toBe(1)
    expect(days[6].date.getDay()).toBe(0)
  })

  test('puts a firing in the column of the calendar day it falls on', () => {
    const { days } = buildTimetable([at(weekStart, 2, 6)], weekStart)
    expect(days[2].blocks).toHaveLength(1)
    expect(days[2].blocks[0].startMinute).toBe(6 * 60)
    expect(days.filter((day) => day.blocks.length > 0)).toHaveLength(1)
  })

  test('drops anything outside the shown week rather than folding it into an edge', () => {
    const before = { jobId: 'j1', at: addDays(weekStart, -1) }
    const after = { jobId: 'j1', at: addDays(weekStart, 8) }
    const { days } = buildTimetable([before, after], weekStart)
    expect(days.every((day) => day.blocks.length === 0)).toBe(true)
  })
})

/**
 * The collision. Four schedules at Monday 06:00 is one notification storm and
 * one load spike, and the ONLY way a person sees it is four boxes side by side.
 */
describe('lane packing', () => {
  const weekStart = startOfWeek(new Date(2026, 8, 14))

  test('firings at the same minute get one column each, all the same width', () => {
    const { days } = buildTimetable(
      [at(weekStart, 0, 6, 0, 'a'), at(weekStart, 0, 6, 0, 'b'), at(weekStart, 0, 6, 0, 'c')],
      weekStart,
    )
    const blocks = days[0].blocks
    expect(blocks.map((block) => block.lane).sort()).toEqual([0, 1, 2])
    expect(blocks.every((block) => block.lanes === 3)).toBe(true)
  })

  test('firings inside the block window still count as a collision', () => {
    const { days } = buildTimetable(
      [at(weekStart, 0, 6, 0, 'a'), at(weekStart, 0, 6, BLOCK_MINUTES - 1, 'b')],
      weekStart,
    )
    expect(days[0].blocks.every((block) => block.lanes === 2)).toBe(true)
  })

  test('firings a full block apart do not — each gets the whole column', () => {
    const { days } = buildTimetable(
      [at(weekStart, 0, 6, 0, 'a'), at(weekStart, 0, 6, BLOCK_MINUTES, 'b')],
      weekStart,
    )
    expect(days[0].blocks.every((block) => block.lanes === 1)).toBe(true)
  })

  test('ties break on the schedule id, so a re-render never reshuffles the columns', () => {
    const forwards = buildTimetable(
      [at(weekStart, 0, 6, 0, 'b'), at(weekStart, 0, 6, 0, 'a')],
      weekStart,
    )
    const backwards = buildTimetable(
      [at(weekStart, 0, 6, 0, 'a'), at(weekStart, 0, 6, 0, 'b')],
      weekStart,
    )
    expect(forwards.days[0].blocks.map((block) => block.jobId)).toEqual(['a', 'b'])
    expect(backwards.days[0].blocks.map((block) => block.jobId)).toEqual(['a', 'b'])
  })
})

/**
 * The crop and the breaks.
 *
 * An uncropped grid spends most of its height on the night nothing runs in. A
 * cropped one still can: a planning office schedules in the morning and again
 * after site visits, and the honest 05:00–17:30 band for that week is ten
 * empty hours with a thin strip at each end. So the day is also BROKEN around
 * long gaps — nothing hidden, nothing rescaled, the gap stated.
 */
describe('the hour band', () => {
  const weekStart = startOfWeek(new Date(2026, 8, 14))

  test('crops to the hours something happens in, padded by an hour either side', () => {
    const { segments, cropped } = buildTimetable(
      [at(weekStart, 0, 6), at(weekStart, 3, 8, 30)],
      weekStart,
    )
    expect(cropped).toBe(true)
    expect(segments).toEqual([{ start: 5 * 60, end: 10 * 60 }])
  })

  test('a morning and an afternoon become TWO segments, not one long emptiness', () => {
    const { segments } = buildTimetable(
      [at(weekStart, 0, 6), at(weekStart, 1, 16, 30)],
      weekStart,
    )
    expect(segments).toHaveLength(2)
    expect(segments[0].end).toBeLessThan(segments[1].start)
    // And the break says how much was skipped.
    expect(gapMinutes(segments, 0)).toBe(segments[1].start - segments[0].end)
  })

  test('a gap short enough to draw is drawn — the rhythm is the point', () => {
    // Two hours apart: under the break threshold, so one continuous segment.
    const { segments } = buildTimetable(
      [at(weekStart, 0, 6), at(weekStart, 0, 8)],
      weekStart,
    )
    expect(segments).toHaveLength(1)
  })

  test('segments whose padding made them meet are merged, so no break covers nothing', () => {
    const { segments } = buildTimetable(
      [at(weekStart, 0, 6), at(weekStart, 0, 9, 30)],
      weekStart,
    )
    expect(segments).toHaveLength(1)
  })

  test('a single early schedule still gets a segment with shape around it', () => {
    const { segments } = buildTimetable([at(weekStart, 0, 6)], weekStart)
    expect(segmentMinutes(segments[0])).toBeGreaterThanOrEqual(3 * 60)
    // Padded above as well as below, so 06:00 is not pinned to the top edge as
    // though nothing could happen before it.
    expect(segments[0].start).toBeLessThan(6 * 60)
    expect(segments[0].end).toBeGreaterThan(6 * 60 + BLOCK_MINUTES)
  })

  test('fullDay overrides the crop AND the breaks, and says it is not cropped', () => {
    const { segments, cropped } = buildTimetable(
      [at(weekStart, 0, 6), at(weekStart, 1, 16, 30)],
      weekStart,
      true,
    )
    expect(segments).toEqual([{ start: 0, end: DAY_MINUTES }])
    expect(cropped).toBe(false)
  })

  test('an empty week is the whole day — there is nothing to crop to', () => {
    const { segments, cropped } = buildTimetable([], weekStart)
    expect(segments).toEqual([{ start: 0, end: DAY_MINUTES }])
    expect(cropped).toBe(false)
  })

  test('no segment ever runs past midnight at either end', () => {
    const { segments } = buildTimetable(
      [at(weekStart, 0, 0, 5), at(weekStart, 0, 23, 55)],
      weekStart,
    )
    expect(segments[0].start).toBe(0)
    expect(segments[segments.length - 1].end).toBe(DAY_MINUTES)
  })

  test('every placed block falls inside a segment — the grid draws all of them', () => {
    const { segments, days } = buildTimetable(
      [at(weekStart, 0, 6), at(weekStart, 1, 16, 30), at(weekStart, 2, 21)],
      weekStart,
    )
    for (const day of days) {
      for (const block of day.blocks) {
        expect(segmentIndexFor(segments, block.startMinute)).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('hourMarks', () => {
  test('one mark per hour, from the segment start, none past the end', () => {
    expect(hourMarks({ start: 5 * 60, end: 8 * 60 })).toEqual([300, 360, 420])
  })
})

describe('minuteOfDay', () => {
  test('counts from local midnight', () => {
    expect(minuteOfDay(new Date(2026, 8, 14, 6, 30))).toBe(390)
  })
})
