import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
}))
vi.mock('./repository', () => ({
  listOpenBatchesBetween: vi.fn(),
  listInFlightBatchDocuments: vi.fn(),
  latestBatchDocumentAt: vi.fn(),
  sealAbandonedBatch: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./settle', () => ({ settleUploadBatches: vi.fn() }))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn().mockResolvedValue([]) }))

import type { UploadBatch } from '@/lib/db/schema'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { makeDocument } from '@/test-utils/db-fixtures'
import { latestBatchDocumentAt, listInFlightBatchDocuments, listOpenBatchesBetween, sealAbandonedBatch } from './repository'
import { settleUploadBatches } from './settle'
import { ABANDONED_AFTER_MS, sweepUploadBatches } from './sweep'

const NOW = new Date('2026-10-01T12:00:00Z')

const batch = (id: string, ageMs: number, sealed: boolean): UploadBatch => ({
  id,
  organizationId: 'org-1',
  createdBy: 'u',
  scope: 'project',
  projectId: 'proj-1',
  conversationId: null,
  expectedCount: 1,
  excluded: [],
  unchangedCount: 0,
  failedCount: 0,
  sealedAt: sealed ? new Date(NOW.getTime() - ageMs + 1000) : null,
  completedAt: null,
  createdAt: new Date(NOW.getTime() - ageMs),
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listInFlightBatchDocuments).mockResolvedValue([])
  vi.mocked(latestBatchDocumentAt).mockResolvedValue(null)
  vi.mocked(settleUploadBatches).mockResolvedValue([])
})

describe('sweepUploadBatches', () => {
  it('seals a batch whose tab closed long ago, but not one still being uploaded', async () => {
    vi.mocked(listOpenBatchesBetween).mockResolvedValue([
      batch('abandoned', ABANDONED_AFTER_MS + 60_000, false),
      batch('uploading', 5 * 60_000, false),
    ])
    const result = await sweepUploadBatches(NOW)
    expect(sealAbandonedBatch).toHaveBeenCalledTimes(1)
    expect(sealAbandonedBatch).toHaveBeenCalledWith('org-1', 'abandoned', NOW)
    expect(result).toMatchObject({ checked: 2, sealed: 1 })
  })

  it('leaves an old batch open while files still come into it, and seals it once they stop', async () => {
    vi.mocked(listOpenBatchesBetween).mockResolvedValue([
      batch('importing', 3 * ABANDONED_AFTER_MS, false),
      batch('stopped', 3 * ABANDONED_AFTER_MS, false),
    ])
    vi.mocked(latestBatchDocumentAt).mockImplementation(async (_org, id) =>
      id === 'importing' ? new Date(NOW.getTime() - 60_000) : new Date(NOW.getTime() - ABANDONED_AFTER_MS - 60_000)
    )
    const result = await sweepUploadBatches(NOW)
    expect(sealAbandonedBatch).toHaveBeenCalledTimes(1)
    expect(sealAbandonedBatch).toHaveBeenCalledWith('org-1', 'stopped', NOW)
    expect(result).toMatchObject({ sealed: 1 })
  })

  it('reconciles what is still in flight, then settles, and counts what completed', async () => {
    vi.mocked(listOpenBatchesBetween).mockResolvedValue([batch('b1', 10 * 60_000, true)])
    const reading = makeDocument({ id: 'doc-1', status: 'pending' })
    vi.mocked(listInFlightBatchDocuments).mockResolvedValue([reading])
    vi.mocked(settleUploadBatches).mockResolvedValue([batch('b1', 10 * 60_000, true)])

    const result = await sweepUploadBatches(NOW)

    expect(reconcileDocumentStatuses).toHaveBeenCalledWith([reading], 'org-1')
    expect(settleUploadBatches).toHaveBeenCalledWith('org-1', ['b1'])
    expect(result).toMatchObject({ completed: 1, failed: 0 })
  })

  it('keeps going past a batch that fails', async () => {
    vi.mocked(listOpenBatchesBetween).mockResolvedValue([batch('bad', 10 * 60_000, true), batch('good', 10 * 60_000, true)])
    vi.mocked(settleUploadBatches)
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce([batch('good', 10 * 60_000, true)])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await sweepUploadBatches(NOW)

    expect(result).toMatchObject({ checked: 2, completed: 1, failed: 1 })
    warn.mockRestore()
  })
})
