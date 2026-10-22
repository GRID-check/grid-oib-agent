/**
 * What an inbox item points at, and whether the reader can still reach it.
 *
 * ## Why this module exists
 *
 * `inbox_items.resource_type` used to be typed `ShareableResourceType`, and the
 * read path went straight to `describeResource()` + `resolveResourceAccess()`.
 * Both are the SHARING registry: they answer "who has been granted what on this
 * object", and `describeResource` THROWS for a type it does not know. That was
 * fine while every notification was about a conversation, and wrong the moment
 * one was about the tenant itself — an organization is not shareable, must not
 * become shareable (adding it to `SHAREABLE_RESOURCE_TYPES` would make an org a
 * thing you can hand somebody a grant on), and has no owner/visibility/grant
 * story at all.
 *
 * So the inbox gets its own target registry, one level above sharing:
 *
 *   - it is exhaustive over `InboxTargetType`, so a new target kind cannot ship
 *     without a deep link AND an access resolver — the same discipline
 *     `SHAREABLE_REGISTRY` applies to shareable types;
 *   - the `conversation` entry DELEGATES to the sharing registry rather than
 *     re-deriving anything, so shareable resources keep exactly one access
 *     definition;
 *   - `resolve` returns `null` for "unreachable" instead of throwing, because
 *     unreachable is the ordinary answer here (revoked, deleted, another
 *     tenant's) and the row must render redacted rather than take the page down.
 *
 * Nothing in this module is a cast or a special case in the read path: adding
 * `organization` cost one descriptor.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  INBOX_TARGET_TYPES,
  SHAREABLE_RESOURCE_TYPES,
  type InboxItemType,
  type InboxTargetType,
  type ShareableResourceType,
} from '@/lib/db/schema'
import { hasPlatformPermission } from '@/lib/authz/platform'
import { requireProjectAccess } from '@/lib/authz/projects'
import { resolveResourceAccess } from '@/lib/sharing/access'
import { describeResource } from '@/lib/sharing/registry'
import {
  MARK_ANCHORED_INBOX_TYPES,
  PLATFORM_INBOX_PERMISSION,
  PROPOSAL_ANCHORED_INBOX_TYPES,
} from './registry'
import { findOwnUploadBatch } from '@/lib/upload-batches/service'
import { getOwnProductFeedback } from '@/lib/product-feedback/repository'
import { feedbackThreadHref } from '@/lib/product-feedback/types'

/** Row-level context a deep link may use. */
export interface InboxTargetLinkContext {
  /** The item's type — an org-scoped alert lands on the page that explains it. */
  itemType: InboxItemType
  /** The exact spot inside the target, when the type has one. */
  anchorId?: string | null
  /**
   * The delegated task this row is about, when the payload names one.
   *
   * Carried from `payload.taskId` by the read path (`service.toItemView`) so
   * a run outcome lands on its result instead of on a run history. Absent is
   * the ordinary case for every other type, and the link falls back to the
   * target's own page.
   */
  taskId?: string | null
  /**
   * The run's own message in its thread, when the run has one (ADR-0062).
   *
   * Carried from `payload.conversationId` / `runId` / `runMessageId` by the
   * read path. With all three the row lands ON the run block — the thread
   * scrolled to the message and the block marked — which is where the report,
   * the question or the error is. Without them the task drawer is the fallback.
   */
  run?: RunMessageRef | null
}

/** Where a run narrates itself: its thread, its id, its message. */
export interface RunMessageRef {
  conversationId: string
  runId: string
  messageId: string
}

/**
 * A target the reader CAN still reach. Existence of this object is the
 * authorization decision; `deepLink` is what the row renders as its href.
 */
export interface InboxTargetAccess {
  /** The project the target belongs to (itself, or the home of its conversation or document); null when none. */
  projectId: string | null
  deepLink: (context: InboxTargetLinkContext) => string
}

export interface InboxTargetDescriptor {
  readonly type: InboxTargetType
  /**
   * Re-derive access at READ time (spec IB-13) and, if it holds, hand back the
   * link builder. `null` means "redact this row".
   *
   * MUST NOT throw for an unreachable target. The caller swallows throws as
   * unreachable too — redacting is the safe direction — but a descriptor that
   * relies on that turns an ordinary revocation into a logged warning per row.
   */
  readonly resolve: (
    session: AuthorizedSession,
    resourceId: string,
  ) => Promise<InboxTargetAccess | null>
}

/**
 * Where an organization-scoped item lands.
 *
 * Data rather than a `switch`, and per ITEM TYPE rather than per target type,
 * because "your organization" is not a place — the useful destination is the
 * page that explains the alert and offers the thing to do about it. A type with
 * no entry falls back to the organization overview, which is never wrong, only
 * vague.
 */
const ORGANIZATION_DESTINATIONS: Partial<Record<InboxItemType, string>> = {
  'storage.quota_warning': '/app/organization/storage',
  'document.quarantined': '/app/organization/quarantine',
  'document.release_requested': '/app/organization/quarantine',
  // A filing suggestion on the Büroablage waits on its file row there.
  'piloti.proposal_waiting': '/app/office-shelf',
}

/**
 * A sort of a shelf's root (ADR-0121): the row lands on the shelf's files with
 * the sort dialog open on the run (`?rootSort=<runId>`, read by
 * `features/documents/hooks/use-root-sort-param`). The run's id is the anchor.
 */
function rootSortHref(shelfPath: string, runId: string | null | undefined): string {
  const run = runId?.trim()
  return run ? `${shelfPath}?rootSort=${encodeURIComponent(run)}` : shelfPath
}

function shareableTarget(type: ShareableResourceType): InboxTargetDescriptor {
  return {
    type,
    resolve: async (session, resourceId) => {
      const access = await resolveResourceAccess(session, type, resourceId)
      if (!access.role) return null
      // An item names its resource (a mention carries the thread's title). For a
      // reader who may no longer read what the resource was drawn from, that
      // line is content: the row renders redacted, like a revoked one.
      if (access.contentLocked) return null
      return {
        projectId: access.container.projectId,
        deepLink: (context) => {
          // An anchor means different things by type: a message of a chat, a
          // mark of a document, a proposal or a Fassung. Only the first two are
          // places the target can open at.
          const anchor = context.anchorId ?? undefined
          const onMark = MARK_ANCHORED_INBOX_TYPES.includes(context.itemType)
          const onProposal = PROPOSAL_ANCHORED_INBOX_TYPES.includes(context.itemType)
          return describeResource(type).deepLink(resourceId, {
            anchorId: onMark || onProposal ? undefined : anchor,
            markId: onMark ? anchor : undefined,
            projectId: access.container.projectId,
          })
        },
      }
    },
  }
}

/**
 * The tenant itself — the target of operational alerts (ADR-0042).
 *
 * Access is membership, and membership is already proven: the inbox list is
 * scoped to `session.organizationId` in SQL, so a row from another tenant cannot
 * be returned in the first place. The comparison below is therefore a belt on
 * top of that WHERE clause, not the only strap — it exists so that a row written
 * with the wrong organization id (a bug in an emitter, a bad backfill) renders
 * redacted instead of linking a member into a tenant they do not belong to.
 *
 * There is deliberately no permission check here. The Organization → Storage
 * page is readable by every member by design (ADR-0042: the member whose upload
 * was refused is usually not an admin, and that page is the only thing that
 * explains the refusal), so gating the LINK harder than the page it points at
 * would produce a redacted row in front of a page the reader can simply open.
 * Who the alert is ADDRESSED to is a separate decision, made once at emission
 * time by the recipient resolver — not re-litigated on every render.
 */
const organizationTarget: InboxTargetDescriptor = {
  type: 'organization',
  resolve: async (session, resourceId) => {
    if (resourceId !== session.organizationId) return null
    return {
      projectId: null,
      deepLink: (context) =>
        // The office filing's sort: its anchor is the run.
        context.itemType.startsWith('root_sort.')
          ? rootSortHref('/app/office-shelf', context.anchorId)
          : (ORGANIZATION_DESTINATIONS[context.itemType] ?? '/app/organization'),
    }
  },
}

/**
 * Exhaustive over `InboxTargetType` by construction — `tsc` fails if a member of
 * the union has no descriptor.
 */
const shareableTargets = Object.fromEntries(
  SHAREABLE_RESOURCE_TYPES.map((type) => [type, shareableTarget(type)]),
) as Record<ShareableResourceType, InboxTargetDescriptor>

/**
 * A project — the target of a background run's outcome.
 *
 * A run is one message in the thread that commissioned it (ADR-0062), so when
 * the row's payload names that message the link lands ON the run block:
 * `?session=` selects the thread, `?run=` names the run and `#message-` scrolls
 * to and marks the block — the same query `taskResultTarget` builds for the
 * Aufträge index, so one mechanism carries every deep link into a run. A run
 * from before run messages existed has no message; then the row lands on the
 * task's detail drawer (`?tab=tasks&task=`) where the result and the filed
 * document wait — and without even a task id, on the schedules view, which is
 * never wrong, only less specific. Access is the same question the page itself asks
 * (`project:view`, re-derived at read time per spec IB-13): a member removed
 * from the project since the run ended sees a redacted row rather than a link
 * into a project they can no longer open. `requireProjectAccess` throws for
 * "no"; here "no" is the ordinary answer and must not take the inbox down, so
 * it is caught and returned as `null`.
 */
const projectTarget: InboxTargetDescriptor = {
  type: 'project',
  resolve: async (session, resourceId) => {
    try {
      await requireProjectAccess(session, resourceId, 'project:view')
    } catch {
      return null
    }
    return {
      projectId: resourceId,
      deepLink: (context) => {
        // A mail import lands on the folder it filed into: the row's anchor,
        // unless the import ended before making one (anchored `import:<id>`).
        if (context.itemType === 'mail_import.completed' || context.itemType === 'mail_import.failed') {
          const anchor = context.anchorId?.trim()
          const folder = anchor && !anchor.startsWith('import:') ? anchor : null
          return `/app/projects/${resourceId}/files${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`
        }
        // A proposal no chat made is a filing suggestion: it waits on its file
        // row in the project's Dateien (`lib/filing`).
        if (context.itemType === 'piloti.proposal_waiting') return `/app/projects/${resourceId}/files`
        // A finished reading waits on the project's setup page, where it is reviewed (ADR-0111).
        if (context.itemType === 'piloti.intake_ready') return `/app/projects/${resourceId}/setup`
        // Mail waiting for a person opens the project's E-Mail-Eingang (ADR-0134).
        if (context.itemType === 'inbound_mail.waiting') return `/app/projects/${resourceId}/files/mail`
        // A sort of the project's root waits in its files, with the dialog open (ADR-0121).
        if (context.itemType.startsWith('root_sort.')) {
          return rootSortHref(`/app/projects/${resourceId}/files`, context.anchorId)
        }
        if (context.run) return runDeepLink(resourceId, context.run)
        const taskId = context.taskId?.trim() ? context.taskId.trim() : null
        if (taskId) {
          return `/app/projects/${resourceId}/automation?tab=tasks&task=${encodeURIComponent(taskId)}`
        }
        return `/app/projects/${resourceId}/automation?tab=jobs`
      },
    }
  },
}

/** The thread at the run: the shape `features/tasks/lib/task-view.ts` builds. */
function runDeepLink(projectId: string, run: RunMessageRef): string {
  const session = encodeURIComponent(run.conversationId)
  const runId = encodeURIComponent(run.runId)
  const message = encodeURIComponent(run.messageId)
  return `/app/projects/${projectId}/chat?session=${session}&run=${runId}#message-${message}`
}

/**
 * A product-feedback report — the target of `feedback.submitted` (for the
 * platform owners) and of `feedback.replied` (for its reporter).
 *
 * Two readers, two rights, both re-asked at read time (spec IB-13):
 *
 *   - a platform owner reaches it by the permission the platform lane opened
 *     on. The report lives in the REPORTER's organization and the row in the
 *     platform organization, so no membership says anything; an owner whose
 *     platform role was withdrawn sees a redacted row. Their link is the triage
 *     page, where a deleted report renders as not found.
 *   - the reporter reaches their OWN report: the row is in their organization
 *     and the report must still be theirs there (`getOwnProductFeedback`, keyed
 *     to the session's organization and user under RLS). Their link opens
 *     „Mein Feedback" on the thread.
 *
 * The descriptor is per target, not per item type, so it answers for both and
 * the link picks by the row's type; a reply row is only ever the reporter's.
 */
const productFeedbackTarget: InboxTargetDescriptor = {
  type: 'product_feedback',
  resolve: async (session, resourceId) => {
    const [platform, own] = await Promise.all([
      hasPlatformPermission(session, PLATFORM_INBOX_PERMISSION),
      getOwnProductFeedback(session.organizationId, session.userId, resourceId).catch(() => null),
    ])
    if (!platform && !own) return null
    return {
      projectId: null,
      deepLink: ({ itemType }) =>
        own && (itemType === 'feedback.replied' || !platform)
          ? feedbackThreadHref(resourceId)
          : `/app/platform/feedback?report=${encodeURIComponent(resourceId)}`,
    }
  },
}

/**
 * One upload gesture — the target of `upload.completed` (ADR-0086).
 *
 * Its summary is its uploader's: it lists what they sent and what the office's
 * screening kept on their machine. Access is therefore "you made this upload",
 * re-asked at read time (spec IB-13) through the same service the summary page
 * reads with, so the row and the page cannot disagree.
 */
const uploadBatchTarget: InboxTargetDescriptor = {
  type: 'upload_batch',
  resolve: async (session, resourceId) => {
    const batch = await findOwnUploadBatch(session, resourceId).catch(() => null)
    if (!batch) return null
    return { projectId: null, deepLink: () => `/app/uploads/${encodeURIComponent(resourceId)}` }
  },
}

export const INBOX_TARGET_REGISTRY: Record<InboxTargetType, InboxTargetDescriptor> = {
  ...shareableTargets,
  organization: organizationTarget,
  project: projectTarget,
  product_feedback: productFeedbackTarget,
  upload_batch: uploadBatchTarget,
}

/**
 * Descriptor lookup that never throws.
 *
 * Unlike `describeResource`, an unknown value here is NOT a programming error:
 * `resource_type` is a `text` column, so a row written by a newer deploy — or
 * read across a rollback — carries a value this build has never heard of. The
 * old code threw for exactly that case and took the whole inbox route with it.
 * An unknown target is simply unreachable, which is what a redacted row means.
 */
export function findInboxTarget(type: string): InboxTargetDescriptor | null {
  return (INBOX_TARGET_TYPES as readonly string[]).includes(type)
    ? INBOX_TARGET_REGISTRY[type as InboxTargetType]
    : null
}
