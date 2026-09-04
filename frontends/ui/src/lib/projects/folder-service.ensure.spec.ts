/**
 * @vitest-environment node
 *
 * `ensureProjectFolderPaths` — the one write a folder upload makes before any
 * bytes move.
 *
 * What it has to get right is MATCHING. A tree dragged off an office server
 * overlaps the project most of the time, and a resolver that only matched
 * exactly would create a second „Pläne" beside the one already there and file
 * half the Einreichung into it — invisibly, because the two render identically.
 * macOS is what makes that concrete: it hands over decomposed umlauts, so the
 * folder from the desktop and the folder typed into Piloti are different
 * strings for the same name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/db/schema', () => ({
  projectFolders: { id: 'id', projectId: 'project_id', parentId: 'parent_id', name: 'name' },
  documents: { folderId: 'folder_id', projectId: 'project_id', id: 'id' },
  projects: { id: 'id', organizationId: 'organization_id', deletedAt: 'deleted_at' },
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { requireProjectAccess } from '@/lib/authz/projects'
import { asDb } from '@/test-utils/db-fixtures'
import { ensureProjectFolderPaths } from './folder-service'
import type { AuthorizedSession } from '@/lib/auth/types'

const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession

interface Row {
  id: string
  projectId: string
  parentId: string | null
  name: string
  path: string
  createdAt: Date
  updatedAt: Date
}

const at = new Date('2026-09-01T00:00:00Z')
const row = (id: string, name: string, path: string, parentId: string | null = null): Row => ({
  id,
  projectId: 'proj-1',
  parentId,
  name,
  path,
  createdAt: at,
  updatedAt: at,
})

/**
 * A database that answers the two shapes this function uses: one unfiltered
 * read of the project's folders, and an insert that mints a row.
 *
 * `where(...).limit(...)` is the parent probe and the 23505 recovery; the bare
 * `where(...)` is the folder listing. Both are driven from one array so an
 * insert is visible to a later read, which is what makes the ordering of a
 * multi-level path testable at all.
 */
function fakeDb(existing: Row[], onInsert?: () => never) {
  const rows = [...existing]
  let minted = 0
  const inserted: Array<{ name: string; parentId: string | null; path: string }> = []

  const select = vi.fn(() => ({
    from: () => {
      const where = (): Promise<Row[]> & { limit: () => Promise<Row[]> } => {
        // The parent probe and the race recovery both `.limit(1)`; the listing
        // awaits the `where` itself.
        const promise = Promise.resolve(rows) as Promise<Row[]> & { limit: () => Promise<Row[]> }
        promise.limit = () => Promise.resolve(rows.slice(0, 1))
        return promise
      }
      return { where }
    },
  }))

  const insert = vi.fn(() => ({
    values: (values: { name: string; parentId: string | null; path: string }) => ({
      returning: async () => {
        if (onInsert) onInsert()
        minted += 1
        const created = row(`new-${minted}`, values.name, values.path, values.parentId)
        rows.push(created)
        inserted.push(values)
        return [created]
      },
    }),
  }))

  return { db: asDb({ select, insert }), inserted, insert }
}

describe('ensureProjectFolderPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' } as never)
  })

  it('reuses a folder whose name differs only in case or Unicode form', async () => {
    // `PLÄNE` is here; the drop carries the decomposed spelling a Mac produces.
    const existing = [row('f1', 'PLÄNE', 'PLÄNE')]
    const fake = fakeDb(existing)
    vi.mocked(getDb).mockReturnValue(fake.db)

    const result = await ensureProjectFolderPaths(
      { projectId: 'proj-1', parentId: null, paths: ['Pläne'.normalize('NFD')] },
      session,
    )

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('unreachable')
    expect(result.folderIdByPath).toEqual({ ['Pläne'.normalize('NFD')]: 'f1' })
    // Creating the near-duplicate is the failure this exists to prevent.
    expect(fake.insert).not.toHaveBeenCalled()
    expect(result.folders).toEqual([])
  })

  it('creates a nested path top-down, each level under the one above it', async () => {
    const fake = fakeDb([])
    vi.mocked(getDb).mockReturnValue(fake.db)

    const result = await ensureProjectFolderPaths(
      { projectId: 'proj-1', parentId: null, paths: ['Wohnbau/03_Einreichung'] },
      session,
    )

    expect(result.ok).toBe(true)
    expect(fake.inserted).toEqual([
      { projectId: 'proj-1', parentId: null, name: 'Wohnbau', path: 'Wohnbau' },
      {
        projectId: 'proj-1',
        parentId: 'new-1',
        name: '03_Einreichung',
        path: 'Wohnbau/03_Einreichung',
      },
    ])
  })

  it('creates a shared ancestor once across several paths', async () => {
    const fake = fakeDb([])
    vi.mocked(getDb).mockReturnValue(fake.db)

    await ensureProjectFolderPaths(
      { projectId: 'proj-1', parentId: null, paths: ['W/Plaene', 'W/Statik'] },
      session,
    )

    // Three folders, not four: the index built as it goes is what stops `W`
    // being created a second time for the second path.
    expect(fake.inserted.map((values) => values.path)).toEqual(['W', 'W/Plaene', 'W/Statik'])
  })

  it('refuses a path deeper than the dropped-tree walk will ever produce', async () => {
    const fake = fakeDb([])
    vi.mocked(getDb).mockReturnValue(fake.db)

    const result = await ensureProjectFolderPaths(
      { projectId: 'proj-1', parentId: null, paths: [Array.from({ length: 13 }, (_, i) => `d${i}`).join('/')] },
      session,
    )

    expect(result).toEqual({ ok: false, error: 'A folder path may be at most 12 levels deep.' })
  })

  it('refuses more paths than a folder upload can honestly need', async () => {
    const fake = fakeDb([])
    vi.mocked(getDb).mockReturnValue(fake.db)

    const result = await ensureProjectFolderPaths(
      { projectId: 'proj-1', parentId: null, paths: Array.from({ length: 301 }, (_, i) => `d${i}`) },
      session,
    )

    expect(result.ok).toBe(false)
    expect(fake.insert).not.toHaveBeenCalled()
  })

  it('files into the concurrent writer’s folder when the insert loses the race', async () => {
    // Two people syncing the same tree at once: both read no `Wohnbau`, both
    // insert, and `uniq_project_folders_parent_name` fails one of them. The
    // loser must not fail an upload nobody did anything wrong in.
    const winner = row('f-winner', 'Wohnbau', 'Wohnbau')
    const fake = fakeDb([winner], () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' })
    })
    vi.mocked(getDb).mockReturnValue(fake.db)

    // `Statik` is not in the listing, so this path reaches the insert — which
    // is where the fake raises the violation. What is under test is the answer
    // to it: re-read, and file into whatever is there, rather than fail.
    const result = await ensureProjectFolderPaths(
      { projectId: 'proj-1', parentId: null, paths: ['Statik'] },
      session,
    )

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('unreachable')
    expect(result.folderIdByPath).toEqual({ Statik: 'f-winner' })
  })

  it('re-throws an insert failure that is not a race', async () => {
    const fake = fakeDb([], () => {
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
    })
    vi.mocked(getDb).mockReturnValue(fake.db)

    await expect(
      ensureProjectFolderPaths({ projectId: 'proj-1', parentId: null, paths: ['W'] }, session),
    ).rejects.toThrow('deadlock detected')
  })
})
