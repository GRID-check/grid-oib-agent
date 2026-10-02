/**
 * @vitest-environment node
 *
 * A rename, move or delete that changes folder access is a change of folder
 * access (ADR-0078).
 *
 * `setFolderRestriction` needs `project:manage` and leaves a
 * `project.folder.access_changed` line. Deleting a restricted folder, or moving
 * a folder out from under (or into) a restricted one, changes which documents
 * are restricted just as surely, and needed only `project:documents:write` and
 * left no line. This spec pins the rule both ways: such a change needs
 * `project:manage` and is audited, and one that changes nothing (an open folder
 * moved between open folders, a rename, deleting an open folder) still needs
 * only the write permission and is not audited.
 *
 *   Verwaltung/           (open)
 *     Verträge/           (org-gf)
 *       Alt/              (open, restricted by Verträge)
 *     Projektordner/      (open)
 *   Ablage/               (open)
 *   Honorare/             (org-gf; hidden from the session in the last block)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { AccessFolder, ProjectFolderAccess } from '@/lib/authz/folder-access'

interface FolderRow {
  id: string
  projectId: string
  parentId: string | null
  name: string
  path: string
  restrictedRoles: string[] | null
  createdAt: Date
  updatedAt: Date
}

const at = new Date('2026-10-01T00:00:00Z')
const folder = (id: string, name: string, path: string, parentId: string | null, roles: string[] | null = null): FolderRow => ({
  id,
  projectId: 'proj-1',
  parentId,
  name,
  path,
  restrictedRoles: roles,
  createdAt: at,
  updatedAt: at,
})

const TREE = {
  verwaltung: folder('f-verwaltung', 'Verwaltung', 'Verwaltung', null),
  vertraege: folder('f-vertraege', 'Verträge', 'Verwaltung/Verträge', 'f-verwaltung', ['org-gf']),
  alt: folder('f-alt', 'Alt', 'Verwaltung/Verträge/Alt', 'f-vertraege'),
  projektordner: folder('f-projektordner', 'Projektordner', 'Verwaltung/Projektordner', 'f-verwaltung'),
  ablage: folder('f-ablage', 'Ablage', 'Ablage', null),
  honorare: folder('f-honorare', 'Honorare', 'Honorare', null, ['org-gf']),
}
const byId = new Map(Object.values(TREE).map((row) => [row.id, row]))

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  hidden: new Set<string>(),
  /** Rows the next `.limit()` reads answer with, in order. */
  reads: [] as unknown[][],
  transactions: 0,
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(async (_session: unknown, _project: string, permission: string | string[]) => {
    const wanted = Array.isArray(permission) ? permission : [permission]
    if (!wanted.some((entry) => state.granted.has(entry))) throw new Error(`Forbidden: ${wanted.join('|')}`)
    return { role: 'project-editor' }
  }),
}))

vi.mock('@/lib/authz/folder-access', () => ({
  getProjectFolderAccess: vi.fn(
    async (): Promise<ProjectFolderAccess> => ({
      hiddenFolderIds: state.hidden,
      isVisible: (id: string | null) => id === null || !state.hidden.has(id),
      collectionFor: () => 'proj_collection',
      clearedRestrictedCollections: [],
      anyRestricted: true,
    })
  ),
}))

vi.mock('@/lib/authz/folder-access-repository', () => ({
  listProjectDocumentCollections: vi.fn(async () => []),
  listProjectFolderTree: vi.fn(
    async (): Promise<AccessFolder[]> =>
      [...byId.values()].map(({ id, parentId, restrictedRoles }) => ({ id, parentId, restrictedRoles }))
  ),
}))

vi.mock('./collection-placement', () => ({
  placeProjectDocuments: vi.fn(async () => ({ moved: 3, failed: [] })),
}))
vi.mock('./ifc-folder-guard', () => ({ assertFolderMoveKeepsIfcOpen: vi.fn(async () => undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async () => ({ id: 'proj-1', collectionName: 'proj_collection' })),
}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

vi.mock('@/lib/db', () => {
  /** A statement that can be awaited, `.returning()`ed, or both. */
  const statement = (rows: unknown[]) =>
    Object.assign(Promise.resolve(undefined), { returning: async () => rows })
  const tx = {
    update: () => ({ set: () => ({ where: () => statement([{}]) }) }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
    delete: () => ({ where: async () => undefined }),
  }
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => state.reads.shift() ?? [] }) }),
      }),
      transaction: async (run: (handle: typeof tx) => Promise<unknown>) => {
        state.transactions += 1
        return run(tx)
      },
    }),
  }
})

const { deleteProjectFolder, updateProjectFolder } = await import('./folder-service')
const { recordAuditEvent } = await import('@/lib/audit/service')

const session = { userId: 'user-1', email: 'pl@buero.at', organizationId: 'org-1' } as AuthorizedSession
const WRITE_ONLY = ['project:documents:write']
const MANAGER = ['project:documents:write', 'project:manage']

/** Queue the folder lookups a call makes: the folder, then the parent it reads. */
function reads(...rows: FolderRow[]) {
  state.reads = rows.map((row) => [row])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
  state.granted = new Set(WRITE_ONLY)
  state.hidden = new Set()
  state.reads = []
  state.transactions = 0
})

describe('moving a folder', () => {
  it('needs project:manage to take a folder out from under a restricted one', async () => {
    reads(TREE.alt, TREE.ablage)

    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: TREE.alt.id, parentId: TREE.ablage.id }, session)
    ).rejects.toThrow(/project:manage/)
    expect(state.transactions).toBe(0)
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('records the change when a manager makes it', async () => {
    state.granted = new Set(MANAGER)
    reads(TREE.alt, TREE.ablage)

    const result = await updateProjectFolder(
      { projectId: 'proj-1', folderId: TREE.alt.id, parentId: TREE.ablage.id },
      session
    )

    expect(result.ok).toBe(true)
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.folder.access_changed',
        targetType: 'project',
        targetId: 'proj-1',
        metadata: { folderId: TREE.alt.id, roles: '', documentsMoved: 3 },
      })
    )
  })

  it('needs project:manage to put a folder under a restriction, and records what now governs it', async () => {
    reads(TREE.projektordner, TREE.vertraege)
    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: TREE.projektordner.id, parentId: TREE.vertraege.id }, session)
    ).rejects.toThrow(/project:manage/)

    state.granted = new Set(MANAGER)
    reads(TREE.projektordner, TREE.vertraege)
    await updateProjectFolder(
      { projectId: 'proj-1', folderId: TREE.projektordner.id, parentId: TREE.vertraege.id },
      session
    )
    expect(vi.mocked(recordAuditEvent).mock.calls[0][0].metadata).toEqual({
      folderId: TREE.projektordner.id,
      roles: 'org-gf',
      documentsMoved: 3,
    })
  })

  it('leaves a move between open folders to the write permission, unaudited', async () => {
    reads(TREE.projektordner, TREE.ablage)

    const result = await updateProjectFolder(
      { projectId: 'proj-1', folderId: TREE.projektordner.id, parentId: TREE.ablage.id },
      session
    )

    expect(result.ok).toBe(true)
    expect(state.transactions).toBe(1)
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('leaves a rename inside a restricted folder to the write permission', async () => {
    reads(TREE.alt, TREE.vertraege)

    const result = await updateProjectFolder({ projectId: 'proj-1', folderId: TREE.alt.id, name: 'Archiv' }, session)

    expect(result.ok).toBe(true)
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})

describe('deleting a folder', () => {
  it('needs project:manage to delete a restricted folder', async () => {
    reads(TREE.vertraege, TREE.verwaltung)

    await expect(deleteProjectFolder({ projectId: 'proj-1', folderId: TREE.vertraege.id }, session)).rejects.toThrow(
      /project:manage/
    )
    expect(state.transactions).toBe(0)
  })

  it('records the lifted restriction when a manager deletes it', async () => {
    state.granted = new Set(MANAGER)
    reads(TREE.vertraege, TREE.verwaltung)

    const result = await deleteProjectFolder({ projectId: 'proj-1', folderId: TREE.vertraege.id }, session)

    expect(result.ok).toBe(true)
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.folder.access_changed',
        metadata: { folderId: TREE.vertraege.id, roles: '', documentsMoved: 3 },
      })
    )
  })

  it('leaves deleting an open folder to the write permission, unaudited', async () => {
    reads(TREE.projektordner, TREE.verwaltung)

    const result = await deleteProjectFolder({ projectId: 'proj-1', folderId: TREE.projektordner.id }, session)

    expect(result.ok).toBe(true)
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})

describe('a folder the session may not see', () => {
  beforeEach(() => {
    state.granted = new Set(MANAGER)
    state.hidden = new Set([TREE.honorare.id])
  })

  it('cannot be renamed, moved or deleted, even by a manager', async () => {
    reads(TREE.honorare)
    expect(await updateProjectFolder({ projectId: 'proj-1', folderId: TREE.honorare.id, name: 'X' }, session)).toEqual({
      ok: false,
      error: 'Folder not found.',
    })
    reads(TREE.honorare)
    expect(await deleteProjectFolder({ projectId: 'proj-1', folderId: TREE.honorare.id }, session)).toEqual({
      ok: false,
      error: 'Folder not found.',
    })
    expect(state.transactions).toBe(0)
  })

  it('cannot be moved into', async () => {
    reads(TREE.ablage)
    expect(
      await updateProjectFolder({ projectId: 'proj-1', folderId: TREE.ablage.id, parentId: TREE.honorare.id }, session)
    ).toEqual({ ok: false, error: 'Parent folder not found.' })
    expect(state.transactions).toBe(0)
  })
})
