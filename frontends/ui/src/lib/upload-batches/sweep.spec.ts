import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
}))
vi.mock('./repository', () => ({
  listOpenBatchesBetween: vi.fn(),
  listInFlightBatchDocuments: vi.fn(),
  sealAbandonedBatch: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./settle', () => ({ settleUploadBatches: vi.fn() }))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/upload-screening/quarantine-audit', () => ({
  pruneSpentQuarantines: vi.fn().mockResolvedValue(0),
  sweepOwedQuarantines: vi.fn().mockResolvedValue(0),
}))

import type { UploadBatch } from '@/lib/db/schema'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { pruneSpentQuarantines, sweepOwedQuarantines } from '@/lib/upload-screening/quarantine-audit'
import { makeDocument } from '@/test-utils/db-fixtures'
import { listInFlightBatchDocuments, listOpenBatchesBetween, sealAbandonedBatch } from './repository'
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
  vi.mocked(settleUploadBatches).mockResolvedValue([])
  vi.mocked(sweepOwedQuarantines).mockResolvedValue(0)
  vi.mocked(pruneSpentQuarantines).mockResolvedValue(0)
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

  // The content gate's decisions reach the trail at least once (ADR-0083): a
  // send that failed when the row moved is the sweep's, batch or no batch.
  it('sends the quarantine decisions still owed to the audit trail, and counts them', async () => {
    vi.mocked(listOpenBatchesBetween).mockResolvedValue([])
    vi.mocked(sweepOwedQuarantines).mockResolvedValue(2)

    const result = await sweepUploadBatches(NOW)

    expect(sweepOwedQuarantines).toHaveBeenCalledWith(NOW)
    expect(result).toMatchObject({ checked: 0, audited: 2 })
  })

  it('still reports the batches when the owed decisions cannot be listed', async () => {
    vi.mocked(listOpenBatchesBetween).mockResolvedValue([batch('b1', 10 * 60_000, true)])
    vi.mocked(settleUploadBatches).mockResolvedValue([batch('b1', 10 * 60_000, true)])
    vi.mocked(sweepOwedQuarantines).mockRejectedValue(new Error('db hiccup'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await sweepUploadBatches(NOW)

    expect(result).toMatchObject({ completed: 1, audited: 0 })
    warn.mockRestore()
  })

  // Retention (0117): after the send, and even when the send could not run.
  it('deletes the spent quarantine decisions after sending, and counts them', async () => {
    vi.mocked(listOpenBatchesBetween).mockResolvedValue([])
    vi.mocked(sweepOwedQuarantines).mockRejectedValue(new Error('db hiccup'))
    vi.mocked(pruneSpentQuarantines).mockResolvedValue(4)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await sweepUploadBatches(NOW)

    expect(pruneSpentQuarantines).toHaveBeenCalledWith(NOW)
    expect(vi.mocked(sweepOwedQuarantines).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(pruneSpentQuarantines).mock.invocationCallOrder[0]
    )
    expect(result).toMatchObject({ audited: 0, pruned: 4 })
    warn.mockRestore()
  })
})
