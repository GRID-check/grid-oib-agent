import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ isFolderVisibleTo: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({
  findDocumentInOrg: vi.fn(),
  listQuarantinedDocuments: vi.fn(),
  markScreeningReleased: vi.fn(),
  QUARANTINE_LIST_LIMIT: 3,
}))
vi.mock('@/lib/documents/service', () => ({
  dispatchDocument: vi.fn().mockResolvedValue({ jobId: 'job-9', status: 'pending' }),
  resolveDocumentFolderPath: vi.fn().mockResolvedValue('Verwaltung'),
}))

import { recordAuditEvent } from '@/lib/audit/service'
import { isFolderVisibleTo } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findDocumentInOrg, listQuarantinedDocuments, markScreeningReleased } from '@/lib/documents/repository'
import { dispatchDocument } from '@/lib/documents/service'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { makeDocument } from '@/test-utils/db-fixtures'
import { listQuarantineQueue, mayReviewQuarantine, releaseQuarantinedDocument } from './review'

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
  vi.mocked(findDocumentInOrg).mockResolvedValue(quarantined)
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

describe('mayReviewQuarantine and restricted folders (ADR-0078)', () => {
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
    expect(audit).toMatchObject({ action: 'document.quarantine_released', metadata: { reasons: 'term:Lohnzettel,iban' } })
    expect(JSON.stringify(audit)).not.toContain('AT61')
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

  it('gives a member who reviews nothing an empty queue', async () => {
    vi.mocked(listQuarantinedDocuments).mockResolvedValue([quarantined])
    expect(await listQuarantineQueue(member)).toEqual([])
  })
})
