/**
 * Run lifecycle service — one attempt from submission to review, over
 * `task_runs` (the collapsed model, migration 0086).
 *
 *   fireJob ─▶ task_runs (running) ─▶ (worker) ─▶ recordRunOutcome ─▶ reviewTask
 *                                                        │
 *                                                        └─▶ fileAsRequester
 *
 * Two things here are the reason the row exists. `fileAsRequester` files a
 * finished run's report into the project AS THE PERSON WHO ASKED — resolved
 * from the pinned requester, never a service token — so a scheduled report no
 * longer expires unfiled. `previousDecisionsBlock` carries a reviewer's
 * rejection into the next run of the same definition, which is the difference
 * between a cron line and delegation.
 */

import 'server-only'
import { ApiError, ConflictError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { InboxItemType, TaskKind, TaskRun, TaskRunStatus } from '@/lib/db/schema'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import {
  replaceVersionContent,
  transitionDocumentVersion,
} from '@/lib/documents/lifecycle'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { openDraftForRevision } from '@/lib/documents/revision'
import { fileResearchReport } from '@/lib/documents/research-report'
import { resolvePeople } from '@/lib/sharing/directory'
import type { TaskWireRow } from '@/features/tasks/lib/task-view'
import { loadRunSummaries, toTaskWireRow } from './list-projection'
import * as repository from './repository'
import { isActiveTaskRunStatus } from './task-vocabulary'
import type { ReviewTaskInput } from './types'

export type TaskOutcomeStatus = 'success' | 'failure' | 'interrupted'
export type { TaskOutcomeStatus as JobOutcomeStatus }

export interface TaskOutcome {
  status: TaskOutcomeStatus
  error?: string | null
  /** The finished report, when the worker has one to file. */
  report?: string | null
  cards?: unknown[] | null
}

const OUTCOME_TO_STATUS: Record<TaskOutcomeStatus, TaskRunStatus> = {
  success: 'succeeded',
  failure: 'failed',
  interrupted: 'interrupted',
}

/** The run the worker is reporting on. Platform-scope lookup; see the repository. */
export async function loadRunForOutcome(backendJobId: string): Promise<TaskRun | null> {
  return repository.findRunByBackendJobId(backendJobId)
}

/**
 * Close the run with the worker's outcome and, for a finished deep-research
 * run, file its report as the requester. Never throws: the outcome route's job
 * is to tell the requester, and that must not wait on a filing.
 */
export async function completeRunForOutcome(
  run: TaskRun,
  outcome: TaskOutcome,
): Promise<{ run: TaskRun; filed: { documentId: string; filename: string } | null }> {
  const status = OUTCOME_TO_STATUS[outcome.status]
  const closed =
    (await repository.updateRun(run.id, run.organizationId, {
      status,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    })) ?? run

  await recordAuditEvent({
    organizationId: run.organizationId,
    actor: { userId: run.requesterUserId, email: run.requesterEmail },
    action: 'task.completed',
    targetType: 'task',
    targetId: run.id,
    metadata: { projectId: run.projectId, kind: run.kind, status },
  })

  if (status !== 'succeeded' || !outcome.report || !FILES_ITS_RESULT[run.kind]) {
    return { run: closed, filed: null }
  }
  const filing = await fileAsRequester(closed, outcome.report, outcome.cards ?? undefined)
  const withFiling =
    (await repository.updateRun(run.id, run.organizationId, {
      filingStatus: filing.status,
      filingDetail: filing.detail,
      filedDocumentId: filing.filed?.documentId ?? null,
    })) ?? closed
  return { run: withFiling, filed: filing.filed }
}

/**
 * Which kinds leave a DOCUMENT behind, and which leave an answer.
 *
 * A `Record<TaskKind, boolean>` and not an `if`, for the reason the producer
 * map in `documents/generated.ts` is one: it is exhaustive by construction, so
 * the next kind is a compile error here rather than a silent decision that its
 * result is not worth filing.
 *
 * `compliance_check` and `einreichcheck` answer INTO the conversation the run
 * wrote — that is what an `output: 'chat'` run is — and filing their prose as a
 * second document would put a copy of the thread in Berichte. `chat` is the
 * same thing arriving from a definition.
 */
const FILES_ITS_RESULT: Record<TaskKind, boolean> = {
  'deep-research': true,
  chat: false,
  compliance_check: false,
  einreichcheck: false,
  document: true,
  revision: true,
}

interface FilingResult {
  status: 'filed' | 'refused' | 'failed'
  detail: string | null
  filed: { documentId: string; filename: string } | null
}

/**
 * File the report into the run's project as the pinned requester.
 *
 * Three outcomes, and the distinction is the point:
 *   - `filed`   — the same `fileResearchReport` the interactive report GET
 *                 calls, keyed on the same backend job id, so a person opening
 *                 the report later finds it already filed (migration 0064).
 *   - `refused` — the requester cannot file here today: left the organization,
 *                 lacks the permission, or the feature is off.
 *   - `failed`  — filing broke (a report over the PDF ceiling, a store error).
 * The detail is for the operator; the client sees the status.
 */
async function fileAsRequester(
  run: TaskRun,
  report: string,
  cards?: unknown[],
): Promise<FilingResult> {
  if (!run.backendJobId) return { status: 'failed', detail: 'run has no backend job id', filed: null }

  const session = await resolvePinnedRequesterSession({
    userId: run.requesterUserId,
    email: run.requesterEmail,
    organizationId: run.organizationId,
  })
  if (!session) {
    return { status: 'refused', detail: 'requester is no longer a member of the organization', filed: null }
  }

  try {
    const filed = await fileResultFor(run, session, report, cards)
    return { status: 'filed', detail: null, filed }
  } catch (error) {
    // The authorization ladder answers a missing permission as 404 and a
    // switched-off feature as 403: both mean "not as this person, not today".
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return { status: 'refused', detail: `${error.name}: ${error.message}`.slice(0, 500), filed: null }
    }
    console.error('[runs] filing the report failed for run', run.id, error)
    const name = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
    return { status: 'failed', detail: name.slice(0, 500), filed: null }
  }
}

/**
 * The document one finished run leaves behind, by kind.
 *
 * Three producers, one seam: whichever runs, the write happens in the pinned
 * requester's own session through the SAME lifecycle service a person's own
 * filing goes through (ADR-0055). Nothing here writes a row itself.
 */
async function fileResultFor(
  run: TaskRun,
  session: AuthorizedSession,
  report: string,
  cards?: unknown[],
): Promise<{ documentId: string; filename: string }> {
  if (run.kind === 'deep-research') {
    const filed = await fileResearchReport({
      session,
      projectId: run.projectId,
      // Non-null by the guard in `fileAsRequester`.
      runId: run.backendJobId as string,
      report,
      cards,
    })
    return { documentId: filed.documentId, filename: filed.filename }
  }

  if (run.kind === 'revision') {
    const subject = run.plan.subject
    if (!subject) throw new UnprocessableError('A revision run carries no version to revise')
    const draft = await openDraftForRevision(session, subject.documentId)
    const replaced = await replaceVersionContent(
      session,
      subject.documentId,
      draft.version.id,
      report,
      draft.version.contentHash ?? undefined,
      // A run is not a person, on both halves of the filing. `update` and
      // `submit` are `either` rows so nothing is refused today — and that is
      // exactly why the flag has to be right.
      { actingHuman: false },
    )
    await transitionDocumentVersion(session, subject.documentId, replaced.id, 'submit', {
      // Back to the person who asked for the changes: they are the one waiting.
      reviewerUserIds: draft.reviewers,
      actingHuman: false,
    })
    return { documentId: subject.documentId, filename: draft.filename }
  }

  // `document`: a new item, version 1, submitted to the requester.
  const filed = await fileAgentDocumentDraft({
    session,
    projectId: run.projectId,
    // The run's own id, so a retried outcome updates rather than duplicates.
    ref: `task-${run.id}`,
    title: run.plan.goal?.trim() || run.title,
    content: report,
    actingHuman: false,
  })
  if (!filed.alreadyFiled) {
    await transitionDocumentVersion(session, filed.documentId, filed.version.id, 'submit', {
      reviewerUserIds: [run.requesterUserId],
      actingHuman: false,
    })
  }
  const document = await findDocumentInOrg(filed.documentId, session.organizationId)
  return { documentId: filed.documentId, filename: document?.filename ?? `task-${run.id}` }
}

/**
 * The ONE outcome recorder: close the run, file as the requester, tell them it
 * ended. Replaces the two recorders (`recordJobOutcome` for a run found via
 * `job_runs`, `recordTaskOutcome` for a delegated task) whose only difference
 * was which lookup found the row — the row is one table now.
 *
 * The inbox type is the existing `job.completed` / `job.failed` pair: the
 * payload already carries the ids, and a second type would be a second
 * presentation for a row that says the same thing. (`job.waiting`, the third
 * of the family, is emitted where the ledger turns to `wartet` —
 * `lib/runs/service.ts` — because that is the only tier that sees it.)
 * `actorUserId: null` because the work was Piloti's, and because
 * `emitInboxItems` drops a row whose actor is its recipient.
 *
 * Idempotent: the unique `(recipient, group_key)` upsert folds a retried report
 * into the existing row.
 */
export async function recordRunOutcome(
  run: TaskRun,
  outcome: TaskOutcome,
): Promise<{ notified: boolean; filed: { documentId: string; filename: string } | null }> {
  const completed = await completeRunForOutcome(run, outcome)

  const type: InboxItemType = outcome.status === 'success' ? 'job.completed' : 'job.failed'
  const anchor = run.backendJobId ?? run.id
  const emitted = await emitInboxItems([
    {
      organizationId: run.organizationId,
      recipientUserId: run.requesterUserId,
      type,
      resourceType: 'project',
      resourceId: run.projectId,
      anchorId: anchor,
      actorUserId: null,
      groupKey: inboxGroupKey(type, 'project', run.projectId, anchor),
      payload: {
        subject: run.title,
        status: outcome.status,
        error: outcome.error ?? null,
        jobId: run.definitionId,
        runId: run.id,
        conversationId: run.conversationId,
        // With the message, the row lands ON the run block in its thread
        // (ADR-0062) rather than in the task drawer; null for a run submitted
        // before run messages existed, and the drawer is the fallback.
        runMessageId: run.runMessageId,
        taskId: run.id,
        filedDocumentId: completed.filed?.documentId ?? null,
        filedFilename: completed.filed?.filename ?? null,
      },
    },
  ])
  return { notified: emitted > 0, filed: completed.filed }
}

/** A project's runs, newest first. `project:view`, like the definition list. */
export async function listTasks(session: AuthorizedSession, projectId: string): Promise<TaskRun[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  return repository.listRunsInProject(projectId, session.organizationId)
}

/**
 * The same listing, projected for the wire and with the requesters NAMED.
 *
 * The name resolution is here and not in the browser because the roster
 * endpoint is `project:members:manage`: a `project:view` member reading their
 * own project's task list would have got a 403 for a byline. `resolvePeople` is
 * the one place this tier turns a user id into a name.
 */
export async function listTaskViews(
  session: AuthorizedSession,
  projectId: string,
): Promise<TaskWireRow[]> {
  const runs = await listTasks(session, projectId)
  if (runs.length === 0) return []
  const [people, summaries] = await Promise.all([
    resolvePeople(session.organizationId, [...new Set(runs.map((run) => run.requesterUserId))]),
    // What each ACTIVE run is doing, off its message's ledger — one bounded
    // query for the page (`list-projection.ts`).
    loadRunSummaries(runs),
  ])
  return runs.map((run) =>
    toTaskWireRow(run, people.get(run.requesterUserId)?.name ?? null, summaries.get(run.id) ?? null),
  )
}

/**
 * Record a person's judgement of a finished run. `project:edit`: the review is
 * a statement about the project's own record, made by somebody who may change
 * that record. A rejection with a reason reaches the next run of the same
 * definition (`previousDecisionsBlock`).
 */
export async function reviewTask(
  session: AuthorizedSession,
  projectId: string,
  taskId: string,
  input: ReviewTaskInput,
  request?: Request,
): Promise<TaskRun> {
  await requireProjectAccess(session, projectId, 'project:edit')
  const run = await repository.findRunInProject(taskId, projectId, session.organizationId)
  if (!run) throw new NotFoundError('Task not found')
  if (isActiveTaskRunStatus(run.status)) {
    throw new ConflictError('A task can only be reviewed once it has finished')
  }

  const reason = input.reason?.trim() || null
  const reviewed = await repository.updateRun(run.id, session.organizationId, {
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
    targetId: run.id,
    metadata: { projectId, kind: run.kind, decision: input.decision, withReason: reason !== null },
    request,
  })
  return reviewed
}

/** The block's header, versioned like the memory channel's. */
export const PREVIOUS_DECISIONS_HEADER = 'PREVIOUS_DECISIONS v1'

/**
 * What earlier runs of this definition were told "no" about, for the next one.
 *
 * Appended to the fire prompt, not to memory: a rejection of a report is a
 * decision about THIS definition's output, and the person who made it expects
 * the next run to have read it. The reasons are the reviewer's own words,
 * quoted verbatim. Best effort: a lookup failure yields no block, never a run
 * that does not fire.
 */
export async function previousDecisionsBlock(
  definition: Pick<TaskRun, 'definitionId' | 'organizationId'> | { id: string; organizationId: string },
): Promise<string> {
  const definitionId = 'id' in definition ? definition.id : definition.definitionId
  if (!definitionId) return ''
  let rejections: Array<{ reviewReason: string | null; reviewedAt: Date | null }>
  try {
    rejections = await repository.listRejectedReviewsForDefinition(
      definitionId,
      definition.organizationId,
    )
  } catch (error) {
    console.warn('[runs] could not load earlier decisions for definition', definitionId, error)
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
