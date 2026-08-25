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
} from './org-role-permissions'
import { hasPermission, ORG_PERMISSIONS } from './permissions'
import { setCacheStore, type CacheStore } from '@/lib/cache'

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
