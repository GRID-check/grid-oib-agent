/**
 * @vitest-environment node
 *
 * Placement and the cached prompt view (ADR-0085).
 *
 * The prompt view's document-roles block names no document in a folder not
 * every member may read, and it is cached for five minutes per project. Every
 * change of who reads what (a folder's list set, a folder or a document moved,
 * a folder deleted) ends in `placeProjectDocuments`, so that is where the view
 * is dropped: a view cached before the change would otherwise keep naming a
 * now-restricted document in every member's turns until its TTL ran out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: (_scope: unknown, run: () => unknown) => run() }))
vi.mock('@/lib/documents/service', () => ({ dispatchDocument: vi.fn() }))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn() }))
vi.mock('@/lib/documents/collection-file-ref', () => ({ collectionFileRef: vi.fn(), purgeIngestedChunks: vi.fn() }))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/project-profile/prompt-view', () => ({ invalidateProjectPromptViewCache: vi.fn(async () => undefined) }))

import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { invalidateProjectPromptViewCache } from '@/lib/project-profile/prompt-view'
import { findProjectInOrg } from '@/lib/projects/repository'
import { placeProjectDocuments, retryProjectPlacement } from './collection-placement'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findProjectInOrg).mockResolvedValue(null)
})

describe('placeProjectDocuments drops the cached prompt view', () => {
  it('before and after placing, for the project in its organization', async () => {
    await placeProjectDocuments('org-1', 'proj-1')

    expect(invalidateProjectPromptViewCache).toHaveBeenCalledTimes(2)
    expect(invalidateProjectPromptViewCache).toHaveBeenNthCalledWith(1, 'proj-1', 'org-1')
    expect(invalidateProjectPromptViewCache).toHaveBeenNthCalledWith(2, 'proj-1', 'org-1')
  })

  it('also when the placement itself fails', async () => {
    vi.mocked(findProjectInOrg).mockResolvedValue({ id: 'proj-1', collectionName: 'proj_1' } as never)
    vi.mocked(listProjectFolderTree).mockRejectedValue(new Error('database down'))

    await expect(placeProjectDocuments('org-1', 'proj-1')).rejects.toThrow('database down')

    expect(invalidateProjectPromptViewCache).toHaveBeenCalledTimes(2)
  })

  it('but not for the sweep, which changes nothing about who reads what', async () => {
    await retryProjectPlacement('org-1', 'proj-1')

    expect(invalidateProjectPromptViewCache).not.toHaveBeenCalled()
  })
})
