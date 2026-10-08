/**
 * Placement's re-reads are bulk work, on every way a document is read
 * (ADR-0079, ADR-0081, ADR-0086).
 *
 * Restricting a large folder re-reads every document in it. Nobody is waiting
 * on those re-reads, so they must queue behind a colleague's upload in the same
 * office and take provider slots only after interactive work. Two halves:
 *
 *   - the request (and the sweep) purges and re-points, and hands the re-read
 *     to ONE `placement_reingest` job, at bulk; it dispatches nothing itself;
 *   - that job dispatches through the real `dispatchDocument`, so each branch a
 *     document can take is checked where it leaves: the `/v1/ingest` body for
 *     an ordinary file, the `bff_job_queue` priority for an IFC model and for a
 *     Word file's rendition.
 *
 * The SQL is `collection-placement.integration.spec.ts`'s subject; here it is
 * the rows it would answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn().mockResolvedValue(undefined) },
  signingS3Client: { send: vi.fn().mockResolvedValue(undefined) },
  bucketAdminS3Client: { send: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://seaweedfs.internal/presigned'),
}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: vi.fn().mockReturnValue('http://backend:8000') }))
vi.mock('@/lib/organizations/service', () => ({ getOrgSettings: vi.fn() }))
vi.mock('@/lib/documents/rendition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/rendition')>()),
  isRenditionEnabled: vi.fn().mockReturnValue(false),
  ensureRendition: vi.fn(),
}))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn().mockResolvedValue({ jobId: 'bff-job-1' }) }))
vi.mock('@/lib/jobs-queue/repository', () => ({ findOpenJobId: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/documents/repository', () => ({
  PLACEMENT_REINGEST_MARKER: 'placementReingest',
  markDocumentProcessing: vi.fn().mockResolvedValue(undefined),
  setDocumentBackgroundJob: vi.fn().mockResolvedValue(undefined),
  markDocumentIngestFailed: vi.fn().mockResolvedValue(undefined),
  setDocumentIngestJob: vi.fn().mockResolvedValue(undefined),
  findDocumentInOrg: vi.fn(),
  findFolderPathInProject: vi.fn(),
}))
vi.mock('@/lib/documents/collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/collection-file-ref')>()),
  purgeIngestedChunks: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn(async (rows: unknown[]) => rows) }))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/project-profile/prompt-view', () => ({ invalidateProjectPromptViewCache: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/documents/placement-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/placement-repository')>()),
  listPlacementRows: vi.fn(),
  repointPlacementRow: vi.fn().mockResolvedValue(true),
  findPlacementFolderPath: vi.fn().mockResolvedValue('Honorare'),
  takeAwaitingPlacementReingest: vi.fn(),
  tagAwaitingPlacementReingest: vi.fn().mockResolvedValue(undefined),
}))

import { getOrgSettings } from '@/lib/organizations/service'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { restrictedCollectionName } from '@/lib/authz/folder-access-rule'
import { isRenditionEnabled } from '@/lib/documents/rendition'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'
import {
  listPlacementRows,
  repointPlacementRow,
  tagAwaitingPlacementReingest,
  takeAwaitingPlacementReingest,
  type PlacementRow,
} from '@/lib/documents/placement-repository'
import { placeProjectDocuments, runPlacementReingestSlice } from './collection-placement'

const ORG = 'org-1'
const PROJECT = 'proj-1'
const COLLECTION = 'proj_abc'
const FOLDER = '0f0f0f0f-1111-4222-8333-444455556666'
const RESTRICTED = restrictedCollectionName(COLLECTION, FOLDER)

const placementRow = (filename: string, overrides: Partial<PlacementRow> = {}): PlacementRow => ({
  id: `doc-${filename}`,
  folderId: FOLDER,
  collectionName: COLLECTION,
  filename,
  status: 'completed',
  errorMessage: null,
  metadata: {},
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  authoredBy: 'user',
  publishedVersionId: null,
  storageKey: `org/${ORG}/project/${PROJECT}/doc/doc-${filename}/${filename}`,
  storageBucket: 'test-bucket',
  ...overrides,
})

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job_id: 'ingest-1' }) })
  vi.stubGlobal('fetch', fetchSpy)
  vi.mocked(getOrgSettings).mockResolvedValue({ displayName: null, defaultLocale: 'de', settings: {} })
  vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ id: PROJECT, collectionName: COLLECTION }))
  // "Honorare" is restricted to one role: its documents belong in its own collection.
  vi.mocked(listProjectFolderTree).mockResolvedValue([
    { id: FOLDER, parentId: null, accessMode: 'custom', grants: [{ role: 'org-geschaeftsfuehrung', level: 'write' }] },
  ])
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(isRenditionEnabled).mockReturnValue(false)
})

describe('a restriction drawn in a request', () => {
  it('purges and re-points in the request, dispatches nothing, and queues ONE bulk re-read job for the project', async () => {
    vi.mocked(listPlacementRows).mockResolvedValueOnce([placementRow('Honorarnote.pdf'), placementRow('Vertrag.pdf')])

    expect(await placeProjectDocuments(ORG, PROJECT)).toEqual({ moved: 2, failed: [], pending: 0 })

    expect(vi.mocked(repointPlacementRow).mock.calls.map(([, row, target, options]) => [row.filename, target, options])).toEqual([
      ['Honorarnote.pdf', RESTRICTED, { reingest: true }],
      ['Vertrag.pdf', RESTRICTED, { reingest: true }],
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    const queued = vi.mocked(enqueueJob).mock.calls[0][0]
    expect(queued).toMatchObject({ kind: 'placement_reingest', organizationId: ORG, payload: { projectId: PROJECT } })
    // The queue's default, which is bulk (`enqueueJob`); never stated interactive.
    expect(queued.priority).toBeUndefined()
    expect(tagAwaitingPlacementReingest).toHaveBeenCalledWith(ORG, PROJECT, 'bff-job-1')
  })

  it('reuses the project’s job that no worker has started, and queues none when nothing was handed off', async () => {
    vi.mocked(findOpenJobId).mockResolvedValueOnce('bff-job-waiting')
    vi.mocked(listPlacementRows).mockResolvedValueOnce([placementRow('Honorarnote.pdf')])

    await placeProjectDocuments(ORG, PROJECT)

    expect(findOpenJobId).toHaveBeenCalledWith({
      kind: 'placement_reingest',
      organizationId: ORG,
      matching: { projectId: PROJECT },
      notStarted: true,
    })
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(tagAwaitingPlacementReingest).toHaveBeenCalledWith(ORG, PROJECT, 'bff-job-waiting')

    vi.mocked(findOpenJobId).mockClear()
    vi.mocked(listPlacementRows).mockResolvedValueOnce([])
    await placeProjectDocuments(ORG, PROJECT)
    expect(findOpenJobId).not.toHaveBeenCalled()
  })
})

describe('the placement_reingest job dispatches every branch at bulk priority', () => {
  const slice = () => runPlacementReingestSlice(ORG, { projectId: PROJECT })
  const taken = (row: PlacementRow) => {
    vi.mocked(takeAwaitingPlacementReingest).mockResolvedValueOnce([{ ...row, collectionName: RESTRICTED, status: 'processing' }])
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        id: row.id,
        filename: row.filename,
        contentType: null,
        authoredBy: 'user',
        storageKey: row.storageKey ?? undefined,
        status: 'processing',
      })
    )
  }

  it('an ordinary file: `priority: "bulk"` in the /v1/ingest body, into the folder’s collection', async () => {
    taken(placementRow('Honorarnote.pdf'))

    expect(await slice()).toEqual({ done: true, payload: { projectId: PROJECT } })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/ingest')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ priority: 'bulk', collection: RESTRICTED, folder_path: 'Honorare' })
  })

  it('an IFC model: its bim_extract job is queued bulk', async () => {
    taken(placementRow('haus.ifc'))

    await slice()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(vi.mocked(enqueueJob).mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'bim_extract',
      priority: 1,
      payload: expect.objectContaining({ priority: 'bulk', collectionName: RESTRICTED }),
    })
  })

  it('a Word file read from its rendition: its office_rendition job is queued bulk', async () => {
    vi.mocked(isRenditionEnabled).mockReturnValue(true)
    taken(placementRow('Baubeschreibung.docx'))

    await slice()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(vi.mocked(enqueueJob).mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'office_rendition',
      priority: 1,
      payload: expect.objectContaining({ priority: 'bulk', collectionName: RESTRICTED }),
    })
  })

  it('re-points a row whose folder changed collection while it waited, and dispatches it there', async () => {
    // The restriction was lifted before the job ran: the row belongs in the open collection now.
    vi.mocked(listProjectFolderTree).mockResolvedValue([{ id: FOLDER, parentId: null, accessMode: 'inherit', grants: [] }])
    taken(placementRow('Honorarnote.pdf'))

    await slice()

    expect(repointPlacementRow).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ collectionName: RESTRICTED }),
      COLLECTION,
      { reingest: false }
    )
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({
      priority: 'bulk',
      collection: COLLECTION,
    })
  })

  it('goes on while a slice takes a full page', async () => {
    vi.mocked(takeAwaitingPlacementReingest).mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) => placementRow(`Plan-${i}.pdf`, { collectionName: RESTRICTED, storageKey: null }))
    )

    expect((await slice()).done).toBe(false)
  })
})
