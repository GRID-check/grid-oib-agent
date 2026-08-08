/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const check = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { check } }),
}))

const findProjectTenancy = vi.fn()
vi.mock('@/lib/projects/repository', () => ({
  findProjectTenancy: (...args: unknown[]) => findProjectTenancy(...args),
}))

import { requireProjectAccess } from './projects'
import { setCacheStore, type CacheStore } from '@/lib/cache'
import type { AuthorizedSession } from '@/lib/auth/types'

/**
 * Controllable in-process store. Ignores TTL expiry (tests assert hits within
 * the window) and can be forced to fail every read to exercise fail-open.
 */
class TestStore implements CacheStore {
  map = new Map<string, string>()
  failGet = false
  getKeys: string[] = []

  async get(key: string): Promise<string | null> {
    this.getKeys.push(key)
    if (this.failGet) throw new Error('cache down')
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

const session = (overrides: Partial<AuthorizedSession> = {}): AuthorizedSession => ({
  userId: 'user_1',
  email: 'someone@grid.com',
  name: 'Someone',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
  ...overrides,
})

const PROJECT_ID = 'proj_1'

describe('requireProjectAccess', () => {
  let store: TestStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new TestStore()
    setCacheStore(store)
    delete process.env.GRID_AUTHZ_CACHE_TTL_MS
    // Grant edit but not manage → derived role project-editor.
    check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
      Promise.resolve({ authorized: permissionSlug !== 'project:manage' })
    )
    findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: null })
  })

  const authzKeys = () => store.getKeys.filter((k) => k.startsWith('authz:check:'))

  it('org admins bypass FGA entirely (differential: no WorkOS check calls)', async () => {
    const result = await requireProjectAccess(
      session({ role: 'admin' }),
      PROJECT_ID,
      'project:edit'
    )
    expect(result).toEqual({ role: 'project-admin' })
    expect(check).not.toHaveBeenCalled()
  })

  it('project:edit makes two FGA round-trips (edit + manage) when uncached', async () => {
    await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
    expect(check).toHaveBeenCalledTimes(2)
  })

  describe('cache disabled (default)', () => {
    it('never consults the cache and re-checks every request', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(check).toHaveBeenCalledTimes(4)
      expect(authzKeys()).toHaveLength(0)
    })

    it('treats GRID_AUTHZ_CACHE_TTL_MS=0 as disabled', async () => {
      process.env.GRID_AUTHZ_CACHE_TTL_MS = '0'
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(authzKeys()).toHaveLength(0)
    })
  })

  describe('cache enabled', () => {
    beforeEach(() => {
      process.env.GRID_AUTHZ_CACHE_TTL_MS = '30000'
    })

    it('miss then populate: the first request checks WorkOS and stores each result', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(check).toHaveBeenCalledTimes(2)
      // The key carries the resource TYPE as well as the id, so a project and a
      // workflow that happen to share an external id cannot collide.
      expect([...store.map.keys()].sort()).toEqual([
        'authz:check:om_1:project:proj_1:project:edit',
        'authz:check:om_1:project:proj_1:project:manage',
      ])
    })

    it('hit: an identical second request serves both checks from cache', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      // 2 real checks on the first request, 0 on the second.
      expect(check).toHaveBeenCalledTimes(2)
    })

    it("is keyed per membership: a different user does not read another user's grant", async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      await requireProjectAccess(
        session({ organizationMembershipId: 'om_2' }),
        PROJECT_ID,
        'project:edit'
      )
      expect(check).toHaveBeenCalledTimes(4)
    })

    it('fail-open: a cache-read outage degrades to live checks and still authorizes', async () => {
      store.failGet = true
      const result = await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(result).toEqual({ role: 'project-editor' })
      expect(check).toHaveBeenCalledTimes(2)
    })

    it('a denied check still throws NotFound (cached denials do not leak access)', async () => {
      check.mockResolvedValue({ authorized: false })
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:edit')).rejects.toThrow()
    })
  })

  it('fails CLOSED when the FGA call itself errors', async () => {
    // A check that cannot complete is a denial, never a default-allow. Before
    // the shared resource-check primitive this rejection propagated as a 500,
    // which left the outcome to whatever the caller did with the exception.
    check.mockRejectedValue(new Error('workos unreachable'))
    await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).rejects.toThrow(
      'Not found'
    )
  })

  describe('any-of permissions (the ADR-0038 project:edit split)', () => {
    const DOC_WRITE = ['project:documents:write', 'project:edit'] as const

    it('accepts the narrow permission on its own', async () => {
      check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
        Promise.resolve({ authorized: permissionSlug === 'project:documents:write' })
      )
      // The derived role reflects the INTENT that was satisfied, so a holder of
      // only the narrow write permission reads as an editor — the same answer
      // the pre-split code gave a `project:edit` holder.
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).resolves.toEqual({
        role: 'project-editor',
      })
    })

    it('still accepts a legacy role holding only the project:edit umbrella', async () => {
      // A custom role provisioned before the split must not lose document
      // writes the day the narrow permission is introduced.
      check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
        Promise.resolve({ authorized: permissionSlug === 'project:edit' })
      )
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).resolves.toEqual({
        role: 'project-editor',
      })
    })

    it('denies when the caller holds neither', async () => {
      check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
        Promise.resolve({ authorized: permissionSlug === 'project:view' })
      )
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).rejects.toThrow(
        'Not found'
      )
    })

    it('does not let a memory grant unlock document writes', async () => {
      check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
        Promise.resolve({ authorized: permissionSlug === 'project:memory:write' })
      )
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).rejects.toThrow(
        'Not found'
      )
    })
  })

  it('authorizes the new fine-grained project permissions', async () => {
    check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
      Promise.resolve({ authorized: permissionSlug === 'project:memory:write' })
    )
    await expect(
      requireProjectAccess(session(), PROJECT_ID, 'project:memory:write')
    ).resolves.toEqual({ role: 'project-viewer' })
    // The same session must NOT get document writes from a memory grant.
    await expect(
      requireProjectAccess(session(), PROJECT_ID, 'project:documents:write')
    ).rejects.toThrow('Not found')
  })
})
