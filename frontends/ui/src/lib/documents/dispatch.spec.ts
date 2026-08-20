/**
 * The one branch that must never be got wrong: what happens to a stored object.
 *
 * An IFC model's STEP source is not a document. Handed to the ingestor it is
 * chunked and embedded as unreadable noise, and the collection reports a green
 * "Ready" for a model nobody can open. Every shelf therefore parses it instead —
 * project uploads, project re-ingests, org-wide Archiv uploads, and (ADR-0047
 * Phase 2) session uploads.
 *
 * That branch used to be copied at each call site. These specs are about the
 * single copy: `dispatchDocument` routes an IFC to extraction and everything
 * else to `/v1/ingest`, and no caller can opt out of the choice because no
 * caller makes it.
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

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

vi.mock('@/lib/bim/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bim/service')>()),
  runBimExtraction: vi.fn().mockResolvedValue({ status: 'ready' }),
}))

vi.mock('./repository', () => ({
  markDocumentProcessing: vi.fn().mockResolvedValue(undefined),
  markDocumentIngestFailed: vi.fn().mockResolvedValue(undefined),
  setDocumentIngestJob: vi.fn().mockResolvedValue(undefined),
  findDocumentInOrg: vi.fn(),
  findFolderPathInProject: vi.fn(),
  findStorageKeyByCollectionAndFilename: vi.fn(),
  listProjectDocuments: vi.fn(),
  deleteProjectDocument: vi.fn(),
}))

import { runBimExtraction } from '@/lib/bim/service'
import { markDocumentProcessing, setDocumentIngestJob, findDocumentInOrg } from './repository'
import { makeDocument } from '@/test-utils/db-fixtures'
import { dispatchDocument, type DispatchDocumentInput } from './service'

const input = (filename: string): DispatchDocumentInput => ({
  organizationId: 'org-1',
  projectId: 'proj-1',
  documentId: 'doc-1',
  filename,
  storageKey: `org/org-1/project/proj-1/doc/doc-1/${filename}`,
  storageBucket: 'test-bucket',
  collectionName: 'proj_abc',
})

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job_id: 'job-1' }) })
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('dispatchDocument', () => {
  /**
   * The invariant the whole agent-authored feature rests on, tested at the ONE
   * place every ingestion path funnels through.
   *
   * It used to be tested in `generated.spec.ts` alone, which proved only that
   * the FILING path does not ingest — a claim about one function, where the
   * design's claim is about the document. `reindexProject`, behind the
   * „Projekt neu indizieren" button, enumerated every document in the project
   * and re-dispatched it; an agent-authored row passed its guard, went into the
   * project's own retrieval collection, and came back out as a green „Bereit"
   * document with „Piloti dazu fragen" enabled. One click, and the model could
   * cite its own writing as Projektwissen.
   */
  it('REFUSES a document a machine wrote, whatever the caller asked for', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ authoredBy: 'agent' }))

    await expect(dispatchDocument(input('bericht.docx'))).rejects.toThrow(
      /must not be indexed/,
    )

    // Nothing left for a retry to pick up, and nothing reached the index.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runBimExtraction).not.toHaveBeenCalled()
    expect(setDocumentIngestJob).not.toHaveBeenCalled()
  })

  it('refuses even when the filename would route to IFC extraction', async () => {
    // The refusal is not a property of the ingest branch — a machine-written
    // `.ifc` must not be parsed into a project's model set either.
    vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ authoredBy: 'agent' }))

    await expect(dispatchDocument(input('haus.ifc'))).rejects.toThrow(/must not be indexed/)
    expect(runBimExtraction).not.toHaveBeenCalled()
  })

  it('lets a document a person uploaded through', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ authoredBy: 'user' }))

    await expect(dispatchDocument(input('plan.pdf'))).resolves.toEqual({
      jobId: 'job-1',
      status: 'pending',
    })
  })

  it('sends an ordinary document to the ingestor', async () => {
    const result = await dispatchDocument(input('plan.pdf'))

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://backend:8000/v1/ingest',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(runBimExtraction).not.toHaveBeenCalled()
    expect(setDocumentIngestJob).toHaveBeenCalledWith('doc-1', 'org-1', 'job-1')
    expect(result).toEqual({ jobId: 'job-1', status: 'pending' })
  })

  it('sends an IFC model to extraction and NEVER to the ingestor', async () => {
    const result = await dispatchDocument(input('haus.ifc'))

    // The whole point. The STEP source must not be embedded as text.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runBimExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', filename: 'haus.ifc' }),
    )
    // Marked in-flight first, so the row never renders a green "Ready" for a
    // model that cannot be opened yet.
    expect(markDocumentProcessing).toHaveBeenCalledWith('doc-1', 'org-1')
    expect(result).toEqual({ jobId: null, status: 'processing' })
  })

  it('routes the uppercase and .ifczip spellings to extraction too', async () => {
    await dispatchDocument(input('HAUS.IFC'))
    await dispatchDocument(input('haus.ifczip'))

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runBimExtraction).toHaveBeenCalledTimes(2)
  })

  it('ingests the digest extraction produces, not the model', async () => {
    await dispatchDocument(input('haus.ifc'))

    const [{ dispatchDigest }] = vi.mocked(runBimExtraction).mock.calls[0]
    await dispatchDigest('org/org-1/project/proj-1/doc/doc-1/_bim/digest.md')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://backend:8000/v1/ingest',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
