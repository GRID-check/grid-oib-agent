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

  describe('the org-wide project bypass is a PERMISSION, not a role name', () => {
    it('an admin session with no permission claims bypasses FGA entirely (no WorkOS calls)', async () => {
      // `hasPermission`'s bounded catalog implication: the session carries the
      // role slug and no claims, and the catalog says Admin holds
      // `org:projects:administer`, so a session whose claims lack that permission
      // still reaches projects.
      const result = await requireProjectAccess(
        session({ role: 'admin' }),
        PROJECT_ID,
        'project:edit'
      )
      expect(result).toEqual({ role: 'project-admin', closed: false, readsBecauseClosed: false })
      expect(check).not.toHaveBeenCalled()
    })

    it('a session holding the permission bypasses, whatever its role is called', async () => {
      const result = await requireProjectAccess(
        session({ role: 'custom-owner', permissions: ['org:projects:administer'] }),
        PROJECT_ID,
        'project:manage'
      )
      expect(result).toEqual({ role: 'project-admin', closed: false, readsBecauseClosed: false })
      expect(check).not.toHaveBeenCalled()
    })

    it('a role that is not admin and holds nothing gets no bypass', async () => {
      check.mockResolvedValue({ authorized: false })
      await expect(
        requireProjectAccess(
          session({ role: 'org-auditor', permissions: ['org:audit:view'] }),
          PROJECT_ID,
          'project:manage'
        )
      ).rejects.toThrow('Not found')
    })

    it('a custom role with every OTHER org permission gets no bypass', async () => {
      // A persona that needs to reach projects gets in by holding the permission,
      // which is the point of the extensibility contract. It does NOT come for
      // free.
      check.mockResolvedValue({ authorized: false })
      await expect(
        requireProjectAccess(
          session({
            role: 'org-owner-custom',
            permissions: [
              'org:settings:manage',
              'org:models:manage',
              'org:budgets:manage',
              'org:compliance:manage',
              'org:audit:view',
              'org:archiv:manage',
              'org:skills:manage',
              'org:projects:create',
              'org:members:manage',
            ],
          }),
          PROJECT_ID,
          'project:view'
        )
      ).rejects.toThrow('Not found')
    })
  })

  describe('the derived role reads what the caller HOLDS', () => {
    it('an admin asked via an any-of list is not demoted to editor', async () => {
      // `['project:members:manage', 'project:manage']` is how the members service
      // asks. A skipped `project:manage` check must not fall back to comparing
      // against `accepted[0]`, a different slug, or a real project admin comes
      // back as an editor.
      check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
        Promise.resolve({ authorized: permissionSlug === 'project:manage' })
      )
      await expect(
        requireProjectAccess(session(), PROJECT_ID, ['project:members:manage', 'project:manage'])
      ).resolves.toEqual({ role: 'project-admin', closed: false, readsBecauseClosed: false })
    })
  })

  it('project:edit makes two FGA round-trips (edit + manage) when uncached', async () => {
    await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
    expect(check).toHaveBeenCalledTimes(2)
  })

  describe('cache disabled (GRID_AUTHZ_CACHE_TTL_MS=0)', () => {
    beforeEach(() => {
      process.env.GRID_AUTHZ_CACHE_TTL_MS = '0'
    })

    it('never consults the cache and re-checks every request', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(check).toHaveBeenCalledTimes(4)
      expect(authzKeys()).toHaveLength(0)
    })
  })

  describe('cache enabled (the default)', () => {
    it('is on when the variable is unset', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(authzKeys().length).toBeGreaterThan(0)
    })

    it('miss then populate: the first request checks WorkOS and stores each result', async () => {
      await requireProjectAccess(session(), PROJECT_ID, 'project:edit')
      expect(check).toHaveBeenCalledTimes(2)
      // The key carries the ORG and the resource TYPE as well as the id, so a
      // project and a workflow that happen to share an external id cannot
      // collide — and neither can two tenants checking the same project id.
      expect([...store.map.keys()].sort()).toEqual([
        'authz:check:org_1:om_1:project:proj_1:project:edit',
        'authz:check:org_1:om_1:project:proj_1:project:manage',
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
      expect(result).toEqual({ role: 'project-editor', closed: false, readsBecauseClosed: false })
      expect(check).toHaveBeenCalledTimes(2)
    })

    it('a denied check still throws NotFound (cached denials do not leak access)', async () => {
      check.mockResolvedValue({ authorized: false })
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:edit')).rejects.toThrow()
    })
  })

  it('fails CLOSED when the FGA call itself errors', async () => {
    // A check that cannot complete is a denial, never a default-allow. The
    // rejection is caught here rather than left to the caller, who would
    // otherwise decide the outcome from the exception.
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
      // only the narrow write permission reads as an editor, the same answer a
      // `project:edit` holder gets.
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).resolves.toEqual({
        role: 'project-editor',
        closed: false,
        readsBecauseClosed: false,
      })
    })

    it('still accepts a role holding only the project:edit umbrella', async () => {
      // A custom role holding only the umbrella keeps its document writes: the
      // umbrella still satisfies them.
      check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
        Promise.resolve({ authorized: permissionSlug === 'project:edit' })
      )
      await expect(requireProjectAccess(session(), PROJECT_ID, DOC_WRITE)).resolves.toEqual({
        role: 'project-editor',
        closed: false,
        readsBecauseClosed: false,
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
    // Editor, not viewer. The rung is "holds a write permission"; which one is
    // not the ladder's business. Keyed on the umbrella `project:edit` alone, a
    // narrow-write role would fall to the reader rung and become a mere viewer on
    // every shared thread in a project whose memory it can rewrite.
    await expect(
      requireProjectAccess(session(), PROJECT_ID, 'project:memory:write')
    ).resolves.toEqual({ role: 'project-editor', closed: false, readsBecauseClosed: false })
    // The same session must NOT get document writes from a memory grant.
    await expect(
      requireProjectAccess(session(), PROJECT_ID, 'project:documents:write')
    ).rejects.toThrow('Not found')
  })

  describe('a closed project (ADR-0082)', () => {
    beforeEach(() => {
      findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: null, status: 'closed' })
    })

    const refusal = { status: 403, details: { reason: 'project-closed' } }

    it('refuses every write to an editor, with the reason the UI names', async () => {
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:documents:write')).rejects.toMatchObject(refusal)
      await expect(
        requireProjectAccess(session(), PROJECT_ID, ['project:memory:write', 'project:edit'])
      ).rejects.toMatchObject(refusal)
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:documents:generate')).rejects.toMatchObject(refusal)
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:skills:manage')).rejects.toMatchObject(refusal)
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:manage')).rejects.toMatchObject(refusal)
      // Decided before WorkOS is asked anything.
      expect(check).not.toHaveBeenCalled()
    })

    it('refuses a write to an organization admin too: the closed check runs before the bypass', async () => {
      const admin = session({ role: 'admin', permissions: ['org:projects:administer'] })
      await expect(requireProjectAccess(admin, PROJECT_ID, 'project:documents:write')).rejects.toMatchObject(refusal)
      await expect(requireProjectAccess(admin, PROJECT_ID, 'project:view')).resolves.toMatchObject({ closed: true })
    })

    it('lets a member read and chat, and keeps their role', async () => {
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).resolves.toEqual({
        role: 'project-editor',
        closed: true,
        readsBecauseClosed: false,
      })
      await expect(requireProjectAccess(session(), PROJECT_ID, ['project:chat', 'project:edit'])).resolves.toMatchObject({
        closed: true,
        readsBecauseClosed: false,
      })
    })

    it('lets every organization member read and chat, as a viewer who reads only because it is closed', async () => {
      check.mockResolvedValue({ authorized: false })
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).resolves.toEqual({
        role: 'project-viewer',
        closed: true,
        readsBecauseClosed: true,
      })
      await expect(requireProjectAccess(session(), PROJECT_ID, ['project:chat', 'project:edit'])).resolves.toMatchObject({
        readsBecauseClosed: true,
      })
      // Managing members stays a grant someone must hold.
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:members:manage')).rejects.toMatchObject({
        status: 404,
      })
    })

    it('still hides it from another organization and once it is deleted', async () => {
      findProjectTenancy.mockResolvedValue({ organizationId: 'org_2', deletedAt: null, status: 'closed' })
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).rejects.toMatchObject({ status: 404 })
      findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: new Date(), status: 'closed' })
      await expect(requireProjectAccess(session(), PROJECT_ID, 'project:view')).rejects.toMatchObject({ status: 404 })
    })

    it('asks project:manage as if active only when reopening says so', async () => {
      check.mockResolvedValue({ authorized: true })
      await expect(
        requireProjectAccess(session(), PROJECT_ID, 'project:manage', { evenWhenClosed: true })
      ).resolves.toMatchObject({ role: 'project-admin', closed: true })
      // A fresh cache: the grant above is cached for the TTL.
      setCacheStore(new TestStore())
      check.mockResolvedValue({ authorized: false })
      await expect(
        requireProjectAccess(session(), PROJECT_ID, 'project:manage', { evenWhenClosed: true })
      ).rejects.toMatchObject({ status: 404 })
    })
  })
})
