import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  countBatchDocumentsByStatus: vi.fn(),
  findUploadBatch: vi.fn(),
  insertUploadBatch: vi.fn().mockResolvedValue(undefined),
  listBatchDocuments: vi.fn(),
  listProjectUploadBatches: vi.fn(),
  sealUploadBatch: vi.fn(),
}))
vi.mock('./settle', () => ({ settleUploadBatches: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/documents/reconcile-status', () => ({
  reconcileDocumentStatuses: vi.fn(async (rows: unknown[]) => rows),
}))
vi.mock('@/lib/documents/repository', () => ({ findFolderPathsInProject: vi.fn().mockResolvedValue(new Map()) }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ getProjectFolderAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getProjectFolderAccess, type ProjectFolderAccess } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { UploadBatch } from '@/lib/db/schema'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { findFolderPathsInProject } from '@/lib/documents/repository'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'
import {
  countBatchDocumentsByStatus,
  findUploadBatch,
  insertUploadBatch,
  listBatchDocuments,
  listProjectUploadBatches,
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

const OPEN: ProjectFolderAccess = {
  hiddenFolderIds: new Set(),
  isVisible: () => true,
  collectionFor: () => 'proj_c',
  clearedRestrictedCollections: [],
  levelOf: () => 'write',
  sourceFolderOf: () => null,
  anyRestricted: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findUploadBatch).mockResolvedValue(batch())
  vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ id: 'proj-1', collectionName: 'proj_c' }))
  vi.mocked(getProjectFolderAccess).mockResolvedValue(OPEN)
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

  it('leaves out what was filed in a folder the uploader may no longer see (ADR-0078)', async () => {
    vi.mocked(listBatchDocuments).mockResolvedValue([
      makeDocument({ id: 'open', filename: 'EG.pdf', folderId: 'f-open' }),
      makeDocument({ id: 'hidden', filename: 'Honorar.pdf', folderId: 'f-hidden' }),
    ])
    vi.mocked(getProjectFolderAccess).mockResolvedValue({
      ...OPEN,
      hiddenFolderIds: new Set(['f-hidden']),
      isVisible: (folderId) => folderId !== 'f-hidden',
      anyRestricted: true,
    })

    const summary = await getUploadSummary(session, BATCH_ID)

    expect(summary.documents.map((d) => d.filename)).toEqual(['EG.pdf'])
  })

  it("is the uploader's only", async () => {
    vi.mocked(findUploadBatch).mockResolvedValue(batch({ createdBy: 'someone-else' }))
    await expect(getUploadSummary(session, BATCH_ID)).rejects.toBeInstanceOf(NotFoundError)
    expect(listBatchDocuments).not.toHaveBeenCalled()
  })
})

describe('listProjectUploadHistory', () => {
  it('needs project:view and tallies each upload by outcome', async () => {
    vi.mocked(listProjectUploadBatches).mockResolvedValue([batch({ completedAt: new Date() })])
    vi.mocked(countBatchDocumentsByStatus).mockResolvedValue([
      { batchId: BATCH_ID, status: 'completed', count: 2 },
      { batchId: BATCH_ID, status: 'quarantined', count: 1 },
    ])
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([['uploader', { userId: 'uploader', email: null, name: 'Uta Upload', profilePictureUrl: null }]])
    )
    const [entry] = await listProjectUploadHistory(session, 'proj-1')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:view')
    expect(entry?.createdByName).toBe('Uta Upload')
    expect(entry).toMatchObject({ excludedCount: 2, unchangedCount: 1, counts: { ready: 2, quarantined: 1, reading: 0 } })
  })
})
