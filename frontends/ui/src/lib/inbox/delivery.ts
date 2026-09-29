/**
 * How an inbox item reaches somebody OUTSIDE the app — the seam for email
 * (ADR-0035 decision 8, spec IB-11).
 *
 * ## What exists and what does not
 *
 * The item is the record of what happened; a channel is how the recipient is
 * told. In-app delivery is the inbox itself. Email is declared per type in the
 * registry (`INBOX_TYPE_DEFINITIONS[type].email`) and decided here, by pure
 * functions over an inbox row. **No sender exists yet**, so nothing in this
 * module is called on a live path: it is the contract a sender is written
 * against, tested now so the contract is real before anything depends on it.
 *
 * ## How a sender plugs in (the follow-up, not this change)
 *
 *   1. Implement {@link InboxEmailSender} over the chosen provider.
 *   2. Add an `emailed_at` column to `inbox_items` in the same migration as the
 *      sender, NOT before: a column added today would read "due, never sent"
 *      for every row until then, and the first sweep would mail the backlog.
 *   3. A scheduled sweep (the storage-alert sweep is the shape: discover under
 *      the platform bypass, act per tenant under `withTenant`) selects rows with
 *      `emailed_at IS NULL` whose {@link emailDueAt} has passed, re-checks
 *      {@link isEmailDue}, re-authorizes the target exactly as the inbox read
 *      path does (spec IB-13 — a revoked target sends nothing), resolves the
 *      address from WorkOS, sends, and stamps `emailed_at`.
 *   4. Per-user overrides (spec IB-12) narrow {@link emailDefaultFor}; they
 *      never widen a type the registry says is in-app only.
 *
 * The mail carries a link and a title, never the payload excerpt: an email
 * cannot be redacted after the fact, so it must not quote what a later
 * revocation would have hidden.
 */

import type { InboxItem, InboxItemType } from '@/lib/db/schema'
import { INBOX_ITEM_TYPES } from '@/lib/db/schema'
import { INBOX_TYPE_DEFINITIONS, type InboxEmailDefault } from './registry'

/** The row facts the decision reads. A full `InboxItem` satisfies it. */
export type InboxEmailCandidate = Pick<
  InboxItem,
  'type' | 'updatedAt' | 'readAt' | 'archivedAt' | 'resolvedAt' | 'inertAt'
>

/**
 * The registry's email default for a type.
 *
 * `type` is a `text` column, so a row from a newer deploy can carry a value
 * this build does not know. Unknown means in-app only: guessing in the mailing
 * direction would send something nobody here can describe.
 */
export function emailDefaultFor(type: string): InboxEmailDefault {
  return (INBOX_ITEM_TYPES as readonly string[]).includes(type)
    ? INBOX_TYPE_DEFINITIONS[type as InboxItemType].email
    : { send: 'never' }
}

/**
 * When the reminder for this row falls due, or null when it never will.
 *
 * Measured from `updatedAt`, the row's last activity: a grouped row that was
 * revived by new activity is due again relative to that activity, not to the
 * first occurrence weeks ago.
 */
export function emailDueAt(row: InboxEmailCandidate): Date | null {
  const policy = emailDefaultFor(row.type)
  if (policy.send === 'never') return null
  return new Date(row.updatedAt.getTime() + policy.afterMinutes * 60_000)
}

/**
 * Whether this row should be emailed now.
 *
 * Every state that means "the recipient has dealt with it, or may no longer
 * see it" cancels the mail: read, archived, resolved, inert. That is the
 * difference between a reminder and a copy.
 */
export function isEmailDue(row: InboxEmailCandidate, now: Date = new Date()): boolean {
  if (row.readAt || row.archivedAt || row.resolvedAt || row.inertAt) return false
  const dueAt = emailDueAt(row)
  return dueAt !== null && dueAt.getTime() <= now.getTime()
}

/** Everything a sender needs to write one mail. Deliberately no excerpt. */
export interface InboxEmailMessage {
  itemId: string
  type: InboxItemType
  recipientUserId: string
  /** Resolved by the sender from WorkOS at send time, never stored on the row. */
  recipientEmail: string
  /** The localized title the inbox row shows. */
  title: string
  /** Absolute URL to the row's deep link, re-authorized at send time. */
  href: string
  locale: 'de' | 'en'
}

/**
 * The provider seam. Implementations must be idempotent per `itemId`: the
 * sweep stamps `emailed_at` after `send` resolves, so a crash between the two
 * re-sends on the next tick.
 */
export interface InboxEmailSender {
  send(message: InboxEmailMessage): Promise<void>
}
