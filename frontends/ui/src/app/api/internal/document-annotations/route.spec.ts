/**
 * @vitest-environment node
 */
/**
 * Piloti's hands on Anmerkungen (`POST /api/internal/document-annotations`).
 *
 * What is pinned here: the document is the conversation's subject unless the
 * turn names one, and a named one is admitted only inside the collections the
 * turn's envelope signs (anything else is an unknown document); with neither,
 * a typed 422 the tool relays; a held upload reaches no model; a subject in a
 * restricted folder is admitted against the conversation first; and what
 * Piloti finds on its own is born a proposal, on behalf of the asker, under the
 * asker's own access rules.
 *
 * And parity: what the asker asks for, Piloti does as the asker could, through
 * the REAL service (`set`, `update`, `delete` run `lib/annotations/service.ts`
 * over a fake repository): a mark asked for is born open with the asker behind
 * it, a change posts Piloti's note in the thread, a stale `expectedStatus` is
 * a 409 with no note, and nothing the asker could not do goes through. Every
 * row the fake holds is checked against the CHECKs of migration 0138.
 *
 * Parity is the organization's choice (`piloti-acts`, an entitlement, off by
 * default): with it off, `create`, `update` and `delete` are refused with
 * `piloti-acts-off` before anything is read or written, and proposals,
 * replies, reads and the room run as ever. The flag is read the real way, off
 * the pinned session's flags in a deployment that signs people in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/api/internal-envelope', () => ({
  requireVerifiedContext: vi.fn(),
  requirePinnedSession: vi.fn(),
}))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/documents/version-content', () => ({ admitSubjectRead: vi.fn() }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/realtime/document-channel', () => ({
  pilotiPeer: (conversationId: string, userId: string) => ({ peerId: `piloti-${conversationId}`, userId }),
  publishAsAgent: vi.fn(),
  publishToDocumentRoom: vi.fn(async () => undefined),
  roomSnapshot: vi.fn(),
}))
// The read, propose and reply paths are pinned at the agent seam; the parity
// paths (`create`, `update`, `delete`) run the real service, whose own calls
// stay real inside it.
vi.mock('@/lib/annotations/service', async (original) => ({
  ...(await original<typeof import('@/lib/annotations/service')>()),
  listAnnotationsForAgent: vi.fn(),
  proposeAnnotations: vi.fn(),
  replyToAnnotation: vi.fn(),
}))
vi.mock('@/lib/annotations/repository', async (original) => ({
  ...(await original<typeof import('@/lib/annotations/repository')>()),
  findDocumentAnnotation: vi.fn(),
  listDocumentAnnotations: vi.fn(),
  insertDocumentAnnotations: vi.fn(),
  updateDocumentAnnotation: vi.fn(),
  deleteDocumentAnnotation: vi.fn(),
  insertAnnotationReply: vi.fn(),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({ PERMISSION_CHECKS_AT_ONCE: 8, userHoldsProjectPermission: vi.fn(), resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant-context')>()),
  withTenant: (_scope: unknown, run: () => unknown) => run(),
}))
// The change record (ADR-0109) and the attention a write asks for, at their seams.
vi.mock('@/lib/changes/repository', () => ({ insertPilotiChanges: vi.fn(async () => []) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/annotations/attention', () => ({
  onPilotiWrote: vi.fn(async () => undefined),
  onMarkSettledByPerson: vi.fn(async () => undefined),
  onWakeEnded: vi.fn(async () => undefined),
  onAssigneeChanged: vi.fn(async () => undefined),
  onMarkReplied: vi.fn(async () => undefined),
  onMarkMoved: vi.fn(async () => undefined),
  onMarkDeleted: vi.fn(async () => undefined),
}))

import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { listAnnotationsForAgent, proposeAnnotations, replyToAnnotation } from '@/lib/annotations/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findConversationInOrg } from '@/lib/conversations/repository'
import type { Conversation, Document } from '@/lib/db/schema'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { getAccessibleDocument } from '@/lib/documents/access'
import { admitSubjectRead } from '@/lib/documents/version-content'
import { publishAsAgent, roomSnapshot } from '@/lib/realtime/document-channel'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  deleteDocumentAnnotation,
  findDocumentAnnotation,
  insertAnnotationReply,
  insertDocumentAnnotations,
  listDocumentAnnotations,
  updateDocumentAnnotation,
  type AnnotationChanges,
  type AnnotationRecord,
  type NewAnnotationsInput,
} from '@/lib/annotations/repository'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { DocumentAnnotationReplyRow, DocumentAnnotationRow } from '@/lib/db/schema'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { onAssigneeChanged, onMarkMoved, onMarkReplied, onMarkSettledByPerson, onPilotiWrote } from '@/lib/annotations/attention'
import { insertPilotiChanges } from '@/lib/changes/repository'
import { recordAuditEvent, type AuditEventInput } from '@/lib/audit/service'
import { expectRegistered } from '@/test-utils/audit'
import type { PilotiChangeRow } from '@/lib/db/schema/piloti-changes'
import { POST } from './route'

const SECRET = 'test-internal-token-annotations'
const DOC_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_DOC = '22222222-2222-4222-8222-222222222222'
/** The asker's pinned session; its flags are WorkOS's answer for the organization. */
const SESSION = { userId: 'user_1', organizationId: 'org_1', featureFlags: ['piloti-acts'] } as Partial<AuthorizedSession> as AuthorizedSession
const CONTEXT = {
  organizationId: 'org_1',
  userId: 'user_1',
  projectId: 'proj_1',
  conversationId: 'conv_1',
  issuedAt: Date.now(),
  collectionScope: ['proj_1_docs'],
} as Partial<VerifiedGridRequestContext> as VerifiedGridRequestContext

const post = (body: unknown) =>
  POST(
    new Request('https://grid.test/api/internal/document-annotations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grid-internal-token': SECRET },
      body: JSON.stringify(body),
    })
  )

const PROPOSAL = {
  page: 1,
  shape: 'region',
  x: 0.1,
  y: 0.2,
  w: 0.3,
  h: 0.1,
  kind: 'defect',
  body: 'Tür ohne Feuerwiderstandsklasse',
  basis: 'OIB-RL 2, Pkt. 3.4',
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  // Flags come from WorkOS (the session's claim), as wherever people sign in.
  vi.stubEnv('REQUIRE_AUTH', 'true')
  SESSION.featureFlags = ['piloti-acts']
  vi.mocked(requireVerifiedContext).mockReturnValue(CONTEXT)
  vi.mocked(requirePinnedSession).mockResolvedValue(SESSION)
  vi.mocked(findConversationInOrg).mockResolvedValue({
    subjectResourceType: 'document',
    subjectResourceId: DOC_ID,
  } as Partial<Conversation> as Conversation)
  vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
    ({
      id,
      filename: id === DOC_ID ? 'Grundriss EG.pdf' : 'Schnitt A-A.pdf',
      collectionName: 'proj_1_docs',
      projectId: 'proj_1',
    }) as Partial<Document> as Document
  )
  vi.mocked(admitSubjectRead).mockResolvedValue(false)
  vi.mocked(listAnnotationsForAgent).mockResolvedValue({ documentId: DOC_ID, annotations: [] })
  vi.mocked(proposeAnnotations).mockResolvedValue({
    annotations: [{ id: 'ann_1', number: 4, ...PROPOSAL }] as never,
  })
})

afterEach(() => {
  delete process.env.GRID_INTERNAL_API_TOKEN
  vi.unstubAllEnvs()
})

describe('POST /api/internal/document-annotations', () => {
  it("reads the conversation's subject as the asker", async () => {
    const response = await post({ op: 'list' })

    expect(response.status).toBe(200)
    expect(listAnnotationsForAgent).toHaveBeenCalledWith(SESSION, DOC_ID)
    expect(findDocumentInOrg).toHaveBeenCalledWith(DOC_ID, 'org_1', expect.anything())
    await expect(response.json()).resolves.toMatchObject({ documentName: 'Grundriss EG.pdf' })
  })

  it('proposes on the subject, as Piloti for the asker, and says which numbers it took', async () => {
    const response = await post({ op: 'propose', proposals: [PROPOSAL] })

    expect(response.status).toBe(200)
    expect(proposeAnnotations).toHaveBeenCalledWith(SESSION, DOC_ID, [PROPOSAL])
    await expect(response.json()).resolves.toEqual({
      documentId: DOC_ID,
      documentName: 'Grundriss EG.pdf',
      proposed: [{ id: 'ann_1', number: 4, page: 1, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.1, kind: 'defect', body: PROPOSAL.body }],
    })
  })

  it('answers in a thread as Piloti', async () => {
    vi.mocked(replyToAnnotation).mockResolvedValue({
      annotation: { id: OTHER_DOC, number: 2, replies: [{}] } as never,
      replyId: 'reply_1',
      wake: 'none',
    })

    await post({ op: 'reply', annotationId: OTHER_DOC, body: 'Die lichte Breite ist im Schnitt B-B kotiert.' })

    expect(replyToAnnotation).toHaveBeenCalledWith(
      SESSION,
      DOC_ID,
      OTHER_DOC,
      { body: 'Die lichte Breite ist im Schnitt B-B kotiert.' },
      { kind: 'piloti' }
    )
  })

  it('acts on a document the turn names, from a chat about something else, inside the signed scope', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: null,
      subjectResourceId: null,
    } as Partial<Conversation> as Conversation)

    const response = await post({ op: 'propose', documentId: OTHER_DOC, proposals: [PROPOSAL] })

    expect(response.status).toBe(200)
    expect(proposeAnnotations).toHaveBeenCalledWith(SESSION, OTHER_DOC, [PROPOSAL])
    await expect(response.json()).resolves.toMatchObject({ documentId: OTHER_DOC, documentName: 'Schnitt A-A.pdf' })
  })

  it('treats a named document outside the signed scope as unknown', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({
      id: OTHER_DOC,
      filename: 'Fremd.pdf',
      collectionName: 'proj_9_docs',
    } as Partial<Document> as Document)

    const response = await post({ op: 'list', documentId: OTHER_DOC })

    expect(response.status).toBe(404)
    expect(listAnnotationsForAgent).not.toHaveBeenCalled()
  })

  it('admits a named document in a restricted folder against the conversation, like the subject', async () => {
    await post({ op: 'list', documentId: OTHER_DOC })

    expect(admitSubjectRead).toHaveBeenCalledWith(expect.objectContaining({ id: OTHER_DOC }), 'org_1', 'conv_1', {
      askerUserId: 'user_1',
      answerMessageId: null,
    })
  })

  it('refuses an unknown field: the turn cannot name a person or an organization', async () => {
    const response = await post({ op: 'list', organizationId: 'org_2' })

    expect(response.status).toBe(400)
    expect(listAnnotationsForAgent).not.toHaveBeenCalled()
  })

  it('refuses a conversation that is not about a document, with the reason the tool relays', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: null,
      subjectResourceId: null,
    } as Partial<Conversation> as Conversation)

    const response = await post({ op: 'propose', proposals: [PROPOSAL] })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ details: { reason: 'no-document-subject' } })
    expect(proposeAnnotations).not.toHaveBeenCalled()
  })

  it('reaches no held upload: a subject that has not passed screening is not found', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    const response = await post({ op: 'list' })

    expect(response.status).toBe(404)
    expect(listAnnotationsForAgent).not.toHaveBeenCalled()
  })

  it("admits a restricted subject against the conversation first, marking the turn's answer", async () => {
    const answerMessageId = '33333333-3333-4333-8333-333333333333'
    await post({ op: 'list', answerMessageId })

    expect(admitSubjectRead).toHaveBeenCalledWith(expect.objectContaining({ id: DOC_ID }), 'org_1', 'conv_1', {
      askerUserId: 'user_1',
      answerMessageId,
    })
  })

  it('refuses a proposal off its page and more than twenty at once', async () => {
    expect((await post({ op: 'propose', proposals: [{ ...PROPOSAL, x: 0.9 }] })).status).toBe(400)
    expect((await post({ op: 'propose', proposals: Array.from({ length: 21 }, () => PROPOSAL) })).status).toBe(400)
    expect(proposeAnnotations).not.toHaveBeenCalled()
  })

  it('refuses a caller without the internal token', async () => {
    const response = await POST(
      new Request('https://grid.test/api/internal/document-annotations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'list' }),
      })
    )

    expect(response.status).toBeGreaterThanOrEqual(401)
    expect(listAnnotationsForAgent).not.toHaveBeenCalled()
  })

  describe('the room', () => {
    const ANNA = {
      peerId: 'peer_anna',
      userId: 'user_anna',
      name: 'Anna Berger',
      kind: 'person' as const,
      page: 2,
      viewport: { page: 2, y: 0.4 },
      selected: 'ann_7',
      draft: { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
      expiresAt: '2026-10-13T12:00:00.000Z',
    }

    it('says who is in the document and where, by mark number, without Piloti itself', async () => {
      vi.mocked(listAnnotationsForAgent).mockResolvedValue({
        documentId: DOC_ID,
        annotations: [
          { id: 'ann_7', number: 7, status: 'open' },
          { id: 'ann_8', number: 8, status: 'proposed' },
        ] as never,
      })
      vi.mocked(roomSnapshot).mockResolvedValue([
        ANNA,
        { ...ANNA, peerId: 'piloti-conv_1', name: 'Piloti', kind: 'piloti', selected: null, draft: null },
      ])

      const response = await post({ op: 'room' })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        documentId: DOC_ID,
        documentName: 'Grundriss EG.pdf',
        peers: [
          {
            name: 'Anna Berger',
            kind: 'person',
            page: 2,
            viewport: { page: 2, y: 0.4 },
            selectedMarkNumber: 7,
            draft: { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
          },
        ],
        marks: { open: 1, proposed: 1 },
      })
    })

    it('points and highlights as Piloti for this conversation, after checking the asker may read', async () => {
      await post({ op: 'point', page: 1, x: 0.4, y: 0.5, label: 'Hier' })
      await post({ op: 'highlight', page: 1, x: 0.8, y: 0.1, w: 0.4, h: 0.2, label: 'Fluchtweg 1,10 m' })

      expect(getAccessibleDocument).toHaveBeenCalledWith(SESSION, DOC_ID, 'read')
      const agent = { organizationId: 'org_1', conversationId: 'conv_1', onBehalfOf: 'user_1' }
      expect(vi.mocked(publishAsAgent).mock.calls).toEqual([
        [DOC_ID, 'org_1', agent, { op: 'presence', state: 'here' }],
        [DOC_ID, 'org_1', agent, { op: 'cursor', cursor: { page: 1, x: 0.4, y: 0.5 }, label: 'Hier' }],
        [DOC_ID, 'org_1', agent, { op: 'presence', state: 'here' }],
        // A box past the page's edge is clamped onto it.
        [DOC_ID, 'org_1', agent, { op: 'highlight', box: { page: 1, x: 0.8, y: 0.1, w: expect.closeTo(0.2), h: 0.2 }, label: 'Fluchtweg 1,10 m' }],
      ])
    })

    it('says what Piloti reads: a box on the page, clamped onto it, or the whole page', async () => {
      await post({ op: 'look', page: 2, x: 0.7, y: 0.1, w: 0.5, h: 0.2 })
      await post({ op: 'look', page: 3 })

      expect(vi.mocked(publishAsAgent).mock.calls.map((call) => call[3])).toEqual([
        { op: 'presence', state: 'here' },
        { op: 'activity', state: 'reading', box: { page: 2, x: 0.7, y: 0.1, w: expect.closeTo(0.3), h: 0.2 } },
        { op: 'presence', state: 'here' },
        { op: 'activity', state: 'reading', box: { page: 3, x: 0, y: 0, w: 1, h: 1 } },
      ])
    })

    it('leaves: pointer off, activity cleared, presence gone', async () => {
      await post({ op: 'leave' })

      expect(vi.mocked(publishAsAgent).mock.calls.map((call) => call[3])).toEqual([
        { op: 'cursor', cursor: null },
        { op: 'activity', state: 'idle' },
        { op: 'presence', state: 'gone' },
      ])
    })

    it('makes no gesture for an asker who may not read the document', async () => {
      vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError('Document not found'))

      const response = await post({ op: 'point', page: 1, x: 0.4, y: 0.5 })

      expect(response.status).toBe(404)
      expect(publishAsAgent).not.toHaveBeenCalled()
    })

    it('refuses a highlight without a label, and a point off the page', async () => {
      expect((await post({ op: 'highlight', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).status).toBe(400)
      expect((await post({ op: 'point', page: 1, x: 1.4, y: 0.5 })).status).toBe(400)
      expect(publishAsAgent).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Parity: what the asker asks for, Piloti does as the asker could.
// ---------------------------------------------------------------------------

const MARK_ID = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-10-13T08:00:00.000Z')
const DOC_ROW = { id: DOC_ID, scope: 'project', projectId: 'proj_1', publishedVersionId: null } as Partial<Document> as Document
const NOTE = 'Erledigt: Die lichte Breite ist im Schnitt B-B mit 1,25 m kotiert.'

/** The fake repository's rows, by id. */
let marks: Map<string, AnnotationRecord>

const record = (patch: Partial<AnnotationRecord> = {}): AnnotationRecord => ({
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
  body: 'Laufbreite im Treppenhaus unter 1,20 m.',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  dueOn: null,
  createdBy: 'user_2',
  createdAt: NOW,
  updatedAt: NOW,
  acceptedBy: null,
  acceptedAt: null,
  closedBy: null,
  closedAt: null,
  delegatedBy: null,
  delegatedAt: null,
  fassungNumber: null,
  replies: [],
  ...patch,
})

/**
 * The CHECKs of migrations 0138 and 0139 that an author, a status move or a
 * delegation touches, as predicates over a row: what the database would refuse.
 */
function violatedChecks(row: DocumentAnnotationRow): string[] {
  const broken: string[] = []
  if (row.status === 'proposed' && row.authorKind !== 'piloti') broken.push('only_piloti_proposes')
  if ((row.acceptedBy === null) !== (row.acceptedAt === null)) broken.push('acceptance_complete')
  if (row.authorKind !== 'person' && !['proposed', 'dismissed'].includes(row.status) && row.acceptedBy === null) {
    broken.push('piloti_needs_a_person')
  }
  const closed = row.status === 'resolved' || row.status === 'dismissed'
  if (closed !== (row.closedBy !== null) || (row.closedBy === null) !== (row.closedAt === null)) {
    broken.push('closing_complete')
  }
  if ((row.delegatedBy === null) !== (row.delegatedAt === null)) broken.push('delegation_complete')
  if (row.delegatedBy !== null && row.status !== 'open') broken.push('delegated_while_open')
  return broken
}

/** A repository over {@link marks}: compare-and-swap on status, as the SQL is. */
function fakeRepository() {
  vi.mocked(findDocumentAnnotation).mockImplementation(async (_org, _doc, id) => marks.get(id) ?? null)
  vi.mocked(listDocumentAnnotations).mockImplementation(async () => [...marks.values()])
  vi.mocked(insertDocumentAnnotations).mockImplementation(async (input: NewAnnotationsInput) =>
    input.marks.map((mark, index) => {
      const acceptedBy = input.authorKind === 'piloti' ? (input.acceptedBy ?? null) : null
      const row = record({
        ...mark,
        id: `55555555-5555-4555-8555-55555555555${index}`,
        number: 10 + index,
        authorKind: input.authorKind,
        createdBy: input.createdBy,
        status: input.authorKind === 'piloti' && !acceptedBy ? 'proposed' : 'open',
        acceptedBy,
        acceptedAt: acceptedBy ? NOW : null,
      })
      marks.set(row.id, row)
      return row
    })
  )
  vi.mocked(updateDocumentAnnotation).mockImplementation(
    async (_org, _doc, id, expected, changes: AnnotationChanges) => {
      const current = marks.get(id)
      if (!current || current.status !== expected) return null
      const { transition, delegation, ...fields } = changes
      const next = { ...current, ...fields, ...(transition ?? {}), ...(delegation ?? {}), updatedAt: NOW }
      marks.set(id, next)
      return next
    }
  )
  vi.mocked(insertAnnotationReply).mockImplementation(async (input) => {
    const current = marks.get(input.annotationId)
    const reply: DocumentAnnotationReplyRow = {
      id: `reply_${current?.replies.length ?? 0}`,
      createdAt: NOW,
      ...input,
      addressesAgent: input.addressesAgent ?? false,
    }
    if (current) marks.set(input.annotationId, { ...current, replies: [...current.replies, reply] })
    return reply
  })
  vi.mocked(deleteDocumentAnnotation).mockImplementation(async (_org, _doc, id) => marks.delete(id))
}

const stored = () => marks.get(MARK_ID) ?? record({ body: 'gone' })

describe('POST /api/internal/document-annotations — what the asker asks for', () => {
  beforeEach(() => {
    marks = new Map([[MARK_ID, record()]])
    fakeRepository()
    vi.mocked(getAccessibleDocument).mockResolvedValue(DOC_ROW)
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([
        ['user_1', { userId: 'user_1', email: 'martin@buero.at', name: 'Martin Huber', profilePictureUrl: null }],
        ['user_anna', { userId: 'user_anna', email: 'anna@buero.at', name: 'Anna Berger', profilePictureUrl: null }],
        ['user_ann', { userId: 'user_ann', email: 'ann@buero.at', name: 'Anna Kurz', profilePictureUrl: null }],
      ])
    )
  })

  it('sets a mark the asker asked for born open, with the asker behind it', async () => {
    const response = await post({ op: 'create', marks: [PROPOSAL] })

    expect(response.status).toBe(200)
    expect(insertDocumentAnnotations).toHaveBeenCalledWith(
      expect.objectContaining({ authorKind: 'piloti', createdBy: 'user_1', acceptedBy: 'user_1' })
    )
    const body = await response.json()
    expect(body).toMatchObject({ documentId: DOC_ID, created: [{ number: 10, kind: 'defect', body: PROPOSAL.body }] })
    const born = marks.get(body.created[0].id)
    expect(born).toMatchObject({ status: 'open', authorKind: 'piloti', acceptedBy: 'user_1' })
    expect(violatedChecks(born ?? record())).toEqual([])
  })

  it('resolves for the asker, in their name, and says so in the thread as Piloti', async () => {
    const response = await post({ op: 'update', annotationId: MARK_ID, status: 'resolved', note: NOTE })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      documentId: DOC_ID,
      documentName: 'Grundriss EG.pdf',
      annotationId: MARK_ID,
      number: 4,
      status: 'resolved',
      before: { status: 'open' },
      after: { status: 'resolved' },
      noted: true,
    })
    expect(stored()).toMatchObject({ status: 'resolved', closedBy: 'user_1' })
    expect(violatedChecks(stored())).toEqual([])
    expect(insertAnnotationReply).toHaveBeenCalledWith(
      {
        organizationId: 'org_1',
        annotationId: MARK_ID,
        authorKind: 'piloti',
        body: NOTE,
        createdBy: 'user_1',
        addressesAgent: false,
      },
      // Piloti's own reply never wakes Piloti.
      undefined
    )
    expect(vi.mocked(updateDocumentAnnotation).mock.calls[0][3]).toBe('open')
  })

  it('takes a proposal over for the asker: the asker is the one who accepted it', async () => {
    marks.set(MARK_ID, record({ authorKind: 'piloti', status: 'proposed', createdBy: 'user_1' }))

    const response = await post({ op: 'update', annotationId: MARK_ID, status: 'open', note: 'Übernommen.' })

    expect(response.status).toBe(200)
    expect(stored()).toMatchObject({ status: 'open', acceptedBy: 'user_1' })
    expect(violatedChecks(stored())).toEqual([])
  })

  it('assigns by the name the asker used, and reports who before and after', async () => {
    const response = await post({ op: 'update', annotationId: MARK_ID, assignee: 'Anna Berger', dueOn: '2026-10-20', note: 'Anna übernimmt.' })

    await expect(response.json()).resolves.toMatchObject({
      before: { assigneeUserId: null, assigneeName: null, dueOn: null },
      after: { assigneeUserId: 'user_anna', assigneeName: 'Anna Berger', dueOn: '2026-10-20' },
      noted: true,
    })
    expect(userHoldsProjectPermission).toHaveBeenCalledWith({ organizationId: SESSION.organizationId }, 'proj_1', 'user_anna', 'project:view')
  })

  it('tells the new Zuständige as the asker’s own change would, saying Piloti did it for them, and the note tells nobody twice', async () => {
    await post({ op: 'update', annotationId: MARK_ID, assignee: 'Anna Berger', note: 'Anna übernimmt.' })

    await vi.waitFor(() => expect(onAssigneeChanged).toHaveBeenCalledTimes(1))
    expect(onAssigneeChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        documentId: DOC_ID,
        annotationId: MARK_ID,
        annotationNumber: 4,
        actorUserId: 'user_1',
        byPiloti: true,
        previousAssigneeUserId: null,
        assigneeUserId: 'user_anna',
        open: true,
      })
    )
    expect(insertAnnotationReply).toHaveBeenCalledTimes(1)
    expect(onMarkReplied).not.toHaveBeenCalled()
  })

  it('settles the mark and tells its author when Piloti resolves it for the asker', async () => {
    marks.set(MARK_ID, record({ createdBy: 'user_anna' }))

    await post({ op: 'update', annotationId: MARK_ID, status: 'resolved', note: NOTE })

    await vi.waitFor(() => expect(onMarkMoved).toHaveBeenCalledTimes(1))
    expect(onMarkMoved).toHaveBeenCalledWith(
      expect.objectContaining({ move: 'resolved', actorUserId: 'user_1', byPiloti: true, annotationId: MARK_ID })
    )
    expect(onMarkSettledByPerson).toHaveBeenCalledWith({ organizationId: 'org_1', annotationId: MARK_ID, closed: true })
  })

  it('asks back when a name means two people, and changes nothing', async () => {
    const response = await post({ op: 'update', annotationId: MARK_ID, assignee: 'Anna', note: 'Anna übernimmt.' })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ details: { reason: 'assignee-ambiguous' } })
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
    expect(insertAnnotationReply).not.toHaveBeenCalled()
  })

  it('refuses a stale expectedStatus with a 409 and posts no note', async () => {
    marks.set(MARK_ID, record({ status: 'resolved', closedBy: 'user_2', closedAt: NOW }))

    const response = await post({ op: 'update', annotationId: MARK_ID, status: 'open', expectedStatus: 'open', note: NOTE })

    expect(response.status).toBe(409)
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
    expect(insertAnnotationReply).not.toHaveBeenCalled()
  })

  it("does not overwrite a colleague's move between its read and its write: 409, no note", async () => {
    vi.mocked(updateDocumentAnnotation).mockResolvedValueOnce(null)

    const response = await post({ op: 'update', annotationId: MARK_ID, status: 'resolved', note: NOTE })

    expect(response.status).toBe(409)
    expect(insertAnnotationReply).not.toHaveBeenCalled()
  })

  it('posts no note for a change that moved nothing', async () => {
    const response = await post({ op: 'update', annotationId: MARK_ID, kind: 'defect', note: NOTE })

    await expect(response.json()).resolves.toMatchObject({ before: {}, after: {}, noted: false })
    expect(insertAnnotationReply).not.toHaveBeenCalled()
  })

  it('refuses an update that names no change', async () => {
    expect((await post({ op: 'update', annotationId: MARK_ID, note: NOTE })).status).toBe(400)
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
  })

  it('cannot do what the asker cannot: a reader changes nothing and no note goes out', async () => {
    vi.mocked(getAccessibleDocument).mockImplementation(async (_session, _id, mode) => {
      if (mode === 'write') throw new ForbiddenError('read only')
      return DOC_ROW
    })

    const update = await post({ op: 'update', annotationId: MARK_ID, status: 'resolved', note: NOTE })
    const create = await post({ op: 'create', marks: [PROPOSAL] })

    expect(update.status).toBe(403)
    expect(create.status).toBe(403)
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
    expect(insertDocumentAnnotations).not.toHaveBeenCalled()
    expect(insertAnnotationReply).not.toHaveBeenCalled()
    expect(stored().status).toBe('open')
  })

  it("refuses to delete a mark somebody else set, or a proposal nobody took over, as it would refuse the asker", async () => {
    expect((await post({ op: 'delete', annotationId: MARK_ID })).status).toBe(403)

    // A proposal is dismissed, never deleted: it has no person behind it yet.
    marks.set(MARK_ID, record({ authorKind: 'piloti', status: 'proposed', createdBy: 'user_1' }))
    expect((await post({ op: 'delete', annotationId: MARK_ID })).status).toBe(403)

    expect(deleteDocumentAnnotation).not.toHaveBeenCalled()
  })

  it('deletes a mark Piloti set open for the asker, as the asker may (parity, `mayDeleteMark`)', async () => {
    marks.set(MARK_ID, record({ authorKind: 'piloti', status: 'open', createdBy: 'user_1', acceptedBy: 'user_1', acceptedAt: NOW }))
    expect((await post({ op: 'delete', annotationId: MARK_ID })).status).toBe(200)
  })

  it('deletes a mark the asker set, and says which it was', async () => {
    marks.set(MARK_ID, record({ createdBy: 'user_1' }))

    const response = await post({ op: 'delete', annotationId: MARK_ID })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      documentId: DOC_ID,
      documentName: 'Grundriss EG.pdf',
      annotationId: MARK_ID,
      number: 4,
      body: 'Laufbreite im Treppenhaus unter 1,20 m.',
    })
    expect(marks.has(MARK_ID)).toBe(false)
  })

  it('finds no mark that is not on the document', async () => {
    marks.clear()
    expect((await post({ op: 'update', annotationId: MARK_ID, status: 'resolved', note: NOTE })).status).toBe(404)
    expect((await post({ op: 'delete', annotationId: MARK_ID })).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// The change record (ADR-0109): every change Piloti applies is a row with the
// turn that made it, written after the service committed it.
// ---------------------------------------------------------------------------

const ANSWER = '66666666-6666-4666-8666-666666666666'
/** The turn's half of every row. */
const TURN = {
  organizationId: 'org_1',
  documentId: DOC_ID,
  originConversationId: 'conv_1',
  originMessageId: ANSWER,
  onBehalfOf: 'user_1',
}
const recorded = () => vi.mocked(insertPilotiChanges).mock.calls.flatMap(([, rows]) => rows)

describe('POST /api/internal/document-annotations — what a turn changed is recorded with the turn', () => {
  beforeEach(() => {
    marks = new Map([[MARK_ID, record()]])
    fakeRepository()
    vi.mocked(getAccessibleDocument).mockResolvedValue(DOC_ROW)
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([['user_anna', { userId: 'user_anna', email: 'anna@buero.at', name: 'Anna Berger', profilePictureUrl: null }]])
    )
  })

  it('records a mark Piloti set as a create, with its whole state, and tells attention it was a question', async () => {
    const response = await post({ op: 'create', answerMessageId: ANSWER, marks: [{ ...PROPOSAL, kind: 'question' }] })

    expect(response.status).toBe(200)
    const { created } = await response.json()
    expect(recorded()).toEqual([
      {
        ...TURN,
        annotationId: created[0].id,
        objectKind: 'annotation',
        objectId: created[0].id,
        op: 'create',
        before: null,
        after: {
          status: 'open',
          kind: 'question',
          body: PROPOSAL.body,
          basis: PROPOSAL.basis,
          assigneeUserId: null,
          dueOn: null,
          page: 1,
          shape: 'region',
          x: 0.1,
          y: 0.2,
          w: 0.3,
          h: 0.1,
        },
      },
    ])
    expect(vi.mocked(insertPilotiChanges).mock.calls[0][0]).toBe('org_1')
    expect(onPilotiWrote).toHaveBeenCalledWith({
      organizationId: 'org_1',
      documentId: DOC_ID,
      annotationId: created[0].id,
      annotationNumber: 10,
      projectId: 'proj_1',
      onBehalfOf: 'user_1',
      assigneeUserId: null,
      what: 'question',
      replyId: null,
    })
  })

  it('records each proposal Piloti made as a create, and tells attention of a mark', async () => {
    vi.mocked(proposeAnnotations).mockResolvedValue({
      annotations: [{ ...record({ id: 'ann_1', status: 'proposed', authorKind: 'piloti' }) }] as never,
    })

    await post({ op: 'propose', answerMessageId: ANSWER, proposals: [PROPOSAL] })

    expect(recorded()).toEqual([
      expect.objectContaining({ op: 'create', annotationId: 'ann_1', after: expect.objectContaining({ status: 'proposed' }) }),
    ])
    expect(onPilotiWrote).toHaveBeenCalledWith(expect.objectContaining({ annotationId: 'ann_1', what: 'mark' }))
  })

  it('records a change with only the fields that moved, as they were and as Piloti left them', async () => {
    await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, status: 'resolved', assignee: 'Anna Berger', note: NOTE })

    expect(recorded()).toEqual([
      {
        ...TURN,
        annotationId: MARK_ID,
        objectKind: 'annotation',
        objectId: MARK_ID,
        op: 'update',
        before: { status: 'open', assigneeUserId: null },
        after: { status: 'resolved', assigneeUserId: 'user_anna' },
      },
    ])
    // The note is part of the change, not a reply of its own.
    expect(onPilotiWrote).not.toHaveBeenCalled()
  })

  it('records nothing for a change that moved nothing, or one refused as stale', async () => {
    await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, kind: 'defect', note: NOTE })
    marks.set(MARK_ID, record({ status: 'resolved', closedBy: 'user_2', closedAt: NOW }))
    const stale = await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, status: 'open', expectedStatus: 'open', note: NOTE })

    expect(stale.status).toBe(409)
    expect(insertPilotiChanges).not.toHaveBeenCalled()
  })

  it('records a delete with everything setting the mark again takes', async () => {
    marks.set(MARK_ID, record({ createdBy: 'user_1', dueOn: '2026-10-20' }))

    await post({ op: 'delete', answerMessageId: ANSWER, annotationId: MARK_ID })

    expect(recorded()).toEqual([
      {
        ...TURN,
        annotationId: MARK_ID,
        objectKind: 'annotation',
        objectId: MARK_ID,
        op: 'delete',
        before: {
          status: 'open',
          kind: 'defect',
          body: 'Laufbreite im Treppenhaus unter 1,20 m.',
          basis: null,
          assigneeUserId: null,
          dueOn: '2026-10-20',
          page: 1,
          shape: 'point',
          x: 0.4,
          y: 0.5,
          w: null,
          h: null,
        },
        after: null,
      },
    ])
  })

  it('records a reply as the create of a reply, by its id, and tells attention', async () => {
    const replyId = '77777777-7777-4777-8777-777777777777'
    vi.mocked(replyToAnnotation).mockResolvedValue({
      annotation: {
        ...record(),
        replies: [{ id: replyId, body: 'Die Breite ist im Schnitt B-B kotiert.' }],
        assigneeUserId: 'user_anna',
      } as never,
      replyId,
      wake: 'none',
    })

    await post({ op: 'reply', answerMessageId: ANSWER, annotationId: MARK_ID, body: 'Die Breite ist im Schnitt B-B kotiert.' })

    expect(recorded()).toEqual([
      {
        ...TURN,
        annotationId: MARK_ID,
        objectKind: 'annotation_reply',
        objectId: replyId,
        op: 'create',
        before: null,
        after: { body: 'Die Breite ist im Schnitt B-B kotiert.' },
      },
    ])
    expect(onPilotiWrote).toHaveBeenCalledWith(
      expect.objectContaining({ annotationId: MARK_ID, annotationNumber: 4, assigneeUserId: 'user_anna', what: 'reply', replyId })
    )
  })

  it('records nothing for a turn without an answer id (an older agent), and still applies the change', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await post({ op: 'update', annotationId: MARK_ID, status: 'resolved', note: NOTE })
    await post({ op: 'create', marks: [PROPOSAL] })

    expect(response.status).toBe(200)
    expect(stored().status).toBe('resolved')
    expect(insertPilotiChanges).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('records no read, no presence, no pointer and no highlight', async () => {
    vi.mocked(roomSnapshot).mockResolvedValue([])
    for (const body of [
      { op: 'list' },
      { op: 'room' },
      { op: 'point', page: 1, x: 0.4, y: 0.5 },
      { op: 'highlight', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'Hier' },
      { op: 'leave' },
    ]) {
      expect((await post({ ...body, answerMessageId: ANSWER })).status).toBe(200)
    }
    expect(insertPilotiChanges).not.toHaveBeenCalled()
    expect(onPilotiWrote).not.toHaveBeenCalled()
  })

  it('does not fail a change that landed when its record cannot be written', async () => {
    vi.mocked(insertPilotiChanges).mockRejectedValueOnce(new Error('connection reset'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, status: 'resolved', note: NOTE })

    expect(response.status).toBe(200)
    expect(stored().status).toBe('resolved')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('POST /api/internal/document-annotations — what a turn changed is in the audit trail', () => {
  const audited = (): AuditEventInput[] => vi.mocked(recordAuditEvent).mock.calls.map(([input]) => input)
  // Whatever was emitted, WorkOS would accept: every target type and key is registered.
  afterEach(() => {
    for (const [input] of vi.mocked(recordAuditEvent).mock.calls) expectRegistered(input)
  })
  const TARGETS = [
    { type: 'document', id: DOC_ID },
    { type: 'project', id: 'proj_1' },
    { type: 'conversation', id: 'conv_1' },
  ]

  beforeEach(() => {
    marks = new Map([[MARK_ID, record()]])
    fakeRepository()
    vi.mocked(getAccessibleDocument).mockResolvedValue(DOC_ROW)
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([['user_anna', { userId: 'user_anna', email: 'anna@buero.at', name: 'Anna Berger', profilePictureUrl: null }]])
    )
  })

  it('records a change once, as the person the turn acted for, with the turn and the field names that moved', async () => {
    vi.mocked(insertPilotiChanges).mockImplementationOnce(async (_org, rows) =>
      rows.map((row) => ({ ...row, id: 'c0000000-0000-4000-8000-000000000001' }) as PilotiChangeRow)
    )

    await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, status: 'resolved', assignee: 'Anna Berger', note: NOTE })

    expect(audited()).toEqual([
      {
        action: 'piloti.change.applied',
        organizationId: 'org_1',
        actor: { userId: 'user_1', email: null },
        targetType: 'document_annotation',
        targetId: MARK_ID,
        alsoTargets: TARGETS,
        metadata: {
          op: 'update',
          markNumber: 4,
          markKind: null,
          status: 'resolved',
          fields: 'status,assigneeUserId',
          messageId: ANSWER,
          changeId: 'c0000000-0000-4000-8000-000000000001',
        },
      },
    ])
  })

  it('records a set mark with its status and kind, and never a word of it', async () => {
    const response = await post({ op: 'create', answerMessageId: ANSWER, marks: [{ ...PROPOSAL, kind: 'question' }] })
    const { created } = await response.json()

    expect(audited()).toHaveLength(1)
    expect(audited()[0]).toMatchObject({
      targetId: created[0].id,
      metadata: { op: 'create', markNumber: 10, markKind: 'question', status: 'open', fields: null, changeId: null },
    })
    expect(JSON.stringify(audited())).not.toContain(PROPOSAL.body)
  })

  it('records each proposed mark, a delete, and a reply as `reply`, none with what it says', async () => {
    vi.mocked(proposeAnnotations).mockResolvedValue({
      annotations: [record({ id: 'ann_1', number: 11, status: 'proposed', authorKind: 'piloti' }), record({ id: 'ann_2', number: 12, status: 'proposed', authorKind: 'piloti' })] as never,
    })
    await post({ op: 'propose', answerMessageId: ANSWER, proposals: [PROPOSAL, PROPOSAL] })
    marks.set(MARK_ID, record({ createdBy: 'user_1' }))
    await post({ op: 'delete', answerMessageId: ANSWER, annotationId: MARK_ID })
    const replyId = '77777777-7777-4777-8777-777777777777'
    vi.mocked(replyToAnnotation).mockResolvedValue({
      annotation: { ...record(), replies: [{ id: replyId, body: 'Die Breite ist im Schnitt B-B kotiert.' }] } as never,
      replyId,
      wake: 'none',
    })
    await post({ op: 'reply', answerMessageId: ANSWER, annotationId: MARK_ID, body: 'Die Breite ist im Schnitt B-B kotiert.' })

    expect(audited().map((input) => [input.targetId, input.metadata?.op, input.metadata?.status])).toEqual([
      ['ann_1', 'create', 'proposed'],
      ['ann_2', 'create', 'proposed'],
      [MARK_ID, 'delete', 'open'],
      [MARK_ID, 'reply', null],
    ])
    expect(JSON.stringify(audited())).not.toMatch(/Laufbreite|Schnitt B-B/)
  })

  it('records nothing for a change that moved nothing, a refused one, or a read', async () => {
    vi.mocked(roomSnapshot).mockResolvedValue([])
    await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, kind: 'defect', note: NOTE })
    marks.set(MARK_ID, record({ status: 'resolved', closedBy: 'user_2', closedAt: NOW }))
    await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, status: 'open', expectedStatus: 'open', note: NOTE })
    await post({ op: 'list', answerMessageId: ANSWER })
    await post({ op: 'room', answerMessageId: ANSWER })

    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('records a change the ledger could not keep, without a change id: the change stands either way', async () => {
    vi.mocked(insertPilotiChanges).mockRejectedValueOnce(new Error('connection reset'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, status: 'resolved', note: NOTE })
    await post({ op: 'update', annotationId: MARK_ID, status: 'open', note: NOTE })

    expect(audited().map((input) => [input.metadata?.changeId, input.metadata?.messageId])).toEqual([
      [null, ANSWER],
      [null, null],
    ])
    error.mockRestore()
    warn.mockRestore()
  })

  it('applies the change when the trail fails', async () => {
    vi.mocked(recordAuditEvent).mockImplementationOnce(() => {
      throw new Error('WorkOS down')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = await post({ op: 'update', answerMessageId: ANSWER, annotationId: MARK_ID, status: 'resolved', note: NOTE })

    expect(response.status).toBe(200)
    expect(stored().status).toBe('resolved')
    expect(insertPilotiChanges).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('piloti.change.applied'), expect.any(Error))
    warn.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// `piloti-acts` off: the office has Piloti propose only.
// ---------------------------------------------------------------------------

describe('POST /api/internal/document-annotations — an office that has Piloti propose only', () => {
  beforeEach(() => {
    marks = new Map([[MARK_ID, record({ createdBy: 'user_1' })]])
    fakeRepository()
    vi.mocked(getAccessibleDocument).mockResolvedValue(DOC_ROW)
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
    SESSION.featureFlags = []
  })

  const refusal = { code: 'PILOTI_ACTS_OFF', details: { reason: 'piloti-acts-off' } }

  it('refuses to set a mark open for the asker, typed, and writes nothing', async () => {
    const response = await post({ op: 'create', answerMessageId: ANSWER, marks: [PROPOSAL] })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ ...refusal, details: { ...refusal.details, op: 'create' } })
    expect(insertDocumentAnnotations).not.toHaveBeenCalled()
    expect(insertPilotiChanges).not.toHaveBeenCalled()
    expect(onPilotiWrote).not.toHaveBeenCalled()
  })

  it('still proposes: the mark the person asked for is born a proposal', async () => {
    const response = await post({ op: 'propose', proposals: [PROPOSAL] })

    expect(response.status).toBe(200)
    expect(proposeAnnotations).toHaveBeenCalledWith(SESSION, DOC_ID, [PROPOSAL])
  })

  it('refuses a change and a deletion the asker could make themselves, and posts no note', async () => {
    const update = await post({ op: 'update', annotationId: MARK_ID, status: 'resolved', note: NOTE })
    const remove = await post({ op: 'delete', annotationId: MARK_ID })

    expect(update.status).toBe(403)
    await expect(update.json()).resolves.toMatchObject({ ...refusal, details: { ...refusal.details, op: 'update' } })
    expect(remove.status).toBe(403)
    await expect(remove.json()).resolves.toMatchObject({ ...refusal, details: { ...refusal.details, op: 'delete' } })
    expect(findDocumentAnnotation).not.toHaveBeenCalled()
    expect(updateDocumentAnnotation).not.toHaveBeenCalled()
    expect(insertAnnotationReply).not.toHaveBeenCalled()
    expect(deleteDocumentAnnotation).not.toHaveBeenCalled()
    expect(stored()).toMatchObject({ status: 'open' })
  })

  it('still answers in a thread, reads, and works the room', async () => {
    vi.mocked(replyToAnnotation).mockResolvedValue({
      annotation: { ...record(), replies: [{ id: 'reply_1', body: 'Steht im Schnitt B-B.' }] } as never,
      replyId: 'reply_1',
      wake: 'none',
    })
    vi.mocked(roomSnapshot).mockResolvedValue([])

    for (const body of [
      { op: 'reply', annotationId: MARK_ID, body: 'Steht im Schnitt B-B.' },
      { op: 'list' },
      { op: 'room' },
      { op: 'point', page: 1, x: 0.4, y: 0.5 },
      { op: 'highlight', page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'Hier' },
      { op: 'leave' },
    ]) {
      expect((await post(body)).status).toBe(200)
    }
    expect(replyToAnnotation).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a token without the flags claim', async () => {
    SESSION.featureFlags = null

    expect((await post({ op: 'create', marks: [PROPOSAL] })).status).toBe(403)
    expect(insertDocumentAnnotations).not.toHaveBeenCalled()
  })

  it('acts again once the organization switches it on', async () => {
    SESSION.featureFlags = ['piloti-acts']

    const response = await post({ op: 'update', annotationId: MARK_ID, status: 'resolved', note: NOTE })

    expect(response.status).toBe(200)
    expect(stored()).toMatchObject({ status: 'resolved', closedBy: 'user_1' })
  })
})
