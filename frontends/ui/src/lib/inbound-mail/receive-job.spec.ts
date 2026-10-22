/**
 * @vitest-environment node
 *
 * The receive job against REAL mail: messages built and DKIM-signed by the
 * hostile corpus's builders (`__fixtures__/hostile.ts`), verified by mailauth
 * against a fake DNS, parsed by postal-mime, screened by the office's real
 * rules. The database, the object store, the scanner and the Python reader are
 * stood in for (an in-memory row, a map of objects), so each case reads as what
 * the job leaves behind:
 *
 * - the raw message is scanned before the mail is `waiting`, and a failed
 *   scan still holds it (never lost, never clean);
 * - auto-replies are dropped, their raw message erased by its key (a legal
 *   hold defers the erasure);
 * - a mail nobody can read is held `unreadable` on the last attempt, and only
 *   then;
 * - B8: another office's project address never reaches what a person reads
 *   (subject, participants, text, quotes and their headers), the receiving
 *   address does;
 * - the PII canary: a sender, subject, file name and token never reach a log,
 *   PostHog or the audit trail;
 * - the follow job is queued only when D31's conditions 1–6 hold;
 * - a mail whose DKIM fails is held like any other (the NEGATIVE).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboundMailRow, NewInboundMailPartRow } from '@/lib/db/schema'
import type { MalwareScanVerdict } from '@/lib/malware-scan/types'

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({
  row: null as InboundMailRow | null,
  parts: [] as NewInboundMailPartRow[],
  objects: new Map<string, Uint8Array>(),
  erased: [] as string[],
  calls: [] as string[],
  threadCandidates: [] as unknown[],
  filedMessages: [] as unknown[],
  followContext: null as unknown,
  dns: null as unknown,
}))

vi.mock('./repository', () => ({
  findMailForReceive: vi.fn(async () => (state.row ? { ...state.row } : null)),
  findAddressToken: vi.fn(async () => 'abcdefgh2345'),
  recordRawScan: vi.fn(async (_id: string, scan: { status: string; engine: string | null; scannedAt: Date }) => {
    state.calls.push(`scan:${scan.status}`)
    if (state.row?.status === 'received') Object.assign(state.row, { rawScanStatus: scan.status, rawScanEngine: scan.engine, rawScannedAt: scan.scannedAt })
  }),
  dropMail: vi.fn(async (_id: string, input: { reason: string; erasureDeferred: boolean }) => {
    state.calls.push(`drop:${input.reason}`)
    if (!state.row || state.row.status !== 'received') return false
    Object.assign(state.row, {
      status: 'dropped',
      droppedReason: input.reason,
      envelopeFrom: null,
      rawStorageKey: input.erasureDeferred ? state.row.rawStorageKey : null,
      erasureDeferredAt: input.erasureDeferred ? new Date() : null,
    })
    return true
  }),
  findThreadCandidates: vi.fn(async () => state.threadCandidates),
  findFiledMessages: vi.fn(async () => state.filedMessages),
  findScreenedDuplicates: vi.fn(async () => new Map()),
  findScreenedNamesakes: vi.fn(async () => new Map()),
  findThreadFollowContext: vi.fn(async () => state.followContext),
  holdMail: vi.fn(async (_id: string, fields: Record<string, unknown>, parts: NewInboundMailPartRow[]) => {
    state.calls.push('hold')
    if (!state.row || state.row.status !== 'received') return false
    if (state.row.rawScanStatus === 'pending') throw new Error('CHECK inbound_mails_waiting_is_scanned')
    Object.assign(state.row, fields, { status: 'waiting' })
    state.parts = parts
    return true
  }),
  findPartSummaries: vi.fn(async () =>
    state.parts.map((part) => ({ kind: part.kind, riskFlags: part.riskFlags ?? [], contentFindings: part.contentFindings ?? [] })),
  ),
  markNotified: vi.fn(async () => {
    state.calls.push('notified')
    if (state.row) state.row.notifiedAt = new Date()
  }),
}))
vi.mock('./staging', () => ({
  readStagedObject: vi.fn(async (_bucket: string, key: string) => {
    const bytes = state.objects.get(key)
    if (!bytes) throw new Error(`no object ${key}`)
    return bytes
  }),
  putStagedObject: vi.fn(async (_bucket: string, key: string, body: Uint8Array) => {
    state.objects.set(key, body)
  }),
  eraseStagedObjects: vi.fn(async (_bucket: string, keys: string[]) => {
    for (const key of keys) {
      state.erased.push(key)
      state.objects.delete(key)
    }
    return []
  }),
  stagedObjectUrlForBackend: vi.fn(async () => 'http://seaweed.test/presigned/raw.eml'),
}))
vi.mock('@/lib/malware-scan/client', () => ({ scanForMalware: vi.fn() }))
vi.mock('./read-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('./read-client')>()), readMail: vi.fn() }))
vi.mock('./sender-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sender-auth')>()
  return {
    ...actual,
    authenticateSender: vi.fn((raw: Uint8Array, options: Parameters<typeof actual.authenticateSender>[1]) =>
      actual.authenticateSender(raw, { ...options, resolver: (state.dns as { resolver: never }).resolver }),
    ),
  }
})
vi.mock('@/lib/documents/accepted-types', () => ({
  acceptedTypesForOrganization: vi.fn(async () => ['.pdf', '.docx', '.txt', '.md', '.csv', '.xlsx', '.pptx']),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/upload-screening/service', async () => {
  const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
  return { gatePolicy: vi.fn(async () => SUGGESTED_SCREENING_POLICY) }
})
vi.mock('@/lib/compliance/repository', () => ({ isCoveredByActiveHold: vi.fn(async () => false) }))
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))
vi.mock('@/lib/jobs-queue/repository', () => ({ insertJobIfAbsent: vi.fn(async () => true) }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('./announce', () => ({ announceWaiting: vi.fn(async () => true) }))

import { captureServer } from '@/lib/analytics/posthog-server'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isCoveredByActiveHold } from '@/lib/compliance/repository'
import { insertJobIfAbsent } from '@/lib/jobs-queue/repository'
import { scanForMalware } from '@/lib/malware-scan/client'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  attachment,
  BODY,
  bytes,
  fakeDns,
  INBOUND_DOMAIN,
  keyFor,
  MEMBER_DOMAIN,
  message,
  multipart,
  OTHER_TENANT_ADDRESS,
  pdf,
  PROJECT_ADDRESS,
  RECEIVED,
  sign,
} from './__fixtures__/hostile'
import { announceWaiting } from './announce'
import { readMail, type MailRead } from './read-client'
import { inboundMailJobId, runInboundMailReceive } from './receive-job'

const ORG = 'org_01RECEIVEJOB'
const PROJECT = '0e5b4f2e-1d7c-4c3a-9a51-2f0d8c6b7a10'
const MAIL = '3c2b1a00-0000-4000-8000-00000000a001'
const ADDRESS = '7a1f5c3e-8b2d-4e6f-9a0b-1c2d3e4f5a6b'
const BUCKET = 'grid-org-test'
const RAW_KEY = `org/${ORG}/project/${PROJECT}/_inbound-mail/${MAIL}/raw.eml`
const READ_KEY = `org/${ORG}/project/${PROJECT}/_inbound-mail/${MAIL}/read.json`
const MEMBER_ID = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2H3'
const FOLLOWER_ID = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2H4'
const THREAD = '9d8c7b6a-0000-4000-8000-0000000000aa'
const NOT_LAST = { last: false }
const LAST = { last: true }

const CLEAN: MalwareScanVerdict = {
  status: 'clean',
  engine: { version: 'ClamAV 1.5.4', signatures: 28157, signaturesPublishedAt: new Date('2026-09-28T00:00:00Z') },
}

function read(overrides: Partial<MailRead> = {}): MailRead {
  return {
    readerVersion: 1,
    bodySource: 'plain',
    ownText: 'Hallo, anbei die Unterlagen.',
    ownTextTruncated: false,
    split: true,
    signatureRemoved: true,
    quoted: [],
    quotedTruncated: false,
    calendar: [],
    calendarTruncated: false,
    encrypted: false,
    unreadableReasons: [],
    unreadable: false,
    ...overrides,
  }
}

function receivedRow(overrides: Partial<InboundMailRow> = {}): InboundMailRow {
  return {
    id: MAIL,
    organizationId: ORG,
    projectId: PROJECT,
    addressId: ADDRESS,
    status: 'received',
    deliveryKey: 'a'.repeat(64),
    envelopeFrom: 'bounce@buero-muster.at',
    rawSizeBytes: 2048,
    stagingBucket: BUCKET,
    rawStorageKey: RAW_KEY,
    readStorageKey: null,
    rawScanStatus: 'pending',
    rawScanEngine: null,
    rawScanSignature: null,
    rawScannedAt: null,
    rawScanAttempts: 0,
    messageId: null,
    inReplyTo: [],
    referenceIds: [],
    threadIndexGuid: null,
    baseSubject: null,
    threadMatch: [],
    senderAddress: null,
    senderName: null,
    subject: null,
    participants: [],
    participantDomains: [],
    recipientCount: 0,
    senderTrust: null,
    senderUserId: null,
    senderReason: null,
    signerDomain: null,
    signedHeaders: [],
    senderFlags: [],
    authenticationResults: null,
    automatic: false,
    droppedReason: null,
    sentAt: null,
    sentAtHeader: null,
    receivedAt: RECEIVED,
    expiresAt: new Date(RECEIVED.getTime() + 30 * 86_400_000),
    settledAt: null,
    notifiedAt: null,
    expiringNotifiedAt: null,
    notStaged: [],
    ignored: {},
    erasureDeferredAt: null,
    originalMovePendingAt: null,
    createdAt: RECEIVED,
    updatedAt: RECEIVED,
    ...overrides,
  }
}

/** Stage `raw` as the webhook would have, and make the row for it. */
function receive(raw: string, overrides: Partial<InboundMailRow> = {}) {
  state.objects.set(RAW_KEY, bytes(raw))
  state.row = receivedRow(overrides)
}

const run = (attempt = NOT_LAST) => runInboundMailReceive(ORG, { mailId: MAIL, projectId: PROJECT }, attempt)
const heldRow = () => state.row as InboundMailRow
const stagedRead = () => JSON.parse(Buffer.from(state.objects.get(READ_KEY) ?? new Uint8Array()).toString()) as MailRead
const jobKinds = () => vi.mocked(insertJobIfAbsent).mock.calls.map(([job]) => job.kind)

/** The INFO lines (the per-delivery operator trail), through the spy rather than `console`. */
let infoSpy: ReturnType<typeof vi.spyOn>
const infoLines = () => infoSpy

beforeEach(() => {
  Object.assign(state, {
    row: null,
    parts: [],
    objects: new Map(),
    erased: [],
    calls: [],
    threadCandidates: [],
    filedMessages: [],
    followContext: null,
    dns: fakeDns({ ...keyFor(MEMBER_DOMAIN), ...keyFor('statik-weber.at') }),
  })
  vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', INBOUND_DOMAIN)
  vi.mocked(scanForMalware).mockResolvedValue(CLEAN)
  vi.mocked(readMail).mockResolvedValue(read())
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      [MEMBER_ID, { userId: MEMBER_ID, email: 'Anna@Buero-Muster.at', name: 'Anna Muster', profilePictureUrl: null }],
      [FOLLOWER_ID, { userId: FOLLOWER_ID, email: 'max@buero-muster.at', name: 'Max', profilePictureUrl: null }],
    ]),
  )
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue({
    userId: FOLLOWER_ID,
    email: 'max@buero-muster.at',
    name: null,
    accessToken: '',
    organizationId: ORG,
    organizationMembershipId: 'om_01',
    role: 'member',
    permissions: [],
    featureFlags: null,
  } as unknown as AuthorizedSession)
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('the receive job holds a mail for a person', () => {
  it('holds a member’s signed mail with its text and attachment, scanned, labelled and announced', async () => {
    receive(await sign(message(multipart('mixed', [BODY, attachment('S-101_C.pdf', 'application/pdf', pdf('S-101 C'))]))))

    await run()

    const row = heldRow()
    expect(row).toMatchObject({
      status: 'waiting',
      rawScanStatus: 'clean',
      rawScanEngine: 'ClamAV 1.5.4/28157',
      senderTrust: 'member_verified',
      senderUserId: MEMBER_ID,
      senderReason: 'dkim_pass',
      signerDomain: MEMBER_DOMAIN,
      senderAddress: 'anna@buero-muster.at',
      subject: 'Einreichplan',
      baseSubject: 'einreichplan',
      messageId: 'm1@buero-muster.at',
      readStorageKey: READ_KEY,
      automatic: false,
    })
    expect(row.senderFlags).toEqual([])
    expect(row.signedHeaders).toEqual(expect.arrayContaining(['from', 'subject', 'date', 'message-id', 'to']))
    expect(row.authenticationResults).not.toMatch(/spf=/i)
    expect(state.parts.map((part) => [part.position, part.kind, part.scanStatus])).toEqual([
      [0, 'message', 'not_applicable'],
      [1, 'attachment', 'clean'],
    ])
    expect(state.parts[1]).toMatchObject({
      filename: 'S-101_C.pdf',
      storageKey: `org/${ORG}/project/${PROJECT}/_inbound-mail/${MAIL}/1`,
      scanEngine: 'ClamAV 1.5.4/28157',
    })
    expect(state.objects.get(`org/${ORG}/project/${PROJECT}/_inbound-mail/${MAIL}/1`)).toBeDefined()
    expect(stagedRead().ownText).toBe('Hallo, anbei die Unterlagen.')
    expect(announceWaiting).toHaveBeenCalledWith(expect.objectContaining({ mailId: MAIL, senderTrust: 'member_verified' }))
    expect(jobKinds()).toEqual(['inbound_mail_suggest'])
    expect(vi.mocked(insertJobIfAbsent).mock.calls[0][0]).toMatchObject({ jobId: inboundMailJobId('suggest', MAIL) })
    expect(row.notifiedAt).not.toBeNull()
  })

  it('scans the whole raw message before the mail is waiting, and holds it on a failed scan (never clean)', async () => {
    vi.mocked(scanForMalware).mockResolvedValue({ status: 'failed', failure: 'unavailable', detail: null, engine: null })
    receive(await sign(message()))

    await run()

    expect(state.calls.indexOf('scan:failed')).toBeLessThan(state.calls.indexOf('hold'))
    expect(heldRow()).toMatchObject({ status: 'waiting', rawScanStatus: 'failed' })
  })

  it('scans every attachment on its own, and an infected one waits for a dismissal only', async () => {
    vi.mocked(scanForMalware).mockResolvedValueOnce(CLEAN).mockResolvedValueOnce({ ...CLEAN, status: 'infected', signature: 'Eicar-Test-Signature' })
    receive(await sign(message(multipart('mixed', [BODY, attachment('Plan.pdf', 'application/pdf', pdf('x'))]))))

    await run()

    expect(state.parts[1]).toMatchObject({ scanStatus: 'infected', scanSignature: 'Eicar-Test-Signature' })
  })

  it('holds a mail whose DKIM fails like any other: labelled, never refused (NEGATIVE)', async () => {
    state.dns = fakeDns({})
    receive(await sign(message()))

    await run()

    expect(heldRow()).toMatchObject({ status: 'waiting', senderTrust: 'member_unverified', senderUserId: MEMBER_ID })
    expect(heldRow().senderReason).not.toBe('dkim_pass')
  })

  it('labels an unsigned stranger external_unverified and spends no model on it', async () => {
    receive(message(BODY, { From: 'Wer Auch Immer <x@stranger.example>' }))

    await run()

    expect(heldRow()).toMatchObject({ status: 'waiting', senderTrust: 'external_unverified', senderUserId: null })
    expect(jobKinds()).not.toContain('inbound_mail_suggest')
    expect(announceWaiting).toHaveBeenCalledTimes(1)
  })

  it('flags an attachment the Namensprüfung stops, and keeps it a part (flag, not drop)', async () => {
    receive(await sign(message(multipart('mixed', [BODY, attachment('Honorarnote_Mai.pdf', 'application/pdf', pdf('h'))]))))

    await run()

    expect(state.parts[1].riskFlags).toContain('name_stop')
    expect(state.parts[1].nameStopTerms).toEqual(['Honorar'])
  })

  it('records the content check of the own text, after the reader removed the signature', async () => {
    vi.mocked(readMail).mockResolvedValue(read({ ownText: 'Bitte überweisen an AT61 1904 3002 3457 3201.' }))
    receive(await sign(message()))

    await run()

    expect(state.parts[0].contentFindings).toEqual(['iban'])
  })

  it('sets message_id_reused when the project has the id, and already_filed when it has the message', async () => {
    state.filedMessages = [{ entryId: 'e1', threadId: THREAD, source: 'inbound', ownTextSha256: '0'.repeat(64) }]
    receive(await sign(message()))
    await run()
    expect(heldRow().senderFlags).toContain('message_id_reused')

    state.filedMessages = [{ entryId: 'e1', threadId: THREAD, source: 'archive', ownTextSha256: '0'.repeat(64) }]
    receive(await sign(message()))
    await run()
    expect(heldRow().senderFlags).toContain('already_filed')
  })

  it('stores the thread match as ids and strengths only', async () => {
    state.threadCandidates = [
      {
        threadId: THREAD,
        baseSubject: 'einreichplan',
        threadIndexGuid: null,
        receivedIds: ['m0@buero-muster.at'],
        referencedIds: [],
        participants: [],
        lastEntryAt: RECEIVED,
      },
    ]
    receive(await sign(message(BODY, { 'In-Reply-To': '<m0@buero-muster.at>', References: '<m0@buero-muster.at>', Subject: 'AW: Einreichplan' })))

    await run()

    expect(heldRow().threadMatch).toEqual([{ threadId: THREAD, strength: 'reference', headers: ['in-reply-to', 'references'] }])
  })
})

describe('automatic mail', () => {
  it('drops an auto-reply unseen and erases its raw message by its key', async () => {
    receive(message(BODY, { 'Auto-Submitted': 'auto-replied', Subject: 'Abwesend' }))

    await run()

    expect(heldRow()).toMatchObject({ status: 'dropped', droppedReason: 'auto_reply', rawStorageKey: null, envelopeFrom: null })
    expect(state.erased).toEqual([RAW_KEY])
    expect(announceWaiting).not.toHaveBeenCalled()
    expect(captureServer).toHaveBeenCalledWith(expect.objectContaining({ event: 'inbound_mail_dropped', properties: { reason: 'auto_reply' } }))
  })

  it('keeps the raw message of a dropped mail under a legal hold, for the deferred erasure', async () => {
    vi.mocked(isCoveredByActiveHold).mockResolvedValue(true)
    receive(message(BODY, { 'Auto-Submitted': 'auto-replied' }))

    await run()

    expect(heldRow()).toMatchObject({ status: 'dropped', rawStorageKey: RAW_KEY })
    expect(heldRow().erasureDeferredAt).not.toBeNull()
    expect(state.erased).toEqual([])
  })

  it('holds list mail, marked automatic and announced, with no model spent on it', async () => {
    receive(await sign(message(BODY, { 'List-Id': '<news.example.org>' })))

    await run()

    expect(heldRow()).toMatchObject({ status: 'waiting', automatic: true })
    expect(jobKinds()).not.toContain('inbound_mail_suggest')
    expect(announceWaiting).toHaveBeenCalledWith(expect.objectContaining({ automatic: true }))
  })
})

describe('mail is never lost to a parser bug', () => {
  it('retries a reader fault, and holds the mail unreadable on the last attempt', async () => {
    vi.mocked(readMail).mockRejectedValue(new Error('502'))
    receive(await sign(message()))

    await expect(run(NOT_LAST)).rejects.toThrow()
    expect(heldRow().status).toBe('received')

    await run(LAST)
    expect(heldRow().status).toBe('waiting')
    expect(state.parts[0]).toMatchObject({ kind: 'message', riskFlags: ['unreadable'] })
  })

  it('holds the mail unreadable on the last attempt when anything else throws, with a scan on record', async () => {
    vi.mocked(loadOrganizationDirectory).mockRejectedValue(new Error('workos down'))
    receive(await sign(message()))

    await run(LAST)

    expect(heldRow()).toMatchObject({ status: 'waiting', senderTrust: 'external_unverified', readStorageKey: null, rawScanStatus: 'clean' })
    expect(state.parts).toHaveLength(1)
    expect(state.parts[0].riskFlags).toEqual(['unreadable'])
    expect(announceWaiting).toHaveBeenCalledTimes(1)
  })

  it('retries an empty directory (a failed read) rather than label a member a stranger', async () => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
    receive(await sign(message()))

    await expect(run(NOT_LAST)).rejects.toThrow('directory')
    expect(heldRow().status).toBe('received')
  })

  it('announces a mail an earlier run held but did not announce, and never twice', async () => {
    receive(await sign(message()))
    await run()
    expect(announceWaiting).toHaveBeenCalledTimes(1)

    await run()
    expect(announceWaiting).toHaveBeenCalledTimes(1)

    state.row = { ...heldRow(), notifiedAt: null }
    await run()
    expect(announceWaiting).toHaveBeenCalledTimes(2)
  })
})

describe('B8: another office’s project address never reaches what a person reads', () => {
  const OTHER_TOKEN = OTHER_TENANT_ADDRESS.split('@')[0].split('.').pop() as string

  it('redacts it in the subject, the participants, the text, every quote and its header; keeps the receiving one', async () => {
    vi.mocked(readMail).mockResolvedValue(
      read({
        ownText: `Bitte auch an ${OTHER_TENANT_ADDRESS} und ${PROJECT_ADDRESS}.`,
        quoted: [{ header: `Am 1.10.2026 schrieb Nachbar <${OTHER_TENANT_ADDRESS}>:`, text: `Kopie an ${OTHER_TENANT_ADDRESS}` }],
        calendar: [
          {
            method: 'REQUEST',
            summary: `Termin ${OTHER_TENANT_ADDRESS}`,
            start: null,
            end: null,
            allDay: false,
            location: OTHER_TENANT_ADDRESS,
            status: null,
            organizerName: null,
            recurring: false,
          },
        ],
      }),
    )
    receive(
      await sign(
        message(BODY, {
          Subject: `Fwd: ${OTHER_TENANT_ADDRESS}`,
          Cc: `Nachbar <${OTHER_TENANT_ADDRESS}>, Statik <weber@statik-weber.at>`,
        }),
      ),
    )

    await run()

    const visible = JSON.stringify([heldRow(), stagedRead(), state.parts])
    expect(visible).not.toContain(OTHER_TOKEN)
    expect(stagedRead().ownText).toContain(PROJECT_ADDRESS)
    expect(stagedRead().quoted[0].header).toContain('nachbar.…@piloti.at')
    expect(heldRow().participants.map((participant) => participant.address)).toEqual(['anna@buero-muster.at', 'weber@statik-weber.at'])
    expect(heldRow().participantDomains).toEqual([MEMBER_DOMAIN, 'statik-weber.at'])
  })
})

describe('the PII canary', () => {
  it('lets no sender, subject, file name, address or token reach a log line, PostHog or the audit trail', async () => {
    const canaries = ['Zebulon Quixote', 'Kanarienvogel-Betreff', 'Flamingo-Rechnungsliste.pdf', 'quixote@canary-domain.example', 'abcdefgh2345']
    receive(
      message(multipart('mixed', [BODY, attachment(canaries[2], 'application/pdf', pdf('c'))]), {
        From: `${canaries[0]} <${canaries[3]}>`,
        Subject: canaries[1],
      }),
    )
    await run()
    vi.mocked(readMail).mockRejectedValue(new Error(`reader failed on ${canaries[1]}`))
    receive(message(BODY, { From: `${canaries[0]} <${canaries[3]}>`, Subject: canaries[1] }))
    await run(LAST)
    receive(message(BODY, { From: `${canaries[0]} <${canaries[3]}>`, 'Auto-Submitted': 'auto-replied' }))
    await run()

    const outbound = JSON.stringify([
      infoLines().mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.error).mock.calls.map((call) => call.map(String)),
      vi.mocked(captureServer).mock.calls,
      vi.mocked(recordAuditEventAfterCommit).mock.calls,
    ])
    for (const canary of canaries) expect(outbound, canary).not.toContain(canary)
    expect(vi.mocked(recordAuditEventAfterCommit).mock.calls.map(([event]) => event.action)).toEqual([
      'inbound_mail.received',
      'inbound_mail.received',
      'inbound_mail.received',
    ])
  })
})

describe('following: the follow job is queued only when D31’s conditions 1–6 hold', () => {
  const REFERENCE_HEADERS = { 'In-Reply-To': '<m0@buero-muster.at>', References: '<m0@buero-muster.at>', Subject: 'AW: Einreichplan' }

  beforeEach(() => {
    state.threadCandidates = [
      {
        threadId: THREAD,
        baseSubject: 'einreichplan',
        threadIndexGuid: null,
        receivedIds: ['m0@buero-muster.at'],
        referencedIds: [],
        participants: ['anna@buero-muster.at'],
        lastEntryAt: RECEIVED,
      },
    ]
    state.followContext = {
      threadId: THREAD,
      participantDomains: [MEMBER_DOMAIN],
      follows: [
        { id: 'f0000000-0000-4000-8000-000000000001', userId: FOLLOWER_ID, createdAt: new Date(RECEIVED.getTime() - 86_400_000), expiresAt: new Date(Date.now() + 86_400_000), endedAt: null },
      ],
    }
  })

  it('queues it, as the follower, for a verified reply whose thread headers are signed', async () => {
    receive(await sign(message(BODY, REFERENCE_HEADERS)))

    await run()

    expect(jobKinds()).toContain('inbound_mail_follow')
    const follow = vi.mocked(insertJobIfAbsent).mock.calls.find(([job]) => job.kind === 'inbound_mail_follow')?.[0]
    expect(follow).toMatchObject({
      jobId: inboundMailJobId('follow', MAIL),
      payload: { mailId: MAIL, projectId: PROJECT, followId: 'f0000000-0000-4000-8000-000000000001', requester: { userId: FOLLOWER_ID } },
    })
  })

  it('does not queue it when the References were added outside the signature', async () => {
    receive(await sign(message(BODY, REFERENCE_HEADERS), { headerList: 'from:to:subject:date:message-id' }))

    await run()

    expect(jobKinds()).not.toContain('inbound_mail_follow')
  })

  it('does not queue it when a new domain joins the conversation', async () => {
    receive(await sign(message(BODY, { ...REFERENCE_HEADERS, Cc: 'neu@new-party.example' })))

    await run()

    expect(jobKinds()).not.toContain('inbound_mail_follow')
  })

  it('does not queue it for an unverified sender, nor without a follow', async () => {
    state.dns = fakeDns({})
    receive(await sign(message(BODY, REFERENCE_HEADERS)))
    await run()
    expect(jobKinds()).not.toContain('inbound_mail_follow')

    state.dns = fakeDns(keyFor(MEMBER_DOMAIN))
    state.followContext = { threadId: THREAD, participantDomains: [MEMBER_DOMAIN], follows: [] }
    receive(await sign(message(BODY, REFERENCE_HEADERS)))
    await run()
    expect(jobKinds()).not.toContain('inbound_mail_follow')
  })

  it('does not queue it when the follower left the organization', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    receive(await sign(message(BODY, REFERENCE_HEADERS)))

    await run()

    expect(jobKinds()).not.toContain('inbound_mail_follow')
  })
})

describe('a job that has nothing to do', () => {
  it('leaves a mail of another project, organization or status alone', async () => {
    receive(await sign(message()), { projectId: 'ffffffff-0000-4000-8000-000000000000' })
    await run()
    expect(state.calls).toEqual([])

    receive(await sign(message()), { status: 'dropped' })
    await run()
    expect(state.calls).toEqual([])
  })
})
