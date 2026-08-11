/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/skills/service', () => ({
  resolveSkillsForAgent: vi.fn(),
}))

import { GET } from '@/app/api/internal/skills/resolve/route'
import { resolveSkillsForAgent } from '@/lib/skills/service'

const mockResolve = vi.mocked(resolveSkillsForAgent)

const REAL_TOKEN = 'a-real-secret-token'

function makeRequest(url: string, token?: string): Request {
  return new Request(`https://grid.test${url}`, {
    headers: token ? { 'x-grid-internal-token': token } : {},
  })
}

const resolvedSkill = {
  name: 'data-table-analysis',
  description: 'Analyze tables.',
  body: '# Skill',
  metadata: {},
  origin: 'platform' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/internal/skills/resolve', () => {
  it('returns 503 when the internal token is unconfigured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    const res = await GET(makeRequest('/api/internal/skills/resolve?organization_id=org_1', REAL_TOKEN))
    expect(res.status).toBe(503)
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('returns 403 without the token header', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const res = await GET(makeRequest('/api/internal/skills/resolve?organization_id=org_1'))
    expect(res.status).toBe(403)
  })

  it('400s without an organization_id', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const res = await GET(makeRequest('/api/internal/skills/resolve', REAL_TOKEN))
    expect(res.status).toBe(400)
  })

  it('resolves skills for an organization and optional agent', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    mockResolve.mockResolvedValue({ skills: [resolvedSkill] })
    const res = await GET(
      makeRequest('/api/internal/skills/resolve?organization_id=org_1&agent=deep_researcher', REAL_TOKEN)
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skills: [resolvedSkill] })
    expect(mockResolve).toHaveBeenCalledWith('org_1', 'deep_researcher')
  })

  it('omits the agent argument when the query has none', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    mockResolve.mockResolvedValue({ skills: [] })
    await GET(makeRequest('/api/internal/skills/resolve?organization_id=org_1', REAL_TOKEN))
    expect(mockResolve).toHaveBeenCalledWith('org_1', undefined)
  })
})