/**
 * @vitest-environment node
 */
/**
 * The third-party role resolver's own spec.
 *
 * It shipped with none, on the authorization path, resolving what somebody ELSE
 * may reach — and an adversarial pass found a real defect in it that a single
 * test would have caught (the WorkOS-knows-the-slug-but-not-the-permission
 * branch hard-denied instead of falling back). These are the properties the
 * module's header claims.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const listEnvironmentRoles = vi.fn()
const listOrganizationRoles = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { listEnvironmentRoles, listOrganizationRoles } }),
}))

import {
  orgRoleHoldsPermission,
  organizationRoleHoldsPermission,
  organizationRolePermissions,
  tenantRolePermissions,
} from './org-role-permissions'
import { hasPermission, ORG_PERMISSIONS } from './permissions'
import { setCacheStore, type CacheStore } from '@/lib/cache'

class TestStore implements CacheStore {
  map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  /** The life each stored entry was given, in the order stored. */
  ttls: number[] = []
  async set(key: string, value: string, ttlMs = Number.POSITIVE_INFINITY): Promise<void> {
    this.ttls.push(ttlMs)
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key)
  }
}

const ORG = 'org_platform'

beforeEach(() => {
  vi.clearAllMocks()
  setCacheStore(new TestStore())
  listEnvironmentRoles.mockResolvedValue({ data: [] })
  listOrganizationRoles.mockResolvedValue({ data: [] })
})

describe('orgRoleHoldsPermission', () => {
  it('answers from WorkOS when WorkOS knows the permission', async () => {
    listEnvironmentRoles.mockResolvedValue({
      data: [{ slug: 'acme-owner', permissions: ['org:projects:administer'] }],
    })
    await expect(orgRoleHoldsPermission('acme-owner', 'org:projects:administer')).resolves.toBe(
      true
    )
  })

  it('does NOT invent a permission WorkOS and the catalog both withhold', async () => {
    listEnvironmentRoles.mockResolvedValue({
      data: [{ slug: 'acme-owner', permissions: ['org:audit:view'] }],
    })
    await expect(orgRoleHoldsPermission('acme-owner', 'org:projects:administer')).resolves.toBe(
      false
    )
  })

  it('agrees with hasPermission when WorkOS lags the catalog', async () => {
    // THE REGRESSION. A catalog that has shipped ahead of provisioning looks
    // exactly like this: WorkOS knows `admin` and does not list the permission.
    // Returning WorkOS's answer alone made this module deny where hasPermission
    // allows, so an org admin reached every project while nobody could invite
    // them to one — the divergence the module exists to prevent, inverted.
    listEnvironmentRoles.mockResolvedValue({
      data: [{ slug: 'admin', permissions: ['org:settings:manage'] }],
    })
    const session = { role: 'admin', permissions: [] }
    expect(hasPermission(session, ORG_PERMISSIONS.projectsAdminister)).toBe(true)
    await expect(orgRoleHoldsPermission('admin', ORG_PERMISSIONS.projectsAdminister)).resolves.toBe(
      true
    )
  })

  it('falls back to the catalog when WorkOS does not know the slug', async () => {
    listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'something-else', permissions: [] }] })
    await expect(orgRoleHoldsPermission('admin', ORG_PERMISSIONS.projectsAdminister)).resolves.toBe(
      true
    )
  })

  it('falls back to the catalog when the lookup throws — never to "yes"', async () => {
    listEnvironmentRoles.mockRejectedValue(new Error('workos down'))
    await expect(orgRoleHoldsPermission('admin', ORG_PERMISSIONS.projectsAdminister)).resolves.toBe(
      true
    )
    await expect(
      orgRoleHoldsPermission('member', ORG_PERMISSIONS.projectsAdminister)
    ).resolves.toBe(false)
  })

  it('a slug neither side knows resolves to nothing', async () => {
    listEnvironmentRoles.mockRejectedValue(new Error('workos down'))
    await expect(
      orgRoleHoldsPermission('never-heard-of-it', ORG_PERMISSIONS.projectsAdminister)
    ).resolves.toBe(false)
  })

  it('a null or empty slug denies without calling WorkOS', async () => {
    await expect(orgRoleHoldsPermission(null, ORG_PERMISSIONS.projectsAdminister)).resolves.toBe(
      false
    )
    await expect(orgRoleHoldsPermission('', ORG_PERMISSIONS.projectsAdminister)).resolves.toBe(
      false
    )
    expect(listEnvironmentRoles).not.toHaveBeenCalled()
  })

  it('caches the whole map, so N subjects cost one call', async () => {
    listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'admin', permissions: [] }] })
    await orgRoleHoldsPermission('admin', ORG_PERMISSIONS.projectsAdminister)
    await orgRoleHoldsPermission('member', ORG_PERMISSIONS.projectsAdminister)
    expect(listEnvironmentRoles).toHaveBeenCalledTimes(1)
  })
})

/**
 * The custom roles an office builds for itself in WorkOS exist only inside its
 * organization. A third-party check that consulted environment roles and the
 * catalog alone denied every one of them — the quarantine never reached a
 * custom „Geschäftsführung" role holding org:projects:administer.
 */
describe('orgRoleHoldsPermission — an organization\'s own custom roles', () => {
  it("finds a custom role's permission when told the organization", async () => {
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'org-geschaeftsfuehrung', permissions: ['org:projects:administer'] }],
    })
    await expect(
      orgRoleHoldsPermission('org-geschaeftsfuehrung', 'org:projects:administer', 'org_tenant')
    ).resolves.toBe(true)
    expect(listOrganizationRoles).toHaveBeenCalledWith('org_tenant')
  })

  it('counts a custom role granted the old org:archiv:manage as holding org:office_shelf:manage', async () => {
    // Roles built before the rename hold the old slug until the re-grant runbook has run.
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'org-kuratorin', permissions: ['org:archiv:manage'] }],
    })
    await expect(orgRoleHoldsPermission('org-kuratorin', 'org:office_shelf:manage', 'org_tenant')).resolves.toBe(true)
  })

  it('denies it without the organization, as before', async () => {
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'org-geschaeftsfuehrung', permissions: ['org:projects:administer'] }],
    })
    await expect(orgRoleHoldsPermission('org-geschaeftsfuehrung', 'org:projects:administer')).resolves.toBe(false)
  })

  it('still answers an environment role when the organization lookup fails', async () => {
    listOrganizationRoles.mockRejectedValue(new Error('rate limited'))
    listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'admin', permissions: ['org:projects:administer'] }] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(orgRoleHoldsPermission('admin', 'org:projects:administer', 'org_tenant')).resolves.toBe(true)
    warn.mockRestore()
  })
})

describe('organization-scoped roles', () => {
  it('unions WorkOS with the catalog rather than replacing it', async () => {
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'org-platform-support', permissions: ['platform:organizations:view'] }],
    })
    const held = await organizationRolePermissions(ORG, 'org-platform-support')
    expect(held.has('platform:organizations:view')).toBe(true)
    // From the catalog: WorkOS has not been re-provisioned for it yet.
    expect(held.has('platform:settings:view')).toBe(true)
    // Held by neither, and therefore not granted.
    expect(held.has('platform:settings:manage')).toBe(false)
  })

  it('keeps a custom platform role the catalog has never heard of', async () => {
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'acme-platform-auditor', permissions: ['platform:usage:view'] }],
    })
    const held = await organizationRolePermissions(ORG, 'acme-platform-auditor')
    expect([...held]).toEqual(['platform:usage:view'])
  })

  it('organizationRoleHoldsPermission unions the same way', async () => {
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'org-platform-support', permissions: [] }],
    })
    await expect(
      organizationRoleHoldsPermission(ORG, 'org-platform-support', 'platform:usage:view')
    ).resolves.toBe(true)
    await expect(
      organizationRoleHoldsPermission(ORG, 'org-platform-support', 'platform:settings:manage')
    ).resolves.toBe(false)
  })

  it('is keyed per organization, so two orgs cannot read each other', async () => {
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'r', permissions: ['platform:usage:view'] }],
    })
    await organizationRolePermissions('org_a', 'r')
    await organizationRolePermissions('org_b', 'r')
    expect(listOrganizationRoles).toHaveBeenCalledTimes(2)
  })
})

/**
 * The whole set a tenant role holds, for a session built without a sign-in
 * (`auth/pinned-session.ts`). The same union as orgRoleHoldsPermission, so a
 * background job run as a person may do what that person may do signed in.
 */
describe('tenantRolePermissions', () => {
  const TENANT = 'org_tenant'

  it("holds an organization's own custom role, which the catalog cannot know", async () => {
    listOrganizationRoles.mockResolvedValue({
      data: [{ slug: 'org-geschaeftsfuehrung', permissions: ['org:projects:administer'] }],
    })
    const held = await tenantRolePermissions(TENANT, 'org-geschaeftsfuehrung')
    expect([...held]).toEqual(['org:projects:administer'])
    expect(listOrganizationRoles).toHaveBeenCalledWith(TENANT)
  })

  it('holds a custom environment role', async () => {
    listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'acme-owner', permissions: ['org:audit:view'] }] })
    expect([...(await tenantRolePermissions(TENANT, 'acme-owner'))]).toEqual(['org:audit:view'])
  })

  it('unions WorkOS with the catalog, so a lagging environment loses nothing', async () => {
    listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'member', permissions: ['org:audit:view'] }] })
    const held = await tenantRolePermissions(TENANT, 'member')
    expect(held.has('org:audit:view')).toBe(true)
    expect(held.has('org:projects:create')).toBe(true)
  })

  it('keeps a retired slug as granted, for hasPermission to accept', async () => {
    listOrganizationRoles.mockResolvedValue({ data: [{ slug: 'org-kuratorin', permissions: ['org:archiv:manage'] }] })
    const held = await tenantRolePermissions(TENANT, 'org-kuratorin')
    const session = { role: 'org-kuratorin', permissions: [...held] }
    expect(hasPermission(session, ORG_PERMISSIONS.officeShelfManage)).toBe(true)
  })

  it('is empty for a slug nobody knows, and for no slug, without asking WorkOS for the latter', async () => {
    expect((await tenantRolePermissions(TENANT, 'never-heard-of-it')).size).toBe(0)
    vi.clearAllMocks()
    expect((await tenantRolePermissions(TENANT, null)).size).toBe(0)
    expect(listEnvironmentRoles).not.toHaveBeenCalled()
  })

  it("answers a catalog role from the catalog when WorkOS cannot be asked", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    listEnvironmentRoles.mockRejectedValue(new Error('workos down'))
    listOrganizationRoles.mockRejectedValue(new Error('workos down'))
    expect([...(await tenantRolePermissions(TENANT, 'member'))]).toEqual(['org:projects:create'])
    warn.mockRestore()
  })

  it('answers a custom role from the lookup that did answer', async () => {
    listEnvironmentRoles.mockRejectedValue(new Error('workos down'))
    listOrganizationRoles.mockResolvedValue({ data: [{ slug: 'org-site-lead', permissions: ['org:audit:view'] }] })
    expect([...(await tenantRolePermissions(TENANT, 'org-site-lead'))]).toEqual(['org:audit:view'])
  })

  it('throws for a role only WorkOS could answer for, rather than read it as holding nothing', async () => {
    listEnvironmentRoles.mockRejectedValue(new Error('workos down'))
    await expect(tenantRolePermissions(TENANT, 'acme-owner')).rejects.toThrow('workos down')
  })

  it('does not cache a failed lookup', async () => {
    const store = new TestStore()
    setCacheStore(store)
    listOrganizationRoles.mockRejectedValue(new Error('workos down'))
    await expect(tenantRolePermissions(TENANT, 'org-site-lead')).rejects.toThrow('workos down')
    expect([...store.map.keys()]).toEqual(['authz:env-role-permissions'])
  })
})

describe('how long what a role holds is remembered', () => {
  it('at most a minute, like the roles a person holds: the folder bypass is derived from both', async () => {
    const store = new TestStore()
    setCacheStore(store)

    await orgRoleHoldsPermission('admin', ORG_PERMISSIONS.projectsAdminister, ORG)

    expect(store.ttls).toHaveLength(2)
    for (const ttl of store.ttls) expect(ttl).toBeLessThanOrEqual(60_000)
  })
})
