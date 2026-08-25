/**
 * @vitest-environment node
 * THROW-AWAY adversarial probe #2. Delete before finishing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getOrganizationByExternalId = vi.fn()
const listOrganizationMemberships = vi.fn()
const listOrganizationRoles = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    organizations: { getOrganizationByExternalId },
    userManagement: { listOrganizationMemberships },
    authorization: { listOrganizationRoles },
  }),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))

import { isPlatformStaff, hasPlatformPermission, _clearPlatformCaches } from '@/lib/authz/platform'
import { setCacheStore, type CacheStore } from '@/lib/cache'
import type { GridSession } from '@/lib/auth/types'

class Store implements CacheStore {
  map = new Map<string, string>()
  async get(k: string) { return this.map.get(k) ?? null }
  async set(k: string, v: string) { this.map.set(k, v) }
  async delete(k: string) { this.map.delete(k) }
  async deletePrefix(p: string) { for (const k of [...this.map.keys()]) if (k.startsWith(p)) this.map.delete(k) }
}

const PLATFORM_ORG = 'org_platform'

const session = (o: Partial<GridSession> = {}): GridSession => ({
  userId: 'user_1', email: 'x@grid.test', name: 'X', accessToken: 't',
  organizationId: 'org_tenant', organizationMembershipId: 'om_1',
  role: 'member', permissions: [], featureFlags: null, ...o,
} as GridSession)

beforeEach(() => {
  vi.clearAllMocks()
  _clearPlatformCaches()
  setCacheStore(new Store())
  delete process.env.GRID_PLATFORM_OWNER_EMAILS
  getOrganizationByExternalId.mockResolvedValue({ id: PLATFORM_ORG })
})

describe('C3 — isPlatformStaff on the cross-org path admits a member holding NO platform permission', () => {
  it('a plain `member` of the GRID Platform org, browsing a tenant org, reads as platform staff', async () => {
    listOrganizationMemberships.mockResolvedValue({ data: [{ role: { slug: 'member' } }] })
    // What WorkOS says the `member` role holds inside the platform org.
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'member', permissions: ['org:projects:create'] }],
    })

    expect(await isPlatformStaff(session())).toBe(true)             // nav flag + platform shell
    expect(await hasPlatformPermission(session(), 'platform:organizations:view')).toBe(false)
    expect(await hasPlatformPermission(session(), 'platform:settings:view')).toBe(false)
  })

  it('the same person acting INSIDE the platform org is correctly NOT staff', async () => {
    const inside = session({ organizationId: PLATFORM_ORG, role: 'member', permissions: [] })
    expect(await isPlatformStaff(inside)).toBe(false)
  })
})
