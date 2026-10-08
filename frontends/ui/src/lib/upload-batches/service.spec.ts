import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  countBatchDocumentsByStatus: vi.fn(),
  findUploadBatch: vi.fn(),
  insertUploadBatch: vi.fn().mockResolvedValue(undefined),
  listBatchDocuments: vi.fn(),
  listProjectUploadBatchPage: vi.fn(),
  sealUploadBatch: vi.fn(),
}))
vi.mock('./settle', () => ({ settleUploadBatches: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/documents/reconcile-status', () => ({
  reconcileDocumentStatuses: vi.fn(async (rows: unknown[]) => rows),
}))
vi.mock('@/lib/documents/repository', () => ({ findFolderPathsInProject: vi.fn().mockResolvedValue(new Map()) }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
// The loaders are stubbed; the rule is the real one, so each spec decides with the rule it ships with.
vi.mock('@/lib/authz/folder-access', async () => ({
  ...(await import('@/lib/authz/folder-access-rule')),
  loadCustomFolderTree: vi.fn(),
  clearanceOf: vi.fn(),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { clearanceOf, loadCustomFolderTree, type AccessFolder, type FolderGrant } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { UploadBatch } from '@/lib/db/schema'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { findFolderPathsInProject } from '@/lib/documents/repository'
import { encodeDocumentListCursor } from '@/lib/documents/list-cursor'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'
import {
  countBatchDocumentsByStatus,
  findUploadBatch,
  insertUploadBatch,
  listBatchDocuments,
  listProjectUploadBatchPage,
  sealUploadBatch,
} from './repository'
import {
  acceptedUploadBatchId,
  getUploadSummary,
  listProjectUploadHistory,
  openUploadBatch,
  readUploadBatchId,
  sealOwnUploadBatch,
} from './service'
import { settleUploadBatches } from './settle'

const BATCH_ID = '0b9a5f7e-3d1c-4a8e-9f00-1234567890ab'

const session: AuthorizedSession = {
  userId: 'uploader',
  email: 'u@example.com',
  name: 'Uploader',
  accessToken: 't',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const batch = (overrides: Partial<UploadBatch> = {}): UploadBatch => ({
  id: BATCH_ID,
  organizationId: 'org-1',
  createdBy: 'uploader',
  scope: 'project',
  projectId: 'proj-1',
  conversationId: null,
  expectedCount: 3,
  excluded: [{ term: 'Rechnung', count: 2 }],
  unchangedCount: 1,
  failedCount: 0,
  sealedAt: null,
  completedAt: null,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  ...overrides,
})

const GF = 'org-geschaeftsfuehrung'
const inherit = (id: string, parentId: string | null = null): AccessFolder => ({ id, parentId, accessMode: 'inherit', grants: [] })
const ownList = (id: string, grants: FolderGrant[], extra: Partial<AccessFolder> = {}): AccessFolder => ({
  id,
  parentId: null,
  accessMode: 'custom',
  grants,
  ...extra,
})
/** A folder only the Geschäftsführung may open: hidden from the member who reads these specs. */
const gfOnly = (id: string, extra: Partial<AccessFolder> = {}): AccessFolder => ownList(id, [{ role: GF, level: 'write' }], extra)
const binned = (folder: AccessFolder): AccessFolder => ({ ...folder, deleted: true })
const asMember = () => vi.mocked(clearanceOf).mockResolvedValue({ roles: ['member'], seesEverything: false })
const asAdmin = () => vi.mocked(clearanceOf).mockResolvedValue({ roles: [], seesEverything: true })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findUploadBatch).mockResolvedValue(batch())
  vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ id: 'proj-1', collectionName: 'proj_c' }))
  vi.mocked(loadCustomFolderTree).mockResolvedValue(null)
  asMember()
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
})

describe('openUploadBatch', () => {
  it('opens a project batch for someone who may write documents there', async () => {
    await openUploadBatch(session, {
      id: BATCH_ID,
      scope: 'project',
      projectId: 'proj-1',
      conversationId: 'ignored',
      expectedCount: 3,
      excluded: [{ term: 'Rechnung', count: 2 }],
    })
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', ['project:documents:write', 'project:edit'])
    expect(insertUploadBatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: BATCH_ID, createdBy: 'uploader', projectId: 'proj-1', conversationId: null })
    )
  })

  it("refuses a Büroablage batch to someone who does not curate it, as if it didn't exist", async () => {
    await expect(
      openUploadBatch(session, { id: BATCH_ID, scope: 'archiv', projectId: null, conversationId: null, expectedCount: 1, excluded: [] })
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(insertUploadBatch).not.toHaveBeenCalled()
  })
})

describe('acceptedUploadBatchId', () => {
  const project = { scope: 'project' as const, projectId: 'proj-1' }

  it("accepts the uploader's own open batch for this shelf", async () => {
    expect(await acceptedUploadBatchId(session, BATCH_ID, project)).toBe(BATCH_ID)
  })

  it.each([
    ['another member’s batch', batch({ createdBy: 'someone-else' })],
    ['a sealed batch', batch({ sealedAt: new Date() })],
    ['another project’s batch', batch({ projectId: 'proj-2' })],
    ['a batch for another shelf', batch({ scope: 'archiv', projectId: null })],
  ])('ignores %s rather than failing the upload', async (_label, row) => {
    vi.mocked(findUploadBatch).mockResolvedValue(row)
    expect(await acceptedUploadBatchId(session, BATCH_ID, project)).toBeNull()
  })

  it('ignores anything that is not a uuid without asking the database', async () => {
    expect(await acceptedUploadBatchId(session, "x' OR 1=1", project)).toBeNull()
    expect(readUploadBatchId('not-a-uuid')).toBeNull()
    expect(findUploadBatch).not.toHaveBeenCalled()
  })
})

describe('sealOwnUploadBatch', () => {
  it('seals with the counts and settles at once, for a batch whose files already finished', async () => {
    vi.mocked(sealUploadBatch).mockResolvedValue(true)
    await sealOwnUploadBatch(session, BATCH_ID, { unchanged: 1, failed: 0 })
    expect(sealUploadBatch).toHaveBeenCalledWith('org-1', BATCH_ID, 'uploader', { unchanged: 1, failed: 0 }, expect.any(Date))
    expect(settleUploadBatches).toHaveBeenCalledWith('org-1', [BATCH_ID])
  })

  it("does not let anyone else seal it", async () => {
    vi.mocked(findUploadBatch).mockResolvedValue(batch({ createdBy: 'someone-else' }))
    await expect(sealOwnUploadBatch(session, BATCH_ID, { unchanged: 0, failed: 0 })).rejects.toBeInstanceOf(NotFoundError)
    expect(sealUploadBatch).not.toHaveBeenCalled()
  })
})

describe('getUploadSummary', () => {
  it('reads every document through reconciliation and says what each became, where, and why', async () => {
    vi.mocked(findUploadBatch).mockResolvedValue(batch({ sealedAt: new Date(), completedAt: new Date() }))
    vi.mocked(listBatchDocuments).mockResolvedValue([
      makeDocument({ id: 'a', filename: 'EG.pdf', status: 'completed', folderId: 'f1', screeningOutcome: 'clean' }),
      makeDocument({
        id: 'b',
        filename: 'Lohn.pdf',
        status: 'quarantined',
        screeningOutcome: 'quarantined',
        errorMessage: 'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":1}],"checked":"full"}',
      }),
      makeDocument({ id: 'c', filename: 'Scan.pdf', status: 'pending' }),
      makeDocument({ id: 'd', filename: 'Kaputt.pdf', status: 'failed', errorMessage: 'pdf_pages_unreadable: 3 of 3 pages' }),
    ])
    vi.mocked(reconcileDocumentStatuses).mockImplementation(async (rows) =>
      rows.map((row) => (row.id === 'a' ? { ...row, summary: 'Grundriss EG', tags: ['Plan'] } : row))
    )
    vi.mocked(findFolderPathsInProject).mockResolvedValue(new Map([['f1', 'Einreichung/Pläne']]))

    const summary = await getUploadSummary(session, BATCH_ID)

    expect(summary.excluded).toEqual([{ term: 'Rechnung', count: 2 }])
    expect(summary.unchangedCount).toBe(1)
    expect(summary.documents.map((d) => [d.filename, d.outcome])).toEqual([
      ['EG.pdf', 'ready'],
      ['Lohn.pdf', 'quarantined'],
      ['Scan.pdf', 'reading'],
      ['Kaputt.pdf', 'failed'],
    ])
    expect(summary.documents[0]).toMatchObject({ folderPath: 'Einreichung/Pläne', summary: 'Grundriss EG', tags: ['Plan'], screening: 'clean' })
    // The quarantine is reasons, not an error string.
    expect(summary.documents[1]).toMatchObject({ errorMessage: null, quarantine: { reasons: [{ term: 'Lohnzettel' }] } })
    expect(summary.documents[3]?.errorMessage).toContain('pdf_pages_unreadable')
  })

  it('leaves out what was filed in a folder the uploader may no longer see (ADR-0084)', async () => {
    vi.mocked(listBatchDocuments).mockResolvedValue([
      makeDocument({ id: 'open', filename: 'EG.pdf', folderId: 'f-open' }),
      makeDocument({ id: 'hidden', filename: 'Honorar.pdf', folderId: 'f-hidden' }),
    ])
    vi.mocked(loadCustomFolderTree).mockResolvedValue([inherit('f-open'), gfOnly('f-hidden')])

    const summary = await getUploadSummary(session, BATCH_ID)

    expect(summary.documents.map((d) => d.filename)).toEqual(['EG.pdf'])
    // The batch's own counts may be of files in that folder too, so they go with it.
    expect(summary).toMatchObject({ expectedCount: 1, unchangedCount: 0, failedCount: 0, excluded: [] })
  })

  it("keeps the batch's own counts while nothing of it is hidden from the uploader", async () => {
    vi.mocked(findUploadBatch).mockResolvedValue(batch({ failedCount: 1 }))
    vi.mocked(listBatchDocuments).mockResolvedValue([makeDocument({ id: 'open', folderId: 'f-open' })])
    vi.mocked(loadCustomFolderTree).mockResolvedValue([inherit('f-open'), gfOnly('f-hidden')])

    const summary = await getUploadSummary(session, BATCH_ID)

    expect(summary).toMatchObject({
      expectedCount: 3,
      unchangedCount: 1,
      failedCount: 1,
      excluded: [{ term: 'Rechnung', count: 2 }],
    })
  })

  it('marks a new version of a document already there as changed, and a file in a folder with its own list as protected', async () => {
    const filed = (id: string, folderId: string | null) =>
      makeDocument({ id, filename: `${id}.pdf`, folderId, createdAt: new Date('2026-10-01T10:00:05Z') })
    vi.mocked(listBatchDocuments).mockResolvedValue([
      // Older than the batch: this upload put new bytes on it (ADR-0054).
      makeDocument({ id: 'old', filename: 'Lageplan.pdf', createdAt: new Date('2026-09-01T08:00:00Z') }),
      filed('new', 'f-plain'),
      filed('secret', 'f-own-list'),
      filed('below', 'f-below-own-list'),
      // Every member reads it, only the Projektleitung changes it: still a folder with its own list.
      filed('statik', 'f-write-limited'),
    ])
    vi.mocked(clearanceOf).mockResolvedValue({ roles: [GF], seesEverything: false })
    vi.mocked(loadCustomFolderTree).mockResolvedValue([
      inherit('f-plain'),
      gfOnly('f-own-list'),
      inherit('f-below-own-list', 'f-own-list'),
      ownList('f-write-limited', [
        { role: '*', level: 'read' },
        { role: 'org-projektleitung', level: 'write' },
      ]),
    ])

    const summary = await getUploadSummary(session, BATCH_ID)

    expect(summary.documents.map((d) => [d.id, d.replaced, d.restricted])).toEqual([
      ['old', true, false],
      ['new', false, false],
      ['secret', false, true],
      ['below', false, true],
      ['statik', false, true],
    ])
  })

  it("keeps the batch's own counts when a file of it is in the Papierkorb of a folder the uploader may read", async () => {
    vi.mocked(listBatchDocuments).mockResolvedValue([
      makeDocument({ id: 'open', filename: 'EG.pdf', folderId: 'f-open' }),
      makeDocument({ id: 'binned', filename: 'Alt.pdf', folderId: 'f-binned' }),
    ])
    vi.mocked(loadCustomFolderTree).mockResolvedValue([inherit('f-open'), binned(inherit('f-binned'))])

    const summary = await getUploadSummary(session, BATCH_ID)

    // The binned file is left out, as the file list leaves it out, and hides nothing the uploader may not see.
    expect(summary.documents.map((d) => d.filename)).toEqual(['EG.pdf'])
    expect(summary).toMatchObject({ expectedCount: 3, unchangedCount: 1, excluded: [{ term: 'Rechnung', count: 2 }] })
  })

  it("withholds the batch's own counts when a file of it is in the Papierkorb of a folder the uploader may not read", async () => {
    vi.mocked(listBatchDocuments).mockResolvedValue([
      makeDocument({ id: 'open', filename: 'EG.pdf', folderId: 'f-open' }),
      makeDocument({ id: 'binned', filename: 'Honorar.pdf', folderId: 'f-binned' }),
    ])
    vi.mocked(loadCustomFolderTree).mockResolvedValue([inherit('f-open'), gfOnly('f-binned', { deleted: true })])

    const summary = await getUploadSummary(session, BATCH_ID)

    expect(summary).toMatchObject({ expectedCount: 1, unchangedCount: 0, failedCount: 0, excluded: [] })
  })

  it('marks nothing protected on a shelf without folder access lists', async () => {
    vi.mocked(findUploadBatch).mockResolvedValue(batch({ scope: 'archiv', projectId: null }))
    vi.mocked(listBatchDocuments).mockResolvedValue([makeDocument({ id: 'a', folderId: 'f-1' })])
    const summary = await getUploadSummary(session, BATCH_ID)
    expect(summary.documents[0]?.restricted).toBe(false)
    expect(loadCustomFolderTree).not.toHaveBeenCalled()
  })

  it("is the uploader's only", async () => {
    vi.mocked(findUploadBatch).mockResolvedValue(batch({ createdBy: 'someone-else' }))
    await expect(getUploadSummary(session, BATCH_ID)).rejects.toBeInstanceOf(NotFoundError)
    expect(listBatchDocuments).not.toHaveBeenCalled()
  })
})

describe('listProjectUploadHistory', () => {
  it('needs project:view and tallies each upload by outcome', async () => {
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({ batches: [batch({ completedAt: new Date() })], nextCursor: null })
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([
      { batchId: BATCH_ID, status: 'completed', count: 2 },
      { batchId: BATCH_ID, status: 'quarantined', count: 1 },
    ])
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([['uploader', { userId: 'uploader', email: null, name: 'Uta Upload', profilePictureUrl: null }]])
    )
    const {
      uploads: [entry],
    } = await listProjectUploadHistory(session, 'proj-1')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:view')
    expect(entry?.createdByName).toBe('Uta Upload')
    expect(entry).toMatchObject({ excludedCount: 2, unchangedCount: 1, counts: { ready: 2, quarantined: 1, reading: 0 } })
  })

  it('counts nothing filed in a folder hidden from the reader, as the document listing leaves it out (ADR-0084)', async () => {
    const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
    vi.mocked(loadCustomFolderTree).mockResolvedValue([inherit('f-open'), gfOnly('f-hidden')])
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({
      batches: [
        batch({ expectedCount: 14, unchangedCount: 0, excluded: [] }),
        batch({ id: OTHER, expectedCount: 12, unchangedCount: 0, excluded: [], createdBy: 'colleague' }),
      ],
      nextCursor: null,
    })
    // The repository counts only what the reader may see: 12 of BATCH_ID's 14
    // and all 12 of OTHER's went where the reader cannot look.
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([{ batchId: BATCH_ID, status: 'completed', count: 2 }])

    const { uploads: entries } = await listProjectUploadHistory(session, 'proj-1')

    expect(loadCustomFolderTree).toHaveBeenCalledWith('org-1', 'proj-1')
    expect(countBatchDocumentsByStatus).toHaveBeenCalledWith('org-1', [BATCH_ID, OTHER], { hiddenFolderIds: ['f-hidden'] })
    expect(entries.map((entry) => entry.id)).toEqual([BATCH_ID])
    expect(entries[0]).toMatchObject({ expectedCount: 2, counts: { ready: 2, quarantined: 0 } })
  })

  it('does not list an upload whose files wrote no row the reader may see, however the batch counted them', async () => {
    const FAILED = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60'
    vi.mocked(loadCustomFolderTree).mockResolvedValue([gfOnly('f-hidden')])
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({
      batches: [
        // A re-sync of 'Honorare': three new files, five the server answered „unchanged" for.
        batch({ expectedCount: 8, unchangedCount: 5, excluded: [] }),
        // Everything that landed is hidden, and one transfer failed.
        batch({ id: FAILED, expectedCount: 4, unchangedCount: 0, failedCount: 1, excluded: [] }),
      ],
      nextCursor: null,
    })
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([])

    expect((await listProjectUploadHistory(session, 'proj-1')).uploads).toEqual([])
  })

  it("shows a reader who cannot open every folder only what landed where they can look, not the batch's own counts", async () => {
    vi.mocked(loadCustomFolderTree).mockResolvedValue([gfOnly('f-hidden')])
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({
      batches: [batch({ expectedCount: 9, unchangedCount: 3, failedCount: 1, excluded: [{ term: 'Lohnzettel', count: 2 }] })],
      nextCursor: null,
    })
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([
      { batchId: BATCH_ID, status: 'completed', count: 2 },
      { batchId: BATCH_ID, status: 'quarantined', count: 1 },
    ])

    const {
      uploads: [entry],
    } = await listProjectUploadHistory(session, 'proj-1')

    // The unchanged, failed and screened-out files carry no folder: any of them may be in 'f-hidden'.
    expect(entry).toMatchObject({ expectedCount: 3, unchangedCount: 0, failedCount: 0, excludedCount: 0 })
    expect(entry?.counts).toMatchObject({ ready: 2, quarantined: 1 })
  })

  it('passes the batch through to a reader from whom no folder is hidden, an upload that wrote no row included', async () => {
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({
      batches: [batch({ expectedCount: 5, unchangedCount: 5, failedCount: 0 })],
      nextCursor: null,
    })
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([])

    const {
      uploads: [entry],
    } = await listProjectUploadHistory(session, 'proj-1')

    expect(entry).toMatchObject({ expectedCount: 5, unchangedCount: 5, excludedCount: 2 })
  })

  it.each([
    ['an organization admin', asAdmin],
    ['a member who may read the binned folder', asMember],
  ])("passes the batch through to %s when the only hidden folder is in the Papierkorb", async (_label, as) => {
    as()
    vi.mocked(loadCustomFolderTree).mockResolvedValue([inherit('f-open'), binned(inherit('f-binned'))])
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({
      batches: [batch({ expectedCount: 9, unchangedCount: 3, failedCount: 1 })],
      nextCursor: null,
    })
    // Four landed in f-open; the two in the bin are not tallied, as the listing leaves them out.
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([{ batchId: BATCH_ID, status: 'completed', count: 4 }])

    const {
      uploads: [entry],
    } = await listProjectUploadHistory(session, 'proj-1')

    expect(countBatchDocumentsByStatus).toHaveBeenCalledWith('org-1', [BATCH_ID], { hiddenFolderIds: ['f-binned'] })
    expect(entry).toMatchObject({ expectedCount: 9, unchangedCount: 3, failedCount: 1, excludedCount: 2, counts: { ready: 4 } })
  })

  it("withholds the batch's own counts when a folder in the Papierkorb is one the reader may not read", async () => {
    vi.mocked(loadCustomFolderTree).mockResolvedValue([inherit('f-open'), gfOnly('f-binned', { deleted: true })])
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({
      batches: [batch({ expectedCount: 9, unchangedCount: 3, failedCount: 1 })],
      nextCursor: null,
    })
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([{ batchId: BATCH_ID, status: 'completed', count: 4 }])

    const {
      uploads: [entry],
    } = await listProjectUploadHistory(session, 'proj-1')

    expect(entry).toMatchObject({ expectedCount: 4, unchangedCount: 0, failedCount: 0, excludedCount: 0 })
  })

  it('pages: reads from the cursor it is given and hands the next one back, opaque', async () => {
    const cursor = { createdAt: '2026-10-01T10:00:00.123456', id: BATCH_ID }
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({
      batches: [batch()],
      nextCursor: { createdAt: '2026-09-30T08:00:00.000001', id: BATCH_ID },
    })
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([])

    const page = await listProjectUploadHistory(session, 'proj-1', { cursor })

    expect(listProjectUploadBatchPage).toHaveBeenCalledWith('org-1', 'proj-1', { cursor })
    expect(page.uploads).toHaveLength(1)
    expect(page.nextCursor).toBe(
      encodeDocumentListCursor({ createdAt: '2026-09-30T08:00:00.000001', id: BATCH_ID })
    )
  })

  it('says the history is complete on its last page', async () => {
    vi.mocked(listProjectUploadBatchPage).mockResolvedValue({ batches: [], nextCursor: null })
    expect(await listProjectUploadHistory(session, 'proj-1')).toEqual({ uploads: [], nextCursor: null })
  })
})
