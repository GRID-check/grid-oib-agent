/**
 * The task vocabularies, free of drizzle.
 *
 * `db/schema/tasks.ts` is where these belong by subject and the wrong place to
 * import them FROM: a client component that wants to label a status must not
 * drag the schema — and therefore the database — into the browser bundle
 * (`server-component-db-access.spec.ts` is what fails when it does). Same
 * arrangement as `documents/lifecycle-types.ts`: the tuples live here, the
 * schema imports them, and `@/lib/db/schema` re-exports so no existing caller
 * moves.
 */

/** Every kind a task row can be. See the schema for what each one means. */
export const TASK_KINDS = [
  'deep-research',
  'chat',
  'compliance_check',
  'einreichcheck',
  'document',
  'revision',
] as const
export type TaskKind = (typeof TASK_KINDS)[number]

/** The lifecycle. `queued` from creation until the worker reports. */
export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'interrupted'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** How a person judged the result. Null until somebody did. */
export const TASK_REVIEWS = ['accepted', 'rejected'] as const
export type TaskReview = (typeof TASK_REVIEWS)[number]
