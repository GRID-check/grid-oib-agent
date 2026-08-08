/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'member@grid.com',
  role: 'member',
  permissions: [] as string[],
}

const requireAuthorizedSession = vi.fn(async () => session)

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: () => requireAuthorizedSession(),
}))

const getConnectionDiagnostics = vi.fn()

vi.mock('@/lib/budgets/service', () => ({
  getConnectionDiagnostics: (...args: unknown[]) => getConnectionDiagnostics(...args),
}))

import { GET } from './route'

const request = (url = 'http://localhost/api/auth/connection-diagnostics'): Request =>
  new Request(url)

describe('GET /api/auth/connection-diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAuthorizedSession.mockImplementation(async () => session)
  })

  it('rejects an unauthenticated caller and never runs the budget check', async () => {
    requireAuthorizedSession.mockRejectedValueOnce(new Error('Unauthorized'))
    const res = await GET(request())
    expect(res.status).toBe(403)
    expect(getConnectionDiagnostics).not.toHaveBeenCalled()
  })

  it('returns the budget diagnostics for the session, forwarding projectId', async () => {
    getConnectionDiagnostics.mockResolvedValue({
      budgetExhausted: true,
      blockedScope: 'member',
      canManageBudgets: false,
    })

    const res = await GET(
      request('http://localhost/api/auth/connection-diagnostics?projectId=proj-9')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ budgetExhausted: true, blockedScope: 'member', canManageBudgets: false })
    expect(getConnectionDiagnostics).toHaveBeenCalledWith(session, { projectId: 'proj-9' })
  })

  it('omits projectId when the query param is absent', async () => {
    getConnectionDiagnostics.mockResolvedValue({
      budgetExhausted: false,
      blockedScope: null,
      canManageBudgets: true,
    })

    const res = await GET(request())

    expect(res.status).toBe(200)
    expect(getConnectionDiagnostics).toHaveBeenCalledWith(session, {})
  })
})
