/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const permissions: { value: string[] } = { value: [] }

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => ({
    userId: 'user_1',
    organizationId: 'org_1',
    role: 'member',
    permissions: permissions.value,
  })),
  authzErrorResponse: () => null,
}))

const generateAuditPortalLink = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  generateAuditPortalLink: (...args: unknown[]) => generateAuditPortalLink(...args),
  trustedAppOrigin: (request: Request) => new URL(request.url).origin,
}))

import { POST } from './route'

const request = (): Request =>
  new Request('https://grid.example/api/organization/audit-portal', { method: 'POST' })

describe('POST /api/organization/audit-portal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    permissions.value = []
  })

  it('rejects sessions without org:audit:view', async () => {
    expect((await POST(request())).status).toBe(403)
    expect(generateAuditPortalLink).not.toHaveBeenCalled()
  })

  it('returns an org-scoped portal link for authorized viewers', async () => {
    permissions.value = ['org:audit:view']
    generateAuditPortalLink.mockResolvedValue('https://portal.workos.com/x')
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect((await res.json()).link).toBe('https://portal.workos.com/x')
    // Scoped to the CALLER's org — never a caller-chosen one.
    expect(generateAuditPortalLink).toHaveBeenCalledWith(
      'org_1',
      'https://grid.example/app/organization'
    )
  })

  it('maps WorkOS failures to 502 without leaking details', async () => {
    permissions.value = ['org:audit:view']
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    generateAuditPortalLink.mockRejectedValue(new Error('workos internal detail'))
    const res = await POST(request())
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('portal-unavailable')
    consoleError.mockRestore()
  })
})
