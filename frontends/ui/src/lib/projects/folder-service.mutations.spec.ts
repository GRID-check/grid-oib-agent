/**
 * @vitest-environment node
 *
 * Renaming, moving and deleting a project folder.
 *
 * The delete is why this file exists. `documents.folder_id` is
 * `ON DELETE CASCADE` (see `schema/documents.ts`), so removing a folder row
 * takes every document filed in it with it — silently, and with no way back. A
 * folder is a label somebody put on a set of documents; deleting the label must
 * never delete the documents. That is asserted here as an ORDER: the documents
 * are re-filed inside the transaction, before the row is deleted, so the
 * cascade never has anything to find.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

const db = vi.hoisted(() => ({
  folders: [] as Array<Record<string, unknown>>,
  /** Every write the code performed, in order. */
  calls: [] as string[],
}))

vi.mock('@/lib/db', () => {
  /** A transaction handle that records the ORDER of what it was asked to do. */
  const tx = {
    update: (table: { id?: string }) => {
      const target = table.id === 'documents.id' ? 'documents' : 'folders'
      return {
        set: () => ({
          where: () => {
            db.calls.push(`update:${target}`)
            return {
              returning: async () => [{ id: 'doc-1' }, { id: 'doc-2' }],
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve(undefined).then(resolve),
            }
          },
        }),
      }
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    delete: () => ({
      where: async () => {
        db.calls.push('delete:folder')
      },
    }),
  }
  return {
    getDb: () => {
      const selectFrom = () => ({
        from: () => ({
          where: () => ({
            limit: async () => db.folders.filter((f) => f.__match === 'one').map((f) => f.row),
            then: undefined,
          }),
        }),
      })
      return {
        select: selectFrom,
        transaction: async (run: (handle: unknown) => Promise<unknown>) => {
          db.calls.push('begin')
          const result = await run(tx)
          db.calls.push('commit')
          return result
        },
      }
    },
  }
})

vi.mock('@/lib/db/schema', () => ({
  projectFolders: {
    id: 'folders.id',
    projectId: 'folders.project_id',
    parentId: 'folders.parent_id',
    path: 'folders.path',
  },
  documents: {
    id: 'documents.id',
    folderId: 'documents.folder_id',
    projectId: 'documents.project_id',
  },
}))

// The backend mirror runs after the transaction (ADR-0049). Both of its
// dependencies are stubbed here rather than reached: the real repository pulls
// the auth stack into a `node`-environment spec, and the point of this file is
// the ORDER of the writes, not the fetch.
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn().mockResolvedValue({ id: 'proj-1', collectionName: 'proj_abc' }),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

import { deleteProjectFolder, updateProjectFolder } from './folder-service'

const SESSION = { organizationId: 'org-1', userId: 'user-1' } as never

let fetchSpy: ReturnType<typeof vi.fn>

describe('deleteProjectFolder', () => {
  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
    db.calls = []
    db.folders = [
      {
        __match: 'one',
        row: {
          id: 'folder-1',
          projectId: 'proj-1',
          parentId: null,
          name: 'Brandschutz',
          path: 'Brandschutz',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ]
  })

  it('re-files the documents BEFORE deleting the folder', async () => {
    const result = await deleteProjectFolder({ projectId: 'proj-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
    // The order is the whole assertion. Reverse these two and the cascade
    // deletes every document in the folder on its way out.
    const documentsMoved = db.calls.indexOf('update:documents')
    const folderDeleted = db.calls.indexOf('delete:folder')
    expect(documentsMoved).toBeGreaterThanOrEqual(0)
    expect(folderDeleted).toBeGreaterThan(documentsMoved)
    // And in one transaction, so a failure half-way cannot strand documents in
    // a folder that no longer exists.
    expect(db.calls[0]).toBe('begin')
    expect(db.calls.at(-1)).toBe('commit')
  })

  it('reports what it moved, so the surface can say where the files went', async () => {
    const result = await deleteProjectFolder({ projectId: 'proj-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok && result.result.documentsMoved).toBe(2)
  })

  /**
   * The join. The backend files documents under the materialised PATH, so a
   * delete that re-files this folder's contents at its parent has to say so —
   * otherwise the agent goes on describing a folder the user just removed.
   *
   * `to_path` is the parent's path, empty at the project root, which the mirror
   * sends as null. The backend twin asserting the same body is
   * `frontends/aiq_api/tests/test_documents_folder_paths_patch.py`.
   */
  it('mirrors the re-filing onto the backend AFTER the rows are committed', async () => {
    await deleteProjectFolder({ projectId: 'proj-1', folderId: 'folder-1' }, SESSION)

    expect(db.calls.at(-1)).toBe('commit')
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://backend:8000/v1/collections/proj_abc/folder-paths',
      expect.objectContaining({ method: 'PATCH' })
    )
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({ from_path: 'Brandschutz', to_path: null })
  })

  it('does not fail the delete when the backend mirror is unreachable', async () => {
    // The folder rows are the durable truth. A backend that is down must not
    // stop somebody removing a label from their own project.
    fetchSpy.mockRejectedValue(new Error('backend down'))

    const result = await deleteProjectFolder({ projectId: 'proj-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
  })
})

/**
 * The other half of the mirror's caller-side join: a RENAME is the common case,
 * and it moves the path of every document filed in the folder or beneath it.
 */
describe('updateProjectFolder', () => {
  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
    db.calls = []
    db.folders = [
      {
        __match: 'one',
        row: {
          id: 'folder-1',
          projectId: 'proj-1',
          parentId: null,
          name: 'Brandschutz',
          path: 'Brandschutz',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ]
  })

  it('mirrors the renamed path onto the backend', async () => {
    await updateProjectFolder({ projectId: 'proj-1', folderId: 'folder-1', name: 'Feuer' }, SESSION)

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>
    expect(body).toEqual({ from_path: 'Brandschutz', to_path: 'Feuer' })
  })

  it('does not touch the backend when nothing actually moved', async () => {
    await updateProjectFolder(
      { projectId: 'proj-1', folderId: 'folder-1', name: 'Brandschutz' },
      SESSION
    )

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
