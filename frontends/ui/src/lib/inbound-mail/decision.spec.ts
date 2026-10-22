/**
 * @vitest-environment node
 */
/**
 * Every check of DECISION §4 C2, each failing alone with its code, on a mail
 * that otherwise passes; and the rows a passing decision becomes, which are the
 * filing job's only instruction (ADR-0134).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({ findDocumentIdByStoredName: vi.fn(async () => null) }))
vi.mock('@/lib/authz/folder-access', () => ({ requireFolderWrite: vi.fn(async () => undefined) }))
vi.mock('@/lib/documents/accepted-types', () => ({
  isAcceptedType: (name: string, accepted: readonly string[]) => accepted.includes(name.slice(name.lastIndexOf('.')).toLowerCase()),
}))

import { ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import type { InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'
import {
  DOCUMENT_ID,
  FILE_PART_ID,
  FOLDER_ID,
  PERSON,
  PROJECT_ID,
  TEXT_PART_ID,
  THREAD_ID,
  filePart,
  heldMail,
  textPart,
} from './__fixtures__/review'
import type { ViewerCandidates } from './candidates'
import {
  mailIfMatch,
  planMailDecision,
  requireDecisionRights,
  senderNeedsAcknowledgement,
  type DecisionContext,
} from './decision'
import type { InboundMailDecision } from './inbound-mail-wire'
import { findDocumentIdByStoredName } from './repository'

const HIDDEN_FOLDER = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c'

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  const candidates: ViewerCandidates = {
    threads: () => ({ shown: [], hidden: 0 }),
    part: () => ({ duplicateOf: null, revisionCandidate: null, revisionCandidateHidden: false }),
    readsFolder: (folderId) => folderId !== HIDDEN_FOLDER,
    readsDocument: () => true,
  }
  return {
    actor: { decidedBy: PERSON, via: 'app', proposalId: null },
    bulk: false,
    acceptedTypes: ['.pdf', '.docx'],
    nameStops: (name) => (/honorar/i.test(name) ? ['Honorar'] : []),
    candidates,
    folders: new Map([
      [FOLDER_ID, 'Tragwerk'],
      [HIDDEN_FOLDER, 'Personal'],
    ]),
    threads: new Map([
      [
        THREAD_ID,
        {
          threadId: THREAD_ID,
          documentId: DOCUMENT_ID,
          name: 'Statik Einreichung',
          folderId: null,
          folderPath: null,
          nextVersion: 4,
          entryCount: 3,
          renderedBytes: 9000,
        },
      ],
    ]),
    documents: new Map([[DOCUMENT_ID, { documentId: DOCUMENT_ID, name: 'S-101_B.pdf', folderId: FOLDER_ID, folderPath: 'Tragwerk', nextVersion: 3 }]]),
    ...overrides,
  }
}

const parts = (): InboundMailPartRow[] => [textPart(), filePart()]

function decision(mail: InboundMailRow, overrides: Partial<InboundMailDecision> = {}): InboundMailDecision {
  return {
    mailId: mail.id,
    ifMatch: mailIfMatch(mail, parts()),
    parts: [{ partId: FILE_PART_ID, folderId: FOLDER_ID, newFolderPath: null, name: 'S-101_C.pdf' }],
    message: { partId: TEXT_PART_ID, text: 'full', thread: { action: 'append', mailThreadId: THREAD_ID } },
    ...overrides,
  }
}

/** The refusal code `fn` throws, or `passes`. */
function codeOf(fn: () => unknown): string {
  try {
    fn()
    return 'passes'
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error
    return (error.details as { reason: string }).reason
  }
}

const plan = (mail: InboundMailRow, d: InboundMailDecision, c = context(), p = parts()) => planMailDecision(mail, p, d, c)

describe('a decision that passes', () => {
  it('becomes one file row per part, each the person’s, with the destination as it was decided', () => {
    const mail = heldMail()
    const planned = plan(mail, decision(mail))
    expect(planned.files).toHaveLength(2)
    expect(planned.files[0]).toMatchObject({
      partId: FILE_PART_ID,
      action: 'file',
      decidedBy: PERSON,
      via: 'app',
      folderId: FOLDER_ID,
      folderPath: 'Tragwerk',
      fileName: 'S-101_C.pdf',
      screeningRelease: false,
      acknowledgedSender: false,
      acknowledgedRisk: false,
    })
    // An append names its thread and no destination of its own (`inbound_mail_decisions_destination_when_filing`).
    expect(planned.files[1]).toMatchObject({
      partId: TEXT_PART_ID,
      threadAction: 'append',
      mailThreadId: THREAD_ID,
      messageText: 'full',
      documentType: 'correspondence',
    })
    expect(planned.files[1]?.folderPath).toBeUndefined()
    expect(planned.writeFolders).toEqual([FOLDER_ID, null])
    expect(planned.freshNames).toEqual([{ partId: FILE_PART_ID, storedName: 'S-101_C.pdf' }])
  })

  it('files a new thread under its screened name in a path to create, and the root is ""', () => {
    const mail = heldMail()
    const planned = plan(
      mail,
      decision(mail, {
        parts: [],
        message: { partId: TEXT_PART_ID, text: 'full', thread: { action: 'create', folderId: null, newFolderPath: ' Korrespondenz//MA 37 ', name: 'Stellplatznachweis' } },
      }),
    )
    expect(planned.files[0]).toMatchObject({ threadAction: 'create', fileName: 'Stellplatznachweis', folderPath: 'Korrespondenz/MA 37', folderId: null })
  })

  it('files a part as the next version of a document in that document’s folder, and needs no free name', () => {
    const mail = heldMail()
    const planned = plan(
      mail,
      decision(mail, { parts: [{ partId: FILE_PART_ID, folderId: null, newFolderPath: null, name: 'S-101_C.pdf', revisionOf: DOCUMENT_ID }] }),
    )
    expect(planned.files[0]).toMatchObject({ targetDocumentId: DOCUMENT_ID, folderId: FOLDER_ID, folderPath: 'Tragwerk' })
    expect(planned.freshNames).toEqual([])
  })
})

describe('C3: the mail the person read', () => {
  it('refuses a stale ifMatch and a mail that is no longer held', () => {
    const mail = heldMail()
    expect(codeOf(() => plan(mail, decision(mail, { ifMatch: 'other' })))).toBe('stale')
    const settled = heldMail({ status: 'settled' })
    expect(codeOf(() => plan(settled, decision(settled)))).toBe('stale')
  })

  it('changes the token whenever a part changes', () => {
    const mail = heldMail()
    expect(mailIfMatch(mail, [textPart(), filePart({ state: 'dismissed' })])).not.toBe(mailIfMatch(mail, parts()))
    expect(mailIfMatch(mail, [textPart(), filePart({ updatedAt: new Date('2026-10-22T00:00:00Z') })])).not.toBe(mailIfMatch(mail, parts()))
  })

  it('refuses a part of another mail, the text in `parts`, and a part no longer waiting', () => {
    const mail = heldMail()
    const other = '0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f'
    expect(codeOf(() => plan(mail, decision(mail, { parts: [{ partId: other, folderId: null, newFolderPath: null, name: 'x.pdf' }] })))).toBe('part_unknown')
    expect(codeOf(() => plan(mail, decision(mail, { parts: [{ partId: TEXT_PART_ID, folderId: null, newFolderPath: null, name: 'x.pdf' }] })))).toBe('part_unknown')
    const filing = [textPart(), filePart({ state: 'filing' })]
    const d = { ...decision(mail), ifMatch: mailIfMatch(mail, filing) }
    expect(codeOf(() => plan(mail, d, context(), filing))).toBe('part_not_waiting')
  })
})

describe('C2: each rule, failing alone', () => {
  const withPart = (overrides: Partial<InboundMailPartRow>) => {
    const mail = heldMail()
    const rows = [textPart(), filePart(overrides)]
    return { mail, rows, d: { ...decision(mail), ifMatch: mailIfMatch(mail, rows) } }
  }

  it.each(['pending', 'failed', 'infected'] as const)('refuses an attachment whose scan is %s', (scanStatus) => {
    const { mail, rows, d } = withPart({ scanStatus, scannedAt: scanStatus === 'pending' ? null : new Date() })
    expect(codeOf(() => plan(mail, d, context(), rows))).toBe('scan_not_clean')
  })

  it('refuses a type the office does not file, by flag and by the name it is filed under', () => {
    const flagged = withPart({ riskFlags: ['type_not_accepted'] })
    expect(codeOf(() => plan(flagged.mail, flagged.d, context(), flagged.rows))).toBe('type_not_accepted')
    const mail = heldMail()
    expect(codeOf(() => plan(mail, decision(mail, { parts: [{ partId: FILE_PART_ID, folderId: null, newFolderPath: null, name: 'S-101_C.dwg' }] })))).toBe(
      'type_not_accepted',
    )
  })

  it('refuses a name the name check stops, in the file name, the thread name or the folder path, unless released', () => {
    const mail = heldMail()
    const named = (name: string, screeningRelease?: 'name') =>
      decision(mail, { parts: [{ partId: FILE_PART_ID, folderId: null, newFolderPath: null, name, ...(screeningRelease ? { screeningRelease } : {}) }] })
    expect(codeOf(() => plan(mail, named('Honorar.pdf')))).toBe('name_stop')
    expect(plan(mail, named('Honorar.pdf', 'name')).files[0]).toMatchObject({ screeningRelease: true })
    const thread = decision(mail, {
      parts: [],
      message: { partId: TEXT_PART_ID, text: 'full', thread: { action: 'create', folderId: null, newFolderPath: null, name: 'Honorar Nachtrag' } },
    })
    expect(codeOf(() => plan(mail, thread))).toBe('name_stop')
    const stops = context({ nameStops: (_name, folderPath) => (folderPath?.includes('Personal') ? ['Personal'] : []) })
    const path = decision(mail, { parts: [{ partId: FILE_PART_ID, folderId: null, newFolderPath: 'Personal', name: 'S-101_C.pdf' }] })
    expect(codeOf(() => plan(mail, path, stops))).toBe('name_stop')
  })

  it.each(['macro', 'type_mismatch'] as const)('refuses a %s part without its id in acknowledgeRisk', (flag) => {
    const { mail, rows, d } = withPart({ riskFlags: [flag] })
    expect(codeOf(() => plan(mail, d, context(), rows))).toBe('risk_not_acknowledged')
    expect(plan(mail, { ...d, acknowledgeRisk: [FILE_PART_ID] }, context(), rows).files[0]).toMatchObject({ acknowledgedRisk: true })
  })

  it('needs the unverified-thread acknowledgement for an append the sender’s signature does not cover (D11)', () => {
    // A stranger whose domain verified but did not sign References: the match proves nothing.
    const mail = heldMail({ senderTrust: 'external_verified', senderUserId: null, signedHeaders: ['from', 'subject', 'date', 'message-id'] })
    expect(codeOf(() => plan(mail, decision(mail)))).toBe('risk_not_acknowledged')
    expect(plan(mail, { ...decision(mail), acknowledgeRisk: [TEXT_PART_ID] }).files[1]).toMatchObject({ acknowledgedRisk: true })
    // An unverified sender's References never vouch for the append either.
    const forged = heldMail({ senderTrust: 'external_unverified', senderUserId: null, senderReason: 'dkim_none', signedHeaders: [] })
    expect(codeOf(() => plan(forged, decision(forged)))).toBe('risk_not_acknowledged')
  })

  it('needs it for a new version of a document on such a sender’s word, too', () => {
    const mail = heldMail({ senderTrust: 'external_unverified', senderUserId: null, senderReason: 'dkim_none', signedHeaders: [] })
    const d = decision(mail, {
      parts: [{ partId: FILE_PART_ID, folderId: null, newFolderPath: null, name: 'S-101_C.pdf', revisionOf: DOCUMENT_ID }],
      message: null,
    })
    expect(codeOf(() => plan(mail, d))).toBe('risk_not_acknowledged')
  })

  it.each([
    ['a member’s address without their signature', { senderTrust: 'member_unverified', senderReason: 'dkim_none' }],
    ['a failed signature', { senderTrust: 'external_unverified', senderUserId: null, senderReason: 'dkim_fail' }],
    ['a domain policy that refused it', { senderTrust: 'external_unverified', senderUserId: null, senderReason: 'dkim_policy' }],
    ['a mail addressed to others', { senderFlags: ['not_addressed_to_project'] }],
    ['a stale date', { senderFlags: ['stale_date'] }],
  ] as const)('needs acknowledgeSender for %s', (_case, overrides) => {
    const mail = heldMail(overrides as Partial<InboundMailRow>)
    expect(senderNeedsAcknowledgement(mail)).toBe(true)
    const d = decision(mail, { message: null })
    expect(codeOf(() => plan(mail, d))).toBe('sender_not_acknowledged')
    expect(plan(mail, { ...d, acknowledgeSender: true }).files[0]).toMatchObject({ acknowledgedSender: true })
  })

  it('needs no sender acknowledgement for a stranger’s plain unsigned mail, nor for a member’s own Bcc copy', () => {
    expect(senderNeedsAcknowledgement(heldMail({ senderTrust: 'external_unverified', senderUserId: null, senderReason: 'dkim_none' }))).toBe(false)
    expect(senderNeedsAcknowledgement(heldMail({ senderFlags: ['not_addressed_to_project', 'bcc_own'] }))).toBe(false)
  })

  it('refuses acknowledgements in a request about more than one mail (RT-S5)', () => {
    const mail = heldMail()
    expect(codeOf(() => plan(mail, { ...decision(mail), acknowledgeSender: true }, context({ bulk: true })))).toBe('acknowledgement_in_bulk')
    expect(codeOf(() => plan(mail, { ...decision(mail), acknowledgeRisk: [FILE_PART_ID] }, context({ bulk: true })))).toBe(
      'acknowledgement_in_bulk',
    )
    expect(codeOf(() => plan(mail, decision(mail), context({ bulk: true })))).toBe('passes')
  })

  it('refuses a Piloti card that carries an acknowledgement or a release (RT-S5)', () => {
    const mail = heldMail()
    const card = context({ actor: { decidedBy: PERSON, via: 'piloti_proposal', proposalId: '6f1c2b8e-3d4a-4b6c-8d7e-9f0a1b2c3d4e' } })
    expect(codeOf(() => plan(mail, { ...decision(mail), acknowledgeSender: true }, card))).toBe('card_carries_acknowledgement')
    const released = decision(mail, { parts: [{ partId: FILE_PART_ID, folderId: null, newFolderPath: null, name: 'S-101_C.pdf', screeningRelease: 'name' }] })
    expect(codeOf(() => plan(mail, released, card))).toBe('card_carries_acknowledgement')
    expect(plan(mail, decision(mail), card).files[0]).toMatchObject({ via: 'piloti_proposal', proposalId: '6f1c2b8e-3d4a-4b6c-8d7e-9f0a1b2c3d4e' })
  })

  it('refuses a folder, thread or document the person may not read, and a full thread', () => {
    const mail = heldMail()
    expect(codeOf(() => plan(mail, decision(mail, { parts: [{ partId: FILE_PART_ID, folderId: HIDDEN_FOLDER, newFolderPath: null, name: 'a.pdf' }] })))).toBe(
      'target_unknown',
    )
    const gone = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f'
    expect(codeOf(() => plan(mail, decision(mail, { message: { partId: TEXT_PART_ID, text: 'full', thread: { action: 'append', mailThreadId: gone } } })))).toBe(
      'target_unknown',
    )
    const hiddenThread = context()
    const full = context({
      threads: new Map([[THREAD_ID, { ...hiddenThread.threads.get(THREAD_ID)!, entryCount: 200 }]]),
    })
    expect(codeOf(() => plan(mail, decision(mail), full))).toBe('thread_full')
  })

  it('refuses the text of a mail nobody could read, and masking a text with nothing to mask', () => {
    const unread = heldMail({ readStorageKey: null })
    expect(codeOf(() => plan(unread, decision(unread)))).toBe('unreadable')
    const mail = heldMail()
    expect(codeOf(() => plan(mail, decision(mail, { message: { partId: TEXT_PART_ID, text: 'masked', thread: { action: 'append', mailThreadId: THREAD_ID } } })))).toBe(
      'nothing_to_mask',
    )
  })
})

describe('the rights asked last, as the person', () => {
  const session = { userId: PERSON, organizationId: 'org_1' } as AuthorizedSession
  beforeEach(() => vi.clearAllMocks())

  it('asks write on every target folder, the root included', async () => {
    const mail = heldMail()
    await requireDecisionRights(session, PROJECT_ID, [plan(mail, decision(mail))])
    expect(requireFolderWrite).toHaveBeenCalledWith(session, PROJECT_ID, [FOLDER_ID, null])
  })

  it('refuses a name taken in the project unless the part is filed as that document’s next version', async () => {
    vi.mocked(findDocumentIdByStoredName).mockResolvedValueOnce(DOCUMENT_ID)
    const mail = heldMail()
    await expect(requireDecisionRights(session, PROJECT_ID, [plan(mail, decision(mail))])).rejects.toMatchObject({
      details: { reason: 'name_taken', partId: FILE_PART_ID },
    })
  })
})
