/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/db/schema', () => ({
  projectFolders: { projectId: 'project_id', parentId: 'parent_id', name: 'name' },
  // `documents` and `projects` are reached transitively — this module re-parents
  // documents when a folder goes, and `@/lib/projects/repository` reads projects.
  // A mock that names only the table the spec asserts on leaves the others
  // undefined at import time, which fails as a module error rather than as an
  // assertion.
  documents: { folderId: 'folder_id', projectId: 'project_id', id: 'id' },
  projects: { id: 'id', organizationId: 'organization_id', deletedAt: 'deleted_at' },
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { asDb } from '@/test-utils/db-fixtures'
import { validateFolderName, buildFolderPath } from './folders'
import { getOrCreateProjectFolderByName } from './folder-service'

describe('folder service validation', () => {
  it('validates and builds folder paths correctly', () => {
    expect(validateFolderName('Plans').ok).toBe(true)
    expect(validateFolderName('')).toEqual({ ok: false, error: 'Folder name is required.' })
    expect(validateFolderName('..')).toEqual({ ok: false, error: 'Folder name cannot be . or ...' })
    expect(validateFolderName('CON')).toEqual({ ok: false, error: 'Folder name is reserved.' })
  })

  it('builds nested folder paths', () => {
    expect(buildFolderPath('Plans', 'Fire Safety')).toBe('Plans/Fire Safety')
    expect(buildFolderPath('', 'Root')).toBe('Root')
    expect(buildFolderPath(null, 'Root')).toBe('Root')
  })
})

const row = (id: string) => ({
  id,
  projectId: 'proj-1',
  parentId: null,
  name: 'Berichte',
  path: 'Berichte',
  createdAt: new Date('2026-08-20T00:00:00Z'),
  updatedAt: new Date('2026-08-20T00:00:00Z'),
})

/**
 * Get-or-create is two statements, and migration 0063's
 * `uniq_project_folders_parent_name` is what turns the loser of a race into a
 * 23505 instead of into a second `Berichte` folder nobody can tell from the
 * first. The index is what makes the recovery correct; these tests are about
 * the recovery being graceful — a concurrent run must not 500 somebody's
 * finished report.
 */
describe('getOrCreateProjectFolderByName', () => {
  const select = vi.fn()
  const insert = vi.fn()

  const stubSelect = (...results: Array<Array<ReturnType<typeof row>>>) => {
    for (const result of results) {
      select.mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve(result) }) }),
      })
    }
  }

  const stubInsert = (behaviour: () => Promise<Array<ReturnType<typeof row>>>) => {
    insert.mockReturnValue({ values: () => ({ returning: behaviour }) })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    select.mockReset()
    insert.mockReset()
    vi.mocked(getDb).mockReturnValue(asDb({ select, insert }))
  })

  it('returns the folder that already exists without inserting', async () => {
    stubSelect([row('folder-1')])

    const folder = await getOrCreateProjectFolderByName('proj-1', 'Berichte')

    expect(folder.id).toBe('folder-1')
    expect(insert).not.toHaveBeenCalled()
  })

  it('creates the folder at the project root on first use', async () => {
    stubSelect([])
    stubInsert(async () => [row('folder-new')])

    const folder = await getOrCreateProjectFolderByName('proj-1', 'Berichte')

    expect(folder).toEqual(row('folder-new'))
  })

  it('recovers the concurrent writer’s folder from a unique violation', async () => {
    // First select finds nothing, the insert loses the race, the second select
    // finds the winner. Nothing about this is visible to the caller.
    stubSelect([], [row('folder-winner')])
    stubInsert(async () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' })
    })

    const folder = await getOrCreateProjectFolderByName('proj-1', 'Berichte')

    expect(folder.id).toBe('folder-winner')
  })

  it('re-throws an insert failure that is not a unique violation', async () => {
    stubSelect([])
    stubInsert(async () => {
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
    })

    await expect(getOrCreateProjectFolderByName('proj-1', 'Berichte')).rejects.toThrow(
      'deadlock detected',
    )
    // One lookup: a non-race failure must not be answered by pretending to look
    // for a winner that was never created.
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('re-throws the unique violation when the re-select still finds nothing', async () => {
    // Cannot happen against the real index, and swallowing it would return
    // `undefined` as a folder — so it stays an error rather than a guess.
    stubSelect([], [])
    stubInsert(async () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' })
    })

    await expect(getOrCreateProjectFolderByName('proj-1', 'Berichte')).rejects.toThrow(
      'duplicate key',
    )
  })
})
