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
}))
vi.mock('@/lib/conversations/repository', () => ({
  findMessageInConversation: vi.fn(),
  insertMessages: vi.fn(),
  mergeMessageMetadata: vi.fn(),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
// Partial: the real slot helpers are what a route opens, and replacing the
// module wholesale would test a service the app does not run.
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
  withPlatformAccess: vi.fn(async (_why: string, run: () => Promise<unknown>) => run()),
}))

import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  findMessageInConversation,
  insertMessages,
  mergeMessageMetadata,
} from '@/lib/conversations/repository'
import type { Message, TaskRun } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import * as taskRepository from '@/lib/tasks/repository'
import { emptyRunLedger } from './run-ledger'
import { applyRunLedgerOp, createRunMessage, getRunView, runMessageId } from './service'

const RUN = '6f1a0f7e-2b1f-4a4e-9a4e-2f0f1a6d9c31'
const CONVERSATION = 's_conv_1'
const T0 = new Date('2026-09-16T08:00:00.000Z')
const T1 = new Date('2026-09-16T08:05:00.000Z')

const run = {
  id: RUN,
  organizationId: 'org_1',
  projectId: 'project-1',
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
  vi.mocked(findMessageInConversation).mockResolvedValue(
    message({ [`run_ledger`]: emptyRunLedger(RUN, T0) }),
  )
  vi.mocked(mergeMessageMetadata).mockResolvedValue(message(null))
})

describe('createRunMessage', () => {
  it('mints an empty assistant message that carries the run and an empty ledger', async () => {
    vi.mocked(insertMessages).mockResolvedValue([message(null)])

    await createRunMessage(CONVERSATION, RUN, T0)

    const [[[row]]] = vi.mocked(insertMessages).mock.calls
    expect(row).toMatchObject({
      id: runMessageId(RUN),
      conversationId: CONVERSATION,
      role: 'assistant',
      runId: RUN,
      content: '',
    })
    expect((row.metadata as Record<string, unknown>).run_ledger).toEqual(emptyRunLedger(RUN, T0))
  })

  it('derives the id from the run, so a retried submit is a no-op', async () => {
    // `insertMessages` upserts with `onConflictDoNothing`, so the second attempt
    // returns nothing and the message that already exists is read back. Without
    // the deterministic id, a retried submit would leave two half-written runs
    // in the thread.
    vi.mocked(insertMessages).mockResolvedValue([])
    vi.mocked(findMessageInConversation).mockResolvedValue(message(null))

    const again = await createRunMessage(CONVERSATION, RUN, T1)

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
