import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildCollectionScopeFromRequest,
  resolveActiveProjectId,
} from '@/lib/collection-scope-request'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/collection-scope', () => ({
  computeCollectionScope: vi.fn((_session, ctx) => {
    const scope: string[] = ['oib_knowledge']
    if (ctx.projectId) scope.push(`proj_${ctx.projectId}`)
    if (ctx.conversationId) {
      scope.push(ctx.conversationId.startsWith('s_') ? ctx.conversationId : `s_${ctx.conversationId}`)
    }
    return scope
  }),
  buildCollectionScopeHeader: vi.fn((scope) => Buffer.from(JSON.stringify(scope)).toString('base64url')),
}))

import { getDb } from '@/lib/db'
import { requireProjectAccess } from '@/lib/authz/projects'

const mockGetDb = vi.mocked(getDb)
const mockRequireProjectAccess = vi.mocked(requireProjectAccess)

const baseSession: AuthorizedSession = {
  userId: 'user_1',
  email: 'a@b.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

function mockDbSelect(rows: Array<{ prefs: Record<string, unknown> }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
    })),
  }
}

describe('resolveActiveProjectId', () => {
  it('returns explicit projectId when provided', async () => {
    const result = await resolveActiveProjectId(baseSession, 'explicit')
    expect(result).toBe('explicit')
    expect(mockGetDb).not.toHaveBeenCalled()
  })

  it('returns active_project_id from user_preferences', async () => {
    mockGetDb.mockReturnValue(
      mockDbSelect([{ prefs: { active_project_id: 'pref_1' } }]) as never,
    )
    const result = await resolveActiveProjectId(baseSession)
    expect(result).toBe('pref_1')
  })

  it('returns undefined when no preference exists', async () => {
    mockGetDb.mockReturnValue(mockDbSelect([]) as never)
    const result = await resolveActiveProjectId(baseSession)
    expect(result).toBeUndefined()
  })
})

describe('buildCollectionScopeFromRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds base-only scope for anonymous mode', async () => {
    process.env.REQUIRE_AUTH = 'false'
    const { scope, headerValue } = await buildCollectionScopeFromRequest(null, {})
    expect(scope).toEqual(['oib_knowledge'])
    expect(mockRequireProjectAccess).not.toHaveBeenCalled()
    delete process.env.REQUIRE_AUTH
  })

  it('authorizes project and includes proj_ corpus', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireProjectAccess.mockResolvedValue({ role: 'project-viewer' })
    const { scope } = await buildCollectionScopeFromRequest(baseSession, {
      projectId: 'proj_1',
      conversationId: 'conv_1',
    })
    expect(scope).toEqual(['oib_knowledge', 'proj_proj_1', 's_conv_1'])
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(
      baseSession,
      'proj_1',
      'project:view',
    )
    delete process.env.REQUIRE_AUTH
  })

  it('reads active project from preferences when no explicit id', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockGetDb.mockReturnValue(
      mockDbSelect([{ prefs: { active_project_id: 'pref_1' } }]) as never,
    )
    mockRequireProjectAccess.mockResolvedValue({ role: 'project-viewer' })
    const { scope } = await buildCollectionScopeFromRequest(baseSession, {})
    expect(scope).toEqual(['oib_knowledge', 'proj_pref_1'])
    delete process.env.REQUIRE_AUTH
  })
})
