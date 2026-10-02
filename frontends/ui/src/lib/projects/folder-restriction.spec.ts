/**
 * @vitest-environment node
 *
 * Drawing a restriction over a folder that holds IFC models is refused before
 * the line is drawn (ADR-0078): restricted folders do not hold IFC models until
 * a model's building data is partitioned.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/authz/folder-access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authz/folder-access')>('@/lib/authz/folder-access')
  const open = (await import('@/test-utils/folder-access')).openFolderAccessModule()
  // The guard runs the decision's pure core over the would-be tree, for real.
  return { ...open, computeFolderAccess: actual.computeFolderAccess }
})
vi.mock('@/lib/authz/folder-access-repository', () => ({
  projectHasRestrictedFolders: vi.fn(async () => false),
  listProjectFolderTree: vi.fn(async () => [
    { id: 'modelle', parentId: null, restrictedRoles: null },
    { id: 'plaene', parentId: null, restrictedRoles: null },
  ]),
  countIfcDocumentsInFolders: vi.fn(async () => 0),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => undefined) }))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async () => ({ id: 'proj-1', collectionName: 'proj_1' })),
}))
vi.mock('@/lib/authz/custom-roles', () => ({
  organizationRoleSlugs: vi.fn(async () => new Set(['org-geschaeftsfuehrung'])),
}))
vi.mock('./collection-placement', () => ({ placeProjectDocuments: vi.fn(async () => ({ moved: 0, failed: [] })) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn(async () => undefined) }))

const writes = vi.hoisted(() => ({ updates: 0 }))
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    update: () => {
      writes.updates += 1
      return { set: () => ({ where: () => ({ returning: async () => [{ id: 'modelle' }] }) }) }
    },
  }),
}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: (_scope: unknown, run: () => unknown) => run(),
}))
vi.mock('@/lib/db/schema', () => ({
  projectFolders: { id: 'folders.id', projectId: 'folders.project_id' },
}))

import { countIfcDocumentsInFolders } from '@/lib/authz/folder-access-repository'
import { placeProjectDocuments } from './collection-placement'
import { setFolderRestriction } from './folder-restriction'

const SESSION = { organizationId: 'org-1', userId: 'user-1', email: 'a@b.c' } as never

beforeEach(() => {
  writes.updates = 0
})

describe('setFolderRestriction and IFC models', () => {
  it('refuses restricting a folder that holds IFC models, names the count, and writes nothing', async () => {
    vi.mocked(countIfcDocumentsInFolders).mockResolvedValueOnce(3)

    const error = await setFolderRestriction(
      SESSION,
      { projectId: 'proj-1', folderId: 'modelle', roles: ['org-geschaeftsfuehrung'] },
      new Request('http://x')
    ).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      status: 409,
      message: expect.stringMatching(/hold 3 IFC models\. IFC models cannot be filed in a restricted folder yet/),
      details: { code: 'IFC_IN_RESTRICTED_FOLDER', models: 3 },
    })
    expect(countIfcDocumentsInFolders).toHaveBeenCalledWith('org-1', 'proj-1', ['modelle'])
    expect(writes.updates).toBe(0)
    expect(placeProjectDocuments).not.toHaveBeenCalled()
  })

  it('restricts a folder that holds none', async () => {
    const result = await setFolderRestriction(
      SESSION,
      { projectId: 'proj-1', folderId: 'plaene', roles: ['org-geschaeftsfuehrung'] },
      new Request('http://x')
    )
    expect(result.roles).toEqual(['org-geschaeftsfuehrung'])
    expect(writes.updates).toBe(1)
  })

  it('always lets a folder be opened again', async () => {
    vi.mocked(countIfcDocumentsInFolders).mockResolvedValue(3)
    const result = await setFolderRestriction(
      SESSION,
      { projectId: 'proj-1', folderId: 'modelle', roles: null },
      new Request('http://x')
    )
    expect(result.roles).toBeNull()
    expect(writes.updates).toBe(1)
  })
})
