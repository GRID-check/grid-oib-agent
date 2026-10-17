/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { INBOX_ITEM_TYPES } from '@/lib/db/schema/inbox'
import {
  INBOX_TYPE_DEFINITIONS,
  inboxGroupKey,
  inboxIsReachable,
  inboxItemIsActionable,
  inboxRetentionCutoff,
  MARK_ANCHORED_INBOX_TYPES,
  PROPOSAL_ANCHORED_INBOX_TYPES,
  platformInboxTypes,
  visibleInboxTypes,
} from './registry'

/**
 * The group key is what gives grouping, deduplication and idempotency (one unique
 * index does all three), so these tests are about the two behaviours callers
 * depend on: collapsing types must collapse, and per-anchor types must never
 * collapse by accident.
 */
describe('inboxGroupKey', () => {
  it('collapses a `collapse` type onto one key per resource, anchor or not', () => {
    const withoutAnchor = inboxGroupKey('conversation.activity', 'conversation', 'conv_1')
    const withAnchor = inboxGroupKey('conversation.activity', 'conversation', 'conv_1', 'msg_9')

    expect(withAnchor).toBe(withoutAnchor)
    // Twenty messages in one thread must be able to fold into a single counted row.
    expect(withoutAnchor).toBe('conversation.activity:conversation:conv_1')
  })

  it('keys a `per-anchor` type per anchor, so each mention is its own row', () => {
    const first = inboxGroupKey('mention.requested', 'conversation', 'conv_1', 'msg_1')
    const second = inboxGroupKey('mention.requested', 'conversation', 'conv_1', 'msg_2')

    expect(first).not.toBe(second)
    expect(first).toBe('mention.requested:conversation:conv_1:msg_1')
  })

  it('throws for a `per-anchor` type with no anchor instead of silently collapsing', () => {
    // Collapsing here would drop every mention after the first — a lost request
    // for help, which is the one failure this feature must not have.
    expect(() => inboxGroupKey('mention.requested', 'conversation', 'conv_1')).toThrow(/groups per anchor/)
    expect(() => inboxGroupKey('mention.requested', 'conversation', 'conv_1', null)).toThrow(
      /groups per anchor/,
    )
  })

  it('separates resources and types that share an id', () => {
    expect(inboxGroupKey('mention.answered', 'conversation', 'conv_1', 'msg_1')).not.toBe(
      inboxGroupKey('mention.requested', 'conversation', 'conv_1', 'msg_1'),
    )
  })
})

describe('the registry itself', () => {
  it('has an entry for every item type (the extensibility guarantee)', () => {
    for (const type of INBOX_ITEM_TYPES) {
      expect(INBOX_TYPE_DEFINITIONS[type]).toBeDefined()
    }
    expect(Object.keys(INBOX_TYPE_DEFINITIONS).sort()).toEqual([...INBOX_ITEM_TYPES].sort())
  })

  it('marks mention requests actionable and everything else informational', () => {
    expect(inboxItemIsActionable('mention.requested')).toBe(true)
    expect(inboxItemIsActionable('mention.answered')).toBe(false)
    expect(inboxItemIsActionable('conversation.shared_with_you')).toBe(false)
    expect(inboxItemIsActionable('conversation.activity')).toBe(false)
  })

  it('derives a retention cutoff in the past, per type', () => {
    const now = new Date('2026-07-29T12:00:00.000Z')

    // An unanswered request is the most valuable row here, so it is kept longest.
    expect(inboxRetentionCutoff('mention.requested', now).toISOString()).toBe(
      '2026-01-30T12:00:00.000Z',
    )
    expect(inboxRetentionCutoff('conversation.activity', now).getTime()).toBeGreaterThan(
      inboxRetentionCutoff('mention.requested', now).getTime(),
    )
  })
})

/**
 * The per-type feature gate (ADR-0042).
 *
 * The requirement is not merely "the storage alert is visible without
 * collaboration" — it is that the gate is a PROPERTY OF THE REGISTRY ENTRY, so
 * registering a second operational type needs no second edit anywhere. These
 * tests are therefore written against the registry's own `gate` fields rather
 * than against a literal list of type names: a hardcoded exemption list in
 * `visibleInboxTypes` would pass a name-based test and fail these.
 */
describe('visibleInboxTypes — the gate is registry-driven, not a hardcoded list', () => {
  it('shows every tenant type when collaboration is on — never a platform one', () => {
    const tenantTypes = INBOX_ITEM_TYPES.filter(
      (type) => INBOX_TYPE_DEFINITIONS[type].gate !== 'platform',
    )
    expect(visibleInboxTypes(true)).toEqual(tenantTypes)
  })

  it('shows exactly the types the REGISTRY marks operational when collaboration is off', () => {
    // Derived from the registry on both sides. If someone re-implemented the
    // gate as `['storage.quota_warning']` at a call site, adding a second
    // operational type would break this without touching the test.
    const expected = INBOX_ITEM_TYPES.filter(
      (type) => INBOX_TYPE_DEFINITIONS[type].gate === 'operational',
    )

    expect(visibleInboxTypes(false)).toEqual(expected)
    expect(expected.length).toBeGreaterThan(0)
  })

  it('hides every collaboration type when collaboration is off', () => {
    const visible = new Set(visibleInboxTypes(false))
    for (const type of INBOX_ITEM_TYPES) {
      if (INBOX_TYPE_DEFINITIONS[type].gate === 'collaboration') {
        expect(visible.has(type), `${type} is gated on collaboration and must be hidden`).toBe(false)
      }
    }
  })

  it('gives every registered type a gate — a new type cannot ship ungated', () => {
    // The registry is exhaustive over `InboxItemType` by construction, so this
    // asserts the FIELD is populated with a meaningful value rather than that
    // the key exists.
    for (const type of INBOX_ITEM_TYPES) {
      expect(['collaboration', 'operational', 'platform'], type).toContain(
        INBOX_TYPE_DEFINITIONS[type].gate,
      )
    }
  })
})

/**
 * Platform types live in the platform organization's rows and reach a reader
 * only through the platform lane (`./service`). The tenant lane and the
 * platform lane must never overlap, or a platform owner whose ACTIVE
 * organization is the platform organization would see every row twice.
 */
describe('platformInboxTypes — the platform lane is disjoint from every tenant lane', () => {
  it('is exactly the types the registry gates on the platform', () => {
    expect(platformInboxTypes()).toEqual(
      INBOX_ITEM_TYPES.filter((type) => INBOX_TYPE_DEFINITIONS[type].gate === 'platform'),
    )
    expect(platformInboxTypes()).toContain('feedback.submitted')
  })

  it('shares no type with a tenant lane, collaboration on or off', () => {
    for (const collaboration of [true, false]) {
      const tenant = new Set(visibleInboxTypes(collaboration))
      for (const type of platformInboxTypes()) {
        expect(tenant.has(type), `${type} leaked into a tenant lane`).toBe(false)
      }
    }
  })
})

/**
 * Every type states its email default (spec IB-5, IB-11) even though nothing
 * sends mail yet — so the day a sender exists, no type mails by accident.
 */
describe('email defaults', () => {
  it('gives every type an explicit email decision with a sane delay', () => {
    for (const type of INBOX_ITEM_TYPES) {
      const { email } = INBOX_TYPE_DEFINITIONS[type]
      expect(['never', 'if-unread'], type).toContain(email.send)
      if (email.send === 'if-unread') {
        expect(email.afterMinutes, type).toBeGreaterThanOrEqual(0)
        expect(email.afterMinutes, type).toBeLessThanOrEqual(7 * 24 * 60)
      }
    }
  })

  it('keeps ambient activity in-app only — the type that would make our mail noise', () => {
    expect(INBOX_TYPE_DEFINITIONS['conversation.activity'].email).toEqual({ send: 'never' })
  })
})

describe('inboxIsReachable', () => {
  it('is true without collaboration, because an operational type is registered', () => {
    // This is what un-gates the inbox nav entry, page and badge for a tenant
    // that never bought a chat feature but can still fill its disk.
    expect(inboxIsReachable(false)).toBe(true)
    expect(inboxIsReachable(true)).toBe(true)
  })

  it('is a derivation of the registry, not a constant', () => {
    // Written as `visibleInboxTypes(x).length > 0` so that removing the last
    // operational type puts the inbox back behind the collaboration flag by
    // itself, instead of leaving a page that renders a permanently empty list.
    expect(inboxIsReachable(false)).toBe(visibleInboxTypes(false).length > 0)
    expect(inboxIsReachable(true)).toBe(visibleInboxTypes(true).length > 0)
  })
})

/**
 * What Piloti's work on marks and proposals puts in the inbox (ADR-0105, ADR-0106).
 * The asks are requests against a person and wait in the badge until settled;
 * the reports are not.
 */
describe('the Piloti types', () => {
  const asks = ['piloti.asks_you', 'piloti.proposal_waiting'] as const
  const reports = ['piloti.work_done', 'piloti.work_failed'] as const

  it('count in the badge only while a person has something to decide', () => {
    for (const type of asks) expect(inboxItemIsActionable(type), type).toBe(true)
    for (const type of reports) expect(inboxItemIsActionable(type), type).toBe(false)
  })

  it('are one row per mark or proposal, never collapsed', () => {
    for (const type of [...asks, ...reports]) {
      expect(INBOX_TYPE_DEFINITIONS[type].grouping, type).toBe('per-anchor')
      expect(() => inboxGroupKey(type, 'document', 'doc_1'), type).toThrow(/groups per anchor/)
    }
    expect(inboxGroupKey('piloti.asks_you', 'document', 'doc_1', 'ann_1')).not.toBe(
      inboxGroupKey('piloti.asks_you', 'document', 'doc_1', 'ann_2'),
    )
  })

  it('stay visible to an office without collaboration: marks are not a chat feature', () => {
    for (const type of [...asks, ...reports]) {
      expect(visibleInboxTypes(false), type).toContain(type)
    }
  })

  it('name the types whose anchor is a mark or a proposal, and only those', () => {
    expect([...MARK_ANCHORED_INBOX_TYPES].sort()).toEqual([
      'annotation.activity',
      'annotation.assigned_to_you',
      'piloti.asks_you',
      'piloti.work_done',
      'piloti.work_failed',
    ])
    expect(PROPOSAL_ANCHORED_INBOX_TYPES).toEqual(['piloti.proposal_waiting'])
  })
})

/**
 * What a colleague's work on a mark puts in the inbox: being made responsible
 * is a request that waits in the badge; a reply or a closed mark is news.
 */
describe('the Anmerkung types', () => {
  it('ask the Zuständige: actionable, one row per mark, mailed after two hours unread, pushed as a request', () => {
    const assigned = INBOX_TYPE_DEFINITIONS['annotation.assigned_to_you']
    expect(assigned).toMatchObject({
      actionable: true,
      grouping: 'per-anchor',
      gate: 'operational',
      email: { send: 'if-unread', afterMinutes: 120 },
      push: { category: 'requests', urgency: 'normal' },
    })
  })

  it('tell the thread: informational, one counted row per mark, never mailed, pushed only as activity', () => {
    const activity = INBOX_TYPE_DEFINITIONS['annotation.activity']
    expect(activity).toMatchObject({
      actionable: false,
      grouping: 'per-anchor',
      gate: 'operational',
      email: { send: 'never' },
      push: { category: 'activity' },
    })
    expect(inboxGroupKey('annotation.activity', 'document', 'doc_1', 'ann_1')).toBe(
      'annotation.activity:document:doc_1:ann_1',
    )
  })

  it('stay visible to an office without collaboration: marks are not a chat feature', () => {
    expect(visibleInboxTypes(false)).toEqual(
      expect.arrayContaining(['annotation.assigned_to_you', 'annotation.activity']),
    )
  })
})
