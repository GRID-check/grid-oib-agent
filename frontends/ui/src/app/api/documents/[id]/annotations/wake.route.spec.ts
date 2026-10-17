/**
 * @vitest-environment node
 */
/**
 * The writes that wake Piloti (ADR-0106), driven through the TYPED CLIENT and
 * the real routes and service: a reply that addresses Piloti, a reply on
 * Piloti's open question, and a delegation enqueue exactly one wake, in the
 * write's own transaction; a reply Piloti wrote, a reply to people, and a
 * reader's refused write enqueue none; the organization's switch off answers
 * `wake: 'off'`, and the browser keeps asking Piloti itself.
 *
 * The repository is a fake that runs the write's transaction hook with a
 * transaction handle, which is how the test sees that the wake rides IN the
 * write's transaction. That a rolled-back write leaves no wake is held against
 * a real database in `lib/annotations/repository.integration.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TX_DB = vi.hoisted(() => ({ handle: 'the tenant-scoped db' }))

const session = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'a@grid.test',
  name: 'Anna Berger',
  role: 'member',
  permissions: [] as string[],
  featureFlags: ['piloti-wakes'] as string[] | null,
}

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => session) }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({ PERMISSION_CHECKS_AT_ONCE: 8, userHoldsProjectPermission: vi.fn(), resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn().mockResolvedValue(new Map()) }))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
// Every write here is one person's; the shared limiter would refuse them as a burst.
vi.mock('@/lib/limits/enforce', async (original) => ({
  ...(await original<typeof import('@/lib/limits/enforce')>()),
  enforceLimit: vi.fn(async () => undefined),
}))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/annotations/wake-repository', () => ({
  countWakes: vi.fn(),
  insertWake: vi.fn(),
  findLiveDelegationWake: vi.fn(),
  settleWake: vi.fn(),
  listLatestWakes: vi.fn(async () => []),
}))
// Only the write after the commit (`settleTakenBack`) opens a handle of its own.
vi.mock('@/lib/db', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/db')>()), getDb: () => TX_DB }))
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: (_context: unknown, run: () => unknown) => run(),
}))
vi.mock('@/lib/annotations/attention', () => ({
  onMarkSettledByPerson: vi.fn(),
  onAssigneeChanged: vi.fn(),
  onMarkReplied: vi.fn(),
  onMarkMoved: vi.fn(),
  onMarkDeleted: vi.fn(),
}))
vi.mock('@/lib/langfuse/decision-score', () => ({ recordDecisionScore: vi.fn() }))
vi.mock('@/lib/annotations/repository', () => ({
  AnnotationLimitReachedError: class AnnotationLimitReachedError extends Error {},
  ReplyLimitReachedError: class ReplyLimitReachedError extends Error {},
  listDocumentAnnotations: vi.fn(),
  findDocumentAnnotation: vi.fn(),
  insertDocumentAnnotations: vi.fn(),
  updateDocumentAnnotation: vi.fn(),
  deleteDocumentAnnotation: vi.fn(),
  insertAnnotationReply: vi.fn(),
}))

import { ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  onAssigneeChanged,
  onMarkDeleted,
  onMarkMoved,
  onMarkReplied,
  onMarkSettledByPerson,
} from '@/lib/annotations/attention'
import {
  deleteAnnotation,
  listAnnotations,
  replyToAnnotation,
  updateAnnotation,
  updateAnnotationWithWake,
} from '@/lib/annotations/client'
import {
  deleteDocumentAnnotation,
  findDocumentAnnotation,
  insertAnnotationReply,
  insertDocumentAnnotations,
  listDocumentAnnotations,
  updateDocumentAnnotation,
  type AnnotationRecord,
} from '@/lib/annotations/repository'
import {
  createAnnotation as createAs,
  PILOTI,
  replyToAnnotation as replyAs,
  updateAnnotation as updateAs,
} from '@/lib/annotations/service'
import {
  countWakes,
  findLiveDelegationWake,
  insertWake,
  listLatestWakes,
  settleWake,
} from '@/lib/annotations/wake-repository'
import { delegationEventId, documentThreadConversationId, wakeTurnId } from '@/lib/annotations/wake-ids'
import { recordAuditEvent } from '@/lib/audit/service'
import { expectRegistered } from '@/test-utils/audit'
import type { DbTransaction } from '@/lib/db/executor'
import type { Document, DocumentAnnotationReplyRow, PilotiWakeRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { filterUsersWhoMayReadFolder } from '@/lib/authz/folder-access'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'

import { GET as list } from './route'
import { DELETE as remove, PATCH as patch } from './[annotationId]/route'
import { POST as reply } from './[annotationId]/replies/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'GET', handler: list, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/, method: 'PATCH', handler: patch, params: ['id', 'annotationId'] },
  { pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/, method: 'DELETE', handler: remove, params: ['id', 'annotationId'] },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)\/replies$/,
    method: 'POST',
    handler: reply,
    params: ['id', 'annotationId'],
  },
]

const run = async (path: string, init?: RequestInit) => {
  const url = new URL(path, 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  const params = Object.fromEntries(route.params.map((name, index) => [name, decodeURIComponent(matched[index + 1])]))
  return route.handler(new Request(url, init), { params: Promise.resolve(params) })
}

const DOC_ID = '11111111-1111-4111-8111-111111111111'
const MARK_ID = '22222222-2222-4222-8222-222222222222'
const REPLY_ID = '33333333-3333-4333-8333-333333333333'

const DOC = { id: DOC_ID, organizationId: 'org_1', scope: 'project', projectId: 'proj_1', publishedVersionId: null } as Partial<Document> as Document

const MARK: AnnotationRecord = {
  id: MARK_ID,
  organizationId: 'org_1',
  documentId: DOC_ID,
  versionId: null,
  number: 4,
  page: 1,
  shape: 'point',
  x: 0.4,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Türbreite prüfen',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: 'user_2',
  dueOn: null,
  createdBy: 'user_2',
  createdAt: new Date('2026-10-13T08:00:00Z'),
  updatedAt: new Date('2026-10-13T08:00:00Z'),
  acceptedBy: null,
  acceptedAt: null,
  closedBy: null,
  closedAt: null,
  delegatedBy: null,
  delegatedAt: null,
  fassungNumber: null,
  replies: [],
}

/** The transaction the fake repository runs a write's hook in. */
const TX = { transaction: 'of the write' } as unknown as DbTransaction

let writable = true
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('REQUIRE_AUTH', 'true')
  session.featureFlags = ['piloti-wakes']
  writable = true
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, _id, intent) => {
    if (intent === 'write' && !writable) throw new ForbiddenError()
    return DOC
  })
  vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
  vi.mocked(listDocumentAnnotations).mockResolvedValue([MARK])
  vi.mocked(countWakes).mockResolvedValue(0)
  vi.mocked(insertWake).mockResolvedValue(true)
  vi.mocked(enqueueJob).mockResolvedValue({ jobId: 'job' })
  vi.mocked(findLiveDelegationWake).mockResolvedValue(null)
  vi.mocked(settleWake).mockResolvedValue(true)
  vi.mocked(insertAnnotationReply).mockImplementation(async (input, afterInsert) => {
    const row: DocumentAnnotationReplyRow = {
      id: REPLY_ID,
      createdAt: new Date(),
      ...input,
      addressesAgent: input.addressesAgent ?? false,
    }
    await afterInsert?.(TX, row)
    return row
  })
  vi.mocked(deleteDocumentAnnotation).mockImplementation(async (_org, _doc, _id, beforeDelete) => {
    await beforeDelete?.(TX)
    return true
  })
  vi.mocked(updateDocumentAnnotation).mockImplementation(async (_org, _doc, _id, _expected, changes, afterUpdate) => {
    const { transition, delegation, ...fields } = changes
    const row = { ...MARK, ...fields, ...(transition ?? {}), ...(delegation ?? {}) }
    await afterUpdate?.(TX, row)
    return row
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a reply that wakes Piloti', () => {
  it('enqueues exactly one wake, in the reply’s transaction, under the id of the reply, and says the server answers', async () => {
    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Stimmt das?', addressesPiloti: true }, { run })

    expect(result.wake).toBe('queued')
    expect(result.replyId).toBe(REPLY_ID)
    expect(insertAnnotationReply).toHaveBeenCalledWith(
      expect.objectContaining({ addressesAgent: true, authorKind: 'person' }),
      expect.any(Function)
    )
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    const [job, executor] = vi.mocked(enqueueJob).mock.calls[0]
    expect(executor).toBe(TX)
    expect(job).toMatchObject({
      kind: 'piloti_wake',
      organizationId: 'org_1',
      jobId: wakeTurnId(REPLY_ID),
      payload: {
        wakeId: wakeTurnId(REPLY_ID),
        trigger: 'thread_mention',
        eventId: REPLY_ID,
        documentId: DOC_ID,
        annotationId: MARK_ID,
        actor: { userId: 'user_1', email: 'a@grid.test' },
      },
    })
    expect(insertWake).toHaveBeenCalledWith(TX, expect.objectContaining({ id: wakeTurnId(REPLY_ID), status: 'queued' }))
  })

  it('wakes Piloti for a reply on its own open question, without an @', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, authorKind: 'piloti', kind: 'question', status: 'proposed' })

    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: '1,20 m.' }, { run })

    expect(result.wake).toBe('queued')
    expect(vi.mocked(enqueueJob).mock.calls[0][0].payload).toMatchObject({ trigger: 'thread_reply' })
  })

  it('enqueues nothing for a reply to people on a person’s mark', async () => {
    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Erledige ich.' }, { run })

    expect(result.wake).toBe('none')
    expect(vi.mocked(insertAnnotationReply).mock.calls[0][1]).toBeUndefined()
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(insertWake).not.toHaveBeenCalled()
  })

  it('refuses a reader: a person who may not write the document cannot wake Piloti on it', async () => {
    writable = false

    await expect(
      replyToAnnotation(DOC_ID, MARK_ID, { body: 'Stimmt das?', addressesPiloti: true }, { run })
    ).rejects.toMatchObject({ status: 403 })
    expect(insertAnnotationReply).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('answers `off` and enqueues nothing while the organization’s switch is off', async () => {
    session.featureFlags = []

    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Stimmt das?', addressesPiloti: true }, { run })

    expect(result.wake).toBe('off')
    // The reply still says it addressed Piloti: the browser asks it under the reply's turn id.
    expect(insertAnnotationReply).toHaveBeenCalledWith(expect.objectContaining({ addressesAgent: true }), undefined)
    expect(enqueueJob).not.toHaveBeenCalled()
    await expect(listAnnotations(DOC_ID, run)).resolves.toMatchObject({ pilotiWakes: false })
  })

  it('answers `suppressed` when a cap holds the wake, records it, and puts it in the audit trail', async () => {
    vi.mocked(countWakes).mockImplementation(async (_tx, query) => (query.annotationId ? 6 : 0))

    const result = await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Stimmt das?', addressesPiloti: true }, { run })

    expect(result.wake).toBe('suppressed')
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(insertWake).toHaveBeenCalledWith(TX, expect.objectContaining({ status: 'suppressed', reason: 'cap:mark-hour' }))
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'piloti.wake.suppressed',
        targetId: MARK_ID,
        metadata: expect.objectContaining({ reason: 'cap:mark-hour', stage: 'enqueue', status: 'suppressed' }),
      })
    )
  })
})

describe('a delegation to Piloti', () => {
  it('keeps the assignee, records who delegated, and enqueues one wake in the change’s transaction', async () => {
    const result = await updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: true }, { run })

    expect(result.wake).toBe('queued')
    const changes = vi.mocked(updateDocumentAnnotation).mock.calls[0][4]
    expect(changes.delegation).toEqual({ delegatedBy: 'user_1', delegatedAt: expect.any(Date) })
    expect(changes).not.toHaveProperty('assigneeUserId')
    const delegatedAt = changes.delegation?.delegatedAt as Date
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enqueueJob).mock.calls[0][1]).toBe(TX)
    expect(vi.mocked(enqueueJob).mock.calls[0][0].payload).toMatchObject({
      trigger: 'assigned',
      eventId: delegationEventId(MARK_ID, delegatedAt),
    })
  })

  it('is not a second event when the mark is already delegated', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_1', delegatedAt: new Date() })

    const result = await updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: true }, { run })

    expect(result.wake).toBeUndefined()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('takes the work back without waking Piloti', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_1', delegatedAt: new Date() })

    await updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: false }, { run })

    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4].delegation).toEqual({ delegatedBy: null, delegatedAt: null })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('is refused on a mark that is not open, and while the switch is off', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, authorKind: 'piloti', status: 'proposed' })
    await expect(updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: true }, { run })).rejects.toMatchObject({
      status: 422,
    })

    vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
    session.featureFlags = []
    await expect(updateAnnotationWithWake(DOC_ID, MARK_ID, { delegateToPiloti: true }, { run })).rejects.toMatchObject({
      status: 403,
    })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('never wakes Piloti when a person takes over or dismisses its proposal', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, authorKind: 'piloti', kind: 'question', status: 'proposed' })

    await updateAnnotationWithWake(DOC_ID, MARK_ID, { status: 'open' }, { run })
    await updateAnnotationWithWake(DOC_ID, MARK_ID, { status: 'dismissed' }, { run })

    expect(vi.mocked(updateDocumentAnnotation).mock.calls.every((call) => call[5] === undefined)).toBe(true)
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('ends with the mark: resolving a delegated mark clears the delegation', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_1', delegatedAt: new Date() })

    await updateAnnotationWithWake(DOC_ID, MARK_ID, { status: 'resolved' }, { run })

    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4].delegation).toEqual({ delegatedBy: null, delegatedAt: null })
  })
})

/** The wake of the mark's current delegation, as `findLiveDelegationWake` answers it. */
const liveWake = (status: 'queued' | 'started', actorUserId = 'user_1'): PilotiWakeRow => ({
  id: WAKE_ID,
  organizationId: 'org_1',
  documentId: DOC_ID,
  annotationId: MARK_ID,
  triggerKind: 'assigned',
  eventId: delegationEventId(MARK_ID, DELEGATED_AT),
  actorUserId,
  status,
  reason: null,
  createdAt: DELEGATED_AT,
  settledAt: status === 'queued' ? null : DELEGATED_AT,
  endedAt: null,
})

const WAKE_ID = '44444444-4444-4444-8444-444444444444'
const DELEGATED_AT = new Date('2026-10-13T09:00:00Z')
const DELEGATED: AnnotationRecord = { ...MARK, delegatedBy: 'user_1', delegatedAt: DELEGATED_AT }

/** The stop jobs the take-back queued, with the executor each went into. */
const stopJobs = () =>
  vi.mocked(enqueueJob).mock.calls.filter(([job]) => job.kind === 'piloti_wake_stop')

describe('a reply of Piloti’s on a delegated mark', () => {
  it('leaves the delegation alone: only the delegation’s own turn ending hands the mark back', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(DELEGATED)

    await replyAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { body: 'Erledigt.' }, PILOTI)

    const [input] = vi.mocked(insertAnnotationReply).mock.calls[0]
    expect(input).not.toHaveProperty('handBack')
    expect(input).toMatchObject({ authorKind: 'piloti', annotationId: MARK_ID })
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})

describe('taking a mark back from Piloti', () => {
  const takeBackBy = {
    'clearing the delegation': () => updateAnnotation(DOC_ID, MARK_ID, { delegateToPiloti: false }, { run }),
    'resolving the mark': () => updateAnnotation(DOC_ID, MARK_ID, { status: 'resolved' }, { run }),
  }

  beforeEach(() => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(DELEGATED)
  })

  for (const [how, takeBack] of Object.entries(takeBackBy)) {
    describe(how, () => {
      it('looks for the live wake of that delegation in the change’s own transaction', async () => {
        await takeBack()

        expect(findLiveDelegationWake).toHaveBeenCalledTimes(1)
        expect(findLiveDelegationWake).toHaveBeenCalledWith(TX, 'org_1', MARK_ID, delegationEventId(MARK_ID, DELEGATED_AT))
      })

      it('settles a queued wake `suppressed` (taken back), so its job never starts a turn, and stops nothing', async () => {
        vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('queued'))

        await takeBack()

        expect(settleWake).toHaveBeenCalledTimes(1)
        expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'suppressed', reason: 'taken back' })
        expect(stopJobs()).toHaveLength(0)
      })

      it('enqueues exactly one stop job, in the change’s transaction, for a wake whose turn runs', async () => {
        vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('started', 'user_3'))

        await takeBack()

        expect(stopJobs()).toHaveLength(1)
        const [job, executor] = stopJobs()[0]
        expect(executor).toBe(TX)
        expect(job).toMatchObject({
          kind: 'piloti_wake_stop',
          organizationId: 'org_1',
          payload: { wakeId: WAKE_ID, documentId: DOC_ID, annotationId: MARK_ID, actorUserId: 'user_3' },
        })
        // The turn ends `stopped` and says so itself: the wake is not ended from here.
        expect(settleWake).not.toHaveBeenCalled()
      })

      it('does nothing about a wake when there is none', async () => {
        await takeBack()

        expect(settleWake).not.toHaveBeenCalled()
        expect(enqueueJob).not.toHaveBeenCalled()
      })
    })
  }

  it('stops the turn of a wake that started between the read and the settle', async () => {
    vi.mocked(findLiveDelegationWake).mockResolvedValueOnce(liveWake('queued')).mockResolvedValueOnce(liveWake('started'))
    vi.mocked(settleWake).mockResolvedValue(false)

    await updateAnnotation(DOC_ID, MARK_ID, { delegateToPiloti: false }, { run })

    expect(stopJobs()).toHaveLength(1)
    expect(stopJobs()[0][1]).toBe(TX_DB)
  })

  it('does not touch a wake when the mark was not delegated', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)

    await updateAnnotation(DOC_ID, MARK_ID, { status: 'resolved' }, { run })

    expect(findLiveDelegationWake).not.toHaveBeenCalled()
  })

  it('stops the turn when the person deletes the mark, before its wakes go with it', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...DELEGATED, createdBy: 'user_1' })
    vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('started'))

    await deleteAnnotation(DOC_ID, MARK_ID, { run })

    expect(findLiveDelegationWake).toHaveBeenCalledWith(TX, 'org_1', MARK_ID, delegationEventId(MARK_ID, DELEGATED_AT))
    expect(stopJobs()).toHaveLength(1)
    expect(stopJobs()[0][1]).toBe(TX)
    expect(settleWake).not.toHaveBeenCalled()
  })

  it('deletes an undelegated mark with no hook in the transaction', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, createdBy: 'user_1' })

    await deleteAnnotation(DOC_ID, MARK_ID, { run })

    expect(vi.mocked(deleteDocumentAnnotation).mock.calls[0][3]).toBeUndefined()
  })

  it('never stops the turn when Piloti closes the mark in the asker’s name, which is usually that turn finishing', async () => {
    vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('started'))

    await updateAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { status: 'resolved' }, PILOTI)

    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4].delegation).toEqual({ delegatedBy: null, delegatedAt: null })
    expect(stopJobs()).toHaveLength(0)
  })

  it('still keeps a queued wake from starting when Piloti closes the mark', async () => {
    vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('queued'))

    await updateAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { status: 'resolved' }, PILOTI)

    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'suppressed', reason: 'taken back' })
  })
})

describe('what a person’s decision leaves behind', () => {
  const PROPOSAL: AnnotationRecord = { ...MARK, authorKind: 'piloti', kind: 'question', status: 'proposed', createdBy: 'user_1' }

  it('says the mark is settled once when a person answers in its thread', async () => {
    await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Erledigt ich.' }, { run })

    expect(onMarkSettledByPerson).toHaveBeenCalledTimes(1)
    expect(onMarkSettledByPerson).toHaveBeenCalledWith({
      organizationId: 'org_1',
      annotationId: MARK_ID,
      closed: false,
    })
  })

  it('says it once, closed, when a person resolves or dismisses the mark, and clears its rows when it is deleted', async () => {
    await updateAnnotation(DOC_ID, MARK_ID, { status: 'resolved' }, { run })
    expect(onMarkSettledByPerson).toHaveBeenCalledTimes(1)
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, status: 'resolved' })
    await updateAnnotation(DOC_ID, MARK_ID, { status: 'open' }, { run })
    expect(onMarkSettledByPerson).toHaveBeenCalledTimes(1)

    vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)
    await updateAnnotation(DOC_ID, MARK_ID, { status: 'dismissed' }, { run })
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, createdBy: 'user_1' })
    await deleteAnnotation(DOC_ID, MARK_ID, { run })

    expect(onMarkSettledByPerson).toHaveBeenCalledTimes(2)
    expect(vi.mocked(onMarkSettledByPerson).mock.calls.every(([call]) => call.closed)).toBe(true)
    expect(onMarkDeleted).toHaveBeenCalledTimes(1)
    expect(onMarkDeleted).toHaveBeenCalledWith({ organizationId: 'org_1', annotationId: MARK_ID })
  })

  it('does not call it for a reply of Piloti’s, or for a move that settles nothing (a rewording)', async () => {
    await replyAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { body: 'Erledigt.' }, PILOTI)
    await updateAnnotation(DOC_ID, MARK_ID, { body: 'Neu gefasst' }, { run })

    expect(onMarkSettledByPerson).not.toHaveBeenCalled()
  })

  it('scores a proposal once as accepted when a person takes it over, and does not call it settled', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await updateAnnotation(DOC_ID, MARK_ID, { status: 'open' }, { run })

    expect(recordDecisionScore).toHaveBeenCalledTimes(1)
    expect(recordDecisionScore).toHaveBeenCalledWith({
      subject: 'annotation',
      subjectId: MARK_ID,
      decision: 'accepted',
      decidedBy: 'user_1',
      organizationId: 'org_1',
    })
    expect(onMarkSettledByPerson).not.toHaveBeenCalled()
  })

  it('scores a proposal once as dismissed when a person dismisses it', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await updateAnnotation(DOC_ID, MARK_ID, { status: 'dismissed' }, { run })

    expect(recordDecisionScore).toHaveBeenCalledTimes(1)
    expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ decision: 'dismissed', subjectId: MARK_ID }))
  })

  it('scores no decision on a person’s own mark, a rewording of a proposal, or a move Piloti makes for the asker', async () => {
    await updateAnnotation(DOC_ID, MARK_ID, { status: 'resolved' }, { run })
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)
    await updateAnnotation(DOC_ID, MARK_ID, { body: 'Neu gefasst' }, { run })
    await updateAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { status: 'open' }, PILOTI)

    expect(recordDecisionScore).not.toHaveBeenCalled()
  })

  it('never breaks the write when either call throws or rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(onMarkSettledByPerson).mockImplementationOnce(() => {
      throw new Error('the inbox is down')
    })
    vi.mocked(recordDecisionScore).mockRejectedValueOnce(new Error('Langfuse is down'))
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await expect(updateAnnotation(DOC_ID, MARK_ID, { status: 'dismissed' }, { run })).resolves.toMatchObject({ id: MARK_ID })
    expect(onMarkSettledByPerson).toHaveBeenCalledTimes(1)
    expect(recordDecisionScore).toHaveBeenCalledTimes(1)

    vi.mocked(onMarkSettledByPerson).mockRejectedValueOnce(new Error('the inbox is down'))
    await expect(replyToAnnotation(DOC_ID, MARK_ID, { body: 'Noch eine.' }, { run })).resolves.toMatchObject({
      replyId: REPLY_ID,
    })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3))
    warn.mockRestore()
  })

  it('does not mark anything settled, or score anything, when the write itself is refused', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)
    vi.mocked(updateDocumentAnnotation).mockResolvedValue(null)

    await expect(updateAnnotation(DOC_ID, MARK_ID, { status: 'open' }, { run })).rejects.toMatchObject({ status: 409 })

    expect(recordDecisionScore).not.toHaveBeenCalled()
    expect(onMarkSettledByPerson).not.toHaveBeenCalled()
  })
})

/**
 * What a colleague's change or reply tells people (`./attention`), from the
 * service itself, so the route and Piloti for the asker go through the same
 * call. Who exactly hears it is `attention.spec.ts`; here, that each event is
 * named once, with the right facts, and filtered by who may open the document.
 */
describe('what a change or a reply tells people', () => {
  beforeEach(() => {
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
  })

  it('tells the new Zuständige and settles the previous one’s row when a person reassigns the mark', async () => {
    await updateAnnotation(DOC_ID, MARK_ID, { assigneeUserId: 'user_3' }, { run })

    expect(onAssigneeChanged).toHaveBeenCalledTimes(1)
    expect(onAssigneeChanged).toHaveBeenCalledWith({
      organizationId: 'org_1',
      documentId: DOC_ID,
      annotationId: MARK_ID,
      annotationNumber: 4,
      projectId: 'proj_1',
      actorUserId: 'user_1',
      byPiloti: false,
      markText: 'Türbreite prüfen',
      previousAssigneeUserId: 'user_2',
      assigneeUserId: 'user_3',
      open: true,
    })
  })

  it('refuses a Zuständige who is in the project but may not read the folder the document is filed in', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue({ ...DOC, folderId: 'fld_hr' })
    vi.mocked(filterUsersWhoMayReadFolder).mockResolvedValueOnce(new Set())

    await expect(updateAnnotation(DOC_ID, MARK_ID, { assigneeUserId: 'user_3' }, { run })).rejects.toMatchObject({
      status: 422,
    })

    expect(filterUsersWhoMayReadFolder).toHaveBeenCalledWith('org_1', 'proj_1', 'fld_hr', ['user_3'])
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
    expect(onAssigneeChanged).not.toHaveBeenCalled()
  })

  it('tells nobody new when the Zuständige stays, or only the wording changes', async () => {
    await updateAnnotation(DOC_ID, MARK_ID, { assigneeUserId: 'user_2' }, { run })
    await updateAnnotation(DOC_ID, MARK_ID, { body: 'Neu gefasst' }, { run })

    expect(onAssigneeChanged).not.toHaveBeenCalled()
    expect(onMarkMoved).not.toHaveBeenCalled()
  })

  it('tells the Zuständige a proposal already named once a person takes it over', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, authorKind: 'piloti', status: 'proposed', assigneeUserId: 'user_3' })

    await updateAnnotation(DOC_ID, MARK_ID, { status: 'open' }, { run })

    expect(onAssigneeChanged).toHaveBeenCalledWith(
      expect.objectContaining({ previousAssigneeUserId: null, assigneeUserId: 'user_3', open: true, byPiloti: false })
    )
    expect(onMarkMoved).not.toHaveBeenCalled()
  })

  it('says Piloti did it when Piloti assigns for the asker', async () => {
    await updateAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { assigneeUserId: 'user_3' }, PILOTI)

    expect(onAssigneeChanged).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'user_1', byPiloti: true }))
  })

  it('tells the author when someone resolves, dismisses or reopens their mark, and settles a closed one even when Piloti closed it', async () => {
    await updateAnnotation(DOC_ID, MARK_ID, { status: 'resolved' }, { run })
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, status: 'resolved' })
    await updateAnnotation(DOC_ID, MARK_ID, { status: 'open' }, { run })
    vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
    await updateAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { status: 'resolved' }, PILOTI)
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, authorKind: 'piloti', status: 'proposed' })
    await updateAnnotation(DOC_ID, MARK_ID, { status: 'dismissed' }, { run })

    expect(vi.mocked(onMarkMoved).mock.calls.map(([input]) => [input.move, input.byPiloti])).toEqual([
      ['resolved', false],
      ['reopened', false],
      ['resolved', true],
      ['dismissed', false],
    ])
    expect(vi.mocked(onMarkMoved).mock.calls[0][0]).toMatchObject({ actorUserId: 'user_1', mark: MARK, markText: 'Türbreite prüfen' })
    expect(vi.mocked(onMarkSettledByPerson).mock.calls.map(([input]) => input.closed)).toEqual([true, true, true])
  })

  it('tells the thread when a person replies, filtered by who may open the document now', async () => {
    await replyToAnnotation(DOC_ID, MARK_ID, { body: 'Ist bestellt.' }, { run })

    expect(onMarkReplied).toHaveBeenCalledTimes(1)
    const [input] = vi.mocked(onMarkReplied).mock.calls[0]
    expect(input).toMatchObject({
      annotationId: MARK_ID,
      annotationNumber: 4,
      actorUserId: 'user_1',
      byPiloti: false,
      mark: MARK,
      replyText: 'Ist bestellt.',
    })
    vi.mocked(userHoldsProjectPermission).mockImplementation(async (_session, _project, userId) => userId === 'user_2')
    await expect(input.mayOpen(['user_2', 'user_outside'])).resolves.toEqual(new Set(['user_2']))
  })

  it('tells the thread when Piloti replies, as the person its turn acted for', async () => {
    await replyAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { body: 'Steht im Schnitt B-B.' }, PILOTI)

    expect(onMarkReplied).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'user_1', byPiloti: true }))
  })

  it('tells the Zuständige a person names when setting a mark, and nobody when they name themselves or nobody', async () => {
    vi.mocked(insertDocumentAnnotations).mockImplementation(async (input) =>
      input.marks.map((mark, index) => ({ ...MARK, id: `${MARK_ID.slice(0, -1)}${index}`, ...mark, status: 'open' as const }))
    )
    const place = { page: 1, shape: 'point' as const, x: 0.1, y: 0.1, kind: 'defect' as const, body: 'Fluchtweg' }

    await createAs(session as unknown as AuthorizedSession, DOC_ID, { ...place, assigneeUserId: 'user_3' })
    await createAs(session as unknown as AuthorizedSession, DOC_ID, place)

    expect(onAssigneeChanged).toHaveBeenCalledTimes(1)
    expect(onAssigneeChanged).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeUserId: 'user_3', previousAssigneeUserId: null, actorUserId: 'user_1', markText: 'Fluchtweg' })
    )
  })
})

describe('the audit trail of a wake taken back', () => {
  const stopped = () =>
    vi.mocked(recordAuditEvent).mock.calls.map(([input]) => input).filter((input) => input.action === 'piloti.wake.stopped')
  // Whatever was emitted, WorkOS would accept: every target type and key is registered.
  afterEach(() => {
    for (const [input] of vi.mocked(recordAuditEvent).mock.calls) expectRegistered(input)
  })

  beforeEach(() => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(DELEGATED)
  })

  it('records one piloti.wake.stopped for a queued wake, as the person who took it back', async () => {
    vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('queued', 'user_3'))

    await updateAnnotation(DOC_ID, MARK_ID, { delegateToPiloti: false }, { run })

    expect(stopped()).toEqual([
      {
        action: 'piloti.wake.stopped',
        organizationId: 'org_1',
        actor: { userId: 'user_1', email: 'a@grid.test' },
        targetType: 'document_annotation',
        targetId: MARK_ID,
        alsoTargets: [
          { type: 'document', id: DOC_ID },
          { type: 'project', id: 'proj_1' },
          { type: 'conversation', id: documentThreadConversationId(DOC_ID, 'user_3') },
        ],
        metadata: { trigger: 'assigned', wakeId: WAKE_ID, wakeStatus: 'queued', wokenBy: 'user_3', by: 'person' },
      },
    ])
  })

  it('records one for a started wake whose stop the take-back enqueued', async () => {
    vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('started'))

    await updateAnnotation(DOC_ID, MARK_ID, { status: 'resolved' }, { run })

    expect(stopped()).toHaveLength(1)
    expect(stopped()[0].metadata).toMatchObject({ wakeStatus: 'started' })
  })

  it('records one for a wake that started between the read and the settle, and none for the settle that lost', async () => {
    vi.mocked(findLiveDelegationWake).mockResolvedValueOnce(liveWake('queued')).mockResolvedValueOnce(liveWake('started'))
    vi.mocked(settleWake).mockResolvedValue(false)

    await updateAnnotation(DOC_ID, MARK_ID, { delegateToPiloti: false }, { run })

    expect(stopped()).toHaveLength(1)
    expect(stopped()[0].metadata).toMatchObject({ wakeStatus: 'started' })
  })

  it('records nothing when there is no live wake, or the wake ended before the settle', async () => {
    await updateAnnotation(DOC_ID, MARK_ID, { delegateToPiloti: false }, { run })
    vi.mocked(findLiveDelegationWake).mockResolvedValueOnce(liveWake('queued')).mockResolvedValueOnce(null)
    vi.mocked(settleWake).mockResolvedValue(false)
    await updateAnnotation(DOC_ID, MARK_ID, { delegateToPiloti: false }, { run })

    expect(stopped()).toEqual([])
  })

  it('records the wakes a deleted mark took with it', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...DELEGATED, createdBy: 'user_1' })
    vi.mocked(findLiveDelegationWake).mockResolvedValueOnce(liveWake('started'))
    await deleteAnnotation(DOC_ID, MARK_ID, { run })
    vi.mocked(findLiveDelegationWake).mockResolvedValueOnce(liveWake('queued'))
    await deleteAnnotation(DOC_ID, MARK_ID, { run })

    expect(stopped().map((input) => input.metadata?.wakeStatus)).toEqual(['started', 'queued'])
  })

  it('says Piloti took it back when Piloti closed the mark, and records no stop of the turn it does not stop', async () => {
    vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('queued'))
    await updateAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { status: 'resolved' }, PILOTI)
    expect(stopped().map((input) => input.metadata?.by)).toEqual(['piloti'])

    vi.mocked(recordAuditEvent).mockClear()
    vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('started'))
    await updateAs(session as unknown as AuthorizedSession, DOC_ID, MARK_ID, { status: 'resolved' }, PILOTI)
    expect(stopped()).toEqual([])
  })

  it('takes the mark back when the trail fails', async () => {
    vi.mocked(findLiveDelegationWake).mockResolvedValue(liveWake('queued'))
    vi.mocked(recordAuditEvent).mockImplementationOnce(() => {
      throw new Error('WorkOS down')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await run(`/api/documents/${DOC_ID}/annotations/${MARK_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delegateToPiloti: false }),
    })

    expect(response.status).toBe(200)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('piloti.wake.stopped'), expect.any(Error))
    warn.mockRestore()
  })
})

describe('what a write reads back of Piloti’s work', () => {
  it('reads the wakes of the mark it wrote, not of the whole document, while the list reads the document’s', async () => {
    await updateAnnotation(DOC_ID, MARK_ID, { body: 'Neu gefasst' }, { run })
    expect(listLatestWakes).toHaveBeenCalled()
    for (const call of vi.mocked(listLatestWakes).mock.calls) expect(call).toEqual(['org_1', DOC_ID, MARK_ID])

    vi.mocked(listLatestWakes).mockClear()
    await listAnnotations(DOC_ID, run)
    expect(listLatestWakes).toHaveBeenCalledWith('org_1', DOC_ID, undefined)
  })
})
