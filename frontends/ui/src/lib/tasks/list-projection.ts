/**
 * The wire projection of a task listing — the one place a `tasks` row becomes
 * JSON.
 *
 * Stated rather than implied, for the reason `documents/list-projection.ts`
 * gives: `JSON.stringify` on a drizzle row hands `createdAt` over as an ISO
 * string, and the RSC boundary hands the same field over as a `Date`. One of
 * the two readers then gets `toISOString is not a function`.
 *
 * It also DROPS things, and the drops are the point. `plan.prompt` carries a
 * skill's whole body — the instruction the organization owns, not something a
 * project's task list needs — and `filingDetail` is marked operator-facing in
 * the schema's own comment. A projection that spread the row would ship both to
 * every viewer of a project.
 */

import 'server-only'
import type { TaskWireRow } from '@/features/tasks/lib/task-view'
import type { Task } from '@/lib/db/schema'

export function toTaskWireRow(task: Task, requesterName: string | null): TaskWireRow {
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    // The requester's own sentence, when there was one. A job-fired run has the
    // job's prompt and no goal, and the title is the job's name.
    goal: task.plan.goal?.trim() || null,
    status: task.status,
    review: task.review ?? null,
    reviewReason: task.reviewReason,
    filedDocumentId: task.filedDocumentId,
    conversationId: task.conversationId,
    requesterUserId: task.requesterUserId,
    // The DISPLAY NAME, resolved server-side through the directory every
    // collaboration surface in this tier resolves through. Not left to the
    // browser: the roster endpoint is `project:members:manage`, so a viewer
    // reading their own project's task list would have got a 403 for a byline.
    // `null` for an id the directory cannot resolve — a deactivated member —
    // rather than a raw `user_01…` at an architect.
    requesterName,
    createdAt: task.createdAt.toISOString(),
    finishedAt: task.finishedAt?.toISOString() ?? null,
    error: task.error,
  }
}
