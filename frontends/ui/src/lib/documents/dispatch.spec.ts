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
import { markDocumentProcessing, setDocumentIngestJob } from './repository'
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

/**
 * The wire join for folders (ADR-0049).
 *
 * The BFF owns `project_folders`; the Python backend has no such table and files
 * each document under the materialised PATH instead. `POST /v1/ingest` is the
 * only call that runs when a document first appears, so this body is where the
 * folder crosses — and a field that one side spells and the other does not is
 * exactly the failure two green suites do not catch.
 *
 * The backend twin is `frontends/aiq_api/tests/test_ingest_folder_path.py`,
 * which asserts the same `folder_path` key reaches the ingest job config.
 */
describe('the ingest dispatch sends the document folder path', () => {
  const bodyOf = (call: number): Record<string, unknown> =>
    JSON.parse(fetchSpy.mock.calls[call][1].body as string) as Record<string, unknown>

  it('sends the folder path the document was filed under', async () => {
    await dispatchDocument({ ...input('plan.pdf'), folderPath: 'Brandschutz/Fluchtwege' })

    expect(bodyOf(0).folder_path).toBe('Brandschutz/Fluchtwege')
  })

  it('sends null for a document at the project root', async () => {
    // Explicitly null rather than omitted: the backend reads absent and null the
    // same way, and stating it keeps the body shape stable across shelves.
    await dispatchDocument(input('plan.pdf'))

    expect(bodyOf(0).folder_path).toBeNull()
  })

  it('carries the folder onto the digest an IFC model produces', async () => {
    // The model is parsed and its Markdown digest is what gets ingested. The
    // digest is the same document to the user, so it belongs in the same folder.
    await dispatchDocument({ ...input('haus.ifc'), folderPath: 'Modelle' })

    const [{ dispatchDigest }] = vi.mocked(runBimExtraction).mock.calls[0]
    await dispatchDigest('org/org-1/project/proj-1/doc/doc-1/_bim/digest.md')

    expect(bodyOf(0).folder_path).toBe('Modelle')
  })
})
