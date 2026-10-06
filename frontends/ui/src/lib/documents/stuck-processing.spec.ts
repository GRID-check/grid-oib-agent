/**
 * @vitest-environment node
 *
 * The sweep for documents stranded at `processing` (ADR-0078): which rows it
 * is handed, what it does for a row with no job and for one whose job died, and
 * that one row's failure never costs the others their turn. The SQL that picks
 * the rows is `stuck-processing.integration.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  listStuckProcessingDocuments: vi.fn(),
  markDocumentIngestFailed: vi.fn(),
}))
vi.mock('./service', () => ({
  INGEST_DISPATCH_FAILED_MESSAGE: 'Ingestion could not be started',
  redispatchStuckDocument: vi.fn(),
}))

import { getTenantContext } from '@/lib/db/tenant-context'
import { listStuckProcessingDocuments, markDocumentIngestFailed, type StuckProcessingDocument } from './repository'
import { redispatchStuckDocument } from './service'
import { STUCK_AFTER_MINUTES, STUCK_BATCH, recoverStuckProcessing } from './stuck-processing'

const row = (over: Partial<StuckProcessingDocument> = {}): StuckProcessingDocument => ({
  id: 'doc-1',
  organizationId: 'org_1',
  jobStatus: null,
  lastError: null,
  ...over,
})

const NOW = new Date('2026-10-06T12:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listStuckProcessingDocuments).mockResolvedValue([])
  vi.mocked(redispatchStuckDocument).mockResolvedValue('requeued')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('recoverStuckProcessing', () => {
  it('asks only for rows that have sat at processing for a quarter of an hour, a bounded batch', async () => {
    await recoverStuckProcessing(NOW)

    expect(listStuckProcessingDocuments).toHaveBeenCalledWith(
      new Date(NOW.getTime() - STUCK_AFTER_MINUTES * 60_000),
      STUCK_BATCH
    )
    expect(STUCK_AFTER_MINUTES).toBe(15)
  })

  it('gives a row with no job a new one, inside its own organization', async () => {
    vi.mocked(listStuckProcessingDocuments).mockResolvedValue([row()])
    let scope: ReturnType<typeof getTenantContext>
    vi.mocked(redispatchStuckDocument).mockImplementation(async () => {
      scope = getTenantContext()
      return 'requeued'
    })

    const result = await recoverStuckProcessing(NOW)

    expect(redispatchStuckDocument).toHaveBeenCalledWith('org_1', 'doc-1')
    expect(scope!).toMatchObject({ kind: 'tenant', organizationId: 'org_1' })
    expect(result).toEqual({ checked: 1, requeued: 1, failed: 0, gone: 0, errors: 0 })
  })

  it('fails a row whose job is dead instead of queueing a fourth attempt at the same file', async () => {
    vi.mocked(listStuckProcessingDocuments).mockResolvedValue([
      row({ jobStatus: 'dead', lastError: 'object store down' }),
    ])

    const result = await recoverStuckProcessing(NOW)

    expect(markDocumentIngestFailed).toHaveBeenCalledWith('doc-1', 'org_1', 'Ingestion could not be started')
    expect(redispatchStuckDocument).not.toHaveBeenCalled()
    expect(result.failed).toBe(1)
  })

  it('counts a row that was gone, or that could not be rebuilt, as what it was', async () => {
    vi.mocked(listStuckProcessingDocuments).mockResolvedValue([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })])
    vi.mocked(redispatchStuckDocument)
      .mockResolvedValueOnce('gone')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('requeued')

    const result = await recoverStuckProcessing(NOW)

    expect(result).toEqual({ checked: 3, requeued: 1, failed: 1, gone: 1, errors: 0 })
  })

  it('goes on to the next row when one throws, and counts the error', async () => {
    vi.mocked(listStuckProcessingDocuments).mockResolvedValue([
      row({ id: 'a', organizationId: 'org_a' }),
      row({ id: 'b', organizationId: 'org_b' }),
    ])
    vi.mocked(redispatchStuckDocument).mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValueOnce('requeued')

    const result = await recoverStuckProcessing(NOW)

    expect(redispatchStuckDocument).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ checked: 2, requeued: 1, failed: 0, gone: 0, errors: 1 })
  })

  it('has nothing to do for an empty list', async () => {
    await expect(recoverStuckProcessing(NOW)).resolves.toEqual({
      checked: 0,
      requeued: 0,
      failed: 0,
      gone: 0,
      errors: 0,
    })
  })
})
