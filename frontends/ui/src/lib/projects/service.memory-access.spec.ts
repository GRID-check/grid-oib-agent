/**
 * @vitest-environment node
 *
 * The Project Memory panel's service (ADR-0087, ADR-0088): a restricted note is
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
  clearanceOf: vi.fn(() => ({ levels: {}, seesEverything: false })),
  customFolderNames: vi.fn(),
  getHiddenFolderIds: vi.fn(async () => []),
  purgedFolderDates: vi.fn(async () => new Map()),
  readableFolderIdsFor: vi.fn(),
}))

vi.mock('./memory-service', () => ({
  createProjectMemoryItem: vi.fn(),
  deleteProjectMemoryItem: vi.fn(async () => true),
  listProjectMemory: vi.fn(),
  updateProjectMemoryItem: vi.fn(async () => ({ id: 'item-1' })),
}))

// Which evidence names a reader may see is the SQL's subject (memory-evidence.integration.spec.ts);
// here, that the panel's read asks it, as this person, with this person's clearance.
vi.mock('./memory-evidence', () => ({
  withServedEvidence: vi.fn(async (_organizationId: string, items: readonly unknown[]) => [...items]),
}))

import { customFolderNames, purgedFolderDates, readableFolderIdsFor } from '@/lib/authz/folder-access'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { makeMemoryItem } from '@/test-utils/db-fixtures'
import { withServedEvidence, type EvidenceReader } from './memory-evidence'
import { deleteProjectMemoryItem, listProjectMemory, updateProjectMemoryItem } from './memory-service'
import { editProjectMemoryItem, getProjectMemory, removeProjectMemoryItem } from './service'

/** The source folder of a restricted note (ADR-0088). */
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

    expect(readableFolderIdsFor).toHaveBeenCalledWith('org_1', 'proj-1', { levels: {}, seesEverything: false })
    expect(listProjectMemory).toHaveBeenCalledWith('proj-1', {
      organizationId: 'org_1',
      readableFolderIds: [CONTRACTS],
    })
    expect(items.find((item) => item.id === 'restricted')?.restrictedFolderNames).toEqual(['Verträge'])
    expect(items.find((item) => item.id === 'open')).not.toHaveProperty('restrictedFolderNames')
    expect(items.find((item) => item.id === 'restricted')).not.toHaveProperty('sourceDeletedAt')
  })

  it('says when the folder a note came from was purged, for „Quelle gelöscht am …" (ADR-0088)', async () => {
    vi.mocked(readableFolderIdsFor).mockResolvedValue([CONTRACTS])
    vi.mocked(customFolderNames).mockResolvedValue(new Map([[CONTRACTS, 'Verträge']]))
    vi.mocked(purgedFolderDates).mockResolvedValue(new Map([[CONTRACTS, new Date('2026-10-20T03:00:00Z')]]))
    vi.mocked(listProjectMemory).mockResolvedValue([
      makeMemoryItem({ id: 'open' }),
      makeMemoryItem({ id: 'restricted', restrictedFolderIds: [CONTRACTS] }),
    ])

    const items = await getProjectMemory(SESSION, 'proj-1')

    expect(items.find((item) => item.id === 'restricted')?.sourceDeletedAt).toBe('2026-10-20T03:00:00.000Z')
    expect(items.find((item) => item.id === 'open')).not.toHaveProperty('sourceDeletedAt')
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

describe('evidence names', () => {
  it('shows a note’s evidence only as this person may open it now, with their own reader and clearance', async () => {
    vi.mocked(readableFolderIdsFor).mockResolvedValue([CONTRACTS])
    vi.mocked(customFolderNames).mockResolvedValue(new Map())
    const grounded = makeMemoryItem({
      id: 'grounded',
      projectId: 'proj-1',
      verification: 'source_grounded',
      evidence: [
        { fileName: 'Baubeschreibung.pdf', page: '2' },
        { fileName: 'Honorare.pdf', page: '1' },
      ],
    })
    vi.mocked(listProjectMemory).mockResolvedValue([grounded])
    vi.mocked(withServedEvidence).mockImplementationOnce(async (_organizationId, items) =>
      items.map((item) => ({ ...item, evidence: (item.evidence ?? []).filter((entry) => entry.fileName !== 'Honorare.pdf') }))
    )

    const items = await getProjectMemory(SESSION, 'proj-1')

    expect(items.map((item) => [item.content, item.evidence])).toEqual([[grounded.content, [{ fileName: 'Baubeschreibung.pdf', page: '2' }]]])
    const [organizationId, , reader] = vi.mocked(withServedEvidence).mock.calls[0] as [string, unknown, EvidenceReader]
    expect(organizationId).toBe('org_1')
    expect(reader.reader).toEqual({ kind: 'member', userId: 'user_1' })
    expect(reader.clearanceIn('proj-1')).toEqual([CONTRACTS])
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
