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
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'

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
 *
 * `platform` types are addressed to the people who run the platform, not to a
 * tenant: a member's product feedback, and whatever joins it later. Their rows
 * live in the PLATFORM organization and are never part of a tenant's inbox.
 * They reach a reader through the inbox's platform lane, which opens only for a
 * session holding {@link PLATFORM_INBOX_PERMISSION} — see `platformInboxTypes`.
 */
export type InboxTypeGate = 'collaboration' | 'operational' | 'platform'

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
  /**
   * The type's default for the email channel (spec IB-5, IB-11). See
   * {@link InboxEmailDefault} and `./delivery`.
   */
  readonly email: InboxEmailDefault
}

/**
 * Whether a type ALSO reaches its recipient by email, and when (spec IB-11).
 *
 * The item is what happened; email is one way of telling somebody, so the
 * policy is a property of the type and the row stays the one record. Nothing
 * sends email yet — `./delivery` is the seam a sender plugs into — but every
 * type has to state its answer today, so the day a sender exists no type ships
 * silent by accident and none mails by accident.
 *
 *   - `never`     — in-app only. Ambient activity, FYIs, anything that would
 *                   train people to filter our mail.
 *   - `if-unread` — a reminder: mail the recipient when the row is still unread
 *                   (and not archived, resolved or inert) `afterMinutes` after
 *                   its last activity. `0` means as soon as the sender sees it.
 *                   Reading it in the app first cancels the mail, which is what
 *                   makes it a reminder rather than a copy.
 *
 * A digest mode and per-user overrides (spec IB-12) join this union when there
 * is a sender to honour them.
 */
export type InboxEmailDefault =
  | { readonly send: 'never' }
  | { readonly send: 'if-unread'; readonly afterMinutes: number }

const IN_APP_ONLY: InboxEmailDefault = { send: 'never' }

export const INBOX_TYPE_DEFINITIONS: Record<InboxItemType, InboxTypeDefinition> = {
  // A request for your input. Each mention is its own question, so no collapsing,
  // and kept longest: an unanswered request is the most valuable thing here.
  'mention.requested': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 180,
    gate: 'collaboration',
    email: { send: 'if-unread', afterMinutes: 60 },
  },
  // "Your request was answered" — one per answered request.
  'mention.answered': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'collaboration',
    email: IN_APP_ONLY,
  },
  // "You now have access" — one per resource; re-sharing should not stack.
  'conversation.shared_with_you': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 60,
    gate: 'collaboration',
    email: IN_APP_ONLY,
  },
  // Ambient thread activity — the type that MUST collapse, or the inbox is noise.
  'conversation.activity': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 30,
    gate: 'collaboration',
    email: IN_APP_ONLY,
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
    email: { send: 'if-unread', afterMinutes: 0 },
  },
  'document.assigned_to_you': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 60,
    gate: 'collaboration',
    email: IN_APP_ONLY,
  },
  /*
    A background run ended. `per-anchor` with the backend job id as the anchor:
    two runs of one job are two pieces of work, each with its own report, so
    they must not fold into one counted row. Informational: the inbox cannot
    resolve a run, and an actionable row would sit in the badge for good.
    Operational: jobs are not a collaboration feature, and a tenant with
    collaboration off still schedules them. A failure is kept longer — it is
    the one the reader most needs to still find.
  */
  'job.completed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
  },
  'job.failed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 30 },
  },
  /*
    A run has a question for the person who asked for it (ADR-0062, `wartet`).
    Actionable, because the run is stopped until they answer and the badge is
    what makes a stopped run visible; resolved by the ledger leaving `wartet`
    (`lib/runs/service.ts`), so it never sits in the badge for good. Anchored
    on the RUN: a second question from the same run folds into the row it
    already has, which is the row the reader is about to open anyway.
  */
  'job.waiting': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 30 },
  },
  /*
    A version is waiting for a decision (ADR-0054). Actionable, because it IS an
    outstanding request against the recipient and the badge is what makes it
    visible; `per-anchor` on the VERSION, because two review rounds on one
    document ask about two sets of bytes and collapsing them would hide the
    second. Kept as long as a mention, for the same reason: an unanswered
    request is the most valuable thing in this list.

    `operational` rather than `collaboration`: a Ziviltechniker's Freigabe is
    not a chat feature, and a tenant that never bought collaboration still has
    documents to approve. Gating it would make the one review queue in the
    product invisible for exactly the offices most likely to want it — the same
    mistake the storage warning's entry above records.
  */
  'document.review_requested': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 180,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 60 },
  },
  /*
    A member sent product feedback (Platform → Feedback). Informational: the
    triage status on the report is the work queue, and an actionable row would
    need every owner's copy resolved when one of them triages it. `collapse` on
    the REPORT, so each report is one row per owner. Kept a quarter: a report
    nobody opened for three months is still on the triage page, which is the
    record; the inbox row is only the announcement.
  */
  'feedback.submitted': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 90,
    gate: 'platform',
    email: { send: 'if-unread', afterMinutes: 0 },
  },
  /*
    An upload of yours has been read (ADR-0085). `per-anchor` on the batch id:
    two uploads are two summaries. Informational and in-app only: nothing waits
    on the reader, and the files already show their status where they live.
  */
  'upload.completed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
  },
  /*
    The content check held files back (ADR-0085). `collapse` per organization:
    a folder of payslips is one row reading "7 Dateien warten", not seven.
    Informational rather than actionable, because the queue page is where the
    decision is made and a row nothing can resolve would sit in the badge.
  */
  'document.quarantined': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
  },
  /*
    The uploader asks for a quarantined file to be released (ADR-0083).
    `per-anchor` on the document: asking twice about one file is one row, two
    files are two. Informational for the same reason as `document.quarantined`:
    the queue page is where the decision is made.
  */
  'document.release_requested': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
  },
}

/**
 * The permission that opens the platform lane of a reader's inbox.
 *
 * `platform:settings:view` because it is the read half of the permission the
 * triage page requires to change a report, and it is what Platform → Lessons
 * reads with: whoever may read the platform's feedback may be told about it.
 */
export const PLATFORM_INBOX_PERMISSION = PLATFORM_PERMISSIONS.settingsView

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
  return INBOX_ITEM_TYPES.filter((type) => {
    const { gate } = INBOX_TYPE_DEFINITIONS[type]
    if (gate === 'platform') return false
    return collaborationEnabled || gate === 'operational'
  })
}

/**
 * The types that live in the platform organization's inbox rows.
 *
 * Never part of {@link visibleInboxTypes}: a tenant lane must not return a
 * platform row even when the reader's active organization IS the platform
 * organization, or the platform lane would list it a second time.
 */
export function platformInboxTypes(): InboxItemType[] {
  return INBOX_ITEM_TYPES.filter((type) => INBOX_TYPE_DEFINITIONS[type].gate === 'platform')
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
