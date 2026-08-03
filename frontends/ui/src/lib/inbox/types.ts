/**
 * Inbox wire types + the client-side half of the item-type registry (ADR-0035).
 *
 * No `'server-only'`: the inbox list, the badge and the row renderer are client
 * components and import these directly.
 *
 * **The extensibility contract lives here.** A new notification type needs:
 *   1. a member added to `INBOX_ITEM_TYPES` (in the schema module),
 *   2. an entry in `INBOX_TYPE_PRESENTATION` below,
 *   3. the two translation keys it names.
 * No schema change, no new component — the generic row renders every registered
 * type from its entry. `Record<InboxItemType, …>` makes the map exhaustive, so
 * `tsc` fails until step 2 is done.
 */

import type { InboxItemType, ShareableResourceType } from '@/lib/db/schema'

export type { InboxItemType, ShareableResourceType }

/** Lifecycle state, derived from the row's timestamps. */
export type InboxItemState = 'unread' | 'read' | 'resolved' | 'archived' | 'inert'

/** One item as the browser receives it. */
export interface InboxItemView {
  id: string
  type: InboxItemType
  state: InboxItemState
  /** True for items representing an outstanding request against the recipient. */
  actionable: boolean
  resourceType: ShareableResourceType
  resourceId: string
  anchorId: string | null
  /** Resolved display name of whoever caused it; null for system items. */
  actorName: string | null
  actorUserId: string | null
  /**
   * Occurrences absorbed by grouping SINCE THE ROW WAS LAST READ.
   *
   * `0` on a row that has been read and has had nothing new since — reading
   * resets it, so the counter always means "new", and a group of twenty that was
   * read then received one more says "1", not "21". Anything treating this as
   * `≥ 1` will be wrong for a read row.
   */
  count: number
  /** Where clicking it should land. Null when the item is inert. */
  href: string | null
  /** Short context line — e.g. the conversation title. */
  subject: string | null
  /**
   * The asker's question, or a message excerpt. Stripped when the item is inert,
   * because an inbox must never leak content whose access was revoked (IB-13).
   */
  excerpt: string | null
  createdAt: string
  updatedAt: string
}

/** `GET /api/inbox` */
export interface InboxListResponse {
  items: InboxItemView[]
  /** Count of things needing attention — the badge number. */
  pending: number
}

/** `GET /api/inbox/summary` — the cheap badge-only read. */
export interface InboxSummaryResponse {
  pending: number
}

/** Presentation metadata for one item type. */
export interface InboxTypePresentation {
  /** Lucide icon name, resolved by the renderer's icon map. */
  readonly icon: 'at-sign' | 'message-square' | 'user-plus' | 'check-circle'
  /** i18n key under `inbox.types.<key>.title` / `.body`. */
  readonly i18nKey: string
  /** Tone hint, so an actionable request reads differently from an FYI. */
  readonly tone: 'request' | 'info'
}

/**
 * The client-side registry. Exhaustive over `InboxItemType` by construction.
 *
 * Kept separate from the server registry (`./registry`) on purpose: the server
 * half owns grouping keys, retention and the actionable flag (facts that decide
 * what gets WRITTEN), while this half owns only how a row LOOKS. Neither needs
 * the other's concerns, and this one must be importable by client components.
 */
export const INBOX_TYPE_PRESENTATION: Record<InboxItemType, InboxTypePresentation> = {
  'mention.requested': { icon: 'at-sign', i18nKey: 'mentionRequested', tone: 'request' },
  'mention.answered': { icon: 'check-circle', i18nKey: 'mentionAnswered', tone: 'info' },
  'conversation.shared_with_you': { icon: 'user-plus', i18nKey: 'conversationShared', tone: 'info' },
  'conversation.activity': { icon: 'message-square', i18nKey: 'conversationActivity', tone: 'info' },
}

/**
 * What a row renders as when its type is not in the map above.
 *
 * That map is exhaustive over `InboxItemType` at compile time, but `type` is a
 * `text` column: a row written by a newer deploy, or read across a rollback,
 * carries a value this build has never heard of. Indexing the map for it yields
 * `undefined`, and reading `.icon` off that took the whole inbox route down with
 * a TypeError — one unrecognised row costing the user every other row they had.
 *
 * So: a neutral row that says something happened and links where the item
 * points. It is deliberately vague, because this build genuinely does not know
 * what the row means; it is not a substitute for registering the type.
 */
export const UNKNOWN_TYPE_PRESENTATION: InboxTypePresentation = {
  icon: 'message-square',
  i18nKey: 'unknown',
  tone: 'info',
}
