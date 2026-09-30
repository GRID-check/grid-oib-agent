/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/projects/folder-service', () => ({
  createProjectFolder: vi.fn(),
  getOrCreateProjectFolderByName: vi.fn(),
  listProjectFolders: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  createProjectFolder,
  getOrCreateProjectFolderByName,
  listProjectFolders,
  type FolderRow,
} from '@/lib/projects/folder-service'
import { createMailFolder, firstFreeFolderName } from './filing-folder'

const session = { userId: 'user-anna', organizationId: 'org_A' } as unknown as AuthorizedSession
const folder = (id: string, name: string, parentId: string | null = 'root'): FolderRow => ({
  id,
  projectId: 'project-a',
  parentId,
  name,
  path: parentId ? `E-Mail-Eingang/${name}` : name,
  createdAt: new Date(),
  updatedAt: new Date(),
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' })
  vi.mocked(getOrCreateProjectFolderByName).mockResolvedValue(folder('root', 'E-Mail-Eingang', null))
  vi.mocked(listProjectFolders).mockResolvedValue([])
  vi.mocked(createProjectFolder).mockImplementation(async (input) => ({ ok: true, folder: folder('new', input.name) }))
})

describe('firstFreeFolderName', () => {
  it('numbers from (2), linearly, skipping what is taken', () => {
    expect(firstFreeFolderName('A', new Set())).toBe('A')
    expect(firstFreeFolderName('A', new Set(['A']))).toBe('A (2)')
    expect(firstFreeFolderName('A', new Set(['A', 'A (2)', 'A (3)']))).toBe('A (4)')
  })
})

describe('createMailFolder', () => {
  const leaf = '2026-09-30 10.15 – Anna Berger'

  it('creates the leaf under E-Mail-Eingang after authorizing the sender', async () => {
    expect(await createMailFolder(session, 'project-a', leaf)).toBe('new')
    expect(requireProjectAccess).toHaveBeenCalledWith(
      session,
      'project-a',
      ['project:documents:write', 'project:edit'],
      { onError: 'throw' }
    )
    expect(getOrCreateProjectFolderByName).toHaveBeenCalledWith('project-a', 'E-Mail-Eingang')
    expect(createProjectFolder).toHaveBeenCalledWith({ projectId: 'project-a', parentId: 'root', name: leaf }, session)
  })

  it('adds (2) when another mail holds the name, ignoring same-named folders elsewhere', async () => {
    vi.mocked(listProjectFolders).mockResolvedValue([folder('x', leaf), folder('y', `${leaf} (2)`, 'elsewhere')])
    await createMailFolder(session, 'project-a', leaf)
    expect(vi.mocked(createProjectFolder).mock.calls[0][0].name).toBe(`${leaf} (2)`)
  })

  it('reads again after losing a race for the name', async () => {
    vi.mocked(createProjectFolder)
      .mockResolvedValueOnce({ ok: false, error: 'A folder with this name already exists here.' })
      .mockImplementationOnce(async (input) => ({ ok: true, folder: folder('second', input.name) }))
    vi.mocked(listProjectFolders).mockResolvedValueOnce([]).mockResolvedValueOnce([folder('racer', leaf)])
    expect(await createMailFolder(session, 'project-a', leaf)).toBe('second')
    expect(vi.mocked(createProjectFolder).mock.calls[1][0].name).toBe(`${leaf} (2)`)
  })

  it('throws without the name in the message when it cannot create one', async () => {
    vi.mocked(createProjectFolder).mockResolvedValue({ ok: false, error: 'Folder name is reserved.' })
    await expect(createMailFolder(session, 'project-a', leaf)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('Anna') })
    )
  })

  it('lets a refusal through, so the drain retries it', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    await expect(createMailFolder(session, 'project-a', leaf)).rejects.toBeInstanceOf(NotFoundError)
    expect(createProjectFolder).not.toHaveBeenCalled()
  })
})
