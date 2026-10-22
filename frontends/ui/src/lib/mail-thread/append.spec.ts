/**
 * @vitest-environment node
 */
/**
 * Filing a mail's text into its E-Mail-Verlauf (`./append.ts`): the pure parts
 * (what came with the message, the entry, who may see where an attachment
 * went, which refusal is which failure) and the orchestration over a mocked
 * repository and upload path (the lease, the retry, a new thread's name, every
 * refusal a typed failure). The SQL is `append.integration.spec.ts`'s.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./write-repository', () => ({
  acquireRenderLease: vi.fn(async () => true),
  releaseRenderLease: vi.fn(async () => undefined),
  commitAppend: vi.fn(async () => 'committed'),
  findCurrentVersions: vi.fn(async () => new Map()),
  findEntryAttachmentRows: vi.fn(async () => new Map()),
  findThreadEntryRows: vi.fn(async () => []),
  findWritableThread: vi.fn(async () => null),
}))
vi.mock('@/lib/documents/service', () => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/inbound-mail/repository', () => ({
  findDocumentIdByStoredName: vi.fn(async () => null),
  findLiveFolders: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/inbound-mail/decision', () => ({ THREAD_DOCUMENT_TYPE: 'correspondence' }))
vi.mock('@/lib/projects/folder-service', () => ({ ensureProjectFolderPaths: vi.fn() }))

import {
  BadRequestError,
  ConflictError,
  FileTooLargeError,
  ForbiddenError,
  InsufficientStorageError,
  NotFoundError,
} from '@/lib/api/errors'
import type { AccessFolder } from '@/lib/authz/folder-access-rule'
import type { InboundMailDecisionRow, MailThreadEntryRow, MailThreadRow } from '@/lib/db/schema'
import { contentDigest } from '@/lib/documents/content-digest'
import { uploadDocument } from '@/lib/documents/service'
import {
  heldMail,
  MAIL_ID,
  PERSON,
  PROJECT_ID,
  textPart,
  THREAD_ID,
  filePart,
} from '@/lib/inbound-mail/__fixtures__/review'
import type { MailRead } from '@/lib/inbound-mail/read-client'
import { findDocumentIdByStoredName } from '@/lib/inbound-mail/repository'
import { projectClosedError } from '@/lib/projects/project-status'
import { chatScreeningRules } from '@/lib/upload-screening/content-screen'
import { ScreenedUploadError } from '@/lib/upload-screening/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  answeredEntryOf,
  appendInboundMessage,
  attachmentRowsOf,
  cutToBytes,
  entryIdOf,
  filingFailureOf,
  inboundEntryOf,
  newThreadIdOf,
  readableWithThread,
  renderEntryOf,
  threadDocumentFilename,
  threadTitleOf,
  type AppendRequest,
  type AttachmentFact,
} from './append'
import { renderMailThread } from './render'
import {
  acquireRenderLease,
  commitAppend,
  findCurrentVersions,
  findThreadEntryRows,
  findWritableThread,
  releaseRenderLease,
  type AppendCommit,
} from './write-repository'

const AT = new Date('2026-10-21T08:14:00.000Z')
const DECISION_ID = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e'
const DOC_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const THREAD_DOC = 'd0c00000-0000-4000-8000-0000000000a0'
const session = {
  userId: PERSON,
  organizationId: 'org_1',
  email: 'petra@example.test',
} as AuthorizedSession

function decision(overrides: Partial<InboundMailDecisionRow> = {}): InboundMailDecisionRow {
  return {
    id: DECISION_ID,
    organizationId: 'org_1',
    projectId: PROJECT_ID,
    mailId: MAIL_ID,
    partId: textPart().id,
    action: 'file',
    decidedBy: PERSON,
    via: 'app',
    proposalId: null,
    followId: null,
    decidedAt: AT,
    folderId: null,
    folderPath: null,
    fileName: null,
    targetDocumentId: null,
    documentType: 'correspondence',
    threadAction: 'append',
    mailThreadId: THREAD_ID,
    messageText: 'full',
    screeningRelease: false,
    acknowledgedSender: false,
    acknowledgedRisk: false,
    auditedAt: null,
    ...overrides,
  }
}

function read(overrides: Partial<MailRead> = {}): MailRead {
  return {
    readerVersion: 1,
    bodySource: 'plain',
    ownText: 'Die Statik ist freigegeben. Bitte überweisen Sie auf AT61 1904 3002 3457 3201.',
    ownTextTruncated: false,
    split: true,
    signatureRemoved: true,
    quoted: [
      {
        header: 'Am 20.10. schrieb huber@ma37.wien.gv.at:',
        text: 'IBAN AT61 1904 3002 3457 3201 bitte prüfen.',
      },
    ],
    quotedTruncated: false,
    calendar: [],
    calendarTruncated: false,
    encrypted: false,
    unreadableReasons: [],
    unreadable: false,
    ...overrides,
  }
}

function threadRow(overrides: Partial<MailThreadRow> = {}): MailThreadRow {
  return {
    id: THREAD_ID,
    organizationId: 'org_1',
    projectId: PROJECT_ID,
    documentId: THREAD_DOC,
    baseSubject: 'statik einreichung',
    threadIndexGuid: null,
    participantDomains: ['piloti.test'],
    continuesThreadId: null,
    entryCount: 1,
    renderedBytes: 100,
    lastEntryAt: AT,
    renderPendingAt: null,
    renderLeaseHolder: null,
    renderLeaseUntil: null,
    locale: 'de',
    createdBy: PERSON,
    createdAt: AT,
    ...overrides,
  }
}

const TREE: ReadonlyMap<string, AccessFolder> = new Map(
  [
    { id: 'open', parentId: null, accessMode: 'inherit', everyoneReads: false },
    { id: 'board', parentId: null, accessMode: 'custom', everyoneReads: false },
    { id: 'board-sub', parentId: 'board', accessMode: 'inherit', everyoneReads: false },
    { id: 'listed-but-read', parentId: null, accessMode: 'custom', everyoneReads: true },
  ].map((folder): [string, AccessFolder] => [folder.id, folder as AccessFolder])
)

describe('the thread document’s name', () => {
  it('is the name a person gave it, as Markdown, once', () => {
    expect(threadDocumentFilename('Stellplatznachweis')).toBe('Stellplatznachweis.md')
    expect(threadDocumentFilename('Stellplatznachweis.MD')).toBe('Stellplatznachweis.MD')
    expect(threadTitleOf('Stellplatznachweis.md')).toBe('Stellplatznachweis')
  })

  it('derives the entry and a new thread from the decision, the same on every retry', () => {
    expect(entryIdOf(DECISION_ID)).toBe(entryIdOf(DECISION_ID))
    expect(newThreadIdOf(DECISION_ID)).not.toBe(entryIdOf(DECISION_ID))
  })
})

describe('who may see where an attachment went (RT-S13)', () => {
  it.each<[string, string | null, string | null, boolean]>([
    ['the root beside a thread at the root', null, null, true],
    ['an open folder beside a thread at the root', 'open', null, true],
    ['a restricted folder beside a thread at the root', 'board', null, false],
    ['a restricted folder beside a thread under the same list', 'board', 'board-sub', true],
    ['the root beside a restricted thread', null, 'board', true],
    ['a list that only narrows who writes', 'listed-but-read', null, true],
    ['a folder that is gone', 'gone', null, false],
  ])('%s', (_case, folderId, threadFolderId, expected) => {
    expect(readableWithThread(TREE, folderId, threadFolderId)).toBe(expected)
  })
})

describe('what came with the message (D36)', () => {
  const rows = (facts: AttachmentFact[], notStaged = heldMail().notStaged) =>
    attachmentRowsOf({
      entryId: 'entry',
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      receivedAt: AT,
      facts,
      notStaged,
      visibleWithThread: (folderId) => readableWithThread(TREE, folderId, null),
    })
  const filed = (
    folderId: string | null,
    overrides: Partial<InboundMailDecisionRow> = {},
    versionCreatedAt = new Date(AT.getTime() + 60_000)
  ): AttachmentFact => ({
    part: filePart({
      state: 'filed',
      storageKey: null,
      filename: null,
      documentId: DOC_ID,
      documentVersionId: 'ver-2',
      decisionId: 'd',
    }),
    decision: decision({
      partId: filePart().id,
      threadAction: null,
      mailThreadId: null,
      messageText: null,
      fileName: 'S-101_C.pdf',
      folderPath: 'Tragwerk',
      ...overrides,
    }),
    document: { id: DOC_ID, versionId: 'ver-2', versionCreatedAt, folderId },
  })

  it('names a filed attachment in a folder as visible as the thread, with its folder', () => {
    expect(rows([filed('open')])).toEqual([
      expect.objectContaining({
        position: 1,
        disposition: 'filed',
        documentId: DOC_ID,
        documentVersionId: 'ver-2',
        sectionName: 'S-101_C.pdf',
        sectionFolderPath: 'Tragwerk',
        filename: 'S-101_C.pdf',
      }),
    ])
  })

  it('links but never names one filed where fewer may read, or under a released name', () => {
    expect(rows([filed('board')])[0]).toMatchObject({
      disposition: 'filed',
      documentId: DOC_ID,
      sectionName: null,
      sectionFolderPath: null,
    })
    expect(rows([filed('open', { screeningRelease: true })])[0]).toMatchObject({
      disposition: 'filed',
      sectionName: null,
    })
  })

  it('says already present when the Fassung was the document’s before the mail arrived', () => {
    expect(rows([filed('open', {}, new Date(AT.getTime() - 86_400_000))])[0]).toMatchObject({
      disposition: 'already_present',
      documentId: DOC_ID,
    })
  })

  it('records a dismissed duplicate as the document it duplicates, never named', () => {
    const duplicate: AttachmentFact = {
      part: filePart({
        state: 'dismissed',
        endedAt: AT,
        riskFlags: ['duplicate_of'],
        duplicateOfDocumentId: DOC_ID,
      }),
      decision: null,
      document: { id: DOC_ID, versionId: 'ver-1', versionCreatedAt: AT, folderId: 'open' },
    }
    expect(rows([duplicate])[0]).toMatchObject({
      disposition: 'already_present',
      documentId: DOC_ID,
      documentVersionId: 'ver-1',
      sectionName: null,
    })
  })

  it.each<[string, Parameters<typeof filePart>[0], string]>([
    ['still waiting', { state: 'waiting' }, 'pending'],
    ['being filed', { state: 'filing' }, 'pending'],
    ['dismissed', { state: 'dismissed', endedAt: AT }, 'dismissed'],
    ['expired', { state: 'expired', endedAt: AT }, 'expired'],
    ['infected', { state: 'dismissed', endedAt: AT, scanStatus: 'infected' }, 'infected'],
    [
      'never scanned clean',
      { state: 'dismissed', endedAt: AT, scanStatus: 'failed' },
      'scan_failed',
    ],
    [
      'of a type the office does not file',
      { state: 'dismissed', endedAt: AT, riskFlags: ['type_not_accepted'] },
      'type_not_accepted',
    ],
  ])('says why one %s was not filed', (_case, overrides, reason) => {
    expect(rows([{ part: filePart(overrides), decision: null, document: null }])[0]).toMatchObject({
      disposition: 'not_filed',
      notFiledReason: reason,
      filename: 'S-101_C.pdf',
    })
  })

  it('records the files that were never staged after the staged ones, and no layout image', () => {
    const notStaged = [
      { filename: 'Pläne.zip', reason: 'archive' as const },
      { filename: 'image001.png', reason: 'embedded' as const },
      { filename: 'Video.mp4', reason: 'size' as const },
    ]
    expect(
      rows(
        [{ part: filePart({ state: 'waiting' }), decision: null, document: null }],
        notStaged
      ).map((row) => [row.position, row.notFiledReason, row.filename])
    ).toEqual([
      [1, 'pending', 'S-101_C.pdf'],
      [2, 'archive', 'Pläne.zip'],
      [3, 'size', 'Video.mp4'],
    ])
  })
})

describe('the entry', () => {
  const rules = chatScreeningRules({
    enabled: true,
    nameTerms: [],
    nameExceptions: [],
    contentTerms: [],
    detectors: ['iban'],
  })

  it('keeps the text as sent and records where it is masked, when the person chose „Unkenntlich ablegen“', () => {
    const entry = inboundEntryOf({
      id: 'e',
      threadId: THREAD_ID,
      mail: heldMail(),
      read: read(),
      decision: decision({ messageText: 'masked' }),
      heading: 'h',
      inReplyToEntryId: null,
      form: { masked: true, rules },
    })
    expect(entry.ownText).toContain('AT61 1904')
    expect(entry.maskedSpans).toEqual([expect.objectContaining({ kind: 'iban' })])
    expect(entry.quoted).toEqual([{ text: expect.not.stringContaining('AT61 1904') }])
    expect(JSON.stringify(entry.quoted)).not.toContain('huber@')
  })

  it('keeps the text unmasked when the person chose the full text, and never a quote’s header', () => {
    const entry = inboundEntryOf({
      id: 'e',
      threadId: THREAD_ID,
      mail: heldMail(),
      read: read(),
      decision: decision(),
      heading: 'h',
      inReplyToEntryId: null,
      form: { masked: false, rules },
    })
    expect(entry.maskedSpans).toBeNull()
    expect(entry.quoted).toEqual([{ text: 'IBAN AT61 1904 3002 3457 3201 bitte prüfen.' }])
  })

  it('is filed at the decision’s time, as the decider, by the decision’s way', () => {
    const entry = inboundEntryOf({
      id: 'e',
      threadId: THREAD_ID,
      mail: heldMail(),
      read: read(),
      decision: decision({ via: 'agent' }),
      heading: 'h',
      inReplyToEntryId: null,
      form: { masked: false, rules: null },
    })
    expect(entry).toMatchObject({
      filedAt: AT,
      filedBy: PERSON,
      filedVia: 'agent',
      source: 'inbound',
      inboundMailId: MAIL_ID,
      senderDomain: 'statik-weber.at',
    })
  })

  it('cuts the text at its byte bound without splitting a character', () => {
    expect(cutToBytes('Grüße', 3)).toBe('Gr')
    expect(cutToBytes('Grüße', 4)).toBe('Grü')
  })

  it('answers the latest entry the mail’s In-Reply-To names', () => {
    const entries = [
      { id: 'a', messageId: '<first@piloti.test>', filedAt: new Date('2026-10-01') },
      { id: 'b', messageId: '<first@piloti.test>', filedAt: new Date('2026-10-02') },
      { id: 'c', messageId: '<other@piloti.test>', filedAt: new Date('2026-10-03') },
    ]
    expect(answeredEntryOf(entries, ['<first@piloti.test>'])).toBe('b')
    expect(answeredEntryOf(entries, ['<nobody@x.at>'])).toBeNull()
  })
})

describe('which refusal of the upload path is which failure', () => {
  it.each<[string, unknown, string | null]>([
    [
      'the name check',
      new ScreenedUploadError([{ term: 'Gehalt', segment: 'Gehalt.pdf', kind: 'file' }]),
      'screened',
    ],
    ['the size', new FileTooLargeError({ fileSize: 2, maxSizeBytes: 1 }), 'size'],
    ['the quota', new InsufficientStorageError('full'), 'quota'],
    ['a closed project', projectClosedError(), 'project_closed'],
    ['a read-only folder', new ForbiddenError('read only'), 'access'],
    ['a folder that is gone', new NotFoundError('gone'), 'access'],
    ['a taken name', new ConflictError('taken'), 'name_taken'],
    ['a type the office does not take', new BadRequestError('type'), 'type'],
    ['an outage, which the queue retries', new Error('ECONNRESET'), null],
  ])('%s', (_case, error, failure) => {
    expect(filingFailureOf(error)).toBe(failure)
  })
})

describe('appending to a thread', () => {
  const ENTRY_ROW = { id: 'e0', heading: '20.10.2026 10:00 · Huber (ma37.wien.gv.at)' } as const
  const earlierRow = (): MailThreadEntryRow =>
    ({
      ...inboundEntryOf({
        id: ENTRY_ROW.id,
        threadId: THREAD_ID,
        mail: heldMail({
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
          messageId: '<first@piloti.test>',
          sentAt: new Date('2026-10-20T08:00:00Z'),
          receivedAt: new Date('2026-10-20T08:01:00Z'),
          senderName: 'Huber',
          senderAddress: 'huber@ma37.wien.gv.at',
          signerDomain: 'ma37.wien.gv.at',
          senderTrust: 'external_verified',
        }),
        read: read({ ownText: 'Bitte reichen Sie die Statik ein.', quoted: [] }),
        decision: decision({ decidedAt: new Date('2026-10-20T09:00:00Z') }),
        heading: '20.10.2026 10:00 · Huber (ma37.wien.gv.at)',
        inReplyToEntryId: null,
        form: { masked: false, rules: null },
      }),
      firstVersionId: 'ver-1',
      originalBucket: null,
      originalStorageKey: null,
      originalSha256: null,
      originalBytes: null,
      originalScanStatus: null,
      originalScannedAt: null,
      createdAt: AT,
    }) as MailThreadEntryRow

  const request = (overrides: Partial<AppendRequest> = {}): AppendRequest => ({
    session,
    mail: heldMail(),
    part: textPart({ state: 'filing', decisionId: DECISION_ID }),
    decision: decision(),
    read: read(),
    form: { masked: false, rules: null },
    attachments: [],
    folderTree: TREE,
    newThreadFolderId: null,
    newThreadLocale: 'de',
    uploadBatchId: 'batch-1',
    request: new Request('http://bff-jobs.internal/x'),
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(acquireRenderLease).mockResolvedValue(true)
    vi.mocked(findWritableThread).mockResolvedValue({
      thread: threadRow(),
      document: {
        id: THREAD_DOC,
        filename: 'Statik Einreichung.md',
        folderId: 'open',
        contentHash: 'sha256:previous',
      },
    })
    vi.mocked(findThreadEntryRows).mockResolvedValue([earlierRow()])
    vi.mocked(uploadDocument).mockResolvedValue({
      documentId: THREAD_DOC,
      jobId: 'job',
      status: 'pending',
      filename: 'Statik Einreichung.md',
    })
    vi.mocked(findCurrentVersions).mockResolvedValue(
      new Map([
        [
          THREAD_DOC,
          {
            documentId: THREAD_DOC,
            versionId: 'ver-2',
            versionCreatedAt: AT,
            contentHash: 'x',
            folderId: 'open',
          },
        ],
      ])
    )
  })

  it('waits for another writer of the thread, touching nothing', async () => {
    vi.mocked(acquireRenderLease).mockResolvedValueOnce(false)
    expect(await appendInboundMessage(request())).toEqual({ kind: 'busy' })
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(releaseRenderLease).not.toHaveBeenCalled()
  })

  it('fails `thread_document_gone` for a thread whose document is out of reach, and lets the lease go', async () => {
    vi.mocked(findWritableThread).mockResolvedValueOnce(null)
    expect(await appendInboundMessage(request())).toEqual({
      kind: 'failed',
      failure: 'thread_document_gone',
    })
    expect(releaseRenderLease).toHaveBeenCalledWith(THREAD_ID, DECISION_ID)
  })

  it('uploads the next Fassung under the same name and folder, quietly, as correspondence, with the thread’s facts', async () => {
    const outcome = await appendInboundMessage(request())
    expect(outcome).toEqual({
      kind: 'filed',
      entryId: entryIdOf(DECISION_ID),
      threadId: THREAD_ID,
      documentId: THREAD_DOC,
      versionId: 'ver-2',
    })
    const [asWho, input] = vi.mocked(uploadDocument).mock.calls[0]!
    expect(asWho).toBe(session)
    expect(input).toMatchObject({
      projectId: PROJECT_ID,
      folderId: 'open',
      uploadBatchId: 'batch-1',
      documentType: 'correspondence',
      screeningRelease: false,
      mailThread: { message_count: 2, locale: 'de', latest_sent_at: '2026-10-21T08:14:00Z' },
    })
    expect(input.file.name).toBe('Statik Einreichung.md')
    expect(releaseRenderLease).toHaveBeenCalledWith(THREAD_ID, DECISION_ID)
  })

  it('writes a Fassung that holds every section of the last one (the superset invariant)', async () => {
    await appendInboundMessage(request())
    const uploaded = await vi.mocked(uploadDocument).mock.calls[0]![1].file.text()
    const before = renderMailThread({
      title: 'Statik Einreichung',
      locale: 'de',
      continues: null,
      entries: [renderEntryOf(earlierRow(), [])],
    })
    for (const section of before.markdown.split(/\n(?=## )/).slice(1))
      expect(uploaded).toContain(section.trim())
  })

  it('commits the entry with its Fassung, its ids, the part filed and the original moving, after the upload', async () => {
    await appendInboundMessage(request())
    const commit = vi.mocked(commitAppend).mock.calls[0]![0] as AppendCommit
    expect(commit.newThread).toBeNull()
    // It answers the earlier message its In-Reply-To names.
    expect(commit.entry).toMatchObject({
      id: entryIdOf(DECISION_ID),
      threadId: THREAD_ID,
      firstVersionId: 'ver-2',
      inReplyToEntryId: 'e0',
    })
    expect(commit.messageIds).toEqual({
      received: '<reply-2@statik-weber.at>',
      referenced: ['<first@piloti.test>', '<first@piloti.test>'],
    })
    expect(commit.part).toEqual({ id: textPart().id, documentId: THREAD_DOC, versionId: 'ver-2' })
    expect(commit.threadUpdate).toMatchObject({
      documentId: THREAD_DOC,
      entryCount: 2,
      participantDomains: ['piloti.test', 'statik-weber.at'],
    })
    expect(commit.movesOriginal).toBe(true)
    expect(vi.mocked(uploadDocument).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(commitAppend).mock.invocationCallOrder[0]!
    )
  })

  it('does not upload again bytes the document already holds (a retry whose answer was lost)', async () => {
    await appendInboundMessage(request())
    const markdown = await vi.mocked(uploadDocument).mock.calls[0]![1].file.text()
    vi.clearAllMocks()
    vi.mocked(acquireRenderLease).mockResolvedValue(true)
    vi.mocked(findThreadEntryRows).mockResolvedValue([earlierRow()])
    vi.mocked(findCurrentVersions).mockResolvedValue(
      new Map([
        [
          THREAD_DOC,
          {
            documentId: THREAD_DOC,
            versionId: 'ver-2',
            versionCreatedAt: AT,
            contentHash: 'x',
            folderId: 'open',
          },
        ],
      ])
    )
    vi.mocked(findWritableThread).mockResolvedValue({
      thread: threadRow(),
      document: {
        id: THREAD_DOC,
        filename: 'Statik Einreichung.md',
        folderId: 'open',
        contentHash: contentDigest(Buffer.from(markdown, 'utf8')),
      },
    })
    expect(await appendInboundMessage(request())).toMatchObject({
      kind: 'filed',
      versionId: 'ver-2',
    })
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(commitAppend).toHaveBeenCalledOnce()
  })

  it('maps a refusal of the upload to a failure and records nothing', async () => {
    vi.mocked(uploadDocument).mockRejectedValueOnce(new InsufficientStorageError('full'))
    expect(await appendInboundMessage(request())).toEqual({ kind: 'failed', failure: 'quota' })
    expect(commitAppend).not.toHaveBeenCalled()
  })

  it('fails `size` on a thread at its entry cap', async () => {
    vi.mocked(findThreadEntryRows).mockResolvedValueOnce(
      Array.from({ length: 200 }, () => earlierRow())
    )
    expect(await appendInboundMessage(request())).toEqual({ kind: 'failed', failure: 'size' })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('numbers a heading the thread already has, never renumbers the earlier one', async () => {
    // The same sender, the same minute: an earlier message the thread already holds.
    const same = inboundEntryOf({
      id: 'e1',
      threadId: THREAD_ID,
      mail: heldMail({
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        messageId: '<reply-1@statik-weber.at>',
      }),
      read: read({ ownText: 'Vorab.', quoted: [] }),
      decision: decision({ decidedAt: new Date(AT.getTime() - 1000) }),
      heading: '21.10.2026 10:14 · DI Petra Weber (statik-weber.at)',
      inReplyToEntryId: null,
      form: { masked: false, rules: null },
    })
    vi.mocked(findThreadEntryRows).mockResolvedValueOnce([
      { ...earlierRow(), ...same } as MailThreadEntryRow,
    ])
    await appendInboundMessage(request())
    const commit = vi.mocked(commitAppend).mock.calls[0]![0] as AppendCommit
    expect(commit.entry.heading).toBe('21.10.2026 10:14 · DI Petra Weber (statik-weber.at) (2)')
  })
})

describe('starting a thread', () => {
  const create = (overrides: Partial<InboundMailDecisionRow> = {}) =>
    decision({
      threadAction: 'create',
      mailThreadId: null,
      fileName: 'Stellplatznachweis',
      folderId: 'open',
      folderPath: 'Behörde',
      ...overrides,
    })
  const request = (decisionRow: InboundMailDecisionRow): AppendRequest => ({
    session,
    mail: heldMail(),
    part: textPart({ state: 'filing', decisionId: DECISION_ID }),
    decision: decisionRow,
    read: read(),
    form: { masked: false, rules: null },
    attachments: [],
    folderTree: TREE,
    newThreadFolderId: 'open',
    newThreadLocale: 'en',
    uploadBatchId: null,
    request: new Request('http://bff-jobs.internal/x'),
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(uploadDocument).mockResolvedValue({
      documentId: 'new-doc',
      jobId: 'job',
      status: 'pending',
      filename: 'Stellplatznachweis.md',
    })
    vi.mocked(findCurrentVersions).mockResolvedValue(
      new Map([
        [
          'new-doc',
          {
            documentId: 'new-doc',
            versionId: 'ver-1',
            versionCreatedAt: AT,
            contentHash: 'x',
            folderId: 'open',
          },
        ],
      ])
    )
  })

  it('creates the thread with its first Fassung in the person’s locale, under the released name if released', async () => {
    const outcome = await appendInboundMessage(request(create({ screeningRelease: true })))
    expect(outcome).toMatchObject({
      kind: 'filed',
      threadId: newThreadIdOf(DECISION_ID),
      documentId: 'new-doc',
    })
    expect(acquireRenderLease).not.toHaveBeenCalled()
    expect(vi.mocked(uploadDocument).mock.calls[0]![1]).toMatchObject({
      folderId: 'open',
      screeningRelease: true,
      mailThread: { message_count: 1, locale: 'en' },
    })
    const commit = vi.mocked(commitAppend).mock.calls[0]![0] as AppendCommit
    expect(commit.newThread).toMatchObject({
      id: newThreadIdOf(DECISION_ID),
      documentId: 'new-doc',
      locale: 'en',
      createdBy: PERSON,
      baseSubject: 'statik einreichung',
    })
  })

  it('never files into another document of the name: `name_taken`, unless it is this filing’s own (a retry)', async () => {
    vi.mocked(findDocumentIdByStoredName).mockResolvedValueOnce('someone-elses')
    vi.mocked(findCurrentVersions).mockResolvedValueOnce(
      new Map([
        [
          'someone-elses',
          {
            documentId: 'someone-elses',
            versionId: 'v',
            versionCreatedAt: AT,
            contentHash: 'sha256:other',
            folderId: null,
          },
        ],
      ])
    )
    expect(await appendInboundMessage(request(create()))).toEqual({
      kind: 'failed',
      failure: 'name_taken',
    })
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(commitAppend).not.toHaveBeenCalled()
  })
})
