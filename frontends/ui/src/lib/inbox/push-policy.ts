/**
 * Whether an inbox item is pushed to a person's devices, and how (ADR-0112).
 * The sibling of `./delivery`, which does the same for email.
 *
 * Pure functions over a type, a row and a person's choices. The registry says
 * which category a type belongs to and how urgent it is; the person says which
 * categories they want; the row says whether it is still worth a notification.
 * Nothing here knows about subscriptions, VAPID or the queue.
 */

import type { InboxItem } from '@/lib/db/schema'
import { INBOX_ITEM_TYPES, type InboxItemType } from '@/lib/db/schema'
import type { PushCategory, PushPreferences, PushUrgency } from './push-categories'
import { INBOX_TYPE_DEFINITIONS, type InboxPushPolicy } from './registry'

/**
 * The registry's push policy for a type.
 *
 * `type` is a `text` column, so a row from a newer deploy can carry a value
 * this build does not know. Unknown means not pushed: a notification this build
 * could not word would say nothing, or something wrong.
 */
export function pushPolicyFor(type: string): InboxPushPolicy | null {
  return (INBOX_ITEM_TYPES as readonly string[]).includes(type)
    ? INBOX_TYPE_DEFINITIONS[type as InboxItemType].push
    : null
}

/**
 * The category one item is pushed under: its type's, or the type's `yours`
 * category when the item is about the recipient's own thing (`payload.yours`,
 * set by the emitter for that recipient alone). Null for an unknown type.
 */
export function pushCategoryOf(type: string, payload?: unknown): PushCategory | null {
  const policy = pushPolicyFor(type)
  if (!policy) return null
  const yours = typeof payload === 'object' && payload !== null && (payload as { yours?: unknown }).yours === true
  return yours && policy.yours ? policy.yours : policy.category
}

/** Whether this person wants a push for this item: its category is on. */
export function isPushWanted(type: string, preferences: PushPreferences, payload?: unknown): boolean {
  const category = pushCategoryOf(type, payload)
  return category !== null && preferences.categories[category]
}

/** The row facts the "still worth a notification" decision reads. */
export type InboxPushCandidate = Pick<InboxItem, 'type' | 'readAt' | 'archivedAt' | 'resolvedAt' | 'inertAt'>

/**
 * Whether the row is still news. Every state that means "the recipient has dealt
 * with it, or may no longer see it" cancels the notification, as it cancels the
 * email: read, archived, resolved, inert.
 */
export function isPushStillDue(row: InboxPushCandidate): boolean {
  return !row.readAt && !row.archivedAt && !row.resolvedAt && !row.inertAt && pushPolicyFor(row.type) !== null
}

/**
 * How long the push service keeps a message for a device that is off, by
 * urgency. A request is worth waking a phone for tomorrow morning; an FYI that
 * is a day old is only noise.
 */
export const PUSH_TTL_SECONDS: Readonly<Record<PushUrgency, number>> = {
  high: 24 * 60 * 60,
  normal: 6 * 60 * 60,
  low: 60 * 60,
}
