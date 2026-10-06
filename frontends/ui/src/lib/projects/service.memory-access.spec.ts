/**
 * @vitest-environment node
 *
 * The Project Memory panel's service (ADR-0078, ADR-0079): a restricted note is
 * listed, edited and deleted only by a session that may read all of its source
 * folders now, and such a reader is told which folders it came from. For anyone else it
 * is absent — the listing never asks for it, and an edit or delete by id
 * answers like a missing item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => undefined) }))

vi.mock('./repository', () => ({
  findProjectCollectionName: vi.fn(async () => 'proj_x'),
  findProjectInOrg: vi.fn(),
  insertProject: vi.fn(),
  listProjectsInOrg: vi.fn(),
  renameProjectInOrg: vi.fn(),
  restoreProjectIfPending: vi.fn(),
  setProjectWorkosResourceId: vi.fn(),
  softDeleteProjectAndEnqueue: vi.fn(),
  deleteProjectRow: vi.fn(),
}))

vi.mock('@/lib/authz/folder-access', () => ({
  clearanceOf: vi.fn(() => ({ roles: ['member'], seesEverything: false })),
  customFolderNames: vi.fn(),
  getHiddenFolderIds: vi.fn(async () => []),
  readableFolderIdsFor: vi.fn(),
}))

vi.mock('./memory-service', () => ({
  createProjectMemoryItem: vi.fn(),
  deleteProjectMemoryItem: vi.fn(async () => true),
  listProjectMemory: vi.fn(),
  updateProjectMemoryItem: vi.fn(async () => ({ id: 'item-1' })),
}))

import { customFolderNames, readableFolderIdsFor } from '@/lib/authz/folder-access'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { makeMemoryItem } from '@/test-utils/db-fixtures'
import { deleteProjectMemoryItem, listProjectMemory, updateProjectMemoryItem } from './memory-service'
import { editProjectMemoryItem, getProjectMemory, removeProjectMemoryItem } from './service'

/** The source folder of a restricted note (ADR-0079). */
const CONTRACTS = 'aaaaaaaa-0000-4000-8000-000000000001'

const SESSION: AuthorizedSession = {
  userId: 'user_1',
  email: 'someone@grid.com',
  name: 'Someone',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getProjectMemory', () => {
  it('lists with the session\'s clearance and names the folders of a restricted note', async () => {
    vi.mocked(readableFolderIdsFor).mockResolvedValue([CONTRACTS])
    vi.mocked(customFolderNames).mockResolvedValue(new Map([[CONTRACTS, 'Verträge']]))
    vi.mocked(listProjectMemory).mockResolvedValue([
      makeMemoryItem({ id: 'open' }),
      makeMemoryItem({ id: 'restricted', restrictedFolderIds: [CONTRACTS] }),
    ])

    const items = await getProjectMemory(SESSION, 'proj-1')

    expect(readableFolderIdsFor).toHaveBeenCalledWith('org_1', 'proj-1', { roles: ['member'], seesEverything: false })
    expect(listProjectMemory).toHaveBeenCalledWith('proj-1', {
      organizationId: 'org_1',
      readableFolderIds: [CONTRACTS],
    })
    expect(items.find((item) => item.id === 'restricted')?.restrictedFolderNames).toEqual(['Verträge'])
    expect(items.find((item) => item.id === 'open')).not.toHaveProperty('restrictedFolderNames')
  })

  it('lists open memory only for an uncleared session, and asks for no folder names', async () => {
    vi.mocked(readableFolderIdsFor).mockResolvedValue([])
    vi.mocked(listProjectMemory).mockResolvedValue([makeMemoryItem({ id: 'open' })])

    await getProjectMemory(SESSION, 'proj-1', { sourceConversationId: 'c1' })

    expect(listProjectMemory).toHaveBeenCalledWith('proj-1', {
      organizationId: 'org_1',
      sourceConversationId: 'c1',
      readableFolderIds: [],
    })
    expect(customFolderNames).not.toHaveBeenCalled()
  })
})

describe('editing and deleting', () => {
  it('reaches only the notes the session may see', async () => {
    vi.mocked(readableFolderIdsFor).mockResolvedValue([])

    await editProjectMemoryItem(SESSION, 'proj-1', 'item-1', { pinned: true })
    await removeProjectMemoryItem(SESSION, 'proj-1', 'item-1')

    const owner = { projectId: 'proj-1', organizationId: 'org_1', readableFolderIds: [] }
    expect(updateProjectMemoryItem).toHaveBeenCalledWith(owner, 'item-1', { pinned: true })
    expect(deleteProjectMemoryItem).toHaveBeenCalledWith(owner, 'item-1')
  })

  it('answers a hidden note like a missing one', async () => {
    vi.mocked(readableFolderIdsFor).mockResolvedValue([])
    vi.mocked(updateProjectMemoryItem).mockResolvedValueOnce(null)
    vi.mocked(deleteProjectMemoryItem).mockResolvedValueOnce(false)

    await expect(editProjectMemoryItem(SESSION, 'proj-1', 'hidden', { pinned: true })).rejects.toBeInstanceOf(
      NotFoundError
    )
    await expect(removeProjectMemoryItem(SESSION, 'proj-1', 'hidden')).rejects.toBeInstanceOf(NotFoundError)
  })
})
