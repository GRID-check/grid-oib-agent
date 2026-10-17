/**
 * @vitest-environment node
 */
/**
 * How a woken turn ended (ADR-0106, ADR-0109): the outcome names its wake by
 * the turn id, and the wake's final word, the mark handed back from a
 * delegation, the one audit event and the one call to attention follow from
 * it. The repository layer is mocked; what is pinned is which calls the
 * service makes, in which order, and when it makes none.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({ transaction: (run: (tx: unknown) => unknown) => run(TX) })),
}))
vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: vi.fn((_reason: string, fn: () => unknown) => fn()),
  withTenant: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}))
vi.mock('@/lib/annotations/wake-repository', () => ({
  findWakeById: vi.fn(),
  endWake: vi.fn(),
  handBackDelegation: vi.fn(),
}))
vi.mock('@/lib/annotations/repository', () => ({ findDocumentAnnotation: vi.fn() }))
vi.mock('@/lib/annotations/attention', () => ({ onWakeEnded: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn() }))

import { onWakeEnded } from '@/lib/annotations/attention'
import { delegationEventId, documentThreadConversationId, wakeTurnId } from '@/lib/annotations/wake-ids'
import { findDocumentAnnotation, type AnnotationRecord } from '@/lib/annotations/repository'
import { endWake, findWakeById, handBackDelegation } from '@/lib/annotations/wake-repository'
import type { Document, PilotiWakeRow } from '@/lib/db/schema'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { recordAuditEvent, type AuditEventInput } from '@/lib/audit/service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { expectRegistered } from '@/test-utils/audit'
import { DEFAULT_FAILURE_REASON, recordTurnOutcome, wakeEndOf } from './outcome'
import type { TurnOutcomeRequest } from './outcome-types'

const TX = { handle: 'tx' }
const ORG = 'org_1'
const DOC_ID = '11111111-1111-4111-8111-111111111111'
const MARK_ID = '22222222-2222-4222-8222-222222222222'
const REPLY_ID = '33333333-3333-4333-8333-333333333333'
const USER = 'user_anna'
const THREAD = documentThreadConversationId(DOC_ID, USER)
const DELEGATED_AT = new Date('2026-10-13T09:00:00.000Z')

const MENTION: PilotiWakeRow = {
  id: wakeTurnId(REPLY_ID),
  organizationId: ORG,
  documentId: DOC_ID,
  annotationId: MARK_ID,
  triggerKind: 'thread_mention',
  eventId: REPLY_ID,
  actorUserId: USER,
  status: 'started',
  reason: null,
  createdAt: new Date('2026-10-13T10:00:00Z'),
  settledAt: new Date('2026-10-13T10:00:05Z'),
  endedAt: null,
}

const DELEGATION: PilotiWakeRow = {
  ...MENTION,
  id: wakeTurnId(delegationEventId(MARK_ID, DELEGATED_AT)),
  triggerKind: 'assigned',
  eventId: delegationEventId(MARK_ID, DELEGATED_AT),
}

const request = (wake: PilotiWakeRow, over: Partial<TurnOutcomeRequest> = {}): TurnOutcomeRequest => ({
  conversationId: THREAD,
  turnId: wake.id,
  outcome: 'answered',
  ...over,
})

/** The mark as the service reads it: delegated at that moment, or not delegated. */
function markIs(delegatedAt: Date | null) {
  vi.mocked(findDocumentAnnotation).mockResolvedValue({
    id: MARK_ID,
    number: 4,
    body: 'Türbreite prüfen',
    delegatedAt,
  } as Partial<AnnotationRecord> as AnnotationRecord)
}

/** `endWake` as the database would answer it: the row as ended, or null when it was not `started`. */
function wakeEndsAs(wake: PilotiWakeRow) {
  vi.mocked(findWakeById).mockResolvedValue(wake)
  vi.mocked(endWake).mockImplementation(async (_tx, _org, _id, end) => ({
    ...wake,
    status: end.status,
    reason: end.status === 'failed' ? end.reason : null,
    endedAt: new Date(),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  markIs(null)
  vi.mocked(handBackDelegation).mockResolvedValue(true)
  vi.mocked(findDocumentInOrg).mockResolvedValue({ id: DOC_ID, projectId: 'proj_1' } as Partial<Document> as Document)
  vi.mocked(publishToDocumentRoom).mockResolvedValue(undefined)
  vi.mocked(onWakeEnded).mockResolvedValue(undefined)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([[USER, { userId: USER, email: 'anna@example.at', name: 'Anna Berger', profilePictureUrl: null }]])
  )
})

describe('wakeEndOf', () => {
  it('maps each outcome to the wake end', () => {
    expect(wakeEndOf({ outcome: 'answered' })).toEqual({ status: 'answered' })
    expect(wakeEndOf({ outcome: 'handed_off' })).toEqual({ status: 'answered' })
    expect(wakeEndOf({ outcome: 'stopped' })).toEqual({ status: 'stopped' })
    expect(wakeEndOf({ outcome: 'refused', reason: 'Budget erschöpft.' })).toEqual({
      status: 'failed',
      reason: 'Budget erschöpft.',
    })
    expect(wakeEndOf({ outcome: 'failed', reason: 'model down' })).toEqual({ status: 'failed', reason: 'model down' })
  })

  it('gives a failure with no reason a sentence, so the reason CHECK holds', () => {
    expect(wakeEndOf({ outcome: 'failed' })).toEqual({ status: 'failed', reason: DEFAULT_FAILURE_REASON })
    expect(wakeEndOf({ outcome: 'refused', reason: '   ' })).toEqual({ status: 'failed', reason: DEFAULT_FAILURE_REASON })
  })
})

describe('recordTurnOutcome', () => {
  it.each([
    ['answered', undefined, { status: 'answered' }],
    ['handed_off', undefined, { status: 'answered' }],
    ['stopped', undefined, { status: 'stopped' }],
    ['refused', 'Budget erschöpft.', { status: 'failed', reason: 'Budget erschöpft.' }],
    ['failed', undefined, { status: 'failed', reason: DEFAULT_FAILURE_REASON }],
  ] as const)('ends the wake for %s', async (outcome, reason, end) => {
    wakeEndsAs(MENTION)
    expect(await recordTurnOutcome(request(MENTION, { outcome, reason }))).toEqual({ settled: true })
    expect(endWake).toHaveBeenCalledWith(TX, ORG, MENTION.id, end)
  })

  it('settles nothing for an unknown turn (a browser\'s)', async () => {
    vi.mocked(findWakeById).mockResolvedValue(null)
    expect(await recordTurnOutcome(request(MENTION))).toEqual({ settled: false })
    expect(endWake).not.toHaveBeenCalled()
    expect(onWakeEnded).not.toHaveBeenCalled()
  })

  it('settles nothing when the conversation is not the wake\'s thread', async () => {
    wakeEndsAs(MENTION)
    const other = documentThreadConversationId(DOC_ID, 'user_bernd')
    expect(await recordTurnOutcome(request(MENTION, { conversationId: other }))).toEqual({ settled: false })
    expect(endWake).not.toHaveBeenCalled()
  })

  it('ends a wake the job has not marked started yet: a turn that errors at once reports first', async () => {
    wakeEndsAs(MENTION)
    vi.mocked(findWakeById).mockResolvedValue({ ...MENTION, status: 'queued', settledAt: null })
    expect(await recordTurnOutcome(request(MENTION, { outcome: 'failed', reason: 'boom' }))).toEqual({ settled: true })
    expect(endWake).toHaveBeenCalledTimes(1)
  })

  it('settles nothing for a wake that already ended', async () => {
    for (const status of ['answered', 'stopped', 'failed', 'suppressed', 'refused'] as const) {
      vi.mocked(findWakeById).mockResolvedValue({ ...MENTION, status })
      expect(await recordTurnOutcome(request(MENTION))).toEqual({ settled: false })
    }
    expect(endWake).not.toHaveBeenCalled()
    expect(onWakeEnded).not.toHaveBeenCalled()
  })

  it('is idempotent: a second report finds the wake ended and changes nothing', async () => {
    wakeEndsAs(MENTION)
    expect(await recordTurnOutcome(request(MENTION))).toEqual({ settled: true })
    // The row is `answered` now; and were the status read stale, `endWake` refuses from anything but `started`.
    vi.mocked(findWakeById).mockResolvedValue({ ...MENTION, status: 'answered', endedAt: new Date() })
    expect(await recordTurnOutcome(request(MENTION, { outcome: 'failed', reason: 'late' }))).toEqual({ settled: false })
    vi.mocked(findWakeById).mockResolvedValue(MENTION)
    vi.mocked(endWake).mockResolvedValue(null)
    expect(await recordTurnOutcome(request(MENTION))).toEqual({ settled: false })
    expect(onWakeEnded).toHaveBeenCalledTimes(1)
  })

  describe('a delegation', () => {
    it('hands the mark back when it is still delegated by THAT delegation', async () => {
      wakeEndsAs(DELEGATION)
      markIs(DELEGATED_AT)
      expect(await recordTurnOutcome(request(DELEGATION))).toEqual({ settled: true })
      expect(handBackDelegation).toHaveBeenCalledWith(TX, ORG, MARK_ID, DELEGATED_AT)
      expect(publishToDocumentRoom).toHaveBeenCalledWith(
        DOC_ID,
        expect.objectContaining({ kind: 'annotations.changed', annotationIds: [MARK_ID], change: 'updated' })
      )
    })

    it('never clears a re-delegation made in between', async () => {
      wakeEndsAs(DELEGATION)
      markIs(new Date('2026-10-13T09:30:00.000Z'))
      expect(await recordTurnOutcome(request(DELEGATION))).toEqual({ settled: true })
      expect(handBackDelegation).not.toHaveBeenCalled()
    })

    it('announces the end once even when the compare-and-swap found the mark already changed', async () => {
      wakeEndsAs(DELEGATION)
      markIs(DELEGATED_AT)
      vi.mocked(handBackDelegation).mockResolvedValue(false)
      await recordTurnOutcome(request(DELEGATION))
      // The mark's „Piloti arbeitet" line moved (`piloti-work.ts`), whatever became of the delegation.
      expect(publishToDocumentRoom).toHaveBeenCalledTimes(1)
    })

    it('leaves a mark that is no longer delegated alone', async () => {
      wakeEndsAs(DELEGATION)
      markIs(null)
      await recordTurnOutcome(request(DELEGATION))
      expect(handBackDelegation).not.toHaveBeenCalled()
    })

    it('hands back whatever the outcome was: a failed delegation does not stay on Piloti', async () => {
      wakeEndsAs(DELEGATION)
      markIs(DELEGATED_AT)
      await recordTurnOutcome(request(DELEGATION, { outcome: 'failed', reason: 'model down' }))
      expect(handBackDelegation).toHaveBeenCalledTimes(1)
    })
  })

  it('does not touch the delegation when a mention wake ends', async () => {
    wakeEndsAs(MENTION)
    markIs(DELEGATED_AT)
    await recordTurnOutcome(request(MENTION))
    expect(handBackDelegation).not.toHaveBeenCalled()
    // The room still hears that the wake ended: every reader's thread drops „Piloti antwortet".
    expect(publishToDocumentRoom).toHaveBeenCalledWith(
      DOC_ID,
      expect.objectContaining({ kind: 'annotations.changed', annotationIds: [MARK_ID], change: 'updated' })
    )
  })

  it('tells attention once, with the wake\'s final word', async () => {
    wakeEndsAs(MENTION)
    await recordTurnOutcome(request(MENTION, { outcome: 'handed_off' }))
    expect(onWakeEnded).toHaveBeenCalledTimes(1)
    expect(onWakeEnded).toHaveBeenCalledWith({
      organizationId: ORG,
      documentId: DOC_ID,
      annotationId: MARK_ID,
      annotationNumber: 4,
      projectId: 'proj_1',
      actorUserId: USER,
      trigger: 'thread_mention',
      outcome: 'answered',
      reason: null,
      markText: 'Türbreite prüfen',
    })
  })

  it('tells attention why a failed turn failed, so the notice can say it', async () => {
    wakeEndsAs(MENTION)
    await recordTurnOutcome(request(MENTION, { outcome: 'failed', reason: 'token_expired' }))
    expect(onWakeEnded).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: 'token_expired' }))
  })

  it('still settles when attention throws', async () => {
    wakeEndsAs(MENTION)
    vi.mocked(onWakeEnded).mockRejectedValue(new Error('inbox down'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await recordTurnOutcome(request(MENTION))).toEqual({ settled: true })
    log.mockRestore()
  })

  describe('the audit trail', () => {
    const audited = (): AuditEventInput[] => vi.mocked(recordAuditEvent).mock.calls.map(([input]) => input)
    // The wake's row keeps no email: the event goes out once the directory named the person.
    const recorded = async (): Promise<AuditEventInput[]> => {
      await vi.waitFor(() => expect(recordAuditEvent).toHaveBeenCalled())
      return audited()
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    // Whatever was emitted, WorkOS would accept: every target type and key is registered.
    afterEach(() => {
      for (const [input] of vi.mocked(recordAuditEvent).mock.calls) expectRegistered(input)
    })

    it('records every end once as piloti.wake.ended, as the person whose act woke Piloti', async () => {
      wakeEndsAs(DELEGATION)
      markIs(DELEGATED_AT)
      await recordTurnOutcome(request(DELEGATION, { outcome: 'handed_off' }))

      expect(await recorded()).toEqual([
        {
          action: 'piloti.wake.ended',
          organizationId: ORG,
          actor: { userId: USER, email: 'anna@example.at' },
          targetType: 'document_annotation',
          targetId: MARK_ID,
          alsoTargets: [
            { type: 'document', id: DOC_ID },
            { type: 'project', id: 'proj_1' },
            { type: 'conversation', id: THREAD },
          ],
          metadata: {
            trigger: 'assigned',
            wakeId: DELEGATION.id,
            outcome: 'answered',
            turnOutcome: 'handed_off',
            reason: null,
            reasonKind: null,
            handedBack: true,
            markNumber: 4,
          },
        },
      ])
    })

    it.each([
      ['stopped', undefined, 'stopped', null, null],
      ['refused', 'The organization budget is exhausted.', 'failed', 'The organization budget is exhausted.', 'budget'],
      ['failed', 'token_expired', 'failed', 'token_expired', 'access'],
      ['failed', undefined, 'failed', DEFAULT_FAILURE_REASON, 'error'],
    ] as const)('records a %s turn with its outcome, reason and its class', async (outcome, reason, ended, recordedReason, reasonKind) => {
      wakeEndsAs(MENTION)
      await recordTurnOutcome(request(MENTION, { outcome, reason }))
      await settle()
      expect(await recorded()).toHaveLength(1)
      expect(audited()[0].metadata).toMatchObject({ outcome: ended, turnOutcome: outcome, reason: recordedReason, reasonKind })
    })

    it('cuts a long reason', async () => {
      wakeEndsAs(MENTION)
      await recordTurnOutcome(request(MENTION, { outcome: 'failed', reason: 'x'.repeat(900) }))
      expect(String((await recorded())[0].metadata?.reason)).toHaveLength(200)
    })

    it('names the person by id alone when the directory does not know them', async () => {
      wakeEndsAs(MENTION)
      vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
      await recordTurnOutcome(request(MENTION))
      expect((await recorded())[0].actor).toEqual({ userId: USER, email: null })
    })

    it('records nothing for a turn that is not a wake, a wrong thread, or a wake that already ended', async () => {
      vi.mocked(findWakeById).mockResolvedValue(null)
      await recordTurnOutcome(request(MENTION))
      wakeEndsAs(MENTION)
      await recordTurnOutcome(request(MENTION, { conversationId: documentThreadConversationId(DOC_ID, 'user_bernd') }))
      vi.mocked(findWakeById).mockResolvedValue({ ...MENTION, status: 'answered' })
      await recordTurnOutcome(request(MENTION))
      vi.mocked(findWakeById).mockResolvedValue(MENTION)
      vi.mocked(endWake).mockResolvedValue(null)
      await recordTurnOutcome(request(MENTION))
      await settle()
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    it('still records the end when the document cannot be read, without a project', async () => {
      wakeEndsAs(MENTION)
      vi.mocked(findDocumentInOrg).mockResolvedValue(null)
      await recordTurnOutcome(request(MENTION))
      expect((await recorded())[0].alsoTargets).toContainEqual({ type: 'project', id: null })
      expect(onWakeEnded).not.toHaveBeenCalled()
    })

    it('settles the wake when the trail fails', async () => {
      wakeEndsAs(MENTION)
      vi.mocked(recordAuditEvent).mockRejectedValueOnce(new Error('WorkOS down'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      expect(await recordTurnOutcome(request(MENTION))).toEqual({ settled: true })
      expect(onWakeEnded).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(warn).toHaveBeenCalled())
      warn.mockRestore()
    })
  })
})
