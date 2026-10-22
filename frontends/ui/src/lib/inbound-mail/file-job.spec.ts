/**
 * @vitest-environment node
 */
/**
 * The filing job (`inbound_mail_file`): each claimed part filed as the person
 * who decided, from its decision row; the attachments before the text, so the
 * entry knows what became of them; every refusal a part waiting again with its
 * failure; a thread being written makes the run wait without spending an
 * attempt; a mail all of whose parts are filed settles.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./filing-repository', () => ({
  findFilingWork: vi.fn(),
  markAttachmentFiled: vi.fn(async () => true),
  projectIsHeld: vi.fn(async () => false),
  recordFilingScan: vi.fn(async () => undefined),
  renewClaim: vi.fn(async () => true),
  returnPartToWaiting: vi.fn(async () => true),
  settleFiledMail: vi.fn(async () => true),
}))
vi.mock('./staging', () => ({
  readStagedObject: vi.fn(),
  eraseStagedObjects: vi.fn(async () => []),
}))
vi.mock('./malware-scan', () => ({ scanForStorage: vi.fn() }))
vi.mock('./quiet-batch', () => ({
  openQuietBatch: vi.fn(async (_s: unknown, _p: unknown, effects: { startsIntake: boolean }) =>
    effects.startsIntake ? 'batch-attachments' : 'batch-thread'
  ),
  sealQuietBatch: vi.fn(async () => undefined),
}))
vi.mock('./service', () => ({ FILING_CLAIM_MS: 300_000 }))
vi.mock('@/lib/documents/service', () => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/mail-thread/append', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail-thread/append')>()),
  appendInboundMessage: vi.fn(),
  ensureTargetFolder: vi.fn(
    async (_s: unknown, _p: unknown, target: { folderId: string | null }) => ({
      ok: true,
      folderId: target.folderId,
    })
  ),
}))
vi.mock('@/lib/mail-thread/originals', () => ({ finishOriginalMove: vi.fn(async () => 'moved') }))
vi.mock('@/lib/mail-thread/write-repository', () => ({
  decidePendingAttachment: vi.fn(async () => undefined),
  findCurrentVersions: vi.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            documentId: id,
            versionId: `${id}-v`,
            versionCreatedAt: new Date('2026-10-22T00:00:00Z'),
            contentHash: 'x',
            folderId: null,
          },
        ])
      )
  ),
  findEntryOfMail: vi.fn(async () => null),
  findThreadRow: vi.fn(async () => null),
  findVersionTimes: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/authz/folder-access-repository', () => ({
  listProjectFolderTree: vi.fn(async () => []),
}))
vi.mock('@/lib/upload-screening/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/upload-screening/service')>()),
  gatePolicy: vi.fn(async () => ({
    enabled: false,
    nameTerms: [],
    nameExceptions: [],
    contentTerms: [],
    detectors: [],
  })),
}))
vi.mock('@/lib/user-preferences/repository', () => ({
  findUserPreferences: vi.fn(async () => ({ locale: 'en' })),
}))
vi.mock('@/lib/organizations/repository', () => ({ findOrganization: vi.fn(async () => null) }))
vi.mock('@/lib/inbox/service', () => ({
  resolveInboxItemsAnchoredOn: vi.fn(async () => undefined),
}))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))

import { createHash } from 'node:crypto'
import { FileTooLargeError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { InboundMailDecisionRow, InboundMailPartRow } from '@/lib/db/schema'
import { uploadDocument } from '@/lib/documents/service'
import { resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import type { InboundMailFilePayload } from '@/lib/jobs-queue/types'
import { appendInboundMessage } from '@/lib/mail-thread/append'
import { finishOriginalMove } from '@/lib/mail-thread/originals'
import { decidePendingAttachment, findEntryOfMail } from '@/lib/mail-thread/write-repository'
import type { MailThreadEntryRow } from '@/lib/db/schema'
import {
  filePart,
  heldMail,
  MAIL_ID,
  PERSON,
  PROJECT_ID,
  textPart,
  THREAD_ID,
} from './__fixtures__/review'
import { runInboundMailFiling } from './file-job'
import {
  findFilingWork,
  markAttachmentFiled,
  projectIsHeld,
  recordFilingScan,
  returnPartToWaiting,
  settleFiledMail,
  type FilingWork,
} from './filing-repository'
import { scanForStorage } from './malware-scan'
import { openQuietBatch, sealQuietBatch } from './quiet-batch'
import { eraseStagedObjects, readStagedObject } from './staging'

const session = {
  userId: PERSON,
  organizationId: 'org_1',
  email: 'petra@example.test',
} as AuthorizedSession
const BYTES = new TextEncoder().encode('%PDF-1.7 S-101_C')
const SHA = createHash('sha256').update(BYTES).digest('hex')
const READ = JSON.stringify({
  readerVersion: 1,
  bodySource: 'plain',
  ownText: 'Freigegeben.',
  ownTextTruncated: false,
  split: true,
  signatureRemoved: false,
  quoted: [],
  quotedTruncated: false,
  calendar: [],
  calendarTruncated: false,
  encrypted: false,
  unreadableReasons: [],
  unreadable: false,
})
const payload: InboundMailFilePayload = {
  projectId: PROJECT_ID,
  mailIds: [MAIL_ID],
  requester: {
    userId: PERSON,
    email: 'petra@example.test',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
  },
}

const fileDecision = (
  part: InboundMailPartRow,
  overrides: Partial<InboundMailDecisionRow> = {}
): InboundMailDecisionRow => ({
  id: `decision-${part.position}`,
  organizationId: 'org_1',
  projectId: PROJECT_ID,
  mailId: MAIL_ID,
  partId: part.id,
  action: 'file',
  decidedBy: PERSON,
  via: 'app',
  proposalId: null,
  followId: null,
  decidedAt: new Date('2026-10-21T09:00:00Z'),
  folderId: 'folder-tragwerk',
  folderPath: 'Tragwerk',
  fileName: 'S-101_C.pdf',
  targetDocumentId: null,
  documentType: null,
  threadAction: null,
  mailThreadId: null,
  messageText: null,
  screeningRelease: false,
  acknowledgedSender: false,
  acknowledgedRisk: false,
  auditedAt: null,
  ...overrides,
})

const attachment = (overrides: Partial<InboundMailPartRow> = {}) =>
  filePart({
    state: 'filing',
    decisionId: 'decision-1',
    claimExpiresAt: new Date(),
    sha256: SHA,
    scannedAt: new Date(),
    ...overrides,
  })
const text = (overrides: Partial<InboundMailPartRow> = {}) =>
  textPart({ state: 'filing', decisionId: 'decision-0', claimExpiresAt: new Date(), ...overrides })

function work(
  parts: InboundMailPartRow[],
  decisions: Array<[InboundMailPartRow, Partial<InboundMailDecisionRow>]> = []
): FilingWork {
  return {
    mail: heldMail(),
    parts,
    decisions: new Map(
      decisions.map(([part, overrides]) => [part.id, fileDecision(part, overrides)])
    ),
  }
}

const filed = (part: InboundMailPartRow) => ({
  ...part,
  state: 'filed' as const,
  decisionId: part.decisionId,
  storageKey: null,
  filename: null,
  documentId: 'doc-1',
  claimExpiresAt: null,
  filedAt: new Date(),
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readStagedObject).mockImplementation(async (_bucket, key) =>
    key.endsWith('read.json') ? new TextEncoder().encode(READ) : BYTES
  )
  vi.mocked(uploadDocument).mockResolvedValue({
    documentId: 'doc-1',
    jobId: 'job',
    status: 'pending',
    filename: 'S-101_C.pdf',
  })
  vi.mocked(scanForStorage).mockResolvedValue({
    status: 'clean',
    engine: 'ClamAV 1.5.4/28200',
    signature: null,
    scannedAt: new Date(),
  })
})

describe('an attachment', () => {
  const run = (part = attachment(), overrides: Partial<InboundMailDecisionRow> = {}) => {
    const first = work([part], [[part, overrides]])
    vi.mocked(findFilingWork)
      .mockResolvedValueOnce([first])
      .mockResolvedValue([work([filed(part)], [[part, overrides]])])
    return runInboundMailFiling(session, payload)
  }

  it('is uploaded as the person, quietly, with its type and the mail it came with, then filed and its bytes erased', async () => {
    expect(
      await run(attachment(), { documentType: 'Bescheid', targetDocumentId: 'earlier-doc' })
    ).toEqual({ done: true, payload })
    const [asWho, input] = vi.mocked(uploadDocument).mock.calls[0]!
    expect(asWho).toBe(session)
    expect(input).toMatchObject({
      projectId: PROJECT_ID,
      folderId: 'folder-tragwerk',
      revisionOf: 'earlier-doc',
      screeningRelease: false,
      uploadBatchId: 'batch-attachments',
      documentType: 'Bescheid',
      mailOrigin: {
        sender_trust: 'member_verified',
        from_name: 'DI Petra Weber',
        signer_domain: 'statik-weber.at',
        locale: 'en',
      },
    })
    expect(input.file.name).toBe('S-101_C.pdf')
    expect(eraseStagedObjects).toHaveBeenCalledWith(heldMail().stagingBucket, [
      attachment().storageKey,
    ])
    expect(markAttachmentFiled).toHaveBeenCalledWith(attachment().id, 'decision-1', {
      documentId: 'doc-1',
      versionId: 'doc-1-v',
      erasureDeferred: false,
    })
    expect(openQuietBatch).toHaveBeenCalledOnce()
    expect(sealQuietBatch).toHaveBeenCalledWith(session, 'batch-attachments')
  })

  it('reads a type the vocabulary does not hold as no choice', async () => {
    await run(attachment(), { documentType: 'a-retired-type' })
    expect(vi.mocked(uploadDocument).mock.calls[0]![1]).not.toHaveProperty('documentType')
  })

  it('keeps its bytes, deferred, under a legal hold', async () => {
    vi.mocked(projectIsHeld).mockResolvedValueOnce(true)
    await run()
    expect(eraseStagedObjects).not.toHaveBeenCalledWith(heldMail().stagingBucket, [
      attachment().storageKey,
    ])
    expect(markAttachmentFiled).toHaveBeenCalledWith(
      attachment().id,
      'decision-1',
      expect.objectContaining({ erasureDeferred: true })
    )
  })

  it('is scanned again when its verdict is older than a day, and waits again unless it is still clean', async () => {
    const stale = attachment({ scannedAt: new Date(Date.now() - 2 * 86_400_000) })
    vi.mocked(scanForStorage).mockResolvedValueOnce({
      status: 'infected',
      engine: 'ClamAV',
      signature: 'Eicar',
      scannedAt: new Date(),
    })
    await run(stale)
    expect(returnPartToWaiting).toHaveBeenCalledWith(
      stale.id,
      'decision-1',
      'scan_not_clean',
      expect.objectContaining({ status: 'infected' })
    )
    expect(uploadDocument).not.toHaveBeenCalled()
    vi.clearAllMocks()
    vi.mocked(readStagedObject).mockResolvedValue(BYTES)
    vi.mocked(uploadDocument).mockResolvedValue({
      documentId: 'doc-1',
      jobId: 'job',
      status: 'pending',
      filename: 'S-101_C.pdf',
    })
    vi.mocked(scanForStorage).mockResolvedValue({
      status: 'clean',
      engine: 'ClamAV',
      signature: null,
      scannedAt: new Date(),
    })
    await run(stale)
    expect(recordFilingScan).toHaveBeenCalled()
    expect(uploadDocument).toHaveBeenCalled()
  })

  it('waits again `digest_mismatch` when the staged bytes are not the ones the person saw', async () => {
    await run(attachment({ sha256: 'f'.repeat(64) }))
    expect(returnPartToWaiting).toHaveBeenCalledWith(
      attachment().id,
      'decision-1',
      'digest_mismatch',
      undefined
    )
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('waits again with the upload path’s refusal, mapped', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(
      new FileTooLargeError({ fileSize: 2, maxSizeBytes: 1 })
    )
    await run()
    expect(returnPartToWaiting).toHaveBeenCalledWith(
      attachment().id,
      'decision-1',
      'size',
      undefined
    )
    expect(markAttachmentFiled).not.toHaveBeenCalled()
  })

  it('is linked to the entry’s row that still said `pending`, when its text was filed before (D36)', async () => {
    const message = textPart({
      state: 'filed',
      decisionId: 'decision-0',
      filedAt: new Date(),
      mailThreadEntryId: 'entry-1',
      documentId: 'thread-doc',
    })
    const part = attachment()
    vi.mocked(findFilingWork)
      .mockResolvedValueOnce([work([message, part], [[part, {}]])])
      .mockResolvedValue([work([message, filed(part)])])
    vi.mocked(findEntryOfMail).mockResolvedValue({
      id: 'entry-1',
      threadId: THREAD_ID,
    } as MailThreadEntryRow)
    await runInboundMailFiling(session, payload)
    expect(decidePendingAttachment).toHaveBeenCalledWith('entry-1', part.position, {
      disposition: 'filed',
      documentId: 'doc-1',
      versionId: 'doc-1-v',
    })
  })
})

describe('the text', () => {
  const messageDecision = {
    threadAction: 'append',
    mailThreadId: THREAD_ID,
    messageText: 'full',
    fileName: null,
    folderId: null,
    folderPath: null,
  } as const

  it('is filed after the attachments, with what became of them, and its original then moved', async () => {
    const part = attachment()
    const message = text()
    vi.mocked(findFilingWork)
      .mockResolvedValueOnce([
        work(
          [message, part],
          [
            [message, messageDecision],
            [part, {}],
          ]
        ),
      ])
      .mockResolvedValueOnce([
        work(
          [message, filed(part)],
          [
            [message, messageDecision],
            [part, {}],
          ]
        ),
      ])
      .mockResolvedValue([work([filed(message), filed(part)])])
    vi.mocked(appendInboundMessage).mockResolvedValueOnce({
      kind: 'filed',
      entryId: 'entry-1',
      threadId: THREAD_ID,
      documentId: 'thread-doc',
      versionId: 'v4',
    })

    expect(await runInboundMailFiling(session, payload)).toEqual({ done: true, payload })

    expect(vi.mocked(uploadDocument).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(appendInboundMessage).mock.invocationCallOrder[0]!
    )
    const request = vi.mocked(appendInboundMessage).mock.calls[0]![0]
    expect(request).toMatchObject({
      session,
      uploadBatchId: 'batch-thread',
      newThreadLocale: 'en',
      form: { masked: false },
    })
    expect(request.read.ownText).toBe('Freigegeben.')
    expect(request.attachments).toEqual([
      expect.objectContaining({
        part: expect.objectContaining({ state: 'filed', documentId: 'doc-1' }),
      }),
    ])
    expect(finishOriginalMove).toHaveBeenCalledWith(expect.objectContaining({ id: MAIL_ID }), {
      id: 'entry-1',
      originalStorageKey: null,
    })
  })

  it('answers „not yet“ while another filing writes the thread, without spending an attempt', async () => {
    const message = text()
    vi.mocked(findFilingWork).mockResolvedValue([work([message], [[message, messageDecision]])])
    vi.mocked(appendInboundMessage).mockResolvedValueOnce({ kind: 'busy' })
    const result = await runInboundMailFiling(session, payload)
    expect(result.done).toBe(false)
    expect(result.notBefore!.getTime()).toBeGreaterThan(Date.now())
    expect(returnPartToWaiting).not.toHaveBeenCalled()
  })

  it('waits again with the failure the append gives', async () => {
    const message = text()
    vi.mocked(findFilingWork).mockResolvedValue([work([message], [[message, messageDecision]])])
    vi.mocked(appendInboundMessage).mockResolvedValueOnce({
      kind: 'failed',
      failure: 'thread_document_gone',
    })
    await runInboundMailFiling(session, payload)
    expect(returnPartToWaiting).toHaveBeenCalledWith(
      message.id,
      'decision-0',
      'thread_document_gone'
    )
    expect(finishOriginalMove).not.toHaveBeenCalled()
  })

  it('waits again `unreadable` when the reader left nothing to file', async () => {
    const message = text()
    vi.mocked(findFilingWork).mockResolvedValue([
      {
        ...work([message], [[message, messageDecision]]),
        mail: heldMail({ readStorageKey: null }),
      },
    ])
    await runInboundMailFiling(session, payload)
    expect(returnPartToWaiting).toHaveBeenCalledWith(message.id, 'decision-0', 'unreadable')
    expect(appendInboundMessage).not.toHaveBeenCalled()
  })
})

describe('settling', () => {
  it('scrubs a mail every part of which is filed, erasing its staged objects by key, and settles its notice', async () => {
    const done = work([filed(text()), filed(attachment())])
    done.mail = heldMail({ rawStorageKey: null })
    vi.mocked(findFilingWork).mockResolvedValue([done])
    await runInboundMailFiling(session, payload)
    expect(eraseStagedObjects).toHaveBeenCalledWith(done.mail.stagingBucket, [
      done.mail.readStorageKey,
    ])
    expect(settleFiledMail).toHaveBeenCalledWith(done.mail, false)
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['inbound_mail.waiting'], anchorId: MAIL_ID })
    )
  })

  it('leaves a mail with a dismissed part to the sweep: it can be restored for seven days', async () => {
    vi.mocked(findFilingWork).mockResolvedValue([
      work([filed(text()), filePart({ state: 'dismissed', endedAt: new Date() })]),
    ])
    await runInboundMailFiling(session, payload)
    expect(settleFiledMail).not.toHaveBeenCalled()
  })

  it('opens no batch when nothing was uploaded', async () => {
    vi.mocked(findFilingWork).mockResolvedValue([])
    expect(await runInboundMailFiling(session, payload)).toEqual({ done: true, payload })
    expect(openQuietBatch).not.toHaveBeenCalled()
    expect(sealQuietBatch).not.toHaveBeenCalled()
  })
})
