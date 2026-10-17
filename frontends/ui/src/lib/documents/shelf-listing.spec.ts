/**
 * @vitest-environment node
 */
/**
 * What a listing row carries about the document's Anmerkungen
 * (`toListedDocuments`): the live marks counted for the rows the reader may
 * see, in one query for the whole page, with the reader the rows were read
 * with and the reader's own id for „für Sie". The SQL itself (the grouping,
 * the statuses, the visibility predicate) is `annotations/repository.integration.spec.ts`'s.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn(async (rows: unknown[]) => rows) }))
vi.mock('./fassung-facts', () => ({ loadFassungFacts: vi.fn(async () => new Map()) }))
vi.mock('@/lib/annotations/repository', () => ({ tallyLiveMarks: vi.fn(async () => new Map()) }))
vi.mock('@/lib/assignments/service', () => ({ listAssignmentsWithoutAccessCheck: vi.fn(async () => ({})) }))
vi.mock('@/lib/authz/feature-flags', () => ({ isCollaborationEnabled: vi.fn(() => false) }))

import { tallyLiveMarks } from '@/lib/annotations/repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { memberReader } from './document-reader'
import type { DocumentListRow } from './repository'
import { toListedDocuments } from './shelf-listing'

const session = { userId: 'user-anna', organizationId: 'org-1' } as AuthorizedSession

const row = (id: string): DocumentListRow =>
  ({
    id,
    projectId: 'proj-1',
    scope: 'project',
    filename: `${id}.pdf`,
    displayName: null,
    lifecycle: 'active',
    publishedVersionId: null,
    originPath: null,
    contentHash: null,
    createdBy: 'user-bernd',
    screeningOutcome: 'clean',
    screenedHash: null,
    fileSize: 1024,
    contentType: 'application/pdf',
    status: 'completed',
    authoredBy: 'user',
    collectionName: 'proj_abc',
    folderId: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    errorMessage: null,
    metadata: null,
  }) as DocumentListRow

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toListedDocuments: the open Anmerkungen on each row', () => {
  it('counts the whole page in one call, for the reader the rows were read with', async () => {
    const reader = memberReader('user-anna')
    vi.mocked(tallyLiveMarks).mockResolvedValueOnce(new Map([['doc-1', { live: 3, forYou: 1 }]]))

    const listed = await toListedDocuments(session, [row('doc-1'), row('doc-2')], reader)

    expect(tallyLiveMarks).toHaveBeenCalledTimes(1)
    expect(tallyLiveMarks).toHaveBeenCalledWith('org-1', ['doc-1', 'doc-2'], reader, 'user-anna')
    expect(listed.map((document) => [document.id, document.marks])).toEqual([
      ['doc-1', { live: 3, forYou: 1 }],
      ['doc-2', null],
    ])
  })
})
