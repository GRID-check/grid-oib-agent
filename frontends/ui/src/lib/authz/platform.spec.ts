/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const getOrganizationByExternalId = vi.fn()
const listOrganizationMemberships = vi.fn()
const listOrganizationRoles = vi.fn()
const listEnvironmentRoles = vi.fn()

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    organizations: { getOrganizationByExternalId },
    userManagement: { listOrganizationMemberships },
    authorization: { listOrganizationRoles, listEnvironmentRoles },
  }),
}))

const recordAuditEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args),
}))

import {
  _clearPlatformCaches,
  hasPlatformPermission,
  isPlatformStaff,
  PLATFORM_ORG_EXTERNAL_ID,
  PLATFORM_OWNER_ROLE_SLUG,
  PlatformAccessDeniedError,
  platformPermissions,
  requirePlatformPermission,
} from './platform'
import { setCacheStore, type CacheStore } from '@/lib/cache'
import type { GridSession } from '@/lib/auth/types'

const PLATFORM_ORG = 'org_platform'
const SUPPORT_ROLE_SLUG = 'org-platform-support'

/** In-process store, cleared per test so a cached role list cannot leak across. */
class TestStore implements CacheStore {
  map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key)
  }
}

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

describe('platform tier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearPlatformCaches()
    setCacheStore(new TestStore())
    delete process.env.GRID_PLATFORM_OWNER_EMAILS
    getOrganizationByExternalId.mockResolvedValue({ id: PLATFORM_ORG })
    listOrganizationMemberships.mockResolvedValue({ data: [] })
    // What WorkOS says the two platform-org roles hold. Mirrors the catalog,
    // which is also the fallback when this call fails.
    listOrganizationRoles.mockResolvedValue({
      data: [
        {
          slug: PLATFORM_OWNER_ROLE_SLUG,
          permissions: [
            'platform:organizations:view',
            'platform:organizations:manage',
            'platform:usage:view',
            'platform:settings:view',
            'platform:settings:manage',
          ],
        },
        {
          slug: SUPPORT_ROLE_SLUG,
          permissions: [
            'platform:organizations:view',
            'platform:usage:view',
            'platform:settings:view',
          ],
        },
      ],
    })
  })

  it('exposes the platform org external id the runbook provisions', () => {
    expect(PLATFORM_ORG_EXTERNAL_ID).toBeTruthy()
  })

  describe('isPlatformStaff — the precondition', () => {
    it('is false for null sessions and tenant admins', async () => {
      expect(await isPlatformStaff(null)).toBe(false)
      expect(await isPlatformStaff(session())).toBe(false)
    })

    it('fast path: active platform org + role or permission claims', async () => {
      expect(
        await isPlatformStaff(
          session({ organizationId: PLATFORM_ORG, role: PLATFORM_OWNER_ROLE_SLUG })
        )
      ).toBe(true)
      expect(
        await isPlatformStaff(
          session({
            organizationId: PLATFORM_ORG,
            role: 'member',
            permissions: ['platform:organizations:view'],
          })
        )
      ).toBe(true)
      // Membership in the platform org without a platform role or claim is NOT
      // enough — the org is not a permission.
      expect(await isPlatformStaff(session({ organizationId: PLATFORM_ORG, role: 'member' }))).toBe(
        false
      )
    })

    it('cross-org path: any platform-org role counts, and is cached', async () => {
      listOrganizationMemberships.mockResolvedValue({
        data: [{ role: { slug: PLATFORM_OWNER_ROLE_SLUG } }],
      })
      expect(await isPlatformStaff(session())).toBe(true)
      expect(await isPlatformStaff(session())).toBe(true)
      expect(listOrganizationMemberships).toHaveBeenCalledTimes(1) // cached
    })

    it('cross-org path reaches SUPPORT too, which the owner-slug match hid', async () => {
      listOrganizationMemberships.mockResolvedValue({
        data: [{ role: { slug: SUPPORT_ROLE_SLUG } }],
      })
      expect(await isPlatformStaff(session())).toBe(true)
      expect(await hasPlatformPermission(session(), 'platform:organizations:view')).toBe(true)
    })

    it('fails closed when WorkOS is unreachable', async () => {
      listOrganizationMemberships.mockRejectedValue(new Error('down'))
      expect(await isPlatformStaff(session())).toBe(false)
    })

    it('fails closed when the platform org is not provisioned', async () => {
      getOrganizationByExternalId.mockRejectedValue(new Error('not found'))
      expect(await isPlatformStaff(session())).toBe(false)
    })
  })

  describe('read-only Platform Support holds no write permission', () => {
    // The defect this replaced: every platform route was gated on one binary
    // "is this platform staff", and Support passed it — so a role documented as
    // changing nothing could PUT the model defaults and DELETE base-corpus
    // documents.
    const support = () =>
      session({
        organizationId: PLATFORM_ORG,
        role: SUPPORT_ROLE_SLUG,
        permissions: [
          'platform:organizations:view',
          'platform:usage:view',
          'platform:settings:view',
        ],
      })

    it('holds every read permission', async () => {
      expect(await hasPlatformPermission(support(), 'platform:organizations:view')).toBe(true)
      expect(await hasPlatformPermission(support(), 'platform:usage:view')).toBe(true)
      expect(await hasPlatformPermission(support(), 'platform:settings:view')).toBe(true)
    })

    it('holds NO write permission', async () => {
      expect(await hasPlatformPermission(support(), 'platform:settings:manage')).toBe(false)
      expect(await hasPlatformPermission(support(), 'platform:organizations:manage')).toBe(false)
    })

    it('requirePlatformPermission throws for the writes and passes the reads', async () => {
      await expect(
        requirePlatformPermission(support(), 'platform:settings:manage')
      ).rejects.toBeInstanceOf(PlatformAccessDeniedError)
      await expect(
        requirePlatformPermission(support(), 'platform:settings:view')
      ).resolves.toBeUndefined()
    })

    it('the same holds on the cross-org path', async () => {
      listOrganizationMemberships.mockResolvedValue({
        data: [{ role: { slug: SUPPORT_ROLE_SLUG } }],
      })
      expect(await hasPlatformPermission(session(), 'platform:usage:view')).toBe(true)
      expect(await hasPlatformPermission(session(), 'platform:settings:manage')).toBe(false)
    })
  })

  it('the OWNER holds every platform permission, on both paths', async () => {
    const inside = session({ organizationId: PLATFORM_ORG, role: PLATFORM_OWNER_ROLE_SLUG })
    expect(await hasPlatformPermission(inside, 'platform:settings:manage')).toBe(true)
    expect(await hasPlatformPermission(inside, 'platform:organizations:manage')).toBe(true)

    _clearPlatformCaches()
    setCacheStore(new TestStore())
    listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: PLATFORM_OWNER_ROLE_SLUG } }],
    })
    expect(await hasPlatformPermission(session(), 'platform:settings:manage')).toBe(true)
  })

  it('falls back to the catalog when the role lookup fails, never to "yes"', async () => {
    listOrganizationRoles.mockRejectedValue(new Error('roles down'))
    listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: SUPPORT_ROLE_SLUG } }],
    })
    // The catalog says Support holds the three reads and neither write.
    expect(await hasPlatformPermission(session(), 'platform:usage:view')).toBe(true)
    expect(await hasPlatformPermission(session(), 'platform:settings:manage')).toBe(false)
  })

  describe('break-glass', () => {
    it('works without any provisioning, and grants every platform permission', async () => {
      process.env.GRID_PLATFORM_OWNER_EMAILS = 'owner@grid.com, second@grid.com'
      getOrganizationByExternalId.mockRejectedValue(new Error('not found'))
      expect(await isPlatformStaff(session({ email: 'Owner@grid.com' }))).toBe(true)
      // Total by design: it exists to recover an unprovisioned environment, and
      // a partial grant would leave the recovery half-usable.
      expect(
        await hasPlatformPermission(
          session({ email: 'owner@grid.com' }),
          'platform:settings:manage'
        )
      ).toBe(true)
      expect(await isPlatformStaff(session({ email: 'intruder@grid.com' }))).toBe(false)
    })

    it('is audited (throttled) into the platform org when it exists', async () => {
      process.env.GRID_PLATFORM_OWNER_EMAILS = 'owner@grid.com'
      expect(await isPlatformStaff(session({ email: 'owner@grid.com' }))).toBe(true)
      expect(await isPlatformStaff(session({ email: 'owner@grid.com' }))).toBe(true)
      expect(recordAuditEvent).toHaveBeenCalledTimes(1) // throttled per actor
      expect(recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: PLATFORM_ORG,
          action: 'platform.access.break_glass',
        })
      )
    })

    it('still grants (log-only) when the platform org is missing', async () => {
      process.env.GRID_PLATFORM_OWNER_EMAILS = 'owner@grid.com'
      getOrganizationByExternalId.mockRejectedValue(new Error('not found'))
      expect(await isPlatformStaff(session({ email: 'owner@grid.com' }))).toBe(true)
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })
  })

  it('platformPermissions distinguishes "not staff" from "staff holding nothing"', async () => {
    expect(await platformPermissions(session())).toBeNull()

    // A fresh membership cache: the "no membership" answer above is cached per
    // user, and caching it is the point (a non-member costs one lookup per TTL).
    _clearPlatformCaches()
    listOrganizationMemberships.mockResolvedValue({ data: [{ role: { slug: 'unknown-role' } }] })
    // A member whose role the catalog and WorkOS both report as empty is staff
    // with no permissions, which must still deny every surface.
    listOrganizationRoles.mockResolvedValue({ data: [{ slug: 'unknown-role', permissions: [] }] })
    const permissions = await platformPermissions(session())
    expect(permissions).not.toBeNull()
    expect(permissions?.size).toBe(0)
    expect(await isPlatformStaff(session())).toBe(false)
  })
})
