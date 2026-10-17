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

import type { InboxItemType, InboxTargetType, ShareableResourceType } from '@/lib/db/schema'

export type { InboxItemType, InboxTargetType, ShareableResourceType }

/** Lifecycle state, derived from the row's timestamps. */
export type InboxItemState = 'unread' | 'read' | 'resolved' | 'archived' | 'inert'

/** One item as the browser receives it. */
export interface InboxItemView {
  id: string
  type: InboxItemType
  state: InboxItemState
  /**
   * Whether the reader archived it. Its own fact, not a `state`: a row that is
   * archived AND redacted reads `state: 'inert'` and must still be restored,
   * never archived again.
   */
  archived: boolean
  /** True for items representing an outstanding request against the recipient. */
  actionable: boolean
  resourceType: InboxTargetType
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
   * The other thing the row names, where a type has two: for a new Fassung, the
   * newer document's name beside the `subject` that was followed. Withheld with
   * the rest of the payload when the item is inert, like `subject`.
   */
  related: string | null
  /**
   * The asker's question, or a message excerpt. Stripped when the item is inert,
   * because an inbox must never leak content whose access was revoked (IB-13).
   */
  excerpt: string | null
  /**
   * Which wording of its type the row reads, where a type has more than one:
   * why Piloti could not work a mark (`piloti.work_failed`, the classes of
   * `lib/annotations/wake-end-reason.ts`), what a proposal changes
   * (`piloti.proposal_waiting`), whether Piloti assigned a mark for someone
   * (`annotation.assigned_to_you`), whether a mark was replied to, closed or
   * reopened (`annotation.activity`). The renderer reads
   * `inbox.types.<key>.variants.<variant>.<leaf>` before the type's own leaf,
   * so an unknown variant reads as the type's general wording. A key segment
   * (`[a-z][a-z_]*`), never copy; withheld with the payload when redacted.
   */
  variant: string | null
  createdAt: string
  updatedAt: string
}

/**
 * The slices `GET /api/inbox?filter=` reads (`./repository`'s `InboxListFilter`):
 * `requests` waits on the reader („Für mich“), `unread` is not opened yet
 * („Ungelesen“), `all` is everything not archived, `archived` what was put
 * away; `pending` is the badge's own set (unread or a request still open).
 */
export const INBOX_LIST_FILTERS = ['pending', 'requests', 'unread', 'all', 'archived'] as const
export type InboxListFilter = (typeof INBOX_LIST_FILTERS)[number]

/** `GET /api/inbox` */
export interface InboxListResponse {
  items: InboxItemView[]
  /** Count of things needing attention — the badge number. */
  pending: number
  /** The numbers beside the filters: requests still open, and rows not opened yet. */
  counts: { requests: number; unread: number }
  /** Whether a further page exists behind `nextCursor`. */
  hasMore: boolean
  /** Pass as `?cursor=` to read the next page; null on the last one. */
  nextCursor: string | null
}

/** Every inbox mutation answers with this: what it touched, and the badge after it. */
export interface InboxMutationResult {
  /** Rows the operation actually touched (0 is a legitimate no-op). */
  affected: number
  /** Recomputed badge count, so the caller needs no follow-up request. */
  pending: number
}

/** `GET /api/inbox/summary` — the cheap badge-only read. */
export interface InboxSummaryResponse {
  pending: number
}

/** Presentation metadata for one item type. */
export interface InboxTypePresentation {
  /** Lucide icon name, resolved by the renderer's icon map. */
  readonly icon:
    | 'at-sign'
    | 'message-square'
    | 'user-plus'
    | 'check-circle'
    | 'hard-drive'
    | 'alert-triangle'
    | 'clock'
    | 'megaphone'
    | 'shield-alert'
    | 'layers'
    /** Piloti's own glyph (`components/ui/piloti-glyph.tsx`), for what Piloti did or asks. */
    | 'piloti'
  /**
   * i18n key under `inbox.types.<key>.title` / `.body`, and the leaves the row
   * picks by what the item names (`titleRelated`, `bodyNoSubject`, …), first
   * under `variants.<variant>` when the item carries one.
   */
  readonly i18nKey: string
  /**
   * Tone hint, so an actionable request reads differently from an FYI.
   *
   * `warning` is for an operational condition: nobody is waiting on the reader,
   * but it is not an FYI either — something in their account needs attention.
   */
  readonly tone: 'request' | 'info' | 'warning'
  /**
   * What the item's `anchorId` is, where it is something the row can act on:
   * `mark`, an Anmerkung of the document the item points at. The row then
   * offers „Zur Anmerkung“ (and, for a request, answers in its thread), and
   * the server registry derives `MARK_ANCHORED_INBOX_TYPES` from it, so the two
   * halves cannot disagree about which types those are.
   */
  readonly anchor?: 'mark'
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
  'storage.quota_warning': { icon: 'hard-drive', i18nKey: 'storageQuotaWarning', tone: 'warning' },
  'document.assigned_to_you': { icon: 'user-plus', i18nKey: 'documentAssigned', tone: 'info' },
  'job.completed': { icon: 'check-circle', i18nKey: 'jobCompleted', tone: 'info' },
  'job.failed': { icon: 'alert-triangle', i18nKey: 'jobFailed', tone: 'warning' },
  // The clock is the run block's own glyph for `wartet`, so the row and the
  // block say "waiting for you" with one shape.
  'job.waiting': { icon: 'clock', i18nKey: 'jobWaiting', tone: 'request' },
  'document.review_requested': {
    icon: 'check-circle',
    i18nKey: 'documentReviewRequested',
    tone: 'request',
  },
  'feedback.submitted': { icon: 'megaphone', i18nKey: 'feedbackSubmitted', tone: 'info' },
  'upload.completed': { icon: 'check-circle', i18nKey: 'uploadCompleted', tone: 'info' },
  'document.quarantined': { icon: 'shield-alert', i18nKey: 'documentQuarantined', tone: 'warning' },
  'document.release_requested': { icon: 'shield-alert', i18nKey: 'documentReleaseRequested', tone: 'request' },
  'mail_import.completed': { icon: 'check-circle', i18nKey: 'mailImportCompleted', tone: 'info' },
  'mail_import.failed': { icon: 'alert-triangle', i18nKey: 'mailImportFailed', tone: 'warning' },
  'document.new_fassung': { icon: 'layers', i18nKey: 'documentNewFassung', tone: 'info' },
  // Piloti's rows wear its face, as its marks and replies do on the page.
  'piloti.work_done': { icon: 'piloti', i18nKey: 'pilotiWorkDone', tone: 'info', anchor: 'mark' },
  'piloti.work_failed': { icon: 'piloti', i18nKey: 'pilotiWorkFailed', tone: 'warning', anchor: 'mark' },
  'piloti.asks_you': { icon: 'piloti', i18nKey: 'pilotiAsksYou', tone: 'request', anchor: 'mark' },
  'piloti.proposal_waiting': { icon: 'piloti', i18nKey: 'pilotiProposalWaiting', tone: 'request' },
  'piloti.intake_ready': { icon: 'piloti', i18nKey: 'pilotiIntakeReady', tone: 'request' },
  'annotation.assigned_to_you': { icon: 'user-plus', i18nKey: 'annotationAssigned', tone: 'request', anchor: 'mark' },
  'annotation.activity': { icon: 'message-square', i18nKey: 'annotationActivity', tone: 'info', anchor: 'mark' },
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

/** Whether an item's anchor is a mark of its document (`anchor: 'mark'` above). */
export function isMarkAnchored(type: InboxItemType): boolean {
  return INBOX_TYPE_PRESENTATION[type]?.anchor === 'mark'
}
