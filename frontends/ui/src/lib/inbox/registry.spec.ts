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
  it('shows every registered type when collaboration is on', () => {
    expect(visibleInboxTypes(true)).toEqual([...INBOX_ITEM_TYPES])
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
      expect(['collaboration', 'operational'], type).toContain(INBOX_TYPE_DEFINITIONS[type].gate)
    }
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
