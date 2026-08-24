/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { asDb } from '@/test-utils/db-fixtures'
import { reconcileDocumentStatuses, extractIngestJobId, clearCollectionFilesCache } from './reconcile-status'

const makeDbMock = () => {
  const where = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where })
  const update = vi.fn().mockReturnValue({ set })
  vi.mocked(getDb).mockReturnValue(asDb({ update }))
  return { update, set, where }
}

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'doc-1',
  status: 'pending',
  filename: 'plan.pdf',
  collectionName: 'proj_abc',
  errorMessage: null,
  metadata: { ingestJobId: 'job-1' },
  ...overrides,
})

const mockFetch = vi.fn()

const batchResponse = (statuses: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ statuses }),
})

const collectionResponse = (files: unknown[]) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(files),
})

describe('reconcileDocumentStatuses', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    // The collection-file-list cache is module-level and short-TTL; clear it so
    // each case starts from a cold cache and its own mock data is honoured.
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('preserves terminal statuses and never issues a status batch call for them', async () => {
    const db = makeDbMock()
    // Terminal rows still consult the collection file list for metadata, but
    // their status must not change and no status write should occur.
    mockFetch.mockResolvedValue(collectionResponse([{ file_name: 'plan.pdf', status: 'success' }]))
    const rows = [makeRow({ status: 'completed' }), makeRow({ id: 'doc-2', status: 'failed' })]

    const result = await reconcileDocumentStatuses(rows, 'org-1')

    expect(result.map((r) => r.status)).toEqual(['completed', 'failed'])
    expect(db.update).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/documents/status/batch'),
      expect.anything()
    )
  })

  it('marks a row completed when the ingestion job completed', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({
        'job-1': { status: 'completed', file_details: [{ file_name: 'plan.pdf', status: 'success' }] },
      })
    )

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/documents/status/batch'),
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.status).toBe('completed')
    expect(result.errorMessage).toBeNull()
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', errorMessage: null })
    )
  })

  it('marks a row failed with the job error message', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({
        'job-1': { status: 'failed', error_message: 'embedding service unavailable', file_details: [] },
      })
    )

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('failed')
    expect(result.errorMessage).toBe('embedding service unavailable')
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorMessage: 'embedding service unavailable' })
    )
  })

  it('marks a row failed when the completed job has a single failed file', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({
        'job-1': {
          status: 'completed',
          file_details: [{ file_name: 'plan.pdf', status: 'failed', error_message: 'unparseable PDF' }],
        },
      })
    )

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('failed')
    expect(result.errorMessage).toBe('unparseable PDF')
  })

  it('leaves a row pending while the job is still in progress', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(batchResponse({ 'job-1': { status: 'processing', file_details: [] } }))

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('pending')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('falls back to the collection file list when the job is unknown', async () => {
    const db = makeDbMock()
    mockFetch
      .mockResolvedValueOnce(batchResponse({ 'job-1': null }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { file_id: 'f-1', file_name: 'plan.pdf', collection_name: 'proj_abc', status: 'success' },
          ]),
      })

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/v1/collections/proj_abc/documents'),
      expect.any(Object)
    )
    expect(result.status).toBe('completed')
    expect(db.update).toHaveBeenCalledTimes(1)
  })

  it('uses the collection file list for legacy rows without a job id', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          { file_id: 'f-1', file_name: 'plan.pdf', collection_name: 'proj_abc', status: 'success' },
        ]),
    })

    const [result] = await reconcileDocumentStatuses([makeRow({ metadata: null })], 'org-1')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/collections/proj_abc/documents'),
      expect.any(Object)
    )
    expect(result.status).toBe('completed')
  })

  it('fetches each collection file list only once per call', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          { file_id: 'f-1', file_name: 'plan.pdf', collection_name: 'proj_abc', status: 'success' },
          { file_id: 'f-2', file_name: 'specs.pdf', collection_name: 'proj_abc', status: 'success' },
        ]),
    })

    const rows = [
      makeRow({ metadata: null }),
      makeRow({ id: 'doc-2', filename: 'specs.pdf', metadata: null }),
    ]
    const result = await reconcileDocumentStatuses(rows, 'org-1')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result.map((r) => r.status)).toEqual(['completed', 'completed'])
  })

  it('leaves rows untouched when the backend is unreachable', async () => {
    const db = makeDbMock()
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('pending')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('leaves rows untouched when the backend fetch times out (same fail-open as unreachable)', async () => {
    const db = makeDbMock()
    // AbortSignal.timeout() rejects fetch with a DOMException named TimeoutError;
    // the fetchJson wrapper swallows it exactly like a connection refusal.
    mockFetch.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('pending')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('bounds the status batch call with an AbortSignal', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(batchResponse({ 'job-1': { status: 'in_progress' } }))

    await reconcileDocumentStatuses([makeRow()], 'org-1')

    const batchCall = mockFetch.mock.calls.find(([url]) => String(url).includes('/v1/documents/status/batch'))
    expect(batchCall).toBeDefined()
    expect((batchCall?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('leaves a legacy row pending when its file is not in the collection yet', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    })

    const [result] = await reconcileDocumentStatuses([makeRow({ metadata: null })], 'org-1')

    expect(result.status).toBe('pending')
    expect(db.update).not.toHaveBeenCalled()
  })
})

describe('reconcileDocumentStatuses metadata enrichment', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    // The collection-file-list cache is module-level and short-TTL; clear it so
    // each case starts from a cold cache and its own mock data is honoured.
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('merges summary, page/chunk counts, content types, and tags onto a row', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(
      collectionResponse([
        {
          file_id: 'f-1',
          file_name: 'plan.pdf',
          status: 'success',
          summary: 'A ground-floor plan.',
          chunk_count: 12,
          tags: ['Grundriss', 'Brandschutz'],
          metadata: { page_count: 4, content_types: ['text', 'table'] },
        },
      ])
    )

    const [result] = await reconcileDocumentStatuses([makeRow({ status: 'completed' })], 'org-1')

    expect(result.summary).toBe('A ground-floor plan.')
    expect(result.pageCount).toBe(4)
    expect(result.chunkCount).toBe(12)
    expect(result.contentTypes).toEqual(['text', 'table'])
    expect(result.tags).toEqual(['Grundriss', 'Brandschutz'])
  })

  it('omits tags when the backend provides an empty tag list', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(
      collectionResponse([
        { file_id: 'f-1', file_name: 'plan.pdf', status: 'success', chunk_count: 5, tags: [] },
      ])
    )

    const [result] = await reconcileDocumentStatuses([makeRow({ status: 'completed' })], 'org-1')

    expect(result.tags).toBeUndefined()
  })

  it('omits fields the backend did not provide', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(
      collectionResponse([{ file_id: 'f-1', file_name: 'plan.pdf', status: 'success', chunk_count: 5 }])
    )

    const [result] = await reconcileDocumentStatuses([makeRow({ status: 'completed' })], 'org-1')

    expect(result.chunkCount).toBe(5)
    expect(result.summary).toBeUndefined()
    expect(result.pageCount).toBeUndefined()
    expect(result.contentTypes).toBeUndefined()
  })

  it('shows no metadata when the filename is ambiguous within the collection', async () => {
    makeDbMock()
    // Two backend files share the filename → the join is unsafe.
    mockFetch.mockResolvedValue(
      collectionResponse([
        { file_id: 'f-1', file_name: 'plan.pdf', status: 'success', summary: 'First.', chunk_count: 3 },
        { file_id: 'f-2', file_name: 'plan.pdf', status: 'success', summary: 'Second.', chunk_count: 9 },
      ])
    )

    const [result] = await reconcileDocumentStatuses([makeRow({ status: 'completed' })], 'org-1')

    expect(result.summary).toBeUndefined()
    expect(result.chunkCount).toBeUndefined()
  })

  it('adds no metadata when the backend file list is unreachable (fail-open)', async () => {
    makeDbMock()
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const [result] = await reconcileDocumentStatuses([makeRow({ status: 'completed' })], 'org-1')

    expect(result.status).toBe('completed')
    expect(result.summary).toBeUndefined()
    expect(result.chunkCount).toBeUndefined()
  })

  it('adds no metadata when the document is absent from the collection list', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(collectionResponse([{ file_id: 'f-9', file_name: 'other.pdf', status: 'success' }]))

    const [result] = await reconcileDocumentStatuses([makeRow({ status: 'completed' })], 'org-1')

    expect(result.summary).toBeUndefined()
    expect(result.chunkCount).toBeUndefined()
  })
})

describe('reconcileDocumentStatuses collection-file-list caching', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('does not refetch the collection file list for terminal rows within the TTL', async () => {
    makeDbMock()
    // Terminal rows only consult the collection list for metadata enrichment.
    mockFetch.mockResolvedValue(
      collectionResponse([{ file_id: 'f-1', file_name: 'plan.pdf', status: 'success', chunk_count: 3 }])
    )
    const rows = [makeRow({ status: 'completed' })]

    // First read fetches once and caches; a second read within the TTL reuses it.
    await reconcileDocumentStatuses(rows, 'org-1')
    await reconcileDocumentStatuses(rows, 'org-1')

    const collectionCalls = mockFetch.mock.calls.filter(([url]) =>
      String(url).includes('/v1/collections/proj_abc/documents')
    )
    expect(collectionCalls).toHaveLength(1)
  })

  it('always refetches the collection list for in-flight rows (status freshness cannot lag)', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(
      collectionResponse([{ file_id: 'f-1', file_name: 'plan.pdf', status: 'pending' }])
    )
    // Legacy in-flight row (no job id) → status reconciliation reads the list fresh.
    const rows = [makeRow({ status: 'pending', metadata: null })]

    await reconcileDocumentStatuses(rows, 'org-1')
    await reconcileDocumentStatuses(rows, 'org-1')

    const collectionCalls = mockFetch.mock.calls.filter(([url]) =>
      String(url).includes('/v1/collections/proj_abc/documents')
    )
    expect(collectionCalls).toHaveLength(2)
  })
})

describe('extractIngestJobId', () => {
  it('extracts a job id from metadata', () => {
    expect(extractIngestJobId({ ingestJobId: 'job-9' })).toBe('job-9')
  })

  it('returns null for missing or malformed metadata', () => {
    expect(extractIngestJobId(null)).toBeNull()
    expect(extractIngestJobId(undefined)).toBeNull()
    expect(extractIngestJobId({})).toBeNull()
    expect(extractIngestJobId({ ingestJobId: 42 })).toBeNull()
    expect(extractIngestJobId('job-9')).toBeNull()
  })
})
