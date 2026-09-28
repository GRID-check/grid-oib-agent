'use client'

/**
 * The Stundenplan — this project's week, as a grid.
 *
 * A list of schedules can only ever tell you about one schedule at a time.
 * „Wöchentlich, Montag 06:00 · Europe/Vienna" is a fact a reader has to hold in
 * their head and compare against six other facts they are also holding, which
 * is how three things nobody wants stay invisible:
 *
 *   - **Collisions.** Four schedules at Monday 06:00 is one load spike and one
 *     morning of four notifications. On a grid it is four boxes side by side —
 *     seen, not deduced.
 *   - **Dead zones.** A week with nothing after Wednesday says the automation
 *     is doing less than its owner thinks.
 *   - **Density.** Whether this project runs twice a week or forty times.
 *
 * All three are properties of the ARRANGEMENT, so the arrangement has to be
 * drawn. That is the whole argument for this component.
 *
 * Two shapes for two viewports, from one model. Seven columns need roughly
 * 90px each to carry a name; below `md` that is not available, so the same
 * `Timetable` renders as an agenda — day headings and a time per firing. A
 * grid crushed to 45px columns is a picture of a grid, not a timetable.
 *
 * Colour is a GROUPING cue and never the only carrier of meaning: every block
 * is labelled with its schedule's name, the legend repeats the pairing, and the
 * validated categorical palette (`components/charts/palette`) is reused rather
 * than a ninth private set of hexes. Past the eight slots a schedule folds to
 * the neutral "other" step — the legend still names it.
 */

import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { CalendarOff, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react'

import { SeriesPaletteStyle, SERIES_SLOT_COUNT } from '@/components/charts/palette'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { Job } from '@/adapters/api/jobs-client'
import { expandWindow, type Occurrence } from '../lib/occurrences'
import {
  addDays,
  buildTimetable,
  gapMinutes,
  hourMarks,
  placeableSchedules,
  segmentIndexFor,
  segmentMinutes,
  seriesColorsFor,
  startOfWeek,
  BLOCK_MINUTES,
  type BandSegment,
  type Timetable,
  type TimetableBlock,
} from '../lib/timetable'

/** Pixels per hour inside a segment. One firing is a 28px block at this scale. */
const HOUR_PX = 56

/**
 * Height of the marked break between two segments.
 *
 * Deliberately not to scale — that is the whole point of a break — and
 * deliberately small enough that it can never be mistaken for an hour of the
 * day: it carries a dashed rule and the gap's own duration, so what was skipped
 * is stated rather than implied.
 */
const BREAK_PX = 28

/** How many weeks forward or back the arrows reach. */
const WEEK_RANGE = 8

interface ScheduleTimetableProps {
  schedules: readonly Job[]
  loading?: boolean
  onSelect?: (job: Job) => void
}

export function ScheduleTimetable({
  schedules,
  loading,
  onSelect,
}: ScheduleTimetableProps): JSX.Element {
  const t = useTranslations('jobs')
  const { locale } = useLocale()
  const [weekOffset, setWeekOffset] = useState(0)
  const [fullDay, setFullDay] = useState(false)
  const [occurrences, setOccurrences] = useState<readonly Occurrence[] | null>(null)
  const [invalid, setInvalid] = useState<readonly string[]>([])

  // The week's left edge, recomputed only when the offset moves. `new Date()`
  // inside a render would make every re-render a new week boundary at midnight.
  const weekStart = useMemo(
    () => addDays(startOfWeek(new Date()), weekOffset * 7),
    [weekOffset],
  )

  // Which tasks land on the week, and in what colour, is one rule — shared with
  // the list beside this grid so the swatch on a card and the block it names
  // cannot be different colours (`lib/timetable.ts`).
  const placeable = useMemo(() => placeableSchedules(schedules), [schedules])

  const colorOf = useMemo(() => {
    const slots = seriesColorsFor(schedules, SERIES_SLOT_COUNT)
    // The grid draws only placeable tasks, so a miss here is a task it is not
    // drawing; the shared „other" tone is the honest answer rather than a hole.
    return (jobId: string): string => slots.get(jobId) ?? 'var(--grid-series-other)'
  }, [schedules])

  const nameOf = useMemo(() => {
    const names = new Map(schedules.map((job) => [job.id, job.name]))
    return (jobId: string): string => names.get(jobId) ?? jobId
  }, [schedules])

  const jobById = useMemo(() => new Map(schedules.map((job) => [job.id, job])), [schedules])

  useEffect(() => {
    let cancelled = false
    setOccurrences(null)
    const weekEnd = addDays(weekStart, 7)
    void expandWindow(
      placeable.map((job) => ({
        id: job.id,
        cron: job.scheduleCron,
        dueAt: job.dueAt ? new Date(job.dueAt) : null,
        timezone: job.scheduleTimezone,
        enabled: job.enabled,
      })),
      weekStart,
      weekEnd,
    ).then((result) => {
      if (cancelled) return
      setOccurrences(result.occurrences)
      setInvalid(result.invalid)
    })
    return () => {
      cancelled = true
    }
  }, [placeable, weekStart])

  const timetable = useMemo<Timetable | null>(
    () => (occurrences === null ? null : buildTimetable(occurrences, weekStart, fullDay)),
    [occurrences, weekStart, fullDay],
  )

  const weekLabel = formatWeekRange(weekStart, locale)
  const expanding = loading || timetable === null

  return (
    // `grid-usage-viz` is what resolves `--grid-series-N`; the style element
    // beside it is what defines them for both themes.
    <section className="grid-usage-viz" aria-label={t('timetable.title')} data-testid="schedule-timetable">
      <SeriesPaletteStyle />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setWeekOffset((offset) => Math.max(-WEEK_RANGE, offset - 1))}
            disabled={weekOffset <= -WEEK_RANGE}
            aria-label={t('timetable.previousWeek')}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setWeekOffset((offset) => Math.min(WEEK_RANGE, offset + 1))}
            disabled={weekOffset >= WEEK_RANGE}
            aria-label={t('timetable.nextWeek')}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <p className="text-sm font-medium" data-testid="timetable-week">
          {weekOffset === 0 ? `${t('timetable.thisWeek')} · ${weekLabel}` : weekLabel}
        </p>
        {weekOffset !== 0 && (
          <Button variant="outline" size="sm" onClick={() => setWeekOffset(0)}>
            {t('timetable.today')}
          </Button>
        )}
        {/* Only offered when there is a crop to undo — a toggle that does
            nothing is a control a reader has to test to understand. */}
        {timetable?.cropped && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground ml-auto"
            onClick={() => setFullDay(true)}
            data-testid="timetable-full-day"
          >
            {t('timetable.showFullDay')}
          </Button>
        )}
        {fullDay && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground ml-auto"
            onClick={() => setFullDay(false)}
          >
            {t('timetable.showActiveHours')}
          </Button>
        )}
      </div>

      {invalid.length > 0 && (
        <p className="text-warning mb-3 flex items-center gap-1.5 text-xs" role="status">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          {t('timetable.unplaceable', { names: invalid.map(nameOf).join(', ') })}
        </p>
      )}

      {expanding ? (
        <Skeleton className="h-64 w-full rounded-lg" data-testid="timetable-loading" />
      ) : isEmpty(timetable) ? (
        <EmptyState
          icon={CalendarOff}
          variant="bare"
          size="sm"
          title={
            placeable.length === 0 ? t('timetable.emptyNoSchedules') : t('timetable.emptyThisWeek')
          }
          description={
            placeable.length === 0 ? t('timetable.emptyNoSchedulesHint') : undefined
          }
        />
      ) : (
        <>
          <WeekGrid
            timetable={timetable}
            locale={locale}
            colorOf={colorOf}
            nameOf={nameOf}
            onSelect={(jobId) => {
              const job = jobById.get(jobId)
              if (job) onSelect?.(job)
            }}
          />
          <Agenda
            timetable={timetable}
            locale={locale}
            colorOf={colorOf}
            nameOf={nameOf}
            emptyDayLabel={t('timetable.nothing')}
            onSelect={(jobId) => {
              const job = jobById.get(jobId)
              if (job) onSelect?.(job)
            }}
          />
        </>
      )}

      {placeable.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label={t('timetable.legend')}>
          {placeable.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => onSelect?.(job)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 flex items-center gap-1.5 rounded-sm text-xs focus-visible:outline-none focus-visible:ring-2"
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: colorOf(job.id) }}
                />
                <span className="max-w-48 truncate">{job.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function isEmpty(timetable: Timetable | null): boolean {
  return !timetable || timetable.days.every((day) => day.blocks.length === 0)
}

/**
 * Where a minute of the day sits, in pixels from the top of the body.
 *
 * Segments are stacked in order with a fixed-height break between each pair, so
 * an offset is the sum of everything above it plus the position inside its own
 * segment. Returns null for a minute the grid is not drawing — which cannot
 * happen for a placed block, since the segments were built from the blocks.
 */
function offsetFor(segments: readonly BandSegment[], minute: number): number | null {
  const index = segmentIndexFor(segments, minute)
  if (index < 0) return null
  let offset = 0
  for (let before = 0; before < index; before += 1) {
    offset += (segmentMinutes(segments[before]) / 60) * HOUR_PX + BREAK_PX
  }
  return offset + ((minute - segments[index].start) / 60) * HOUR_PX
}

/** Total body height: every segment drawn to scale, plus one break per gap. */
function bodyHeight(segments: readonly BandSegment[]): number {
  const drawn = segments.reduce(
    (total, segment) => total + (segmentMinutes(segment) / 60) * HOUR_PX,
    0,
  )
  return drawn + BREAK_PX * Math.max(0, segments.length - 1)
}

/** Where each break sits, and how long a gap it stands for. */
function breaksFor(
  segments: readonly BandSegment[],
): { top: number; minutes: number; key: number }[] {
  const breaks: { top: number; minutes: number; key: number }[] = []
  let offset = 0
  for (let index = 0; index < segments.length - 1; index += 1) {
    offset += (segmentMinutes(segments[index]) / 60) * HOUR_PX
    breaks.push({ top: offset, minutes: gapMinutes(segments, index), key: segments[index].end })
    offset += BREAK_PX
  }
  return breaks
}

interface ShapeProps {
  timetable: Timetable
  locale: string
  colorOf: (jobId: string) => string
  nameOf: (jobId: string) => string
  onSelect: (jobId: string) => void
}

/** Seven columns and an hour gutter. Desktop only — see the module docstring. */
function WeekGrid({ timetable, locale, colorOf, nameOf, onSelect }: ShapeProps): JSX.Element {
  const t = useTranslations('jobs')
  const { segments, days } = timetable
  const height = bodyHeight(segments)
  const marks = segments.flatMap((segment) => hourMarks(segment))
  const breaks = breaksFor(segments)
  const today = startOfDay(new Date())

  return (
    <div className="border-border hidden overflow-hidden rounded-lg border md:block" data-testid="timetable-grid">
      <div className="border-border flex border-b">
        <div className="w-12 shrink-0" />
        {days.map((day) => {
          const isToday = startOfDay(day.date).getTime() === today.getTime()
          return (
            <div
              key={day.date.toISOString()}
              className={cn(
                'border-border flex-1 border-l px-2 py-1.5 text-center',
                isToday && 'bg-primary/5',
              )}
            >
              <p
                className={cn(
                  'text-xs font-medium',
                  isToday ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(day.date)}
              </p>
              <p className="text-muted-foreground text-[11px] tabular-nums">
                {new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(day.date)}
              </p>
            </div>
          )
        })}
      </div>

      <div className="relative flex" style={{ height: `${height}px` }}>
        <div className="relative w-12 shrink-0">
          {marks.map((minute) => (
            <span
              key={minute}
              className="text-muted-foreground absolute right-1.5 -translate-y-1/2 text-[11px] tabular-nums"
              style={{ top: `${offsetFor(segments, minute) ?? 0}px` }}
            >
              {formatHour(minute, locale)}
            </span>
          ))}
        </div>
        {days.map((day) => (
          <div key={day.date.toISOString()} className="border-border relative flex-1 border-l">
            {/* Hour rules, drawn per column so they cannot drift out of
                alignment with the blocks laid on top of them. */}
            {marks.map((minute, index) => (
              <span
                key={minute}
                aria-hidden
                className={cn(
                  'bg-border/60 absolute inset-x-0 h-px',
                  index === 0 && 'opacity-0',
                )}
                style={{ top: `${offsetFor(segments, minute) ?? 0}px` }}
              />
            ))}
            {day.blocks.map((block) => (
              <GridBlock
                key={`${block.jobId}-${block.at.toISOString()}`}
                block={block}
                top={offsetFor(segments, block.startMinute) ?? 0}
                locale={locale}
                color={colorOf(block.jobId)}
                name={nameOf(block.jobId)}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}

        {/* The breaks, drawn ACROSS the day columns rather than per column: the
            hours they stand for are missing from every day at once, and a
            per-column rule would read as something that happened on a day.
            They stop at the hour gutter (`left-12`) so the hour label that
            straddles the boundary underneath is not clipped by the band. */}
        {breaks.map((gap) => (
          <div
            key={gap.key}
            data-testid="timetable-break"
            className="bg-card absolute inset-x-0 left-12 flex items-center gap-2 px-2"
            style={{ top: `${gap.top}px`, height: `${BREAK_PX}px` }}
          >
            <span aria-hidden className="border-border flex-1 border-t border-dashed" />
            <span className="text-muted-foreground/80 shrink-0 text-[10px] uppercase tracking-wide">
              {t('timetable.gap', { hours: Math.round(gap.minutes / 60) })}
            </span>
            <span aria-hidden className="border-border flex-1 border-t border-dashed" />
          </div>
        ))}
      </div>
    </div>
  )
}

function GridBlock({
  block,
  top,
  locale,
  color,
  name,
  onSelect,
}: {
  block: TimetableBlock
  /** Pixels from the top of the body — the segment stack already folded in. */
  top: number
  locale: string
  color: string
  name: string
  onSelect: (jobId: string) => void
}): JSX.Element {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(block.at)
  const width = 100 / block.lanes
  return (
    <button
      type="button"
      onClick={() => onSelect(block.jobId)}
      title={`${time} · ${name}`}
      data-testid="timetable-block"
      className="focus-visible:ring-ring/60 absolute overflow-hidden rounded-[5px] border-l-[3px] px-1.5 py-0.5 text-left transition-shadow duration-quick ease-out hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
      style={{
        top: `${top + 1}px`,
        height: `${(BLOCK_MINUTES / 60) * HOUR_PX - 2}px`,
        left: `calc(${block.lane * width}% + 2px)`,
        width: `calc(${width}% - 4px)`,
        borderLeftColor: color,
        // A tint rather than the series colour itself: the label sits on this
        // surface, and the palette's own notes record that three of the eight
        // light steps do not clear 3:1 on a near-white ground. Ink stays
        // `--foreground`; the colour only groups.
        backgroundColor: `color-mix(in oklab, ${color} 16%, var(--card))`,
      }}
    >
      <span className="text-foreground block truncate text-[11px] font-medium leading-tight">
        {name}
      </span>
      <span className="text-muted-foreground block truncate text-[10px] leading-tight tabular-nums">
        {time}
      </span>
    </button>
  )
}

/**
 * The same week as a list. Below `md` only — seven columns cannot carry a name
 * at phone width, and a grid that cannot be read is worse than no grid.
 */
function Agenda({
  timetable,
  locale,
  colorOf,
  nameOf,
  emptyDayLabel,
  onSelect,
}: ShapeProps & { emptyDayLabel: string }): JSX.Element {
  const today = startOfDay(new Date())
  return (
    <ul className="flex flex-col gap-3 md:hidden" data-testid="timetable-agenda">
      {timetable.days.map((day) => {
        const isToday = startOfDay(day.date).getTime() === today.getTime()
        return (
          <li key={day.date.toISOString()}>
            <p
              className={cn(
                'text-xs font-medium',
                isToday ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {new Intl.DateTimeFormat(locale, {
                weekday: 'long',
                day: '2-digit',
                month: '2-digit',
              }).format(day.date)}
            </p>
            {day.blocks.length === 0 ? (
              <p className="text-muted-foreground/70 mt-1 text-xs">{emptyDayLabel}</p>
            ) : (
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {day.blocks.map((block) => (
                  <li key={`${block.jobId}-${block.at.toISOString()}`}>
                    <button
                      type="button"
                      onClick={() => onSelect(block.jobId)}
                      className="border-border bg-card focus-visible:ring-ring/60 flex w-full items-center gap-2 rounded-lg border border-l-[3px] px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2"
                      style={{ borderLeftColor: colorOf(block.jobId) }}
                    >
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {new Intl.DateTimeFormat(locale, {
                          hour: '2-digit',
                          minute: '2-digit',
                        }).format(block.at)}
                      </span>
                      <span className="text-foreground min-w-0 truncate text-sm">
                        {nameOf(block.jobId)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function startOfDay(date: Date): Date {
  const out = new Date(date)
  out.setHours(0, 0, 0, 0)
  return out
}

function formatHour(minute: number, locale: string): string {
  const reference = new Date(2024, 0, 1, Math.floor(minute / 60), minute % 60)
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(reference)
}

function formatWeekRange(weekStart: Date, locale: string): string {
  const weekEnd = addDays(weekStart, 6)
  const format = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' })
  return `${format.format(weekStart)} – ${format.format(weekEnd)}`
}
