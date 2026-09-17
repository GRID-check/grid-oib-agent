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

/**
 * What makes a `task_definitions` row run (the collapsed model of jobs +
 * delegated tasks).
 *
 *   - `manual`   — never on its own; a person presses "Run now".
 *   - `once`     — fires exactly once. A delegated task is this with no
 *                  `due_at` (it is dispatched on creation); a due date makes it
 *                  a one-shot schedule, which the task wizard creates and the
 *                  scheduler claims like any other due row (0090). The due
 *                  date is therefore what tells the two apart, and what the
 *                  standing-task list filters on — filtering on the TRIGGER
 *                  would hide a one-shot from the list that created it.
 *   - `schedule` — a cron fires it again and again; `next_run_at` is live.
 */
export const DEFINITION_TRIGGERS = ['manual', 'once', 'schedule'] as const
export type DefinitionTrigger = (typeof DEFINITION_TRIGGERS)[number]

/**
 * How one `task_runs` row started.
 *
 * `delegated` is the run a person asked for in chat or from a review — the
 * trigger the old `tasks` row could not name because a delegated task had no
 * `job_runs` row to carry one.
 */
export const TASK_RUN_TRIGGERS = ['manual', 'schedule', 'delegated'] as const
export type TaskRunTrigger = (typeof TASK_RUN_TRIGGERS)[number]

/**
 * The merged run lifecycle: the worker's own terminal words, the submission's
 * (`skipped` / `error`), and the two active states.
 *
 * `skipped` and `error` are first-class because a fire that never reached the
 * agent is still an attempt a person must be able to see in their Aufgaben
 * list — the defect the collapse closes. `detail` from the old `job_runs` row
 * is folded into `error`, so a skip reason has one place to live.
 */
export const TASK_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'skipped',
  'error',
] as const
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number]

/**
 * The run is still in the worker's hands: nothing about it can be judged yet,
 * and it is the only state a cancel can reach. `queued` counts — a run stuck
 * before its first status transition would otherwise be un-cancellable while
 * still holding a slot (the same reason the backend cancels `SUBMITTED` jobs).
 */
export function isActiveTaskRunStatus(status: TaskRunStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** How a person judged the result. Null until somebody did. */
export const TASK_REVIEWS = ['accepted', 'rejected'] as const
export type TaskReview = (typeof TASK_REVIEWS)[number]
