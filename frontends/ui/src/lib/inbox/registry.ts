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

import type { InboxItemType, ShareableResourceType } from '@/lib/db/schema'

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
}

export const INBOX_TYPE_DEFINITIONS: Record<InboxItemType, InboxTypeDefinition> = {
  // A request for your input. Each mention is its own question, so no collapsing,
  // and kept longest: an unanswered request is the most valuable thing here.
  'mention.requested': { actionable: true, grouping: 'per-anchor', retentionDays: 180 },
  // "Your request was answered" — one per answered request.
  'mention.answered': { actionable: false, grouping: 'per-anchor', retentionDays: 60 },
  // "You now have access" — one per resource; re-sharing should not stack.
  'conversation.shared_with_you': { actionable: false, grouping: 'collapse', retentionDays: 60 },
  // Ambient thread activity — the type that MUST collapse, or the inbox is noise.
  'conversation.activity': { actionable: false, grouping: 'collapse', retentionDays: 30 },
}

/** Whether a type is actionable (denormalized onto the row for a cheap count). */
export function inboxItemIsActionable(type: InboxItemType): boolean {
  return INBOX_TYPE_DEFINITIONS[type].actionable
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
  resourceType: ShareableResourceType,
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
