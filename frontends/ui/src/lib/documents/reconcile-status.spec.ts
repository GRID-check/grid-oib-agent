import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { reconcileDocumentStatuses, extractIngestJobId } from './reconcile-status'

const makeDbMock = () => {
  const where = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where })
  const update = vi.fn().mockReturnValue({ set })
  vi.mocked(getDb).mockReturnValue({ update } as any)
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

describe('reconcileDocumentStatuses', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('leaves terminal rows untouched without calling the backend', async () => {
    makeDbMock()
    const rows = [makeRow({ status: 'completed' }), makeRow({ id: 'doc-2', status: 'failed' })]

    const result = await reconcileDocumentStatuses(rows)

    expect(result).toEqual(rows)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('marks a row completed when the ingestion job completed', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(
      batchResponse({
        'job-1': { status: 'completed', file_details: [{ file_name: 'plan.pdf', status: 'success' }] },
      })
    )

    const [result] = await reconcileDocumentStatuses([makeRow()])

    expect(mockFetch).toHaveBeenCalledTimes(1)
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

    const [result] = await reconcileDocumentStatuses([makeRow()])

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

    const [result] = await reconcileDocumentStatuses([makeRow()])

    expect(result.status).toBe('failed')
    expect(result.errorMessage).toBe('unparseable PDF')
  })

  it('leaves a row pending while the job is still in progress', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue(batchResponse({ 'job-1': { status: 'processing', file_details: [] } }))

    const [result] = await reconcileDocumentStatuses([makeRow()])

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

    const [result] = await reconcileDocumentStatuses([makeRow()])

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

    const [result] = await reconcileDocumentStatuses([makeRow({ metadata: null })])

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
    const result = await reconcileDocumentStatuses(rows)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result.map((r) => r.status)).toEqual(['completed', 'completed'])
  })

  it('leaves rows untouched when the backend is unreachable', async () => {
    const db = makeDbMock()
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const [result] = await reconcileDocumentStatuses([makeRow()])

    expect(result.status).toBe('pending')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('leaves a legacy row pending when its file is not in the collection yet', async () => {
    const db = makeDbMock()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    })

    const [result] = await reconcileDocumentStatuses([makeRow({ metadata: null })])

    expect(result.status).toBe('pending')
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
