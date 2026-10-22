/**
 * @vitest-environment node
 */
/**
 * The review service around the decision (ADR-0134): what a reader is shown
 * (masked, metadata only, no bytes until a clean scan), how a decision is
 * recorded (`via` from the call, never the body; one transaction with its
 * job; a refusal with its code), and what follows a commit (the trail, the
 * live hint, the waiting notice settled).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const store = vi.hoisted(() => ({
  mail: null as unknown,
  parts: [] as unknown[],
  write: vi.fn(),
  proposalId: undefined as string | undefined,
  agent: false,
  acting: false,
}))

vi.mock('./access', () => ({ requireMailReviewer: vi.fn(async () => ({ closed: false })) }))
vi.mock('./candidates', () => ({
  candidatesFor: vi.fn(async () => ({
    threads: () => ({ shown: [], hidden: 0 }),
    part: () => ({ duplicateOf: null, revisionCandidate: null, revisionCandidateHidden: false }),
    readsFolder: () => true,
    readsDocument: () => true,
  })),
}))
vi.mock('./audit', () => ({ auditDecisions: vi.fn(async () => true) }))
vi.mock('./decision', async () => {
  const actual = await vi.importActual<typeof import('./decision')>('./decision')
  return { ...actual, requireDecisionRights: vi.fn(async () => undefined) }
})
vi.mock('./repository', async () => {
  class MailChangedError extends Error {
    constructor(readonly mailId: string) {
      super('changed')
    }
  }
  class PartNotWaitingError extends Error {
    constructor(readonly mailId: string) {
      super('not waiting')
    }
  }
  return {
    MailChangedError,
    PartNotWaitingError,
    findProjectMail: vi.fn(async () => store.mail),
    findMailParts: vi.fn(async () => store.parts),
    findFollowDeciders: vi.fn(async () => new Map()),
    findLiveFolders: vi.fn(async (_p: string, ids: string[]) => new Map(ids.map((id) => [id, 'Tragwerk']))),
    findThreadDocuments: vi.fn(async () => []),
    findCandidateDocuments: vi.fn(async () => []),
    writeMailDecisions: store.write,
    dismissMails: vi.fn(async () => ({ decisions: [] })),
    restoreMailParts: vi.fn(async () => ({ decisions: [] })),
    hasOpenParts: vi.fn(async () => false),
    listProjectMails: vi.fn(async () => []),
  }
})
vi.mock('./staging', () => ({ readStagedObject: vi.fn(async () => new TextEncoder().encode('raw bytes')) }))
vi.mock('./malware-scan', () => ({ scanForStorage: vi.fn(async () => ({ status: 'infected', engine: null, signature: 'Eicar', scannedAt: new Date() })) }))
vi.mock('@/lib/upload-screening/service', () => ({ gatePolicy: vi.fn(async () => ({ enabled: true, nameTerms: [], nameExceptions: [] })) }))
vi.mock('@/lib/upload-screening/content-screen', () => ({
  chatScreeningRules: () => ({}),
  maskText: (text: string) => {
    const masked = text.replace(/AT\d{18}/g, '[IBAN]')
    return { text: masked, findings: masked === text ? [] : [{ kind: 'iban', count: 1 }] }
  },
}))
vi.mock('@/lib/documents/accepted-types', () => ({
  acceptedTypesForOrganization: vi.fn(async () => ['.pdf']),
  isAcceptedType: (name: string, accepted: readonly string[]) => accepted.includes(name.slice(name.lastIndexOf('.'))),
}))
vi.mock('@/lib/agent-api/acting-session', () => ({
  actingProposalId: () => store.proposalId,
  actingReaderIsAgent: () => store.agent,
  currentActingSession: () => (store.acting ? {} : undefined),
}))
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('./suggest-scores', () => ({ scoreMailDecision: vi.fn(() => 'all') }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ resolveInboxItemsAnchoredOn: vi.fn(async () => 1) }))
vi.mock('@/lib/inbox/best-effort', () => ({ bestEffortInbox: vi.fn(async (_l: string, _o: string, write: () => Promise<unknown>) => write()) }))

import { captureServer } from '@/lib/analytics/posthog-server'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import { FILE_PART_ID, FOLDER_ID, MAIL_ID, PERSON, PROJECT_ID, filePart, heldMail, textPart } from './__fixtures__/review'
import { auditDecisions } from './audit'
import { mailIfMatch } from './decision'
import { MailChangedError } from './repository'
import { scoreMailDecision } from './suggest-scores'
import { decisionActor, dismissInboundMails, fileInboundMails, filingJobId, getInboundMail, readInboundMailOriginal, readInboundMailPart } from './service'

const session = {
  userId: PERSON,
  organizationId: 'org_1',
  email: 'lena@example.test',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
} as unknown as AuthorizedSession

beforeEach(() => {
  vi.clearAllMocks()
  store.mail = heldMail({ subject: 'Rechnung, IBAN AT611904300234573201' })
  store.parts = [textPart(), filePart()]
  store.proposalId = undefined
  store.agent = false
  store.acting = false
  store.write.mockImplementation(async (writes: Array<{ files: Array<{ id: string; partId: string }> }>) => ({
    decisions: writes.flatMap((write) => write.files.map((file) => ({ ...file, mailId: MAIL_ID, action: 'file' }))),
  }))
})

describe('how a decision reached us', () => {
  it('is the app, an outside agent acting as the person, or a Piloti card, read from the call', () => {
    expect(decisionActor(session)).toEqual({ decidedBy: PERSON, via: 'app', proposalId: null })
    store.acting = true
    store.agent = true
    expect(decisionActor(session)).toMatchObject({ via: 'agent' })
    store.proposalId = 'prop-1'
    expect(decisionActor(session)).toEqual({ decidedBy: PERSON, via: 'piloti_proposal', proposalId: 'prop-1' })
  })
})

describe('what a reader is shown', () => {
  it('masks the subject for every reader and carries no text or bytes', async () => {
    const view = await getInboundMail(session, PROJECT_ID, MAIL_ID)
    expect(view.subject).toBe('Rechnung, IBAN [IBAN]')
    expect(Object.keys(view)).not.toEqual(expect.arrayContaining(['text', 'ownText', 'bytes']))
    expect(view.ifMatch).toBe(mailIfMatch(heldMail(), [textPart(), filePart()]))
    expect(view.parts.map((part) => part.kind)).toEqual(['message', 'attachment'])
  })

  it('serves an attachment only after a clean scan', async () => {
    store.parts = [textPart(), filePart({ scanStatus: 'pending', scannedAt: null })]
    await expect(readInboundMailPart(session, PROJECT_ID, MAIL_ID, FILE_PART_ID)).rejects.toMatchObject({ details: { reason: 'scan_not_clean' } })
    store.parts = [textPart(), filePart()]
    const res = await readInboundMailPart(session, PROJECT_ID, MAIL_ID, FILE_PART_ID)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment/)
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(expect.objectContaining({ action: 'inbound_mail.part_read' }))
  })

  it('scans the original whole on the request and refuses it unless clean, recording the read', async () => {
    await expect(readInboundMailOriginal(session, PROJECT_ID, MAIL_ID)).rejects.toMatchObject({
      details: { reason: 'original_not_clean', scan: 'infected' },
    })
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'inbound_mail.original_read', metadata: { projectId: PROJECT_ID, scan: 'infected' } }),
    )
  })
})

describe('a decision', () => {
  const body = () => ({
    mails: [
      {
        mailId: MAIL_ID,
        ifMatch: mailIfMatch(heldMail(), [textPart(), filePart()]),
        parts: [{ partId: FILE_PART_ID, folderId: FOLDER_ID, newFolderPath: null, name: 'S-101_C.pdf' }],
        message: null,
      },
    ],
  })

  it('writes the rows, the claims and the filing job together, as the person, then tells the trail', async () => {
    const result = await fileInboundMails(session, PROJECT_ID, body())
    const [writes, actor, , , job] = store.write.mock.calls[0] as [Array<{ files: Array<{ id: string }> }>, unknown, unknown, Date, { jobId: string; payload: { requester: { userId: string } } }]
    expect(actor).toEqual({ decidedBy: PERSON, via: 'app', proposalId: null })
    const firstId = writes[0]!.files[0]!.id
    expect(job.jobId).toBe(filingJobId(firstId))
    expect(job.payload).toMatchObject({ projectId: PROJECT_ID, mailIds: [MAIL_ID], requester: { userId: PERSON } })
    expect(result.filingJobId).toBe(job.jobId)
    expect(auditDecisions).toHaveBeenCalledTimes(1)
  })

  it('scores Piloti’s suggestion against the parts as they were, and tells PostHog whether it was followed', async () => {
    const before = [textPart(), filePart({ suggestion: { folderId: FOLDER_ID, folderPath: 'Tragwerk' } })]
    store.parts = before
    await fileInboundMails(session, PROJECT_ID, body())
    const scored = vi.mocked(scoreMailDecision).mock.calls[0]![0]
    expect(scored).toMatchObject({ organizationId: 'org_1', decidedBy: PERSON, via: 'app', parts: before, decision: body().mails[0] })
    expect(scored.folderPathOf(FOLDER_ID)).toBe('Tragwerk')
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'inbound_mail_decided', properties: expect.objectContaining({ suggestion_followed: 'all' }) }),
    )
  })

  it('scores a dismissed mail’s suggestions as not followed', async () => {
    const { dismissMails } = await import('./repository')
    vi.mocked(dismissMails).mockResolvedValueOnce({ decisions: [{ mailId: MAIL_ID, action: 'dismiss' }] } as never)
    vi.mocked(scoreMailDecision).mockReturnValueOnce('none')
    await dismissInboundMails(session, PROJECT_ID, { mailIds: [MAIL_ID] })
    expect(vi.mocked(scoreMailDecision).mock.calls[0]![0]).toMatchObject({ decision: null, parts: [textPart(), filePart()] })
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({ properties: expect.objectContaining({ suggestion_followed: 'none', files: 0, dismissed: 1 }) }),
    )
  })

  it('settles the waiting notice once nothing of the mail waits', async () => {
    store.write.mockImplementationOnce(async () => {
      store.parts = [textPart({ state: 'dismissed', endedAt: new Date() }), filePart({ state: 'filing', decisionId: 'd', claimExpiresAt: new Date() })]
      return { decisions: [] }
    })
    await fileInboundMails(session, PROJECT_ID, body())
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({ organizationId: 'org_1', types: ['inbound_mail.waiting'], anchorId: MAIL_ID })
  })

  it('answers a lost compare-and-set as `stale`, and writes nothing else', async () => {
    store.write.mockRejectedValueOnce(new MailChangedError(MAIL_ID))
    await expect(fileInboundMails(session, PROJECT_ID, body())).rejects.toMatchObject({ details: { reason: 'stale', mailId: MAIL_ID } })
    expect(auditDecisions).not.toHaveBeenCalled()
  })

  it('refuses before any write when a rule of C2 fails', async () => {
    store.parts = [textPart(), filePart({ riskFlags: ['macro'] })]
    const changed = body()
    changed.mails[0]!.ifMatch = mailIfMatch(heldMail(), store.parts as never)
    await expect(fileInboundMails(session, PROJECT_ID, changed)).rejects.toMatchObject({ details: { reason: 'risk_not_acknowledged' } })
    expect(store.write).not.toHaveBeenCalled()
  })
})
