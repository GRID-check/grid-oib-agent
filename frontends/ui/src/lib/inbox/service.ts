/**
 * Inbox service — emission, reading, and the revocation hooks (ADR-0035).
 *
 * Owns authorization for the recipient-facing operations (a caller may only ever
 * touch their OWN inbox) and the read-time re-authorization that keeps a
 * notification from outliving the access it describes.
 *
 * Emission is called from inside the operation that CAUSED the notification, so
 * "if the mention was stored, the item exists" (spec IB-16). It is therefore
 * written to be cheap and to never surprise its caller with an exception it
 * cannot handle — see {@link emitInboxItems}.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { publishToUser } from '@/lib/events/bus'
import type {
  InboxItem,
  InboxItemType,
  InboxTargetType,
  NewInboxItem,
  ShareableResourceType,
} from '@/lib/db/schema'
import { resolvePeople } from '@/lib/sharing/directory'
import { findInboxTarget, type InboxTargetAccess } from './targets'
import {
  archiveInboxItem,
  countPendingInboxItems,
  INBOX_LIST_LIMIT,
  listInboxItems,
  markAllInboxItemsRead,
  markInboxItemsRead,
  markItemsInertForResource,
  markItemsInertForSubjectRow,
  markResourceItemsRead,
  resolveInboxItemsForTargets,
  upsertInboxItems,
  type InboxResolutionTarget,
} from './repository'
import { inboxItemIsActionable, visibleInboxTypes } from './registry'
import type {
  InboxItemState,
  InboxItemView,
  InboxListResponse,
  InboxSummaryResponse,
} from './types'

/**
 * One notification to create. `groupKey` decides grouping/dedup/idempotency —
 * build it with the registry's helper rather than by hand.
 */
export interface InboxEmission {
  organizationId: string
  recipientUserId: string
  type: InboxItemType
  resourceType: InboxTargetType
  resourceId: string
  anchorId?: string | null
  actorUserId?: string | null
  groupKey: string
  payload?: Record<string, unknown>
}

/**
 * Create (or fold) notifications and nudge each recipient's badge.
 *
 * A recipient equal to the actor is dropped: nobody needs to be told about their
 * own action, and self-notification is the most common cause of an inbox that
 * feels like noise.
 */
export async function emitInboxItems(emissions: InboxEmission[]): Promise<number> {
  const rows: NewInboxItem[] = emissions
    .filter((emission) => emission.recipientUserId !== emission.actorUserId)
    .map((emission) => ({
      organizationId: emission.organizationId,
      recipientUserId: emission.recipientUserId,
      type: emission.type,
      resourceType: emission.resourceType,
      resourceId: emission.resourceId,
      anchorId: emission.anchorId ?? null,
      actorUserId: emission.actorUserId ?? null,
      groupKey: emission.groupKey,
      actionable: inboxItemIsActionable(emission.type),
      payload: emission.payload ?? {},
    }))

  if (rows.length === 0) return 0

  const inserted = await upsertInboxItems(rows)

  // Badge nudge per recipient. Publishing is fail-open by construction, and the
  // badge is re-read from Postgres anyway, so a miss costs latency only.
  await Promise.all(
    [...new Set(rows.map((row) => row.recipientUserId))].map(async (recipientUserId) => {
      const emission = rows.find((row) => row.recipientUserId === recipientUserId)
      if (!emission) return
      // `pending: -1` — the event's own "unknown, go and read the summary"
      // convention (see CollaborationEvent), and the client already honours it
      // by refetching.
      //
      // This is not a shortcut. The emitter has no session, so it cannot know
      // which item types the RECIPIENT may see: a count taken here would include
      // collaboration rows that a collaboration-disabled recipient will never be
      // shown, and the badge would disagree with the list. The previous code
      // computed an untyped count and published it as fact.
      //
      // The alternative — resolve each recipient's feature flags here — means a
      // WorkOS lookup per recipient on the emit path, to produce a number the
      // client is documented as being allowed to distrust. So the event stays a
      // nudge, and `getInboxSummary` (session-scoped, type-gated) remains the
      // one place the badge number is authoritative.
      await publishToUser(recipientUserId, {
        kind: 'inbox.changed',
        pending: -1,
        itemType: emission.type,
      })
    }),
  )

  return inserted.length
}

/**
 * Resolve the actionable items belonging to settled requests (spec MN-16).
 *
 * Called by the mentions service when a request is answered, released or voided —
 * the recipient never has to tidy up manually for the inbox to stay accurate.
 *
 * Takes (organization, recipient, group) TRIPLES rather than a list of group keys
 * plus a separate list of recipients: the pairing is what makes the update touch
 * only the rows that actually settled. A group key is shared by everyone mentioned
 * on the same message, so the two lists must never be applied as a cross product.
 */
export async function resolveInboxItemsFor(
  targets: readonly InboxResolutionTarget[],
): Promise<number> {
  const resolved = await resolveInboxItemsForTargets(targets)
  await Promise.all(
    [...new Set(targets.map((target) => target.recipientUserId))].map((userId) =>
      publishToUser(userId, { kind: 'inbox.changed', pending: -1 }),
    ),
  )
  return resolved
}

/**
 * Neutralise one person's items for a resource, in the SAME operation that
 * revokes their access (spec IB-14).
 *
 * Session-less: the caller (`@/lib/sharing/service`) has already authorized the
 * revocation. Wipes the stored payload, so a quoted snippet cannot survive the
 * access it was quoted from.
 */
export async function markItemsInertForSubject(
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<number> {
  const affected = await markItemsInertForSubjectRow(resourceType, resourceId, subjectUserId)
  if (affected > 0) {
    await publishToUser(subjectUserId, { kind: 'inbox.changed', pending: -1 })
  }
  return affected
}

/**
 * Neutralise EVERY item pointing at a resource — for a soft-delete, where nobody
 * should be left with a working link.
 */
export async function markItemsInertForDeletedResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  return markItemsInertForResource(resourceType, resourceId)
}

// ---------------------------------------------------------------------------
// Reading the inbox
// ---------------------------------------------------------------------------

/**
 * Re-exported so a route can bound its request size against the same cap the
 * list uses, without importing the repository (routes never reach the DB layer).
 */
export { INBOX_LIST_LIMIT }
export type { InboxResolutionTarget }

export interface ListInboxParams {
  /** `true` = only what needs attention; omitted = everything unarchived. */
  pendingOnly?: boolean
}

/** Key for the per-page target cache — one entry per DISTINCT resource. */
function targetKey(resourceType: InboxTargetType, resourceId: string): string {
  return `${resourceType}:${resourceId}`
}

/**
 * The item types this reader may see (see `visibleInboxTypes`).
 *
 * Applied to the list AND to the badge count, so the two can never disagree
 * about what is in the inbox. A tenant without collaboration gets its
 * operational alerts and nothing else — not a 403, which is what used to make an
 * operational alert unreachable for precisely the deployments that need it.
 */
function typesVisibleTo(session: Pick<GridSession, 'featureFlags'>): InboxItemType[] {
  return visibleInboxTypes(isCollaborationEnabled(session))
}

/**
 * Lifecycle state from the row's timestamps, strongest fact first.
 *
 * Order matters: an inert item is inert whatever else was set on it, and an
 * archived one is archived even if it was also resolved. Deriving rather than
 * storing means a state can never contradict the timestamps that drove it.
 */
function deriveState(row: InboxItem): InboxItemState {
  if (row.inertAt) return 'inert'
  if (row.archivedAt) return 'archived'
  if (row.resolvedAt) return 'resolved'
  if (row.readAt) return 'read'
  return 'unread'
}

/**
 * Payload text is attacker-influenced (a message someone else wrote, quoted into
 * MY inbox), so it is treated as `unknown`: anything that is not a non-empty
 * string becomes null, and length is capped so a padded payload cannot bloat the
 * list response. The payload is a display convenience, never a contract (IB-3).
 */
function coerceText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed
}

const SUBJECT_MAX_LENGTH = 200
const EXCERPT_MAX_LENGTH = 500

/**
 * Re-derive, ONCE per distinct target in the page, whether the recipient can
 * still reach it (spec IB-13). This is the security core of the inbox read path:
 * an item is a pointer and never a grant, so the link and the snippet are earned
 * again at every render.
 *
 * Two failure modes are deliberately swallowed per resource rather than
 * propagated:
 *   - `NotFoundError` — the normal answer for "revoked, deleted, or another
 *     tenant's". It means redact this item, not fail the page.
 *   - anything else — a probe blowing up must not take a user's whole inbox with
 *     it; redacting is the safe direction, so we degrade to a redacted row.
 *
 * Inert rows are skipped: they are redacted by construction, so probing their
 * target would spend a query to learn something already decided.
 */
async function resolveTargets(
  session: AuthorizedSession,
  rows: readonly InboxItem[],
): Promise<Map<string, InboxTargetAccess | null>> {
  const distinct = new Map<string, { resourceType: InboxTargetType; resourceId: string }>()
  for (const row of rows) {
    if (row.inertAt) continue
    const key = targetKey(row.resourceType, row.resourceId)
    if (!distinct.has(key)) {
      distinct.set(key, { resourceType: row.resourceType, resourceId: row.resourceId })
    }
  }

  const resolved = await Promise.all(
    [...distinct].map(async ([key, target]) => {
      // An unregistered target type — a row from a newer deploy, read across a
      // rollback — is unreachable, not a crash. The sharing registry throws for
      // this case, which is why the inbox resolves targets through its own.
      const descriptor = findInboxTarget(target.resourceType)
      if (!descriptor) return [key, null] as const
      try {
        return [key, await descriptor.resolve(session, target.resourceId)] as const
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          console.warn(`[inbox] re-authorization failed for ${key}, redacting item(s):`, error)
        }
        return [key, null] as const
      }
    }),
  )

  return new Map(resolved)
}

/**
 * Project one row onto the wire shape.
 *
 * A row whose target is unreachable is returned REDACTED — no link and no
 * payload text at all — but never dropped: a redacted row explains itself ("you
 * no longer have access"), whereas a silently vanished notification looks like a
 * bug in the product.
 *
 * **The whole payload is withheld, not just the excerpt.** `subject` is the
 * conversation's TITLE, which is exactly the kind of thing a title gives away
 * ("Kündigung Müller", "Übernahmeangebot Halle 3"); gating the snippet while
 * handing over the title would be a redaction in name only (spec IB-13, SH-19).
 * The stored payload of an inert row was already wiped at revocation time (spec
 * IB-14) — withholding it here is the second half of that double protection, and
 * the half that also covers a missed transition, a narrowed visibility, or a lost
 * project membership, none of which touch the stored row.
 */
function toItemView(
  row: InboxItem,
  targets: Map<string, InboxTargetAccess | null>,
  actorNames: Map<string, string>,
): InboxItemView {
  const access = row.inertAt ? null : (targets.get(targetKey(row.resourceType, row.resourceId)) ?? null)
  const payload: Record<string, unknown> = row.payload ?? {}

  return {
    id: row.id,
    type: row.type,
    state: deriveState(row),
    actionable: row.actionable,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    anchorId: row.anchorId,
    // Unknown ids stay null rather than falling back to the raw WorkOS id: the
    // client still has `actorUserId` and can render initials without us leaking
    // an identifier into copy.
    actorName: row.actorUserId ? (actorNames.get(row.actorUserId) ?? null) : null,
    actorUserId: row.actorUserId,
    count: row.count,
    href: access ? access.deepLink({ itemType: row.type, anchorId: row.anchorId }) : null,
    subject: access ? coerceText(payload.subject, SUBJECT_MAX_LENGTH) : null,
    excerpt: access ? coerceText(payload.excerpt, EXCERPT_MAX_LENGTH) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * One page of the caller's own inbox, plus the badge count (spec IB-20).
 *
 * Scoped to `session.userId` + `session.organizationId` in SQL, so there is no
 * "whose inbox" parameter to get wrong: a caller can only ever list their own,
 * in the organization they are currently acting in (spec IB-1).
 *
 * The three post-processing reads — target re-authorization, actor names, badge
 * count — are batched and run concurrently, because this is a per-page-render
 * endpoint: distinct targets are probed once each (not once per item), and the
 * directory is one cached lookup for every actor on the page.
 */
export async function listInbox(
  session: AuthorizedSession,
  params: ListInboxParams = {},
): Promise<InboxListResponse> {
  const types = typesVisibleTo(session)
  const rows = await listInboxItems(session.organizationId, session.userId, {
    pendingOnly: params.pendingOnly ?? false,
    limit: INBOX_LIST_LIMIT,
    types,
  })

  const actorIds = [...new Set(rows.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))]

  const [targets, people, pending] = await Promise.all([
    resolveTargets(session, rows),
    resolvePeople(session.organizationId, actorIds),
    countPendingInboxItems(session.organizationId, session.userId, types),
  ])

  const actorNames = new Map([...people].map(([userId, person]) => [userId, person.name]))

  return { items: rows.map((row) => toItemView(row, targets, actorNames)), pending }
}

/**
 * The badge number and nothing else (spec IB-19).
 *
 * Separate from {@link listInbox} on purpose: this runs on EVERY page render, so
 * it must stay one indexed count — no re-authorization, no directory, no rows.
 */
export async function getInboxSummary(session: AuthorizedSession): Promise<InboxSummaryResponse> {
  return {
    pending: await countPendingInboxItems(session.organizationId, session.userId, typesVisibleTo(session)),
  }
}

// ---------------------------------------------------------------------------
// Mutating the caller's own inbox
// ---------------------------------------------------------------------------

export interface InboxMutationResult {
  /** Rows the operation actually touched (0 is a legitimate no-op). */
  affected: number
  /** Recomputed badge count, so the caller needs no follow-up request. */
  pending: number
}

/**
 * Recompute the badge and push it to the caller's own channel.
 *
 * The event is an accelerator, not the mechanism (spec RT-4): the same number is
 * returned in the HTTP response, so a dropped publish costs a stale badge in
 * OTHER tabs until their next fetch — never correctness. `publishToUser` never
 * throws, so this cannot fail the mutation it reports.
 */
async function publishPending(session: AuthorizedSession, affected: number): Promise<InboxMutationResult> {
  const pending = await countPendingInboxItems(
    session.organizationId,
    session.userId,
    typesVisibleTo(session),
  )
  await publishToUser(session.userId, { kind: 'inbox.changed', pending })
  return { affected, pending }
}

/**
 * Mark specific items read.
 *
 * No ownership check is needed and none is written: the repository's WHERE
 * clause is scoped to the caller's user + organization, so ids belonging to
 * someone else simply match nothing. That is deliberately quiet — reporting
 * "that item is not yours" would confirm it exists.
 */
export async function markRead(
  session: AuthorizedSession,
  itemIds: readonly string[],
): Promise<InboxMutationResult> {
  const affected = await markInboxItemsRead(
    session.organizationId,
    session.userId,
    [...itemIds],
    typesVisibleTo(session),
  )
  return publishPending(session, affected)
}

/**
 * Mark the caller's whole inbox read — the "clear all" affordance (spec IB-20).
 *
 * Scoped to the types the caller can actually SEE. "Clear all" means the list in
 * front of them; silently marking rows they were never shown (a collaboration
 * item in a tenant whose flag has since been turned off, say) would decide
 * something on their behalf about a surface they cannot look at.
 */
export async function markAllRead(session: AuthorizedSession): Promise<InboxMutationResult> {
  const affected = await markAllInboxItemsRead(
    session.organizationId,
    session.userId,
    typesVisibleTo(session),
  )
  return publishPending(session, affected)
}

/**
 * Archive one item.
 *
 * Unlike {@link markRead} this addresses a single id, so a miss must answer
 * something: `NotFoundError` — identical for "does not exist" and "belongs to
 * another user", so the endpoint cannot be used to probe for item ids.
 */
export async function archiveItem(session: AuthorizedSession, itemId: string): Promise<InboxMutationResult> {
  const archived = await archiveInboxItem(
    session.organizationId,
    session.userId,
    itemId,
    typesVisibleTo(session),
  )
  if (!archived) throw new NotFoundError()
  return publishPending(session, 1)
}

/**
 * Clear the ambient items for a resource because the caller has now actually
 * looked at it (spec IB-9) — called by the conversation read path, not by a
 * button.
 *
 * Only informational items are cleared. Reading a thread is NOT answering the
 * question someone asked you in it, so an actionable request survives being seen
 * and is cleared only by its resolution (spec MN-16).
 *
 * No access check here: the caller has already read the resource (that is the
 * event), and the operation can only ever touch the caller's own rows.
 */
export async function markResourceItemsReadFor(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<InboxMutationResult> {
  const affected = await markResourceItemsRead(
    session.organizationId,
    session.userId,
    resourceType,
    resourceId,
  )
  return publishPending(session, affected)
}
