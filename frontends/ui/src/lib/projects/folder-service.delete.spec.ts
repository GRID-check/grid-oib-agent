/**
 * @vitest-environment node
 *
 * Deleting a PROJECT folder is the Papierkorb's (ADR-0088): the folder goes to
 * the bin with its subfolders and their documents. The shelf's delete, which
 * re-files the contents into the parent, is the Archiv's alone; for a project
 * it would lift the folder's own list from what it held. What the bin does is
 * proved against Postgres in `folder-bin.integration.spec.ts`; this pins the
 * wiring, which a merge of the shelf refactor once put back the other way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('server-only', () => ({}))
vi.mock('./folder-bin', () => ({
  moveFolderToBin: vi.fn(async () => ({
    documentsBinned: 2,
    foldersBinned: 1,
    purgeAfter: new Date('2026-10-20T03:00:00Z'),
  })),
}))
vi.mock('@/lib/documents/shelf-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/shelf-folders')>()),
  deleteShelfFolder: vi.fn(async () => ({ ok: true, result: { documentsMoved: 0, foldersMoved: 0 } })),
}))

const { deleteProjectFolder } = await import('./folder-service')
const { moveFolderToBin } = await import('./folder-bin')
const { deleteShelfFolder } = await import('@/lib/documents/shelf-folders')

const session = { userId: 'user-1', organizationId: 'org-1', roles: [], permissions: [] } as unknown as AuthorizedSession

beforeEach(() => vi.clearAllMocks())

describe('deleteProjectFolder', () => {
  it('moves the folder to the Papierkorb and answers what went and when it is purged', async () => {
    const request = new Request('http://test/api/projects/proj-1/folders/f-1', { method: 'DELETE' })

    const result = await deleteProjectFolder({ projectId: 'proj-1', folderId: 'f-1' }, session, request)

    expect(moveFolderToBin).toHaveBeenCalledWith(session, { projectId: 'proj-1', folderId: 'f-1' }, request)
    expect(result).toEqual({ documentsBinned: 2, foldersBinned: 1, purgeAfter: new Date('2026-10-20T03:00:00Z') })
  })

  it('never re-files the contents into the parent: the shelf delete is the Archiv’s', async () => {
    await deleteProjectFolder({ projectId: 'proj-1', folderId: 'f-1' }, session)

    expect(deleteShelfFolder).not.toHaveBeenCalled()
  })

  it('passes a refusal of the bin through unchanged (a protected subtree, a missing folder)', async () => {
    const refusal = Object.assign(new Error('This folder holds content you may not delete.'), { status: 403 })
    vi.mocked(moveFolderToBin).mockRejectedValueOnce(refusal)

    await expect(deleteProjectFolder({ projectId: 'proj-1', folderId: 'f-1' }, session)).rejects.toBe(refusal)
    expect(deleteShelfFolder).not.toHaveBeenCalled()
  })
})
