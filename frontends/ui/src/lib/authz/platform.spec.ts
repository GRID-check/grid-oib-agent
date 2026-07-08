import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const getOrganizationByExternalId = vi.fn()
const listOrganizationMemberships = vi.fn()

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    organizations: { getOrganizationByExternalId },
    userManagement: { listOrganizationMemberships },
  }),
}))

const recordAuditEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}))

import { _clearPlatformCaches, isPlatformOwner, PLATFORM_OWNER_ROLE_SLUG } from './platform'
import type { GridSession } from '@/lib/auth/types'

const PLATFORM_ORG = 'org_platform'

const session = (overrides: Partial<GridSession> = {}): GridSession => ({
  userId: 'user_1',
  email: 'someone@grid.com',
  name: 'Someone',
  accessToken: 'token',
  organizationId: 'org_tenant',
  organizationMembershipId: 'om_1',
  role: 'admin',
  permissions: [],
  featureFlags: null,
  ...overrides,
})

describe('isPlatformOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearPlatformCaches()
    delete process.env.GRID_PLATFORM_OWNER_EMAILS
    getOrganizationByExternalId.mockResolvedValue({ id: PLATFORM_ORG })
    listOrganizationMemberships.mockResolvedValue({ data: [] })
  })

  it('is false for null sessions and tenant admins', async () => {
    expect(await isPlatformOwner(null)).toBe(false)
    expect(await isPlatformOwner(session())).toBe(false)
  })

  it('fast path: active platform org + role/permission claims', async () => {
    expect(
      await isPlatformOwner(session({ organizationId: PLATFORM_ORG, role: PLATFORM_OWNER_ROLE_SLUG })),
    ).toBe(true)
    expect(
      await isPlatformOwner(
        session({ organizationId: PLATFORM_ORG, role: 'member', permissions: ['platform:organizations:view'] }),
      ),
    ).toBe(true)
    // Membership in the platform org without the role is NOT enough.
    expect(await isPlatformOwner(session({ organizationId: PLATFORM_ORG, role: 'member' }))).toBe(false)
  })

  it('cross-org path: platform membership with the owner role (cached)', async () => {
    listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: PLATFORM_OWNER_ROLE_SLUG } }],
    })
    expect(await isPlatformOwner(session())).toBe(true)
    expect(await isPlatformOwner(session())).toBe(true)
    expect(listOrganizationMemberships).toHaveBeenCalledTimes(1) // cached
  })

  it('fails closed when WorkOS is unreachable', async () => {
    listOrganizationMemberships.mockRejectedValue(new Error('down'))
    expect(await isPlatformOwner(session())).toBe(false)
  })

  it('fails closed when the platform org is not provisioned', async () => {
    getOrganizationByExternalId.mockRejectedValue(new Error('not found'))
    expect(await isPlatformOwner(session())).toBe(false)
  })

  it('break-glass env allowlist works without any provisioning', async () => {
    process.env.GRID_PLATFORM_OWNER_EMAILS = 'owner@grid.com, second@grid.com'
    getOrganizationByExternalId.mockRejectedValue(new Error('not found'))
    expect(await isPlatformOwner(session({ email: 'Owner@grid.com' }))).toBe(true)
    expect(await isPlatformOwner(session({ email: 'intruder@grid.com' }))).toBe(false)
  })

  it('break-glass use is audited (throttled) into the platform org when it exists', async () => {
    process.env.GRID_PLATFORM_OWNER_EMAILS = 'owner@grid.com'
    expect(await isPlatformOwner(session({ email: 'owner@grid.com' }))).toBe(true)
    expect(await isPlatformOwner(session({ email: 'owner@grid.com' }))).toBe(true)
    expect(recordAuditEvent).toHaveBeenCalledTimes(1) // throttled per actor
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: PLATFORM_ORG,
        action: 'platform.access.break_glass',
      }),
    )
    // Access itself never depends on the audit emit.
    recordAuditEvent.mockRejectedValueOnce(new Error('audit down'))
  })

  it('break-glass still grants (log-only) when the platform org is missing', async () => {
    process.env.GRID_PLATFORM_OWNER_EMAILS = 'owner@grid.com'
    getOrganizationByExternalId.mockRejectedValue(new Error('not found'))
    expect(await isPlatformOwner(session({ email: 'owner@grid.com' }))).toBe(true)
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})
