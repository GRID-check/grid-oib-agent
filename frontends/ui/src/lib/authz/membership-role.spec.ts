/**
 * @vitest-environment node
 */
/**
 * Resolving an org role from a MEMBERSHIP ID (ADR-0038, ADR-0054).
 *
 * This is the only place in the product where a role comes from a payload
 * rather than from a session's own claims, and the answer decides an org-wide
 * bypass. Two properties carry that weight and neither is visible from the call
 * site: the membership must belong to the organization it is used in, and every
 * uncertainty must resolve to `null`, which denies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// A pass-through cache: this suite is about what is RESOLVED, and the cache's
// own behaviour is `cache.spec.ts`'s. The key it is called with is asserted
// below, because that is the half a pass-through cannot make true.
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: vi.fn(),
}))

vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))

import { getCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'
import { resolveMembershipRole } from './membership-role'

const ORG = 'org_1'
const MEMBERSHIP = 'om_1'

const getOrganizationMembership = vi.fn()

function membership(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBERSHIP,
    organizationId: ORG,
    status: 'active',
    role: { slug: 'admin' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(getWorkOS).mockReturnValue({
    userManagement: { getOrganizationMembership },
  } as never)
  getOrganizationMembership.mockResolvedValue(membership())
})

afterEach(() => vi.clearAllMocks())

describe('resolveMembershipRole', () => {
  it('resolves the role slug and caches it ORG-KEYED', async () => {
    await expect(resolveMembershipRole(ORG, MEMBERSHIP)).resolves.toBe('admin')
    expect(getOrganizationMembership).toHaveBeenCalledWith(MEMBERSHIP)
    // A key without the organization would serve whatever the first caller
    // populated, to every tenant after it (`frontends/ui/AGENTS.md`).
    expect(getCached).toHaveBeenCalledWith(
      expect.stringContaining(`${ORG}:${MEMBERSHIP}`),
      expect.any(Number),
      expect.any(Function)
    )
  })

  it('refuses a membership belonging to another organization', async () => {
    // The id arrives in a payload. Without this comparison it would be a way to
    // import a role across the tenant boundary.
    getOrganizationMembership.mockResolvedValue(membership({ organizationId: 'org_2' }))

    await expect(resolveMembershipRole(ORG, MEMBERSHIP)).resolves.toBeNull()
  })

  it('refuses a membership that is not active', async () => {
    for (const status of ['pending', 'inactive']) {
      getOrganizationMembership.mockResolvedValue(membership({ status }))
      await expect(resolveMembershipRole(ORG, MEMBERSHIP), status).resolves.toBeNull()
    }
  })

  it('answers null — never a guess — for a missing id, a nameless role or a WorkOS outage', async () => {
    await expect(resolveMembershipRole(ORG, null)).resolves.toBeNull()
    await expect(resolveMembershipRole('', MEMBERSHIP)).resolves.toBeNull()
    expect(getOrganizationMembership).not.toHaveBeenCalled()

    getOrganizationMembership.mockResolvedValue(membership({ role: undefined }))
    await expect(resolveMembershipRole(ORG, MEMBERSHIP)).resolves.toBeNull()

    getOrganizationMembership.mockRejectedValue(new Error('WorkOS is away'))
    await expect(resolveMembershipRole(ORG, MEMBERSHIP)).resolves.toBeNull()
  })
})
