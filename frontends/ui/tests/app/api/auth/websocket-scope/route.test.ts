import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/session', () => ({
  getGridSession: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

vi.mock('@/lib/project-profile/prompt-view', () => ({
  loadProjectPromptView: vi.fn(),
}))

// Keep the test hermetic: the real digest builder requires a database.
vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigest: vi.fn(),
}))

import { GET } from '@/app/api/auth/websocket-scope/route'
import { getGridSession } from '@/lib/auth/session'
import { requireProjectAccess } from '@/lib/authz/projects'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { loadProjectPromptView } from '@/lib/project-profile/prompt-view'

const mockGetGridSession = vi.mocked(getGridSession)
const mockRequireProjectAccess = vi.mocked(requireProjectAccess)
const mockBuildCollectionScopeFromRequest = vi.mocked(buildCollectionScopeFromRequest)
const mockLoadProjectPromptView = vi.mocked(loadProjectPromptView)

describe('/api/auth/websocket-scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.REQUIRE_AUTH
    mockLoadProjectPromptView.mockResolvedValue(null)
  })

  it('returns scope and header when auth is disabled', async () => {
    process.env.REQUIRE_AUTH = 'false'
    mockGetGridSession.mockResolvedValue(null)
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge'],
      headerValue: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      projectId: 'proj-1',
      conversationId: 'conv-1',
      projectCollectionName: undefined,
    })

    const req = new Request(
      'http://localhost:3000/api/auth/websocket-scope?projectId=proj-1&conversationId=conv-1'
    )
    const res = await GET(req)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      scope: ['oib_knowledge'],
      header: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      // The route echoes the requested projectId so server.js can scope the socket.
      projectId: 'proj-1',
    })
    expect(mockRequireProjectAccess).not.toHaveBeenCalled()
    expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(null, {
      projectId: 'proj-1',
      conversationId: 'conv-1',
    })
  })

  it('returns 401 when auth is required and there is no session', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockGetGridSession.mockResolvedValue(null)

    const req = new Request('http://localhost:3000/api/auth/websocket-scope')
    const res = await GET(req)

    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toEqual({ error: 'Unauthorized' })
  })

  it('authorizes project access when auth is required and projectId is provided', async () => {
    process.env.REQUIRE_AUTH = 'true'
    const session = {
      userId: 'user_1',
      email: 'a@b.com',
      name: null,
      accessToken: 'tok',
      organizationId: 'org_1',
      organizationMembershipId: 'om_1',
      role: 'member',
      permissions: [] as string[],
    }
    mockGetGridSession.mockResolvedValue(session)
    mockRequireProjectAccess.mockResolvedValue({ role: 'project-viewer' as const })
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_proj-1'],
      headerValue: 'scope-header',
      projectId: 'proj-1',
      conversationId: undefined,
      projectCollectionName: undefined,
    })

    const req = new Request('http://localhost:3000/api/auth/websocket-scope?projectId=proj-1')
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:view')
  })

  it('returns 403 on authorization failure', async () => {
    process.env.REQUIRE_AUTH = 'true'
    const session = {
      userId: 'user_1',
      email: 'a@b.com',
      name: null,
      accessToken: 'tok',
      organizationId: 'org_1',
      organizationMembershipId: 'om_1',
      role: 'member',
      permissions: [] as string[],
    }
    mockGetGridSession.mockResolvedValue(session)
    mockRequireProjectAccess.mockRejectedValue(new Error('Not found'))

    const req = new Request('http://localhost:3000/api/auth/websocket-scope?projectId=proj-1')
    const res = await GET(req)

    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json).toEqual({ error: 'Forbidden' })
  })

  it('returns 500 for unexpected errors', async () => {
    process.env.REQUIRE_AUTH = 'false'
    mockGetGridSession.mockRejectedValue(new Error('database unavailable'))

    const req = new Request('http://localhost:3000/api/auth/websocket-scope')
    const res = await GET(req)

    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json).toEqual({ error: 'Internal Server Error' })
  })
})
