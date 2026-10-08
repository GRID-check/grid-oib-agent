/**
 * @vitest-environment node
 *
 * The write of permitting memory: what the service decides before the
 * repository stores anything. The SQL is the integration suite's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  findPermitDocument: vi.fn(),
  replacePermitRecord: vi.fn(),
  deletePermitRecord: vi.fn(),
}))
vi.mock('@/lib/authz/folder-access', () => ({ sourceFoldersOfCollections: vi.fn() }))
vi.mock('@/lib/knowledge/embeddings', () => ({ embedNotes: vi.fn() }))
// The restriction rule is memory's own; its module pulls the database in.
vi.mock('@/lib/projects/memory-service', () => ({
  canonicalRestriction: (ids: readonly string[]) => {
    const unique = [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))].sort()
    return unique.length > 0 ? unique : null
  },
}))

import { sourceFoldersOfCollections } from '@/lib/authz/folder-access'
import { embedNotes } from '@/lib/knowledge/embeddings'
import { getTenantContext } from '@/lib/db/tenant-context'
import { deletePermitRecord, findPermitDocument, replacePermitRecord } from './repository'
import { storePermitRecord } from './service'
import type { StorePermitRecordRequest } from './types'

const ORG = 'org_1'
const DOC = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const PROJECT = '11111111-1111-4111-8111-111111111111'
const FOLDER_A = 'bbbbbbbb-0000-4000-8000-00000000000b'
const FOLDER_B = 'aaaaaaaa-0000-4000-8000-00000000000a'

const document = { documentId: DOC, projectId: PROJECT, projectCollection: 'proj_1', fileName: 'Bescheid.pdf' }

const requirement = (content: string, evidence: string | null = null) => ({
  kind: 'auflage' as const,
  content,
  evidence,
  legalBasis: null,
  page: 1,
})

const body = (overrides: Partial<StorePermitRecordRequest> = {}): StorePermitRecordRequest => ({
  organizationId: ORG,
  documentId: DOC,
  collection: 'proj_1',
  fileName: 'ignored-name.pdf',
  model: 'summary-model',
  record: {
    kind: 'bewilligung',
    authority: 'Stadtgemeinde Mödling',
    municipality: 'Mödling',
    bundesland: 'niederoesterreich',
    issuedOn: '2021-05-04',
    reference: 'Bau-123/2021',
    requirements: [requirement('Brandschutzkonzept vorzulegen.', 'Gutachten'), requirement('Fluchtwege zu bemaßen.')],
  },
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(findPermitDocument).mockResolvedValue(document)
  vi.mocked(sourceFoldersOfCollections).mockResolvedValue(new Map())
  vi.mocked(embedNotes).mockImplementation(async (texts) => texts.map(() => ({ vector: [1, 0], fingerprint: 'm' })))
})

describe('storePermitRecord', () => {
  it('stores nothing for a document it does not know', async () => {
    vi.mocked(findPermitDocument).mockResolvedValue(null)

    expect(await storePermitRecord(body())).toEqual({ stored: false, requirements: 0 })
    expect(replacePermitRecord).not.toHaveBeenCalled()
    expect(deletePermitRecord).not.toHaveBeenCalled()
    expect(findPermitDocument).toHaveBeenCalledWith(ORG, { collectionName: 'proj_1', documentId: DOC, fileName: 'ignored-name.pdf' })
  })

  it('finds the document by collection and file name when the body carries no id, and stores under the row’s id', async () => {
    expect(await storePermitRecord(body({ documentId: undefined }))).toEqual({ stored: true, requirements: 2 })

    expect(findPermitDocument).toHaveBeenCalledWith(ORG, { collectionName: 'proj_1', documentId: undefined, fileName: 'ignored-name.pdf' })
    expect(replacePermitRecord).toHaveBeenCalledWith(expect.objectContaining({ documentId: DOC, fileName: 'Bescheid.pdf' }))
  })

  it('stores nothing for a file name it does not know', async () => {
    vi.mocked(findPermitDocument).mockResolvedValue(null)

    expect(await storePermitRecord(body({ documentId: undefined, fileName: 'unbekannt.pdf' }))).toEqual({ stored: false, requirements: 0 })
    expect(replacePermitRecord).not.toHaveBeenCalled()
  })

  it('deletes by the row’s id when a null record names the document by file name', async () => {
    await storePermitRecord(body({ documentId: undefined, record: null }))

    expect(deletePermitRecord).toHaveBeenCalledWith(ORG, DOC)
  })

  it('deletes the document’s record for a null record, and embeds nothing', async () => {
    expect(await storePermitRecord(body({ record: null }))).toEqual({ stored: false, requirements: 0 })

    expect(deletePermitRecord).toHaveBeenCalledWith(ORG, DOC)
    expect(replacePermitRecord).not.toHaveBeenCalled()
    expect(embedNotes).not.toHaveBeenCalled()
  })

  it('runs inside the organization’s tenant scope', async () => {
    let scope: unknown
    vi.mocked(findPermitDocument).mockImplementation(async () => {
      scope = getTenantContext()
      return document
    })

    await storePermitRecord(body())

    expect(scope).toMatchObject({ kind: 'tenant', organizationId: ORG })
  })

  it('takes the project and file name from the document, and embeds content with evidence', async () => {
    expect(await storePermitRecord(body())).toEqual({ stored: true, requirements: 2 })

    expect(embedNotes).toHaveBeenCalledWith(['Brandschutzkonzept vorzulegen.\nGutachten', 'Fluchtwege zu bemaßen.'])
    expect(replacePermitRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        projectId: PROJECT,
        documentId: DOC,
        collectionName: 'proj_1',
        fileName: 'Bescheid.pdf',
        restrictedFolderIds: null,
        model: 'summary-model',
        kind: 'bewilligung',
        authority: 'Stadtgemeinde Mödling',
        issuedOn: '2021-05-04',
        requirements: [
          expect.objectContaining({ content: 'Brandschutzkonzept vorzulegen.', embedding: { vector: [1, 0], fingerprint: 'm' } }),
          expect.objectContaining({ content: 'Fluchtwege zu bemaßen.', embedding: { vector: [1, 0], fingerprint: 'm' } }),
        ],
      })
    )
  })

  it('restricts the record to the folder whose collection the document sits in, canonically', async () => {
    vi.mocked(sourceFoldersOfCollections).mockResolvedValue(new Map([['proj_1_restricted', FOLDER_A.toUpperCase()]]))

    await storePermitRecord(body({ collection: 'proj_1_restricted' }))

    expect(sourceFoldersOfCollections).toHaveBeenCalledWith(ORG, PROJECT, 'proj_1', ['proj_1_restricted'])
    expect(replacePermitRecord).toHaveBeenCalledWith(expect.objectContaining({ restrictedFolderIds: [FOLDER_A] }))
  })

  it('sorts and de-duplicates when a collection resolves to several folders', async () => {
    vi.mocked(sourceFoldersOfCollections).mockResolvedValue(new Map([['c1', FOLDER_A], ['c2', FOLDER_B], ['c3', FOLDER_A]]))

    await storePermitRecord(body())

    expect(replacePermitRecord).toHaveBeenCalledWith(expect.objectContaining({ restrictedFolderIds: [FOLDER_B, FOLDER_A] }))
  })

  it('still stores when the embedder is down: the requirements carry no vector', async () => {
    vi.mocked(embedNotes).mockResolvedValue(null)

    expect(await storePermitRecord(body())).toEqual({ stored: true, requirements: 2 })

    const stored = vi.mocked(replacePermitRecord).mock.calls[0][0]
    expect(stored.requirements.map((item) => item.embedding)).toEqual([null, null])
  })

  it('stores a record with no requirements', async () => {
    const empty = body()
    empty.record = { ...empty.record!, requirements: [] }

    expect(await storePermitRecord(empty)).toEqual({ stored: true, requirements: 0 })
    expect(replacePermitRecord).toHaveBeenCalledWith(expect.objectContaining({ requirements: [] }))
  })

  it('reports not stored when the document was deleted while the record was prepared', async () => {
    vi.mocked(replacePermitRecord).mockRejectedValue(
      Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('fk'), { code: '23503' }) })
    )

    expect(await storePermitRecord(body())).toEqual({ stored: false, requirements: 0 })
  })

  it('lets any other failure through', async () => {
    vi.mocked(replacePermitRecord).mockRejectedValue(new Error('connection lost'))

    await expect(storePermitRecord(body())).rejects.toThrow('connection lost')
  })
})
