import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { checkProjectConsistency } from './profile-service'

const session = { userId: 'user-1', organizationId: 'org-1' } as never

describe('checkProjectConsistency authorization (FB-13)', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ findings: [] }) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires project:edit — the pre-save check runs only for editors', async () => {
    await checkProjectConsistency(session, 'proj-1', { freeText: [] })

    // Aligned with generateProjectSummary; viewers cannot save the wizard, so the
    // check must not be reachable with the broader project:view.
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:edit')
  })

  it('propagates an authorization failure and never reaches the backend', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new Error('forbidden'))

    await expect(checkProjectConsistency(session, 'proj-1', { freeText: [] })).rejects.toThrow('forbidden')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
