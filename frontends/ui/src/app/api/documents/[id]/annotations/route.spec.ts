/**
 * @vitest-environment node
 */
/**
 * The Anmerkungen routes and their service, driven through the TYPED CLIENT
 * (ADR-0055): the browser uses the same functions, so a path or a field the two
 * disagreed on would fail here.
 *
 * The document reader, the repository and the room are mocked; what is under
 * test is the service's rules between them: access follows the document, a
 * read-only reader gets the list without the controls, the Fassung a mark was
 * set on decides whether it is drawn, a region stays on its page, a proposal
 * becomes the office's only by a person, a status move carries its
 * bookkeeping and loses to a colleague's earlier move, only the person who set
 * a mark (or Piloti, for the person it set it for) deletes it, the person a
 * reply was posted for deletes that, and every write tells the room.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'a@grid.test',
    name: 'Anna Berger',
    role: 'member',
    permissions: [],
  }),
}))

vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({ PERMISSION_CHECKS_AT_ONCE: 8, userHoldsProjectPermission: vi.fn(), resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/annotations/repository', () => ({
  AnnotationLimitReachedError: class AnnotationLimitReachedError extends Error {},
  ReplyLimitReachedError: class ReplyLimitReachedError extends Error {},
  listDocumentAnnotations: vi.fn(),
  findDocumentAnnotation: vi.fn(),
  insertDocumentAnnotations: vi.fn(),
  updateDocumentAnnotation: vi.fn(),
  deleteDocumentAnnotation: vi.fn(),
  deleteAnnotationReply: vi.fn(),
  insertAnnotationReply: vi.fn(),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  AnnotationRequestError,
  createAnnotation,
  deleteAnnotation,
  getAnnotation,
  listAnnotations,
  replyToAnnotation,
  updateAnnotation,
} from '@/lib/annotations/client'
import { deleteReply } from '@/lib/annotations/service'
import {
  AnnotationLimitReachedError,
  deleteAnnotationReply,
  deleteDocumentAnnotation,
  findDocumentAnnotation,
  insertAnnotationReply,
  insertDocumentAnnotations,
  listDocumentAnnotations,
  updateDocumentAnnotation,
  type AnnotationRecord,
} from '@/lib/annotations/repository'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { recordAuditEvent } from '@/lib/audit/service'
import { expectRegistered } from '@/test-utils/audit'

import { GET as list, POST as create } from './route'
import { DELETE as remove, GET as readOne, PATCH as patch } from './[annotationId]/route'
import { POST as reply } from './[annotationId]/replies/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'GET', handler: list, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/annotations$/, method: 'POST', handler: create, params: ['id'] },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/,
    method: 'GET',
    handler: readOne,
    params: ['id', 'annotationId'],
  },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/,
    method: 'PATCH',
    handler: patch,
    params: ['id', 'annotationId'],
  },
  {
    pattern: /^\/api\/documents\/([^/]+)\/annotations\/([^/]+)$/,
    method: 'DELETE',
    handler: remove,
    params: ['id', 'annotationId'],
  },
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

const DOC = {
  id: 'doc_1',
  organizationId: 'org_1',
  scope: 'project',
  projectId: 'proj_1',
  publishedVersionId: 'ver_2',
} as Partial<Document> as Document

const RECORD: AnnotationRecord = {
  id: 'ann_1',
  organizationId: 'org_1',
  documentId: 'doc_1',
  versionId: 'ver_2',
  number: 1,
  page: 3,
  shape: 'point',
  x: 0.25,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Tür T30 fehlt im Fluchtweg',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  dueOn: null,
  createdBy: 'user_1',
  createdAt: new Date('2026-10-01T08:00:00Z'),
  updatedAt: new Date('2026-10-01T08:00:00Z'),
  acceptedBy: null,
  acceptedAt: null,
  closedBy: null,
  closedAt: null,
  delegatedBy: null,
  delegatedAt: null,
  fassungNumber: 2,
  replies: [],
}

const PROPOSAL: AnnotationRecord = {
  ...RECORD,
  id: 'ann_p',
  authorKind: 'piloti',
  status: 'proposed',
  shape: 'region',
  w: 0.2,
  h: 0.1,
  basis: 'OIB-RL 2, Pkt. 3.5.2',
}

let writable = true
beforeEach(() => {
  vi.clearAllMocks()
  writable = true
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, _id, intent) => {
    if (intent === 'write' && !writable) throw new ForbiddenError()
    return DOC
  })
  vi.mocked(findDocumentAnnotation).mockResolvedValue(RECORD)
  vi.mocked(insertDocumentAnnotations).mockResolvedValue([RECORD])
  vi.mocked(updateDocumentAnnotation).mockResolvedValue(RECORD)
  vi.mocked(deleteDocumentAnnotation).mockResolvedValue(true)
  vi.mocked(deleteAnnotationReply).mockResolvedValue(true)
  vi.mocked(insertAnnotationReply).mockResolvedValue({
    id: 'rep_1',
    organizationId: 'org_1',
    annotationId: 'ann_1',
    authorKind: 'person',
    body: 'x',
    createdBy: 'user_1',
    createdAt: new Date(),
    addressesAgent: false,
  })
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      ['user_1', { userId: 'user_1', email: null, name: 'Anna Berger', profilePictureUrl: null }],
      ['user_in', { userId: 'user_in', email: null, name: 'Jakob Huber', profilePictureUrl: null }],
    ])
  )
})

describe('GET /api/documents/[id]/annotations', () => {
  it('lists live ones first, by page, and says which were set on an earlier Fassung', async () => {
    vi.mocked(listDocumentAnnotations).mockResolvedValue([
      { ...RECORD, id: 'a', number: 1, status: 'resolved', closedBy: 'user_2', closedAt: new Date() },
      { ...RECORD, id: 'b', number: 2, page: 4, versionId: 'ver_1', fassungNumber: 1 },
      { ...PROPOSAL, id: 'c', number: 3, page: 3 },
    ])

    const result = await listAnnotations('doc_1', run)

    expect(result.canAnnotate).toBe(true)
    expect(result.annotations.map((a) => a.id)).toEqual(['c', 'b', 'a'])
    expect(result.annotations.map((a) => a.onCurrentFassung)).toEqual([true, false, true])
    expect(result.annotations[0]).toMatchObject({
      shape: 'region',
      w: 0.2,
      authorKind: 'piloti',
      createdByName: 'Anna Berger',
    })
  })

  it('gives a reader who may not write the list without the controls', async () => {
    writable = false
    vi.mocked(listDocumentAnnotations).mockResolvedValue([RECORD])

    const result = await listAnnotations('doc_1', run)

    expect(result.canAnnotate).toBe(false)
    expect(result.annotations[0]).toMatchObject({ canEdit: false, canDelete: false })
  })

  it('lists them without names when the directory cannot be read', async () => {
    vi.mocked(listDocumentAnnotations).mockResolvedValue([{ ...RECORD, assigneeUserId: 'user_in' }])
    vi.mocked(loadOrganizationDirectory).mockRejectedValue(new Error('WorkOS down'))

    const result = await listAnnotations('doc_1', run)

    expect(result.annotations[0]).toMatchObject({ assigneeName: null, createdByName: null })
  })

  it('is not found for a document the reader cannot read', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())

    await expect(listAnnotations('doc_x', run)).rejects.toMatchObject({ status: 404 })
    expect(listDocumentAnnotations).not.toHaveBeenCalled()
  })

  it('carries none on a chat attachment', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue({ ...DOC, scope: 'session' } as Document)

    await expect(listAnnotations('doc_1', run)).resolves.toEqual({ annotations: [], canAnnotate: false, pilotiWakes: false })
  })
})

describe('GET /api/documents/[id]/annotations/[annotationId]', () => {
  it('reads one mark as the list would show it to this reader', async () => {
    writable = false

    const mark = await getAnnotation('doc_1', 'ann_1', run)

    expect(findDocumentAnnotation).toHaveBeenCalledWith('org_1', 'doc_1', 'ann_1')
    expect(mark).toMatchObject({ id: 'ann_1', number: 1, canEdit: false, createdByName: 'Anna Berger' })
  })

  it('is not found for a mark that is gone, so a hint about it takes it off the list', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValueOnce(null)

    await expect(getAnnotation('doc_1', 'ann_gone', run)).rejects.toMatchObject({ status: 404 })
  })
})

describe('POST /api/documents/[id]/annotations', () => {
  it('sets a region on the Fassung shown now, as a person, and tells the room which tab did it', async () => {
    await createAnnotation(
      'doc_1',
      { page: 3, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.2, kind: 'defect', body: '  Brüstung zu niedrig  ' },
      { peerId: 'peer_abcdef12', run }
    )

    expect(insertDocumentAnnotations).toHaveBeenCalledWith({
      organizationId: 'org_1',
      documentId: 'doc_1',
      versionId: 'ver_2',
      authorKind: 'person',
      createdBy: 'user_1',
      marks: [expect.objectContaining({ shape: 'region', w: 0.3, h: 0.2, body: 'Brüstung zu niedrig', basis: null })],
    })
    expect(publishToDocumentRoom).toHaveBeenCalledWith('doc_1', {
      kind: 'annotations.changed',
      annotationIds: ['ann_1'],
      change: 'created',
      actor: { peerId: 'peer_abcdef12', userId: 'user_1', name: 'Anna Berger', kind: 'person' },
    })
  })

  it('refuses a point with a size, a region off its page, an empty body and a bad date before reading anything', async () => {
    for (const input of [
      { page: 1, shape: 'point', x: 0.2, y: 0.5, w: 0.1, h: 0.1, kind: 'hint', body: 'x' },
      { page: 1, shape: 'region', x: 0.8, y: 0.5, w: 0.3, h: 0.1, kind: 'hint', body: 'x' },
      { page: 1, shape: 'region', x: 0.2, y: 0.5, kind: 'hint', body: 'x' },
      { page: 1, shape: 'point', x: 0.2, y: 0.5, kind: 'hint', body: '   ' },
      { page: 1, shape: 'point', x: 0.2, y: 0.5, kind: 'hint', body: 'x', dueOn: '14.10.2026' },
    ]) {
      await expect(createAnnotation('doc_1', input as never, { run })).rejects.toMatchObject({ status: 400 })
    }
    expect(getAccessibleDocument).not.toHaveBeenCalled()
  })

  it('is refused to a reader who may not write in the folder', async () => {
    writable = false

    await expect(
      createAnnotation('doc_1', { page: 1, shape: 'point', x: 0.1, y: 0.1, kind: 'hint', body: 'x' }, { run })
    ).rejects.toMatchObject({ status: 403 })
    expect(insertDocumentAnnotations).not.toHaveBeenCalled()
  })

  it('refuses an assignee who cannot open the project', async () => {
    vi.mocked(userHoldsProjectPermission).mockResolvedValueOnce(false)

    await expect(
      createAnnotation(
        'doc_1',
        { page: 1, shape: 'point', x: 0.1, y: 0.1, kind: 'question', body: 'x', assigneeUserId: 'user_out' },
        { run }
      )
    ).rejects.toMatchObject({ status: 422 })
    expect(insertDocumentAnnotations).not.toHaveBeenCalled()
  })

  it('says so when a document is full', async () => {
    vi.mocked(insertDocumentAnnotations).mockRejectedValue(new AnnotationLimitReachedError())

    await expect(
      createAnnotation('doc_1', { page: 1, shape: 'point', x: 0.1, y: 0.1, kind: 'hint', body: 'x' }, { run })
    ).rejects.toMatchObject({ status: 422 })
  })
})

describe('PATCH /api/documents/[id]/annotations/[annotationId]', () => {
  it('takes a proposal over: open, accepted by the person, compared against „proposed"', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await updateAnnotation('doc_1', 'ann_p', { status: 'open' }, { run })

    expect(updateDocumentAnnotation).toHaveBeenCalledWith('org_1', 'doc_1', 'ann_p', 'proposed', {
      transition: {
        status: 'open',
        closedBy: null,
        closedAt: null,
        acceptedBy: 'user_1',
        acceptedAt: expect.any(Date),
      },
    }, undefined)
  })

  it('refuses a take-over from a copy once a colleague dismissed the proposal, rather than reopening it', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...PROPOSAL, status: 'dismissed' })

    const failure = await updateAnnotation('doc_1', 'ann_p', { status: 'open', expectedStatus: 'proposed' }, { run }).catch(
      (error: unknown) => error
    )

    expect(failure).toMatchObject({ status: 409 })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })

  it('dismisses a proposal as closed by the person', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await updateAnnotation('doc_1', 'ann_p', { status: 'dismissed' }, { run })

    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4]).toEqual({
      transition: { status: 'dismissed', closedBy: 'user_1', closedAt: expect.any(Date) },
    })
  })

  it('resolves an open one and reopens a resolved one', async () => {
    await updateAnnotation('doc_1', 'ann_1', { status: 'resolved' }, { run })
    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][4]).toEqual({
      transition: { status: 'resolved', closedBy: 'user_1', closedAt: expect.any(Date) },
    })

    vi.mocked(findDocumentAnnotation).mockResolvedValue({
      ...RECORD,
      status: 'resolved',
      closedBy: 'user_2',
      closedAt: new Date(),
    })
    await updateAnnotation('doc_1', 'ann_1', { status: 'open' }, { run })
    expect(vi.mocked(updateDocumentAnnotation).mock.calls[1][4]).toEqual({
      transition: { status: 'open', closedBy: null, closedAt: null },
    })
  })

  it('refuses a move that does not exist: a proposal cannot be resolved before anyone took it over', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)

    await expect(updateAnnotation('doc_1', 'ann_p', { status: 'resolved' }, { run })).rejects.toMatchObject({
      status: 409,
    })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })

  it('loses to a colleague who moved it first, rather than overwriting them', async () => {
    vi.mocked(updateDocumentAnnotation).mockResolvedValue(null)

    await expect(updateAnnotation('doc_1', 'ann_1', { status: 'resolved' }, { run })).rejects.toMatchObject({
      status: 409,
    })
    expect(publishToDocumentRoom).not.toHaveBeenCalled()
  })

  describe("a decision on Piloti's proposed mark, in the audit trail", () => {
    const decided = () =>
      vi.mocked(recordAuditEvent).mock.calls.map(([input]) => input).filter((input) => input.action === 'piloti.mark.decided')
    afterEach(() => {
      for (const [input] of vi.mocked(recordAuditEvent).mock.calls) expectRegistered(input)
    })

    it.each([
      ['open', 'taken_over'],
      ['dismissed', 'dismissed'],
    ] as const)('records %s once, as the person deciding, for the person it was proposed for', async (status, decision) => {
      vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...PROPOSAL, createdBy: 'user_in', number: 7 })

      await updateAnnotation('doc_1', 'ann_p', { status, expectedStatus: 'proposed' }, { run })

      expect(decided()).toEqual([
        {
          action: 'piloti.mark.decided',
          organizationId: 'org_1',
          actor: { userId: 'user_1', email: 'a@grid.test' },
          targetType: 'document_annotation',
          targetId: 'ann_p',
          alsoTargets: [
            { type: 'document', id: 'doc_1' },
            { type: 'project', id: 'proj_1' },
          ],
          metadata: { decision, markNumber: 7, markKind: 'defect', onBehalfOf: 'user_in' },
        },
      ])
    })

    it('records nothing when a colleague moved it first, or for a move that is not a decision', async () => {
      vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...PROPOSAL, status: 'dismissed' })
      await updateAnnotation('doc_1', 'ann_p', { status: 'open', expectedStatus: 'proposed' }, { run }).catch(() => null)

      vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)
      vi.mocked(updateDocumentAnnotation).mockResolvedValueOnce(null)
      await updateAnnotation('doc_1', 'ann_p', { status: 'dismissed', expectedStatus: 'proposed' }, { run }).catch(() => null)

      // A person's own mark, and a reword of a proposal: no decision on Piloti's work.
      vi.mocked(findDocumentAnnotation).mockResolvedValue(RECORD)
      await updateAnnotation('doc_1', 'ann_1', { status: 'resolved' }, { run })
      vi.mocked(findDocumentAnnotation).mockResolvedValue(PROPOSAL)
      await updateAnnotation('doc_1', 'ann_p', { body: 'Tür T30 fehlt' }, { run })

      expect(decided()).toEqual([])
    })
  })

  it('refuses an empty change and a change to the place', async () => {
    await expect(updateAnnotation('doc_1', 'ann_1', {}, { run })).rejects.toMatchObject({ status: 400 })
    await expect(updateAnnotation('doc_1', 'ann_1', { x: 0.3 } as never, { run })).rejects.toMatchObject({
      status: 400,
    })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/documents/[id]/annotations/[annotationId]', () => {
  it('deletes one the caller set, and tells the room', async () => {
    await expect(deleteAnnotation('doc_1', 'ann_1', { run })).resolves.toBeUndefined()
    expect(deleteDocumentAnnotation).toHaveBeenCalledWith('org_1', 'doc_1', 'ann_1', undefined)
    expect(publishToDocumentRoom).toHaveBeenCalledWith('doc_1', expect.objectContaining({ change: 'deleted' }))
  })

  it("refuses one somebody else set, and Piloti's proposals, which are dismissed instead", async () => {
    for (const record of [{ ...RECORD, createdBy: 'user_2' }, PROPOSAL]) {
      vi.mocked(findDocumentAnnotation).mockResolvedValue(record)
      const error = await deleteAnnotation('doc_1', record.id, { run }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AnnotationRequestError)
      expect(error).toMatchObject({ status: 403 })
    }
    expect(deleteDocumentAnnotation).not.toHaveBeenCalled()
  })

  describe("a mark Piloti set (author 'piloti')", () => {
    // Piloti works in the asker's session, so `created_by` is the asker; `accepted_by` is the asker when the mark was
    // born open at their request.
    const SET_FOR_ASKER: AnnotationRecord = { ...RECORD, id: 'ann_s', authorKind: 'piloti', createdBy: 'user_1', acceptedBy: 'user_1' }

    it('is deleted by the person it was set for, like their own, and shown to them as deletable', async () => {
      vi.mocked(findDocumentAnnotation).mockResolvedValue(SET_FOR_ASKER)
      vi.mocked(listDocumentAnnotations).mockResolvedValue([SET_FOR_ASKER])
      expect((await listAnnotations('doc_1', run)).annotations[0]).toMatchObject({ canDelete: true })

      await expect(deleteAnnotation('doc_1', 'ann_s', { run })).resolves.toBeUndefined()
      expect(deleteDocumentAnnotation).toHaveBeenCalledWith('org_1', 'doc_1', 'ann_s', undefined)
      expect(publishToDocumentRoom).toHaveBeenCalledWith('doc_1', expect.objectContaining({ change: 'deleted' }))
    })

    it('is refused to another member, to whoever took a proposal over that was not theirs, and for an untaken proposal', async () => {
      const others: AnnotationRecord[] = [
        // Set for user_2; user_1 is only a colleague.
        { ...SET_FOR_ASKER, createdBy: 'user_2', acceptedBy: 'user_2' },
        // Proposed in user_2's turn, taken over by user_1: two people behind it, so it is resolved, never deleted.
        { ...SET_FOR_ASKER, createdBy: 'user_2', acceptedBy: 'user_1' },
        // Proposed in user_1's turn and taken over by user_2.
        { ...SET_FOR_ASKER, createdBy: 'user_1', acceptedBy: 'user_2' },
        { ...PROPOSAL, createdBy: 'user_1' },
      ]
      for (const record of others) {
        vi.mocked(findDocumentAnnotation).mockResolvedValue(record)
        await expect(deleteAnnotation('doc_1', record.id, { run })).rejects.toMatchObject({ status: 403 })
        vi.mocked(listDocumentAnnotations).mockResolvedValue([record])
        expect((await listAnnotations('doc_1', run)).annotations[0]).toMatchObject({ canDelete: false })
      }
      expect(deleteDocumentAnnotation).not.toHaveBeenCalled()
    })
  })
})

describe('deleteReply (the service; undo is its caller)', () => {
  const session = {
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'a@grid.test',
    name: 'Anna Berger',
    role: 'member',
    permissions: [],
  } as unknown as Parameters<typeof deleteReply>[0]
  const reply = (patch: Partial<AnnotationRecord['replies'][number]> = {}): AnnotationRecord['replies'][number] => ({
    id: 'rep_1',
    organizationId: 'org_1',
    annotationId: 'ann_1',
    authorKind: 'piloti',
    body: 'Auf Mittwoch gesetzt.',
    createdBy: 'user_1',
    createdAt: new Date('2026-10-01T08:00:00Z'),
    addressesAgent: false,
    ...patch,
  })
  const withReplies = (...replies: AnnotationRecord['replies']) =>
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...RECORD, replies })

  it("deletes the person's own reply and Piloti's reply posted for them, and tells the room", async () => {
    for (const authorKind of ['piloti', 'person'] as const) {
      vi.mocked(publishToDocumentRoom).mockClear()
      withReplies(reply({ authorKind }))

      await expect(deleteReply(session, 'doc_1', 'ann_1', 'rep_1')).resolves.toBeNull()
      expect(deleteAnnotationReply).toHaveBeenLastCalledWith('org_1', 'ann_1', 'rep_1', undefined)
      expect(publishToDocumentRoom).toHaveBeenCalledWith(
        'doc_1',
        expect.objectContaining({ kind: 'annotations.changed', annotationIds: ['ann_1'], change: 'updated' })
      )
    }
  })

  it('refuses a reply posted for somebody else, a reader who may not write, and a reply that is not there', async () => {
    withReplies(reply({ createdBy: 'user_2' }), reply({ id: 'rep_2', authorKind: 'person', createdBy: 'user_2' }))
    await expect(deleteReply(session, 'doc_1', 'ann_1', 'rep_1')).rejects.toMatchObject({ status: 403 })
    await expect(deleteReply(session, 'doc_1', 'ann_1', 'rep_2')).rejects.toMatchObject({ status: 403 })
    await expect(deleteReply(session, 'doc_1', 'ann_1', 'rep_9')).rejects.toMatchObject({ status: 404 })

    withReplies(reply())
    writable = false
    await expect(deleteReply(session, 'doc_1', 'ann_1', 'rep_1')).rejects.toMatchObject({ status: 403 })

    expect(deleteAnnotationReply).not.toHaveBeenCalled()
    expect(publishToDocumentRoom).not.toHaveBeenCalled()
  })

  it('compares the body when asked: a reply that says something else stays, with a 409', async () => {
    withReplies(reply({ body: 'Geändert.' }))
    await expect(deleteReply(session, 'doc_1', 'ann_1', 'rep_1', { expectedBody: 'Auf Mittwoch gesetzt.' })).rejects.toMatchObject({
      status: 409,
    })
    expect(deleteAnnotationReply).not.toHaveBeenCalled()

    // It changed between the read and the delete: the repository's compare finds no row.
    withReplies(reply())
    vi.mocked(deleteAnnotationReply).mockResolvedValueOnce(false)
    await expect(deleteReply(session, 'doc_1', 'ann_1', 'rep_1', { expectedBody: 'Auf Mittwoch gesetzt.' })).rejects.toMatchObject({
      status: 409,
    })
    expect(deleteAnnotationReply).toHaveBeenCalledWith('org_1', 'ann_1', 'rep_1', 'Auf Mittwoch gesetzt.')
    expect(publishToDocumentRoom).not.toHaveBeenCalled()
  })
})

describe('POST /api/documents/[id]/annotations/[annotationId]/replies', () => {
  it('answers in the thread as the person, trimmed, and tells the room', async () => {
    await replyToAnnotation('doc_1', 'ann_1', { body: '  Ist im Index D drin.  ' }, { run })

    expect(insertAnnotationReply).toHaveBeenCalledWith(
      {
        organizationId: 'org_1',
        annotationId: 'ann_1',
        authorKind: 'person',
        body: 'Ist im Index D drin.',
        createdBy: 'user_1',
        addressesAgent: false,
      },
      // A reply on a person's mark that does not address Piloti wakes nothing.
      undefined
    )
    expect(publishToDocumentRoom).toHaveBeenCalledWith('doc_1', expect.objectContaining({ change: 'replied' }))
  })

  it('is refused to a reader who may not write', async () => {
    writable = false

    await expect(replyToAnnotation('doc_1', 'ann_1', { body: 'x' }, { run })).rejects.toMatchObject({ status: 403 })
    expect(insertAnnotationReply).not.toHaveBeenCalled()
  })
})
