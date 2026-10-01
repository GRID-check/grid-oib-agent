/**
 * @vitest-environment node
 */
/**
 * The drain at the service seam: what one claimed delivery does with each
 * answer `uploadDocument` can give, the backoff, the give-up, the hold while
 * the organization's switch is off, and the fence. The SQL behind the claim,
 * the fence and the retention is `repository.integration.spec.ts`.
 */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => await fn()),
}))
vi.mock('@/lib/documents/service', () => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isProjectMailInboxEnabledForOrg: vi.fn() }))
vi.mock('@/lib/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/limits')>()),
  enforceLimit: vi.fn(),
}))
vi.mock('./filing-folder', () => ({ createMailFolder: vi.fn() }))
vi.mock('./notify', () => ({ notifyFiled: vi.fn(), notifyFailed: vi.fn() }))
vi.mock('./staging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./staging')>()),
  readStagedObject: vi.fn(),
  deleteStagedObjects: vi.fn(),
}))
vi.mock('./repository', () => ({
  claimNextDelivery: vi.fn(),
  reapStaleClaims: vi.fn(),
  heartbeat: vi.fn(),
  recordDeliveryFolder: vi.fn(),
  markDeliveryFiled: vi.fn(),
  markDeliveryFailed: vi.fn(),
  scheduleRetry: vi.fn(),
  releaseClaim: vi.fn(),
  findExpiredStaging: vi.fn(),
  clearExpiredStaging: vi.fn(),
  deleteDeliveriesOlderThan: vi.fn(),
}))

import {
  BadRequestError,
  ForbiddenError,
  InsufficientStorageError,
  NotFoundError,
  TooManyRequestsError,
} from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { TransientAuthzError } from '@/lib/authz/errors'
import type { StagedAttachment } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { uploadDocument } from '@/lib/documents/service'
import { DOCUMENT_UPLOAD_LIMIT, enforceLimit } from '@/lib/limits'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { isProjectMailInboxEnabledForOrg } from '@/lib/workos/feature-flags'
import { BACKOFF_MINUTES, DRAIN_MAX_ROWS, MAX_ATTEMPTS, drainDelivery, drainInboundMail, skipReason } from './drain'
import { createMailFolder } from './filing-folder'
import { notifyFailed, notifyFiled } from './notify'
import {
  claimNextDelivery,
  clearExpiredStaging,
  deleteDeliveriesOlderThan,
  findExpiredStaging,
  heartbeat,
  markDeliveryFailed,
  markDeliveryFiled,
  reapStaleClaims,
  recordDeliveryFolder,
  releaseClaim,
  scheduleRetry,
  type ClaimedDelivery,
} from './repository'
import { deleteStagedObjects, readStagedObject } from './staging'

const bytesOf = (name: string) => new TextEncoder().encode(`%PDF ${name}`) as Uint8Array<ArrayBuffer>
const staged = (name: string, n: number): StagedAttachment => ({
  key: `org/org_A/project/project-a/inbound-mail/row-1/${n}`,
  filename: name,
  contentType: 'application/pdf',
  sha256: createHash('sha256').update(bytesOf(name)).digest('hex'),
  size: bytesOf(name).byteLength,
})

function claimed(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    id: 'row-1',
    organizationId: 'org_A',
    projectId: 'project-a',
    addressId: 'addr-a',
    deliveryKey: 'a'.repeat(64),
    senderUserId: 'user-anna',
    status: 'processing',
    folderName: '2026-09-30 10.15 – Anna Berger',
    folderId: null,
    subject: 'Pläne',
    stagingBucket: 'grid-documents',
    staged: [staged('Plan.pdf', 1), staged('Statik.pdf', 2)],
    skipped: [{ filename: 'image001.png', reason: 'embedded' }],
    filedCount: 0,
    skippedCount: 0,
    attempts: 1,
    nextAttemptAt: new Date(),
    claimToken: 'token-1',
    lastError: null,
    receivedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const anna = { userId: 'user-anna', organizationId: 'org_A', permissions: [] } as unknown as AuthorizedSession

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(isProjectMailInboxEnabledForOrg).mockResolvedValue(true)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([['user-anna', { userId: 'user-anna', email: 'anna@buero-a.at', name: 'Anna', profilePictureUrl: null }]])
  )
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(anna)
  vi.mocked(createMailFolder).mockResolvedValue('folder-new')
  vi.mocked(enforceLimit).mockResolvedValue({} as never)
  vi.mocked(readStagedObject).mockImplementation(async (_bucket, key) =>
    bytesOf(key.endsWith('/1') ? 'Plan.pdf' : 'Statik.pdf')
  )
  vi.mocked(uploadDocument).mockImplementation(async (_s, input) => ({
    documentId: `doc-${input.file.name}`,
    jobId: null,
    status: 'pending',
    filename: input.file.name,
    unchanged: false,
  }))
  vi.mocked(deleteStagedObjects).mockResolvedValue([])
  for (const fenced of [heartbeat, recordDeliveryFolder, markDeliveryFiled, markDeliveryFailed, scheduleRetry, releaseClaim]) {
    vi.mocked(fenced).mockResolvedValue(true)
  }
})

describe('filing one delivery', () => {
  it('files every staged object as the pinned sender, with suffix naming and the mail channel', async () => {
    expect(await drainDelivery(claimed())).toBe('filed')

    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_A', userId: 'user-anna' }, expect.any(Function))
    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith(
      { userId: 'user-anna', email: 'anna@buero-a.at', organizationId: 'org_A' },
      { onError: 'throw' }
    )
    const calls = vi.mocked(uploadDocument).mock.calls
    expect(calls.map(([, input]) => input.file.name)).toEqual(['Plan.pdf', 'Statik.pdf'])
    for (const [session, input, request] of calls) {
      expect(session).toBe(anna)
      expect(input).toMatchObject({
        projectId: 'project-a',
        folderId: 'folder-new',
        onNameTaken: 'suffix',
        audit: { channel: 'inbound-mail', ref: 'row-1' },
      })
      // No request: the audit trail records no relay's IP or user agent.
      expect(request).toBeUndefined()
    }
    expect(enforceLimit).toHaveBeenCalledTimes(2)
    expect(enforceLimit).toHaveBeenCalledWith(DOCUMENT_UPLOAD_LIMIT, expect.stringContaining('user-anna'))
  })

  it('creates the folder once, records it under the fence, then heartbeats after each file', async () => {
    await drainDelivery(claimed())
    expect(createMailFolder).toHaveBeenCalledWith(anna, 'project-a', '2026-09-30 10.15 – Anna Berger')
    expect(recordDeliveryFolder).toHaveBeenCalledWith('row-1', 'token-1', 'folder-new')
    expect(heartbeat).toHaveBeenCalledTimes(2)
    expect(heartbeat).toHaveBeenCalledWith('row-1', 'token-1')
  })

  it('reuses the folder a previous attempt recorded, and never recomputes it', async () => {
    await drainDelivery(claimed({ folderId: 'folder-first', attempts: 2 }))
    expect(createMailFolder).not.toHaveBeenCalled()
    expect(recordDeliveryFolder).not.toHaveBeenCalled()
    expect(vi.mocked(uploadDocument).mock.calls[0][1].folderId).toBe('folder-first')
  })

  it('deletes the staging, marks the row filed and tells the sender', async () => {
    await drainDelivery(claimed())
    expect(deleteStagedObjects).toHaveBeenCalledWith('grid-documents', claimed().staged)
    expect(markDeliveryFiled).toHaveBeenCalledWith('row-1', 'token-1', {
      filedCount: 2,
      skipped: [{ filename: 'image001.png', reason: 'embedded' }],
      remaining: [],
    })
    expect(notifyFiled).toHaveBeenCalledWith(expect.objectContaining({ id: 'row-1' }), {
      filed: 2,
      skipped: [{ filename: 'image001.png', reason: 'embedded' }],
      folderId: 'folder-new',
    })
  })

  it('keeps on the row what the staging delete could not remove', async () => {
    const left = [claimed().staged[1]]
    vi.mocked(deleteStagedObjects).mockResolvedValue(left)
    await drainDelivery(claimed())
    expect(vi.mocked(markDeliveryFiled).mock.calls[0][2].remaining).toBe(left)
  })

  it('files a mail with nothing staged without a folder, and still tells the sender', async () => {
    expect(await drainDelivery(claimed({ staged: [], stagingBucket: null }))).toBe('filed')
    expect(createMailFolder).not.toHaveBeenCalled()
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(notifyFiled).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filed: 0 }))
  })

  it('skips a file only for type, size and quota', async () => {
    vi.mocked(uploadDocument)
      .mockRejectedValueOnce(new BadRequestError('File type ".exe" is not permitted', { extension: '.exe', accepted: [] }))
      .mockRejectedValueOnce(new InsufficientStorageError())
    expect(await drainDelivery(claimed())).toBe('filed')
    expect(vi.mocked(markDeliveryFiled).mock.calls[0][2]).toMatchObject({
      filedCount: 0,
      skipped: [
        { filename: 'image001.png', reason: 'embedded' },
        { filename: 'Plan.pdf', reason: 'type' },
        { filename: 'Statik.pdf', reason: 'quota' },
      ],
    })
  })
})

describe('a failed attempt', () => {
  it('turns a 404 from uploadDocument into a retry, never a skip', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new NotFoundError('Folder not found in project'))
    expect(await drainDelivery(claimed())).toBe('retried')
    expect(scheduleRetry).toHaveBeenCalledWith('row-1', 'token-1', BACKOFF_MINUTES[0] * 60, 'NotFoundError:NOT_FOUND')
    expect(markDeliveryFiled).not.toHaveBeenCalled()
    expect(deleteStagedObjects).not.toHaveBeenCalled()
    expect(notifyFiled).not.toHaveBeenCalled()
  })

  it('retries a 403, a transient authz error and an unknown bad request too', async () => {
    for (const error of [
      new ForbiddenError(),
      new TransientAuthzError('fga-check'),
      new BadRequestError('Something else about the request'),
    ]) {
      vi.mocked(uploadDocument).mockRejectedValueOnce(error)
      expect(await drainDelivery(claimed())).toBe('retried')
    }
    expect(markDeliveryFiled).not.toHaveBeenCalled()
  })

  it('backs off on a spent upload budget rather than skipping', async () => {
    vi.mocked(enforceLimit).mockRejectedValueOnce(
      new TooManyRequestsError({ allowed: false, rule: 'document-upload', remaining: 0, limit: 600, retryAfterSeconds: 30, degraded: false })
    )
    expect(await drainDelivery(claimed())).toBe('retried')
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('retries when the staged bytes are not the ones selected', async () => {
    vi.mocked(readStagedObject).mockResolvedValueOnce(bytesOf('something else'))
    expect(await drainDelivery(claimed())).toBe('retried')
    expect(vi.mocked(scheduleRetry).mock.calls[0][3]).toBe('staged-digest-mismatch')
  })

  it('retries when the sender is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    expect(await drainDelivery(claimed())).toBe('retried')
    expect(vi.mocked(scheduleRetry).mock.calls[0][3]).toBe('sender-not-member')
  })

  it('waits longer after each failure: 1, 5, 30 minutes, then 1, 3, 6, 12 hours', async () => {
    vi.mocked(uploadDocument).mockRejectedValue(new NotFoundError())
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await drainDelivery(claimed({ attempts: attempt }))
    }
    expect(vi.mocked(scheduleRetry).mock.calls.map(([, , seconds]) => seconds / 60)).toEqual([1, 5, 30, 60, 180, 360, 720])
  })

  it('gives up after the eighth: marks it failed, deletes the staging and sends the failure notice', async () => {
    vi.mocked(uploadDocument).mockRejectedValue(new NotFoundError())
    expect(await drainDelivery(claimed({ attempts: MAX_ATTEMPTS, folderId: 'folder-first' }))).toBe('failed')
    expect(scheduleRetry).not.toHaveBeenCalled()
    expect(deleteStagedObjects).toHaveBeenCalledWith('grid-documents', claimed().staged)
    expect(markDeliveryFailed).toHaveBeenCalledWith('row-1', 'token-1', {
      filedCount: 0,
      skipped: [{ filename: 'image001.png', reason: 'embedded' }],
      remaining: [],
      lastError: 'NotFoundError:NOT_FOUND',
    })
    expect(notifyFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'row-1', folderId: 'folder-first' }))
  })

  it('gives up without filing when a reaped row comes back with every attempt spent', async () => {
    expect(await drainDelivery(claimed({ attempts: MAX_ATTEMPTS + 1 }))).toBe('failed')
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(notifyFailed).toHaveBeenCalled()
  })
})

describe('the fence and the switch', () => {
  it('stops at once, writing nothing more, when the heartbeat finds the claim gone', async () => {
    vi.mocked(heartbeat).mockResolvedValueOnce(false)
    expect(await drainDelivery(claimed())).toBe('lost')
    expect(uploadDocument).toHaveBeenCalledTimes(1)
    expect(markDeliveryFiled).not.toHaveBeenCalled()
    expect(scheduleRetry).not.toHaveBeenCalled()
    expect(notifyFiled).not.toHaveBeenCalled()
  })

  it('stops when the folder cannot be recorded under the fence', async () => {
    vi.mocked(recordDeliveryFolder).mockResolvedValueOnce(false)
    expect(await drainDelivery(claimed())).toBe('lost')
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('holds a delivery for an hour, spending no attempt, while the switch is off', async () => {
    vi.mocked(isProjectMailInboxEnabledForOrg).mockResolvedValue(false)
    expect(await drainDelivery(claimed())).toBe('held')
    expect(releaseClaim).toHaveBeenCalledWith('row-1', 'token-1', 3600)
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('holds briefly when the switch could not be read', async () => {
    vi.mocked(isProjectMailInboxEnabledForOrg).mockRejectedValue(new TransientAuthzError('feature-flags'))
    expect(await drainDelivery(claimed())).toBe('held')
    expect(releaseClaim).toHaveBeenCalledWith('row-1', 'token-1', 60)
  })
})

describe('drainInboundMail', () => {
  beforeEach(() => {
    vi.mocked(reapStaleClaims).mockResolvedValue(1)
    vi.mocked(findExpiredStaging).mockResolvedValue([])
    vi.mocked(deleteDeliveriesOlderThan).mockResolvedValue(4)
  })

  it('reaps, files what is due until the queue is empty, then sweeps retention', async () => {
    vi.mocked(claimNextDelivery)
      .mockResolvedValueOnce(claimed({ id: 'row-1' }))
      .mockResolvedValueOnce(claimed({ id: 'row-2' }))
      .mockResolvedValueOnce(null)
    expect(await drainInboundMail()).toEqual({
      reaped: 1,
      filed: 2,
      retried: 0,
      failed: 0,
      held: 0,
      lost: 0,
      stagingExpired: 0,
      deleted: 4,
    })
    expect(claimNextDelivery).toHaveBeenCalledTimes(3)
  })

  it('claims at most DRAIN_MAX_ROWS in one call', async () => {
    vi.mocked(claimNextDelivery).mockImplementation(async () => claimed())
    const result = await drainInboundMail()
    expect(result.filed).toBe(DRAIN_MAX_ROWS)
    expect(claimNextDelivery).toHaveBeenCalledTimes(DRAIN_MAX_ROWS)
  })

  it('deletes staging past seven days, fails a row still queued and tells its sender', async () => {
    vi.mocked(claimNextDelivery).mockResolvedValue(null)
    const expired = { ...claimed(), status: 'queued' as const, claimToken: null }
    vi.mocked(findExpiredStaging).mockResolvedValue([expired])
    vi.mocked(clearExpiredStaging).mockResolvedValue(true)

    const result = await drainInboundMail()

    expect(deleteStagedObjects).toHaveBeenCalledWith('grid-documents', expired.staged)
    expect(clearExpiredStaging).toHaveBeenCalledWith(expired, [])
    expect(notifyFailed).toHaveBeenCalledWith(expired)
    expect(result.stagingExpired).toBe(1)
  })

  it('only cleans up the leftover staging of a row already filed, without a second notice', async () => {
    vi.mocked(claimNextDelivery).mockResolvedValue(null)
    vi.mocked(findExpiredStaging).mockResolvedValue([{ ...claimed(), status: 'filed' as const, claimToken: null }])
    vi.mocked(clearExpiredStaging).mockResolvedValue(true)
    await drainInboundMail()
    expect(notifyFailed).not.toHaveBeenCalled()
  })
})

describe('skipReason', () => {
  it('names the three refusals about the file, and nothing else', () => {
    expect(skipReason(new InsufficientStorageError())).toBe('quota')
    expect(skipReason(new BadRequestError('too big', { fileSize: 9, maxSizeBytes: 1 }))).toBe('size')
    expect(skipReason(new BadRequestError('type', { extension: '.exe', accepted: [] }))).toBe('type')
    expect(skipReason(new BadRequestError('other'))).toBeNull()
    expect(skipReason(new NotFoundError())).toBeNull()
    expect(skipReason(new ForbiddenError())).toBeNull()
    expect(skipReason(new Error('boom'))).toBeNull()
  })
})
