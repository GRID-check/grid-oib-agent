/**
 * @vitest-environment node
 *
 * Keeping the backend's copy of the folder tree honest (ADR-0049).
 *
 * The Python side files every document under the MATERIALISED PATH, not the
 * folder id — it has no `project_folders` table to join against, the path is
 * what a person reads, and a prefix match over it is the folder's whole subtree.
 * The price of that denormalisation is that a path MOVES, and this is the one
 * function that replays the move. Without it a rename leaves the agent
 * describing a folder structure the user no longer has, and
 * `knowledge_search folder=` filters on a name that no longer exists.
 *
 * The backend twin — same URL, same `from_path`/`to_path` body — is
 * `frontends/aiq_api/tests/test_documents_folder_paths_patch.py`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }))

vi.mock('@/lib/db/schema', () => ({
  projectFolders: { id: 'folders.id', projectId: 'folders.project_id', parentId: 'folders.parent_id', path: 'folders.path' },
  documents: { id: 'documents.id', folderId: 'documents.folder_id', projectId: 'documents.project_id' },
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(),
}))

import { findProjectInOrg } from '@/lib/projects/repository'
import { mirrorFolderPathRewrite } from './folder-service'

let fetchSpy: ReturnType<typeof vi.fn>

const body = (): Record<string, unknown> =>
  JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchSpy)
  vi.mocked(findProjectInOrg).mockResolvedValue({
    id: 'proj-1',
    collectionName: 'proj_abc',
  } as Awaited<ReturnType<typeof findProjectInOrg>>)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('mirrorFolderPathRewrite', () => {
  it('PATCHes the old and new path onto the project collection', async () => {
    await mirrorFolderPathRewrite('proj-1', 'org-1', 'Brandschutz', 'Feuer')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://backend:8000/v1/collections/proj_abc/folder-paths',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(body()).toEqual({ from_path: 'Brandschutz', to_path: 'Feuer' })
  })

  it('sends a nested path verbatim, so the whole subtree moves with it', async () => {
    await mirrorFolderPathRewrite('proj-1', 'org-1', 'Alt/Brandschutz', 'Neu/Brandschutz')

    expect(body()).toEqual({ from_path: 'Alt/Brandschutz', to_path: 'Neu/Brandschutz' })
  })

  it('sends null when the subtree lands at the project root', async () => {
    // What a folder delete does to its direct children. `''` is not a folder
    // name, and sending it as one would file documents under an empty label.
    await mirrorFolderPathRewrite('proj-1', 'org-1', 'Brandschutz', '')

    expect(body()).toEqual({ from_path: 'Brandschutz', to_path: null })
  })

  it('does nothing when the path did not actually change', async () => {
    await mirrorFolderPathRewrite('proj-1', 'org-1', 'Brandschutz', 'Brandschutz')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not call the backend for a project outside the caller organization', async () => {
    vi.mocked(findProjectInOrg).mockResolvedValue(null)

    await mirrorFolderPathRewrite('proj-1', 'org-1', 'Brandschutz', 'Feuer')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('swallows a backend failure — the folder rows are the durable truth', async () => {
    fetchSpy.mockRejectedValue(new Error('backend down'))

    await expect(mirrorFolderPathRewrite('proj-1', 'org-1', 'Brandschutz', 'Feuer')).resolves.toBeUndefined()
  })

  it('url-encodes a collection name so the path cannot be split', async () => {
    vi.mocked(findProjectInOrg).mockResolvedValue({
      id: 'proj-1',
      collectionName: 'proj a/b',
    } as Awaited<ReturnType<typeof findProjectInOrg>>)

    await mirrorFolderPathRewrite('proj-1', 'org-1', 'Brandschutz', 'Feuer')

    expect(fetchSpy.mock.calls[0][0]).toBe('http://backend:8000/v1/collections/proj%20a%2Fb/folder-paths')
  })
})
