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
import type { PushCategory, PushUrgency } from './push-categories'
import { isMarkAnchored } from './types'

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
  /**
   * How the type reaches a person's phone or desktop as a system notification
   * (ADR-0112). See {@link InboxPushPolicy} and `./push-policy`.
   */
  readonly push: InboxPushPolicy
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

/**
 * How a type is pushed (ADR-0112). Not a yes or no: every type may reach a
 * device the person turned notifications on for, and the person decides per
 * `category` (`./push-categories`), whose default is on for what is addressed to
 * them and off for ambient activity. `urgency` is what the push service is told
 * about how soon the device should wake for it.
 *
 * Unlike the email policy, push has no delay: a notification is only worth
 * sending while the item is unread, and the job that sends it checks that at
 * the moment it runs (`lib/push/inbox-push-job.ts`), which is the same
 * cancellation email gets from reading a row first.
 */
export interface InboxPushPolicy {
  readonly category: PushCategory
  readonly urgency: PushUrgency
  /**
   * The category instead, when the item is about the recipient's OWN thing
   * (its payload says `yours: true`): a reply on a mark they wrote answers
   * them, the way `mention.answered` does, and is not ambient activity.
   */
  readonly yours?: PushCategory
  /**
   * Fold a burst of this type's rows for ONE person into one notification,
   * across resources: the morning's due reminders, fifteen marks carried on to
   * a new document, a mark handed over after another. See {@link InboxPushFold}.
   */
  readonly fold?: InboxPushFold
}

/**
 * How a burst of one type's rows for one person is counted in the one
 * notification that tells them all (`lib/push/fold.ts`): each row's `variant`
 * is counted under a part of the line („3 heute oder morgen fällig, 1
 * überfällig“), worded by `pushFold.parts.<part>` in the type's copy. A
 * variant not listed is counted under `other`.
 */
export interface InboxPushFold {
  readonly parts: Readonly<Record<string, string>>
}

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
    push: { category: 'requests', urgency: 'high' },
  },
  // "Your request was answered" — one per answered request.
  'mention.answered': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'collaboration',
    email: IN_APP_ONLY,
    push: { category: 'results', urgency: 'normal' },
  },
  // "You now have access" — one per resource; re-sharing should not stack.
  'conversation.shared_with_you': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 60,
    gate: 'collaboration',
    email: IN_APP_ONLY,
    push: { category: 'access', urgency: 'normal' },
  },
  // Ambient thread activity — the type that MUST collapse, or the inbox is noise.
  'conversation.activity': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 30,
    gate: 'collaboration',
    email: IN_APP_ONLY,
    push: { category: 'activity', urgency: 'low' },
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
    push: { category: 'office', urgency: 'normal' },
  },
  'document.assigned_to_you': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 60,
    gate: 'collaboration',
    email: IN_APP_ONLY,
    push: { category: 'access', urgency: 'normal' },
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
  'task_run.completed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'results', urgency: 'low' },
  },
  'task_run.failed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 30 },
    push: { category: 'results', urgency: 'normal' },
  },
  /*
    A run has a question for the person who asked for it (ADR-0062, `waiting`).
    Actionable, because the run is stopped until they answer and the badge is
    what makes a stopped run visible; resolved by the ledger leaving `waiting`
    (`lib/runs/service.ts`), so it never sits in the badge for good. Anchored
    on the RUN: a second question from the same run folds into the row it
    already has, which is the row the reader is about to open anyway.
  */
  'task_run.waiting': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 30 },
    push: { category: 'requests', urgency: 'high' },
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
    push: { category: 'requests', urgency: 'normal' },
  },
  /*
    An Outlook archive import ended (ADR-0085). The `job.*` shapes, and for the
    same reasons: informational, one row per import (anchored on its folder),
    operational because an office without collaboration imports mail too. A
    failure is the one worth an email once a sender exists (none does yet, see
    `lib/inbox/delivery.ts`, so nothing is mailed today): the person may have
    closed the tab hours ago, and the archive is gone from staging once it ends.
  */
  'mail_import.completed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'results', urgency: 'low' },
  },
  'mail_import.failed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 30 },
    push: { category: 'results', urgency: 'normal' },
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
    push: { category: 'office', urgency: 'low' },
  },
  /*
    The team answered the reader's own feedback in PostHog Support (ADR-0118,
    second amendment). `collapse` on the REPORT: a conversation is one row that
    counts the replies since it was last read, and opens the thread, where all
    of them are. Informational: nothing waits on the reader, and the thread is
    the record. Operational, not collaboration: a member of an office without a
    chat feature sends feedback too, and must hear back. Pushed as a result,
    as `mention.answered` is (it answers something they asked). In-app only,
    by the product owner's decision: the inbox and the push are the notice, and
    a reply to feedback does not earn mail. Kept a quarter, like the report's
    announcement.
  */
  'feedback.replied': {
    actionable: false,
    grouping: 'collapse',
    retentionDays: 90,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'results', urgency: 'normal' },
  },
  /*
    An upload of yours has been read (ADR-0086). `per-anchor` on the batch id:
    two uploads are two summaries. Informational and in-app only: nothing waits
    on the reader, and the files already show their status where they live.
  */
  'upload.completed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'activity', urgency: 'low' },
  },
  /*
    The content check held files back (ADR-0086). `collapse` per organization:
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
    push: { category: 'office', urgency: 'normal' },
  },
  /*
    The uploader asks for a quarantined file to be released (ADR-0086).
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
    push: { category: 'office', urgency: 'normal' },
  },
  /*
    A newer Fassung of a document the recipient follows (ADR-0054, ADR-0099).
    `per-anchor`: the anchor is the older document (a confirmed link) or the new
    version (a same-name upload), so two Fassungen of one document are two rows
    and confirming the same link twice folds into one. Informational: the
    document opens from the row and nothing waits on the reader. Operational,
    like `document.review_requested`: documents are not a chat feature, and an
    office without collaboration still has uploaders to tell.
  */
  'document.new_revision': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'activity', urgency: 'low' },
  },
  /*
    Piloti finished a turn on an Anmerkung for the person who woke it (ADR-0106).
    `per-anchor` on the MARK: a second answer on the same mark folds into the
    row it has, which is the row the reader is about to open. Informational: the
    answer is in the thread, nothing waits on the reader. Operational, like
    `document.review_requested`: marks are not a chat feature. Short retention:
    it announces work that is already visible on the mark. A failure is the one
    worth keeping and mailing, as `task_run.failed` is: the person delegated the mark
    and may have left.
  */
  'piloti.work_done': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'results', urgency: 'low' },
  },
  'piloti.work_failed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 60 },
    push: { category: 'results', urgency: 'normal' },
  },
  /*
    Piloti asked a question and waits for a person. Actionable, because the
    mark is stuck until someone answers and the badge is what shows it; resolved
    by `onMarkSettledByPerson`, so it never sits there for good. `per-anchor` on
    the mark: a follow-up question folds into the row, and a second mark is a
    second row. Kept as long as a mention, for the same reason.
  */
  'piloti.asks_you': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 180,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 60 },
    push: { category: 'requests', urgency: 'high' },
  },
  /*
    A stored proposal waits for a decision (ADR-0105). Actionable until it is
    applied or dismissed. In-app only: it is a suggestion Piloti made while the
    person was working with it, not a request against them, so it does not earn
    mail. `per-anchor` on the proposal.
  */
  /*
    Piloti compared a new Fassung on its own and proposed marks (ADR-0130).
    Informational: the marks wait in the Prüfansicht, where they are decided;
    an unread row already counts. `per-anchor` on the first mark, so two notices
    are two rows. Operational, like the other rows about Piloti's work on marks.
  */
  'piloti.revision_checked': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'results', urgency: 'low' },
  },
  'piloti.proposal_waiting': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'requests', urgency: 'normal' },
  },
  /*
    A reading of the project's documents is ready for review (ADR-0111).
    Actionable: the suggestions count for nothing until a person confirms them,
    and the badge is what says so. `per-anchor` on the intake: the next reading
    of the same project folds into the row. Resolved by `completeIntake`, for
    everyone, so it never sits there for good.
  */
  'piloti.intake_ready': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'requests', urgency: 'normal' },
  },
  /*
    A colleague made the reader responsible for an Anmerkung (ADR-0106).
    Actionable: the mark waits on them until it is closed or handed on, and
    the badge is what says so. Resolved when someone else becomes responsible
    and for everyone when the mark is closed (`lib/annotations/attention.ts`).
    `per-anchor` on the mark: assigning it twice is one row. A reminder by
    mail after two hours unread, once a sender exists (`./delivery`): a mark
    handed to someone who never opens the app would otherwise wait for good. Operational, like `piloti.asks_you`:
    marks are not a chat feature.
  */
  'annotation.assigned_to_you': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 180,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 120 },
    // A day's reminders and a bulk hand-over are one notification, not one per mark.
    push: {
      category: 'requests',
      urgency: 'normal',
      fold: {
        parts: {
          overdue: 'overdue',
          due_soon: 'due_soon',
          person: 'assigned',
          piloti: 'assigned',
          due: 'redated',
          due_piloti: 'redated',
          due_cleared: 'redated',
          due_cleared_piloti: 'redated',
        },
      },
    },
  },
  /*
    News on a mark the reader takes part in: a reply, or their mark closed or
    reopened by someone else. `per-anchor` on the mark, so a busy thread is ONE
    counted row per mark, as `conversation.activity` is one per chat. Also new
    marks on a document the reader is Verantwortlich for or uploaded (variants
    `created` / `created_piloti`, `onMarksSet`): those fold per document and
    per who set them instead (anchor `set:<variant>:<actor>`), still anchored
    on the newest mark, so a review of fifteen is one counted row.
    Informational and in-app only: mailing it would teach people to filter our
    mail. Pushed as activity to the thread's other participants and to the
    document's people, who turned that on; to the mark's AUTHOR (`yours`) it is
    an answer to what they wrote, as `mention.answered` is, and is pushed as a
    result. Folded across marks: a colleague resolving fifteen of the reader's
    marks one after another is one notification („15 Neuigkeiten zu
    Anmerkungen“ over „15 erledigt“), not fifteen. A burst counts only the rows
    the reader's categories push (`readBurst` with `isPushWanted`), so their
    own marks' news and a thread they only take part in do not mix.
  */
  'annotation.activity': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: {
      category: 'activity',
      urgency: 'low',
      yours: 'results',
      fold: {
        parts: {
          reply: 'reply',
          resolved: 'resolved',
          dismissed: 'dismissed',
          reopened: 'reopened',
          created: 'created',
          created_piloti: 'created',
        },
      },
    },
  },
  /*
    A colleague @mentioned the reader on an Anmerkung: the chat's
    `mention.requested`, on a mark. Actionable, as a mention in the chat is: a
    person asked the reader something, and the badge is what shows it until
    they answer in the thread or the mark is closed
    (`lib/annotations/attention.ts`). `per-anchor` on the mark: being mentioned
    twice on one mark is one row. Pushed as the chat's mention is, and mailed
    as it is once a sender exists, so a person learns one rule for both. Operational, like the other marks'
    types: marks are not a chat feature.
  */
  'annotation.mentioned': {
    actionable: true,
    grouping: 'per-anchor',
    retentionDays: 180,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 60 },
    push: { category: 'requests', urgency: 'high' },
  },
  /*
    A sort of a shelf's root has proposed where its files go and waits for the
    requester (ADR-0121). Informational, not actionable: the dialog is where the
    decision is made, and the row counts in the badge until it is read, so
    nothing needs to resolve it. `per-anchor` on the run, so the one notice per
    run stays one row. In-app only: the person asked for the sort and is
    probably near it. Operational: documents are not a chat feature.
  */
  'root_sort.ready': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 30,
    gate: 'operational',
    email: IN_APP_ONLY,
    push: { category: 'results', urgency: 'normal' },
  },
  /*
    A sort stopped on an error. Kept as long as a failed job, and mailed once
    unread after half an hour, as `job.failed` is: the requester may have closed
    the tab and gone, and the run's reason is what they need to find.
  */
  'root_sort.failed': {
    actionable: false,
    grouping: 'per-anchor',
    retentionDays: 60,
    gate: 'operational',
    email: { send: 'if-unread', afterMinutes: 30 },
    push: { category: 'results', urgency: 'normal' },
  },
}

/**
 * The types whose `anchorId` is an Anmerkung (a mark) of the document they
 * point at. Their link opens the Prüfansicht at that mark; every other type
 * anchored on a document anchors on something else (a Fassung), and must not be
 * read as a mark. Derived from the client half (`anchor: 'mark'` in
 * `INBOX_TYPE_PRESENTATION`), which the row reads without this module.
 */
export const MARK_ANCHORED_INBOX_TYPES: readonly InboxItemType[] = INBOX_ITEM_TYPES.filter(isMarkAnchored)

/** The types anchored on a proposal: a deep link into a chat must not read that anchor as a message. */
export const PROPOSAL_ANCHORED_INBOX_TYPES: readonly InboxItemType[] = ['piloti.proposal_waiting']

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
 * The group-key anchor of rows that fold on something else than the anchor
 * they point at: new marks fold per document and per who set them
 * (`set:<variant>:<actor>`, `lib/annotations/attention.ts`), anchored on the
 * newest mark only so their link opens the review there. Their news is about
 * the document, not that mark: a dot on its pin would say an unrelated mark
 * has news (`listUnreadAnchors` leaves them out), and opening the review of
 * the document reads them (`markResourceItemsRead` narrowed to them).
 */
export const MARKS_SET_GROUP_ANCHOR = 'set:'

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
