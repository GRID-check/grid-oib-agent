import { beforeEach, describe, expect, it, vi } from 'vitest'

const createOrganization = vi.fn()
const createOrganizationMembership = vi.fn()

vi.mock('@workos-inc/authkit-nextjs', () => ({
  refreshSession: vi.fn().mockResolvedValue({ user: { id: 'user_1' } }),
}))

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    organizations: { createOrganization },
    userManagement: { createOrganizationMembership },
  }),
}))

import { POST } from './route'

const request = (body: unknown): Request =>
  new Request('http://localhost/api/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/organizations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.GRID_DISABLE_SELF_SERVE_ORGS
    createOrganization.mockResolvedValue({ id: 'org_new' })
    createOrganizationMembership.mockResolvedValue({})
  })

  it('creates an org and makes the caller admin', async () => {
    const res = await POST(request({ name: 'Acme' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ organizationId: 'org_new' })
    expect(createOrganizationMembership).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1', organizationId: 'org_new', roleSlug: 'admin' })
    )
  })

  it('is blocked when self-serve org creation is disabled (invite-only platform)', async () => {
    process.env.GRID_DISABLE_SELF_SERVE_ORGS = 'true'
    const res = await POST(request({ name: 'Acme' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'self-serve-disabled' })
    expect(createOrganization).not.toHaveBeenCalled()
  })

  it('never leaks provider error messages to the client', async () => {
    createOrganization.mockRejectedValue(
      new Error('WorkOS internal: connection cfg_123 misconfigured')
    )
    const res = await POST(request({ name: 'Acme' }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'create-failed' })
  })
})
