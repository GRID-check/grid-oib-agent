/**
 * @vitest-environment node
 */
/**
 * An office's own roles, kept in WorkOS (ADR-0080).
 *
 * Only the WorkOS client, the cache and the audit sink are stubbed; the
 * service's rules run for real. The ones that matter most:
 *
 *  - composing a role is granting, so nobody puts a permission they lack into
 *    one (the no-escalation guard), and removing one is allowed;
 *  - the platform's environment roles are listed and never changed here;
 *  - every change forgets both caches that hold roles, or a folder dialog and
 *    a permission check keep reading the old set for a minute.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'

interface StubRole {
  slug: string
  name: string
  description: string | null
  permissions: string[]
  type: string
}

const roles: StubRole[] = []
const workos = {
  listOrganizationRoles: vi.fn(async (_organizationId: string) => ({ data: roles.map((role) => ({ ...role })) })),
  createOrganizationRole: vi.fn(async (_organizationId: string, _input: unknown) => ({})),
  setOrganizationRolePermissions: vi.fn(async (_organizationId: string, _slug: string, _input: unknown) => ({})),
  updateOrganizationRole: vi.fn(async (_organizationId: string, _slug: string, _input: unknown) => ({})),
  deleteOrganizationRole: vi.fn(async (_organizationId: string, _slug: string): Promise<void> => undefined),
}
vi.mock('@/lib/workos/client', () => ({ getWorkOS: () => ({ authorization: workos }) }))

const invalidateCached = vi.fn(async (_key: string) => undefined)
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: (key: string) => invalidateCached(key),
}))

const recordAuditEvent = vi.fn(async (_event: unknown) => undefined)
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (event: unknown) => recordAuditEvent(event) }))

// Which folders name a role is read from the database; the rule that acts on it
// is what is under test here.
const usage = vi.hoisted(() => ({
  total: 0,
  folders: [] as Array<{ folderId: string; folderName: string; projectId: string; projectName: string }>,
}))
vi.mock('./folder-access-repository', () => ({
  listFoldersNamingRole: vi.fn(async () => ({ folders: usage.folders, total: usage.total })),
}))

import {
  ASSIGNABLE_ROLE_PERMISSIONS,
  assignableRolePermissions,
  createCustomRole,
  customRoleSlug,
  deleteCustomRole,
  getCustomRoleUsage,
  listOrganizationRoles,
  organizationRoleSlugs,
  updateCustomRole,
} from './custom-roles'

/** A User Admin: may manage people and roles, and holds two other org permissions. Not a catalog role. */
const userAdmin = (permissions: string[] = []): AuthorizedSession => ({
  userId: 'user_ua',
  email: 'ua@buero.at',
  name: 'User Admin',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'org-user-admin',
  roles: ['org-user-admin'],
  permissions: ['org:members:manage', 'org:archiv:manage', 'org:projects:create', ...permissions],
  featureFlags: null,
})

const member = (): AuthorizedSession => ({ ...userAdmin(), role: 'org-plain', roles: ['org-plain'], permissions: [] })

const request = (): Request => new Request('http://localhost/api/organization/roles', { method: 'POST' })

const ENVIRONMENT_ADMIN: StubRole = {
  slug: 'admin',
  name: 'Admin',
  description: 'Everything',
  permissions: ['org:settings:manage'],
  type: 'EnvironmentRole',
}
const GESCHAEFTSFUEHRUNG: StubRole = {
  slug: 'org-geschaeftsfuehrung',
  name: 'Geschäftsführung',
  description: null,
  permissions: ['org:archiv:manage', 'org:models:manage'],
  type: 'OrganizationRole',
}

const ROLE_CACHE_KEYS = ['authz:org-role-permissions:org_1', 'authz:org-roles:org_1']

beforeEach(() => {
  vi.clearAllMocks()
  usage.total = 0
  usage.folders = []
  roles.splice(0, roles.length, { ...ENVIRONMENT_ADMIN }, { ...GESCHAEFTSFUEHRUNG, permissions: [...GESCHAEFTSFUEHRUNG.permissions] })
})

describe('customRoleSlug', () => {
  it('folds umlauts and ß the German way, under the org- prefix WorkOS requires', () => {
    expect(customRoleSlug('Geschäftsführung')).toBe('org-geschaeftsfuehrung')
    expect(customRoleSlug('Büroleitung Öffentlichkeit')).toBe('org-bueroleitung-oeffentlichkeit')
    expect(customRoleSlug('Straßenbau')).toBe('org-strassenbau')
  })

  it('reads capitals the same way, and drops other accents and punctuation', () => {
    expect(customRoleSlug('  ÄRZTE & Café-Planung!  ')).toBe('org-aerzte-cafe-planung')
  })

  it('caps the body at 48 characters without leaving a trailing hyphen', () => {
    const slug = customRoleSlug(`${'a'.repeat(47)} b`)
    expect(slug).toBe(`org-${'a'.repeat(47)}`)
  })

  it('refuses a name with nothing a slug could be made of', () => {
    expect(() => customRoleSlug('—  !!')).toThrow(/at least one letter or digit/)
  })
})

describe('listOrganizationRoles', () => {
  it('marks custom roles and shows permissions only to a role manager', async () => {
    const managed = await listOrganizationRoles(userAdmin())
    expect(managed).toEqual([
      { slug: 'admin', name: 'Admin', description: 'Everything', custom: false, permissions: ['org:settings:manage'] },
      {
        slug: 'org-geschaeftsfuehrung',
        name: 'Geschäftsführung',
        description: null,
        custom: true,
        permissions: ['org:archiv:manage', 'org:models:manage'],
      },
    ])
    const read = await listOrganizationRoles(member())
    expect(read.map((role) => role.permissions)).toEqual([undefined, undefined])
    expect(read.map((role) => role.name)).toEqual(['Admin', 'Geschäftsführung'])
  })
})

describe('assignableRolePermissions', () => {
  it('offers the organization tier, grantable only where the editor holds the permission', () => {
    const offered = assignableRolePermissions(userAdmin())
    expect(offered?.map((entry) => entry.slug)).toEqual([...ASSIGNABLE_ROLE_PERMISSIONS])
    const grantable = offered?.filter((entry) => entry.grantable).map((entry) => entry.slug)
    expect(grantable?.sort()).toEqual(['org:archiv:manage', 'org:members:manage', 'org:projects:create'])
  })

  it('is null for a reader who may not manage roles', () => {
    expect(assignableRolePermissions(member())).toBeNull()
  })
})

describe('createCustomRole', () => {
  it('creates the role under the derived slug, sets its permissions, forgets the caches and audits', async () => {
    const created = await createCustomRole(
      userAdmin(),
      { name: ' Projektleitung ', description: 'Leitet Projekte', permissions: ['org:archiv:manage'] },
      request()
    )

    expect(created).toEqual({
      slug: 'org-projektleitung',
      name: 'Projektleitung',
      description: 'Leitet Projekte',
      custom: true,
      permissions: ['org:archiv:manage'],
    })
    expect(workos.createOrganizationRole).toHaveBeenCalledWith('org_1', {
      slug: 'org-projektleitung',
      name: 'Projektleitung',
      description: 'Leitet Projekte',
    })
    expect(workos.setOrganizationRolePermissions).toHaveBeenCalledWith('org_1', 'org-projektleitung', {
      permissions: ['org:archiv:manage'],
    })
    expect(invalidateCached.mock.calls.map(([key]) => key).sort()).toEqual(ROLE_CACHE_KEYS)
    expect(recordAuditEvent).toHaveBeenCalledTimes(1)
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({
      organizationId: 'org_1',
      actor: { userId: 'user_ua', email: 'ua@buero.at' },
      action: 'org.role.created',
      metadata: { role: 'org-projektleitung', permissions: 'org:archiv:manage' },
    })
  })

  it('refuses a permission the editor does not hold, before anything reaches WorkOS', async () => {
    await expect(
      createCustomRole(
        userAdmin(),
        { name: 'Modellpflege', description: null, permissions: ['org:archiv:manage', 'org:models:manage'] },
        request()
      )
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('org:models:manage') })

    expect(workos.createOrganizationRole).not.toHaveBeenCalled()
    expect(workos.setOrganizationRolePermissions).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('refuses a permission that is not of the organization tier, even for an editor holding it', async () => {
    await expect(
      createCustomRole(
        userAdmin(['project:view']),
        { name: 'Leser', description: null, permissions: ['project:view'] },
        request()
      )
    ).rejects.toMatchObject({ status: 400 })
  })

  it('refuses a name whose slug already exists', async () => {
    await expect(
      createCustomRole(userAdmin(), { name: 'Geschaeftsfuehrung', description: null, permissions: [] }, request())
    ).rejects.toMatchObject({ status: 409 })
    expect(workos.createOrganizationRole).not.toHaveBeenCalled()
  })

  it('refuses a reader without org:members:manage', async () => {
    await expect(
      createCustomRole(member(), { name: 'X', description: null, permissions: [] }, request())
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe('updateCustomRole', () => {
  it('lets an editor take away a permission they do not hold', async () => {
    const updated = await updateCustomRole(
      userAdmin(),
      'org-geschaeftsfuehrung',
      { permissions: ['org:archiv:manage'] },
      request()
    )
    expect(updated.permissions).toEqual(['org:archiv:manage'])
    expect(workos.setOrganizationRolePermissions).toHaveBeenCalledWith('org_1', 'org-geschaeftsfuehrung', {
      permissions: ['org:archiv:manage'],
    })
    expect(invalidateCached.mock.calls.map(([key]) => key).sort()).toEqual(ROLE_CACHE_KEYS)
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({ action: 'org.role.updated' })
  })

  it('keeps a permission the role already carries without counting it as granted', async () => {
    await updateCustomRole(
      userAdmin(),
      'org-geschaeftsfuehrung',
      { permissions: ['org:archiv:manage', 'org:models:manage', 'org:projects:create'] },
      request()
    )
    expect(workos.setOrganizationRolePermissions).toHaveBeenCalled()
  })

  it('refuses to add a permission the editor does not hold', async () => {
    await expect(
      updateCustomRole(
        userAdmin(),
        'org-geschaeftsfuehrung',
        { permissions: ['org:archiv:manage', 'org:models:manage', 'org:budgets:manage'] },
        request()
      )
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('org:budgets:manage') })
    expect(workos.setOrganizationRolePermissions).not.toHaveBeenCalled()
  })

  it('renames without touching permissions, and keeps the slug', async () => {
    const updated = await updateCustomRole(userAdmin(), 'org-geschaeftsfuehrung', { name: 'GF' }, request())
    expect(updated).toMatchObject({ slug: 'org-geschaeftsfuehrung', name: 'GF' })
    expect(workos.updateOrganizationRole).toHaveBeenCalledWith('org_1', 'org-geschaeftsfuehrung', { name: 'GF' })
    expect(workos.setOrganizationRolePermissions).not.toHaveBeenCalled()
  })

  it('keeps the slug a folder grant names: a rename leaves the role list under the same slug', async () => {
    await updateCustomRole(userAdmin(), 'org-geschaeftsfuehrung', { name: 'GF', description: 'Leitung' }, request())

    // WorkOS takes a name and a description and nothing that could move the slug.
    expect(workos.updateOrganizationRole).toHaveBeenCalledWith('org_1', 'org-geschaeftsfuehrung', {
      name: 'GF',
      description: 'Leitung',
    })
    expect([...(await organizationRoleSlugs('org_1'))].sort()).toEqual(['admin', 'org-geschaeftsfuehrung'])
  })

  it('does not edit an environment role', async () => {
    await expect(updateCustomRole(userAdmin(), 'admin', { name: 'Chef' }, request())).rejects.toMatchObject({
      status: 403,
    })
    expect(workos.updateOrganizationRole).not.toHaveBeenCalled()
    expect(invalidateCached).not.toHaveBeenCalled()
  })

  it('answers 404 for a slug the organization does not have', async () => {
    await expect(updateCustomRole(userAdmin(), 'org-nobody', { name: 'X' }, request())).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('deleteCustomRole', () => {
  it('deletes the role, forgets the caches and audits', async () => {
    await deleteCustomRole(userAdmin(), 'org-geschaeftsfuehrung', request())
    expect(workos.deleteOrganizationRole).toHaveBeenCalledWith('org_1', 'org-geschaeftsfuehrung')
    expect(invalidateCached.mock.calls.map(([key]) => key).sort()).toEqual(ROLE_CACHE_KEYS)
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({
      action: 'org.role.deleted',
      metadata: { role: 'org-geschaeftsfuehrung' },
    })
  })

  describe('a role that folders name (ADR-0081)', () => {
    const folder = {
      folderId: 'f1',
      folderName: 'Honorare',
      projectId: 'p1',
      projectName: 'Schule Süd',
    }

    it('is refused with 409 and the count until the caller confirms, and WorkOS is not asked', async () => {
      usage.total = 2
      usage.folders = [folder]

      await expect(deleteCustomRole(userAdmin(), 'org-geschaeftsfuehrung', request())).rejects.toMatchObject({
        status: 409,
        details: { reason: 'role-used-by-folders', total: 2 },
      })

      expect(workos.deleteOrganizationRole).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    it('is deleted once confirmed, and the audit entry counts the folders it left without that grant', async () => {
      usage.total = 2

      await deleteCustomRole(userAdmin(), 'org-geschaeftsfuehrung', request(), { confirmFolders: true })

      expect(workos.deleteOrganizationRole).toHaveBeenCalledWith('org_1', 'org-geschaeftsfuehrung')
      expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({ metadata: { role: 'org-geschaeftsfuehrung', folders: 2 } })
    })

    it('needs no confirmation when no folder names it', async () => {
      await expect(deleteCustomRole(userAdmin(), 'org-geschaeftsfuehrung', request())).resolves.toBeUndefined()
    })

    it('names the folders to someone who administers projects, and only counts them for a role manager who does not', async () => {
      usage.total = 1
      usage.folders = [folder]

      await expect(getCustomRoleUsage(userAdmin(['org:projects:administer']), 'org-geschaeftsfuehrung')).resolves.toEqual({
        total: 1,
        folders: [folder],
      })
      await expect(getCustomRoleUsage(userAdmin(), 'org-geschaeftsfuehrung')).resolves.toEqual({ total: 1, folders: [] })
    })

    it('is for role managers, and only for the organization’s own roles', async () => {
      await expect(getCustomRoleUsage(member(), 'org-geschaeftsfuehrung')).rejects.toMatchObject({ status: 403 })
      await expect(getCustomRoleUsage(userAdmin(), 'admin')).rejects.toMatchObject({ status: 403 })
    })
  })

  it('does not delete an environment role', async () => {
    await expect(deleteCustomRole(userAdmin(), 'admin', request())).rejects.toMatchObject({ status: 403 })
    expect(workos.deleteOrganizationRole).not.toHaveBeenCalled()
  })

  it('answers 409 while WorkOS says the role is still assigned, and changes nothing else', async () => {
    workos.deleteOrganizationRole.mockRejectedValueOnce(Object.assign(new Error('in use'), { status: 422 }))
    await expect(deleteCustomRole(userAdmin(), 'org-geschaeftsfuehrung', request())).rejects.toMatchObject({
      status: 409,
    })
    expect(invalidateCached).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})
