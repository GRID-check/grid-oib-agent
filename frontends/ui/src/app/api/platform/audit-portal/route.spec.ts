/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }
const platformOrgId = { value: 'org_platform' as string | null }

vi.mock('@/lib/auth/session', () => ({
  getGridSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1' }),
}))

vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error {
    readonly status = 403
  }
  return {
    PlatformAccessDeniedError,
    requirePlatformOwner: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
    getPlatformOrganizationId: vi.fn().mockImplementation(async () => platformOrgId.value),
  }
})

const generateAuditPortalLink = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  generateAuditPortalLink: (...args: unknown[]) => generateAuditPortalLink(...args),
  trustedAppOrigin: (request: Request) => new URL(request.url).origin,
}))

import { POST } from './route'

const request = (): Request =>
  new Request('https://grid.example/api/platform/audit-portal', { method: 'POST' })

describe('POST /api/platform/audit-portal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
    platformOrgId.value = 'org_platform'
  })

  it('rejects non-owners with 403', async () => {
    expect((await POST(request())).status).toBe(403)
  })

  it('links to the PLATFORM org trail for the owner', async () => {
    isOwner.value = true
    generateAuditPortalLink.mockResolvedValue('https://portal.workos.com/p')
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect((await res.json()).link).toBe('https://portal.workos.com/p')
    expect(generateAuditPortalLink).toHaveBeenCalledWith(
      'org_platform',
      'https://grid.example/app/platform'
    )
  })

  it('returns 404 when the platform org is not provisioned (break-glass phase)', async () => {
    isOwner.value = true
    platformOrgId.value = null
    expect((await POST(request())).status).toBe(404)
  })
})
