/**
 * @vitest-environment node
 * THROW-AWAY adversarial probe. Delete before finishing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const check = vi.fn()
const listEnvironmentRoles = vi.fn()
const listOrganizationRoles = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    authorization: { check, listEnvironmentRoles, listOrganizationRoles },
  }),
}))

const findProjectTenancy = vi.fn()
vi.mock('@/lib/projects/repository', () => ({
  findProjectTenancy: (...a: unknown[]) => findProjectTenancy(...a),
}))

const probe = vi.fn()
vi.mock('@/lib/sharing/registry', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, describeResource: () => ({ probe }) }
})

const findGrantForSubject = vi.fn()
vi.mock('@/lib/sharing/repository', () => ({
  findGrantForSubject: (...a: unknown[]) => findGrantForSubject(...a),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { resolveResourceAccess, requireResourceAccess } from '@/lib/sharing/access'
import { orgRoleHoldsPermission } from '@/lib/authz/org-role-permissions'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { setCacheStore, type CacheStore } from '@/lib/cache'
import type { AuthorizedSession } from '@/lib/auth/types'

class Store implements CacheStore {
  map = new Map<string, string>()
  async get(k: string) { return this.map.get(k) ?? null }
  async set(k: string, v: string) { this.map.set(k, v) }
  async delete(k: string) { this.map.delete(k) }
  async deletePrefix(p: string) { for (const k of [...this.map.keys()]) if (k.startsWith(p)) this.map.delete(k) }
}

const s = (o: Partial<AuthorizedSession> = {}): AuthorizedSession => ({
  userId: 'user_1', email: 'a@b.c', name: 'A', accessToken: 't',
  organizationId: 'org_1', organizationMembershipId: 'om_1',
  role: 'member', permissions: [], featureFlags: null, ...o,
} as AuthorizedSession)

const P = 'proj_1'

beforeEach(() => {
  vi.clearAllMocks()
  setCacheStore(new Store())
  delete process.env.GRID_AUTHZ_CACHE_TTL_MS
  findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: null })
  findGrantForSubject.mockResolvedValue(null)
})

describe('C4 — F3 second reproduction still passes verbatim', () => {
  it('a role NAMED admin holding ZERO permissions still administers every project, with no FGA call', async () => {
    check.mockResolvedValue({ authorized: false })
    await expect(
      requireProjectAccess(s({ role: 'admin', permissions: [] }), P, 'project:manage')
    ).resolves.toEqual({ role: 'project-admin' })
    expect(check).not.toHaveBeenCalled()
  })
  it('hasPermission alone shows why', () => {
    expect(hasPermission(s({ role: 'admin', permissions: [] }), ORG_PERMISSIONS.projectsAdminister)).toBe(true)
  })
})

describe('C5 — F7 stated consequence is not delivered at its own call site', () => {
  it('a narrow-write role is STILL a viewer on shared threads (sharing/access passes project:view)', async () => {
    // Holds project:documents:write + project:memory:write, NOT project:edit.
    check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
      Promise.resolve({
        authorized: ['project:view', 'project:documents:write', 'project:memory:write'].includes(permissionSlug),
      })
    )
    // Exactly what lib/sharing/access.ts:111 does.
    await expect(requireProjectAccess(s(), P, 'project:view')).resolves.toEqual({
      role: 'project-viewer',
    })
  })
  it('the same caller IS an editor when the list happens to name the narrow permission', async () => {
    check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
      Promise.resolve({
        authorized: ['project:view', 'project:documents:write', 'project:memory:write'].includes(permissionSlug),
      })
    )
    await expect(
      requireProjectAccess(s(), P, ['project:documents:write', 'project:edit'])
    ).resolves.toEqual({ role: 'project-editor' })
  })
})

describe('C4 — orgRoleHoldsPermission is NOT symmetric with hasPermission', () => {
  it('denies a real org admin when WorkOS knows the slug but the permission is unprovisioned', async () => {
    listEnvironmentRoles.mockResolvedValue({
      data: [{ slug: 'admin', permissions: ['org:settings:manage', 'org:members:manage'] }],
    })
    // hasPermission says yes for the very same role, via the catalog implication.
    expect(hasPermission(s({ role: 'admin' }), ORG_PERMISSIONS.projectsAdminister)).toBe(true)
    // The third-party path says NO.
    expect(await orgRoleHoldsPermission('admin', ORG_PERMISSIONS.projectsAdminister)).toBe(false)
  })
  it('but SAYS YES for the same input when WorkOS omits the slug entirely (catalog fallback)', async () => {
    listEnvironmentRoles.mockResolvedValue({ data: [{ slug: 'member', permissions: [] }] })
    expect(await orgRoleHoldsPermission('admin', ORG_PERMISSIONS.projectsAdminister)).toBe(true)
  })
  it('and YES when WorkOS throws', async () => {
    listEnvironmentRoles.mockRejectedValue(new Error('workos down'))
    expect(await orgRoleHoldsPermission('admin', ORG_PERMISSIONS.projectsAdminister)).toBe(true)
  })
})

describe('C8 — a transient failure locks the composer', () => {
  it('requireProjectAccess is indistinguishable from a denial when WorkOS is down', async () => {
    check.mockRejectedValue(new Error('workos unreachable'))
    // The chat page does exactly this try/catch.
    let canChatInProject = true
    try {
      await requireProjectAccess(s({ role: 'member' }), P, ['project:chat', 'project:edit'])
    } catch {
      canChatInProject = false
    }
    expect(canChatInProject).toBe(false)
  })
  it('a database hiccup in the tenancy probe does the same', async () => {
    findProjectTenancy.mockRejectedValue(new Error('db down'))
    let canChatInProject = true
    try {
      await requireProjectAccess(s({ role: 'member' }), P, ['project:chat', 'project:edit'])
    } catch {
      canChatInProject = false
    }
    expect(canChatInProject).toBe(false)
  })
})

describe('C2 — a project VIEWER can continue a project thread they own', () => {
  it('resolves to owner, which satisfies the collaborator gate on message writes', async () => {
    check.mockImplementation(({ permissionSlug }: { permissionSlug: string }) =>
      Promise.resolve({ authorized: permissionSlug === 'project:view' })
    )
    probe.mockResolvedValue({
      organizationId: 'org_1',
      projectId: P,
      container: { kind: 'project', id: P },
      visibility: 'private',
      createdBy: 'user_1',
      deletedAt: null,
    })
    const access = await resolveResourceAccess(s(), 'conversation', 'conv_1')
    expect(access.role).toBe('owner')
    // This is the gate createConversationMessages applies.
    await expect(
      requireResourceAccess(s(), 'conversation', 'conv_1', 'collaborator')
    ).resolves.toBeTruthy()
  })
})
