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
  // An ordinary human upload, before every test. `vi.clearAllMocks()` clears
  // calls and not implementations, so without this a row set by one test is
  // still the row the next one reads — which is how a suite comes to depend on
  // the order its cases happen to run in.
  vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ authoredBy: 'user' }))
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

  /**
   * The one clause ADR-0054 added, and everything it deliberately does not
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
     * which is the first three rows.
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
      // Every upload shelf and every re-ingest dispatches without a version:
      // the clause widened the rule for machine-authored rows and changed
      // nothing for a person's.
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
