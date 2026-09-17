/**
 * The wire contract of `POST /api/internal/tasks`.
 *
 * Its own module and NOT `server-only`, for the reason `lifecycle-types.ts` is
 * not: the schema has readers that are not the service — the route, the specs,
 * and the Python tool that has to know what the body looks like. Keeping it out
 * of the service means nothing here drags drizzle or a database connection into
 * a description of a request body.
 */

import { z } from 'zod'
import { DELEGATABLE_TASK_KINDS } from '@/lib/db/schema'

/**
 * Bound on the goal: it is a sentence a person typed, and it becomes a title.
 *
 * Here rather than in `./delegation`, which is `server-only`: the bound is part
 * of the CONTRACT, and a schema module that imported the service to learn its
 * own ceiling would drag the database into a description of a request body.
 * `delegation.ts` re-exports it, so the one place a caller looks is unchanged.
 */
export const TASK_GOAL_MAX_CHARS = 500

/**
 * `POST /api/internal/tasks` — the ONE machine entry point for delegation.
 *
 * A discriminated union on `op` with two members: `create`, which states a
 * standing intent and its first attempt, and `research`, which commissions ONE
 * run for a question the person just asked (ADR-0062). They are two verbs
 * because they leave different things behind — a definition the project keeps,
 * versus a single run with no cadence it never had — and one route because the
 * identity question is the same one, answered once.
 *
 * What a machine still may not do is JUDGE work: `reviewTask` is a session
 * route because a review is a person's statement about the project's own
 * record, and a machine that could accept its own output would close the loop
 * ADR-0051 exists to open.
 *
 * `projectId` is the caller's to name and is checked: the pinned session's
 * `requireProjectAccess` runs against it in `delegateTask`, so naming a project
 * the requester cannot reach is a 404 from the authorization ladder rather than
 * a task in somebody else's project.
 */
export const internalTaskRequestSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('create'),
      projectId: z.string().uuid(),
      kind: z.enum(DELEGATABLE_TASK_KINDS),
      /** What was asked, in the requester's own words. */
      goal: z.string().trim().min(1).max(TASK_GOAL_MAX_CHARS),
      /**
       * When it is wanted, as a date (`YYYY-MM-DD`) or a full ISO instant.
       *
       * A date and not a free-text „bis Freitag": the model resolves the phrase
       * against the turn's own date, and a string nothing can compare is a
       * deadline the scheduler will never enforce.
       */
      due: z.string().trim().min(4).max(40).optional(),
      /**
       * A recurring trigger, as a 5-field cron (`0 8 * * 1` = Mondays 08:00) —
       * the same shape the schedule builder writes and the scheduler claims.
       *
       * Cadence is what makes this the second trigger of ADR-0051's "a chat
       * handoff becomes another": without it the delegation is a `once`
       * definition and fires immediately; with it the definition is a
       * `schedule` and only the scheduler fires it. The requester must hold
       * `project:skills:manage` (the permissioned act is the recurrence, not
       * the asking).
       */
      cadence: z.string().trim().min(1).max(120).optional(),
      /** IANA zone the cadence is read in; UTC when absent. */
      cadenceTimezone: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('research'),
      projectId: z.string().uuid(),
      /**
       * The question the run is to answer, as the turn restated it. It IS the
       * run's prompt, so it is bounded like a goal and carries no markup: a
       * question nobody typed this way would be a run about something else.
       */
      question: z.string().trim().min(1).max(TASK_GOAL_MAX_CHARS),
    })
    .strict(),
])

export type InternalTaskRequest = z.infer<typeof internalTaskRequestSchema>

/** What the caller gets back: enough to tell the reader what was queued. */
export const internalTaskResponseSchema = z.object({
  taskId: z.string(),
  kind: z.enum(DELEGATABLE_TASK_KINDS),
  title: z.string(),
  status: z.string(),
  /** The thread the run writes into, when it could be created. */
  conversationId: z.string().nullable(),
  /** ISO instant, or null when the caller named no deadline. */
  dueAt: z.string().nullable(),
  /** True when a cadence was given: a standing definition, no run yet. */
  scheduled: z.boolean(),
  /** The first fire the scheduler will claim, for a scheduled definition. */
  nextRunAt: z.string().nullable(),
})

export type InternalTaskResponse = z.infer<typeof internalTaskResponseSchema>

/**
 * What the `research` op answers with: where the run narrates itself.
 *
 * A different shape from `create`'s on purpose — there is no definition, no
 * cadence and no deadline to report, and padding those with nulls would invite
 * a reader to look for them. The two ids are what the turn needs to point at
 * the block it just commissioned.
 */
export const internalResearchResponseSchema = z.object({
  runId: z.string(),
  /** The run's message in the thread, or null when it could not be minted. */
  runMessageId: z.string().nullable(),
  conversationId: z.string(),
  /** `running` when the worker took it, `failed` when it refused. */
  status: z.string(),
})

export type InternalResearchResponse = z.infer<typeof internalResearchResponseSchema>

/**
 * The deadline, as an instant, or `null` when the string is not one.
 *
 * A bare `YYYY-MM-DD` is read as the END of that day in UTC, because „bis
 * Freitag" means the whole of Friday and midnight-at-the-start would make every
 * date-only deadline a day early. An unparseable string is dropped rather than
 * refused: a task with no deadline still does the work, and refusing the whole
 * delegation over a date the model mistyped would lose the work to fix a field
 * nothing enforces yet.
 */
export function parseTaskDue(due: string | undefined): Date | null {
  if (!due) return null
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due)
  const parsed = new Date(dateOnly ? `${due}T23:59:59.999Z` : due)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
