import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/authz/folder-access', () => ({ isFolderVisibleTo: vi.fn(), requireFolderWrite: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/authz/organizations', () => ({ canManageArchiv: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isFolderVisibleTo, requireFolderWrite } from '@/lib/authz/folder-access'
import { folderReadOnlyError } from '@/lib/authz/folder-access-rule'
import { makeDocument } from '@/test-utils/db-fixtures'
import { getAccessibleDocument } from './access'
import { findDocumentInOrg } from './repository'

const session = { organizationId: 'org-1', userId: 'u-1' } as AuthorizedSession

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getAccessibleDocument and restricted folders (ADR-0084)', () => {
  it('does not find a project document filed under a folder the session is not cleared for', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'd', scope: 'project', projectId: 'p', folderId: 'f-hidden' })
    )
    vi.mocked(isFolderVisibleTo).mockResolvedValue(false)

    await expect(getAccessibleDocument(session, 'd')).rejects.toBeInstanceOf(NotFoundError)
    expect(isFolderVisibleTo).toHaveBeenCalledWith(session, 'p', 'f-hidden')
  })

  it('returns it to a session that may see the folder', async () => {
    const doc = makeDocument({ id: 'd', scope: 'project', projectId: 'p', folderId: 'f-open' })
    vi.mocked(findDocumentInOrg).mockResolvedValue(doc)
    vi.mocked(isFolderVisibleTo).mockResolvedValue(true)

    await expect(getAccessibleDocument(session, 'd')).resolves.toBe(doc)
  })
})

describe('getAccessibleDocument and read-only folders (ADR-0085)', () => {
  const doc = makeDocument({ id: 'd', scope: 'project', projectId: 'p', folderId: 'f-vertraege' })

  beforeEach(() => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(doc)
    vi.mocked(isFolderVisibleTo).mockResolvedValue(true)
  })

  it('reads a document in a folder the session may only read, without asking for a write', async () => {
    await expect(getAccessibleDocument(session, 'd')).resolves.toBe(doc)
    expect(requireFolderWrite).not.toHaveBeenCalled()
  })

  it('refuses every change to it: the write intent asks for a write in its folder', async () => {
    vi.mocked(requireFolderWrite).mockRejectedValueOnce(folderReadOnlyError())

    await expect(getAccessibleDocument(session, 'd', 'write')).rejects.toMatchObject({
      status: 403,
      details: { reason: 'folder-read-only' },
    })
    expect(requireFolderWrite).toHaveBeenCalledWith(session, 'p', ['f-vertraege'])
  })
})
