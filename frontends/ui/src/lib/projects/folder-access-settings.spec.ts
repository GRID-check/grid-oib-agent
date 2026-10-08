/**
 * @vitest-environment node
 *
 * Setting a folder's own read/write list (ADR-0088): validated against the
 * organization's roles, stored as grants with the folder made `custom` in one
 * transaction, audited with the levels, and refused before anything is written
 * when it would put an IFC model in a folder not every member may read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/folder-access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authz/folder-access')>('@/lib/authz/folder-access')
  const open = (await import('@/test-utils/folder-access')).openFolderAccessModule()
  // The guard runs the decision's pure core over the would-be tree, for real.
  return {
    ...open,
    computeFolderAccess: actual.computeFolderAccess,
    EVERY_PROJECT_MEMBER: '*',
    // The tree the project has, and who asks: `listFoldersWithoutValidRole`.
    loadCustomFolderTree: vi.fn(async () => orphans.tree),
    clearanceOf: vi.fn(() => ({ roles: orphans.roles, seesEverything: orphans.admin })),
    customFolderNames: vi.fn(async () => orphans.names),
  }
})
const orphans = vi.hoisted(() => ({
  tree: null as Array<{ id: string; parentId: string | null; accessMode: 'inherit' | 'custom'; grants: Array<{ role: string; level: 'read' | 'write' }>; deleted?: boolean }> | null,
  roles: [] as string[],
  admin: false,
  names: new Map<string, string>(),
}))

vi.mock('@/lib/authz/folder-access-repository', () => ({
  projectHasCustomFolders: vi.fn(async () => false),
  listProjectFolderTree: vi.fn(async () => [
    { id: 'modelle', parentId: null, accessMode: 'inherit', grants: [] },
    { id: 'plaene', parentId: null, accessMode: 'inherit', grants: [] },
  ]),
  countIfcDocumentsInFolders: vi.fn(async () => 0),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => undefined) }))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async () => ({ id: 'proj-1', collectionName: 'proj_1' })),
}))
vi.mock('@/lib/authz/custom-roles', () => ({
  organizationRoleSlugs: vi.fn(async () => new Set(['org-geschaeftsfuehrung', 'org-buchhaltung'])),
}))
vi.mock('./collection-placement', () => ({ placeProjectDocuments: vi.fn(async () => ({ moved: 2, failed: [], pending: 0 })) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn(async () => undefined) }))

const writes = vi.hoisted(() => ({
  deletes: 0,
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>[]>,
}))
vi.mock('@/lib/db', () => {
  const tx = {
    delete: () => ({
      where: async () => {
        writes.deletes += 1
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.updates.push(values)
        return { where: () => ({ returning: async () => [{ id: 'modelle' }] }) }
      },
    }),
    insert: () => ({
      values: async (rows: Record<string, unknown>[]) => {
        writes.inserts.push(rows)
      },
    }),
  }
  return { getDb: () => ({ transaction: async (fn: (handle: typeof tx) => unknown) => fn(tx) }) }
})
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: (_scope: unknown, run: () => unknown) => run(),
}))
vi.mock('@/lib/db/schema', () => ({
  projectFolders: { id: 'folders.id', projectId: 'folders.project_id', deletedAt: 'folders.deleted_at' },
  projectFolderGrants: { folderId: 'grants.folder_id' },
}))

import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { getProjectFolderAccess } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { countIfcDocumentsInFolders } from '@/lib/authz/folder-access-repository'
import { placeProjectDocuments } from './collection-placement'
import { organizationRoleSlugs } from '@/lib/authz/custom-roles'
import { listFoldersWithoutValidRole, setFolderAccess } from './folder-access-settings'

const SESSION = { organizationId: 'org-1', userId: 'user-1', email: 'a@b.c' } as never
const request = () => new Request('http://x')

beforeEach(() => {
  vi.clearAllMocks()
  writes.deletes = 0
  writes.updates = []
  writes.inserts = []
})

describe('setFolderAccess', () => {
  it('stores an own list as grants, makes the folder custom, and audits the levels', async () => {
    const result = await setFolderAccess(
      SESSION,
      {
        projectId: 'proj-1',
        folderId: 'plaene',
        access: {
          mode: 'custom',
          grants: [
            { role: 'org-geschaeftsfuehrung', level: 'write' },
            { role: 'org-buchhaltung', level: 'read' },
          ],
        },
      },
      request()
    )

    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, 'proj-1', 'project:manage')
    expect(writes.deletes).toBe(1)
    expect(writes.updates[0]).toMatchObject({ accessMode: 'custom', accessChangedBy: 'user-1' })
    expect(writes.inserts[0]).toEqual([
      { organizationId: 'org-1', projectId: 'proj-1', folderId: 'plaene', roleSlug: 'org-geschaeftsfuehrung', level: 'write' },
      { organizationId: 'org-1', projectId: 'proj-1', folderId: 'plaene', roleSlug: 'org-buchhaltung', level: 'read' },
    ])
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.folder.access_changed',
        metadata: expect.objectContaining({
          folderId: 'plaene',
          mode: 'custom',
          grants: 'org-buchhaltung:read,org-geschaeftsfuehrung:write',
          documentsMoved: 2,
        }),
      })
    )
    expect(result.access).toEqual({
      mode: 'custom',
      grants: [
        { role: 'org-geschaeftsfuehrung', level: 'write' },
        { role: 'org-buchhaltung', level: 'read' },
      ],
    })
    expect(placeProjectDocuments).toHaveBeenCalledWith('org-1', 'proj-1')
  })

  it('accepts `*`, every project member, beside the organization’s roles', async () => {
    await setFolderAccess(
      SESSION,
      {
        projectId: 'proj-1',
        folderId: 'plaene',
        access: {
          mode: 'custom',
          grants: [
            { role: '*', level: 'read' },
            { role: 'org-geschaeftsfuehrung', level: 'write' },
          ],
        },
      },
      request()
    )
    expect(writes.inserts[0].map((row) => row.roleSlug)).toEqual(['*', 'org-geschaeftsfuehrung'])
  })

  it('makes a folder inherit again: the list goes, nothing is inserted', async () => {
    const result = await setFolderAccess(
      SESSION,
      { projectId: 'proj-1', folderId: 'modelle', access: { mode: 'inherit' } },
      request()
    )
    expect(writes.deletes).toBe(1)
    expect(writes.updates[0]).toMatchObject({ accessMode: 'inherit' })
    expect(writes.inserts).toEqual([])
    expect(result.access).toEqual({ mode: 'inherit' })
  })

  it.each([
    ['an empty list', []],
    ['a role the organization does not have', [{ role: 'org-ghost', level: 'read' as const }]],
    [
      'a role listed twice',
      [
        { role: 'org-buchhaltung', level: 'read' as const },
        { role: 'org-buchhaltung', level: 'write' as const },
      ],
    ],
  ])('refuses %s and writes nothing', async (_label, grants) => {
    await expect(
      setFolderAccess(SESSION, { projectId: 'proj-1', folderId: 'plaene', access: { mode: 'custom', grants } }, request())
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(writes.updates).toEqual([])
  })

  it('answers a folder the manager may not read like a missing one', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValueOnce({
      hiddenFolderIds: new Set(['plaene']),
      isVisible: (id) => id !== 'plaene',
      levelOf: () => 'none',
      collectionFor: () => 'proj_1',
      sourceFolderOf: () => null,
      clearedRestrictedCollections: [],
      anyRestricted: true,
    })
    await expect(
      setFolderAccess(SESSION, { projectId: 'proj-1', folderId: 'plaene', access: { mode: 'inherit' } }, request())
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(writes.updates).toEqual([])
  })

  describe('a manager is held to the level they have on the folder', () => {
    // Plaene has a list of its own, on which the manager's role holds `level`.
    const asManager = async (roles: string[], seesEverything: boolean, level: 'read' | 'write' = 'read') => {
      const { computeFolderAccess } = await vi.importActual<typeof import('@/lib/authz/folder-access')>(
        '@/lib/authz/folder-access'
      )
      const tree = [
        { id: 'plaene', parentId: null, accessMode: 'custom' as const, grants: [{ role: 'org-geschaeftsfuehrung', level }] },
        { id: 'modelle', parentId: null, accessMode: 'inherit' as const, grants: [] },
      ]
      vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(computeFolderAccess(tree, { roles, seesEverything }, 'proj_1'))
    }
    const giveSelfWrite = {
      projectId: 'proj-1',
      folderId: 'plaene',
      access: { mode: 'custom' as const, grants: [{ role: 'org-geschaeftsfuehrung', level: 'write' as const }] },
    }

    it('refuses a project manager who may only read the folder, with a typed 403, and writes nothing', async () => {
      await asManager(['org-geschaeftsfuehrung'], false)

      const error = await setFolderAccess(SESSION, giveSelfWrite, request()).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ status: 403, details: { reason: 'folder-read-only' } })
      expect(writes.deletes).toBe(0)
      expect(writes.updates).toEqual([])
      expect(recordAuditEvent).not.toHaveBeenCalled()
      expect(placeProjectDocuments).not.toHaveBeenCalled()
    })

    it('lets an organization admin change it, whatever its list names', async () => {
      await asManager([], true)

      await setFolderAccess(SESSION, giveSelfWrite, request())

      expect(writes.updates[0]).toMatchObject({ accessMode: 'custom' })
    })

    it('lets a manager who may write the folder change it', async () => {
      await asManager(['org-geschaeftsfuehrung'], false, 'write')

      await setFolderAccess(SESSION, giveSelfWrite, request())

      expect(writes.updates[0]).toMatchObject({ accessMode: 'custom' })
    })
  })

  it('refuses a list that keeps a member from reading a folder holding IFC models, and writes nothing', async () => {
    vi.mocked(countIfcDocumentsInFolders).mockResolvedValueOnce(3)

    const error = await setFolderAccess(
      SESSION,
      {
        projectId: 'proj-1',
        folderId: 'modelle',
        access: { mode: 'custom', grants: [{ role: 'org-geschaeftsfuehrung', level: 'write' }] },
      },
      request()
    ).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      status: 409,
      message: expect.stringMatching(/hold 3 IFC models\. IFC models cannot be filed in a restricted folder yet/),
      details: { code: 'IFC_IN_RESTRICTED_FOLDER', models: 3 },
    })
    expect(countIfcDocumentsInFolders).toHaveBeenCalledWith('org-1', 'proj-1', ['modelle'])
    expect(writes.updates).toEqual([])
    expect(placeProjectDocuments).not.toHaveBeenCalled()
  })

  it('lets a folder with models narrow who WRITES while every member still reads (`*`)', async () => {
    // Three models in whatever folders the guard asks about; it asks about none.
    vi.mocked(countIfcDocumentsInFolders).mockImplementation(async (_org, _project, folderIds) =>
      folderIds.length > 0 ? 3 : 0
    )
    await setFolderAccess(
      SESSION,
      {
        projectId: 'proj-1',
        folderId: 'modelle',
        access: {
          mode: 'custom',
          grants: [
            { role: '*', level: 'read' },
            { role: 'org-geschaeftsfuehrung', level: 'write' },
          ],
        },
      },
      request()
    )
    expect(writes.updates[0]).toMatchObject({ accessMode: 'custom' })
    expect(countIfcDocumentsInFolders).toHaveBeenCalledWith('org-1', 'proj-1', [])
  })
  const custom = (grants: Array<{ role: string; level: 'read' | 'write' }>) => ({
    projectId: 'proj-1',
    folderId: 'plaene',
    access: { mode: 'custom' as const, grants },
  })
  const writesNothing = () => {
    expect(writes.deletes).toBe(0)
    expect(writes.updates).toEqual([])
    expect(writes.inserts).toEqual([])
    expect(recordAuditEvent).not.toHaveBeenCalled()
  }

  it.each([
    ['an own list naming nobody', []],
    ['more than 20 entries', Array.from({ length: 21 }, (_, i) => ({ role: i === 0 ? '*' : `org-r${i}`, level: 'read' as const }))],
    ['a role twice', [{ role: 'org-buchhaltung', level: 'read' as const }, { role: 'org-buchhaltung', level: 'write' as const }]],
    ['a role the organization does not have', [{ role: 'org-gibt-es-nicht', level: 'read' as const }]],
  ])('refuses %s with a 400, and writes nothing', async (_case, grants) => {
    await expect(setFolderAccess(SESSION, custom(grants), request())).rejects.toBeInstanceOf(BadRequestError)
    writesNothing()
  })

  it('needs project:manage before it reads anything', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError('Project not found'))
    await expect(
      setFolderAccess(SESSION, custom([{ role: 'org-buchhaltung', level: 'read' }]), request())
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(getProjectFolderAccess).not.toHaveBeenCalled()
    writesNothing()
  })
})

describe('listFoldersWithoutValidRole (ADR-0087)', () => {
  beforeEach(() => {
    orphans.tree = [
      { id: 'honorare', parentId: null, accessMode: 'custom', grants: [{ role: 'org-gone', level: 'write' }] },
      { id: 'vertraege', parentId: null, accessMode: 'custom', grants: [{ role: 'org-buchhaltung', level: 'read' }] },
      { id: 'plaene', parentId: null, accessMode: 'inherit', grants: [] },
    ]
    orphans.names = new Map([
      ['honorare', 'Honorare'],
      ['vertraege', 'Verträge'],
    ])
    orphans.admin = true
    orphans.roles = []
  })

  it('names the folders whose list matches no role of the organization, for someone who may read them', async () => {
    await expect(listFoldersWithoutValidRole(SESSION, 'proj-1')).resolves.toEqual([{ id: 'honorare', name: 'Honorare' }])
  })

  it('needs project:manage, and asks it before anything else', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError('Project not found'))

    await expect(listFoldersWithoutValidRole(SESSION, 'proj-1')).rejects.toBeInstanceOf(NotFoundError)
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, 'proj-1', 'project:manage')
  })

  it('does not name a folder to a project manager who cannot read it', async () => {
    orphans.admin = false

    await expect(listFoldersWithoutValidRole(SESSION, 'proj-1')).resolves.toEqual([])
  })

  it('answers none for a project in which no folder has its own list, without asking WorkOS', async () => {
    orphans.tree = null

    await expect(listFoldersWithoutValidRole(SESSION, 'proj-1')).resolves.toEqual([])
    expect(organizationRoleSlugs).not.toHaveBeenCalled()
  })

  it('flags nothing when WorkOS cannot list the roles: an outage is not a deleted role', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(organizationRoleSlugs).mockRejectedValueOnce(new Error('WorkOS unavailable'))

    await expect(listFoldersWithoutValidRole(SESSION, 'proj-1')).resolves.toEqual([])
  })
})
