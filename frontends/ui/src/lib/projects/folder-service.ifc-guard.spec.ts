/**
 * @vitest-environment node
 *
 * Moving a folder asks the IFC guard before anything is written (ADR-0078):
 * restricted folders do not hold IFC models, so a folder holding one may not be
 * moved under a restriction. The guard's own rule is pinned in
 * `ifc-folder-guard.spec.ts`; this file pins that the move asks it, and stops.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./ifc-folder-guard', () => ({ assertFolderMoveKeepsIfcOpen: vi.fn(async () => undefined) }))
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/authz/folder-access-repository', () => ({
  listProjectDocumentCollections: vi.fn(async () => []),
  // No folder has its own access list: the move changes nobody's access.
  listProjectFolderTree: vi.fn(async () => []),
}))
vi.mock('./collection-placement', () => ({
  placeProjectDocuments: vi.fn(async () => ({ moved: 0, failed: [] })),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => undefined) }))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async () => ({ id: 'proj-1', collectionName: 'proj_1' })),
}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: vi.fn(() => 'http://backend:8000') }))

const FOLDER = { id: 'modelle', projectId: 'proj-1', parentId: null, name: 'Modelle', path: 'Modelle' }
const DESTINATION = { id: 'verwaltung', projectId: 'proj-1', parentId: null, name: 'Verwaltung', path: 'Verwaltung' }

const db = vi.hoisted(() => ({
  /** Rows the next `select(...).limit()` resolves to, in call order. */
  selects: [] as Array<Array<Record<string, unknown>>>,
  transactions: 0,
}))

vi.mock('@/lib/db', () => {
  const tx = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ ...FOLDER, parentId: 'verwaltung', path: 'Verwaltung/Modelle' }],
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        }),
      }),
    }),
  }
  return {
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => db.selects.shift() ?? [] }) }) }),
      transaction: async (run: (handle: unknown) => Promise<unknown>) => {
        db.transactions += 1
        return run(tx)
      },
    }),
  }
})
vi.mock('@/lib/db/schema', () => ({
  projectFolders: { id: 'folders.id', projectId: 'folders.project_id', parentId: 'folders.parent_id', path: 'folders.path' },
  documents: { id: 'documents.id', folderId: 'documents.folder_id', projectId: 'documents.project_id' },
}))

import { ConflictError } from '@/lib/api/errors'
import { assertFolderMoveKeepsIfcOpen } from './ifc-folder-guard'
import { updateProjectFolder } from './folder-service'

const SESSION = { organizationId: 'org-1', userId: 'user-1' } as never

beforeEach(() => {
  db.selects = [[FOLDER], [DESTINATION]]
  db.transactions = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

describe('updateProjectFolder and IFC models', () => {
  it('asks the guard about the new parent, and moves when it agrees', async () => {
    const result = await updateProjectFolder({ projectId: 'proj-1', folderId: 'modelle', parentId: 'verwaltung' }, SESSION)

    expect(assertFolderMoveKeepsIfcOpen).toHaveBeenCalledWith('org-1', 'proj-1', 'modelle', 'verwaltung')
    expect(result.ok).toBe(true)
    expect(db.transactions).toBe(1)
  })

  it('writes nothing when the guard refuses, and the 409 reaches the caller', async () => {
    vi.mocked(assertFolderMoveKeepsIfcOpen).mockRejectedValueOnce(
      new ConflictError('IFC models cannot be filed in a restricted folder yet', { code: 'IFC_IN_RESTRICTED_FOLDER' })
    )

    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: 'modelle', parentId: 'verwaltung' }, SESSION)
    ).rejects.toMatchObject({ status: 409 })
    expect(db.transactions).toBe(0)
  })

  it('does not ask for a rename that leaves the parent alone', async () => {
    db.selects = [[FOLDER]]
    await updateProjectFolder({ projectId: 'proj-1', folderId: 'modelle', name: 'IFC' }, SESSION)
    expect(assertFolderMoveKeepsIfcOpen).not.toHaveBeenCalled()
  })
})
