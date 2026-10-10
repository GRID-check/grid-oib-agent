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
        verifiedConversationId: undefined,
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
        verifiedConversationId: undefined,
      })
      mockDbProjectLookup([{ id: 'proj-1' }])
      mockRequireProjectAccess.mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
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
        verifiedConversationId: undefined,
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
    // No product client uploads or deletes through the proxy: every shelf has
    // a first-party route that writes and removes the document row, runs the
    // file-type gate and charges the quota. So no write into a collection's
    // files is forwarded, whatever the collection (`lib/proxy/v1-allowlist.ts`).
    it.each([
      ['POST', 'proj_proj-1'],
      ['DELETE', 'proj_proj-1'],
      ['POST', 'archiv_org_1'],
      ['POST', 's_conv-1'],
      ['DELETE', 's_conv-1'],
      ['POST', 'oib_knowledge'],
      ['POST', 'random-name'],
    ] as const)('forwards no %s into the files of %s (404)', async (method, collection) => {
      process.env.REQUIRE_AUTH = 'true'
      mockRequireAuthorizedSession.mockResolvedValue(baseSession)
      mockRequireResourceAccess.mockResolvedValue({} as never)
      const fetchMock = mockFetch()

      const req = new Request(`http://localhost:3000/api/v1/collections/${collection}/documents`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const handler = method === 'POST' ? POST : DELETE
      const res = await handler(req, makeParams(['collections', collection, 'documents']))

      expect(res.status).toBe(404)
      expect(fetchMock).not.toHaveBeenCalled()
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

  })
})
