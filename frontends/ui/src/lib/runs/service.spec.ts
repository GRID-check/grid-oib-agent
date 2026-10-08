/**
 * @vitest-environment node
 */
/**
 * The run's message and its ledger.
 *
 * Three properties, and they are the ones a review would ask about: the message
 * is minted ONCE however often a submit is retried, a ledger op is folded into
 * the one metadata key this service owns, and every identity in the write comes
 * off the `task_runs` row rather than out of the op.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/tasks/repository', () => ({
  findRunById: vi.fn(),
  findRunInProject: vi.fn(),
  findRunByBackendJobId: vi.fn(),
  markRunStarted: vi.fn(),
}))
vi.mock('@/lib/conversations/repository', () => ({
  findMessageInConversation: vi.fn(),
  insertMessages: vi.fn(),
  mergeMessageMetadata: vi.fn(),
  writeMessageContent: vi.fn(),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
// The scope a run control signs: the project the service just authorized, as
// the scope builder resolves it (its own checks are its spec's to pin).
vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(async (_session: unknown, context: { projectId?: string }) => ({
    headerValue: 'scope',
    scope: ['oib_knowledge', `proj_col_${context.projectId}`],
    scopedCollections: [
      { collection: 'oib_knowledge', shelf: 'base' },
      { collection: `proj_col_${context.projectId}`, shelf: 'project' },
    ],
    projectId: context.projectId,
    projectCollectionName: `proj_col_${context.projectId}`,
    conversationId: undefined,
    verifiedConversationId: undefined,
  })),
}))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn(), resolveInboxItemsFor: vi.fn() }))
// The project's folders and the documents a run is handed: the real Unterlagen refusal runs against them.
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findProjectDocumentsByFilenames: vi.fn() }))
// Partial: the real slot helpers are what a route opens, and replacing the
// module wholesale would test a service the app does not run.
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
  withPlatformAccess: vi.fn(async (_why: string, run: () => Promise<unknown>) => run()),
}))
// Partial for the same reason: the error class is what the service narrows on.
vi.mock('@/lib/jobs/backend-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/backend-client')>()),
  cancelBackendJob: vi.fn(),
  addDocumentToBackendJob: vi.fn(),
}))

import {
  BadRequestError,
  ConflictError,
  ConversationConfinedError,
  NotFoundError,
  UpstreamError,
} from '@/lib/api/errors'
import type { AccessFolder } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { findProjectDocumentsByFilenames, type DocumentListRow } from '@/lib/documents/repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  findMessageInConversation,
  insertMessages,
  mergeMessageMetadata,
  writeMessageContent,
} from '@/lib/conversations/repository'
import type { Message, TaskRun } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import {
  addDocumentToBackendJob,
  cancelBackendJob,
  JobCancelError,
  type JobControlCaller,
} from '@/lib/jobs/backend-client'
import { emitInboxItems, resolveInboxItemsFor } from '@/lib/inbox/service'
import * as taskRepository from '@/lib/tasks/repository'
import { emptyRunLedger, failRun, finishRun, openPhase } from './run-ledger'
import {
  addRunDocument,
  applyRunLedgerOp,
  cancelRun,
  writeNowRun,
  createRunMessage,
  findRunMessageByBackendJobId,
  getRunView,
  ledgerOpForEnding,
  runMessageId,
  settleRunLedger,
  writeRunReport,
} from './service'

const RUN = '6f1a0f7e-2b1f-4a4e-9a4e-2f0f1a6d9c31'
const CONVERSATION = 's_conv_1'
const T0 = new Date('2026-09-16T08:00:00.000Z')
const T1 = new Date('2026-09-16T08:05:00.000Z')

const run = {
  id: RUN,
  organizationId: 'org_1',
  projectId: 'project-1',
  definitionId: 'def-1',
  requesterUserId: 'user_1',
  title: 'Brandschutzkonzept — Fluchtwege',
  conversationId: CONVERSATION,
  runMessageId: runMessageId(RUN),
  backendJobId: 'job-9',
  status: 'running',
  createdAt: T0,
} as unknown as TaskRun

const message = (metadata: Record<string, unknown> | null): Message =>
  ({
    id: runMessageId(RUN),
    conversationId: CONVERSATION,
    organizationId: 'org_1',
    role: 'assistant',
    runId: RUN,
    content: '',
    metadata,
    createdAt: T0,
  }) as unknown as Message

const session = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'a@grid.test',
  role: 'admin',
  permissions: [],
  accessToken: 'wos-token',
} as unknown as AuthorizedSession

/** The envelope a run control carried, decoded the way the backend reads it. */
const signedPayload = (caller: JobControlCaller): Record<string, unknown> =>
  JSON.parse(Buffer.from(caller.contextHeaders['X-Grid-Request-Context'], 'base64url').toString('utf8'))

/** ADR-0084: the project the service authorized travels signed, so a teammate may steer the run. */
const expectSignedProject = (caller: JobControlCaller): void => {
  expect(caller.accessToken).toBe('wos-token')
  expect(buildCollectionScopeFromRequest).toHaveBeenCalledWith(session, { projectId: 'project-1' })
  const payload = signedPayload(caller)
  expect(payload).toMatchObject({
    organizationId: 'org_1',
    userId: 'user_1',
    projectId: 'project-1',
    issuedAt: expect.any(Number),
  })
  expect(payload.collectionScope).toContainEqual({ collection: 'proj_col_project-1', shelf: 'project' })
}

const step = {
  id: 'batch-1',
  phase: 'recherchieren' as const,
  intent: 'OIB-2 auf Fluchtwegbreiten prüfen',
  startedAt: T1.toISOString(),
  docs: [],
}

const MEMBER = { role: 'project-editor', closed: false, readsBecauseClosed: false } as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProjectAccess).mockResolvedValue(MEMBER)
  vi.mocked(taskRepository.findRunById).mockResolvedValue(run)
  vi.mocked(taskRepository.findRunInProject).mockResolvedValue(run)
  vi.mocked(taskRepository.findRunByBackendJobId).mockResolvedValue(run)
  vi.mocked(listProjectFolderTree).mockResolvedValue([])
  vi.mocked(findProjectDocumentsByFilenames).mockResolvedValue([])
  vi.mocked(writeMessageContent).mockResolvedValue(message(null))
  vi.mocked(findMessageInConversation).mockResolvedValue(
    message({ [`run_ledger`]: emptyRunLedger(RUN, T0) }),
  )
  // The repository's contract, faithfully: the patch (or the function that
  // computes it) is applied to the row as stored, and `writes` is what reached
  // the column — so "wrote nothing" is observable, not just "was not called".
  writes = []
  vi.mocked(mergeMessageMetadata).mockImplementation(async (conversationId, messageId, patch) => {
    const stored = await findMessageInConversation(conversationId, messageId)
    if (!stored) return null
    const current = (stored.metadata ?? {}) as Record<string, unknown>
    const entries = typeof patch === 'function' ? patch(current) : patch
    if (!entries) return stored
    writes.push(entries)
    return { ...stored, metadata: { ...current, ...entries } }
  })
})

let writes: Record<string, unknown>[] = []

describe('createRunMessage', () => {
  it('mints an empty assistant message that carries the run and an empty ledger', async () => {
    vi.mocked(insertMessages).mockResolvedValue([message(null)])

    await createRunMessage(CONVERSATION, RUN, { at: T0 })

    const [[[row]]] = vi.mocked(insertMessages).mock.calls
    expect(row).toMatchObject({
      id: runMessageId(RUN),
      conversationId: CONVERSATION,
      role: 'assistant',
      runId: RUN,
      content: '',
    })
    expect((row.metadata as Record<string, unknown>).run_ledger).toEqual(emptyRunLedger(RUN, T0))
    // No title given, no key: the block falls back to its own word for an
    // untitled run, and an empty string would be a title that is empty.
    expect(row.metadata as Record<string, unknown>).not.toHaveProperty('run_title')
  })

  it('writes the title as one bounded line, for the block to head itself with', async () => {
    vi.mocked(insertMessages).mockResolvedValue([message(null)])

    await createRunMessage(CONVERSATION, RUN, {
      at: T0,
      title: `  Normprüfung:\n\tBrandschutzkonzept   Fluchtwege ${'x'.repeat(300)}`,
    })

    const [[[row]]] = vi.mocked(insertMessages).mock.calls
    const title = (row.metadata as Record<string, unknown>).run_title
    expect(title).toMatch(/^Normprüfung: Brandschutzkonzept Fluchtwege x+$/)
    expect((title as string).length).toBe(200)
  })

  it('derives the id from the run, so a retried submit is a no-op', async () => {
    // `insertMessages` upserts with `onConflictDoNothing`, so the second attempt
    // returns nothing and the message that already exists is read back. Without
    // the deterministic id, a retried submit would leave two half-written runs
    // in the thread.
    vi.mocked(insertMessages).mockResolvedValue([])
    vi.mocked(findMessageInConversation).mockResolvedValue(message(null))

    const again = await createRunMessage(CONVERSATION, RUN, { at: T1 })

    expect(again.id).toBe(runMessageId(RUN))
    expect(findMessageInConversation).toHaveBeenCalledWith(CONVERSATION, runMessageId(RUN))
  })
})

describe('the ledger stays under the lock', () => {
  it('folds onto the ledger as stored when the lock is taken, not a copy read before it', async () => {
    // A flush that landed between an earlier read and the lock is the one the
    // fold must build on; the stored row is read INSIDE the merge.
    await applyRunLedgerOp(RUN, { op: 'append', steps: [step] }, T1)
    const [[, , patch]] = vi.mocked(mergeMessageMetadata).mock.calls
    const landed = openPhase(emptyRunLedger(RUN, T0), 'planen', T0)
    const written = (patch as (m: Record<string, unknown>) => Record<string, unknown>)({ run_ledger: landed })
    expect((written.run_ledger as { phases: unknown[] }).phases).toHaveLength(1)
  })
})

describe('a run that waited in the queue', () => {
  const queuedRun = { ...run, status: 'queued' } as unknown as TaskRun

  it('moves from queued to running on the worker’s first flush', async () => {
    vi.mocked(taskRepository.findRunById).mockResolvedValue(queuedRun)
    await applyRunLedgerOp(RUN, { op: 'append', steps: [step] }, T1)
    expect(taskRepository.markRunStarted).toHaveBeenCalledWith(RUN, 'org_1', T1)
  })

  it('leaves a run that is already running alone', async () => {
    await applyRunLedgerOp(RUN, { op: 'append', steps: [step] }, T1)
    expect(taskRepository.markRunStarted).not.toHaveBeenCalled()
  })

  it('still writes the ledger when the status move fails', async () => {
    vi.mocked(taskRepository.findRunById).mockResolvedValue(queuedRun)
    vi.mocked(taskRepository.markRunStarted).mockRejectedValue(new Error('connection reset'))
    await expect(applyRunLedgerOp(RUN, { op: 'append', steps: [step] }, T1)).resolves.toMatchObject({ runId: RUN })
  })
})

describe('ledgerOpForEnding', () => {
  it('says each ending the way the worker’s fold says it', () => {
    expect(ledgerOpForEnding({ status: 'success' }, T1)).toEqual({
      op: 'finish',
      result: { filedAt: T1.toISOString() },
    })
    expect(ledgerOpForEnding({ status: 'interrupted' }, T1)).toEqual({ op: 'append', status: 'abgebrochen' })
    expect(ledgerOpForEnding({ status: 'failure', error: 'Zeitüberschreitung' }, T1)).toEqual({
      op: 'finish',
      error: { reason: 'Zeitüberschreitung' },
    })
    expect(ledgerOpForEnding({ status: 'failure', error: null }, T1)).toEqual({
      op: 'finish',
      error: { reason: 'Der Lauf ist fehlgeschlagen.' },
    })
  })
})

describe('settleRunLedger', () => {
  it('ends a block that still reads as live — the run whose worker was gone', async () => {
    const live = openPhase(emptyRunLedger(RUN, T0), 'recherchieren', T0)
    vi.mocked(findMessageInConversation).mockResolvedValue(message({ run_ledger: live }))

    expect(await settleRunLedger(run, { status: 'failure', error: 'Job timed out' }, T1)).toBe(true)

    const [written] = writes
    expect(written?.run_ledger).toMatchObject({ status: 'fehlgeschlagen', error: { reason: 'Job timed out' } })
  })

  it('says abgebrochen for a cancel, the status the block’s „Abbrechen" waits for', async () => {
    expect(await settleRunLedger(run, { status: 'interrupted' }, T1)).toBe(true)
    expect(writes[0]?.run_ledger).toMatchObject({ status: 'abgebrochen' })
  })

  it('leaves a ledger the worker already settled alone, whatever the ending says', async () => {
    const done = finishRun(emptyRunLedger(RUN, T0), { filedAt: T0.toISOString(), fileId: 'doc-1' }, T0)
    vi.mocked(findMessageInConversation).mockResolvedValue(message({ run_ledger: done }))
    expect(await settleRunLedger(run, { status: 'failure', error: 'late' }, T1)).toBe(false)

    const failed = failRun(emptyRunLedger(RUN, T0), 'Anbieter', T0)
    vi.mocked(findMessageInConversation).mockResolvedValue(message({ run_ledger: failed }))
    expect(await settleRunLedger(run, { status: 'success' }, T1)).toBe(false)

    expect(writes).toEqual([])
  })

  it('does nothing for a run with no block, and nothing for a message that is gone', async () => {
    expect(await settleRunLedger({ ...run, runMessageId: null }, { status: 'success' }, T1)).toBe(false)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()

    vi.mocked(findMessageInConversation).mockResolvedValue(null)
    expect(await settleRunLedger(run, { status: 'success' }, T1)).toBe(false)
  })

  it('lets a real write failure through, so the caller can leave the row active and retry', async () => {
    vi.mocked(mergeMessageMetadata).mockRejectedValue(new Error('connection reset'))
    await expect(settleRunLedger(run, { status: 'success' }, T1)).rejects.toThrow('connection reset')
  })
})

describe('applyRunLedgerOp', () => {
  it('folds an append onto the stored ledger and writes only its own key', async () => {
    const { ledger } = await applyRunLedgerOp(
      RUN,
      { op: 'append', steps: [step], phases: [{ phase: 'recherchieren', startedAt: T0.toISOString() }] },
      T1,
    )

    expect(ledger.steps).toEqual([step])
    expect(ledger.phases).toEqual([{ phase: 'recherchieren', startedAt: T0.toISOString() }])
    expect(ledger.status).toBe('laeuft')
    // One top-level key. The report, its sources and the transparency keys are
    // written by the path that produces them, into the same message.
    expect(mergeMessageMetadata).toHaveBeenCalledWith(CONVERSATION, runMessageId(RUN), expect.any(Function))
    expect(writes).toEqual([{ run_ledger: ledger }])
  })

  it('enters the tenant the RUN names, never one the op could name', async () => {
    await applyRunLedgerOp(RUN, { op: 'append' }, T1)
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
  })

  it('tells the requester once when the run turns to wartet, with the ids that land on the block', async () => {
    await applyRunLedgerOp(RUN, { op: 'append', status: 'wartet' }, T1)

    expect(emitInboxItems).toHaveBeenCalledTimes(1)
    const [[[emission]]] = vi.mocked(emitInboxItems).mock.calls
    expect(emission).toMatchObject({
      organizationId: 'org_1',
      recipientUserId: 'user_1',
      type: 'job.waiting',
      resourceType: 'project',
      resourceId: 'project-1',
      anchorId: RUN,
      actorUserId: null,
    })
    expect(emission.payload).toMatchObject({
      subject: 'Brandschutzkonzept — Fluchtwege',
      runId: RUN,
      taskId: RUN,
      conversationId: CONVERSATION,
      runMessageId: runMessageId(RUN),
    })
    expect(resolveInboxItemsFor).not.toHaveBeenCalled()

    // A second flush that is still waiting says nothing new.
    vi.mocked(findMessageInConversation).mockResolvedValue(
      message({ run_ledger: { ...emptyRunLedger(RUN, T0), status: 'wartet' } }),
    )
    await applyRunLedgerOp(RUN, { op: 'append', status: 'wartet' }, T1)
    expect(emitInboxItems).toHaveBeenCalledTimes(1)
  })

  it('settles the waiting row when the run moves on, so it never sits in the badge for good', async () => {
    vi.mocked(findMessageInConversation).mockResolvedValue(
      message({ run_ledger: { ...emptyRunLedger(RUN, T0), status: 'wartet' } }),
    )
    await applyRunLedgerOp(RUN, { op: 'append', status: 'laeuft' }, T1)

    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(resolveInboxItemsFor).toHaveBeenCalledWith([
      {
        organizationId: 'org_1',
        recipientUserId: 'user_1',
        groupKey: expect.stringContaining('job.waiting'),
      },
    ])
  })

  it('writes the ledger even when the inbox refuses', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('inbox down'))
    const { ledger } = await applyRunLedgerOp(RUN, { op: 'append', status: 'wartet' }, T1)
    expect(ledger.status).toBe('wartet')
    expect(mergeMessageMetadata).toHaveBeenCalledTimes(1)
  })

  it('finishes with a result', async () => {
    const { ledger } = await applyRunLedgerOp(
      RUN,
      { op: 'finish', result: { filedAt: T1.toISOString(), fileId: 'doc-1' } },
      T1,
    )
    expect(ledger.status).toBe('fertig')
    expect(ledger.result).toEqual({ filedAt: T1.toISOString(), fileId: 'doc-1' })
    expect(ledger.finishedAt).toBe(T1.toISOString())
  })

  it('finishes with an error, keeping what had been completed', async () => {
    vi.mocked(findMessageInConversation).mockResolvedValue(
      message({
        run_ledger: {
          ...emptyRunLedger(RUN, T0),
          phases: [{ phase: 'planen', startedAt: T0.toISOString(), endedAt: T0.toISOString() }],
        },
      }),
    )

    const { ledger } = await applyRunLedgerOp(
      RUN,
      { op: 'finish', error: { reason: 'Der Anbieter hat abgebrochen.' } },
      T1,
    )
    expect(ledger.status).toBe('fehlgeschlagen')
    expect(ledger.error).toEqual({
      reason: 'Der Anbieter hat abgebrochen.',
      completedBefore: ['planen'],
    })
  })

  it('refuses a finish that says both, or neither', async () => {
    await expect(
      applyRunLedgerOp(
        RUN,
        { op: 'finish', result: { filedAt: T1.toISOString() }, error: { reason: 'beides' } },
        T1,
      ),
    ).rejects.toBeInstanceOf(BadRequestError)
    await expect(applyRunLedgerOp(RUN, { op: 'finish' }, T1)).rejects.toBeInstanceOf(
      BadRequestError,
    )
    expect(writes).toEqual([])
  })

  it('refuses a run it cannot find, and one with no message to write into', async () => {
    vi.mocked(taskRepository.findRunById).mockResolvedValue(null)
    await expect(applyRunLedgerOp(RUN, { op: 'append' }, T1)).rejects.toBeInstanceOf(NotFoundError)

    vi.mocked(taskRepository.findRunById).mockResolvedValue({
      ...run,
      runMessageId: null,
    } as unknown as TaskRun)
    await expect(applyRunLedgerOp(RUN, { op: 'append' }, T1)).rejects.toBeInstanceOf(NotFoundError)
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
  })

  it('starts from an empty ledger dated to the RUN when the message carries none', async () => {
    vi.mocked(findMessageInConversation).mockResolvedValue(message({ citations: [] }))

    const { ledger } = await applyRunLedgerOp(RUN, { op: 'append' }, T1)

    // Not "now": a week-old run must not be dated to the moment a flush arrived.
    expect(ledger.startedAt).toBe(T0.toISOString())
  })

  it('sanitises what it stores, whatever a caller sent', async () => {
    const { ledger } = await applyRunLedgerOp(
      RUN,
      { op: 'finish', error: { reason: 'x'.repeat(5_000) } },
      T1,
    )
    expect(ledger.error?.reason).toHaveLength(400)
  })
})

describe('getRunView', () => {
  it('answers with the run’s pointers and its sanitised ledger', async () => {
    await expect(getRunView(session, 'project-1', RUN)).resolves.toEqual({
      runId: RUN,
      backendJobId: 'job-9',
      conversationId: CONVERSATION,
      messageId: runMessageId(RUN),
      status: 'running',
      ledger: emptyRunLedger(RUN, T0),
    })
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'project-1', 'project:view')
  })

  it('answers with a null ledger for a run that has no message yet', async () => {
    vi.mocked(taskRepository.findRunInProject).mockResolvedValue({
      ...run,
      runMessageId: null,
    } as unknown as TaskRun)

    await expect(getRunView(session, 'project-1', RUN)).resolves.toMatchObject({ ledger: null })
  })

  it('refuses a run that is not in this project', async () => {
    vi.mocked(taskRepository.findRunInProject).mockResolvedValue(null)
    await expect(getRunView(session, 'project-1', RUN)).rejects.toBeInstanceOf(NotFoundError)
  })
})

/**
 * The cancel is the browser's existing job cancel reached by run id: same
 * backend call, same credential, same permission. What is pinned here is that
 * it refuses before it reaches the backend when there is nothing to stop, and
 * that it writes nothing itself — the row and the ledger are the worker's to
 * close.
 */
describe('cancelRun', () => {
  it('gates on project:view and the chat permissions, then cancels the backend job as the caller', async () => {
    await expect(cancelRun(session, 'project-1', RUN)).resolves.toMatchObject({
      runId: RUN,
      backendJobId: 'job-9',
      status: 'running',
      ledger: emptyRunLedger(RUN, T0),
    })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'project-1', 'project:view')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'project-1', CHAT_PERMISSIONS)
    expect(taskRepository.findRunInProject).toHaveBeenCalledWith(RUN, 'project-1', 'org_1')
    expect(cancelBackendJob).toHaveBeenCalledWith('job-9', expect.anything())
    expectSignedProject(vi.mocked(cancelBackendJob).mock.calls[0][1])
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
    expect(writeMessageContent).not.toHaveBeenCalled()
  })

  it('refuses before the backend when the caller may not chat in the project', async () => {
    // Once per call this test makes: `clearMocks` drops calls, not implementations.
    vi.mocked(requireProjectAccess)
      .mockResolvedValueOnce(MEMBER)
      .mockRejectedValueOnce(new NotFoundError())

    await expect(cancelRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(NotFoundError)
    expect(cancelBackendJob).not.toHaveBeenCalled()
  })

  it('refuses a run that is not in this project', async () => {
    vi.mocked(taskRepository.findRunInProject).mockResolvedValue(null)

    await expect(cancelRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(NotFoundError)
    expect(cancelBackendJob).not.toHaveBeenCalled()
  })

  it.each(['succeeded', 'failed', 'interrupted', 'skipped', 'error'])(
    'refuses a run that has already ended (%s) without asking the backend',
    async (status) => {
      vi.mocked(taskRepository.findRunInProject).mockResolvedValue({ ...run, status } as TaskRun)

      await expect(cancelRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(ConflictError)
      expect(cancelBackendJob).not.toHaveBeenCalled()
    },
  )

  it('refuses a run that never reached the worker', async () => {
    vi.mocked(taskRepository.findRunInProject).mockResolvedValue({
      ...run,
      status: 'queued',
      backendJobId: null,
    } as TaskRun)

    await expect(cancelRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(ConflictError)
    expect(cancelBackendJob).not.toHaveBeenCalled()
  })

  it('reads the backend’s own verdict on a race as „already ended“, and its 404 as unknown', async () => {
    vi.mocked(cancelBackendJob).mockRejectedValueOnce(
      new JobCancelError('Job not cancellable: job-9 (status: success)', 400),
    )
    await expect(cancelRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(ConflictError)

    vi.mocked(cancelBackendJob).mockRejectedValueOnce(new JobCancelError('Job not found: job-9', 404))
    await expect(cancelRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(NotFoundError)

    vi.mocked(cancelBackendJob).mockRejectedValueOnce(new JobCancelError('network down', 503))
    await expect(cancelRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(UpstreamError)
  })
})

/**
 * The worker holds one id, the job store's, and the report has to reach the
 * message the run has been narrating itself in. Three answers matter: it finds
 * that message, it writes the report into it without touching the ledger, and it
 * says „no message here" for a run that has none — which is what keeps the old
 * question-and-answer path alive for the runs that still need it.
 */
describe('writeRunReport', () => {
  it('fills in the run’s own message, inside the run’s organization', async () => {
    await expect(
      writeRunReport('job-9', { content: 'Der Bericht', metadata: { job_id: 'job-9' } }),
    ).resolves.toEqual({
      runId: RUN,
      conversationId: CONVERSATION,
      messageId: runMessageId(RUN),
    })

    expect(taskRepository.findRunByBackendJobId).toHaveBeenCalledWith('job-9')
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
    expect(writeMessageContent).toHaveBeenCalledWith(
      CONVERSATION,
      runMessageId(RUN),
      'Der Bericht',
      expect.objectContaining({ job_id: 'job-9' }),
    )
  })

  /**
   * The backend's own spelling arrives and the stored contract leaves. The
   * translation is the internal messages route's, applied at the one point the
   * foreign dialect enters — a report whose `sources` stayed under that name is
   * a message whose citations are silently gone.
   */
  it('translates the backend’s answer metadata on the way in', async () => {
    await writeRunReport('job-9', {
      content: 'Der Bericht',
      metadata: { sources: [{ title: 'OIB-2', url: 'https://example.test/oib2' }] },
    })

    const [, , , metadata] = vi.mocked(writeMessageContent).mock.calls[0]
    expect(metadata.sources).toBeUndefined()
    expect(metadata).toHaveProperty('citations')
  })

  it('refuses a run with no message, which is how the old path stays alive', async () => {
    vi.mocked(taskRepository.findRunByBackendJobId).mockResolvedValue({
      ...run,
      runMessageId: null,
    } as unknown as TaskRun)

    await expect(writeRunReport('job-9', { content: 'x' })).rejects.toBeInstanceOf(NotFoundError)
    expect(writeMessageContent).not.toHaveBeenCalled()
  })

  it('refuses a job that is no run of ours at all', async () => {
    vi.mocked(taskRepository.findRunByBackendJobId).mockResolvedValue(null)
    await expect(writeRunReport('job-9', { content: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('findRunMessageByBackendJobId', () => {
  it('resolves the target from the one id the job store keeps', async () => {
    await expect(findRunMessageByBackendJobId('job-9')).resolves.toEqual({
      runId: RUN,
      conversationId: CONVERSATION,
      messageId: runMessageId(RUN),
    })
  })

  it('is null for a run with no conversation', async () => {
    vi.mocked(taskRepository.findRunByBackendJobId).mockResolvedValue({
      ...run,
      conversationId: null,
    } as unknown as TaskRun)

    await expect(findRunMessageByBackendJobId('job-9')).resolves.toBeNull()
  })
})

/**
 * Adding a document to a running run is the same door as the cancel: gated the
 * same way, refused before the backend for a run with nothing to hand it to,
 * and it writes nothing itself — the ledger lists the document through the
 * run's own stream once the worker has taken it.
 */
/**
 * A closed project (ADR-0088): every member reads it and may chat about it, but
 * someone who reads it only because it is closed does not steer another
 * person's run, and nobody hands a run a document, which files into it.
 */
describe('run mutations in a closed project', () => {
  const outsider = { role: 'project-viewer', closed: true, readsBecauseClosed: true } as const

  it('refuses someone who reads the project only because it is closed, unless the run is theirs', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue(outsider)
    vi.mocked(taskRepository.findRunInProject).mockResolvedValue({ ...run, requesterUserId: 'user_someone_else' } as TaskRun)
    await expect(cancelRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(NotFoundError)
    await expect(writeNowRun(session, 'project-1', RUN)).rejects.toBeInstanceOf(NotFoundError)
    expect(cancelBackendJob).not.toHaveBeenCalled()

    vi.mocked(taskRepository.findRunInProject).mockResolvedValue({ ...run, requesterUserId: session.userId } as TaskRun)
    await expect(cancelRun(session, 'project-1', RUN)).resolves.toMatchObject({ runId: RUN })
  })

  it('lets a member of the project cancel', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ ...MEMBER, closed: true })
    await expect(cancelRun(session, 'project-1', RUN)).resolves.toMatchObject({ runId: RUN })
  })

  it('refuses to hand a run a document, a member included', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ ...MEMBER, closed: true })
    await expect(
      addRunDocument(session, 'project-1', RUN, { name: 'Plan.pdf', title: 'Plan', shelf: 'project' })
    ).rejects.toMatchObject({ details: { reason: 'project-closed' } })
    expect(addDocumentToBackendJob).not.toHaveBeenCalled()
  })
})

describe('addRunDocument', () => {
  const doc = { name: 'Einreichplan.pdf', title: 'Einreichplan', shelf: 'project' as const }

  it('gates on project:view and the chat permissions, then hands the document to the backend job', async () => {
    await expect(addRunDocument(session, 'project-1', RUN, doc)).resolves.toMatchObject({
      runId: RUN,
      backendJobId: 'job-9',
      status: 'running',
    })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'project-1', 'project:view')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'project-1', CHAT_PERMISSIONS)
    expect(addDocumentToBackendJob).toHaveBeenCalledWith('job-9', doc, expect.anything())
    expectSignedProject(vi.mocked(addDocumentToBackendJob).mock.calls[0][2])
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
    expect(writeMessageContent).not.toHaveBeenCalled()
  })

  it('refuses a run that has already ended without asking the backend', async () => {
    vi.mocked(taskRepository.findRunInProject).mockResolvedValue({ ...run, status: 'succeeded' } as TaskRun)

    await expect(addRunDocument(session, 'project-1', RUN, doc)).rejects.toBeInstanceOf(ConflictError)
    expect(addDocumentToBackendJob).not.toHaveBeenCalled()
  })

  it('reads the backend’s 400 as the run having ended and any other refusal as upstream', async () => {
    vi.mocked(addDocumentToBackendJob).mockRejectedValueOnce(new JobCancelError('Job not running', 400))
    await expect(addRunDocument(session, 'project-1', RUN, doc)).rejects.toBeInstanceOf(ConflictError)

    vi.mocked(addDocumentToBackendJob).mockRejectedValueOnce(new JobCancelError('gateway', 502))
    await expect(addRunDocument(session, 'project-1', RUN, doc)).rejects.toBeInstanceOf(UpstreamError)
  })

  /**
   * ADR-0084 lets every project:chat member read the run's stream and report,
   * where the document's name and title would land. A cleared member picking a
   * document from a restricted folder is refused, and the backend hears nothing.
   */
  describe('a document from a restricted folder (ADR-0087)', () => {
    const PERSONAL = 'folder-personal'
    const OPEN = 'folder-plaene'
    const TREE: AccessFolder[] = [
      { id: PERSONAL, parentId: null, accessMode: 'custom', grants: [{ role: 'org-gf', level: 'read' }] },
      { id: 'folder-unter-personal', parentId: PERSONAL, accessMode: 'inherit', grants: [] },
      { id: OPEN, parentId: null, accessMode: 'inherit', grants: [] },
    ]
    const row = (filename: string, folderId: string | null) =>
      ({ id: `doc-${filename}`, filename, folderId }) as DocumentListRow

    beforeEach(() => {
      vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    })

    it.each([PERSONAL, 'folder-unter-personal'])(
      'refuses one filed in %s, in the reader’s language, without asking the backend',
      async (folderId) => {
        vi.mocked(findProjectDocumentsByFilenames).mockResolvedValue([row('Abmahnung_Meier_2026.pdf', folderId)])
        const error = await addRunDocument(
          session,
          'project-1',
          RUN,
          { name: 'Abmahnung_Meier_2026.pdf', title: 'Abmahnung Meier', shelf: 'project' },
          'en'
        ).catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(ConversationConfinedError)
        expect((error as ConversationConfinedError).action).toBe('planDocument')
        expect((error as ConversationConfinedError).message).toContain('restricted access')
        expect(findProjectDocumentsByFilenames).toHaveBeenCalledWith(
          'project-1',
          'org_1',
          ['Abmahnung_Meier_2026.pdf'],
          { includeArchived: true }
        )
        expect(addDocumentToBackendJob).not.toHaveBeenCalled()
      }
    )

    it('hands over a document from an open folder, or the project root', async () => {
      vi.mocked(findProjectDocumentsByFilenames).mockResolvedValue([row('Einreichplan.pdf', OPEN)])
      await addRunDocument(session, 'project-1', RUN, doc)
      vi.mocked(findProjectDocumentsByFilenames).mockResolvedValue([row('Einreichplan.pdf', null)])
      await addRunDocument(session, 'project-1', RUN, doc)
      expect(addDocumentToBackendJob).toHaveBeenCalledTimes(2)
    })

    it('never looks up an Archiv document: no project folder restricts the Archiv', async () => {
      await addRunDocument(session, 'project-1', RUN, { name: 'Leitfaden.pdf', shelf: 'archiv' })
      expect(listProjectFolderTree).not.toHaveBeenCalled()
      expect(findProjectDocumentsByFilenames).not.toHaveBeenCalled()
      expect(addDocumentToBackendJob).toHaveBeenCalled()
    })
  })
})
