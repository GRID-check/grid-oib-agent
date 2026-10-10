/**
 * @vitest-environment node
 *
 * The folder core on the ARCHIV shelf, beside the project shelf's own suites
 * (`projects/folder-service*.spec.ts`).
 *
 * The claim (ADR-0078) is that a shelf is a parameter: the same code files,
 * renames, moves and deletes folders on both, and what the Archiv adds is only
 * who may (`org:archiv:manage`), where its collection is, and that a folder row
 * carries its tenant and shelf. The database's half of that — a parent and a
 * document held on their own shelf and tenant — is
 * `tenant-isolation.integration.spec.ts`; this suite pins the service's half
 * against a doubled handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/db/schema', () => ({
  projectFolders: {
    id: 'f.id',
    organizationId: 'f.organization_id',
    scope: 'f.scope',
    projectId: 'f.project_id',
    parentId: 'f.parent_id',
    name: 'f.name',
    path: 'f.path',
  },
  documents: {
    id: 'd.id',
    organizationId: 'd.organization_id',
    scope: 'd.scope',
    projectId: 'd.project_id',
    folderId: 'd.folder_id',
  },
}))
vi.mock('@/lib/authz/organizations', () => ({ canManageArchiv: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: vi.fn().mockReturnValue('http://backend:8000') }))

import { getDb } from '@/lib/db'
import { canManageArchiv } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import { ForbiddenError } from '@/lib/api/errors'
import { asDb } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ARCHIV_SHELF, projectShelf } from './shelf'
import {
  createShelfFolder,
  deleteShelfFolder,
  ensureShelfFolderPaths,
  getOrCreateShelfRootFolder,
  listShelfFolders,
  updateShelfFolder,
} from './shelf-folders'

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession
const NOW = new Date('2026-10-01T00:00:00Z')

const folder = (id: string, name: string, path: string, parentId: string | null = null) => ({
  id,
  organizationId: 'org-1',
  scope: 'archiv' as const,
  projectId: null,
  parentId,
  name,
  path,
  createdAt: NOW,
  updatedAt: NOW,
})

/** A drizzle handle that answers `select`s in order and records every write. */
function fakeDb(selects: Array<Array<ReturnType<typeof folder>>>) {
  const writes = {
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    deleted: 0,
  }
  const answer = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), {
      limit: () => Promise.resolve(rows),
      orderBy: () => Promise.resolve(rows),
    })
  const db = {
    select: () => ({ from: () => ({ where: () => answer(selects.shift() ?? []) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        writes.inserted.push(values)
        return { returning: async () => [{ ...folder('new-1', String(values.name), String(values.path)), ...values }] }
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.updated.push(values)
        return {
          where: () =>
            Object.assign(Promise.resolve(), {
              returning: async () => [{ ...folder('f-1', 'Neu', 'Neu'), ...values }],
            }),
        }
      },
    }),
    delete: () => ({
      where: async () => {
        writes.deleted += 1
      },
    }),
    transaction: async (run: (tx: unknown) => unknown) => run(db),
  }
  return { db, writes }
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchSpy)
  vi.mocked(canManageArchiv).mockReturnValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('who may touch the Archiv shelf', () => {
  it('lets any member read the tree, and checks nothing for it', async () => {
    vi.mocked(canManageArchiv).mockReturnValue(false)
    vi.mocked(getDb).mockReturnValue(asDb(fakeDb([[folder('f-1', 'Normen', 'Normen')]]).db))

    const folders = await listShelfFolders(session, ARCHIV_SHELF)

    expect(folders.map((row) => row.path)).toEqual(['Normen'])
    expect(folders[0].projectId).toBeNull()
    expect(canManageArchiv).not.toHaveBeenCalled()
  })

  it.each([
    ['create', () => createShelfFolder(session, ARCHIV_SHELF, { name: 'Normen' })],
    ['update', () => updateShelfFolder(session, ARCHIV_SHELF, { folderId: 'f-1', name: 'Neu' })],
    ['delete', () => deleteShelfFolder(session, ARCHIV_SHELF, 'f-1')],
    ['ensure', () => ensureShelfFolderPaths(session, ARCHIV_SHELF, { parentId: null, paths: ['A/B'] })],
  ])('refuses %s to a member without org:archiv:manage, before touching the database', async (_name, run) => {
    vi.mocked(canManageArchiv).mockReturnValue(false)

    await expect(run()).rejects.toBeInstanceOf(ForbiddenError)

    expect(getDb).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('asks the project permission, not the Archiv one, on a project shelf', async () => {
    vi.mocked(getDb).mockReturnValue(asDb(fakeDb([]).db))

    await createShelfFolder(session, projectShelf('proj-1'), { name: 'Plaene' })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', [
      'project:documents:write',
      'project:edit',
    ])
    expect(canManageArchiv).not.toHaveBeenCalled()
  })
})

describe('a folder row on the Archiv shelf', () => {
  it('is inserted with its tenant and shelf and no project', async () => {
    const fake = fakeDb([])
    vi.mocked(getDb).mockReturnValue(asDb(fake.db))

    const result = await createShelfFolder(session, ARCHIV_SHELF, { name: 'Normen' })

    expect(result.ok).toBe(true)
    expect(fake.writes.inserted).toEqual([
      { organizationId: 'org-1', scope: 'archiv', projectId: null, parentId: null, name: 'Normen', path: 'Normen' },
    ])
  })

  it('says a taken name is a message, not a 500', async () => {
    const fake = fakeDb([])
    fake.db.insert = () => ({
      values: () => ({
        returning: async () => {
          throw Object.assign(new Error('duplicate key'), { code: '23505' })
        },
      }),
    })
    vi.mocked(getDb).mockReturnValue(asDb(fake.db))

    await expect(createShelfFolder(session, ARCHIV_SHELF, { name: 'Normen' })).resolves.toEqual({
      ok: false,
      error: 'A folder with this name already exists here.',
    })
  })

  it('refuses a parent that is not on the shelf', async () => {
    vi.mocked(getDb).mockReturnValue(asDb(fakeDb([[]]).db))

    await expect(
      createShelfFolder(session, ARCHIV_SHELF, { name: 'EN', parentId: 'f-elsewhere' }),
    ).resolves.toEqual({ ok: false, error: 'Parent folder not found.' })
  })

  it('get-or-create files the fixed destination at the Archiv root', async () => {
    const fake = fakeDb([[]])
    vi.mocked(getDb).mockReturnValue(asDb(fake.db))

    const created = await getOrCreateShelfRootFolder(ARCHIV_SHELF, 'org-1', 'Berichte')

    expect(created.path).toBe('Berichte')
    expect(fake.writes.inserted[0]).toMatchObject({ scope: 'archiv', projectId: null, organizationId: 'org-1' })
  })
})

describe('moving and renaming an Archiv folder', () => {
  it('rewrites the subtree and mirrors the path onto the ARCHIV collection', async () => {
    const fake = fakeDb([[folder('f-1', 'Normen', 'Normen')]])
    vi.mocked(getDb).mockReturnValue(asDb(fake.db))

    const result = await updateShelfFolder(session, ARCHIV_SHELF, { folderId: 'f-1', name: 'Neu' })

    expect(result.ok).toBe(true)
    expect(fetchSpy.mock.calls[0][0]).toBe('http://backend:8000/v1/collections/archiv_org-1/folder-paths')
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toEqual({
      from_path: 'Normen',
      to_path: 'Neu',
    })
  })

  it('refuses to move a folder into its own subfolder', async () => {
    vi.mocked(getDb).mockReturnValue(
      asDb(
        fakeDb([
          [folder('f-1', 'Normen', 'Normen')],
          [folder('f-2', 'EN', 'Normen/EN', 'f-1')],
        ]).db,
      ),
    )

    await expect(
      updateShelfFolder(session, ARCHIV_SHELF, { folderId: 'f-1', parentId: 'f-2' }),
    ).resolves.toEqual({ ok: false, error: 'A folder cannot be moved into its own subfolder.' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not find a folder of another shelf or tenant', async () => {
    vi.mocked(getDb).mockReturnValue(asDb(fakeDb([[]]).db))

    await expect(
      updateShelfFolder(session, ARCHIV_SHELF, { folderId: 'f-other', name: 'x' }),
    ).resolves.toEqual({ ok: false, error: 'Folder not found.' })
  })
})

describe('deleting an Archiv folder', () => {
  it('re-files its documents and children into the parent, then mirrors the collapse', async () => {
    const fake = fakeDb([
      [folder('f-2', 'EN', 'Normen/EN', 'f-1')], // the folder
      [folder('f-1', 'Normen', 'Normen')], // its parent
      [folder('f-3', 'Alt', 'Normen/EN/Alt', 'f-2')], // its child
    ])
    vi.mocked(getDb).mockReturnValue(asDb(fake.db))

    const result = await deleteShelfFolder(session, ARCHIV_SHELF, 'f-2')

    expect(result.ok && result.result).toEqual({ documentsMoved: 1, foldersMoved: 1 })
    // The row goes: the Archiv has no Papierkorb and no tombstone (ADR-0088),
    // only a project folder's delete keeps one, and that is not this function.
    expect(fake.writes.deleted).toBe(1)
    expect(fake.writes.updated).not.toContainEqual(expect.objectContaining({ deletedAt: expect.anything() }))
    // The child moves up a level, carrying its path with it.
    expect(fake.writes.updated).toContainEqual(
      expect.objectContaining({ parentId: 'f-1', path: 'Normen/Alt' }),
    )
    expect(fetchSpy.mock.calls[0][0]).toBe('http://backend:8000/v1/collections/archiv_org-1/folder-paths')
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toEqual({
      from_path: 'Normen/EN',
      to_path: 'Normen',
    })
  })
})
