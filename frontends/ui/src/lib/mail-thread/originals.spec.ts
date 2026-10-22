/**
 * @vitest-environment node
 */
/**
 * A filed message's original (D6): the move to the entry's own key loses no
 * byte at any step and finishes on a retry; the download is scanned whole on
 * every request and served only clean, to whoever may read the thread, and is
 * recorded either way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbound-mail/staging', () => ({
  RAW_MESSAGE_CONTENT_TYPE: 'message/rfc822',
  readStagedObject: vi.fn(),
  putStagedObject: vi.fn(async () => undefined),
  eraseStagedObjects: vi.fn(async () => []),
}))
vi.mock('./write-repository', () => ({
  findEntry: vi.fn(),
  recordEntryOriginal: vi.fn(async () => undefined),
  forgetMovedRaw: vi.fn(async () => undefined),
}))
vi.mock('./repository', () => ({ findVisibleThread: vi.fn() }))
vi.mock('@/lib/inbound-mail/malware-scan', () => ({ scanForStorage: vi.fn() }))
vi.mock('@/lib/inbound-mail/access', () => ({ requireInboundMailEnabled: vi.fn() }))
vi.mock('@/lib/inbound-mail/decision', async () => {
  const { ConflictError } = await import('@/lib/api/errors')
  return {
    refusal: (reason: string, message: string, details = {}) =>
      new ConflictError(message, { reason, ...details }),
  }
})
vi.mock('@/lib/inbound-mail/service', () => ({
  heldBytesHeaders: (type: string, name: string) => ({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${name}"`,
    'X-Content-Type-Options': 'nosniff',
  }),
}))
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(async () => ({ closed: false })),
}))
vi.mock('@/lib/authz/folder-access', () => ({ getHiddenFolderIds: vi.fn(async () => []) }))
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))

import { createHash } from 'node:crypto'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailThreadEntryRow } from '@/lib/db/schema'
import {
  heldMail,
  MAIL_ID,
  PERSON,
  PROJECT_ID,
  THREAD_ID,
} from '@/lib/inbound-mail/__fixtures__/review'
import { scanForStorage } from '@/lib/inbound-mail/malware-scan'
import { eraseStagedObjects, putStagedObject, readStagedObject } from '@/lib/inbound-mail/staging'
import { finishOriginalMove, readEntryOriginal } from './originals'
import { findVisibleThread, type ThreadRow } from './repository'
import { findEntry, forgetMovedRaw, recordEntryOriginal } from './write-repository'

const ENTRY_ID = 'e1000000-0000-4000-8000-000000000184'
const RAW = new TextEncoder().encode(
  'From: p.weber@statik-weber.at\r\nSubject: Statik\r\n\r\nFreigegeben.\r\n'
)
const ORIGINAL_KEY = `org/org_1/project/${PROJECT_ID}/_mail-originals/${ENTRY_ID}.eml`
const session = {
  userId: PERSON,
  organizationId: 'org_1',
  email: 'petra@example.test',
} as AuthorizedSession

describe('moving the raw message to the entry’s original', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readStagedObject).mockResolvedValue(RAW)
    vi.mocked(eraseStagedObjects).mockResolvedValue([])
  })

  it('copies it to the entry’s own key, proves the copy, records it, and only then erases the raw', async () => {
    const mail = heldMail()
    expect(await finishOriginalMove(mail, { id: ENTRY_ID, originalStorageKey: null })).toBe('moved')
    expect(putStagedObject).toHaveBeenCalledWith(
      mail.stagingBucket,
      ORIGINAL_KEY,
      RAW,
      'message/rfc822'
    )
    expect(recordEntryOriginal).toHaveBeenCalledWith(ENTRY_ID, {
      originalBucket: mail.stagingBucket,
      originalStorageKey: ORIGINAL_KEY,
      originalSha256: createHash('sha256').update(RAW).digest('hex'),
      originalBytes: RAW.byteLength,
      originalScanStatus: 'clean',
      originalScannedAt: mail.rawScannedAt,
    })
    expect(eraseStagedObjects).toHaveBeenCalledWith(mail.stagingBucket, [mail.rawStorageKey])
    expect(forgetMovedRaw).toHaveBeenCalledWith(MAIL_ID)
    expect(vi.mocked(recordEntryOriginal).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(eraseStagedObjects).mock.invocationCallOrder[0]!
    )
  })

  it('keeps the raw when the copy does not read back as written', async () => {
    vi.mocked(readStagedObject).mockResolvedValueOnce(RAW).mockResolvedValueOnce(RAW.slice(1))
    await expect(
      finishOriginalMove(heldMail(), { id: ENTRY_ID, originalStorageKey: null })
    ).rejects.toThrow(/did not read back/)
    expect(recordEntryOriginal).not.toHaveBeenCalled()
    expect(eraseStagedObjects).not.toHaveBeenCalled()
  })

  it('finishes a move that stopped after the copy: no second copy, the raw erased and forgotten', async () => {
    expect(
      await finishOriginalMove(heldMail(), { id: ENTRY_ID, originalStorageKey: ORIGINAL_KEY })
    ).toBe('moved')
    expect(putStagedObject).not.toHaveBeenCalled()
    expect(forgetMovedRaw).toHaveBeenCalledWith(MAIL_ID)
  })

  it('keeps the key while the raw could not be erased, for the next run', async () => {
    vi.mocked(eraseStagedObjects).mockResolvedValueOnce([heldMail().rawStorageKey!])
    await expect(
      finishOriginalMove(heldMail(), { id: ENTRY_ID, originalStorageKey: ORIGINAL_KEY })
    ).rejects.toThrow(/could not be erased/)
    expect(forgetMovedRaw).not.toHaveBeenCalled()
  })

  it('does nothing once the raw is gone', async () => {
    expect(
      await finishOriginalMove(heldMail({ rawStorageKey: null }), {
        id: ENTRY_ID,
        originalStorageKey: ORIGINAL_KEY,
      })
    ).toBe('already')
    expect(readStagedObject).not.toHaveBeenCalled()
  })
})

describe('downloading a filed message’s original', () => {
  const entry = (overrides: Partial<MailThreadEntryRow> = {}) =>
    ({
      id: ENTRY_ID,
      threadId: THREAD_ID,
      senderTrust: 'external_verified',
      originalBucket: 'tenant-org-1',
      originalStorageKey: ORIGINAL_KEY,
      ...overrides,
    }) as MailThreadEntryRow
  const read = () => readEntryOriginal(session, PROJECT_ID, THREAD_ID, ENTRY_ID)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findVisibleThread).mockResolvedValue({ id: THREAD_ID } as ThreadRow)
    vi.mocked(findEntry).mockResolvedValue(entry())
    vi.mocked(readStagedObject).mockResolvedValue(RAW)
    vi.mocked(scanForStorage).mockResolvedValue({
      status: 'clean',
      engine: 'ClamAV 1.5.4/28157',
      signature: null,
      scannedAt: new Date(),
    })
  })

  it('serves it clean, as a download never sniffed, scanned on this request and recorded', async () => {
    const response = await read()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('message/rfc822')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(RAW)
    expect(scanForStorage).toHaveBeenCalledWith(RAW)
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mail_thread.original_read',
        targetId: ENTRY_ID,
        metadata: { projectId: PROJECT_ID, scan: 'clean' },
      })
    )
  })

  it.each(['infected', 'failed'] as const)(
    'refuses %s with 409 original_not_clean, and records the attempt',
    async (status) => {
      vi.mocked(scanForStorage).mockResolvedValueOnce({
        status,
        engine: null,
        signature: status === 'infected' ? 'Eicar' : null,
        scannedAt: new Date(),
      })
      await expect(read()).rejects.toMatchObject({
        status: 409,
        details: { reason: 'original_not_clean', scan: status },
      })
      expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { projectId: PROJECT_ID, scan: status } })
      )
    }
  )

  it('answers `gone` for a message without an original (an archive entry)', async () => {
    vi.mocked(findEntry).mockResolvedValueOnce(
      entry({ originalBucket: null, originalStorageKey: null })
    )
    await expect(read()).rejects.toMatchObject({ details: { reason: 'gone' } })
    expect(scanForStorage).not.toHaveBeenCalled()
  })

  it('is not found for a thread the reader may not read, or a message of another thread', async () => {
    vi.mocked(findVisibleThread).mockResolvedValueOnce(null)
    await expect(read()).rejects.toMatchObject({ status: 404 })
    vi.mocked(findEntry).mockResolvedValueOnce(entry({ threadId: 'another-thread' }))
    await expect(read()).rejects.toMatchObject({ status: 404 })
    expect(readStagedObject).not.toHaveBeenCalled()
  })
})
