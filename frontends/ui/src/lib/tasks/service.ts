/**
 * Tasks service — the durable unit of delegated work (ADR-0051).
 *
 * Owns the lifecycle of a task row from the moment a job fires to the moment
 * a person reviews the result:
 *
 *   fireJob ─▶ createTaskForRun ─▶ (worker) ─▶ completeTaskForRun ─▶ reviewTask
 *                                                    │
 *                                                    └─▶ fileAsRequester
 *
 * Two things here are the reason the row exists. `fileAsRequester` files a
 * finished run's report into the project AS THE PERSON WHO ASKED — resolved
 * from the pinned requester, never a service token — so a scheduled report no
 * longer expires unfiled. `previousDecisionsBlock` carries a reviewer's
 * rejection into the next run of the same job, which is the difference
 * between a cron line and delegation.
 */

import 'server-only'
import { ApiError, ConflictError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Job, JobRun, Task, TaskFilingStatus, TaskStatus } from '@/lib/db/schema'
import { fileResearchReport } from '@/lib/documents/research-report'
import * as repository from './repository'
import type { ReviewTaskInput } from './types'

export type TaskOutcomeStatus = 'success' | 'failure' | 'interrupted'

export interface TaskOutcome {
  status: TaskOutcomeStatus
  error?: string | null
  /** The finished report, when the worker has one to file. */
  report?: string | null
  cards?: unknown[] | null
}

const OUTCOME_TO_STATUS: Record<TaskOutcomeStatus, TaskStatus> = {
  success: 'succeeded',
  failure: 'failed',
  interrupted: 'interrupted',
}

/**
 * Record the attempt a job just made, as a task. Best effort by contract: the
 * run has already been submitted, and a task row that could not be written
 * must not turn into a run nobody hears about — the run history still has it.
 */
export async function createTaskForRun(job: Job, run: JobRun, firePrompt: string): Promise<Task | null> {
  if (run.status !== 'submitted' || !run.jobId) return null
  try {
    const task = await repository.insertTask({
      organizationId: job.organizationId,
      projectId: job.projectId,
      kind: job.output,
      title: job.name,
      plan: {
        prompt: firePrompt,
        skill: run.skillSnapshot,
        dataSources: job.dataSources ?? null,
      },
      requesterUserId: job.createdBy,
      requesterEmail: job.createdByEmail ?? null,
      status: 'running',
      startedAt: run.createdAt,
      jobId: job.id,
      jobRunId: run.id,
      backendJobId: run.jobId,
      conversationId: run.conversationId,
    })
    await recordAuditEvent({
      organizationId: job.organizationId,
      actor: { userId: job.createdBy, email: job.createdByEmail },
      action: 'task.created',
      targetType: 'task',
      targetId: task.id,
      metadata: { projectId: job.projectId, kind: job.output, jobId: job.id, trigger: run.trigger },
    })
    return task
  } catch (error) {
    console.error('[tasks] failed to record the task for run', run.id, error)
    return null
  }
}

/** The task the worker is reporting on. Platform-scope lookup; see the repository. */
export async function loadTaskForOutcome(backendJobId: string): Promise<Task | null> {
  return repository.findTaskByBackendJobId(backendJobId)
}

/**
 * Close the task with the worker's outcome and, for a finished deep-research
 * task, file its report as the requester. Never throws: the outcome route's
 * job is to tell the requester, and that must not wait on a filing.
 */
export async function completeTaskForRun(
  task: Task,
  outcome: TaskOutcome,
): Promise<{ task: Task; filed: { documentId: string; filename: string } | null }> {
  const status = OUTCOME_TO_STATUS[outcome.status]
  const closed =
    (await repository.updateTask(task.id, task.organizationId, {
      status,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    })) ?? task

  await recordAuditEvent({
    organizationId: task.organizationId,
    actor: { userId: task.requesterUserId, email: task.requesterEmail },
    action: 'task.completed',
    targetType: 'task',
    targetId: task.id,
    metadata: { projectId: task.projectId, kind: task.kind, status },
  })

  if (status !== 'succeeded' || task.kind !== 'deep-research' || !outcome.report) {
    return { task: closed, filed: null }
  }
  const filing = await fileAsRequester(closed, outcome.report, outcome.cards ?? undefined)
  const withFiling =
    (await repository.updateTask(task.id, task.organizationId, {
      filingStatus: filing.status,
      filingDetail: filing.detail,
      filedDocumentId: filing.filed?.documentId ?? null,
    })) ?? closed
  return { task: withFiling, filed: filing.filed }
}

interface FilingResult {
  status: TaskFilingStatus
  detail: string | null
  filed: { documentId: string; filename: string } | null
}

/**
 * File the report into the task's project as the pinned requester.
 *
 * Three outcomes, and the distinction is the point:
 *   - `filed`   — the same `fileResearchReport` the interactive report GET
 *                 calls, keyed on the same backend job id, so a person opening
 *                 the report later finds it already filed (migration 0064).
 *   - `refused` — the requester cannot file here today: left the
 *                 organization, lacks the permission, or the feature is off.
 *                 A permission the person does not hold is not one the
 *                 scheduler may borrow.
 *   - `failed`  — filing broke (a report over the PDF ceiling, a store error).
 * The detail is for the operator; the client sees the status.
 */
async function fileAsRequester(task: Task, report: string, cards?: unknown[]): Promise<FilingResult> {
  if (!task.backendJobId) return { status: 'failed', detail: 'task has no backend job id', filed: null }

  const session = await resolvePinnedRequesterSession({
    userId: task.requesterUserId,
    email: task.requesterEmail,
    organizationId: task.organizationId,
  })
  if (!session) {
    return { status: 'refused', detail: 'requester is no longer a member of the organization', filed: null }
  }

  try {
    const filed = await fileResearchReport({
      session,
      projectId: task.projectId,
      runId: task.backendJobId,
      report,
      cards,
    })
    return { status: 'filed', detail: null, filed: { documentId: filed.documentId, filename: filed.filename } }
  } catch (error) {
    // The authorization ladder answers a missing permission as 404 and a
    // switched-off feature as 403: both mean "not as this person, not today".
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return { status: 'refused', detail: `${error.name}: ${error.message}`.slice(0, 500), filed: null }
    }
    console.error('[tasks] filing the report failed for task', task.id, error)
    const name = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
    return { status: 'failed', detail: name.slice(0, 500), filed: null }
  }
}

/** A project's tasks, newest first. `project:view`, like the run history. */
export async function listTasks(session: AuthorizedSession, projectId: string): Promise<Task[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  return repository.listTasksInProject(projectId, session.organizationId)
}

/**
 * Record a person's judgement of a finished task. `project:edit`: the review
 * is a statement about the project's own record, made by somebody who may
 * change that record. A rejection with a reason reaches the next run of the
 * same job (`previousDecisionsBlock`).
 */
export async function reviewTask(
  session: AuthorizedSession,
  projectId: string,
  taskId: string,
  input: ReviewTaskInput,
  request?: Request,
): Promise<Task> {
  await requireProjectAccess(session, projectId, 'project:edit')
  const task = await repository.findTaskInProject(taskId, projectId, session.organizationId)
  if (!task) throw new NotFoundError('Task not found')
  if (task.status === 'queued' || task.status === 'running') {
    throw new ConflictError('A task can only be reviewed once it has finished')
  }

  const reason = input.reason?.trim() || null
  const reviewed = await repository.updateTask(task.id, session.organizationId, {
    review: input.decision,
    reviewReason: reason,
    reviewedBy: session.userId,
    reviewedAt: new Date(),
  })
  if (!reviewed) throw new NotFoundError('Task not found')

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'task.reviewed',
    targetType: 'task',
    targetId: task.id,
    metadata: { projectId, kind: task.kind, decision: input.decision, withReason: reason !== null },
    request,
  })
  return reviewed
}

/** The block's header, versioned like the memory channel's. */
export const PREVIOUS_DECISIONS_HEADER = 'PREVIOUS_DECISIONS v1'

/**
 * What earlier runs of this job were told "no" about, for the next one.
 *
 * Appended to the fire prompt, not to memory: a rejection of a report is a
 * decision about THIS job's output, and the person who made it expects the
 * next run to have read it. The reasons are the reviewer's own words, quoted
 * verbatim; the instruction around them is meta and says what a decision is,
 * not what the reviewer meant. Empty when nothing was rejected. Best effort:
 * a lookup failure yields no block, never a run that does not fire.
 */
export async function previousDecisionsBlock(job: Pick<Job, 'id' | 'organizationId'>): Promise<string> {
  let rejections: Array<{ reviewReason: string | null; reviewedAt: Date | null }>
  try {
    rejections = await repository.listRejectedReviewsForJob(job.id, job.organizationId)
  } catch (error) {
    console.warn('[tasks] could not load earlier decisions for job', job.id, error)
    return ''
  }
  const lines = rejections
    .filter((row): row is { reviewReason: string; reviewedAt: Date | null } => Boolean(row.reviewReason))
    .map((row) => {
      const when = row.reviewedAt ? row.reviewedAt.toISOString().slice(0, 10) : ''
      return `- [abgelehnt${when ? `, ${when}` : ''}] ${row.reviewReason}`
    })
  if (lines.length === 0) return ''
  return [
    `### ${PREVIOUS_DECISIONS_HEADER}`,
    'Frühere Ergebnisse dieses Auftrags wurden von einer Person geprüft und mit der',
    'folgenden Begründung abgelehnt. Eine Ablehnung ist eine Entscheidung, keine',
    'Frage: Berücksichtige sie in diesem Lauf, wiederhole nicht, was abgelehnt',
    'wurde, und sage im Ergebnis, wo du ihr gefolgt bist.',
    ...lines,
  ].join('\n')
}
