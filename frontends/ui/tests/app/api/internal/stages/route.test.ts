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

vi.mock('@/lib/projects/repository', () => ({ findProjectTenancy: vi.fn(async () => null) }))

import { GET } from '@/app/api/internal/stages/route'
import { findProjectTenancy } from '@/lib/projects/repository'
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
  it('withdraws research and tasks in a closed project, and only there (ADR-0089)', async () => {
    const PROJECT = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_123', deletedAt: null, status: 'closed' })
    const closed = await GET(makeRequest(`?organizationId=org_123&projectId=${PROJECT}`, REAL_TOKEN))
    await expect(closed.json()).resolves.toMatchObject({ features: { deepResearch: false, tasks: false } })

    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_123', deletedAt: null, status: 'active' })
    const active = await GET(makeRequest(`?organizationId=org_123&projectId=${PROJECT}`, REAL_TOKEN))
    await expect(active.json()).resolves.toMatchObject({ features: { deepResearch: true, tasks: true } })

    // Another organization's project decides nothing here.
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org_other', deletedAt: null, status: 'closed' })
    const foreign = await GET(makeRequest(`?organizationId=org_123&projectId=${PROJECT}`, REAL_TOKEN))
    await expect(foreign.json()).resolves.toMatchObject({ features: { deepResearch: true, tasks: true } })
  })

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
