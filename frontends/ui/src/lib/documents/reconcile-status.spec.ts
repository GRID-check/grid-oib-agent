/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { asDb } from '@/test-utils/db-fixtures'
import {
  reconcileDocumentStatuses,
  extractIngestJobId,
  clearCollectionFilesCache,
  describeBackendIngestState,
  type ReconcilableDocument,
} from './reconcile-status'

const makeDbMock = () => {
  const where = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where })
  const update = vi.fn().mockReturnValue({ set })
  vi.mocked(getDb).mockReturnValue(asDb({ update }))
  return { update, set, where }
}

/**
 * A row as the read paths hand it over. `authoredBy: 'user'` is the default
 * because a person uploading a file is what every row means until a commissioned
 * run writes one — and because it is REQUIRED: the fixture is typed as the real
 * `ReconcilableDocument`, so a case that means to exercise the machine-authored
 * path has to say so rather than inherit it.
 */
const makeRow = (overrides: Partial<ReconcilableDocument> = {}): ReconcilableDocument => ({
  id: 'doc-1',
  status: 'pending',
  filename: 'plan.pdf',
  collectionName: 'proj_abc',
  authoredBy: 'user',
  // Nothing published, which is what a human upload's row carried before
  // migration 0082 and what the backfill gives it. A human row owns its chunks
  // regardless; a case about a PUBLISHED Piloti document says so.
  publishedVersionId: null,
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

  /**
   * A re-upload that fails to index keeps the previous version's chunks under
   * the same filename, so the collection file list still reports that name as
   * `success`. The job is what knows the NEW bytes failed, and it must win:
   * reading the list here would turn a failed re-upload green.
   */
  it('marks a failed re-upload failed although the previous version still lists as indexed', async () => {
    const db = makeDbMock()
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('/v1/documents/status/batch')
        ? batchResponse({
            'job-1': {
              status: 'failed',
              error_message: '1/1 file(s) failed',
              file_details: [{ status: 'failed', error_message: 'PDF is encrypted' }],
            },
          })
        : collectionResponse([{ file_name: 'plan.pdf', status: 'success', chunk_count: 12 }])
    )

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('failed')
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })

  it('leaves a row pending while the job is still in progress', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(batchResponse({ 'job-1': { status: 'processing', file_details: [] } }))

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('pending')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('carries how many of the office\'s uploads wait ahead of a queued job', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({ 'job-1': { status: 'pending', file_details: [], metadata: { queue_ahead: 3 } } })
    )

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.queueAhead).toBe(3)
  })

  it('says null once the job is no longer waiting, so a count shown before clears', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({ 'job-1': { status: 'processing', file_details: [], metadata: { queue_ahead: null } } })
    )

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.queueAhead).toBeNull()
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

  /**
   * The collision `generatedFilename` makes reachable, played out on the read
   * path: one real Gutachten a person uploaded, and one report Piloti filed into
   * the SAME project collection whose model-written title slugged to the same
   * stem on the same day. The backend list has exactly one entry for that name —
   * the human document's, because nothing machine-authored is ever ingested.
   */
  const gutachtenListing = () =>
    collectionResponse([
      {
        file_id: 'f-1',
        file_name: 'brandschutz-gutachten-2026-08-20.pdf',
        status: 'success',
        summary: 'Gutachten zum Brandschutzkonzept, Bauteil B.',
        chunk_count: 42,
        tags: ['Gutachten', 'Brandschutz'],
        metadata: { page_count: 31, content_types: ['text', 'table'] },
      },
    ])

  const collidingRow = (authoredBy: 'user' | 'agent') =>
    makeRow({
      id: authoredBy === 'agent' ? 'doc-agent' : 'doc-human',
      status: authoredBy === 'agent' ? 'stored' : 'completed',
      filename: 'brandschutz-gutachten-2026-08-20.pdf',
      authoredBy,
    })

  it('gives a machine-authored row none of the colliding human document\'s metadata', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(gutachtenListing())

    const [result] = await reconcileDocumentStatuses([collidingRow('agent')], 'org-1')

    // Every one of these belongs to somebody's actual Gutachten. `FileCard`
    // renders `summary` with no gate, so before the authorship gate this row
    // displayed that summary under „Von Piloti erstellt“, and
    // `GET /api/documents/{id}/status` returned it to the chat peek pane.
    expect(result.summary).toBeUndefined()
    expect(result.pageCount).toBeUndefined()
    expect(result.chunkCount).toBeUndefined()
    expect(result.contentTypes).toBeUndefined()
    expect(result.tags).toBeUndefined()
    // The row itself is untouched — this is a suppression, not a failure.
    expect(result.status).toBe('stored')
  })

  it('still enriches the human document that owns the colliding filename', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(gutachtenListing())

    const [result] = await reconcileDocumentStatuses([collidingRow('user')], 'org-1')

    expect(result.summary).toBe('Gutachten zum Brandschutzkonzept, Bauteil B.')
    expect(result.pageCount).toBe(31)
    expect(result.tags).toEqual(['Gutachten', 'Brandschutz'])
  })

  it('does not fetch a collection listing for a read of machine-authored rows only', async () => {
    makeDbMock()
    mockFetch.mockResolvedValue(gutachtenListing())

    await reconcileDocumentStatuses([collidingRow('agent')], 'org-1')

    // The gate runs ahead of the fetch: the row owns nothing in that list either
    // way, so deciding costs no backend round trip.
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('reconcileDocumentStatuses authorship gate on the status pass', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('never resolves a machine-authored row from a colliding entry in the file list', async () => {
    const db = makeDbMock()
    // In flight AND machine-authored is already an anomaly — filing writes the
    // terminal `stored`. The point is that the collection fallback must be
    // closed by AUTHORSHIP and not merely by the status vocabulary: `stored`
    // being outside IN_FLIGHT_STATUSES is a fact about the status column, and a
    // row that reaches this pass anyway would otherwise adopt the human
    // document's `success` and go green and „zitierbar“.
    mockFetch.mockResolvedValue(
      collectionResponse([
        { file_id: 'f-1', file_name: 'brandschutz-gutachten-2026-08-20.pdf', status: 'success' },
      ])
    )

    const [result] = await reconcileDocumentStatuses(
      [
        makeRow({
          status: 'pending',
          filename: 'brandschutz-gutachten-2026-08-20.pdf',
          authoredBy: 'agent',
          metadata: null,
        }),
      ],
      'org-1'
    )

    expect(result.status).toBe('pending')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('still resolves a human row with the same filename from the same list', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(
      collectionResponse([
        { file_id: 'f-1', file_name: 'brandschutz-gutachten-2026-08-20.pdf', status: 'success' },
      ])
    )

    const [result] = await reconcileDocumentStatuses(
      [
        makeRow({
          status: 'pending',
          filename: 'brandschutz-gutachten-2026-08-20.pdf',
          authoredBy: 'user',
          metadata: null,
        }),
      ],
      'org-1'
    )

    expect(result.status).toBe('completed')
    expect(db.update).toHaveBeenCalled()
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

describe('reconcileDocumentStatuses enrichment on a status transition', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const collectionCalls = () =>
    mockFetch.mock.calls.filter(([url]) => String(url).includes('/v1/collections/proj_abc/documents'))

  /**
   * The backend as the file viewer meets it: the listing a steady-state read
   * cached before the upload landed, then the job finishing with its summary
   * registered. `listing` is swapped mid-test to play the backend moving on.
   */
  const routeBackend = (jobs: Record<string, unknown>, listing: { current: unknown[] }) => {
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('/v1/documents/status/batch') ? batchResponse(jobs) : collectionResponse(listing.current)
    )
  }

  const indexedPlan = {
    file_id: 'f-1',
    file_name: 'plan.pdf',
    status: 'success',
    summary: 'A ground-floor plan.',
    chunk_count: 12,
    tags: ['Grundriss'],
    metadata: { page_count: 4, content_types: ['text'] },
  }

  it('enriches the read that turns a row completed from a fresh listing, not the stale cached one', async () => {
    makeDbMock()
    const listing = { current: [] as unknown[] }
    routeBackend({ 'job-1': { status: 'completed', file_details: [{ status: 'success' }] } }, listing)

    // A terminal sibling in the same collection primes the cache with the
    // listing from before plan.pdf existed.
    await reconcileDocumentStatuses([makeRow({ id: 'doc-old', filename: 'old.pdf', status: 'completed' })], 'org-1')
    expect(collectionCalls()).toHaveLength(1)

    listing.current = [indexedPlan]
    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('completed')
    expect(result.summary).toBe('A ground-floor plan.')
    expect(result.pageCount).toBe(4)
    expect(result.chunkCount).toBe(12)
    expect(result.contentTypes).toEqual(['text'])
    expect(result.tags).toEqual(['Grundriss'])
    expect(collectionCalls()).toHaveLength(2)
  })

  it('replaces the cache entry, so the next steady-state read serves the fresh listing without a fetch', async () => {
    makeDbMock()
    const listing = { current: [] as unknown[] }
    routeBackend({ 'job-1': { status: 'completed', file_details: [{ status: 'success' }] } }, listing)
    await reconcileDocumentStatuses([makeRow({ id: 'doc-old', filename: 'old.pdf', status: 'completed' })], 'org-1')
    listing.current = [indexedPlan]
    await reconcileDocumentStatuses([makeRow()], 'org-1')

    const [again] = await reconcileDocumentStatuses([makeRow({ status: 'completed' })], 'org-1')

    expect(again.summary).toBe('A ground-floor plan.')
    expect(collectionCalls()).toHaveLength(2)
  })

  it('fetches a collection fresh at most once per read, however many rows transition', async () => {
    makeDbMock()
    const listing = { current: [] as unknown[] }
    routeBackend(
      {
        'job-1': { status: 'completed', file_details: [{ status: 'success' }] },
        'job-2': { status: 'completed', file_details: [{ status: 'success' }] },
      },
      listing
    )
    await reconcileDocumentStatuses([makeRow({ id: 'doc-old', filename: 'old.pdf', status: 'completed' })], 'org-1')
    listing.current = [indexedPlan, { file_id: 'f-2', file_name: 'specs.pdf', status: 'success', chunk_count: 3 }]

    const result = await reconcileDocumentStatuses(
      [
        makeRow(),
        makeRow({ id: 'doc-2', filename: 'specs.pdf', metadata: { ingestJobId: 'job-2' } }),
        // A legacy row resolved from the list shares the same fresh fetch.
        makeRow({ id: 'doc-3', filename: 'legacy.pdf', metadata: null }),
        makeRow({ id: 'doc-4', filename: 'old.pdf', status: 'completed' }),
      ],
      'org-1'
    )

    expect(result.map((r) => r.chunkCount)).toEqual([12, 3, undefined, undefined])
    expect(collectionCalls()).toHaveLength(2)
  })

  it('keeps steady-state reads of unchanged terminal rows on the cache', async () => {
    makeDbMock()
    const listing = { current: [indexedPlan] as unknown[] }
    routeBackend({}, listing)
    const row = makeRow({ status: 'completed', updatedAt: new Date(Date.now() - 60_000) })

    await reconcileDocumentStatuses([row], 'org-1')
    await reconcileDocumentStatuses([row], 'org-1')
    await reconcileDocumentStatuses([row], 'org-1')

    expect(collectionCalls()).toHaveLength(1)
  })

  it('refreshes once for a row written after the cached listing, e.g. a transition another read made', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
    makeDbMock()
    const listing = { current: [] as unknown[] }
    routeBackend({}, listing)
    await reconcileDocumentStatuses([makeRow({ id: 'doc-old', filename: 'old.pdf', status: 'completed' })], 'org-1')

    vi.setSystemTime(new Date('2026-09-29T10:00:05Z'))
    listing.current = [indexedPlan]
    const row = makeRow({ status: 'completed', updatedAt: new Date('2026-09-29T10:00:03Z') })
    const [first] = await reconcileDocumentStatuses([row], 'org-1')
    const [second] = await reconcileDocumentStatuses([row], 'org-1')

    expect(first.summary).toBe('A ground-floor plan.')
    expect(second.summary).toBe('A ground-floor plan.')
    expect(collectionCalls()).toHaveLength(2)
  })
})

describe('reconcileDocumentStatuses on a row the BFF is still working on', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('leaves a processing row without a job id processing, and asks the backend nothing about its status', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(collectionResponse([]))

    const [result] = await reconcileDocumentStatuses(
      [makeRow({ status: 'processing', filename: 'Bericht.docx', metadata: null })],
      'org-1'
    )

    expect(result.status).toBe('processing')
    expect(db.update).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/documents/status/batch'),
      expect.anything()
    )
  })

  it('does not adopt the previous version\'s success from the list while a re-ingest converts', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(
      collectionResponse([{ file_id: 'f-1', file_name: 'Bericht.docx', status: 'success', chunk_count: 8 }])
    )

    const [result] = await reconcileDocumentStatuses(
      [makeRow({ status: 'processing', filename: 'Bericht.docx', metadata: null })],
      'org-1'
    )

    expect(result.status).toBe('processing')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('ignores the job id a retried row still carries from its failed dispatch', async () => {
    const db = makeDbMock()
    // `markDocumentProcessing` does not clear `metadata`, so a retry of a
    // failed document still names the job that failed.
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('/v1/documents/status/batch')
        ? batchResponse({ 'job-1': { status: 'failed', error_message: 'old failure' } })
        : collectionResponse([])
    )

    const [result] = await reconcileDocumentStatuses([makeRow({ status: 'processing' })], 'org-1')

    expect(result.status).toBe('processing')
    expect(db.update).not.toHaveBeenCalled()
  })
})

describe('reconcileDocumentStatuses on a failure the backend settled as interrupted', () => {
  const INTERRUPTED = 'interrupted: ingestion stopped when the service restarted; retry to index this file'
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)
  const interruptedRow = (overrides: Partial<ReconcilableDocument> = {}) =>
    makeRow({ status: 'failed', errorMessage: INTERRUPTED, updatedAt: minutesAgo(5), ...overrides })

  const batchCalls = () =>
    mockFetch.mock.calls.filter(([url]) => String(url).includes('/v1/documents/status/batch'))

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('heals to completed when the owner outlived the settle and finished the job', async () => {
    const db = makeDbMock()
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/v1/documents/status/batch')
          ? batchResponse({ 'job-1': { status: 'completed', file_details: [{ status: 'success' }] } })
          : collectionResponse([])
      )
    )

    const [result] = await reconcileDocumentStatuses([interruptedRow()], 'org-1')

    expect(result.status).toBe('completed')
    expect(result.errorMessage).toBeNull()
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', errorMessage: null }))
  })

  it('goes back to pending while the owner is still working, so the in-flight pass takes over', async () => {
    const db = makeDbMock()
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/v1/documents/status/batch')
          ? batchResponse({ 'job-1': { status: 'processing' } })
          : collectionResponse([])
      )
    )

    const [result] = await reconcileDocumentStatuses([interruptedRow()], 'org-1')

    expect(result.status).toBe('pending')
    expect(result.errorMessage).toBeNull()
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending', errorMessage: null }))
  })

  it('stays failed, with no write, when the backend still says failed', async () => {
    const db = makeDbMock()
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/v1/documents/status/batch')
          ? batchResponse({ 'job-1': { status: 'failed', error_message: INTERRUPTED } })
          : collectionResponse([])
      )
    )

    const [result] = await reconcileDocumentStatuses([interruptedRow()], 'org-1')

    expect(batchCalls()).toHaveLength(1)
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toBe(INTERRUPTED)
    expect(db.update).not.toHaveBeenCalled()
  })

  it('does not adopt a previous version\'s success from the file list when the job is unknown', async () => {
    const db = makeDbMock()
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/v1/documents/status/batch')
          ? batchResponse({})
          : collectionResponse([{ file_name: 'plan.pdf', status: 'success' }])
      )
    )

    const [result] = await reconcileDocumentStatuses([interruptedRow()], 'org-1')

    expect(result.status).toBe('failed')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('stops asking once the row is older than the re-check window', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(collectionResponse([]))

    const rows = [interruptedRow({ updatedAt: minutesAgo(31) }), interruptedRow({ id: 'doc-2', updatedAt: null })]
    const result = await reconcileDocumentStatuses(rows, 'org-1')

    expect(batchCalls()).toHaveLength(0)
    expect(result.map((r) => r.status)).toEqual(['failed', 'failed'])
    expect(db.update).not.toHaveBeenCalled()
  })

  it('leaves other failed rows alone: another reason, or no job to ask about', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(collectionResponse([{ file_name: 'plan.pdf', status: 'success' }]))

    const rows = [
      interruptedRow({ errorMessage: 'embedding service unavailable' }),
      interruptedRow({ id: 'doc-2', errorMessage: null }),
      interruptedRow({ id: 'doc-3', metadata: {} }),
    ]
    const result = await reconcileDocumentStatuses(rows, 'org-1')

    expect(batchCalls()).toHaveLength(0)
    expect(result.map((r) => r.status)).toEqual(['failed', 'failed', 'failed'])
    expect(db.update).not.toHaveBeenCalled()
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

describe('describeBackendIngestState', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const routeBackend = (jobs: Record<string, unknown> | null, files: unknown[] | null) => {
    mockFetch.mockImplementation((url: unknown) => {
      if (String(url).includes('/v1/documents/status/batch')) {
        if (jobs === null) return Promise.reject(new Error('backend down'))
        return Promise.resolve(batchResponse(jobs))
      }
      if (files === null) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) })
      return Promise.resolve(collectionResponse(files))
    })
  }

  it('reports in-progress while the job is running, without touching the file list', async () => {
    routeBackend({ 'job-1': { status: 'running' } }, [])

    const knowledge = await describeBackendIngestState(makeRow({ status: 'processing' }))

    expect(knowledge).toEqual({ state: 'in-progress' })
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/collections/'))).toBe(false)
  })

  it('reports absent when the backend forgot the job and holds no file', async () => {
    // A restart wiped the in-memory job registry and the file never landed:
    // the row's `processing` badge is a memory of work that exists nowhere.
    routeBackend({}, [])

    const knowledge = await describeBackendIngestState(makeRow({ status: 'processing' }))

    expect(knowledge).toEqual({ state: 'absent' })
  })

  it('reports terminal when the work landed behind the row back', async () => {
    routeBackend({}, [{ file_name: 'plan.pdf', status: 'success' }])

    const knowledge = await describeBackendIngestState(makeRow({ status: 'processing' }))

    expect(knowledge).toEqual({ state: 'terminal', resolution: { status: 'completed', errorMessage: null } })
  })

  it('reports in-progress when a file under this name is mid-flight', async () => {
    routeBackend({}, [{ file_name: 'plan.pdf', status: 'pending' }])

    const knowledge = await describeBackendIngestState(makeRow({ status: 'processing', metadata: null }))

    expect(knowledge).toEqual({ state: 'in-progress' })
  })

  it('reports unreachable when the backend cannot be asked, and refuses to guess', async () => {
    routeBackend(null, [])

    const knowledge = await describeBackendIngestState(makeRow({ status: 'processing' }))

    expect(knowledge).toEqual({ state: 'unreachable' })
  })

  it('reports unreachable when the collection list is gone', async () => {
    routeBackend({}, null)

    const knowledge = await describeBackendIngestState(makeRow({ status: 'processing', metadata: null }))

    expect(knowledge).toEqual({ state: 'unreachable' })
  })
})

/**
 * ADR-0077: the content gate stops a job on purpose. The row must read as
 * quarantined (waiting on a person), never as an ordinary failure a retry
 * would re-dispatch into the same gate, and the job's screening outcome lands
 * on the row so the upload summary can say what was and was not checked.
 */
describe('reconcileDocumentStatuses — upload screening', () => {
  const verdict =
    'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":1,"pages":[1]}],"checked":"full"}'

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    clearCollectionFilesCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('quarantines a row whose only file the content gate stopped', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({
        'job-1': {
          status: 'completed',
          file_details: [{ status: 'failed', error_message: verdict, screening: 'quarantined' }],
        },
      })
    )

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('quarantined')
    expect(result.errorMessage).toBe(verdict)
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'quarantined', errorMessage: verdict, screeningOutcome: 'quarantined' })
    )
  })

  it('quarantines from a failed job too', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(batchResponse({ 'job-1': { status: 'failed', error_message: verdict } }))

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('quarantined')
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'quarantined' }))
  })

  it('quarantines from the collection file list when the job is forgotten', async () => {
    const db = makeDbMock()
    mockFetch
      .mockResolvedValueOnce(batchResponse({}))
      .mockResolvedValue(collectionResponse([{ file_name: 'plan.pdf', status: 'failed', error_message: verdict }]))

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('quarantined')
    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'quarantined' }))
  })

  it.each(['clean', 'partial', 'unchecked'])('records the outcome %s of a completed, screened job', async (screening) => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({ 'job-1': { status: 'completed', file_details: [{ status: 'success', screening }] } })
    )

    await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', screeningOutcome: screening }))
  })

  it('leaves the outcome alone for a job that carried no rules (released, or screening off)', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({ 'job-1': { status: 'completed', file_details: [{ status: 'success', screening: null }] } })
    )

    await reconcileDocumentStatuses([makeRow()], 'org-1')

    const written = db.set.mock.calls[0]?.[0] as Record<string, unknown>
    expect(written.status).toBe('completed')
    expect('screeningOutcome' in written).toBe(false)
  })

  it('does not mistake an ordinary failure for a quarantine', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(batchResponse({ 'job-1': { status: 'failed', error_message: 'unparseable PDF' } }))

    const [result] = await reconcileDocumentStatuses([makeRow()], 'org-1')

    expect(result.status).toBe('failed')
    const written = db.set.mock.calls[0]?.[0] as Record<string, unknown>
    expect('screeningOutcome' in written).toBe(false)
  })
})
