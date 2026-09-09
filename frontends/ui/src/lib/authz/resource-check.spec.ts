/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const check = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { check } }),
}))

import { checkResourcePermission } from './resource-check'
import { setCacheStore, type CacheStore } from '@/lib/cache'

/** Same controllable store as `projects.spec.ts`: no TTL expiry, full key visibility. */
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

const INPUT = {
  organizationMembershipId: 'om_1',
  organizationId: 'org_1',
  permissionSlug: 'project:view',
  resourceExternalId: 'proj_1',
  resourceTypeSlug: 'project',
} as const

describe('checkResourcePermission', () => {
  let store: TestStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new TestStore()
    setCacheStore(store)
    // The default TTL (30s) stays ON: these tests assert what survives it.
    delete process.env.GRID_AUTHZ_CACHE_TTL_MS
    check.mockResolvedValue({ authorized: true })
  })

  it('does not cache an error-induced denial: error then success within TTL succeeds', async () => {
    // A transport failure fails closed WITHOUT writing the entry, so the
    // next request re-checks live instead of replaying the denial for 30s.
    check.mockRejectedValueOnce(new Error('workos unreachable'))
    await expect(checkResourcePermission({ ...INPUT })).resolves.toBe(false)
    await expect(checkResourcePermission({ ...INPUT })).resolves.toBe(true)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('caches a completed denial (only errors bypass the cache)', async () => {
    check.mockResolvedValue({ authorized: false })
    await expect(checkResourcePermission({ ...INPUT })).resolves.toBe(false)
    await expect(checkResourcePermission({ ...INPUT })).resolves.toBe(false)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('never shares a cached verdict across organizations', async () => {
    // Same membership, resource and permission — only the org differs. The
    // first org's grant must not leak into the second org's check.
    await expect(checkResourcePermission({ ...INPUT })).resolves.toBe(true)
    check.mockResolvedValue({ authorized: false })
    await expect(
      checkResourcePermission({ ...INPUT, organizationId: 'org_2' })
    ).resolves.toBe(false)
    expect(check).toHaveBeenCalledTimes(2)
    expect([...store.map.keys()].sort()).toEqual([
      'authz:check:org_1:om_1:project:proj_1:project:view',
      'authz:check:org_2:om_1:project:proj_1:project:view',
    ])
  })

  it('keys a missing org under the literal no-org segment, never alongside an org', async () => {
    await expect(
      checkResourcePermission({
        organizationMembershipId: 'om_1',
        permissionSlug: 'project:view',
        resourceExternalId: 'proj_1',
        resourceTypeSlug: 'project',
      })
    ).resolves.toBe(true)
    expect([...store.map.keys()]).toEqual([
      'authz:check:no-org:om_1:project:proj_1:project:view',
    ])
  })
})
