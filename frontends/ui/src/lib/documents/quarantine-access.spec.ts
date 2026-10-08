/**
 * A quarantined document (ADR-0085) exists only for its uploader and for the
 * people who may review the quarantine.
 *
 * The audit found it served to every project member, and in the Büroablage to
 * every org member, on every byte path: `getAccessibleDocument` never looked at
 * the status. These specs drive the real gate and the real reviewer rule
 * (`mayReviewQuarantine`) through each surface a person opens a file by —
 * download, preview, text preview, thumbnail — and the listing, for a member,
 * the uploader and a reviewer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/download-log/service', () => ({ recordDocumentAccess: vi.fn(async () => undefined) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/organizations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/organizations')>()),
  canManageArchiv: vi.fn(() => false),
}))
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn() },
  signingS3Client: { send: vi.fn() },
  bucketAdminS3Client: { send: vi.fn() },
  bucketName: 'test-bucket',
}))
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://seaweedfs.internal/presigned'),
}))
vi.mock('./repository', () => ({
  findDocumentInOrg: vi.fn(),
  listProjectDocumentPage: vi.fn().mockResolvedValue({ rows: [], nextCursor: null }),
  findProjectDocumentsByFilenames: vi.fn().mockResolvedValue([]),
  findProjectDocumentsByNames: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn().mockResolvedValue({ id: 'proj-1', collectionName: 'proj_abc' }),
}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('./reconcile-status', () => ({
  reconcileDocumentStatuses: vi.fn(async (rows: unknown[]) => rows),
  describeBackendIngestState: vi.fn(),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canManageArchiv } from '@/lib/authz/organizations'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Document } from '@/lib/db/schema'
import { s3Client } from '@/lib/s3'
import { makeDocument } from '@/test-utils/db-fixtures'
import {
  findDocumentInOrg,
  findProjectDocumentsByFilenames,
  findProjectDocumentsByNames,
  listProjectDocumentPage,
  type DocumentListRow,
} from './repository'
import { reconcileDocumentStatuses } from './reconcile-status'
import {
  getDocumentDownload,
  getDocumentPreview,
  getDocumentTextPreview,
  getDocumentThumbnail,
  listDocumentsPage,
  probeProjectDocumentNames,
  resolveProjectDocumentsByName,
  searchProjectDocuments,
} from './service'

const personOf = (userId: string, permissions: string[] = []): AuthorizedSession =>
  ({ organizationId: 'org-1', userId, email: `${userId}@example.com`, permissions }) as unknown as AuthorizedSession

/** A project member who neither uploaded the file nor reviews the project's quarantine. */
const member = personOf('member-1')
const uploader = personOf('uploader-1')
/** The project's admin: `project:manage` on it. */
const projectAdmin = personOf('admin-1')
const orgAdmin = personOf('owner-1', [ORG_PERMISSIONS.projectsAdminister])

const quarantined = (overrides: Partial<Document> = {}): Document =>
  makeDocument({
    id: 'doc-q',
    scope: 'project',
    projectId: 'proj-1',
    createdBy: 'uploader-1',
    status: 'quarantined',
    errorMessage: 'quarantined:{"reasons":[{"kind":"iban"}]}',
    ...overrides,
  })

type Surface = { name: string; open: (session: AuthorizedSession) => Promise<unknown>; doc: () => Document }

const SURFACES: Surface[] = [
  { name: 'download', open: (session) => getDocumentDownload(session, 'doc-q'), doc: () => quarantined() },
  { name: 'preview', open: (session) => getDocumentPreview(session, 'doc-q'), doc: () => quarantined() },
  {
    name: 'text preview',
    open: (session) => getDocumentTextPreview(session, 'doc-q'),
    doc: () => quarantined({ filename: 'konten.csv', contentType: 'text/csv' }),
  },
  { name: 'thumbnail', open: (session) => getDocumentThumbnail(session, 'doc-q'), doc: () => quarantined() },
]

beforeEach(() => {
  vi.clearAllMocks()
  // Every session here may view the project; only its admin may manage it.
  vi.mocked(requireProjectAccess).mockImplementation(async (session, _projectId, permission) => {
    if (permission === 'project:manage' && session.userId !== 'admin-1') throw new ForbiddenError()
    return { role: 'project-viewer' } as Awaited<ReturnType<typeof requireProjectAccess>>
  })
  vi.mocked(canManageArchiv).mockReturnValue(false)
  vi.mocked(s3Client.send).mockResolvedValue({
    ContentLength: 64,
    Body: { transformToByteArray: async () => new TextEncoder().encode('iban;betrag\n') },
  } as never)
})

describe.each(SURFACES)('the $name of a quarantined project document', ({ open, doc }) => {
  beforeEach(() => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(doc())
  })

  it('does not exist for a project member who did not upload it', async () => {
    await expect(open(member)).rejects.toBeInstanceOf(NotFoundError)
    // Refused before a byte was asked for.
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('is served to its uploader', async () => {
    await expect(open(uploader)).resolves.toBeDefined()
  })

  it("is served to the project's admin, who reviews it", async () => {
    await expect(open(projectAdmin)).resolves.toBeDefined()
  })

  it("is served to the organization's admin", async () => {
    await expect(open(orgAdmin)).resolves.toBeDefined()
  })
})

describe('a document that is not quarantined', () => {
  it('is served to every project member as before', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(quarantined({ status: 'completed', errorMessage: null }))
    await expect(getDocumentDownload(member, 'doc-q')).resolves.toMatchObject({ filename: 'plan.pdf' })
  })
})

describe('a quarantined Büroablage document', () => {
  beforeEach(() => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(quarantined({ scope: 'archiv', projectId: null }))
  })

  it('does not exist for an org member who did not upload it', async () => {
    await expect(getDocumentDownload(member, 'doc-q')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('is served to its uploader and to a curator', async () => {
    await expect(getDocumentDownload(uploader, 'doc-q')).resolves.toBeDefined()
    vi.mocked(canManageArchiv).mockReturnValue(true)
    await expect(getDocumentDownload(member, 'doc-q')).resolves.toBeDefined()
  })
})

describe('the project listing and a quarantined document', () => {
  const readerOf = (call: number): unknown => vi.mocked(listProjectDocumentPage).mock.calls[call][2]?.quarantineReader

  it('keeps a member to the quarantined files they uploaded themselves', async () => {
    await listDocumentsPage(member, 'proj-1')
    await listDocumentsPage(uploader, 'proj-1')

    expect(readerOf(0)).toBe('member-1')
    expect(readerOf(1)).toBe('uploader-1')
  })

  it('lists every quarantined file to a reviewer', async () => {
    await listDocumentsPage(projectAdmin, 'proj-1')
    await listDocumentsPage(orgAdmin, 'proj-1')

    expect(readerOf(0)).toBeUndefined()
    expect(readerOf(1)).toBeUndefined()
  })

  it('narrows the by-name resolve the same way', async () => {
    await resolveProjectDocumentsByName(member, 'proj-1', ['konten.csv'])
    expect(vi.mocked(findProjectDocumentsByFilenames).mock.calls[0][3]).toMatchObject({ quarantineReader: 'member-1' })
  })

  // The upload planner's probe answers with the digest: somebody else's
  // quarantined file would let a member confirm its contents by hash.
  it('narrows the name probe the same way', async () => {
    await probeProjectDocumentNames(member, 'proj-1', ['konten.csv'])
    await probeProjectDocumentNames(projectAdmin, 'proj-1', ['konten.csv'])
    expect(vi.mocked(findProjectDocumentsByNames).mock.calls[0][3]).toMatchObject({ quarantineReader: 'member-1' })
    expect(vi.mocked(findProjectDocumentsByNames).mock.calls[1][3]?.quarantineReader).toBeUndefined()
  })

  it('narrows the rows a search hit is joined to the same way', async () => {
    // A hit names a file; a quarantined row of the same name must not take it.
    const hit = { file_name: 'konten.csv', score: 0.9, snippet: 's', page_number: 1, collection: 'proj_abc' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ hits: [hit] })))
    try {
      await searchProjectDocuments(member, 'proj-1', 'konto')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(vi.mocked(findProjectDocumentsByFilenames).mock.calls[0][3]).toMatchObject({ quarantineReader: 'member-1' })
  })
})

/**
 * The query can drop only a row that IS quarantined. The first listing after a
 * file's verdict reads it `pending`, and the reconcile that runs on the rows it
 * read is what turns it `quarantined`: that row must be narrowed again, or the
 * first member to open the Dateien after screening is handed its name.
 */
describe('a verdict that lands during the listing', () => {
  const pendingRow = (id: string, createdBy: string): DocumentListRow => ({
    id,
    filename: `${id}.pdf`,
    displayName: null,
    fileSize: 64,
    contentType: 'application/pdf',
    status: 'pending',
    authoredBy: 'user',
    publishedVersionId: null,
    lifecycle: 'active',
    collectionName: 'proj_abc',
    folderId: null,
    originPath: null,
    contentHash: null,
    createdBy,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    errorMessage: null,
    metadata: null,
  })

  beforeEach(() => {
    vi.mocked(listProjectDocumentPage).mockResolvedValue({
      rows: [pendingRow('mine', 'member-1'), pendingRow('theirs', 'uploader-1')],
      nextCursor: null,
    })
    vi.mocked(reconcileDocumentStatuses).mockImplementation(async (rows) =>
      rows.map((row) => ({ ...row, status: 'quarantined' }))
    )
  })

  it("leaves somebody else's out for a member, and keeps their own", async () => {
    const { documents } = await listDocumentsPage(member, 'proj-1')
    expect(documents.map((doc) => doc.id)).toEqual(['mine'])
    expect(documents[0]).not.toHaveProperty('createdBy')
  })

  it('keeps both for a reviewer', async () => {
    const { documents } = await listDocumentsPage(projectAdmin, 'proj-1')
    expect(documents.map((doc) => doc.id)).toEqual(['mine', 'theirs'])
  })
})
