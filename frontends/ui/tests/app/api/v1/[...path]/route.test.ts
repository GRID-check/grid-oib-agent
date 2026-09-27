import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

// A write into a chat collection is authorized on its conversation.
vi.mock('@/lib/sharing/access', () => ({
  requireResourceAccess: vi.fn(),
}))

import { GET, POST, DELETE } from '@/app/api/v1/[...path]/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { NotFoundError } from '@/lib/api/errors'
import { requireResourceAccess } from '@/lib/sharing/access'

const mockRequireAuthorizedSession = vi.mocked(requireAuthorizedSession)
const mockBuildCollectionScopeFromRequest = vi.mocked(buildCollectionScopeFromRequest)
const mockRequireProjectAccess = vi.mocked(requireProjectAccess)
const mockGetDb = vi.mocked(getDb)
const mockRequireResourceAccess = vi.mocked(requireResourceAccess)

/**
 * Mock the drizzle project lookup used by validateCollectionName for
 * proj_<id> collections: db.select().from().where().limit(1) -> rows.
 */
function mockDbProjectLookup(rows: Array<{ id: string }>): void {
  mockGetDb.mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as never)
}

const baseSession = {
  userId: 'user_1',
  email: 'a@b.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [] as string[],
  featureFlags: null,
}

function makeParams(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) }
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(response = makeJsonResponse({ ok: true })): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>
  return headers[name]
}

describe('/api/v1/[...path]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.REQUIRE_AUTH
    delete process.env.BASE_COLLECTION_NAME
  })

  describe('scope header', () => {
    it('attaches scope header for GET requests', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1', 's_conv-1'],
        scopedCollections: [
          { collection: 'oib_knowledge', shelf: 'base' },
          { collection: 'proj_proj-1', shelf: 'project' },
          { collection: 's_conv-1', shelf: 'session' },
        ],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/data_sources?projectId=proj-1&conversationId=conv-1'
      )
      const res = await GET(req, makeParams(['data_sources']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Accept')).toBe('application/json')
      expect(getHeader(init, 'Authorization')).toBe('Bearer tok')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: 'conv-1',
      })
    })

    it('attaches scope header for POST JSON requests', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1', 's_conv-1'],
        scopedCollections: [
          { collection: 'oib_knowledge', shelf: 'base' },
          { collection: 'proj_proj-1', shelf: 'project' },
          { collection: 's_conv-1', shelf: 'session' },
        ],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
      mockDbProjectLookup([{ id: 'proj-1' }])
      mockRequireProjectAccess.mockResolvedValue({ role: 'project-editor' })
      const fetchMock = mockFetch()

      const req = new Request('http://localhost:3000/api/v1/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1', session_id: 'conv-1', name: 'proj_proj-1' }),
      })
      const res = await POST(req, makeParams(['collections']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Content-Type')).toBe('application/json')
      expect(getHeader(init, 'Authorization')).toBe('Bearer tok')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: 'conv-1',
        collectionName: 'proj_proj-1',
      })
    })

    it('attaches scope header for multipart uploads', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockRequireResourceAccess.mockResolvedValue({} as never)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 's_conv-1'],
        scopedCollections: [
          { collection: 'oib_knowledge', shelf: 'base' },
          { collection: 's_conv-1', shelf: 'session' },
        ],
        headerValue: 'encoded-scope',
        projectId: undefined,
        conversationId: 's_conv-1',
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('--boundary--'))
          controller.close()
        },
      })
      const req = new Request(
        'http://localhost:3000/api/v1/collections/s_conv-1/documents?conversationId=s_conv-1',
        {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data; boundary=----boundary' },
          body: stream,
        }
      )
      const res = await POST(req, makeParams(['collections', 's_conv-1', 'documents']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Authorization')).toBe('Bearer tok')
      expect(init.body).toBe(stream)
      expect((init as RequestInit & { duplex?: string }).duplex).toBe('half')
    })

    it('attaches scope header for DELETE requests', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockDbProjectLookup([{ id: 'proj-1' }])
      mockRequireProjectAccess.mockResolvedValue({ role: 'project-editor' })
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1'],
        scopedCollections: [
          { collection: 'oib_knowledge', shelf: 'base' },
          { collection: 'proj_proj-1', shelf: 'project' },
        ],
        headerValue: 'encoded-scope',
        projectId: 'proj-1',
        conversationId: undefined,
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request(
        'http://localhost:3000/api/v1/collections/proj_proj-1/documents?projectId=proj-1',
        { method: 'DELETE' }
      )
      const res = await DELETE(req, makeParams(['collections', 'proj_proj-1', 'documents']))

      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.method).toBe('DELETE')
      expect(getHeader(init, 'X-Grid-Collection-Scope')).toBe('encoded-scope')
      expect(getHeader(init, 'Authorization')).toBe('Bearer tok')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(baseSession, {
        projectId: 'proj-1',
        conversationId: undefined,
      })
    })

    it('uses anonymous session when auth is disabled', async () => {
      process.env.REQUIRE_AUTH = 'false'
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 's_conv-1'],
        scopedCollections: [
          { collection: 'oib_knowledge', shelf: 'base' },
          { collection: 's_conv-1', shelf: 'session' },
        ],
        headerValue: 'anon-scope',
        projectId: undefined,
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request('http://localhost:3000/api/v1/data_sources?conversationId=conv-1')
      const res = await GET(req, makeParams(['data_sources']))

      expect(res.status).toBe(200)
      expect(mockRequireAuthorizedSession).not.toHaveBeenCalled()
      expect(getHeader(fetchMock.mock.calls[0][1], 'X-Grid-Collection-Scope')).toBe('anon-scope')
      expect(getHeader(fetchMock.mock.calls[0][1], 'Authorization')).toBeUndefined()
    })
  })

  describe('collection name validation', () => {
    it('refuses a raw upload into proj_<id> (403), naming the first-party route', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      const fetchMock = mockFetch()

      const req = new Request('http://localhost:3000/api/v1/collections/proj_proj-1/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1' }),
      })
      const res = await POST(req, makeParams(['collections', 'proj_proj-1', 'documents']))

      // No document row, no file-type gate, no quota down this path.
      expect(res.status).toBe(403)
      expect(JSON.stringify(await res.json())).toContain('/api/documents/upload')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects a proj_<id> file delete without a project document-write membership', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockDbProjectLookup([{ id: 'proj-1' }])
      mockRequireProjectAccess.mockRejectedValue(new Error('Not found'))
      const fetchMock = mockFetch()

      const req = new Request('http://localhost:3000/api/v1/collections/proj_proj-1/documents', {
        method: 'DELETE',
      })
      const res = await DELETE(req, makeParams(['collections', 'proj_proj-1', 'documents']))

      expect(res.status).toBe(404)
      expect(mockRequireProjectAccess).toHaveBeenCalledWith(baseSession, 'proj-1', [
        'project:documents:write',
        'project:edit',
      ])
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('allows upload to s_<id> when it matches active conversationId', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 's_conv-1'],
        scopedCollections: [
          { collection: 'oib_knowledge', shelf: 'base' },
          { collection: 's_conv-1', shelf: 'session' },
        ],
        headerValue: 'encoded-scope',
        projectId: undefined,
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      mockRequireResourceAccess.mockResolvedValue({} as never)

      const req = new Request('http://localhost:3000/api/v1/collections/s_conv-1/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'conv-1' }),
      })
      const res = await POST(req, makeParams(['collections', 's_conv-1', 'documents']))

      expect(res.status).toBe(200)
      expect(mockRequireResourceAccess).toHaveBeenCalledWith(
        baseSession,
        'conversation',
        's_conv-1',
        'collaborator'
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it.each(['POST', 'DELETE'] as const)(
      'refuses a %s to s_<id> files for a viewer, or for a conversation that does not exist (404)',
      async (method) => {
        process.env.REQUIRE_AUTH = 'true'
        mockRequireAuthorizedSession.mockResolvedValue(baseSession)
        mockRequireResourceAccess.mockRejectedValue(new NotFoundError())
        const fetchMock = mockFetch()

        const req = new Request(
          'http://localhost:3000/api/v1/collections/s_conv-1/documents?conversationId=s_conv-1',
          { method }
        )
        const handler = method === 'POST' ? POST : DELETE
        const res = await handler(req, makeParams(['collections', 's_conv-1', 'documents']))

        expect(res.status).toBe(404)
        expect(fetchMock).not.toHaveBeenCalled()
      }
    )

    it('rejects upload to s_<id> when no conversationId is active', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge'],
        scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }],
        headerValue: 'encoded-scope',
        projectId: undefined,
        conversationId: undefined,
        projectCollectionName: undefined,
      })
      const fetchMock = mockFetch()

      const req = new Request('http://localhost:3000/api/v1/collections/s_conv-1/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const res = await POST(req, makeParams(['collections', 's_conv-1', 'documents']))

      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects upload to base corpus', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      const fetchMock = mockFetch()

      const req = new Request('http://localhost:3000/api/v1/collections/oib_knowledge/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const res = await POST(req, makeParams(['collections', 'oib_knowledge', 'documents']))

      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects upload to arbitrary collection name', async () => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      const fetchMock = mockFetch()

      const req = new Request('http://localhost:3000/api/v1/collections/random-name/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const res = await POST(req, makeParams(['collections', 'random-name', 'documents']))

      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
