/**
 * Server-side inbox item-type registry (ADR-0035, spec IB-5…IB-7).
 *
 * This half owns the facts that decide what gets WRITTEN: whether a type is
 * actionable, how its group key is built (and therefore whether occurrences
 * collapse), and how long it is kept. The client-side half
 * (`./types`'s `INBOX_TYPE_PRESENTATION`) owns only how a row LOOKS.
 *
 * Both are `Record<InboxItemType, …>`, so adding a type to the union without
 * registering it in BOTH fails `tsc`. That is the whole extensibility guarantee:
 * a new notification kind is a registry entry plus translations, never a schema
 * change and never a new component.
 */

import { INBOX_ITEM_TYPES, type InboxItemType, type InboxTargetType } from '@/lib/db/schema'

/**
 * Which product gate a type lives behind.
 *
 * `collaboration` types only exist because the collaboration feature does, and
 * they stay behind its flag (ADR-0032…0035, spec NF-8).
 *
 * `operational` types are the platform telling the tenant something about its
 * own account — a filling disk, and whatever joins it later. Gating those on
 * collaboration would mean the warning silently never fires for a tenant that
 * has not bought a chat feature, which is the opposite of what an operational
 * alert is for. So the gate is a property OF THE TYPE, checked by the read path,
 * rather than a guard on the route: a hardcoded list of exceptions at the route
 * would drift the moment a second operational type is registered.
 */
export type InboxTypeGate = 'collaboration' | 'operational'

export interface InboxTypeDefinition {
  /**
   * Actionable items represent an outstanding request against the recipient: they
   * can be RESOLVED by a domain event, and they are what the badge counts.
   * Informational items are read and archived.
   */
  readonly actionable: boolean
  /**
   * Whether occurrences collapse into one counted row.
   *   - `collapse` — one row per (recipient, resource). Twenty new messages in a
   *     thread become one row with count 20 (spec CC-20, IB-8).
   *   - `per-anchor` — one row per (recipient, resource, anchor). Each mention
   *     deserves its own row because each is a separate question.
   */
  readonly grouping: 'collapse' | 'per-anchor'
  /** Days after creation the item may be pruned (spec IB-15). */
  readonly retentionDays: number
  /** Which feature gate this type lives behind. See {@link InboxTypeGate}. */
  readonly gate: InboxTypeGate
}

export const INBOX_TYPE_DEFINITIONS: Record<InboxItemType, InboxTypeDefinition> = {
  // A request for your input. Each mention is its own question, so no collapsing,
  // and kept longest: an unanswered request is the most valuable thing here.
  'mention.requested': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 180,
    gate: 'collaboration',
  },
  // "Your request was answered" — one per answered request.
  'mention.answered': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'collaboration',
  },
  // "You now have access" — one per resource; re-sharing should not stack.
  'conversation.shared_with_you': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 60,
    gate: 'collaboration',
  },
  // Ambient thread activity — the type that MUST collapse, or the inbox is noise.
  'conversation.activity': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 30,
    gate: 'collaboration',
  },
  /*
    Storage pressure (ADR-0042). `per-anchor` rather than `collapse`, and the
    anchor is the THRESHOLD BUCKET that was crossed — see the storage-alert
    service for why. Informational rather than actionable: the recipient is not
    holding up a request, and an actionable row would sit in the badge until
    somebody deleted files, which is not a thing the inbox can resolve.

    Retention is short because the row states a CURRENT condition. A three-month
    -old "storage is 80% full" is not history worth keeping — it is a claim that
    may well be false by the time anyone reads it.
  */
  'storage.quota_warning': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
  },
}

/** Whether a type is actionable (denormalized onto the row for a cheap count). */
export function inboxItemIsActionable(type: InboxItemType): boolean {
  return INBOX_TYPE_DEFINITIONS[type].actionable
}

/**
 * The types a reader may see, given whether collaboration is on for them.
 *
 * The ONE place the per-type gate is applied. Both the list and the badge count
 * filter on this in SQL, so a tenant without collaboration sees an inbox that
 * contains its operational alerts and nothing else — rather than a 403, which is
 * what made the storage warning unreachable for exactly the deployments most
 * likely to need it.
 *
 * Derived from the registry rather than listed here, so registering a second
 * operational type is a one-line change with no second place to remember.
 */
export function visibleInboxTypes(collaborationEnabled: boolean): InboxItemType[] {
  return INBOX_ITEM_TYPES.filter(
    (type) => collaborationEnabled || INBOX_TYPE_DEFINITIONS[type].gate === 'operational',
  )
}

/**
 * Whether the inbox surfaces (page, nav entry, badge) exist for this reader.
 *
 * True whenever ANY type is visible to them — which today means always, because
 * the registry carries an operational type. Written as a derivation rather than
 * `true` so that removing the last operational type puts the inbox back behind
 * the collaboration flag automatically, instead of leaving a page that renders
 * a permanently empty list.
 */
export function inboxIsReachable(collaborationEnabled: boolean): boolean {
  return visibleInboxTypes(collaborationEnabled).length > 0
}

/**
 * Build the grouping/dedup/idempotency key for an emission.
 *
 * ALWAYS use this rather than composing a key by hand: the unique index on
 * `(recipient_user_id, group_key)` is what gives grouping, deduplication and
 * idempotency, and a hand-rolled key silently opts out of all three.
 */
export function inboxGroupKey(
  type: InboxItemType,
  resourceType: InboxTargetType,
  resourceId: string,
  anchorId?: string | null,
): string {
  const definition = INBOX_TYPE_DEFINITIONS[type]
  const base = `${type}:${resourceType}:${resourceId}`
  if (definition.grouping === 'collapse') return base
  // `per-anchor` without an anchor would collapse by accident, which would drop
  // every mention after the first. Fail loudly instead of losing notifications.
  if (!anchorId) {
    throw new Error(`[inbox] type "${type}" groups per anchor but no anchorId was supplied`)
  }
  return `${base}:${anchorId}`
}

/** Retention cutoff for a type, as an absolute date. */
export function inboxRetentionCutoff(type: InboxItemType, now = new Date()): Date {
  const days = INBOX_TYPE_DEFINITIONS[type].retentionDays
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}
