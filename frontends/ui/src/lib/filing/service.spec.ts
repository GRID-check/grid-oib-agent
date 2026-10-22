/**
 * @vitest-environment node
 *
 * The filing review's gates, around a judgement that is mocked: what reaches
 * the model, and what becomes a proposal. The rules over the moves themselves
 * are `./plan.spec.ts`; the model's answer, `./judge.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { DEFAULT_UPLOAD_BATCH_EFFECTS, type Document, type UploadBatch } from '@/lib/db/schema'
import type { ProjectFolderRow } from '@/lib/projects/folder-service'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/upload-batches/repository', () => ({ findUploadBatch: vi.fn(), listBatchDocuments: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn(), listProjectsInOrg: vi.fn() }))
vi.mock('@/lib/projects/service', () => ({ projectsHolding: vi.fn() }))
vi.mock('@/lib/projects/folder-service', () => ({ listProjectFolders: vi.fn() }))
vi.mock('@/lib/office-shelf/folder-service', () => ({ listOfficeShelfFolders: vi.fn() }))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn() }))
vi.mock('@/lib/proposals/service', () => ({
  createProposal: vi.fn(),
  listShelfFileProposals: vi.fn(),
  withdrawProposal: vi.fn(),
}))
vi.mock('./repository', () => ({ listFiledDocuments: vi.fn(), listProjectsFolders: vi.fn() }))
vi.mock('./judge', () => ({ judgeFiling: vi.fn() }))

import { listOfficeShelfFolders } from '@/lib/office-shelf/folder-service'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { listProjectFolders } from '@/lib/projects/folder-service'
import { findProjectInOrg, listProjectsInOrg } from '@/lib/projects/repository'
import { projectsHolding } from '@/lib/projects/service'
import { createProposal, listShelfFileProposals, withdrawProposal } from '@/lib/proposals/service'
import { findUploadBatch, listBatchDocuments } from '@/lib/upload-batches/repository'
import { judgeFiling } from './judge'
import { listFiledDocuments, listProjectsFolders } from './repository'
import { reviewUploadFiling } from './service'
import type { FilingJudgementInput } from './types'

const SESSION: AuthorizedSession = {
  userId: 'uploader',
  email: 'a@buero.at',
  name: 'Anna',
  accessToken: '',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const batch = (overrides: Partial<UploadBatch> = {}): UploadBatch => ({
  id: 'batch-1',
  organizationId: 'org-1',
  createdBy: 'uploader',
  scope: 'project',
  projectId: 'proj-1',
  conversationId: null,
  expectedCount: 3,
  excluded: [],
  unchangedCount: 0,
  failedCount: 0,
  sealedAt: new Date('2026-10-01T10:00:00Z'),
  completedAt: null,
  createdAt: new Date('2026-10-01T09:59:00Z'),
  ...DEFAULT_UPLOAD_BATCH_EFFECTS,
  ...overrides,
})

const folder = (id: string, path: string, description: string | null = null): ProjectFolderRow => ({
  id,
  projectId: 'proj-1',
  parentId: null,
  name: path,
  path,
  description,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ownAccess: null,
  access: 'write',
})

const FOLDERS = [folder('f-bescheide', 'Bescheide', 'Bescheide der Behörden'), folder('f-honorare', 'Honorare')]

const doc = (id: string, filename: string, overrides: Partial<Document> = {}) =>
  makeDocument({ id, filename, folderId: null, uploadBatchId: 'batch-1', ...overrides })

const judgedInput = (): FilingJudgementInput => vi.mocked(judgeFiling).mock.calls[0][1]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findUploadBatch).mockResolvedValue(batch())
  vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ id: 'proj-1', status: 'active' }))
  vi.mocked(listProjectFolders).mockResolvedValue(FOLDERS)
  vi.mocked(listOfficeShelfFolders).mockResolvedValue([])
  // „Honorare" has an own access list: not every member reads it.
  vi.mocked(listProjectFolderTree).mockResolvedValue([
    { id: 'f-bescheide', parentId: null, accessMode: 'inherit', everyoneReads: false },
    { id: 'f-honorare', parentId: null, accessMode: 'custom', everyoneReads: false },
  ])
  vi.mocked(listBatchDocuments).mockResolvedValue([
    doc('d1', 'MA37_Bescheid.pdf'),
    doc('d2', 'Honorarnote.pdf', { folderId: 'f-honorare' }),
  ])
  vi.mocked(reconcileDocumentStatuses).mockImplementation(async (rows) => rows)
  vi.mocked(listFiledDocuments).mockResolvedValue([])
  vi.mocked(listProjectsInOrg).mockResolvedValue([])
  vi.mocked(projectsHolding).mockResolvedValue([])
  vi.mocked(listProjectsFolders).mockResolvedValue([])
  vi.mocked(listShelfFileProposals).mockResolvedValue([])
  vi.mocked(judgeFiling).mockResolvedValue({
    moves: [{ documentId: 'd1', folder: 'Bescheide', reason: 'Ein Bescheid der MA 37.', newFolder: null, confidence: null }],
    traceId: 'trace-1',
    error: null,
  })
})

describe('reviewUploadFiling', () => {
  it('files one proposal per target folder, on the project, with no conversation, as the uploader', async () => {
    const outcome = await reviewUploadFiling(SESSION, 'batch-1', 'name')
    expect(outcome).toMatchObject({ status: 'judged', proposed: 1, withdrawn: 0 })
    expect(createProposal).toHaveBeenCalledTimes(1)
    expect(createProposal).toHaveBeenCalledWith(SESSION, {
      projectId: 'proj-1',
      kind: 'file_operation',
      payload: {
        operation: 'move',
        operations: [
          { document: 'MA37_Bescheid.pdf', source: 'project', target_folder: 'Bescheide', reason: 'Ein Bescheid der MA 37.' },
        ],
        basis: 'name',
        new_folder: null,
      },
      conversationId: null,
      answerMessageId: null,
      originTraceId: 'trace-1',
    })
  })

  it('never sends a restricted folder, nor a document filed in one, to the model', async () => {
    await reviewUploadFiling(SESSION, 'batch-1', 'name')
    const input = judgedInput()
    expect(input.folders.map((entry) => entry.path)).toEqual(['Bescheide'])
    expect(input.documents.map((entry) => entry.id)).toEqual(['d1'])
    expect(input.folders[0].description).toBe('Bescheide der Behörden')
    expect(input.trace).toEqual({ batchId: 'batch-1', projectId: 'proj-1', shelf: 'project' })
  })

  it('judges by name only at the seal: no summary, no tags', async () => {
    vi.mocked(listBatchDocuments).mockResolvedValue([doc('d1', 'MA37_Bescheid.pdf')])
    await reviewUploadFiling(SESSION, 'batch-1', 'name')
    expect(judgedInput().documents).toEqual([
      { id: 'd1', file: 'MA37_Bescheid.pdf', folder: '', type: null, tags: [], summary: null },
    ])
  })

  it('judges from what ingestion read only for documents whose screening passed', async () => {
    vi.mocked(findUploadBatch).mockResolvedValue(batch({ completedAt: new Date('2026-10-01T10:05:00Z') }))
    vi.mocked(listBatchDocuments).mockResolvedValue([
      doc('d1', 'MA37_Bescheid.pdf'),
      doc('d3', 'Lohnzettel.pdf', { status: 'quarantined', screeningOutcome: 'quarantined' }),
      doc('d4', 'Noch.pdf', { status: 'processing' }),
    ])
    vi.mocked(reconcileDocumentStatuses).mockImplementation(async (rows) =>
      rows.map((row) => ({ ...row, tags: ['Bescheid', 'Brandschutz'], summary: 'Baubewilligung' }))
    )
    await reviewUploadFiling(SESSION, 'batch-1', 'content')
    expect(judgedInput().documents).toEqual([
      { id: 'd1', file: 'MA37_Bescheid.pdf', folder: '', type: 'Bescheid', tags: ['Brandschutz'], summary: 'Baubewilligung' },
    ])
  })

  it('proposes nothing on a closed project and asks no model', async () => {
    vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ id: 'proj-1', status: 'closed' }))
    expect(await reviewUploadFiling(SESSION, 'batch-1', 'name')).toMatchObject({ status: 'skipped', reason: 'project-closed' })
    expect(judgeFiling).not.toHaveBeenCalled()
    expect(createProposal).not.toHaveBeenCalled()
  })

  it('leaves a chat’s attachments, a batch that is not the uploader’s, and a read batch at the seal alone', async () => {
    vi.mocked(findUploadBatch).mockResolvedValueOnce(batch({ scope: 'session', projectId: null }))
    expect((await reviewUploadFiling(SESSION, 'batch-1', 'name')).reason).toBe('chat-attachments')
    vi.mocked(findUploadBatch).mockResolvedValueOnce(batch({ createdBy: 'someone-else' }))
    expect((await reviewUploadFiling(SESSION, 'batch-1', 'name')).reason).toBe('not-the-uploaders-batch')
    vi.mocked(findUploadBatch).mockResolvedValueOnce(batch({ completedAt: new Date() }))
    expect((await reviewUploadFiling(SESSION, 'batch-1', 'name')).reason).toBe('already-read')
    expect(judgeFiling).not.toHaveBeenCalled()
  })

  it('proposes nothing when the judgement failed', async () => {
    vi.mocked(judgeFiling).mockResolvedValue({ moves: [], traceId: null, error: 'llm_not_configured' })
    expect(await reviewUploadFiling(SESSION, 'batch-1', 'name')).toMatchObject({ status: 'failed', proposed: 0 })
    expect(createProposal).not.toHaveBeenCalled()
    expect(withdrawProposal).not.toHaveBeenCalled()
  })

  it('does not propose again what a person dismissed', async () => {
    vi.mocked(listShelfFileProposals).mockResolvedValue([
      {
        id: 'p-dismissed',
        status: 'dismissed',
        typed: {
          kind: 'file_operation',
          payload: {
            operation: 'move',
            operations: [{ document: 'MA37_Bescheid.pdf', source: 'project', target_folder: 'Bescheide' }],
            basis: 'name',
          },
        },
        originConversationId: null,
        claimed: false,
      },
    ])
    expect(await reviewUploadFiling(SESSION, 'batch-1', 'name')).toMatchObject({ status: 'judged', proposed: 0 })
    expect(createProposal).not.toHaveBeenCalled()
  })

  it('files a Büroablage upload on the office shelf, with no project and no conventions', async () => {
    vi.mocked(findUploadBatch).mockResolvedValue(batch({ scope: 'office_shelf', projectId: null }))
    vi.mocked(listOfficeShelfFolders).mockResolvedValue([{ ...FOLDERS[0], projectId: null }])
    await reviewUploadFiling(SESSION, 'batch-1', 'name')
    expect(judgedInput().conventions).toEqual([])
    expect(judgedInput().trace.shelf).toBe('office_shelf')
    expect(createProposal).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        projectId: null,
        payload: expect.objectContaining({
          operations: [expect.objectContaining({ source: 'office', target_folder: 'Bescheide' })],
        }),
      })
    )
  })

  it('learns the Austrian default when the office has no other project, minus what the project has', async () => {
    await reviewUploadFiling(SESSION, 'batch-1', 'name')
    const paths = judgedInput().conventions.map((entry) => entry.path)
    expect(paths).toContain('Behörde und Bescheide')
    expect(paths).not.toContain('Bescheide')
  })
})
