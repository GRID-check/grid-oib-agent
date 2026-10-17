/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(),
  resolveInboxItemsAnchoredOn: vi.fn(),
  markInboxItemsInertAnchoredOn: vi.fn(),
}))
vi.mock('./repository', () => ({ findDocumentAnnotation: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({ describeResource: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({
  getTenantContext: vi.fn(),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
}))

import { getTenantContext, withTenant } from '@/lib/db/tenant-context'
import type { InboxEmission } from '@/lib/inbox/service'
import { emitInboxItems, markInboxItemsInertAnchoredOn, resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import { MARK_ANCHORED_INBOX_TYPES } from '@/lib/inbox/registry'
import { describeResource } from '@/lib/sharing/registry'
import {
  markAuthor,
  markParticipants,
  onAssigneeChanged,
  onMarkDeleted,
  onMarkMoved,
  onMarkReplied,
  onMarkSettledByPerson,
  onPilotiWrote,
  onWakeEnded,
  type MarkPeople,
  type MarkRef,
  type MayOpen,
} from './attention'
import { findDocumentAnnotation, type AnnotationRecord } from './repository'

const ref: MarkRef = {
  organizationId: 'org_1',
  documentId: 'doc_1',
  annotationId: 'ann_1',
  annotationNumber: 4,
  projectId: 'proj_1',
}

function mark(overrides: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return {
    id: 'ann_1',
    kind: 'question',
    authorKind: 'piloti',
    status: 'open',
    body: 'Ist die Brüstungshöhe hier 1,00 m?',
    replies: [],
    ...overrides,
  } as AnnotationRecord
}

/** The one emission the call made. */
function emitted(): InboxEmission {
  expect(emitInboxItems).toHaveBeenCalledTimes(1)
  const [emissions] = vi.mocked(emitInboxItems).mock.calls[0]
  expect(emissions).toHaveLength(1)
  return emissions[0]
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getTenantContext).mockReturnValue({ kind: 'tenant', organizationId: 'org_1', userId: 'user_me' })
  vi.mocked(withTenant).mockImplementation(async (_scope, fn) => await fn())
  vi.mocked(describeResource).mockReturnValue({
    describeRef: vi.fn().mockResolvedValue({ title: 'Grundriss EG.pdf' }),
  } as never)
  vi.mocked(emitInboxItems).mockResolvedValue(1)
  vi.mocked(resolveInboxItemsAnchoredOn).mockResolvedValue(1)
  vi.mocked(markInboxItemsInertAnchoredOn).mockResolvedValue(1)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('onWakeEnded', () => {
  const wake = { ...ref, actorUserId: 'user_me' }

  it('tells who delegated a mark that Piloti is done with it', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered' })

    expect(emitted()).toMatchObject({
      organizationId: 'org_1',
      recipientUserId: 'user_me',
      type: 'piloti.work_done',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ann_1',
      groupKey: 'piloti.work_done:document:doc_1:ann_1',
      payload: { subject: 'Grundriss EG.pdf', related: '4' },
    })
  })

  it('tells who delegated a mark that Piloti could not work it', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'failed' })

    expect(emitted()).toMatchObject({ type: 'piloti.work_failed', recipientUserId: 'user_me', anchorId: 'ann_1' })
  })

  it('quotes what the mark says, on one line, so the person knows which one it was', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered', markText: '  Türbreite\n prüfen ' })

    expect(emitted().payload).toEqual({
      subject: 'Grundriss EG.pdf',
      related: '4',
      excerpt: 'Türbreite prüfen',
      variant: 'assigned',
    })
  })

  it.each([
    ['budget: The user LLM budget is exhausted. An org admin can raise limits under Organization → Usage & budgets.', 'budget'],
    ['The assistant is busy right now. Please send your message again in a moment.', 'busy'],
    ['token_expired', 'access'],
    ['the turn ended without an answer', 'error'],
    [null, 'error'],
  ] as const)('names why it failed („%s“ is %s), never the stored reason itself', async (reason, variant) => {
    await onWakeEnded({ ...wake, trigger: 'thread_mention', outcome: 'failed', reason })

    const payload = emitted().payload
    expect(payload).toMatchObject({ variant })
    expect(JSON.stringify(payload)).not.toContain('token_expired')
    expect(JSON.stringify(payload)).not.toContain('budget is exhausted')
  })

  it('names what woke Piloti on work that was done, never a cause, so a delegation’s end says the mark is back', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered', reason: 'ignored' })

    expect(emitted().payload).toMatchObject({ variant: 'assigned' })
  })

  it.each(['thread_mention', 'thread_reply'] as const)(
    'names the trigger (%s) on work done, so a folded row never keeps an earlier variant',
    async (trigger) => {
      await onWakeEnded({ ...wake, trigger, outcome: 'answered' })

      expect(emitted().payload).toMatchObject({ variant: trigger })
    },
  )

  it.each(['thread_mention', 'thread_reply'] as const)('tells who asked (%s) when Piloti answered', async (trigger) => {
    await onWakeEnded({ ...wake, trigger, outcome: 'answered' })

    expect(emitted()).toMatchObject({ type: 'piloti.work_done', recipientUserId: 'user_me' })
  })

  it.each(['thread_mention', 'thread_reply'] as const)(
    'tells who asked (%s) when Piloti could not answer',
    async (trigger) => {
      await onWakeEnded({ ...wake, trigger, outcome: 'failed' })

      expect(emitted()).toMatchObject({
        type: 'piloti.work_failed',
        recipientUserId: 'user_me',
        anchorId: 'ann_1',
        actorUserId: null,
        groupKey: 'piloti.work_failed:document:doc_1:ann_1',
        payload: { subject: 'Grundriss EG.pdf', related: '4', variant: 'error' },
      })
    },
  )

  it.each(['assigned', 'thread_mention', 'thread_reply'] as const)(
    'stays quiet when the person stopped it (%s)',
    async (trigger) => {
      await onWakeEnded({ ...wake, trigger, outcome: 'stopped' })

      expect(emitInboxItems).not.toHaveBeenCalled()
    },
  )

  it('carries no actor, so the person is told about Piloti’s work and not dropped as their own act', async () => {
    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered' })

    expect(emitted().actorUserId).toBeNull()
  })

  it('names no file when the document cannot be described, and still tells', async () => {
    vi.mocked(describeResource).mockReturnValue({ describeRef: vi.fn().mockRejectedValue(new Error('gone')) } as never)

    await onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered' })

    expect(emitted().payload).toEqual({ related: '4', variant: 'assigned' })
  })

  it('never throws into the turn when the inbox write fails', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('database down'))

    await expect(onWakeEnded({ ...wake, trigger: 'assigned', outcome: 'answered' })).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalled()
  })
})

describe('onPilotiWrote', () => {
  const write = { ...ref, onBehalfOf: 'user_me', assigneeUserId: null, replyId: null }

  it('asks the person the turn acted for when Piloti sets a Rückfrage nobody is responsible for', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark({ status: 'proposed' }))

    await onPilotiWrote({ ...write, what: 'question' })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_me',
      type: 'piloti.asks_you',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ann_1',
      actorUserId: null,
      groupKey: 'piloti.asks_you:document:doc_1:ann_1',
      payload: { subject: 'Grundriss EG.pdf', related: '4', excerpt: 'Ist die Brüstungshöhe hier 1,00 m?' },
    })
  })

  it('asks the responsible person instead when the mark has one', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark())

    await onPilotiWrote({ ...write, what: 'question', assigneeUserId: 'user_zustaendig' })

    expect(emitted().recipientUserId).toBe('user_zustaendig')
  })

  it('quotes the reply, not the mark, when Piloti follows up in the thread', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(
      mark({ replies: [{ id: 'reply_1', body: 'Und die Absturzsicherung?' } as AnnotationRecord['replies'][number]] }),
    )

    await onPilotiWrote({ ...write, what: 'reply', replyId: 'reply_1' })

    expect(emitted()).toMatchObject({ type: 'piloti.asks_you', payload: { excerpt: 'Und die Absturzsicherung?' } })
  })

  it('cuts a long question to a line', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark({ body: `Frage\n${'sehr lang '.repeat(60)}` }))

    await onPilotiWrote({ ...write, what: 'question' })

    const excerpt = emitted().payload?.excerpt as string
    expect(excerpt.length).toBeLessThanOrEqual(160)
    expect(excerpt).not.toContain('\n')
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('says nothing about an ordinary mark', async () => {
    await onPilotiWrote({ ...write, what: 'mark' })

    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(findDocumentAnnotation).not.toHaveBeenCalled()
  })

  it.each([
    ['a reply on a Hinweis', { kind: 'hint' as const }],
    ['a reply on a Mangel', { kind: 'defect' as const }],
    ['an answer to a person’s own Rückfrage', { authorKind: 'person' as const }],
    ['a reply on a resolved Rückfrage', { status: 'resolved' as const }],
    ['a reply on a dismissed Rückfrage', { status: 'dismissed' as const }],
  ])('says nothing for %s: it waits on nobody', async (_name, overrides) => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark(overrides))

    await onPilotiWrote({ ...write, what: 'reply', replyId: 'reply_1' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing when the mark is gone by now', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue(null)

    await onPilotiWrote({ ...write, what: 'question' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('never throws into the turn when the mark cannot be read or the inbox write fails', async () => {
    vi.mocked(findDocumentAnnotation).mockRejectedValueOnce(new Error('database down'))
    await expect(onPilotiWrote({ ...write, what: 'question' })).resolves.toBeUndefined()

    vi.mocked(findDocumentAnnotation).mockResolvedValue(mark())
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('database down'))
    await expect(onPilotiWrote({ ...write, what: 'question' })).resolves.toBeUndefined()
  })
})

describe('onMarkSettledByPerson', () => {
  const settle = { organizationId: 'org_1', annotationId: 'ann_1' }

  it('resolves the Rückfrage for everyone once any person answered it: one answer answers it', async () => {
    await onMarkSettledByPerson({ ...settle, closed: false })

    const [input] = vi.mocked(resolveInboxItemsAnchoredOn).mock.calls[0]
    expect(input).toEqual({ organizationId: 'org_1', types: ['piloti.asks_you'], anchorId: 'ann_1' })
    expect(input).not.toHaveProperty('recipientUserId')
  })

  it('resolves the Rückfrage and the Zuständige’s row for everyone once the mark is closed', async () => {
    await onMarkSettledByPerson({ ...settle, closed: true })

    const [input] = vi.mocked(resolveInboxItemsAnchoredOn).mock.calls[0]
    expect(input).toEqual({
      organizationId: 'org_1',
      types: ['piloti.asks_you', 'annotation.assigned_to_you'],
      anchorId: 'ann_1',
    })
    expect(input).not.toHaveProperty('recipientUserId')
  })

  it('never throws into the write that settled it', async () => {
    vi.mocked(resolveInboxItemsAnchoredOn).mockRejectedValue(new Error('database down'))

    await expect(onMarkSettledByPerson({ ...settle, closed: true })).resolves.toBeUndefined()
  })
})

describe('the tenant scope of the write', () => {
  it('keeps the caller’s own when there is one', async () => {
    await onMarkSettledByPerson({ organizationId: 'org_1', annotationId: 'ann_1', closed: true })

    expect(withTenant).not.toHaveBeenCalled()
  })

  it('states the event’s organization when the caller has none, because inbox_items is behind RLS', async () => {
    vi.mocked(getTenantContext).mockReturnValue(undefined)

    await onMarkSettledByPerson({ organizationId: 'org_1', annotationId: 'ann_1', closed: true })

    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalled()
  })
})

/** A mark's people, as the thread reads them. */
function people(overrides: Partial<MarkPeople & Pick<AnnotationRecord, 'kind' | 'status'>> = {}) {
  return {
    authorKind: 'person' as const,
    createdBy: 'user_author',
    acceptedBy: null,
    assigneeUserId: null,
    delegatedBy: null,
    replies: [],
    kind: 'defect' as const,
    status: 'open' as const,
    ...overrides,
  }
}

/** Everyone may open the document, unless a test says who may not. */
const everyone: MayOpen = async (userIds) => new Set(userIds)
const allBut =
  (...hidden: string[]): MayOpen =>
  async (userIds) =>
    new Set(userIds.filter((userId) => !hidden.includes(userId)))

/** Who the one emission went to. */
function recipients(): string[] {
  expect(emitInboxItems).toHaveBeenCalledTimes(1)
  return vi.mocked(emitInboxItems).mock.calls[0][0].map((emission) => emission.recipientUserId)
}

describe('markParticipants', () => {
  it('is the author, the Zuständige, who delegated and every person who replied, once each', () => {
    const mark = people({
      assigneeUserId: 'user_zustaendig',
      delegatedBy: 'user_delegator',
      replies: [
        { authorKind: 'person', createdBy: 'user_replier' },
        { authorKind: 'person', createdBy: 'user_author' },
        { authorKind: 'piloti', createdBy: 'user_asker' },
      ],
    })

    expect(markParticipants(mark)).toEqual(['user_author', 'user_zustaendig', 'user_delegator', 'user_replier'])
  })

  it('takes the person who took Piloti’s mark over as its author, and nobody for an untaken proposal', () => {
    expect(markAuthor(people({ authorKind: 'piloti', createdBy: 'user_asker', acceptedBy: 'user_taker' }))).toBe('user_taker')
    expect(markParticipants(people({ authorKind: 'piloti', createdBy: 'user_asker', acceptedBy: null }))).toEqual([])
  })
})

describe('onAssigneeChanged', () => {
  const act = { ...ref, actorUserId: 'user_anna', byPiloti: false, markText: 'Tür  T30\nfehlt', open: true }

  it('asks the new Zuständige, named by who did it, quoting the mark', async () => {
    await onAssigneeChanged({ ...act, previousAssigneeUserId: null, assigneeUserId: 'user_bob' })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_bob',
      type: 'annotation.assigned_to_you',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ann_1',
      actorUserId: 'user_anna',
      groupKey: 'annotation.assigned_to_you:document:doc_1:ann_1',
      payload: { subject: 'Grundriss EG.pdf', related: '4', excerpt: 'Tür T30 fehlt', variant: 'person' },
    })
    expect(resolveInboxItemsAnchoredOn).not.toHaveBeenCalled()
  })

  it('says Piloti did it for the asker when Piloti changed the mark', async () => {
    await onAssigneeChanged({ ...act, byPiloti: true, previousAssigneeUserId: null, assigneeUserId: 'user_bob' })

    expect(emitted()).toMatchObject({ actorUserId: 'user_anna', payload: { variant: 'piloti' } })
  })

  it('tells nobody when a person makes themselves responsible', async () => {
    await onAssigneeChanged({ ...act, previousAssigneeUserId: null, assigneeUserId: 'user_anna' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('tells nobody about a mark that is not open: a proposal is nobody’s yet, a closed mark nobody’s to do', async () => {
    await onAssigneeChanged({ ...act, open: false, previousAssigneeUserId: null, assigneeUserId: 'user_bob' })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('settles the previous Zuständige’s row, and only theirs, when someone else takes it on', async () => {
    await onAssigneeChanged({ ...act, previousAssigneeUserId: 'user_carol', assigneeUserId: 'user_bob' })

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: ['annotation.assigned_to_you'],
      anchorId: 'ann_1',
      recipientUserId: 'user_carol',
    })
    expect(recipients()).toEqual(['user_bob'])
  })

  it('settles the previous one’s row when nobody is responsible any more', async () => {
    await onAssigneeChanged({ ...act, previousAssigneeUserId: 'user_carol', assigneeUserId: null })

    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: 'user_carol' }))
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('never throws into the write when the inbox is down', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('database down'))

    await expect(
      onAssigneeChanged({ ...act, previousAssigneeUserId: null, assigneeUserId: 'user_bob' }),
    ).resolves.toBeUndefined()
  })
})

describe('onMarkReplied', () => {
  const reply = { ...ref, actorUserId: 'user_replier', byPiloti: false, markText: 'Tür T30 fehlt', replyText: 'Ist bestellt.' }
  const thread = people({
    assigneeUserId: 'user_zustaendig',
    delegatedBy: 'user_delegator',
    replies: [{ authorKind: 'person', createdBy: 'user_replier' }],
  })

  it('tells every participant but the one who replied, one counted row per mark, quoting the reply', async () => {
    await onMarkReplied({ ...reply, mark: thread, mayOpen: everyone })

    expect(recipients()).toEqual(['user_author', 'user_zustaendig', 'user_delegator'])
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0]).toMatchObject({
      type: 'annotation.activity',
      actorUserId: 'user_replier',
      anchorId: 'ann_1',
      groupKey: 'annotation.activity:document:doc_1:ann_1',
      payload: { subject: 'Grundriss EG.pdf', related: '4', excerpt: 'Ist bestellt.', variant: 'reply' },
    })
  })

  it('says to the mark’s author alone that the reply is on their mark, so it reaches them as an answer', async () => {
    await onMarkReplied({ ...reply, mark: thread, mayOpen: everyone })

    const rows = vi.mocked(emitInboxItems).mock.calls[0][0]
    const yours = Object.fromEntries(rows.map((row) => [row.recipientUserId, (row.payload as { yours?: boolean }).yours ?? false]))
    expect(yours).toEqual({ user_author: true, user_zustaendig: false, user_delegator: false })
  })

  it('tells nobody who may not open the document now', async () => {
    await onMarkReplied({ ...reply, mark: thread, mayOpen: allBut('user_delegator') })

    expect(recipients()).toEqual(['user_author', 'user_zustaendig'])
  })

  it('leaves out the person Piloti’s turn acted for, who woke it and hears that Piloti is done', async () => {
    await onMarkReplied({ ...reply, actorUserId: 'user_delegator', byPiloti: true, mark: thread, mayOpen: everyone })

    expect(recipients()).toEqual(['user_author', 'user_zustaendig', 'user_replier'])
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0].actorUserId).toBeNull()
  })

  it('leaves out the Zuständige Piloti’s open Rückfrage asks: they have that row', async () => {
    const question = { ...thread, authorKind: 'piloti' as const, acceptedBy: 'user_author', kind: 'question' as const }

    await onMarkReplied({ ...reply, actorUserId: 'user_delegator', byPiloti: true, mark: question, mayOpen: everyone })

    expect(recipients()).toEqual(['user_author', 'user_replier'])
  })

  it('tells nobody when nobody else takes part', async () => {
    await onMarkReplied({ ...reply, actorUserId: 'user_author', mark: people(), mayOpen: everyone })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('onMarkMoved', () => {
  const move = { ...ref, actorUserId: 'user_bob', byPiloti: false, markText: 'Tür T30 fehlt', mayOpen: everyone }

  it.each(['resolved', 'dismissed', 'reopened'] as const)('tells the author someone else %s their mark', async (moved) => {
    await onMarkMoved({ ...move, move: moved, mark: people() })

    expect(emitted()).toMatchObject({
      recipientUserId: 'user_author',
      type: 'annotation.activity',
      actorUserId: 'user_bob',
      payload: { related: '4', excerpt: 'Tür T30 fehlt', variant: moved, yours: true },
    })
  })

  it('tells the person who took Piloti’s mark over, as its author', async () => {
    await onMarkMoved({ ...move, move: 'resolved', mark: people({ authorKind: 'piloti', acceptedBy: 'user_taker' }) })

    expect(recipients()).toEqual(['user_taker'])
  })

  it('tells nobody when the author did it, a proposal nobody took over moved, or the author may not open it', async () => {
    await onMarkMoved({ ...move, actorUserId: 'user_author', move: 'resolved', mark: people() })
    await onMarkMoved({ ...move, move: 'dismissed', mark: people({ authorKind: 'piloti', acceptedBy: null }) })
    await onMarkMoved({ ...move, move: 'resolved', mark: people(), mayOpen: allBut('user_author') })

    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('onMarkDeleted', () => {
  it('turns every row anchored on the mark inert, for everyone', async () => {
    await onMarkDeleted({ organizationId: 'org_1', annotationId: 'ann_1' })

    expect(markInboxItemsInertAnchoredOn).toHaveBeenCalledWith({
      organizationId: 'org_1',
      types: MARK_ANCHORED_INBOX_TYPES,
      anchorId: 'ann_1',
    })
    expect(MARK_ANCHORED_INBOX_TYPES).toEqual(
      expect.arrayContaining(['piloti.asks_you', 'annotation.assigned_to_you', 'annotation.activity']),
    )
  })

  it('never throws into the delete', async () => {
    vi.mocked(markInboxItemsInertAnchoredOn).mockRejectedValue(new Error('database down'))

    await expect(onMarkDeleted({ organizationId: 'org_1', annotationId: 'ann_1' })).resolves.toBeUndefined()
  })
})
