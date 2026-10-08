/**
 * The one branch that must never be got wrong: what happens to a stored object.
 *
 * An IFC model's STEP source is not a document. Handed to the ingestor it is
 * chunked and embedded as unreadable noise, and the collection reports a green
 * "Ready" for a model nobody can open. Every shelf therefore parses it instead —
 * project uploads, project re-ingests, org-wide Archiv uploads, and (ADR-0047
 * Phase 2) session uploads.
 *
 * The branch lives at one call site, not copied per caller. These specs are
 * about that single copy: `dispatchDocument` routes an IFC to extraction and
 * everything else to `/v1/ingest`, and no caller can opt out of the choice
 * because no caller makes it.
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

// The organization's upload-screening policy (ADR-0079) is read through its
// settings row; each test states the row it means.
vi.mock('@/lib/organizations/service', () => ({ getOrgSettings: vi.fn() }))

// The converter is `rendition.spec.ts`'s subject; here it is a switch and an
// outcome, so what is under test is what dispatch does with each.
vi.mock('./rendition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rendition')>()),
  isRenditionEnabled: vi.fn().mockReturnValue(false),
  ensureRendition: vi.fn(),
}))

import { runBimExtraction } from '@/lib/bim/service'
import { invalidateCached } from '@/lib/cache'
import { getOrgSettings } from '@/lib/organizations/service'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { RenditionFailedError, ensureRendition, isRenditionEnabled } from './rendition'
import {
  findDocumentInOrg,
  markDocumentIngestFailed,
  markDocumentProcessing,
  setDocumentIngestJob,
} from './repository'
import { makeDocument } from '@/test-utils/db-fixtures'
import { RENDITION_REQUIRED_MESSAGE, dispatchDocument, type DispatchDocumentInput } from './service'

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
  // An ordinary human upload, before every test. `vi.clearAllMocks()` clears
  // calls and not implementations, so without this a row set by one test is
  // still the row the next one reads — which is how a suite comes to depend on
  // the order its cases happen to run in.
  vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ authoredBy: 'user' }))
  vi.mocked(getOrgSettings).mockResolvedValue({ displayName: null, defaultLocale: 'de', settings: {} })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('dispatchDocument', () => {
  /**
   * The invariant the whole agent-authored feature rests on, tested at the ONE
   * place every ingestion path funnels through. Testing the filing path alone
   * would prove only that filing does not ingest, a claim about one function,
   * where the design's claim is about the document. `reindexProject`, behind the
   * „Projekt neu indizieren" button, enumerates every document in the project
   * and re-dispatches it, so an agent-authored row must be refused here as well:
   * otherwise it goes into the project's own retrieval collection, comes back as
   * a green „Bereit" document with „Piloti dazu fragen" enabled, and one click
   * lets the model cite its own writing as Projektwissen.
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

  /**
   * The published-version clause (ADR-0054), and what it deliberately does not
   * cover.
   *
   * The rule is a COMPARISON — `published_version_id === the dispatched
   * version` — rather than a list of allowed states, which is why every state a
   * version can be in that is not "the published one" fails here without being
   * enumerated in the production code. Enumerating them in the SPEC is the
   * point: a reader has to be able to see that `approved` (approved on Tuesday,
   * not yet issued) is refused exactly as `draft` is.
   */
  describe('the published-version clause', () => {
    const agentRow = (publishedVersionId: string | null) =>
      makeDocument({
        authoredBy: 'agent',
        authoredByProducer: 'agent_document',
        authoredByRef: 'conv_1-aktenvermerk',
        authoredByRefKind: 'answer_artifact',
        filename: 'piloti/doc-1/aktenvermerk-2026-09-01.md',
        publishedVersionId,
      })

    it('admits the published version of an agent-authored document', async () => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentRow('ver_2'))

      await expect(
        dispatchDocument({ ...input('aktenvermerk.md'), versionId: 'ver_2' }),
      ).resolves.toEqual({ jobId: 'job-1', status: 'pending' })
    })

    /**
     * Every state that is not the published version, by the id it dispatches
     * with. A draft, an in-review version, a changes-requested one, an approved
     * one and a rejected one are all versions the row's pointer does not name;
     * a superseded one is the version the pointer named until the last publish
     * moved it. The pointer is `null` while nothing has ever been published,
     * which is the first five rows.
     */
    const refused: Array<[string, string | null, string | null]> = [
      ['a draft, before anything was ever published', null, 'ver_1'],
      ['an in-review version', null, 'ver_1'],
      ['a changes-requested version', null, 'ver_1'],
      ['a rejected version', null, 'ver_1'],
      ['an approved version that nobody has published yet', null, 'ver_2'],
      ['a superseded version, after the pointer moved on', 'ver_3', 'ver_2'],
      ['a draft alongside a published version', 'ver_2', 'ver_3'],
      ['a caller that names no version at all (a re-index)', 'ver_2', null],
    ]

    it.each(refused)('refuses %s', async (_case, pointer, dispatched) => {
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentRow(pointer))

      await expect(
        dispatchDocument({ ...input('aktenvermerk.md'), versionId: dispatched }),
      ).rejects.toThrow(/must not be indexed/)

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(setDocumentIngestJob).not.toHaveBeenCalled()
    })

    it('does not let a caller assert the pointer: the ROW decides', async () => {
      // The version id travels in the input because the row cannot supply it —
      // "are these the published version's bytes" is not a question a row
      // answers alone. What the row DOES supply is the pointer, and a caller
      // naming a version the row does not point at is refused however
      // plausible the id looks.
      vi.mocked(findDocumentInOrg).mockResolvedValue(agentRow(null))

      await expect(
        dispatchDocument({ ...input('aktenvermerk.md'), versionId: 'ver_2' }),
      ).rejects.toThrow(/must not be indexed/)
    })

    it('leaves a human upload admitted with no version named at all', async () => {
      // Every upload shelf and every re-ingest dispatches without a version.
      // The clause applies to machine-authored rows and leaves a person's alone.
      vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ authoredBy: 'user' }))

      await expect(dispatchDocument(input('plan.pdf'))).resolves.toEqual({
        jobId: 'job-1',
        status: 'pending',
      })
    })
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

  it('signs file_ref and the thumbnail slot for a day: the queued JOB uses them, not the request', async () => {
    // `/v1/ingest` hands the job a deferred download and answers at once; the
    // job may start hours after dispatch behind a folder upload on the
    // two-worker ingest pool, and an expired signature fails the document as
    // `original_download_failed` although nothing is wrong with it.
    await dispatchDocument(input('plan.pdf'))

    const signed = vi.mocked(getSignedUrl).mock.calls
    const originalRead = signed.find(
      ([, command]) =>
        (command as { input: { Key: string } }).input.Key === input('plan.pdf').storageKey &&
        command.constructor.name === 'GetObjectCommand',
    )
    const thumbnailWrite = signed.find(([, command]) => command.constructor.name === 'PutObjectCommand')
    expect(originalRead?.[2]).toEqual({ expiresIn: 86_400 })
    expect(thumbnailWrite?.[2]).toEqual({ expiresIn: 86_400 })
  })

  it('sends the folder path the document was filed under', async () => {
    await dispatchDocument({ ...input('plan.pdf'), folderPath: 'Brandschutz/Fluchtwege' })

    expect(bodyOf(0).folder_path).toBe('Brandschutz/Fluchtwege')
  })

  it('states the row’s own filename as the chunk join key', async () => {
    // Without it the backend derives the name from the presigned URL's last
    // path segment — the OBJECT KEY's basename, which `storageKeySegment` has
    // already sanitised. For a namespaced Piloti document those are different
    // strings, and chunks filed under the derived one are chunks no purge can
    // ever address, because every purge asks by `documents.filename`.
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        authoredBy: 'agent',
        authoredByProducer: 'agent_document',
        authoredByRef: 'conv_1-x',
        authoredByRefKind: 'answer_artifact',
        filename: 'piloti/doc-1/aktenvermerk-2026-09-01.md',
        publishedVersionId: 'ver_2',
      }),
    )

    await dispatchDocument({ ...input('aktenvermerk.md'), versionId: 'ver_2' })

    expect(bodyOf(0).file_name).toBe('piloti/doc-1/aktenvermerk-2026-09-01.md')
  })

  it('sends the four provenance keys for a published Piloti document', async () => {
    // The backend twin is `frontends/aiq_api/tests/test_ingest_provenance.py`,
    // which asserts the same four keys reach the ingest job config. They are
    // spelled in `src/aiq_agent/common/provenance.py` and nowhere else.
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({
        authoredBy: 'agent',
        authoredByProducer: 'agent_document',
        authoredByRef: 'conv_1-x',
        authoredByRefKind: 'answer_artifact',
        filename: 'piloti/doc-1/aktenvermerk-2026-09-01.md',
        publishedVersionId: 'ver_2',
      }),
    )

    await dispatchDocument({
      ...input('aktenvermerk.md'),
      versionId: 'ver_2',
      provenance: {
        authored_by: 'agent',
        approved_by: 'Maria Huber',
        approved_at: '2026-09-01T10:00:00.000Z',
        producer: 'agent_document',
      },
    })

    expect(bodyOf(0)).toMatchObject({
      authored_by: 'agent',
      approved_by: 'Maria Huber',
      approved_at: '2026-09-01T10:00:00.000Z',
      producer: 'agent_document',
    })
  })

  it('sends no provenance keys for a human document', async () => {
    await dispatchDocument(input('plan.pdf'))

    // Absent, not null-valued: `parse_agent_provenance` returns None for
    // anything unmarked, and every human document must stay byte-for-byte what
    // it was through the whole pipeline.
    const body = bodyOf(0)
    expect(body).not.toHaveProperty('authored_by')
    expect(body).not.toHaveProperty('approved_by')
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

/**
 * An office file is converted before it is ingested, detached (ADR-0070,
 * ADR-0071). The PDF feeds the thumbnail (`preview_ref`) and, for Word and
 * presentation formats, the indexed text (`extraction_ref`). The rendition is a
 * convenience beside a durable file, so every way it can fail must leave the
 * ingest exactly as it was before conversion existed.
 */
describe('an office file is converted, detached, before it is ingested', () => {
  const bodyOf = (call: number): Record<string, unknown> =>
    JSON.parse(fetchSpy.mock.calls[call][1].body as string) as Record<string, unknown>
  const RENDITION_KEY = 'org/org-1/project/proj-1/doc/doc-1/_render.pdf'
  const RENDITION_URL = 'https://seaweedfs.internal/rendition'
  const ORIGINAL_URL = 'https://seaweedfs.internal/presigned'
  const officeRow = (filename: string, contentType: string | null = null) =>
    makeDocument({ authoredBy: 'user', filename, contentType })
  /** The background half has POSTed. */
  const ingested = () => vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

  beforeEach(() => {
    vi.mocked(isRenditionEnabled).mockReturnValue(true)
    vi.mocked(ensureRendition).mockReset().mockResolvedValue(RENDITION_KEY)
    vi.mocked(getSignedUrl).mockImplementation(async (_client, command) =>
      (command as { input: { Key: string } }).input.Key === RENDITION_KEY ? RENDITION_URL : ORIGINAL_URL,
    )
    vi.mocked(findDocumentInOrg).mockResolvedValue(officeRow('Baubeschreibung.docx'))
  })

  afterEach(() => {
    // `clearAllMocks` keeps implementations; put the module defaults back so no
    // later case inherits the rendition-aware signer or a failing write.
    vi.mocked(getSignedUrl).mockResolvedValue(ORIGINAL_URL)
    vi.mocked(isRenditionEnabled).mockReturnValue(false)
    vi.mocked(setDocumentIngestJob).mockResolvedValue(undefined)
  })

  it('answers `processing` at once, without waiting on the converter', async () => {
    // A conversion that never finishes: the upload must not be what waits.
    vi.mocked(ensureRendition).mockReturnValue(new Promise<string>(() => undefined))

    await expect(dispatchDocument(input('Baubeschreibung.docx'))).resolves.toEqual({
      jobId: null,
      status: 'processing',
    })
    // Marked in flight first, so the row never renders a green "Ready" for a
    // file nothing has been dispatched for yet.
    expect(markDocumentProcessing).toHaveBeenCalledWith('doc-1', 'org-1')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('indexes a Word file from its rendition: preview_ref AND extraction_ref', async () => {
    await dispatchDocument(input('Baubeschreibung.docx'))
    await ingested()

    expect(ensureRendition).toHaveBeenCalledWith({
      bucket: 'test-bucket',
      storageKey: 'org/org-1/project/proj-1/doc/doc-1/Baubeschreibung.docx',
      filename: 'Baubeschreibung.docx',
    })
    // Converted BEFORE the POST: the backend fetches it as part of the job.
    expect(vi.mocked(ensureRendition).mock.invocationCallOrder[0]).toBeLessThan(
      fetchSpy.mock.invocationCallOrder[0],
    )
    expect(bodyOf(0)).toMatchObject({
      preview_ref: RENDITION_URL,
      extraction_ref: RENDITION_URL,
      // The original is still what `file_ref` names, and the chunks keep the
      // row's name: only the bytes extracted come from the PDF.
      file_ref: ORIGINAL_URL,
      file_name: 'Baubeschreibung.docx',
    })
    await vi.waitFor(() => expect(setDocumentIngestJob).toHaveBeenCalledWith('doc-1', 'org-1', 'job-1'))
    // The rendition is read by the same queued job, so it lives as long as file_ref.
    const renditionRead = vi
      .mocked(getSignedUrl)
      .mock.calls.find(([, command]) => (command as { input: { Key: string } }).input.Key === RENDITION_KEY)
    expect(renditionRead?.[2]).toEqual({ expiresIn: 86_400 })
  })

  it('keeps a workbook on its own extractor: preview_ref only', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(officeRow('Kostenschätzung.xlsx'))

    await dispatchDocument(input('Kostenschätzung.xlsx'))
    await ingested()

    expect(bodyOf(0).preview_ref).toBe(RENDITION_URL)
    expect(bodyOf(0).extraction_ref).toBeNull()
  })

  it('fails a Word file whose PDF cannot be made, and never reads the original instead', async () => {
    // The rendition is its only source (ADR-0071): a converter outage is a
    // failure the reader can retry, not a quietly worse index.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(ensureRendition).mockRejectedValue(new RenditionFailedError('Office conversion answered 503'))

    await expect(dispatchDocument(input('Baubeschreibung.docx'))).resolves.toEqual({
      jobId: null,
      status: 'processing',
    })

    await vi.waitFor(() =>
      expect(markDocumentIngestFailed).toHaveBeenCalledWith('doc-1', 'org-1', RENDITION_REQUIRED_MESSAGE),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still ingests a workbook whose PDF cannot be made: it only loses the thumbnail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(findDocumentInOrg).mockResolvedValue(officeRow('Kostenschätzung.xlsx'))
    vi.mocked(ensureRendition).mockRejectedValue(new RenditionFailedError('Office conversion answered 503'))

    await dispatchDocument(input('Kostenschätzung.xlsx'))
    await ingested()

    expect(bodyOf(0).preview_ref).toBeNull()
    expect(bodyOf(0).extraction_ref).toBeNull()
    expect(markDocumentIngestFailed).not.toHaveBeenCalled()
  })

  it('marks the row failed when the background throws around the dispatch', async () => {
    // `dispatchIngest` records its own failures; a write that throws after the
    // POST is what the catch-all exists for, so the row does not sit at
    // `processing` with nobody left to move it.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(setDocumentIngestJob).mockRejectedValue(new Error('database gone'))

    await dispatchDocument(input('Baubeschreibung.docx'))

    await vi.waitFor(() =>
      expect(markDocumentIngestFailed).toHaveBeenCalledWith('doc-1', 'org-1', expect.any(String)),
    )
  })

  it('decides on the row’s stored type too, not only its extension', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      officeRow('Baubeschreibung', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    )

    await expect(dispatchDocument(input('Baubeschreibung'))).resolves.toMatchObject({ status: 'processing' })
    await ingested()
    expect(bodyOf(0).preview_ref).toBe(RENDITION_URL)
  })

  it('fails a Word file at once when no converter is configured', async () => {
    vi.mocked(isRenditionEnabled).mockReturnValue(false)

    await expect(dispatchDocument(input('Baubeschreibung.docx'))).resolves.toEqual({
      jobId: null,
      status: 'failed',
    })
    expect(markDocumentIngestFailed).toHaveBeenCalledWith('doc-1', 'org-1', RENDITION_REQUIRED_MESSAGE)
    expect(ensureRendition).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ingests a workbook synchronously, as before, when no converter is configured', async () => {
    vi.mocked(isRenditionEnabled).mockReturnValue(false)
    vi.mocked(findDocumentInOrg).mockResolvedValue(officeRow('Kostenschätzung.xlsx'))

    await expect(dispatchDocument(input('Kostenschätzung.xlsx'))).resolves.toEqual({
      jobId: 'job-1',
      status: 'pending',
    })
    expect(bodyOf(0).preview_ref).toBeNull()
    expect(bodyOf(0).extraction_ref).toBeNull()
  })

  it('does not convert a PDF, nor a real PDF that happens to be named .docx', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(officeRow('plan.pdf', 'application/pdf'))
    await expect(dispatchDocument(input('plan.pdf'))).resolves.toEqual({ jobId: 'job-1', status: 'pending' })

    vi.mocked(findDocumentInOrg).mockResolvedValue(officeRow('Bericht.docx', 'application/pdf'))
    await expect(dispatchDocument(input('Bericht.docx'))).resolves.toEqual({ jobId: 'job-1', status: 'pending' })

    expect(ensureRendition).not.toHaveBeenCalled()
    expect(markDocumentProcessing).not.toHaveBeenCalled()
    expect(bodyOf(0).preview_ref).toBeNull()
  })

  it('still refuses a machine-written document before anything is converted', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ authoredBy: 'agent', filename: 'piloti/doc-1/bericht.docx' }),
    )

    await expect(dispatchDocument(input('bericht.docx'))).rejects.toThrow(/must not be indexed/)
    expect(markDocumentProcessing).not.toHaveBeenCalled()
    expect(ensureRendition).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

/**
 * A timeout is the one dispatch outcome that leaves the backend's side unknown.
 *
 * The backend may still be downloading when the ten-second budget runs out and
 * start the job afterwards, so a timeout cannot be recorded as a failure without
 * risking a false one, and a duplicate once someone retries. `/v1/ingest` is
 * idempotent per document and object, so the dispatch sends the same request
 * once more and takes whichever job id comes back. The backend twin is the
 * idempotency block at the end of `frontends/aiq_api/tests/test_ingest.py`.
 */
describe('the ingest dispatch after a timeout', () => {
  const timeout = () =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })

  it('asks once more and records the job the backend holds', async () => {
    fetchSpy
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ job_id: 'job-live' }) })

    await expect(dispatchDocument(input('plan.pdf'))).resolves.toEqual({
      jobId: 'job-live',
      status: 'pending',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // The same request, so the backend can recognise it.
    expect(fetchSpy.mock.calls[1][1].body).toBe(fetchSpy.mock.calls[0][1].body)
    expect(setDocumentIngestJob).toHaveBeenCalledWith('doc-1', 'org-1', 'job-live')
    expect(markDocumentIngestFailed).not.toHaveBeenCalled()
  })

  it('records a failure only when the second attempt times out too', async () => {
    fetchSpy.mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout())

    await expect(dispatchDocument(input('plan.pdf'))).resolves.toEqual({
      jobId: null,
      status: 'failed',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(markDocumentIngestFailed).toHaveBeenCalledWith(
      'doc-1',
      'org-1',
      'Ingestion could not be started'
    )
  })

  it('does not retry a failure the backend reported', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })

    await expect(dispatchDocument(input('plan.pdf'))).resolves.toEqual({
      jobId: null,
      status: 'failed',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(markDocumentIngestFailed).toHaveBeenCalled()
  })

  it('does not retry a connection that never reached the backend', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(dispatchDocument(input('plan.pdf'))).resolves.toEqual({
      jobId: null,
      status: 'failed',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

/**
 * ADR-0079: every path into the index carries the office's content rules, so
 * the ingest job can quarantine a match before its first model call. Tested at
 * the choke point, for the same reason as the authorship refusal above: a
 * caller cannot forget what it never has to supply.
 */
describe('dispatchDocument — upload screening', () => {
  const sentBody = (): Record<string, unknown> =>
    JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>

  beforeEach(async () => {
    await invalidateCached('upload-screening:org-1')
  })

  it("sends the suggested content rules for an office that never saved a policy", async () => {
    await dispatchDocument(input('Baubeschreibung.pdf'))
    const screening = sentBody().screening as { content_terms: string[]; detectors: string[] }
    expect(screening.detectors).toEqual(['iban', 'at_svnr', 'credit_card'])
    expect(screening.content_terms).toContain('Gehaltsabrechnung')
  })

  it("sends the office's own rules once it saved them", async () => {
    vi.mocked(getOrgSettings).mockResolvedValue({
      displayName: null,
      defaultLocale: 'de',
      settings: {
        uploadScreening: {
          enabled: true,
          nameTerms: [],
          nameExceptions: [],
          contentTerms: ['Projektkalkulation'],
          detectors: ['iban'],
        },
      },
    })
    await dispatchDocument(input('Baubeschreibung.pdf'))
    expect(sentBody().screening).toEqual({ content_terms: ['Projektkalkulation'], detectors: ['iban'] })
  })

  it('sends no rules when the office switched screening off', async () => {
    vi.mocked(getOrgSettings).mockResolvedValue({
      displayName: null,
      defaultLocale: 'de',
      settings: {
        uploadScreening: { enabled: false, nameTerms: [], nameExceptions: [], contentTerms: ['x y'], detectors: [] },
      },
    })
    await dispatchDocument(input('Baubeschreibung.pdf'))
    expect(sentBody().screening).toBeNull()
  })

  it('skips screening only for the exact bytes a reviewer released', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ authoredBy: 'user', contentHash: 'sha256:aaa', screeningReleasedHash: 'sha256:aaa' })
    )
    await dispatchDocument(input('Honorar.pdf'))
    expect(sentBody().screening).toBeNull()
  })

  it('screens a re-upload under a released id, because its bytes are new', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ authoredBy: 'user', contentHash: 'sha256:bbb', screeningReleasedHash: 'sha256:aaa' })
    )
    await dispatchDocument(input('Honorar.pdf'))
    expect(sentBody().screening).not.toBeNull()
  })

  it('fails closed when the policy cannot be read: screens with the suggestion', async () => {
    vi.mocked(getOrgSettings).mockRejectedValue(new Error('db down'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await dispatchDocument(input('Baubeschreibung.pdf'))
    expect((sentBody().screening as { detectors: string[] }).detectors).toContain('iban')
    errorLog.mockRestore()
  })
})
