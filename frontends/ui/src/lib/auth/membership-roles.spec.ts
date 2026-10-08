/**
 * @vitest-environment node
 *
 * The roles behind a folder-access decision come from the WorkOS membership,
 * at most a minute stale (ADR-0087), and the token is only the fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const listOrganizationMemberships = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ userManagement: { listOrganizationMemberships } }),
}))

const getCached = vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader())
vi.mock('@/lib/cache', () => ({
  getCached: (key: string, ttl: number, loader: () => Promise<unknown>) => getCached(key, ttl, loader),
}))

import { MEMBERSHIP_ROLES_TTL_MS, resolveMembershipRoles, rolesOfMembership } from './membership-roles'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveMembershipRoles', () => {
  it('reads the ACTIVE membership, keyed by organization and person, for at most a minute', async () => {
    listOrganizationMemberships.mockResolvedValue({
      data: [{ role: { slug: 'member' }, roles: [{ slug: 'member' }, { slug: 'org-gf' }] }],
    })

    expect(await resolveMembershipRoles('org_1', 'user_1')).toEqual(['member', 'org-gf'])
    expect(listOrganizationMemberships).toHaveBeenCalledWith({
      userId: 'user_1',
      organizationId: 'org_1',
      statuses: ['active'],
      limit: 1,
    })
    expect(getCached).toHaveBeenCalledWith('membership-roles:org_1:user_1', MEMBERSHIP_ROLES_TTL_MS, expect.any(Function))
    expect(MEMBERSHIP_ROLES_TTL_MS).toBeLessThanOrEqual(60_000)
  })

  it('answers no roles for someone who is not an active member', async () => {
    listOrganizationMemberships.mockResolvedValue({ data: [] })
    expect(await resolveMembershipRoles('org_1', 'user_gone')).toEqual([])
  })

  it('answers null, uncached, when WorkOS cannot be asked, so the caller falls back to the token', async () => {
    getCached.mockRejectedValueOnce(new Error('WorkOS down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveMembershipRoles('org_1', 'user_1')).toBeNull()
  })
})

describe('rolesOfMembership', () => {
  it('takes every listed role, else the single one', () => {
    expect(rolesOfMembership({ roles: [{ slug: 'a' }, { slug: 'a' }, { slug: 'b' }] })).toEqual(['a', 'b'])
    expect(rolesOfMembership({ role: { slug: 'member' }, roles: [] })).toEqual(['member'])
    expect(rolesOfMembership({})).toEqual([])
  })
})
