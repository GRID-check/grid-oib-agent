/**
 * @vitest-environment node
 */
/**
 * The `inbound_mail` job at the service seam: what one attempt does with each
 * answer the filer can give, the backoff by fresh jobs, the give-up, the hold
 * while the organization's switch is off, the fence, and the sweep. The SQL
 * behind the fence, the stalled listing and the retention is
 * `repository.integration.spec.ts`; the filer itself is
 * `lib/mail-import/filing.spec.ts`.
 */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => await fn()),
}))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isProjectMailInboxEnabledForOrg: vi.fn() }))
vi.mock('@/lib/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/limits')>()),
  enforceLimit: vi.fn(),
}))
vi.mock('@/lib/mail-import/filing', () => ({
  MailImportQuotaError: class MailImportQuotaError extends Error {},
  createFolderWithFreeName: vi.fn(),
  fileBytes: vi.fn(),
}))
vi.mock('@/lib/documents/shelf', () => ({ projectShelf: (projectId: string) => ({ kind: 'project', projectId }) }))
vi.mock('@/lib/documents/shelf-authz', () => ({ requireShelfWrite: vi.fn() }))
vi.mock('@/lib/documents/folder-path', () => ({ resolveShelfFolderPath: vi.fn() }))
vi.mock('@/lib/projects/folder-service', () => ({ getOrCreateProjectFolderByName: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/jobs-queue/repository', () => ({ findOpenJobId: vi.fn() }))
vi.mock('./notify', () => ({ notifyFiled: vi.fn(), notifyFailed: vi.fn() }))
vi.mock('./staging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./staging')>()),
  readStagedObject: vi.fn(),
  deleteStagedObjects: vi.fn(),
}))
vi.mock('./repository', () => ({
  findDeliveryRow: vi.fn(),
  touchDelivery: vi.fn(),
  recordDeliveryFolder: vi.fn(),
  recordFailedAttempt: vi.fn(),
  markDeliveryFiled: vi.fn(),
  markDeliveryFailed: vi.fn(),
  listStalledDeliveries: vi.fn(),
  findExpiredStaging: vi.fn(),
  clearExpiredStaging: vi.fn(),
  deleteDeliveriesOlderThan: vi.fn(),
}))

import { ForbiddenError, NotFoundError, TooManyRequestsError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { TransientAuthzError } from '@/lib/authz/errors'
import type { InboundMailMessageRow, StagedAttachment } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { resolveShelfFolderPath } from '@/lib/documents/folder-path'
import { requireShelfWrite } from '@/lib/documents/shelf-authz'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { DOCUMENT_UPLOAD_LIMIT, enforceLimit } from '@/lib/limits'
import { createFolderWithFreeName, fileBytes, MailImportQuotaError } from '@/lib/mail-import/filing'
import { getOrCreateProjectFolderByName } from '@/lib/projects/folder-service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { isProjectMailInboxEnabledForOrg } from '@/lib/workos/feature-flags'
import { BACKOFF_MINUTES, INBOUND_MAIL_ROOT_FOLDER, MAX_ATTEMPTS, runInboundMailJob, sweepInboundMail } from './job'
import { notifyFailed, notifyFiled } from './notify'
import {
  clearExpiredStaging,
  deleteDeliveriesOlderThan,
  findDeliveryRow,
  findExpiredStaging,
  listStalledDeliveries,
  markDeliveryFailed,
  markDeliveryFiled,
  recordDeliveryFolder,
  recordFailedAttempt,
  touchDelivery,
} from './repository'
import { deleteStagedObjects, readStagedObject } from './staging'

const ROW_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT = '22222222-2222-4222-8222-222222222222'
const PAYLOAD = { deliveryId: ROW_ID, projectId: PROJECT }
const LEAF = '2026-09-30 10.15 – Anna Berger'

const bytesOf = (name: string) => new TextEncoder().encode(`%PDF ${name}`) as Uint8Array<ArrayBuffer>
const staged = (name: string, n: number): StagedAttachment => ({
  key: `org/org_A/project/${PROJECT}/inbound-mail/${ROW_ID}/${n}`,
  filename: name,
  contentType: 'application/pdf',
  sha256: createHash('sha256').update(bytesOf(name)).digest('hex'),
  size: bytesOf(name).byteLength,
})

function delivery(overrides: Partial<InboundMailMessageRow> = {}): InboundMailMessageRow {
  return {
    id: ROW_ID,
    organizationId: 'org_A',
    projectId: PROJECT,
    addressId: 'addr-a',
    deliveryKey: 'a'.repeat(64),
    senderUserId: 'user-anna',
    status: 'queued',
    folderName: LEAF,
    folderId: null,
    subject: 'Pläne',
    stagingBucket: 'grid-documents',
    staged: [staged('Plan.pdf', 1), staged('Statik.pdf', 2)],
    skipped: [{ filename: 'image001.png', reason: 'embedded' }],
    filedCount: 0,
    skippedCount: 0,
    attempts: 0,
    lastError: null,
    receivedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const anna = { userId: 'user-anna', organizationId: 'org_A', permissions: [] } as unknown as AuthorizedSession

/** The job's run, with the row `findDeliveryRow` returns. */
async function run(row: InboundMailMessageRow = delivery()) {
  vi.mocked(findDeliveryRow).mockResolvedValue(row)
  return runInboundMailJob('org_A', PAYLOAD)
}

/** The `notBefore` of the n-th enqueued job, in minutes from now. */
function enqueuedAfterMinutes(call = 0): number {
  const notBefore = vi.mocked(enqueueJob).mock.calls[call][0].notBefore
  return Math.round(((notBefore?.getTime() ?? Date.now()) - Date.now()) / 60_000)
}

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
  vi.mocked(getOrCreateProjectFolderByName).mockResolvedValue({ id: 'folder-root' } as never)
  vi.mocked(createFolderWithFreeName).mockResolvedValue({ id: 'folder-new', name: LEAF })
  vi.mocked(enforceLimit).mockResolvedValue({} as never)
  vi.mocked(readStagedObject).mockImplementation(async (_bucket, key) =>
    bytesOf(key.endsWith('/1') ? 'Plan.pdf' : 'Statik.pdf')
  )
  vi.mocked(fileBytes).mockImplementation(async (_target, _folder, desired) => ({
    filed: true,
    filename: desired,
    unchanged: false,
  }))
  vi.mocked(deleteStagedObjects).mockResolvedValue([])
  for (const fenced of [touchDelivery, recordDeliveryFolder, recordFailedAttempt, markDeliveryFiled, markDeliveryFailed]) {
    vi.mocked(fenced).mockResolvedValue(true)
  }
})

describe('filing one delivery', () => {
  it('files every staged object through the mail filer, as the sender, under the mail channel', async () => {
    expect(await run()).toBe('filed')

    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_A', userId: 'user-anna' }, expect.any(Function))
    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith(
      { userId: 'user-anna', email: 'anna@buero-a.at', organizationId: 'org_A' },
      { onError: 'throw' }
    )
    const calls = vi.mocked(fileBytes).mock.calls
    // The mail's folder name first, as an imported mail's files are named.
    expect(calls.map(([, , desired]) => desired)).toEqual([`${LEAF} – Plan.pdf`, `${LEAF} – Statik.pdf`])
    for (const [target, folderId, , , contentType, claimed] of calls) {
      expect(target).toMatchObject({
        session: anna,
        projectId: PROJECT,
        priority: 'interactive',
        audit: { channel: 'inbound-mail', ref: ROW_ID },
      })
      expect(target.request.headers.get('user-agent')).toBe('piloti-inbound-mail')
      expect(folderId).toBe('folder-new')
      expect(contentType).toBe('application/pdf')
      // One set for the whole mail: the second `scan.pdf` of a mail is numbered.
      expect(claimed).toBe(calls[0][5])
    }
    expect(enforceLimit).toHaveBeenCalledTimes(2)
    expect(enforceLimit).toHaveBeenCalledWith(DOCUMENT_UPLOAD_LIMIT, expect.stringContaining('user-anna'))
  })

  it('checks the sender may write, then makes the folder once under E-Mail-Eingang and records it', async () => {
    await run()
    expect(requireShelfWrite).toHaveBeenCalledWith(anna, { kind: 'project', projectId: PROJECT })
    expect(getOrCreateProjectFolderByName).toHaveBeenCalledWith(PROJECT, INBOUND_MAIL_ROOT_FOLDER, 'org_A')
    expect(createFolderWithFreeName).toHaveBeenCalledWith(expect.objectContaining({ session: anna }), 'folder-root', LEAF)
    expect(recordDeliveryFolder).toHaveBeenCalledWith('org_A', ROW_ID, 'folder-new')
    expect(touchDelivery).toHaveBeenCalledTimes(2)
  })

  it('reuses the folder a previous attempt recorded, under the name it has now', async () => {
    vi.mocked(resolveShelfFolderPath).mockResolvedValue(`${INBOUND_MAIL_ROOT_FOLDER}/${LEAF} (2)`)
    await run(delivery({ folderId: 'folder-first', attempts: 2 }))
    expect(createFolderWithFreeName).not.toHaveBeenCalled()
    expect(recordDeliveryFolder).not.toHaveBeenCalled()
    expect(vi.mocked(fileBytes).mock.calls[0].slice(1, 3)).toEqual(['folder-first', `${LEAF} (2) – Plan.pdf`])
  })

  it('makes a new folder when the recorded one was deleted meanwhile', async () => {
    vi.mocked(resolveShelfFolderPath).mockResolvedValue(null)
    await run(delivery({ folderId: 'folder-gone' }))
    expect(createFolderWithFreeName).toHaveBeenCalled()
    expect(vi.mocked(fileBytes).mock.calls[0][1]).toBe('folder-new')
  })

  it('deletes the staging, marks the row filed and tells the sender', async () => {
    await run()
    expect(deleteStagedObjects).toHaveBeenCalledWith('grid-documents', delivery().staged)
    expect(markDeliveryFiled).toHaveBeenCalledWith('org_A', ROW_ID, {
      filedCount: 2,
      skipped: [{ filename: 'image001.png', reason: 'embedded' }],
      remaining: [],
    })
    expect(notifyFiled).toHaveBeenCalledWith(expect.objectContaining({ id: ROW_ID }), {
      filed: 2,
      skipped: [{ filename: 'image001.png', reason: 'embedded' }],
      folderId: 'folder-new',
    })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('keeps on the row what the staging delete could not remove', async () => {
    const left = [delivery().staged[1]]
    vi.mocked(deleteStagedObjects).mockResolvedValue(left)
    await run()
    expect(vi.mocked(markDeliveryFiled).mock.calls[0][2].remaining).toBe(left)
  })

  it('files a mail with nothing staged without a folder, and still tells the sender', async () => {
    expect(await run(delivery({ staged: [], stagingBucket: null }))).toBe('filed')
    expect(createFolderWithFreeName).not.toHaveBeenCalled()
    expect(fileBytes).not.toHaveBeenCalled()
    expect(notifyFiled).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filed: 0 }))
  })

  it('skips a file only for its type, its size over the organization limit, the name screening and a full quota', async () => {
    vi.mocked(fileBytes)
      .mockResolvedValueOnce({ filed: false, reason: 'size' })
      .mockRejectedValueOnce(new MailImportQuotaError())
    expect(await run()).toBe('filed')
    expect(vi.mocked(markDeliveryFiled).mock.calls[0][2]).toMatchObject({
      filedCount: 0,
      skipped: [
        { filename: 'image001.png', reason: 'embedded' },
        { filename: 'Plan.pdf', reason: 'size' },
        { filename: 'Statik.pdf', reason: 'quota' },
      ],
    })
    vi.mocked(fileBytes).mockResolvedValueOnce({ filed: false, reason: 'type' })
    await run()
    expect(vi.mocked(markDeliveryFiled).mock.calls[1][2].skipped[1]).toEqual({ filename: 'Plan.pdf', reason: 'type' })
    vi.mocked(fileBytes).mockResolvedValueOnce({ filed: false, reason: 'screened' })
    await run()
    expect(vi.mocked(markDeliveryFiled).mock.calls[2][2].skipped[1]).toEqual({ filename: 'Plan.pdf', reason: 'screened' })
  })

  it('does nothing for a delivery that is no longer queued', async () => {
    expect(await run(delivery({ status: 'filed' }))).toBe('gone')
    vi.mocked(findDeliveryRow).mockResolvedValue(null)
    expect(await runInboundMailJob('org_A', PAYLOAD)).toBe('gone')
    expect(fileBytes).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})

describe('a failed attempt', () => {
  it('counts it and hands the delivery to a fresh job after the first backoff, never a skip', async () => {
    vi.mocked(fileBytes).mockRejectedValueOnce(new NotFoundError('Folder not found in project'))
    expect(await run()).toBe('retried')
    expect(recordFailedAttempt).toHaveBeenCalledWith('org_A', ROW_ID, 1, 'NotFoundError:NOT_FOUND')
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inbound_mail', organizationId: 'org_A', payload: PAYLOAD })
    )
    expect(enqueuedAfterMinutes()).toBe(BACKOFF_MINUTES[0])
    expect(markDeliveryFiled).not.toHaveBeenCalled()
    expect(deleteStagedObjects).not.toHaveBeenCalled()
    expect(notifyFiled).not.toHaveBeenCalled()
  })

  it('retries a folder turned read-only and a name taken after the probe: neither is about the file', async () => {
    for (const reason of ['access', 'name_taken'] as const) {
      vi.mocked(fileBytes).mockResolvedValueOnce({ filed: false, reason })
      expect(await run()).toBe('retried')
      expect(recordFailedAttempt).toHaveBeenLastCalledWith('org_A', ROW_ID, 1, `upload-refused-${reason}`)
    }
    expect(markDeliveryFiled).not.toHaveBeenCalled()
  })

  it('retries a 403 and a transient authz error too', async () => {
    for (const error of [new ForbiddenError(), new TransientAuthzError('fga-check')]) {
      vi.mocked(fileBytes).mockRejectedValueOnce(error)
      expect(await run()).toBe('retried')
    }
    expect(markDeliveryFiled).not.toHaveBeenCalled()
  })

  it('backs off on a spent upload budget rather than skipping', async () => {
    vi.mocked(enforceLimit).mockRejectedValueOnce(
      new TooManyRequestsError({ allowed: false, rule: 'document-upload', remaining: 0, limit: 600, retryAfterSeconds: 30, degraded: false })
    )
    expect(await run()).toBe('retried')
    expect(fileBytes).not.toHaveBeenCalled()
  })

  it('retries when the staged bytes are not the ones selected', async () => {
    vi.mocked(readStagedObject).mockResolvedValueOnce(bytesOf('something else'))
    expect(await run()).toBe('retried')
    expect(vi.mocked(recordFailedAttempt).mock.calls[0][3]).toBe('staged-digest-mismatch')
  })

  it('retries when the sender is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    expect(await run()).toBe('retried')
    expect(vi.mocked(recordFailedAttempt).mock.calls[0][3]).toBe('sender-not-member')
  })

  it('waits longer after each failure: 1, 5, 30 minutes, then 1, 3, 6, 12 hours', async () => {
    vi.mocked(fileBytes).mockRejectedValue(new NotFoundError())
    for (let attempts = 0; attempts < MAX_ATTEMPTS - 1; attempts += 1) {
      await run(delivery({ attempts }))
    }
    const waits = vi.mocked(enqueueJob).mock.calls.map((_, call) => enqueuedAfterMinutes(call))
    expect(waits).toEqual([1, 5, 30, 60, 180, 360, 720])
  })

  it('gives up after the eighth: marks it failed, deletes the staging and sends the failure notice', async () => {
    vi.mocked(fileBytes).mockRejectedValue(new NotFoundError())
    expect(await run(delivery({ attempts: MAX_ATTEMPTS - 1, folderId: null }))).toBe('failed')
    expect(enqueueJob).not.toHaveBeenCalled()
    expect(deleteStagedObjects).toHaveBeenCalledWith('grid-documents', delivery().staged)
    expect(markDeliveryFailed).toHaveBeenCalledWith('org_A', ROW_ID, {
      filedCount: 0,
      skipped: [{ filename: 'image001.png', reason: 'embedded' }],
      remaining: [],
      lastError: 'NotFoundError:NOT_FOUND',
    })
    expect(notifyFailed).toHaveBeenCalledWith(expect.objectContaining({ id: ROW_ID }))
  })

  it('lets the queue retry the job when even recording the failure fails', async () => {
    vi.mocked(fileBytes).mockRejectedValueOnce(new NotFoundError())
    vi.mocked(recordFailedAttempt).mockRejectedValueOnce(new Error('database gone'))
    await expect(run()).rejects.toThrow('database gone')
  })
})

describe('the fence and the switch', () => {
  it('stops at once, writing nothing more, when another job finished the delivery meanwhile', async () => {
    vi.mocked(touchDelivery).mockResolvedValueOnce(false)
    expect(await run()).toBe('gone')
    expect(fileBytes).toHaveBeenCalledTimes(1)
    expect(markDeliveryFiled).not.toHaveBeenCalled()
    expect(recordFailedAttempt).not.toHaveBeenCalled()
    expect(notifyFiled).not.toHaveBeenCalled()
  })

  it('stops when the folder cannot be recorded because the row moved on', async () => {
    vi.mocked(recordDeliveryFolder).mockResolvedValueOnce(false)
    expect(await run()).toBe('gone')
    expect(fileBytes).not.toHaveBeenCalled()
  })

  it('tells nobody twice: a mark that finds the row finished sends no notice', async () => {
    vi.mocked(markDeliveryFiled).mockResolvedValueOnce(false)
    expect(await run()).toBe('gone')
    expect(notifyFiled).not.toHaveBeenCalled()
  })

  it('holds a delivery for an hour, spending no attempt, while the switch is off', async () => {
    vi.mocked(isProjectMailInboxEnabledForOrg).mockResolvedValue(false)
    expect(await run()).toBe('held')
    expect(enqueuedAfterMinutes()).toBe(60)
    expect(recordFailedAttempt).not.toHaveBeenCalled()
    expect(fileBytes).not.toHaveBeenCalled()
  })

  it('holds briefly when the switch could not be read', async () => {
    vi.mocked(isProjectMailInboxEnabledForOrg).mockRejectedValue(new TransientAuthzError('feature-flags'))
    expect(await run()).toBe('held')
    expect(enqueuedAfterMinutes()).toBe(1)
  })
})

describe('sweepInboundMail', () => {
  beforeEach(() => {
    vi.mocked(listStalledDeliveries).mockResolvedValue([])
    vi.mocked(findExpiredStaging).mockResolvedValue([])
    vi.mocked(deleteDeliveriesOlderThan).mockResolvedValue(4)
  })

  it('leaves a stalled delivery that still has a job alone', async () => {
    vi.mocked(listStalledDeliveries).mockResolvedValue([delivery()])
    vi.mocked(findOpenJobId).mockResolvedValue('job-1')
    expect(await sweepInboundMail()).toMatchObject({ waiting: 1, requeued: 0, deleted: 4 })
    expect(findOpenJobId).toHaveBeenCalledWith({
      kind: 'inbound_mail',
      organizationId: 'org_A',
      matching: { deliveryId: ROW_ID },
    })
    expect(enqueueJob).not.toHaveBeenCalled()
    // ...and moves it to the back of the stalled list, so twenty held mails
    // cannot hide one whose job is gone.
    expect(touchDelivery).toHaveBeenCalledWith('org_A', ROW_ID)
  })

  it('gives a delivery without a job a new one now, counted as an attempt', async () => {
    vi.mocked(listStalledDeliveries).mockResolvedValue([delivery({ attempts: 2 })])
    vi.mocked(findOpenJobId).mockResolvedValue(null)
    expect(await sweepInboundMail()).toMatchObject({ requeued: 1 })
    expect(recordFailedAttempt).toHaveBeenCalledWith('org_A', ROW_ID, 3, 'job-lost')
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'inbound_mail', payload: PAYLOAD }))
    expect(vi.mocked(enqueueJob).mock.calls[0][0].notBefore).toBeUndefined()
  })

  it('gives up on a delivery that keeps losing its job', async () => {
    vi.mocked(listStalledDeliveries).mockResolvedValue([delivery({ attempts: MAX_ATTEMPTS - 1 })])
    vi.mocked(findOpenJobId).mockResolvedValue(null)
    expect(await sweepInboundMail()).toMatchObject({ failed: 1, requeued: 0 })
    expect(vi.mocked(markDeliveryFailed).mock.calls[0][2].lastError).toBe('job-lost')
    expect(notifyFailed).toHaveBeenCalled()
  })

  it('counts a row it could not settle and carries on', async () => {
    vi.mocked(listStalledDeliveries).mockResolvedValue([delivery({ id: 'row-x' }), delivery()])
    vi.mocked(findOpenJobId).mockRejectedValueOnce(new Error('database gone')).mockResolvedValueOnce('job-1')
    expect(await sweepInboundMail()).toMatchObject({ errors: 1, waiting: 1 })
  })

  it('deletes staging past seven days, fails a row still queued and tells its sender', async () => {
    const expired = delivery()
    vi.mocked(findExpiredStaging).mockResolvedValue([expired])
    vi.mocked(clearExpiredStaging).mockResolvedValue(true)

    const result = await sweepInboundMail()

    expect(deleteStagedObjects).toHaveBeenCalledWith('grid-documents', expired.staged)
    expect(clearExpiredStaging).toHaveBeenCalledWith(expired, [])
    expect(notifyFailed).toHaveBeenCalledWith(expired)
    expect(result.stagingExpired).toBe(1)
  })

  it('only cleans up the leftover staging of a row already filed, without a second notice', async () => {
    vi.mocked(findExpiredStaging).mockResolvedValue([delivery({ status: 'filed' })])
    vi.mocked(clearExpiredStaging).mockResolvedValue(true)
    await sweepInboundMail()
    expect(notifyFailed).not.toHaveBeenCalled()
  })
})
