/**
 * @vitest-environment node
 */
/**
 * The conversation draft-filing door: what it files, and what it refuses.
 *
 * The browser and the agent's `file_draft` converge on ONE document through
 * the shared idempotency reference (`{conversationId}-{slug}`), so the
 * properties pinned here are the convergence ones:
 *
 *   - the reference is the agent tier's spelling, byte for byte (parity
 *     vectors below — change either side and this fails first);
 *   - an already-filed reference comes back with the open version and creates
 *     nothing, while a reference past the writing states is a conflict;
 *   - a same-name row the reference does NOT own is a 409 carrying that row,
 *     and only an explicit `force` files beside it;
 *   - the gate order (conversation viewer, then project, then bytes) means a
 *     denial never addresses the backend and a project-less chat never files.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '@/lib/api/errors'
import type { Conversation } from '@/lib/db/schema'
import type { DocumentVersion } from '@/lib/db/schema'
import type { DocumentListRow } from '@/lib/documents/repository'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'member',
    email: 'u@grid.test',
    permissions: [],
  }),
}))

const requireResourceAccessMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/sharing/access', () => ({
  requireResourceAccess: requireResourceAccessMock,
}))

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

vi.mock('@/lib/conversations/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversations/repository')>()),
  findConversationInOrg: vi.fn(),
}))

vi.mock('@/lib/documents/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/repository')>()),
  findDocumentAuthoredByRef: vi.fn(),
  listProjectDocuments: vi.fn(),
}))

vi.mock('@/lib/documents/version-repository', () => ({
  findOpenVersion: vi.fn(),
}))

vi.mock('@/lib/documents/agent-document', () => ({
  fileAgentDocumentDraft: vi.fn(),
}))

import { findConversationInOrg } from '@/lib/conversations/repository'
import { filingReference } from '@/lib/conversations/draft-filing'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import { findDocumentAuthoredByRef, listProjectDocuments } from '@/lib/documents/repository'
import { findOpenVersion } from '@/lib/documents/version-repository'
import { POST } from './route'

const PROJECT = '33333333-3333-4333-8333-333333333333'
const DOC = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'

const PATH = '/entwuerfe/aktenvermerk.md'
const TITLE = 'Aktenvermerk'

const fetchMock = vi.fn()

const post = (body: unknown) =>
  POST(
    new Request('https://grid.example/api/conversations/conv-1/draft/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'conv-1' }) },
  )

const conversation = (overrides: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'conv-1',
    organizationId: 'org_1',
    projectId: PROJECT,
    ...overrides,
  }) as Conversation

describe('POST /api/conversations/[id]/draft/file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    vi.stubGlobal('fetch', fetchMock)
    requireResourceAccessMock.mockResolvedValue({ role: 'viewer' })
    vi.mocked(findConversationInOrg).mockResolvedValue(conversation())
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ path: PATH, content: '# Aktenvermerk\n', version: 2 }),
    })
    vi.mocked(findDocumentAuthoredByRef).mockResolvedValue(null)
    vi.mocked(listProjectDocuments).mockResolvedValue([])
    vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
      documentId: DOC,
      version: { id: VERSION, state: 'draft' } as DocumentVersion,
      alreadyFiled: false,
    })
  })

  it('files the draft in the reader session under the shared reference', async () => {
    const res = await post({ path: PATH, title: TITLE })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      documentId: DOC,
      versionId: VERSION,
      state: 'draft',
      alreadyFiled: false,
    })
    // The conversation gate first: only drafts of conversations the reader may
    // see are filed.
    expect(requireResourceAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1', organizationId: 'org_1' }),
      'conversation',
      'conv-1',
      'viewer',
    )
    // The bytes come from the agent tier's read door, with the internal token
    // and this conversation's own namespace.
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://backend:8000/v1/drafts/conv-1/entwuerfe/aktenvermerk.md')
    expect(init.headers['x-grid-internal-token']).toBe('test-token')
    // The create goes through the existing filing op — the reference the agent
    // tier mints for this path, the card's title, the fetched bytes, and this
    // conversation as the origin a later review decision returns to. No
    // `actingHuman: false`: this caller IS the person.
    expect(vi.mocked(fileAgentDocumentDraft).mock.calls[0][0]).toMatchObject({
      projectId: PROJECT,
      ref: 'conv-1-aktenvermerk',
      title: TITLE,
      content: '# Aktenvermerk\n',
      originConversationId: 'conv-1',
    })
    expect(vi.mocked(fileAgentDocumentDraft).mock.calls[0][0]).not.toHaveProperty('actingHuman', false)
  })

  it('converges with the agent filing: an already-filed reference creates nothing', async () => {
    vi.mocked(findDocumentAuthoredByRef).mockResolvedValue({
      id: DOC,
      filename: 'piloti/x.md',
      folderId: 'folder-1',
    })
    vi.mocked(findOpenVersion).mockResolvedValue({ id: VERSION, state: 'draft' } as DocumentVersion)

    const res = await post({ path: PATH, title: TITLE })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      documentId: DOC,
      versionId: VERSION,
      state: 'draft',
      alreadyFiled: true,
    })
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('refuses a reference whose version has left the writing states', async () => {
    vi.mocked(findDocumentAuthoredByRef).mockResolvedValue({
      id: DOC,
      filename: 'piloti/x.md',
      folderId: 'folder-1',
    })
    vi.mocked(findOpenVersion).mockResolvedValue({ id: VERSION, state: 'in_review' } as DocumentVersion)

    const res = await post({ path: PATH, title: TITLE })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'already-submitted' },
    })
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('vetoes a same-name document the reference does not own, carrying that row', async () => {
    vi.mocked(listProjectDocuments).mockResolvedValue([
      { id: 'doc-9', filename: 'x.md', displayName: 'Aktenvermerk' } as DocumentListRow,
    ])

    const res = await post({ path: PATH, title: TITLE })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'same-name', documentId: 'doc-9', displayName: 'Aktenvermerk' },
    })
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('files beside the same-name document on explicit confirmation', async () => {
    vi.mocked(listProjectDocuments).mockResolvedValue([
      { id: 'doc-9', filename: 'x.md', displayName: 'Aktenvermerk' } as DocumentListRow,
    ])

    const res = await post({ path: PATH, title: TITLE, force: true })

    expect(res.status).toBe(201)
    expect(fileAgentDocumentDraft).toHaveBeenCalled()
  })

  it('answers 404 without addressing the backend when the reader may not see the conversation', async () => {
    requireResourceAccessMock.mockRejectedValue(new NotFoundError())

    const res = await post({ path: PATH, title: TITLE })

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('answers 422 when the conversation has no project to file into', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue(conversation({ projectId: null }))

    const res = await post({ path: PATH, title: TITLE })

    expect(res.status).toBe(422)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('rejects a missing path with 400 before any gate or backend call', async () => {
    const res = await post({ title: TITLE })

    expect(res.status).toBe(400)
    expect(requireResourceAccessMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a backend 404 to 404', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })

    const res = await post({ path: PATH, title: TITLE })

    expect(res.status).toBe(404)
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('maps a backend outage to 502, retryable from the card', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

    const res = await post({ path: PATH, title: TITLE })

    expect(res.status).toBe(502)
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })
})

describe('filingReference — parity with the agent tier', () => {
  it('spells the reference the way file_draft does', () => {
    // `tools/documents/register.py::filing_reference`: `{conversation}-{slug}`,
    // the slug lowercased, non-alphanumerics folded to one dash, `.md` gone.
    expect(filingReference('conv-1', '/entwuerfe/Aktenvermerk Fluchtweg.md')).toBe(
      'conv-1-aktenvermerk-fluchtweg',
    )
    // Umlauts are not ASCII and fold like any other non-alphanumeric — mirrored
    // exactly rather than transliterated, because convergence is the point.
    expect(filingReference('conv-1', '/entwuerfe/Fluchtweglänge.md')).toBe('conv-1-fluchtwegl-nge')
    // A bare name files under itself; a name with nothing left is still a key.
    expect(filingReference('conv-1', 'notiz')).toBe('conv-1-notiz')
    expect(filingReference('conv-1', '/entwuerfe/---.md')).toBe('conv-1-entwurf')
  })

  it('bounds the reference like the agent tier', () => {
    expect(filingReference('c'.repeat(300), '/entwuerfe/a.md')).toHaveLength(200)
  })
})
