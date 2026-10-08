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
import { getPlatformOrganizationId, hasPlatformPermission } from '@/lib/authz/platform'
import { withTenant } from '@/lib/db/tenant-context'
import { publishToUser } from '@/lib/events/bus'
import type {
  InboxItem,
  InboxItemType,
  InboxTargetType,
  NewInboxItem,
  ShareableResourceType,
} from '@/lib/db/schema'
import { resolvePeople } from '@/lib/sharing/directory'
import { unreadableRunIds, type RunRef } from '@/lib/tasks/subject-access'
import { findInboxTarget, type InboxTargetAccess, type RunMessageRef } from './targets'
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
import {
  inboxItemIsActionable,
  PLATFORM_INBOX_PERMISSION,
  platformInboxTypes,
  visibleInboxTypes,
} from './registry'
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

/** Split rows into waves in which no (recipient, group key) repeats, keeping their order. */
export function upsertWaves<T extends { recipientUserId: string; groupKey: string }>(rows: readonly T[]): T[][] {
  const waves: T[][] = []
  const seenByWave: Array<Set<string>> = []
  for (const row of rows) {
    const key = `${row.recipientUserId}\u0000${row.groupKey}`
    let index = seenByWave.findIndex((seen) => !seen.has(key))
    if (index < 0) {
      index = waves.length
      waves.push([])
      seenByWave.push(new Set())
    }
    waves[index].push(row)
    seenByWave[index].add(key)
  }
  return waves
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

  // One upsert per wave of distinct (recipient, group) keys. Postgres refuses
  // an INSERT … ON CONFLICT DO UPDATE that touches the same row twice, so two
  // emissions that fold into one row — two files quarantined in one settle —
  // used to fail the whole call. Successive waves fold them one at a time, so
  // the row's count still says two.
  const inserted = []
  for (const wave of upsertWaves(rows)) inserted.push(...(await upsertInboxItems(wave)))

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
 * One organization's slice of a reader's inbox: whose rows, which types.
 *
 * A reader's inbox is normally one lane, their active organization. Platform
 * staff have a second: the rows addressed to them in the PLATFORM organization
 * (`gate: 'platform'` types — a member's product feedback). Those rows cannot
 * live in the reader's tenant, because the owner works from whichever
 * organization they happen to be in, and a tenant's inbox is no place for the
 * platform's mail. So the platform lane is read alongside the tenant lane, and
 * the two are merged into one list and one badge.
 *
 * The lanes are disjoint by construction: `visibleInboxTypes` never contains a
 * platform type, so even a reader whose active organization IS the platform
 * organization gets each row exactly once.
 */
interface InboxLane {
  organizationId: string
  types: InboxItemType[]
}

/**
 * The platform lane, when this reader has one.
 *
 * Opened by the permission (`PLATFORM_INBOX_PERMISSION`), not by membership
 * alone — the same rule every platform surface applies. Both lookups are
 * cached in `@/lib/authz/platform` and are already warm from the nav flags on
 * every page, so the badge stays cheap for everybody else.
 */
async function platformLaneFor(session: AuthorizedSession): Promise<InboxLane | null> {
  const types = platformInboxTypes()
  if (types.length === 0) return null
  if (!(await hasPlatformPermission(session, PLATFORM_INBOX_PERMISSION))) return null
  const organizationId = await getPlatformOrganizationId()
  return organizationId ? { organizationId, types } : null
}

async function lanesFor(session: AuthorizedSession): Promise<InboxLane[]> {
  const tenant: InboxLane = { organizationId: session.organizationId, types: typesVisibleTo(session) }
  const platform = await platformLaneFor(session)
  return platform ? [tenant, platform] : [tenant]
}

/**
 * Run a lane's query as that lane's organization.
 *
 * The platform lane's rows belong to the platform organization, so row-level
 * security only shows them inside that tenant scope. This is not a bypass: the
 * scope is still ONE organization and the query is still pinned to the
 * reader's own user id, exactly as the tenant lane is.
 */
function inLane<T>(session: AuthorizedSession, lane: InboxLane, fn: () => Promise<T>): Promise<T> {
  if (lane.organizationId === session.organizationId) return fn()
  return withTenant({ organizationId: lane.organizationId, userId: session.userId }, fn)
}

/** The badge across every lane — one indexed count per lane. */
async function countPendingAcross(session: AuthorizedSession, lanes: readonly InboxLane[]): Promise<number> {
  const counts = await Promise.all(
    lanes.map((lane) =>
      inLane(session, lane, () => countPendingInboxItems(lane.organizationId, session.userId, lane.types)),
    ),
  )
  return counts.reduce((sum, value) => sum + value, 0)
}

/** Apply a mutation in every lane and total the rows it touched. */
async function mutateAcross(
  session: AuthorizedSession,
  lanes: readonly InboxLane[],
  mutate: (lane: InboxLane) => Promise<number>,
): Promise<number> {
  const affected = await Promise.all(lanes.map((lane) => inLane(session, lane, () => mutate(lane))))
  return affected.reduce((sum, value) => sum + value, 0)
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

/** The run a project row names (`job.*` rows carry `runId`, older ones `taskId`). */
function runRefOf(row: InboxItem): RunRef | null {
  if (row.inertAt || row.resourceType !== 'project') return null
  const payload: Record<string, unknown> = row.payload ?? {}
  const runId = nonEmpty(payload.runId) ?? nonEmpty(payload.taskId)
  return runId ? { projectId: row.resourceId, runId } : null
}

/**
 * The rows whose run the recipient may not see now, by id. A target is a
 * project, and the project's access says nothing about a revision task whose
 * document has since moved into a folder the recipient may not read: its row
 * carries the task's title and a link into its thread, so it is judged by the
 * same rule as the task list and the run view (`subject-access.ts`, ADR-0089)
 * and redacted like a revoked one.
 */
async function rowsWithUnreadableRuns(session: AuthorizedSession, rows: readonly InboxItem[]): Promise<Set<string>> {
  const refs = rows.flatMap((row) => {
    const ref = runRefOf(row)
    return ref ? [{ rowId: row.id, ref }] : []
  })
  if (refs.length === 0) return new Set()
  const unreadable = await unreadableRunIds(
    session,
    refs.map(({ ref }) => ref),
  )
  return new Set(refs.filter(({ ref }) => unreadable.has(ref.runId)).map(({ rowId }) => rowId))
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
/** A payload string that says something, trimmed; anything else is absent. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function toItemView(
  row: InboxItem,
  targets: Map<string, InboxTargetAccess | null>,
  actorNames: Map<string, string>,
  withheld: ReadonlySet<string>,
): InboxItemView {
  const access =
    row.inertAt || withheld.has(row.id) ? null : (targets.get(targetKey(row.resourceType, row.resourceId)) ?? null)
  const payload: Record<string, unknown> = row.payload ?? {}
  // The delegated task this row is about, when the emitter named one
  // (`job.completed` / `job.failed` carry `taskId` beside `filedDocumentId`).
  // Threaded into the href so the row lands on its result; absent falls back
  // to the target's own page. Attacker-influenced like every other payload
  // field, so anything that is not a non-empty string becomes absent.
  const taskId = nonEmpty(payload.taskId)
  // The run's message, when the emitter knew it (`runMessageId` beside
  // `conversationId` and `runId`): the row then lands on the run block itself.
  // All three or nothing — a link with a session and no message is the drawer's
  // job, not a half-built anchor.
  const conversationId = nonEmpty(payload.conversationId)
  const runId = nonEmpty(payload.runId)
  const messageId = nonEmpty(payload.runMessageId)
  const run: RunMessageRef | null =
    conversationId && runId && messageId ? { conversationId, runId, messageId } : null

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
    //
    // A platform-lane row's actor belongs to ANOTHER organization, which the
    // reader's directory cannot resolve, so its emitter snapshots the name as
    // `payload.actorName`. Withheld with the rest of the payload when redacted.
    actorName: row.actorUserId
      ? (actorNames.get(row.actorUserId) ?? (access ? coerceText(payload.actorName, SUBJECT_MAX_LENGTH) : null))
      : null,
    actorUserId: row.actorUserId,
    count: row.count,
    href: access
      ? access.deepLink({ itemType: row.type, anchorId: row.anchorId, taskId, run })
      : null,
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
  const lanes = await lanesFor(session)
  const perLane = await Promise.all(
    lanes.map((lane) =>
      inLane(session, lane, () =>
        listInboxItems(lane.organizationId, session.userId, {
          pendingOnly: params.pendingOnly ?? false,
          limit: INBOX_LIST_LIMIT,
          types: lane.types,
        }),
      ),
    ),
  )
  // Each lane is already newest-first and bounded, so the merged page is the
  // newest INBOX_LIST_LIMIT across them — the same bound one lane had.
  const rows = perLane
    .flat()
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, INBOX_LIST_LIMIT)

  const actorIds = [...new Set(rows.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))]

  const [targets, withheld, people, pending] = await Promise.all([
    resolveTargets(session, rows),
    rowsWithUnreadableRuns(session, rows),
    resolvePeople(session.organizationId, actorIds),
    countPendingAcross(session, lanes),
  ])

  const actorNames = new Map([...people].map(([userId, person]) => [userId, person.name]))

  return { items: rows.map((row) => toItemView(row, targets, actorNames, withheld)), pending }
}

/**
 * The badge number and nothing else (spec IB-19).
 *
 * Separate from {@link listInbox} on purpose: this runs on EVERY page render, so
 * it must stay one indexed count — no re-authorization, no directory, no rows.
 */
export async function getInboxSummary(session: AuthorizedSession): Promise<InboxSummaryResponse> {
  return { pending: await countPendingAcross(session, await lanesFor(session)) }
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
async function publishPending(
  session: AuthorizedSession,
  lanes: readonly InboxLane[],
  affected: number,
): Promise<InboxMutationResult> {
  const pending = await countPendingAcross(session, lanes)
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
  const lanes = await lanesFor(session)
  const affected = await mutateAcross(session, lanes, (lane) =>
    markInboxItemsRead(lane.organizationId, session.userId, [...itemIds], lane.types),
  )
  return publishPending(session, lanes, affected)
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
  const lanes = await lanesFor(session)
  const affected = await mutateAcross(session, lanes, (lane) =>
    markAllInboxItemsRead(lane.organizationId, session.userId, lane.types),
  )
  return publishPending(session, lanes, affected)
}

/**
 * Archive one item.
 *
 * Unlike {@link markRead} this addresses a single id, so a miss must answer
 * something: `NotFoundError` — identical for "does not exist" and "belongs to
 * another user", so the endpoint cannot be used to probe for item ids.
 */
export async function archiveItem(session: AuthorizedSession, itemId: string): Promise<InboxMutationResult> {
  const lanes = await lanesFor(session)
  // An id belongs to at most one lane; the others match nothing.
  const archived = await mutateAcross(session, lanes, async (lane) =>
    (await archiveInboxItem(lane.organizationId, session.userId, itemId, lane.types)) ? 1 : 0,
  )
  if (archived === 0) throw new NotFoundError()
  return publishPending(session, lanes, archived)
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
  return publishPending(session, await lanesFor(session), affected)
}
