/**
 * One delegated task as the browser receives it — the wire shape of
 * `GET /api/projects/[id]/tasks` — plus the three decisions the Tasks surface
 * makes about a row, kept here rather than in JSX so they are one answer with
 * a spec beside it: where its result lives, which filter it falls under, and
 * how recent it is.
 *
 * Client-side, and deliberately not a re-export of the drizzle row: dates are
 * ISO strings here, the plan's prompt (which carries a skill's whole body)
 * never crosses, and neither does `filingDetail`, which the schema's own
 * comment marks operator-facing. The server projection
 * (`lib/tasks/list-projection.ts`) returns THIS type, which is what keeps the
 * two ends from drifting.
 */

import type { RunStatus } from '@/lib/runs/run-ledger-types'
import type {
  TaskKind,
  TaskReview,
  TaskRunStatus,
  TaskRunTrigger,
} from '@/lib/tasks/task-vocabulary'

export interface TaskWireRow {
  id: string
  kind: TaskKind
  /** The schedule's name at the time, or the delegation's own title. */
  title: string
  /** What the requester asked for, in their words. Null for a scheduled run. */
  goal: string | null
  status: TaskRunStatus
  /** How a person judged the result. Null until somebody did. */
  review: TaskReview | null
  /** The reviewer's words on a rejection. */
  reviewReason: string | null
  /** The document the result was filed as, when it was. */
  filedDocumentId: string | null
  /** The conversation an `output: 'chat'` task wrote into. */
  conversationId: string | null
  /**
   * The message this run narrates itself in, inside that conversation
   * (ADR-0062). Null for every run submitted before run messages existed, and
   * for one whose message could not be minted — those rows still open their
   * thread, they just land at the bottom of it rather than at the run.
   */
  runMessageId: string | null
  /**
   * The backend async-job id — the id the agent's job store knows this run by.
   * Null for a task whose submission never reached the agent.
   *
   * It was sent so „Bericht öffnen" could be built from it for a run that filed
   * nothing and minted no conversation. That link was `?job=<id>`, whose only
   * reader was the deep-research side panel, and a run now tells its own story
   * in its own message (ADR-0062) — so no destination on this surface is built
   * from this field any more. It stays on the wire because it is how a run is
   * named outside this tier (the worker reports an outcome by it); the
   * projection that fills it, `lib/tasks/list-projection.ts`, is where to drop
   * it when nothing needs the handle either.
   */
  backendJobId: string | null
  /**
   * How this run started — `schedule` for a timer, `manual` for a "Jetzt
   * ausführen", `delegated` for an ask in chat or a reviewer's send-back.
   *
   * Sent so the drawer can offer „als Zeitplan speichern" on work that is not
   * already recurring. Deliberately the TRIGGER and not the definition id: since
   * migration 0086 a delegated task is a `task_definitions` row too, so "has a
   * definition" stopped meaning "came from a schedule".
   */
  trigger: TaskRunTrigger
  requesterUserId: string
  /** Their display name, or null when the directory cannot resolve the id. */
  requesterName: string | null
  createdAt: string
  finishedAt: string | null
  /** The sanitized, user-safe error the worker reported. */
  error: string | null
  /**
   * What the run did, read off its message's ledger (ADR-0062): the compact
   * run line a card shows under its title — the same glyph, word and tallies
   * as the block's header in the thread. Filled for every row on the page that
   * has a run message; absent or null otherwise, and the card shows no line.
   */
  runSummary?: TaskRunSummary | null
}

/** The three facts the card's run line needs from a ledger; nothing a block would. */
export interface TaskRunSummary {
  status: RunStatus
  rounds: number
  docs: number
}

/**
 * Submission words the wire may still carry, mapped to planner words.
 *
 * The task vocabulary talks about WORK (`queued`/`running`/…), but a status
 * that names the submission (`submitted`, `pending`) can still reach this
 * surface — and the row would then render the raw token to an architect.
 * Both mean "accepted, not started", which is exactly what `queued` says, so
 * they are folded there. Backend enums are untouched: this maps at the view
 * boundary only. Anything else passes through unchanged — an unknown status
 * is rendered as before, not reworded into a claim about the work.
 */
const SUBMISSION_STATUS_TO_PLANNER: Record<string, TaskRunStatus> = {
  submitted: 'queued',
  pending: 'queued',
}

export const normalizeTaskStatus = (status: string): TaskRunStatus =>
  SUBMISSION_STATUS_TO_PLANNER[status.trim().toLowerCase()] ?? (status as TaskRunStatus)

/** The statuses that mean the work has not finished. */
const ACTIVE_STATUSES: ReadonlySet<TaskRunStatus> = new Set(['queued', 'running'])

/** The statuses that mean somebody has to look. */
const BROKEN_STATUSES: ReadonlySet<TaskRunStatus> = new Set(['failed', 'error'])

export function isActiveTask(task: TaskWireRow): boolean {
  return ACTIVE_STATUSES.has(task.status)
}

/**
 * Where this task's result IS, as one destination.
 *
 * Two places a result can live, in the order a person wants them:
 *
 *   1. the **document** it was filed as, which is the durable artefact and the
 *      thing the rest of the product treats as real;
 *   2. the **conversation** the run was commissioned in, opened at the run's own
 *      message — which since ADR-0062 holds the report, the account of the work
 *      and the failure alike, and can be read and continued.
 *
 * There was a third, the run's report by backend job id (`?job=…`), with
 * `&tab=thinking` for a failure and `&tab=tasks` while the work was still
 * going. That URL had exactly one reader, the deep-research side panel, and
 * with the panel gone it lands on the chat page and silently does nothing — a
 * link that looks alive and is not, which is worse than none. The run's message
 * replaces all three: it IS the report when the run filed nothing, and it is
 * what it tried when the run broke.
 *
 * Null when the task genuinely has nowhere to point — no filed document and no
 * thread. Honest, and no worse than a link to nothing.
 */
export type TaskResultTarget = { kind: 'document' | 'conversation'; href: string } | null

/**
 * The query (and anchor) that opens a task's thread AT its run.
 *
 * `?session=` selects the conversation and `#message-<id>` scrolls to the
 * message and marks it — the shape the inbox links already use
 * (`lib/sharing/registry.ts`, `useMessageAnchor`), reused rather than reinvented
 * so one mechanism carries every deep link into a thread. `?run=` rides along
 * because the run id is the public key of a run: a surface that has only that
 * resolves the rest itself (`GET /api/projects/[id]/runs/[runId]`).
 *
 * A row with no run message gets the plain `?session=` it always got.
 */
function conversationQuery(task: TaskWireRow): string {
  const session = `session=${encodeURIComponent(task.conversationId ?? '')}`
  if (!task.runMessageId) return session
  return `${session}&run=${encodeURIComponent(task.id)}#message-${encodeURIComponent(task.runMessageId)}`
}

/**
 * The thread at this run, or null when the task never minted one.
 *
 * A SECOND destination beside `taskResultTarget`, and deliberately not folded
 * into it: the result answers „what came out", the thread answers „how it got
 * there", and a run that filed a document has both. `taskResultTarget` ranks
 * the document first and would otherwise hide the account of the work behind
 * the artefact — which is the one thing the run block exists to show.
 */
export function taskThreadHref(projectId: string, task: TaskWireRow): string | null {
  if (!task.conversationId) return null
  return `/app/projects/${encodeURIComponent(projectId)}/chat?${conversationQuery(task)}`
}

export function taskResultTarget(projectId: string, task: TaskWireRow): TaskResultTarget {
  const project = encodeURIComponent(projectId)
  if (task.filedDocumentId) {
    return {
      kind: 'document',
      href: `/app/projects/${project}/files?doc=${encodeURIComponent(task.filedDocumentId)}`,
    }
  }
  // The thread AT the run, from the one builder that knows that shape, so the
  // result link and „Im Verlauf öffnen" can never point at different messages.
  const thread = taskThreadHref(projectId, task)
  return thread ? { kind: 'conversation', href: thread } : null
}

/**
 * The four questions the filter row asks.
 *
 *   - `all`        — everything, newest first.
 *   - `active`     — still going. The only rows that will change on their own.
 *   - `unreviewed` — finished, and nobody has said whether it was any good.
 *   - `failed`     — broken, and somebody has to look.
 *
 * `unreviewed` is the one worth having and the reason this row exists at all.
 * A finished task nobody has judged is an OPEN LOOP: the work is done but the
 * decision is not, and an open loop that is invisible is one that never closes.
 * Everything else here is a convenience; this one is the surface's job.
 *
 * `interrupted` and `skipped` are in none of the three narrow filters on
 * purpose. Both mean a person or a policy stopped the work deliberately —
 * there is nothing to review and nothing broken — so they appear under `all`
 * and nowhere else, rather than padding the list a person opened to find real
 * failures.
 */
export const TASK_FILTERS = ['all', 'active', 'unreviewed', 'failed'] as const
export type TaskFilter = (typeof TASK_FILTERS)[number]

export function matchesFilter(task: TaskWireRow, filter: TaskFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return isActiveTask(task)
    case 'unreviewed':
      return task.status === 'succeeded' && task.review === null
    case 'failed':
      return BROKEN_STATUSES.has(task.status)
  }
}

/** How many rows each filter would show, for the counts on the filter row. */
export function filterCounts(tasks: readonly TaskWireRow[]): Record<TaskFilter, number> {
  const counts = { all: 0, active: 0, unreviewed: 0, failed: 0 }
  for (const task of tasks) {
    for (const filter of TASK_FILTERS) {
      if (matchesFilter(task, filter)) counts[filter] += 1
    }
  }
  return counts
}

/**
 * Recency buckets, so a long list reads as a timeline instead of a wall.
 *
 * Relative rather than by calendar date: "Heute", "Gestern", "Diese Woche",
 * "Früher" is how a person remembers when they asked for something, and it
 * cannot degenerate into forty groups of one the way a per-day grouping does
 * on a project that delegates steadily.
 */
export const TASK_BUCKETS = ['today', 'yesterday', 'week', 'earlier'] as const
export type TaskBucket = (typeof TASK_BUCKETS)[number]

export interface TaskGroup {
  bucket: TaskBucket
  tasks: TaskWireRow[]
}

export function bucketFor(createdAt: string, now: Date): TaskBucket {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) return 'earlier'
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (created >= startOfToday) return 'today'
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  if (created >= startOfYesterday) return 'yesterday'
  const startOfWindow = new Date(startOfToday)
  startOfWindow.setDate(startOfWindow.getDate() - 7)
  return created >= startOfWindow ? 'week' : 'earlier'
}

/**
 * The rows grouped into recency buckets, newest bucket first and empty buckets
 * dropped. Order WITHIN a bucket is the order the server sent — the list is
 * already newest-first, and re-sorting here would be a second opinion about
 * which of two identical timestamps came first.
 */
export function groupByRecency(tasks: readonly TaskWireRow[], now: Date = new Date()): TaskGroup[] {
  const groups = new Map<TaskBucket, TaskWireRow[]>()
  for (const task of tasks) {
    const bucket = bucketFor(task.createdAt, now)
    const existing = groups.get(bucket)
    if (existing) existing.push(task)
    else groups.set(bucket, [task])
  }
  return TASK_BUCKETS.filter((bucket) => groups.has(bucket)).map((bucket) => ({
    bucket,
    tasks: groups.get(bucket) ?? [],
  }))
}
