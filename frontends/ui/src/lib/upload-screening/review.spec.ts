import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ isFolderVisibleTo: vi.fn(), requireFolderWrite: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({
  findDocumentInOrg: vi.fn(),
  listQuarantinedDocuments: vi.fn(),
  markScreeningReleased: vi.fn(),
  QUARANTINE_LIST_LIMIT: 3,
}))
vi.mock('@/lib/documents/service', () => ({
  dispatchDocument: vi.fn().mockResolvedValue({ jobId: 'job-9', status: 'pending' }),
}))
vi.mock('@/lib/documents/folder-path', () => ({
  resolveDocumentFolderPath: vi.fn().mockResolvedValue('Verwaltung'),
}))
vi.mock('@/lib/upload-batches/settle', () => ({ quarantineReviewersOf: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn().mockResolvedValue(0) }))

import { recordAuditEvent } from '@/lib/audit/service'
import { DOCUMENT_NAME_KEYS } from '@/lib/audit/document-names'
import { isFolderVisibleTo, requireFolderWrite } from '@/lib/authz/folder-access'
import { folderReadOnlyError } from '@/lib/authz/folder-access-rule'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findDocumentInOrg, listQuarantinedDocuments, markScreeningReleased } from '@/lib/documents/repository'
import { mayReadDocument } from '@/lib/documents/document-reader'
import { dispatchDocument } from '@/lib/documents/service'
import { emitInboxItems } from '@/lib/inbox/service'
import { quarantineReviewersOf } from '@/lib/upload-batches/settle'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { makeDocument } from '@/test-utils/db-fixtures'
import { listQuarantineQueue, mayReviewQuarantine, releaseQuarantinedDocument, requestQuarantineRelease } from './review'

const member: AuthorizedSession = {
  userId: 'user-member',
  email: 'm@example.com',
  name: 'Member',
  accessToken: 't',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}
const orgAdmin: AuthorizedSession = { ...member, userId: 'user-admin', permissions: ['org:projects:administer'] }
const archivist: AuthorizedSession = { ...member, userId: 'user-arch', permissions: ['org:archiv:manage'] }

const verdict = 'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":1,"pages":[1]},{"kind":"iban","count":1,"sample":"AT61 •••• 1234"}],"checked":"full"}'
const quarantined = makeDocument({
  id: 'doc-q',
  status: 'quarantined',
  errorMessage: verdict,
  contentHash: 'sha256:abc',
  storageKey: 'org/org-1/project/proj-1/doc/doc-q/x.pdf',
  filename: 'Lohnzettel 03.pdf',
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isFolderVisibleTo).mockResolvedValue(true)
  vi.mocked(requireFolderWrite).mockResolvedValue(undefined)
  // The repository answers by the reader it is asked for, as `documentVisibleTo` does.
  vi.mocked(findDocumentInOrg).mockImplementation(async (_id, _org, reader) =>
    mayReadDocument(quarantined, reader) ? quarantined : null
  )
  vi.mocked(markScreeningReleased).mockResolvedValue(true)
  // A plain member holds no project:manage anywhere.
  vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError('Project not found'))
})

describe('mayReviewQuarantine', () => {
  it('lets an org admin review anything', async () => {
    expect(await mayReviewQuarantine(orgAdmin, { scope: 'session', projectId: null, folderId: null })).toBe(true)
  })

  it("lets a project's admins review that project's documents, and nobody else's", async () => {
    vi.mocked(requireProjectAccess).mockImplementation(async (_s, projectId) => {
      if (projectId !== 'proj-1') throw new NotFoundError('Project not found')
      return { role: 'project-admin' } as Awaited<ReturnType<typeof requireProjectAccess>>
    })
    expect(await mayReviewQuarantine(member, { scope: 'project', projectId: 'proj-1', folderId: null })).toBe(true)
    expect(await mayReviewQuarantine(member, { scope: 'project', projectId: 'proj-2', folderId: null })).toBe(false)
    expect(requireProjectAccess).toHaveBeenCalledWith(member, 'proj-1', 'project:manage')
  })

  it('leaves the Büroablage to whoever curates it, and a chat attachment to org admins', async () => {
    expect(await mayReviewQuarantine(archivist, { scope: 'archiv', projectId: null, folderId: null })).toBe(true)
    expect(await mayReviewQuarantine(member, { scope: 'archiv', projectId: null, folderId: null })).toBe(false)
    expect(await mayReviewQuarantine(archivist, { scope: 'session', projectId: null, folderId: null })).toBe(false)
  })
})

describe('mayReviewQuarantine and restricted folders (ADR-0087)', () => {
  it("does not let a project admin review a document in a folder they are not cleared for", async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' } as Awaited<
      ReturnType<typeof requireProjectAccess>
    >)
    vi.mocked(isFolderVisibleTo).mockImplementation(async (_s, _p, folderId) => folderId !== 'f-hidden')

    expect(await mayReviewQuarantine(member, { scope: 'project', projectId: 'proj-1', folderId: 'f-hidden' })).toBe(false)
    expect(await mayReviewQuarantine(member, { scope: 'project', projectId: 'proj-1', folderId: 'f-open' })).toBe(true)
  })
})

describe('releaseQuarantinedDocument', () => {
  it('releases the exact bytes, re-dispatches, and audits kinds and terms only', async () => {
    const result = await releaseQuarantinedDocument(orgAdmin, 'doc-q', new Request('http://x'))

    expect(result).toEqual({ id: 'doc-q', status: 'pending', jobId: 'job-9' })
    expect(markScreeningReleased).toHaveBeenCalledWith(
      'doc-q',
      'org-1',
      expect.objectContaining({ contentHash: 'sha256:abc', releasedBy: 'user-admin' })
    )
    expect(dispatchDocument).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc-q', folderPath: 'Verwaltung' }))
    const audit = vi.mocked(recordAuditEvent).mock.calls[0]?.[0]
    expect(audit).toMatchObject({
      action: 'document.quarantine_released',
      metadata: { reasons: 'term,iban', terms: 'Lohnzettel' },
    })
    expect(JSON.stringify(audit)).not.toContain('AT61')
  })

  it('keeps the words found in the text under a key withheld with the name (ADR-0087)', async () => {
    const inFolder = { ...quarantined, scope: 'project' as const, projectId: 'proj-1', folderId: 'f-lohn' }
    vi.mocked(findDocumentInOrg).mockResolvedValue(inFolder)

    await releaseQuarantinedDocument(orgAdmin, 'doc-q', new Request('http://x'))

    const audit = vi.mocked(recordAuditEvent).mock.calls[0]?.[0]
    expect(audit?.filedIn).toEqual({ projectId: 'proj-1', folderId: 'f-lohn' })
    // What the trail keeps of the event when the folder is restricted (`wireMetadata`, audit/service.ts).
    const kept = Object.entries(audit?.metadata ?? {}).filter(
      ([key]) => !(DOCUMENT_NAME_KEYS as readonly string[]).includes(key)
    )
    expect(JSON.stringify(kept)).not.toMatch(/Lohnzettel/i)
  })

  it('asks for a write in the document\'s folder, and a reviewer who may only read it cannot release (ADR-0088)', async () => {
    const inFolder = { ...quarantined, scope: 'project' as const, projectId: 'proj-1', folderId: 'f-read-only' }
    vi.mocked(findDocumentInOrg).mockResolvedValue(inFolder)
    vi.mocked(requireFolderWrite).mockRejectedValueOnce(folderReadOnlyError())

    await expect(releaseQuarantinedDocument(orgAdmin, 'doc-q', new Request('http://x'))).rejects.toMatchObject({
      status: 403,
      details: { reason: 'folder-read-only' },
    })
    expect(requireFolderWrite).toHaveBeenCalledWith(orgAdmin, 'proj-1', ['f-read-only'])
    expect(markScreeningReleased).not.toHaveBeenCalled()
    expect(dispatchDocument).not.toHaveBeenCalled()
  })

  it('answers a non-reviewer as if the document did not exist', async () => {
    await expect(releaseQuarantinedDocument(member, 'doc-q', new Request('http://x'))).rejects.toBeInstanceOf(NotFoundError)
    expect(markScreeningReleased).not.toHaveBeenCalled()
    expect(dispatchDocument).not.toHaveBeenCalled()
  })

  it('refuses a document that is not quarantined', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...quarantined, status: 'completed', errorMessage: null })
    await expect(releaseQuarantinedDocument(orgAdmin, 'doc-q', new Request('http://x'))).rejects.toMatchObject({
      status: 409,
    })
    expect(dispatchDocument).not.toHaveBeenCalled()
  })

  /**
   * A file the gate never reached a verdict on is held from upload until its
   * screening passes (2026-10-08). When its reading fails for good (an IFC model
   * over the size limit, an unparseable one) a retry fails the same way, so
   * without a release it stayed with its uploader for ever.
   */
  it.each([
    ['whose reading failed', { status: 'failed', errorMessage: 'IFC zu groß' }],
    ['stranded before its dispatch', { status: 'uploaded', errorMessage: null }],
    ['whose bytes were swapped after its verdict', { status: 'completed', screeningOutcome: 'clean' as const, screenedHash: 'sha256:earlier' }],
  ])('releases a file %s, which waits on a reviewer as a quarantine does', async (_label, fields) => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...quarantined, errorMessage: null, ...fields })
    await expect(releaseQuarantinedDocument(orgAdmin, 'doc-q', new Request('http://x'))).resolves.toMatchObject({
      id: 'doc-q',
    })
    expect(markScreeningReleased).toHaveBeenCalledWith('doc-q', 'org-1', expect.objectContaining({ contentHash: 'sha256:abc' }))
    expect(dispatchDocument).toHaveBeenCalled()
  })

  it('refuses a held file still in flight: its own job decides it', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...quarantined, status: 'processing', errorMessage: null })
    await expect(releaseQuarantinedDocument(orgAdmin, 'doc-q', new Request('http://x'))).rejects.toMatchObject({
      status: 409,
    })
    expect(markScreeningReleased).not.toHaveBeenCalled()
  })

  it('refuses a document with no digest, because a release must name its bytes', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...quarantined, contentHash: null })
    await expect(releaseQuarantinedDocument(orgAdmin, 'doc-q', new Request('http://x'))).rejects.toMatchObject({
      status: 409,
    })
  })

  it('does not dispatch when a re-upload replaced the bytes in the meantime', async () => {
    vi.mocked(markScreeningReleased).mockResolvedValue(false)
    await expect(releaseQuarantinedDocument(orgAdmin, 'doc-q', new Request('http://x'))).rejects.toMatchObject({
      status: 409,
    })
    expect(dispatchDocument).not.toHaveBeenCalled()
  })
})

describe('listQuarantineQueue', () => {
  it('reads past a page of other projects\' quarantine until the reviewer\'s own list is full', async () => {
    // The page size is 3 here. The newest page belongs entirely to a project
    // this reviewer does not administer; theirs come after it.
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute))
    const other = [1, 2, 3].map((n) => ({ ...quarantined, id: `other-${n}`, projectId: 'proj-2', updatedAt: at(60 - n) }))
    const mine = [1, 2].map((n) => ({ ...quarantined, id: `mine-${n}`, projectId: 'proj-1', updatedAt: at(30 - n) }))
    vi.mocked(listQuarantinedDocuments).mockReset()
    vi.mocked(listQuarantinedDocuments).mockResolvedValueOnce(other).mockResolvedValueOnce(mine)
    vi.mocked(requireProjectAccess).mockImplementation(async (_s, projectId) => {
      if (projectId !== 'proj-1') throw new NotFoundError('Project not found')
      return { role: 'project-admin' } as Awaited<ReturnType<typeof requireProjectAccess>>
    })

    const items = await listQuarantineQueue(member)

    expect(items.map((item) => item.id)).toEqual(['mine-1', 'mine-2'])
    // The second page starts after the last row of the first.
    expect(vi.mocked(listQuarantinedDocuments).mock.calls[1]?.[1]).toEqual({ updatedAt: at(57), id: 'other-3' })
  })

  it("shows a project admin only their projects' part of the queue, with the reasons read", async () => {
    // A full page, then the end of the queue.
    vi.mocked(listQuarantinedDocuments)
      .mockResolvedValueOnce([
        { ...quarantined, id: 'a', projectId: 'proj-1' },
        { ...quarantined, id: 'b', projectId: 'proj-2' },
        { ...quarantined, id: 'c', projectId: 'proj-1' },
      ])
      .mockResolvedValue([])
    vi.mocked(requireProjectAccess).mockImplementation(async (_s, projectId) => {
      if (projectId !== 'proj-1') throw new NotFoundError('Project not found')
      return { role: 'project-admin' } as Awaited<ReturnType<typeof requireProjectAccess>>
    })

    const items = await listQuarantineQueue(member)

    expect(items.map((item) => item.id)).toEqual(['a', 'c'])
    expect(items[0]?.verdict?.reasons[0]).toMatchObject({ kind: 'term', term: 'Lohnzettel' })
    // One check per project, not per document.
    expect(requireProjectAccess).toHaveBeenCalledTimes(2)
  })

  it('lists a file whose reading ended without a verdict as unscreened, not as a reasonless quarantine', async () => {
    vi.mocked(listQuarantinedDocuments)
      .mockResolvedValueOnce([quarantined, { ...quarantined, id: 'doc-f', status: 'failed', errorMessage: 'IFC zu groß' }])
      .mockResolvedValue([])
    const items = await listQuarantineQueue(orgAdmin)
    expect(items.map((item) => [item.id, item.held])).toEqual([
      ['doc-q', 'quarantined'],
      ['doc-f', 'unscreened'],
    ])
    expect(items[1]?.verdict).toBeNull()
  })

  it('gives a member who reviews nothing an empty queue', async () => {
    vi.mocked(listQuarantinedDocuments).mockResolvedValue([quarantined])
    expect(await listQuarantineQueue(member)).toEqual([])
  })
})

describe('requestQuarantineRelease („Freigabe anfragen")', () => {
  // `makeDocument` is uploaded by `user-1`.
  const uploader: AuthorizedSession = { ...member, userId: 'user-1' }

  beforeEach(() => {
    // Every session here may view the project; nobody but its admin manages it.
    vi.mocked(requireProjectAccess).mockImplementation(async (_s, _projectId, permission) => {
      if (permission === 'project:manage') throw new NotFoundError('Project not found')
      return { role: 'project-viewer' } as Awaited<ReturnType<typeof requireProjectAccess>>
    })
    vi.mocked(quarantineReviewersOf).mockResolvedValue(['user-admin', 'user-pa'])
  })

  it("tells the file's reviewers through the inbox, one row per file, naming it", async () => {
    await expect(requestQuarantineRelease(uploader, 'doc-q')).resolves.toEqual({ id: 'doc-q', notified: 2 })

    expect(quarantineReviewersOf).toHaveBeenCalledWith('org-1', quarantined)
    const emitted = vi.mocked(emitInboxItems).mock.calls[0]?.[0] ?? []
    expect(emitted.map((row) => row.recipientUserId)).toEqual(['user-admin', 'user-pa'])
    expect(emitted[0]).toMatchObject({
      type: 'document.release_requested',
      resourceType: 'organization',
      resourceId: 'org-1',
      anchorId: 'doc-q',
      actorUserId: 'user-1',
      groupKey: 'document.release_requested:organization:org-1:doc-q',
      payload: { subject: 'Lohnzettel 03.pdf' },
    })
    // Asking releases nothing.
    expect(markScreeningReleased).not.toHaveBeenCalled()
    expect(dispatchDocument).not.toHaveBeenCalled()
  })

  it('does not count the uploader among the reviewers it told', async () => {
    vi.mocked(quarantineReviewersOf).mockResolvedValue(['user-1'])
    await expect(requestQuarantineRelease(uploader, 'doc-q')).resolves.toEqual({ id: 'doc-q', notified: 0 })
  })

  it('does not exist for a member who did not upload it', async () => {
    await expect(requestQuarantineRelease(member, 'doc-q')).rejects.toBeInstanceOf(NotFoundError)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('refuses a reviewer who did not upload it: they release it themselves', async () => {
    await expect(requestQuarantineRelease(orgAdmin, 'doc-q')).rejects.toBeInstanceOf(ForbiddenError)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('lets the uploader ask about a file whose reading failed before a verdict', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (_id, _org, reader) => {
      const failed = { ...quarantined, status: 'failed', errorMessage: 'IFC zu groß' }
      return mayReadDocument(failed, reader) ? failed : null
    })
    await expect(requestQuarantineRelease(uploader, 'doc-q')).resolves.toEqual({ id: 'doc-q', notified: 2 })
  })

  it('refuses a file that is no longer in quarantine', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue({ ...quarantined, status: 'completed', errorMessage: null })
    await expect(requestQuarantineRelease(uploader, 'doc-q')).rejects.toBeInstanceOf(ConflictError)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})
