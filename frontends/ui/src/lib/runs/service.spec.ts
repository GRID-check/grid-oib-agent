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
}))
vi.mock('@/lib/conversations/repository', () => ({
  findMessageInConversation: vi.fn(),
  insertMessages: vi.fn(),
  mergeMessageMetadata: vi.fn(),
  writeMessageContent: vi.fn(),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn(), resolveInboxItemsFor: vi.fn() }))
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

import { BadRequestError, ConflictError, NotFoundError, UpstreamError } from '@/lib/api/errors'
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
import { addDocumentToBackendJob, cancelBackendJob, JobCancelError } from '@/lib/jobs/backend-client'
import { emitInboxItems, resolveInboxItemsFor } from '@/lib/inbox/service'
import * as taskRepository from '@/lib/tasks/repository'
import { emptyRunLedger } from './run-ledger'
import {
  addRunDocument,
  applyRunLedgerOp,
  cancelRun,
  createRunMessage,
  findRunMessageByBackendJobId,
  getRunView,
  runMessageId,
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

const step = {
  id: 'batch-1',
  phase: 'recherchieren' as const,
  intent: 'OIB-2 auf Fluchtwegbreiten prüfen',
  startedAt: T1.toISOString(),
  docs: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(taskRepository.findRunById).mockResolvedValue(run)
  vi.mocked(taskRepository.findRunInProject).mockResolvedValue(run)
  vi.mocked(taskRepository.findRunByBackendJobId).mockResolvedValue(run)
  vi.mocked(writeMessageContent).mockResolvedValue(message(null))
  vi.mocked(findMessageInConversation).mockResolvedValue(
    message({ [`run_ledger`]: emptyRunLedger(RUN, T0) }),
  )
  vi.mocked(mergeMessageMetadata).mockResolvedValue(message(null))
})

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
    expect(mergeMessageMetadata).toHaveBeenCalledWith(CONVERSATION, runMessageId(RUN), {
      run_ledger: ledger,
    })
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
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
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
    expect(cancelBackendJob).toHaveBeenCalledWith('job-9', 'wos-token')
    expect(mergeMessageMetadata).not.toHaveBeenCalled()
    expect(writeMessageContent).not.toHaveBeenCalled()
  })

  it('refuses before the backend when the caller may not chat in the project', async () => {
    // Once per call this test makes: `clearMocks` drops calls, not implementations.
    vi.mocked(requireProjectAccess)
      .mockResolvedValueOnce(undefined as never)
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
    expect(addDocumentToBackendJob).toHaveBeenCalledWith('job-9', doc, 'wos-token')
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
})
