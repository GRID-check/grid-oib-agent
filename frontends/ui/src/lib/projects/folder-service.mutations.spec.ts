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
              then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
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
  projectFolders: { id: 'folders.id', projectId: 'folders.project_id', parentId: 'folders.parent_id', path: 'folders.path' },
  documents: { id: 'documents.id', folderId: 'documents.folder_id', projectId: 'documents.project_id' },
}))

import { deleteProjectFolder } from './folder-service'

const SESSION = { organizationId: 'org-1', userId: 'user-1' } as never

describe('deleteProjectFolder', () => {
  beforeEach(() => {
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
})
