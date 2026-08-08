import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'

vi.mock('server-only', () => ({}))

const send = vi.fn()
vi.mock('@/lib/s3', () => ({
  s3Client: { send: (...args: unknown[]) => send(...args) },
}))

const admitDocumentWithinQuota = vi.fn()
vi.mock('./service', () => ({
  admitDocumentWithinQuota: (...args: unknown[]) => admitDocumentWithinQuota(...args),
}))

import { InsufficientStorageError } from '@/lib/api/errors'
import { admitOrDiscard } from './admission'
import type { NewDocument } from '@/lib/db/schema'

/**
 * The object is written before the row, because a `documents` row implies its
 * bytes exist and every read path assumes that. The cost of that order is this
 * module: admission can refuse AFTER the upload, and a refused upload must not
 * leave an object nothing references.
 *
 * An orphan there is worse than it sounds — invisible to the UI, invisible to the
 * quota ledger (which counts rows), findable only by a bucket-wide sweep — so
 * these tests are about a leak, not about tidiness.
 */
const ROW = {
  id: 'doc-1',
  organizationId: 'org-1',
  storageKey: 'org/org-1/project/p1/doc-1/report.pdf',
  fileSize: 5_000,
} as unknown as NewDocument

const BUCKET = 'grid-org-org-1-abc'

describe('admitOrDiscard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    send.mockResolvedValue({})
  })

  it('keeps the object when the row is admitted', async () => {
    admitDocumentWithinQuota.mockResolvedValue(undefined)
    await admitOrDiscard(BUCKET, ROW.storageKey, ROW)
    expect(admitDocumentWithinQuota).toHaveBeenCalledWith(ROW)
    expect(send).not.toHaveBeenCalled()
  })

  it('deletes the object it just wrote when admission refuses', async () => {
    admitDocumentWithinQuota.mockRejectedValue(new InsufficientStorageError())

    await expect(admitOrDiscard(BUCKET, ROW.storageKey, ROW)).rejects.toBeInstanceOf(
      InsufficientStorageError,
    )

    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0]
    expect(command).toBeInstanceOf(DeleteObjectCommand)
    // The bucket it was written to, not the shared one — the row was never
    // inserted, so nothing else records where those bytes went.
    expect(command.input).toEqual({ Bucket: BUCKET, Key: ROW.storageKey })
  })

  it('re-throws the refusal, so the caller reports the quota and not a 500', async () => {
    const refusal = new InsufficientStorageError('no room', {
      quotaBytes: 10,
      usedBytes: 10,
      requestedBytes: 5,
    })
    admitDocumentWithinQuota.mockRejectedValue(refusal)
    await expect(admitOrDiscard(BUCKET, ROW.storageKey, ROW)).rejects.toBe(refusal)
  })

  // Any failure, not just a quota refusal: a row that was not inserted for ANY
  // reason leaves the same orphan.
  it('also cleans up when the insert fails for a reason other than the quota', async () => {
    admitDocumentWithinQuota.mockRejectedValue(new Error('deadlock detected'))
    await expect(admitOrDiscard(BUCKET, ROW.storageKey, ROW)).rejects.toThrow('deadlock detected')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('still reports the original failure when the cleanup itself fails', async () => {
    // Turning a quota refusal into a 500 because the tidy-up failed would hide
    // the one thing the user can act on. The orphan is logged and the purge
    // collects it with its project.
    const refusal = new InsufficientStorageError()
    admitDocumentWithinQuota.mockRejectedValue(refusal)
    send.mockRejectedValue(new Error('AccessDenied'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(admitOrDiscard(BUCKET, ROW.storageKey, ROW)).rejects.toBe(refusal)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
