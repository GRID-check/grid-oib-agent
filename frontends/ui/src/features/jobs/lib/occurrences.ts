/**
 * When a schedule actually fires — expanded from cron, in real instants.
 *
 * The Zeitplan surface asks a question a cron string cannot answer by being
 * read: *when does this next happen, and what else happens around it*. That is
 * calendar arithmetic over DST boundaries in a per-schedule IANA zone, which
 * is somebody else's domain — so it is `cron-parser`, the same library the BFF
 * validates and advances schedules with (`lib/jobs/schedule.ts`). One expander,
 * two tiers, no second interpretation of a cron field.
 *
 * `cron-parser` is loaded through a dynamic `import()` and never at module
 * scope. It pulls in luxon (~70 kB) for the timezone maths, and the Automation
 * route must not carry that for the two tabs that never open a timetable —
 * Next.js code-splits per ROUTE, not per tab, so a static import here would
 * land in the chunk every reader of the section downloads. The loader is
 * memoized, so the cost is paid once per session and only by a reader who
 * opened Zeitplan.
 *
 * Every returned instant is absolute. A schedule's own `scheduleTimezone`
 * decides WHEN it fires; the grid renders in the READER's local zone, so two
 * schedules in Vienna and New York land where they truly collide instead of
 * where their cron strings look alike.
 */

/** One firing of one schedule. */
export interface Occurrence {
  /** The schedule this firing belongs to (`Job.id`). */
  jobId: string
  /** The absolute instant it fires at. */
  at: Date
}

type CronModule = typeof import('cron-parser')

let parserPromise: Promise<CronModule> | null = null

/** The memoized `cron-parser` load. See the module docstring for why it is lazy. */
function loadCronParser(): Promise<CronModule> {
  parserPromise ??= import('cron-parser')
  return parserPromise
}

/**
 * How many firings one schedule may contribute to a window.
 *
 * An hourly cron produces 168 firings a week, and a `* * * * *` one produces
 * 10 080. Neither is a timetable — they are a wall — and expanding them is
 * wasted work before it is unreadable paint. The cap is per SCHEDULE so one
 * dense row cannot starve the others out of the window, and the caller is told
 * it was reached (`truncated`) rather than left to infer it from a round
 * number.
 */
const PER_SCHEDULE_CAP = 96

/** A parsed task as the expander needs it. */
export interface ScheduleSpec {
  id: string
  cron: string | null
  timezone: string
  /**
   * When a one-shot is due. A task has a cron or a due date, never both, and
   * the week grid places either — the timetable answers "what is happening
   * this week", and a task due on Thursday is one of the most important
   * answers it has. Null on a recurring or manual task.
   */
  dueAt?: Date | null
  /** A paused task contributes nothing: it is not going to happen. */
  enabled: boolean
}

export interface ExpansionResult {
  occurrences: Occurrence[]
  /** Schedule ids whose firings were cut short by {@link PER_SCHEDULE_CAP}. */
  truncated: string[]
  /** Schedule ids whose cron the parser rejected — shown, never swallowed. */
  invalid: string[]
}

/**
 * Every firing of every schedule inside `[from, to)`, oldest first.
 *
 * Rejects nothing quietly: a cron the parser cannot read is reported in
 * `invalid` so the surface can say which schedule it cannot place, rather than
 * drawing a timetable that is silently missing a row.
 */
export async function expandWindow(
  schedules: readonly ScheduleSpec[],
  from: Date,
  to: Date,
): Promise<ExpansionResult> {
  const { CronExpressionParser } = await loadCronParser()
  const occurrences: Occurrence[] = []
  const truncated: string[] = []
  const invalid: string[] = []

  for (const schedule of schedules) {
    if (!schedule.enabled) continue

    // A one-shot is its own occurrence list, of length one. No parser, no cap,
    // and no `invalid` — there is no expression to be wrong about.
    if (!schedule.cron) {
      if (schedule.dueAt && schedule.dueAt >= from && schedule.dueAt < to) {
        occurrences.push({ jobId: schedule.id, at: schedule.dueAt })
      }
      continue
    }
    let interval: ReturnType<typeof CronExpressionParser.parse>
    try {
      interval = CronExpressionParser.parse(schedule.cron, {
        tz: schedule.timezone,
        // `currentDate` is EXCLUSIVE in cron-parser, so a firing exactly on the
        // window's left edge would be dropped. One millisecond back keeps a
        // Monday-00:00 schedule inside the Monday-00:00 week.
        currentDate: new Date(from.getTime() - 1),
      })
    } catch {
      invalid.push(schedule.id)
      continue
    }

    for (let taken = 0; taken < PER_SCHEDULE_CAP; taken += 1) {
      const next = nextOrNull(interval)
      if (!next || next.getTime() >= to.getTime()) break
      occurrences.push({ jobId: schedule.id, at: next })
      if (taken === PER_SCHEDULE_CAP - 1) truncated.push(schedule.id)
    }
  }

  occurrences.sort((a, b) => a.at.getTime() - b.at.getTime())
  return { occurrences, truncated, invalid }
}

/**
 * The next `count` firings of one schedule, from `after`.
 *
 * The wizard's schedule step and the schedule drawer both show these: a cron
 * expression is a claim nobody can check by reading it, and three real dates
 * turn it into one they can. Returns fewer than `count` — or none — when the
 * expression is finite or unreadable, which the caller renders as "no upcoming
 * run" rather than as an error.
 */
export async function nextOccurrences(
  cron: string,
  timezone: string,
  count: number,
  after: Date = new Date(),
): Promise<Date[]> {
  const { CronExpressionParser } = await loadCronParser()
  let interval: ReturnType<typeof CronExpressionParser.parse>
  try {
    interval = CronExpressionParser.parse(cron, { tz: timezone, currentDate: after })
  } catch {
    return []
  }
  const out: Date[] = []
  for (let taken = 0; taken < count; taken += 1) {
    const next = nextOrNull(interval)
    if (!next) break
    out.push(next)
  }
  return out
}

/**
 * One step of an interval, or null once it is exhausted.
 *
 * `next()` THROWS at the end of a finite expression (a cron naming a month
 * that has passed), which is a normal outcome here and not an error: the
 * schedule simply has nothing more to fire. Converting it to null keeps the
 * two loops above free of try/catch in their bodies.
 */
function nextOrNull(interval: { next: () => { toDate: () => Date } }): Date | null {
  try {
    return interval.next().toDate()
  } catch {
    return null
  }
}
