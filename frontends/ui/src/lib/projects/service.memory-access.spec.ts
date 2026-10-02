/**
 * @vitest-environment node
 *
 * The Project Memory panel's service (ADR-0078): a restricted note is listed,
 * edited and deleted only by a session cleared for all of its collections,
 * and a cleared reader is told which folders it came from. For anyone else it
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
  getHiddenFolderIds: vi.fn(async () => []),
  getProjectFolderAccess: vi.fn(),
  restrictedFolderNamesByCollection: vi.fn(),
}))

vi.mock('./memory-service', () => ({
  createProjectMemoryItem: vi.fn(),
  deleteProjectMemoryItem: vi.fn(async () => true),
  listProjectMemory: vi.fn(),
  updateProjectMemoryItem: vi.fn(async () => ({ id: 'item-1' })),
}))

import { getProjectFolderAccess, restrictedFolderNamesByCollection } from '@/lib/authz/folder-access'
import type { ProjectFolderAccess } from '@/lib/authz/folder-access'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { makeMemoryItem } from '@/test-utils/db-fixtures'
import { deleteProjectMemoryItem, listProjectMemory, updateProjectMemoryItem } from './memory-service'
import { editProjectMemoryItem, getProjectMemory, removeProjectMemoryItem } from './service'

const CONTRACTS = 'proj_x_raaaaaaaaaaaa'

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

const access = (cleared: string[]): ProjectFolderAccess => ({
  hiddenFolderIds: new Set(),
  isVisible: () => true,
  collectionFor: () => 'proj_x',
  clearedRestrictedCollections: cleared,
  anyRestricted: cleared.length > 0,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getProjectMemory', () => {
  it('lists with the session\'s clearance and names the folders of a restricted note', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValue(access([CONTRACTS]))
    vi.mocked(restrictedFolderNamesByCollection).mockResolvedValue(new Map([[CONTRACTS, 'Verträge']]))
    vi.mocked(listProjectMemory).mockResolvedValue([
      makeMemoryItem({ id: 'open' }),
      makeMemoryItem({ id: 'restricted', restrictedCollections: [CONTRACTS] }),
    ])

    const items = await getProjectMemory(SESSION, 'proj-1')

    expect(getProjectFolderAccess).toHaveBeenCalledWith(SESSION, 'proj-1', 'proj_x')
    expect(listProjectMemory).toHaveBeenCalledWith('proj-1', {
      organizationId: 'org_1',
      clearedRestrictedCollections: [CONTRACTS],
    })
    expect(items.find((item) => item.id === 'restricted')?.restrictedFolderNames).toEqual(['Verträge'])
    expect(items.find((item) => item.id === 'open')).not.toHaveProperty('restrictedFolderNames')
  })

  it('lists open memory only for an uncleared session, and asks for no folder names', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValue(access([]))
    vi.mocked(listProjectMemory).mockResolvedValue([makeMemoryItem({ id: 'open' })])

    await getProjectMemory(SESSION, 'proj-1', { sourceConversationId: 'c1' })

    expect(listProjectMemory).toHaveBeenCalledWith('proj-1', {
      organizationId: 'org_1',
      sourceConversationId: 'c1',
      clearedRestrictedCollections: [],
    })
    expect(restrictedFolderNamesByCollection).not.toHaveBeenCalled()
  })
})

describe('editing and deleting', () => {
  it('reaches only the notes the session may see', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValue(access([]))

    await editProjectMemoryItem(SESSION, 'proj-1', 'item-1', { pinned: true })
    await removeProjectMemoryItem(SESSION, 'proj-1', 'item-1')

    const owner = { projectId: 'proj-1', clearedRestrictedCollections: [] }
    expect(updateProjectMemoryItem).toHaveBeenCalledWith(owner, 'item-1', { pinned: true })
    expect(deleteProjectMemoryItem).toHaveBeenCalledWith(owner, 'item-1')
  })

  it('answers a hidden note like a missing one', async () => {
    vi.mocked(getProjectFolderAccess).mockResolvedValue(access([]))
    vi.mocked(updateProjectMemoryItem).mockResolvedValueOnce(null)
    vi.mocked(deleteProjectMemoryItem).mockResolvedValueOnce(false)

    await expect(editProjectMemoryItem(SESSION, 'proj-1', 'hidden', { pinned: true })).rejects.toBeInstanceOf(
      NotFoundError
    )
    await expect(removeProjectMemoryItem(SESSION, 'proj-1', 'hidden')).rejects.toBeInstanceOf(NotFoundError)
  })
})
