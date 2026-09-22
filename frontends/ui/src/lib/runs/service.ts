/**
 * The run's message and its ledger — the service behind the run primitive
 * (ADR-0055, ADR-0062).
 *
 * A run is ONE assistant message in the conversation it was commissioned in.
 * This module owns five moves on that message and nothing else:
 *
 *   `createRunMessage`  — mint it, empty, at submit time;
 *   `applyRunLedgerOp`  — fold one op into `metadata.run_ledger`;
 *   `writeRunReport`    — fill in the finished answer, found by backend job id;
 *   `getRunView`        — read it back for a person, project-scoped;
 *   `cancelRun`         — ask the backend to stop it, for a person, project-scoped.
 *
 * ## Identity comes from the row, never from the body
 *
 * The ledger arrives from a worker that holds one id: the run's. So
 * `applyRunLedgerOp` resolves that id under platform access — there is genuinely
 * no tenant yet — and then does EVERYTHING else inside the run's own
 * organization, so row-level security applies to the write exactly as it would
 * to a person's. The organization, the project and the requester are read off
 * the `task_runs` row; the request body names none of them and could not be
 * believed if it did (ADR-0041, and the shape `POST /api/internal/jobs/[jobId]/outcome`
 * already uses).
 *
 * ## This route owns `run_ledger` and no other metadata key
 *
 * The finished report, its sources and the transparency keys
 * (`_TRANSPARENCY_METADATA_KEYS` in `frontends/aiq_api/.../conversation_output.py`)
 * are written by the path that produces them, into the same message. The merge
 * below is per top-level key, so a ledger flush never touches them and a report
 * write never touches the ledger — two writers, one message, no lost update
 * (`mergeMessageMetadata` takes the row lock).
 */

import 'server-only'
import { v5 as uuidv5 } from 'uuid'
import { BadRequestError, ConflictError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireProjectAccess } from '@/lib/authz/projects'
import { normalizeAgentAnswerMetadata } from '@/lib/conversations/agent-answer-metadata'
import {
  findMessageInConversation,
  insertMessages,
  mergeMessageMetadata,
  writeMessageContent,
} from '@/lib/conversations/repository'
import type { Message, TaskRun } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { cancelBackendJob, JobCancelError } from '@/lib/jobs/backend-client'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, resolveInboxItemsFor } from '@/lib/inbox/service'
import * as taskRepository from '@/lib/tasks/repository'
import { isActiveTaskRunStatus } from '@/lib/tasks/task-vocabulary'
import {
  applyRunLedgerAppend,
  applyRunLedgerFinish,
  emptyRunLedger,
  sanitizeRunLedger,
  sanitizeRunTitle,
} from './run-ledger'
import type { RunLedger, RunLedgerRequest, RunLedgerResponse, RunView } from './run-ledger-types'
import { runDisplayStatus } from './run-vocabulary'

/** Where the ledger lives on the message. Wire spelling, like `retrieval_ledger`. */
export const RUN_LEDGER_METADATA_KEY = 'run_ledger'
/**
 * Where the run's title lives on the message: the task's title, or the
 * question a deep-research run was asked. Set once at mint time and never
 * merged over — the ledger route writes `run_ledger` and nothing else.
 */
export const RUN_TITLE_METADATA_KEY = 'run_title'

/** What `createRunMessage` takes beside the two ids. */
export interface CreateRunMessageOptions {
  /** The block's header line. Sanitised to one line of at most 200 characters. */
  title?: string | null
  at?: Date
}

/**
 * The id of the message a run writes into, derived from the run id.
 *
 * Deterministic on purpose, exactly as `conversation_output._message_id` is on
 * the Python side: `insertMessages` upserts with `onConflictDoNothing`, so a
 * retried submit — a worker that lost its claim, a user who pressed the button
 * twice — lands on the same row instead of leaving two half-written runs in the
 * thread. uuid5 over `NAMESPACE_URL`, which is the namespace the Python half
 * uses, so both tiers compute the same uuid for the same run.
 */
export function runMessageId(runId: string): string {
  return uuidv5(`grid:run:${runId}`, uuidv5.URL)
}

/**
 * Mint the run's message: an empty assistant turn carrying an empty ledger.
 *
 * Empty content, deliberately. The message is the run's PLACE in the thread from
 * the moment it is submitted — „angelegt" is a state the reader should see —
 * and its prose arrives when the run has some. A reader of an older build sees
 * an assistant message with nothing in it, which is what it is.
 *
 * Runs inside the caller's tenant scope: the organization is defaulted from
 * `grid.organization_id` in SQL, so a call outside a scope fails closed rather
 * than writing into whatever tenant the socket last served.
 */
export async function createRunMessage(
  conversationId: string,
  runId: string,
  options: CreateRunMessageOptions = {},
): Promise<Message> {
  const at = options.at ?? new Date()
  const id = runMessageId(runId)
  // The title is what the block's header shows while the ledger is still
  // empty, so it is written with the ledger rather than by a later flush. Absent
  // rather than empty when the caller has none: the block falls back to its own
  // word for an untitled run, and an empty string would be a title that is empty.
  const title = sanitizeRunTitle(options.title)
  const [inserted] = await insertMessages([
    {
      id,
      conversationId,
      role: 'assistant',
      runId,
      content: '',
      metadata: {
        messageType: 'agent_response',
        [RUN_LEDGER_METADATA_KEY]: emptyRunLedger(runId, at),
        ...(title ? { [RUN_TITLE_METADATA_KEY]: title } : {}),
      },
      createdAt: at,
    },
  ])
  if (inserted) return inserted
  // The insert no-opped, so the message is already there — a retry, which is
  // the whole point of the deterministic id. Read it back rather than reporting
  // a failure: the caller wanted a message to exist, and one does.
  const existing = await findMessageInConversation(conversationId, id)
  if (!existing) throw new NotFoundError('The run message could not be created')
  return existing
}

/** The run a ledger op is about, or a 404. Platform-scope lookup; see the header. */
async function loadRunForLedger(runId: string) {
  return withPlatformAccess(
    'run ledger: the worker names a run by id, before any organization is known',
    () => taskRepository.findRunById(runId),
  )
}

/** The ledger stored on a message, sanitised, or null when it carries none. */
function storedLedger(message: Message): RunLedger | null {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>
  return sanitizeRunLedger(metadata[RUN_LEDGER_METADATA_KEY])
}

/** The op as the fold takes it — exactly one of a result or an error on `finish`. */
function finishOutcome(op: Extract<RunLedgerRequest, { op: 'finish' }>) {
  if (op.result && op.error) {
    throw new BadRequestError('A finished run has a result or an error, never both')
  }
  if (op.result) return { result: op.result }
  if (op.error) return { error: op.error }
  throw new BadRequestError('A finished run must say what it produced or why it stopped')
}

/**
 * Fold one op into the run's ledger and store the result.
 *
 * Read-modify-write under the row lock `mergeMessageMetadata` takes, because
 * two flushes of the same run can be in flight: the debounced one and the
 * terminal one. The fold itself is the pure one from `./run-ledger`, so the
 * BFF, the Python tier and the UI all grow a ledger the same way.
 */
export async function applyRunLedgerOp(
  runId: string,
  op: RunLedgerRequest,
  at: Date = new Date(),
): Promise<RunLedgerResponse> {
  const run = await loadRunForLedger(runId)
  if (!run) throw new NotFoundError('Unknown run')
  // A run submitted before this tier minted run messages has nowhere to put a
  // ledger. A 404 rather than an invented message: the fold treats it as
  // „nothing to write", and inventing a message would put an empty assistant
  // turn into a thread nobody asked to have narrated.
  if (!run.conversationId || !run.runMessageId) {
    throw new NotFoundError('This run has no message to write a ledger into')
  }
  const conversationId = run.conversationId
  const messageId = run.runMessageId

  return withTenant({ organizationId: run.organizationId }, async () => {
    const message = await findMessageInConversation(conversationId, messageId)
    if (!message) throw new NotFoundError('This run has no message to write a ledger into')

    // A message with no ledger yet — one minted before this column existed, or
    // one whose payload did not survive the sanitiser — starts from an empty
    // ledger dated to the run, never to now: a week-old run must not be dated
    // to the moment a flush arrived.
    const current = storedLedger(message) ?? emptyRunLedger(runId, run.createdAt)
    const next =
      op.op === 'append'
        ? applyRunLedgerAppend(current, op, at)
        : applyRunLedgerFinish(current, finishOutcome(op), at)

    // Sanitised once more on the way to the column: the moves already bound
    // their output, and this is the line that makes „sanitised on write" true
    // of the STORAGE rather than of the caller's good behaviour.
    const ledger = sanitizeRunLedger(next) ?? current
    await mergeMessageMetadata(conversationId, messageId, { [RUN_LEDGER_METADATA_KEY]: ledger })
    await notifyWaiting(run, current, ledger)
    return { runId, ledger }
  })
}

/**
 * Tell the requester when their run stops to ask them something, and settle
 * that row when the run moves on.
 *
 * `wartet` is the one status with no column behind it: it exists only in the
 * ledger, so this fold is the only place that sees a run enter or leave it.
 * The row is `job.waiting`, actionable, anchored on the run — and resolved by
 * the ledger's next status, which is what keeps an actionable row out of the
 * badge for good. The payload carries the same ids the outcome rows carry, so
 * the inbox lands the reader on the run block (`lib/inbox/targets.ts`).
 *
 * Fail-open: a flush is the worker's write, and the inbox must never turn it
 * into a 500 — a missed notification costs a badge, a refused flush costs the
 * ledger.
 */
async function notifyWaiting(run: TaskRun, before: RunLedger, after: RunLedger): Promise<void> {
  const wasWaiting = runDisplayStatus(before) === 'wartet'
  const isWaiting = runDisplayStatus(after) === 'wartet'
  if (wasWaiting === isWaiting) return
  const groupKey = inboxGroupKey('job.waiting', 'project', run.projectId, run.id)
  try {
    if (!isWaiting) {
      await resolveInboxItemsFor([
        { organizationId: run.organizationId, recipientUserId: run.requesterUserId, groupKey },
      ])
      return
    }
    await emitInboxItems([
      {
        organizationId: run.organizationId,
        recipientUserId: run.requesterUserId,
        type: 'job.waiting',
        resourceType: 'project',
        resourceId: run.projectId,
        anchorId: run.id,
        actorUserId: null,
        groupKey,
        payload: {
          subject: run.title,
          jobId: run.definitionId,
          runId: run.id,
          conversationId: run.conversationId,
          runMessageId: run.runMessageId,
          taskId: run.id,
        },
      },
    ])
  } catch (err) {
    console.warn('[runs] could not update the waiting row for run', run.id, err)
  }
}

/**
 * Where a backend job's run writes — the resolution the worker and the deep
 * links both need, from the one id the job store holds.
 *
 * `backend_job_id` is the worker's only handle on a run: it has no `task_runs`
 * id, no conversation and no message. Every consumer of that handle goes through
 * here rather than deriving anything of its own, because the message id is
 * derived from the RUN id and only this tier knows the pair.
 *
 * Null for an interactive deep-research job (no `task_runs` row at all) and for
 * every run submitted before this tier minted run messages. Both mean the same
 * thing to a caller — „this run has no message" — and the caller falls back to
 * writing an ordinary turn.
 */
export async function findRunMessageByBackendJobId(
  backendJobId: string,
): Promise<{ runId: string; conversationId: string; messageId: string } | null> {
  const run = await withPlatformAccess(
    'run message lookup: the worker names a run by its backend job id, before any organization is known',
    () => taskRepository.findRunByBackendJobId(backendJobId),
  )
  if (!run?.conversationId || !run.runMessageId) return null
  return { runId: run.id, conversationId: run.conversationId, messageId: run.runMessageId }
}

/**
 * Write the run's finished answer into the run's own message.
 *
 * A run is ONE message in the thread that commissioned it, so its report does
 * not arrive as a new assistant turn beside a question nobody typed — it fills
 * in the message the thread has been showing since the run was submitted. The
 * metadata is merged per top-level key and translated through
 * `normalizeAgentAnswerMetadata` exactly as the internal messages route does, so
 * the backend's wire spelling (`sources`, `answer_confidence`, …) reads back as
 * the stored contract every surface looks for — and `run_ledger`, which another
 * writer owns, is untouched.
 *
 * A 404 is the answer for a run with no message, and it is what tells the worker
 * to fall back to today's question-and-answer pair.
 */
export async function writeRunReport(
  backendJobId: string,
  report: { content: string; metadata?: Record<string, unknown> },
): Promise<{ runId: string; conversationId: string; messageId: string }> {
  const target = await findRunMessageByBackendJobId(backendJobId)
  if (!target) throw new NotFoundError('This run has no message to write a report into')

  const run = await loadRunForLedger(target.runId)
  if (!run) throw new NotFoundError('Unknown run')

  return withTenant({ organizationId: run.organizationId }, async () => {
    const written = await writeMessageContent(
      target.conversationId,
      target.messageId,
      report.content,
      normalizeAgentAnswerMetadata(report.metadata ?? {}) ?? {},
    )
    if (!written) throw new NotFoundError('This run has no message to write a report into')
    return target
  })
}

/**
 * One run as a person reads it: where its message is, and what the ledger says.
 *
 * Project-scoped and session-authorized — `project:view`, the same gate the
 * task list uses — so this is the surface a browser reads a live run from. The
 * internal route above is the write door and holds no session at all.
 */
export async function getRunView(
  session: AuthorizedSession,
  projectId: string,
  runId: string,
): Promise<RunView> {
  await requireProjectAccess(session, projectId, 'project:view')
  const run = await taskRepository.findRunInProject(runId, projectId, session.organizationId)
  if (!run) throw new NotFoundError('Unknown run')
  return runView(run)
}

/** The view of a run already resolved inside the caller's project. */
async function runView(run: TaskRun): Promise<RunView> {
  const message =
    run.conversationId && run.runMessageId
      ? await findMessageInConversation(run.conversationId, run.runMessageId)
      : null
  return {
    runId: run.id,
    backendJobId: run.backendJobId,
    conversationId: run.conversationId,
    messageId: run.runMessageId,
    status: run.status,
    // Re-sanitised on READ as well as on write, like every other stored jsonb
    // payload a renderer meets: the row may have been written by another build.
    ledger: message ? storedLedger(message) : null,
  }
}

/**
 * Stop a run on a person's request: the write door of the run primitive that
 * the block's „Abbrechen" presses (ADR-0055, ADR-0062).
 *
 * ## The same cancel, the same gate, behind the run's own id
 *
 * The browser has cancelled a deep-research job since before runs had
 * messages: `POST /api/jobs/async/job/{jobId}/cancel`, which the proxy gates on
 * the session plus `CHAT_PERMISSIONS` on the project in scope and forwards to
 * the backend as the caller. This is that call reached by run id instead of
 * job id — so the block, which holds only the run's message, does not have to
 * learn the job store's key — and nothing about it is new: the same backend
 * endpoint (`cancelBackendJob`), the same credential, and the same permission
 * (`project:view` to read the run at all, `CHAT_PERMISSIONS` to act on the
 * agent in the project, exactly as `buildCollectionScopeFromRequest` gates the
 * proxy). The backend then enforces job ownership on top, which is why a run
 * somebody else commissioned answers 404 rather than 403.
 *
 * ## Nothing is written here
 *
 * The row and the ledger stay as they are. The backend marks the job
 * interrupted, the worker sees it and stops, the ledger's terminal flush
 * arrives as `abgebrochen` through the same route every other flush uses, and
 * the outcome callback closes the row. Writing „abgebrochen" here as well would
 * be a second author of the run's status, and the two would disagree exactly
 * when the cancel did not take.
 *
 * Refusals: 404 for a run outside the project, 409 for one that has already
 * ended (by the row, or by the backend's own verdict when the two race) and for
 * one that has no backend job — a run that never reached the worker has nothing
 * to stop.
 */
export async function cancelRun(
  session: AuthorizedSession,
  projectId: string,
  runId: string,
): Promise<RunView> {
  await requireProjectAccess(session, projectId, 'project:view')
  await requireProjectAccess(session, projectId, CHAT_PERMISSIONS)
  const run = await taskRepository.findRunInProject(runId, projectId, session.organizationId)
  if (!run) throw new NotFoundError('Unknown run')
  if (!isActiveTaskRunStatus(run.status)) throw new ConflictError('This run has already ended')
  if (!run.backendJobId) throw new ConflictError('This run has no backend job to cancel')

  try {
    await cancelBackendJob(run.backendJobId, session.accessToken ?? null)
  } catch (error) {
    if (!(error instanceof JobCancelError)) throw error
    // The backend's verdict on a race: the job finished between the row read
    // and the cancel. Its 404 is „not yours or not there", and it says which
    // to nobody on purpose.
    if (error.status === 400) throw new ConflictError('This run has already ended')
    if (error.status === 404) throw new NotFoundError('Unknown run')
    throw new UpstreamError('The run could not be cancelled')
  }
  return runView(run)
}
