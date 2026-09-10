/**
 * @vitest-environment node
 */
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
  loadProjectBundesland: vi.fn(),
}))

// Keep the test hermetic: the real digest builder requires a database.
vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigest: vi.fn(),
}))

import { GET } from '@/app/api/auth/websocket-scope/route'
import { getGridSession } from '@/lib/auth/session'
import { requireProjectAccess } from '@/lib/authz/projects'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'

const mockGetGridSession = vi.mocked(getGridSession)
const mockRequireProjectAccess = vi.mocked(requireProjectAccess)
const mockBuildCollectionScopeFromRequest = vi.mocked(buildCollectionScopeFromRequest)
const mockLoadProjectPromptView = vi.mocked(loadProjectPromptView)
const mockLoadProjectBundesland = vi.mocked(loadProjectBundesland)
const mockBuildProjectMemoryDigest = vi.mocked(buildProjectMemoryDigest)

describe('/api/auth/websocket-scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.REQUIRE_AUTH
    // Keep the reflection gate at its documented defaults (flags not enforced,
    // GRID_MEMORY_REFLECTION_ENABLED unset → on) regardless of ambient env.
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
    delete process.env.GRID_MEMORY_REFLECTION_ENABLED
    mockLoadProjectPromptView.mockResolvedValue(null)
    mockLoadProjectBundesland.mockResolvedValue(null)
    mockBuildProjectMemoryDigest.mockResolvedValue(null)
  })

  it('returns scope and header when auth is disabled', async () => {
    process.env.REQUIRE_AUTH = 'false'
    mockGetGridSession.mockResolvedValue(null)
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge'],
      scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }],
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
      scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }],
      header: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      // The route echoes the requested projectId so server.js can scope the socket.
      projectId: 'proj-1',
      // Anonymous mode: no org, and GRID_ENFORCE_FEATURE_FLAGS is off, so the
      // GRID_MEMORY_REFLECTION_ENABLED fallback decides — and it defaults ON.
      memoryReflectionEnabled: true,
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
  featureFlags: null,
    }
    mockGetGridSession.mockResolvedValue(session)
    mockBuildCollectionScopeFromRequest.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_proj-1'],
      scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }, { collection: 'proj_proj-1', shelf: 'project' }],
      headerValue: 'scope-header',
      projectId: 'proj-1',
      conversationId: undefined,
      projectCollectionName: undefined,
    })

    const req = new Request('http://localhost:3000/api/auth/websocket-scope?projectId=proj-1')
    const res = await GET(req)

    expect(res.status).toBe(200)
    // Access enforcement lives in buildCollectionScopeFromRequest (covered by
    // its own tests); the route must delegate with the session and NOT run a
    // second, redundant check.
    expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(session, {
      projectId: 'proj-1',
      conversationId: undefined,
    })
    expect(mockRequireProjectAccess).not.toHaveBeenCalled()
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
  featureFlags: null,
    }
    mockGetGridSession.mockResolvedValue(session)
    // The access check inside the scope builder rejects (tenancy/FGA denial).
    mockBuildCollectionScopeFromRequest.mockRejectedValue(new Error('Not found'))

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

  /**
   * ADR-0054 — the Büro upgrade. `scope=workspace` names the office surface, and
   * the route's whole job for it is subtraction: no project id is read, no
   * project profile or Bundesland is loaded, and nothing project-shaped comes
   * back. What stays is the memory digest, which already serves a project-less
   * caller and is how organisation memory reaches an office turn (spec KH-3).
   */
  describe('scope=workspace', () => {
    const workspaceSession = {
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

    beforeEach(() => {
      process.env.REQUIRE_AUTH = 'true'
      mockGetGridSession.mockResolvedValue(workspaceSession)
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'archiv_org_1', 's_conv-1'],
        scopedCollections: [
          { collection: 'oib_knowledge', shelf: 'base' },
          { collection: 'archiv_org_1', shelf: 'archiv' },
          { collection: 's_conv-1', shelf: 'session' },
        ],
        headerValue: 'workspace-header',
        projectId: undefined,
        conversationId: 'conv-1',
        projectCollectionName: undefined,
      })
    })

    it('states the workspace scope to the builder and returns no project', async () => {
      const req = new Request(
        'http://localhost:3000/api/auth/websocket-scope?scope=workspace&conversationId=conv-1'
      )
      const res = await GET(req)

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.projectId).toBeUndefined()
      expect(json.projectContext).toBeUndefined()
      expect(json.bundesland).toBeUndefined()
      expect(json.header).toBe('workspace-header')

      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(workspaceSession, {
        scope: 'workspace',
        conversationId: 'conv-1',
      })
      // The two project loaders are the ones KH-4 forbids an unmounted office
      // turn from reaching.
      expect(mockLoadProjectPromptView).not.toHaveBeenCalled()
      expect(mockLoadProjectBundesland).not.toHaveBeenCalled()
      // Organisation memory still travels: the digest is called with no project.
      expect(mockBuildProjectMemoryDigest).toHaveBeenCalledWith(undefined, 'org_1')
    })

    it('drops a projectId smuggled in beside the workspace scope', async () => {
      const req = new Request(
        'http://localhost:3000/api/auth/websocket-scope?scope=workspace&projectId=proj-1'
      )
      const res = await GET(req)

      expect(res.status).toBe(200)
      expect((await res.json()).projectId).toBeUndefined()
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(workspaceSession, {
        scope: 'workspace',
        conversationId: undefined,
      })
      expect(mockLoadProjectPromptView).not.toHaveBeenCalled()
    })

    it('refuses the office scope when the workspace-chat flag is not held', async () => {
      process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
      mockGetGridSession.mockResolvedValue({ ...workspaceSession, featureFlags: [] })

      const req = new Request('http://localhost:3000/api/auth/websocket-scope?scope=workspace')
      const res = await GET(req)

      expect(res.status).toBe(403)
      expect(mockBuildCollectionScopeFromRequest).not.toHaveBeenCalled()
    })

    it('serves the office scope to an org that holds the flag', async () => {
      process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
      mockGetGridSession.mockResolvedValue({
        ...workspaceSession,
        featureFlags: ['workspace-chat'],
      })

      const req = new Request('http://localhost:3000/api/auth/websocket-scope?scope=workspace')
      const res = await GET(req)

      expect(res.status).toBe(200)
    })

    it('leaves the project upgrade untouched — no scope param, no scope in the context', async () => {
      mockBuildCollectionScopeFromRequest.mockResolvedValue({
        scope: ['oib_knowledge', 'proj_proj-1'],
        scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }],
        headerValue: 'scope-header',
        projectId: 'proj-1',
        conversationId: undefined,
        projectCollectionName: undefined,
      })

      const req = new Request('http://localhost:3000/api/auth/websocket-scope?projectId=proj-1')
      const res = await GET(req)

      expect(res.status).toBe(200)
      expect((await res.json()).projectId).toBe('proj-1')
      expect(mockBuildCollectionScopeFromRequest).toHaveBeenCalledWith(workspaceSession, {
        projectId: 'proj-1',
        conversationId: undefined,
      })
      expect(mockLoadProjectPromptView).toHaveBeenCalledWith('proj-1', 'org_1')
    })

    it('answers 400 for a scope that is neither project nor workspace', async () => {
      const req = new Request('http://localhost:3000/api/auth/websocket-scope?scope=all-projects')
      const res = await GET(req)

      expect(res.status).toBe(400)
      expect(mockBuildCollectionScopeFromRequest).not.toHaveBeenCalled()
    })
  })
})
