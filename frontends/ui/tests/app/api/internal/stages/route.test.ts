/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `@/lib/api/handler` reaches the AuthKit session module transitively; the
// internal-token routes never use it, and it does not load under vitest.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/workos/feature-flags', () => ({
  enabledPostAnswerStages: vi.fn(),
  isDeepResearchEnabledForOrg: vi.fn(),
  isTaskAutomationEnabledForOrg: vi.fn(),
}))

import { GET } from '@/app/api/internal/stages/route'
import {
  enabledPostAnswerStages,
  isDeepResearchEnabledForOrg,
  isTaskAutomationEnabledForOrg,
} from '@/lib/workos/feature-flags'

const mockEnabled = vi.mocked(enabledPostAnswerStages)
const mockDeepResearch = vi.mocked(isDeepResearchEnabledForOrg)
const mockTasks = vi.mocked(isTaskAutomationEnabledForOrg)

const REAL_TOKEN = 'a-real-secret-token'

function makeRequest(query: string, token?: string): Request {
  return new Request(`https://grid.test/api/internal/stages${query}`, {
    headers: token ? { 'x-grid-internal-token': token } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
  mockEnabled.mockResolvedValue(['memory_reflection'])
  mockDeepResearch.mockResolvedValue(true)
  mockTasks.mockResolvedValue(true)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/internal/stages', () => {
  it('serves the enabled stage ids for the organization', async () => {
    const res = await GET(makeRequest('?organizationId=org_123', REAL_TOKEN))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      enabled: ['memory_reflection'],
      features: { deepResearch: true, tasks: true },
    })
    expect(mockEnabled).toHaveBeenCalledWith('org_123')
  })

  it('serves each capability the answering agent may not offer', async () => {
    // The whole point of `features`: the agent reads it BEFORE writing the
    // answer, so a tenant is never handed a plan or an Auftrag that the route
    // behind it would refuse.
    mockDeepResearch.mockResolvedValue(false)
    mockTasks.mockResolvedValue(false)

    const res = await GET(makeRequest('?organizationId=org_123', REAL_TOKEN))

    await expect(res.json()).resolves.toMatchObject({
      features: { deepResearch: false, tasks: false },
    })
    expect(mockDeepResearch).toHaveBeenCalledWith('org_123')
    expect(mockTasks).toHaveBeenCalledWith('org_123')
  })

  it('withdraws the two capabilities independently', async () => {
    mockTasks.mockResolvedValue(false)

    const res = await GET(makeRequest('?organizationId=org_123', REAL_TOKEN))

    await expect(res.json()).resolves.toMatchObject({
      features: { deepResearch: true, tasks: false },
    })
  })

  it('serves the org-less decision too, so a dev deployment is not stuck on the socket value', async () => {
    const res = await GET(makeRequest('', REAL_TOKEN))
    expect(res.status).toBe(200)
    expect(mockEnabled).toHaveBeenCalledWith(undefined)
  })

  it('refuses without the internal token', async () => {
    const res = await GET(makeRequest('?organizationId=org_123'))
    expect(res.status).toBe(403)
    expect(mockEnabled).not.toHaveBeenCalled()
    expect(mockDeepResearch).not.toHaveBeenCalled()
    expect(mockTasks).not.toHaveBeenCalled()
  })

  it('rejects an organization id that is not a WorkOS id', async () => {
    const res = await GET(makeRequest('?organizationId=../../etc/passwd', REAL_TOKEN))
    expect(res.status).toBe(400)
    expect(mockEnabled).not.toHaveBeenCalled()
    expect(mockDeepResearch).not.toHaveBeenCalled()
    expect(mockTasks).not.toHaveBeenCalled()
  })
})
