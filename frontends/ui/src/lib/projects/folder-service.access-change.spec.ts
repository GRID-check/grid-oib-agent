/**
 * @vitest-environment node
 *
 * Renaming and moving folders under read/write access (ADR-0088).
 *
 * Each is a write: on the folder and on a move's new parent. A folder the
 * session may only read refuses with a typed 403, one it may not read answers
 * not found, and the project's document-write permission stays the ceiling. A
 * move that changes the access lists over a subtree is a change of folder
 * access on top: it needs `project:manage` and leaves a
 * `project.folder.access_changed` line, like `setFolderAccess`; one that
 * changes nothing (an open folder moved between open folders, a rename) needs
 * only the write and is not audited. Deleting is the Papierkorb's
 * (`folder-bin.integration.spec.ts`).
 *
 *   Verwaltung/           inherits
 *     Verträge/           org-gf: write, org-bh: read
 *       Alt/              inherits (narrowed by Verträge)
 *       Sub/              inherits (narrowed by Verträge)
 *         Geheim/         org-hr: write (the session may not read it)
 *     Projektordner/      inherits
 *   Ablage/               inherits
 *   Honorare/             org-hr: write (the session may not read it)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AccessFolder, FolderGrant } from '@/lib/authz/folder-access'

interface FolderRow {
  id: string
  projectId: string
  parentId: string | null
  name: string
  path: string
  accessMode: 'inherit' | 'custom'
  createdAt: Date
  updatedAt: Date
}

const at = new Date('2026-10-01T00:00:00Z')
const grantsOf = new Map<string, FolderGrant[]>()
const folder = (id: string, name: string, path: string, parentId: string | null, grants: FolderGrant[] | null = null): FolderRow => {
  if (grants) grantsOf.set(id, grants)
  return { id, projectId: 'proj-1', parentId, name, path, accessMode: grants ? 'custom' : 'inherit', createdAt: at, updatedAt: at }
}

const TREE = {
  verwaltung: folder('f-verwaltung', 'Verwaltung', 'Verwaltung', null),
  vertraege: folder('f-vertraege', 'Verträge', 'Verwaltung/Verträge', 'f-verwaltung', [
    { role: 'org-gf', level: 'write' },
    { role: 'org-bh', level: 'read' },
  ]),
  alt: folder('f-alt', 'Alt', 'Verwaltung/Verträge/Alt', 'f-vertraege'),
  sub: folder('f-sub', 'Sub', 'Verwaltung/Verträge/Sub', 'f-vertraege'),
  geheim: folder('f-geheim', 'Geheim', 'Verwaltung/Verträge/Sub/Geheim', 'f-sub', [{ role: 'org-hr', level: 'write' }]),
  projektordner: folder('f-projektordner', 'Projektordner', 'Verwaltung/Projektordner', 'f-verwaltung'),
  ablage: folder('f-ablage', 'Ablage', 'Ablage', null),
  honorare: folder('f-honorare', 'Honorare', 'Honorare', null, [{ role: 'org-hr', level: 'write' }]),
}
const byId = new Map(Object.values(TREE).map((row) => [row.id, row]))

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  /** Rows the next `.limit()` reads answer with, in order. */
  reads: [] as unknown[][],
  /** Rows a read without a limit answers with. */
  children: [] as unknown[],
  transactions: 0,
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(async (_session: unknown, _project: string, permission: string | string[]) => {
    const wanted = Array.isArray(permission) ? permission : [permission]
    if (!wanted.some((entry) => state.granted.has(entry))) throw new Error(`Forbidden: ${wanted.join('|')}`)
    return { role: 'project-editor' }
  }),
}))

// The decision runs for real over the tree below; only its reads are stubbed.
vi.mock('@/lib/authz/folder-access-repository', () => ({
  listProjectDocumentCollections: vi.fn(async () => []),
  projectHasCustomOrBinnedFolders: vi.fn(async () => true),
  listProjectFolderTree: vi.fn(
    async (): Promise<AccessFolder[]> =>
      [...byId.values()].map(({ id, parentId, accessMode }) => ({
        id,
        parentId,
        accessMode,
        grants: grantsOf.get(id) ?? [],
      }))
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
    update: () => ({
      set: () => ({ where: () => statement([{}]) }),
    }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
    delete: () => ({ where: async () => undefined }),
  }
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () =>
            Object.assign(Promise.resolve(state.children), { limit: async () => state.reads.shift() ?? [] }),
        }),
      }),
      transaction: async (run: (handle: typeof tx) => Promise<unknown>) => {
        state.transactions += 1
        return run(tx)
      },
    }),
  }
})

const { createProjectFolder, updateProjectFolder } = await import('./folder-service')
const { recordAuditEvent } = await import('@/lib/audit/service')

const session = {
  userId: 'user-1',
  email: 'pl@buero.at',
  organizationId: 'org-1',
  role: 'org-gf',
  roles: ['org-gf'],
  permissions: [],
} as unknown as AuthorizedSession
/** May only read „Verträge“. */
const reader = { ...session, role: 'org-bh', roles: ['org-bh'] } as unknown as AuthorizedSession
const WRITE_ONLY = ['project:documents:write']
const MANAGER = ['project:documents:write', 'project:manage']

/**
 * Queue the folder lookups a call makes: the folder (twice: once for the
 * access check here, once by the shelf core that writes), then the parent it
 * reads. A refused call stops after the first.
 */
function reads(folder: FolderRow, ...rest: FolderRow[]) {
  state.reads = [[folder], [folder], ...rest.map((row) => [row])]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
  state.granted = new Set(WRITE_ONLY)
  state.reads = []
  state.children = []
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
        metadata: { folderId: TREE.alt.id, grants: '', roles: '', documentsMoved: 3 },
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
      grants: 'org-bh:read,org-gf:write',
      roles: 'org-bh,org-gf',
      documentsMoved: 3,
    })
  })

  describe('a subtree holding a folder the mover cannot read', () => {
    // Sub sits under Verträge (org-gf, org-bh) and holds Geheim, whose own list names org-hr only. The
    // path's minimum leaves nobody reading Geheim. Taking Sub out from under Verträge makes org-hr read
    // it, and the mover could not see what they changed.
    it('refuses to move it out from under a restricting folder, even for a manager, and writes nothing', async () => {
      state.granted = new Set(MANAGER)
      reads(TREE.sub, TREE.ablage)

      const error = await updateProjectFolder(
        { projectId: 'proj-1', folderId: TREE.sub.id, parentId: TREE.ablage.id },
        session
      ).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ status: 403, details: { reason: 'folder-subtree-unreadable' } })
      expect(state.transactions).toBe(0)
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    it('lets an organization admin, who reads everything, move it', async () => {
      state.granted = new Set(MANAGER)
      reads(TREE.sub, TREE.ablage)
      const admin = { ...session, permissions: ['org:projects:administer'] } as unknown as AuthorizedSession

      const result = await updateProjectFolder(
        { projectId: 'proj-1', folderId: TREE.sub.id, parentId: TREE.ablage.id },
        admin
      )

      expect(result.ok).toBe(true)
    })

    it('does not stop a move that leaves the lists above it as they were', async () => {
      state.granted = new Set(WRITE_ONLY)
      reads(TREE.sub, TREE.alt)
      // Sub into Alt: both sit under Verträge, so who reads Geheim does not change.
      const result = await updateProjectFolder(
        { projectId: 'proj-1', folderId: TREE.sub.id, parentId: TREE.alt.id },
        session
      )

      expect(result.ok).toBe(true)
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

describe('a folder the session may only read (ADR-0088)', () => {
  it('refuses a new folder inside it with a typed 403, and one inside a folder it may not read as missing', async () => {
    state.granted = new Set(MANAGER)
    await expect(
      createProjectFolder({ projectId: 'proj-1', parentId: TREE.vertraege.id, name: 'Neu' }, reader)
    ).rejects.toMatchObject({ status: 403, details: { reason: 'folder-read-only' } })
    await expect(
      createProjectFolder({ projectId: 'proj-1', parentId: TREE.honorare.id, name: 'Neu' }, reader)
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(state.transactions).toBe(0)
  })

  it('refuses rename and move with a typed 403, and writes nothing', async () => {
    state.granted = new Set(MANAGER)
    reads(TREE.alt)
    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: TREE.alt.id, name: 'X' }, reader)
    ).rejects.toBeInstanceOf(ForbiddenError)
    reads(TREE.alt)
    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: TREE.alt.id, parentId: TREE.ablage.id }, reader)
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(state.transactions).toBe(0)
  })

  it('refuses moving a folder the session may write INTO one it may only read', async () => {
    reads(TREE.ablage)
    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: TREE.ablage.id, parentId: TREE.vertraege.id }, reader)
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(state.transactions).toBe(0)
  })

  it('keeps the project permission the ceiling: without document write, a granted writer is refused too', async () => {
    state.granted = new Set(['project:view'])
    reads(TREE.alt)
    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: TREE.alt.id, name: 'X' }, session)
    ).rejects.toThrow(/Forbidden: project:documents:write/)
    expect(state.transactions).toBe(0)
  })

  it('lets an organization admin change a folder whose list names none of their roles', async () => {
    const admin = { ...session, roles: [], role: 'admin', permissions: ['org:projects:administer'] } as unknown as AuthorizedSession
    reads(TREE.honorare)
    const result = await updateProjectFolder({ projectId: 'proj-1', folderId: TREE.honorare.id, name: 'Gehälter' }, admin)
    expect(result.ok).toBe(true)
  })
})

describe('a folder the session may not read', () => {
  beforeEach(() => {
    state.granted = new Set(MANAGER)
  })

  it('cannot be renamed or moved, even by a manager: it is not found', async () => {
    reads(TREE.honorare)
    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: TREE.honorare.id, name: 'X' }, session)
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(state.transactions).toBe(0)
  })

  it('cannot be moved into', async () => {
    reads(TREE.ablage)
    await expect(
      updateProjectFolder({ projectId: 'proj-1', folderId: TREE.ablage.id, parentId: TREE.honorare.id }, session)
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(state.transactions).toBe(0)
  })
})
