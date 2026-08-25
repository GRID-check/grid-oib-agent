/**
 * @vitest-environment node
 *
 * Re-filing one document into another folder.
 *
 * Two things are pinned here, and neither is the update itself.
 *
 * The first is the TENANT boundary on the destination: a folder id is a bare
 * pointer, and without checking that the folder belongs to the same project the
 * move would file a document under another project's tree — where it would
 * disappear from every listing that filters by folder.
 *
 * The second is the BACKEND MIRROR (ADR-0049). The Python side files documents
 * under the materialised path, so a move that only wrote `documents.folder_id`
 * leaves the agent's inventory and `knowledge_search folder=` naming the folder
 * the file just left. The subtree mirror cannot cover this — it rewrites a path
 * PREFIX, and a document leaving `Brandschutz` for `Statik` shares no prefix
 * with where it was.
 *
 * The backend twin — same URL, same `folder_path` body — is
 * `frontends/aiq_api/tests/test_document_folder_path_patch.py`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

const db = vi.hoisted(() => ({
  /** Rows the next `select(...).limit()` resolves to, in call order. */
  selects: [] as Array<Array<Record<string, unknown>>>,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => db.selects.shift() ?? [] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        db.updates.push(values)
        return {
          where: () => ({
            returning: async () => [{ id: 'doc-1', folderId: values.folderId }],
          }),
        }
      },
    }),
  }),
}))

vi.mock('@/lib/db/schema', () => ({
  documents: {
    id: 'documents.id',
    organizationId: 'documents.organization_id',
    projectId: 'documents.project_id',
    folderId: 'documents.folder_id',
    filename: 'documents.filename',
    collectionName: 'documents.collection_name',
    updatedAt: 'documents.updated_at',
  },
  projectFolders: { id: 'folders.id', projectId: 'folders.project_id', path: 'folders.path' },
}))

import { moveDocumentToFolder } from './move-to-folder'

const SESSION = { organizationId: 'org-1', userId: 'user-1' } as never

const DOCUMENT = {
  id: 'doc-1',
  projectId: 'proj-1',
  folderId: null,
  filename: 'Fluchtwegplan.pdf',
  collectionName: 'proj_1',
}

let fetchSpy: ReturnType<typeof vi.fn>

const mirrorBody = (): Record<string, unknown> =>
  JSON.parse(fetchSpy.mock.calls[0][1].body as string) as Record<string, unknown>

beforeEach(() => {
  db.selects = []
  db.updates = []
  fetchSpy = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('moveDocumentToFolder', () => {
  it('files the document and tells the backend the new PATH, not the id', async () => {
    db.selects = [[DOCUMENT], [{ id: 'folder-1', path: 'Brandschutz/Fluchtwege' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBe('folder-1')
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://backend:8000/v1/collections/proj_1/documents/Fluchtwegplan.pdf/folder-path',
    )
    expect(mirrorBody()).toEqual({ folder_path: 'Brandschutz/Fluchtwege' })
  })

  it('clears the backend path when the document goes back to the project root', async () => {
    db.selects = [[{ ...DOCUMENT, folderId: 'folder-1' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: null }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBeNull()
    expect(mirrorBody()).toEqual({ folder_path: null })
  })

  it('refuses a folder that belongs to another project', async () => {
    // The document is found; the folder lookup, scoped to the document's own
    // project, is not.
    db.selects = [[DOCUMENT], []]

    const result = await moveDocumentToFolder(
      { documentId: 'doc-1', folderId: 'folder-from-elsewhere' },
      SESSION,
    )

    expect(result).toEqual({ ok: false, error: 'Folder not found in this project.' })
    expect(db.updates).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a document that is not filed in a project at all', async () => {
    db.selects = [[{ ...DOCUMENT, projectId: null }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: null }, SESSION)

    expect(result).toEqual({ ok: false, error: 'Only project documents live in folders.' })
    expect(db.updates).toHaveLength(0)
  })

  it('does nothing at all when the document is already there', async () => {
    db.selects = [[{ ...DOCUMENT, folderId: 'folder-1' }], [{ id: 'folder-1', path: 'Brandschutz' }]]

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    expect(result.ok).toBe(true)
    expect(db.updates).toHaveLength(0)
    // No write, so nothing for the backend to catch up on either.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still moves the document when the backend mirror is unreachable', async () => {
    db.selects = [[DOCUMENT], [{ id: 'folder-1', path: 'Statik' }]]
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await moveDocumentToFolder({ documentId: 'doc-1', folderId: 'folder-1' }, SESSION)

    // The row is the durable record; a backend outage must not fail a move the
    // user is entitled to make.
    expect(result.ok).toBe(true)
    expect(db.updates[0].folderId).toBe('folder-1')
  })
})
