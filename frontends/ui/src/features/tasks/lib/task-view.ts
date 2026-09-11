/**
 * One delegated task as the browser receives it — the wire shape of
 * `GET /api/projects/[id]/tasks`.
 *
 * Client-side, and deliberately not a re-export of the drizzle row: dates are
 * ISO strings here, the plan's prompt (which carries a skill's whole body)
 * never crosses, and neither does `filingDetail`, which the schema's own
 * comment marks operator-facing. The server projection
 * (`lib/tasks/list-projection.ts`) returns THIS type, which is what keeps the
 * two ends from drifting.
 */

import type { TaskKind, TaskReview, TaskStatus } from '@/lib/tasks/task-vocabulary'

export interface TaskWireRow {
  id: string
  kind: TaskKind
  /** The job's name at the time, or the delegation's own title. */
  title: string
  /** What the requester asked for, in their words. Null for a job-fired run. */
  goal: string | null
  status: TaskStatus
  /** How a person judged the result. Null until somebody did. */
  review: TaskReview | null
  /** The reviewer's words on a rejection. */
  reviewReason: string | null
  /** The document the result was filed as, when it was. */
  filedDocumentId: string | null
  /** The conversation an `output: 'chat'` task wrote into. */
  conversationId: string | null
  requesterUserId: string
  /** Their display name, or null when the directory cannot resolve the id. */
  requesterName: string | null
  createdAt: string
  finishedAt: string | null
  /** The sanitized, user-safe error the worker reported. */
  error: string | null
}
