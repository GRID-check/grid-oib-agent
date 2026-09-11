/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('./lifecycle', () => ({ forkDraftVersion: vi.fn() }))
vi.mock('./version-repository', () => ({ findOpenVersion: vi.fn(), listDocumentVersions: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentVersion } from '@/lib/db/schema'
import { makeDocument } from '@/test-utils/db-fixtures'
import { getAccessibleDocument } from './access'
import { forkDraftVersion } from './lifecycle'
import { openDraftForRevision } from './revision'
import { findOpenVersion, listDocumentVersions } from './version-repository'

const session = { userId: 'user_author', organizationId: 'org_1' } as AuthorizedSession

const version = (overrides: Partial<DocumentVersion> = {}) =>
  ({
    id: 'ver-1',
    versionNumber: 1,
    state: 'changes_requested',
    reviewedBy: 'user_reviewer',
    contentHash: 'sha256:abc',
    ...overrides,
  }) as DocumentVersion

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAccessibleDocument).mockResolvedValue(
    makeDocument({ id: 'doc-1', projectId: 'proj-1', displayName: 'Befund Fluchtweg' }),
  )
  vi.mocked(listDocumentVersions).mockResolvedValue([])
})

describe('openDraftForRevision', () => {
  it('writes into the version that was sent back, rather than forking a second', async () => {
    // One open version per document is the DATABASE's rule (migration 0082), so
    // a refused version IS the open one.
    vi.mocked(findOpenVersion).mockResolvedValue(version())

    const draft = await openDraftForRevision(session, 'doc-1')

    expect(draft.version.id).toBe('ver-1')
    expect(forkDraftVersion).not.toHaveBeenCalled()
  })

  it('forks from the published bytes when nothing is open', async () => {
    // The reviewer rejected the draft outright, or somebody has since published
    // over it.
    vi.mocked(findOpenVersion).mockResolvedValue(null)
    vi.mocked(forkDraftVersion).mockResolvedValue(version({ id: 'ver-9', state: 'draft' }))

    const draft = await openDraftForRevision(session, 'doc-1')

    expect(forkDraftVersion).toHaveBeenCalledWith(session, 'doc-1')
    expect(draft.version.id).toBe('ver-9')
  })

  it('brings back whoever most recently refused a version, to be asked again', async () => {
    vi.mocked(findOpenVersion).mockResolvedValue(version())
    vi.mocked(listDocumentVersions).mockResolvedValue([
      version({ id: 'ver-0', versionNumber: 1, state: 'superseded', reviewedBy: 'user_old' }),
      version({ id: 'ver-1', versionNumber: 2, state: 'changes_requested', reviewedBy: 'user_reviewer' }),
    ])

    const draft = await openDraftForRevision(session, 'doc-1')
    expect(draft.reviewers).toEqual(['user_reviewer'])
  })

  it('names nobody when no version was ever refused, so the assignees are asked', async () => {
    vi.mocked(findOpenVersion).mockResolvedValue(version({ state: 'draft', reviewedBy: null }))
    vi.mocked(listDocumentVersions).mockResolvedValue([version({ state: 'draft', reviewedBy: null })])

    const draft = await openDraftForRevision(session, 'doc-1')
    // The lifecycle falls back to `resource_assignments` exactly as it does for
    // a person's own submit.
    expect(draft.reviewers).toEqual([])
  })

  it('hands back an `in_review` version rather than forcing it', async () => {
    // A version somebody is looking at right now must not be rewritten under
    // them; `replaceVersionContent` refuses it with a 409, which says "a person
    // has it" instead of quietly producing a second draft.
    vi.mocked(findOpenVersion).mockResolvedValue(version({ state: 'in_review' }))

    const draft = await openDraftForRevision(session, 'doc-1')
    expect(draft.version.state).toBe('in_review')
    expect(forkDraftVersion).not.toHaveBeenCalled()
  })

  it('reports the document by the name a reader sees', async () => {
    vi.mocked(findOpenVersion).mockResolvedValue(version())
    expect((await openDraftForRevision(session, 'doc-1')).filename).toBe('Befund Fluchtweg')
  })
})
