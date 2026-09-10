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
 * A discriminated union on `op` with exactly one member, deliberately: the
 * document-versions route's op set is derived from the lifecycle's `actor`
 * field, and this one is `create` and nothing else because there is no second
 * verb a machine may reach. Reviewing a task is a person's act
 * (`POST /api/projects/[id]/tasks/[taskId]/review`, a session route), and
 * cancelling one is not built. Writing the union out now means the second verb,
 * if it ever exists, is a member here and a branch in the route rather than a
 * second route with a second identity check.
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
})

export type InternalTaskResponse = z.infer<typeof internalTaskResponseSchema>

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
