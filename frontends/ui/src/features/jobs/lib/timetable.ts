/**
 * The week grid's geometry — pure, so the timetable component paints and
 * decides nothing.
 *
 * A Stundenplan answers a question no list of cron strings can: what does this
 * project's week LOOK like. Three things only a laid-out grid shows —
 * collisions (four schedules all at Monday 06:00 is one notification storm and
 * one load spike), dead zones (nothing between Friday noon and Monday), and
 * density — and all three are properties of the arrangement rather than of any
 * row. That is the whole reason this surface exists, and the reason the maths
 * lives here with a spec beside it rather than inside JSX.
 *
 * Everything below is in the READER's local timezone. The schedules fire in
 * their own (`Job.scheduleTimezone`, expanded in `occurrences.ts`); placing
 * them on one local grid is what makes a Vienna schedule and a New York one
 * land where they actually collide instead of where their cron strings rhyme.
 */

import type { Occurrence } from './occurrences'

/**
 * The visual duration of one firing, in minutes.
 *
 * A firing is an instant — it has no length — but a grid needs a box, and a
 * 1-minute box is a hairline nobody can hit or read. 30 minutes is the block
 * height AND the overlap window: two schedules within half an hour of each
 * other are the collision a person cares about, so they are packed side by
 * side rather than drawn on top of one another.
 */
export const BLOCK_MINUTES = 30

/** Minutes in a day. Named because it appears as a bound, not as a magic 1440. */
export const DAY_MINUTES = 24 * 60

/** The narrowest segment the grid will crop to, so one firing still has shape. */
const MIN_SEGMENT_MINUTES = 3 * 60

/** Breathing room above the first firing of a segment and below the last. */
const SEGMENT_PADDING_MINUTES = 60

/**
 * The empty stretch that earns a BREAK rather than a scroll.
 *
 * A planning office schedules in the morning and again after site visits, so
 * the honest band for a typical week is 05:00–17:30 — and ten of those twelve
 * hours are empty. Drawn to scale, the two clusters a person came to read are
 * two thin strips at opposite ends of a page of nothing.
 *
 * So the day is cut into SEGMENTS around gaps of three hours or more, with the
 * gap shown as a marked break that names how long it is. Nothing is hidden and
 * nothing is rescaled: the hours inside a segment keep a constant scale, and
 * the break says exactly what was skipped. Under three hours the gap is drawn
 * to scale — a two-hour pause between two schedules is a shape worth seeing,
 * and cutting it would flatten the very rhythm the grid exists to show.
 */
const MIN_GAP_TO_BREAK_MINUTES = 3 * 60

export interface TimetableBlock {
  jobId: string
  at: Date
  /** Minutes from local midnight of its day. */
  startMinute: number
  /** This block's column within its overlap cluster, 0-based. */
  lane: number
  /** How many columns that cluster needs. */
  lanes: number
}

export interface TimetableDay {
  /** Local midnight of this day. */
  date: Date
  blocks: TimetableBlock[]
}

/** One continuous stretch of the day the grid draws to scale. */
export interface BandSegment {
  /** First minute of the segment, from midnight. */
  start: number
  /** One past its last minute. */
  end: number
}

export interface Timetable {
  days: TimetableDay[]
  /**
   * The stretches of the day that are drawn, in order, with the gaps between
   * them rendered as marked breaks. One segment means one continuous band.
   */
  segments: BandSegment[]
  /** True when anything was cropped or broken — the surface offers all 24 hours. */
  cropped: boolean
}

/**
 * Local midnight of the Monday on or before `date`.
 *
 * Monday, not Sunday: this is a German-language product for Austrian planning
 * offices, where the week starts on Monday and a weekend is the two columns at
 * the right-hand end — which is exactly where a reader expects the empty ones.
 */
export function startOfWeek(date: Date): Date {
  const out = new Date(date)
  out.setHours(0, 0, 0, 0)
  // getDay(): 0 = Sunday. Sunday belongs to the week that started six days ago.
  const shift = (out.getDay() + 6) % 7
  out.setDate(out.getDate() - shift)
  return out
}

/** `count` days on from local midnight of `from`, DST-safe (no 24h arithmetic). */
export function addDays(from: Date, count: number): Date {
  const out = new Date(from)
  out.setDate(out.getDate() + count)
  return out
}

/** Minutes from local midnight. */
export function minuteOfDay(at: Date): number {
  return at.getHours() * 60 + at.getMinutes()
}

/**
 * Lay a week of firings out as seven day columns.
 *
 * `fullDay` forces the 00:00–24:00 band; otherwise the grid crops to the hours
 * that actually carry something, padded by an hour either side. Cropping is not
 * a cosmetic choice: an uncropped grid spends 80% of its height on the night
 * nothing runs in, which pushes the 06:00 cluster — the thing the reader came
 * for — into a 40-pixel sliver.
 */
export function buildTimetable(
  occurrences: readonly Occurrence[],
  weekStart: Date,
  fullDay = false,
): Timetable {
  const days: TimetableDay[] = Array.from({ length: 7 }, (_, index) => ({
    date: addDays(weekStart, index),
    blocks: [],
  }))

  const weekEnd = addDays(weekStart, 7)
  const placed: { dayIndex: number; block: TimetableBlock }[] = []

  for (const occurrence of occurrences) {
    const at = occurrence.at
    if (at < weekStart || at >= weekEnd) continue
    const dayIndex = dayIndexOf(weekStart, at)
    if (dayIndex < 0 || dayIndex > 6) continue
    placed.push({
      dayIndex,
      block: { jobId: occurrence.jobId, at, startMinute: minuteOfDay(at), lane: 0, lanes: 1 },
    })
  }

  for (const entry of placed) {
    days[entry.dayIndex].blocks.push(entry.block)
  }
  for (const day of days) {
    packLanes(day.blocks)
  }

  const segments = segmentsFor(placed.map((entry) => entry.block.startMinute), fullDay)
  const cropped =
    segments.length > 1 || segments[0].start > 0 || segments[0].end < DAY_MINUTES
  return { days, segments, cropped }
}

/**
 * Which segment a minute falls in, or -1 when none does.
 *
 * Every placed block is inside one by construction — the segments are built
 * FROM the block times — so -1 only ever means a caller asked about an hour the
 * grid is not drawing.
 */
export function segmentIndexFor(segments: readonly BandSegment[], minute: number): number {
  return segments.findIndex((segment) => minute >= segment.start && minute < segment.end)
}

/** Minutes of day a segment draws. */
export function segmentMinutes(segment: BandSegment): number {
  return segment.end - segment.start
}

/** The gap a break covers, in minutes, between two consecutive segments. */
export function gapMinutes(segments: readonly BandSegment[], index: number): number {
  const before = segments[index]
  const after = segments[index + 1]
  return before && after ? after.start - before.end : 0
}

/**
 * Which of the seven columns an instant belongs to.
 *
 * Counted in CALENDAR days rather than by dividing a millisecond difference by
 * 86 400 000: the week a clock change falls in has a 23-hour day and a 25-hour
 * one, and the division puts that week's Sunday firings in Saturday's column.
 */
function dayIndexOf(weekStart: Date, at: Date): number {
  for (let index = 0; index < 7; index += 1) {
    const dayStart = addDays(weekStart, index)
    const dayEnd = addDays(weekStart, index + 1)
    if (at >= dayStart && at < dayEnd) return index
  }
  return -1
}

/**
 * Side-by-side columns for firings that overlap, in place.
 *
 * Greedy and cluster-local: blocks are swept in time order, and a block that
 * starts before the running cluster ends joins it. Every block in a cluster
 * gets the SAME `lanes` count, so a cluster renders as equal columns rather
 * than as boxes of drifting width — the property that makes four schedules at
 * 06:00 read as four, immediately.
 */
function packLanes(blocks: TimetableBlock[]): void {
  blocks.sort((a, b) => a.startMinute - b.startMinute || a.jobId.localeCompare(b.jobId))

  let cluster: TimetableBlock[] = []
  let clusterEnd = -1

  const closeCluster = (): void => {
    for (const block of cluster) block.lanes = cluster.length
    cluster = []
    clusterEnd = -1
  }

  for (const block of blocks) {
    if (cluster.length > 0 && block.startMinute >= clusterEnd) closeCluster()
    block.lane = cluster.length
    cluster.push(block)
    clusterEnd = Math.max(clusterEnd, block.startMinute + BLOCK_MINUTES)
  }
  if (cluster.length > 0) closeCluster()
}

/**
 * The stretches of the day the grid draws, cropped and broken around the gaps.
 *
 * Built by clustering the firing times: a new cluster starts wherever the
 * distance to the previous firing exceeds {@link MIN_GAP_TO_BREAK_MINUTES}.
 * Each cluster is then padded by an hour, snapped to whole hours, and widened
 * to the minimum segment height; overlapping neighbours are merged, so padding
 * can never produce two segments that touch.
 */
function segmentsFor(startMinutes: readonly number[], fullDay: boolean): BandSegment[] {
  if (fullDay || startMinutes.length === 0) {
    return [{ start: 0, end: DAY_MINUTES }]
  }

  const sorted = [...new Set(startMinutes)].sort((a, b) => a - b)
  const clusters: number[][] = [[sorted[0]]]
  for (const minute of sorted.slice(1)) {
    const current = clusters[clusters.length - 1]
    const previous = current[current.length - 1]
    if (minute - (previous + BLOCK_MINUTES) >= MIN_GAP_TO_BREAK_MINUTES) clusters.push([minute])
    else current.push(minute)
  }

  const segments: BandSegment[] = clusters.map((cluster) => {
    const earliest = cluster[0]
    const latest = cluster[cluster.length - 1] + BLOCK_MINUTES
    let start = clampToHour(earliest - SEGMENT_PADDING_MINUTES, 'down')
    let end = clampToHour(latest + SEGMENT_PADDING_MINUTES, 'up')
    // Grow off whichever edge still has room. A segment that only ever grows
    // downward pins an 07:00 schedule to its top edge, which reads as "nothing
    // could happen before this" rather than as a crop.
    while (end - start < MIN_SEGMENT_MINUTES) {
      if (start > 0) start -= 60
      else if (end < DAY_MINUTES) end += 60
      else break
    }
    return { start: Math.max(0, start), end: Math.min(DAY_MINUTES, end) }
  })

  return mergeTouching(segments)
}

/** Fold segments whose padding made them meet, so no break covers nothing. */
function mergeTouching(segments: readonly BandSegment[]): BandSegment[] {
  const merged: BandSegment[] = []
  for (const segment of segments) {
    const last = merged[merged.length - 1]
    if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end)
    else merged.push({ ...segment })
  }
  return merged
}

function clampToHour(minute: number, direction: 'up' | 'down'): number {
  const bounded = Math.max(0, Math.min(DAY_MINUTES, minute))
  return direction === 'down'
    ? Math.floor(bounded / 60) * 60
    : Math.ceil(bounded / 60) * 60
}

/** The hour marks inside one segment, as minute offsets from midnight. */
export function hourMarks(segment: BandSegment): number[] {
  const marks: number[] = []
  for (let minute = segment.start; minute < segment.end; minute += 60) marks.push(minute)
  return marks
}
