/**
 * Collaboration data cleanup — the cascade that the schema cannot express
 * (spec SH-13, IB-14, IB-15, NF-12).
 *
 * **Why this module has to exist.** `resource_shares`, `inbox_items` and
 * `mention_requests` all address their target as `(resource_type, resource_id)`
 * with `resource_id` a plain `text` column and **no foreign key** — deliberately,
 * because shareable ids are heterogeneous (a conversation id is a client-generated
 * string, a project id is a uuid) and a polymorphic FK is not a thing Postgres
 * offers. `conversation_reads` DOES have an FK and cascades on its own; these
 * three do not, so deleting a conversation would leave grants, open requests and
 * inbox items pointing at something that no longer exists.
 *
 * Those orphans are not a security hole — access resolution 404s on a missing
 * resource and the inbox re-authorizes at read time, so nothing leaks. But they
 * accumulate forever and they make a user's inbox show permanently redacted rows,
 * which reads as a bug. So the cascade is explicit, and it lives here rather than
 * being copy-pasted into every delete path.
 *
 * Two distinct operations, and the difference matters:
 *   - {@link neutralizeConversationCollaboration} for a SOFT delete — the
 *     conversation may come back, so rows are preserved and merely rendered
 *     inert/void. Restoring is then lossless.
 *   - {@link purgeConversationCollaboration} for a HARD delete — the target is
 *     gone for good, so the rows go with it.
 */

import 'server-only'
import {
  deleteItemsForResource,
  deleteOrphanedInboxItems,
  markItemsInertForResource,
  markItemsInertForSubjectInProject,
} from '@/lib/inbox/repository'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { resolveInboxItemsFor } from '@/lib/inbox/service'
import {
  deleteOrphanedMentionRequests,
  deleteRequestsForResource,
  voidOpenRequestsForResource,
  voidOpenRequestsForSubjectInProject,
} from '@/lib/mentions/repository'
import { deleteAllGrantsForResource, deleteOrphanedGrants } from '@/lib/sharing/repository'

export interface CollaborationCleanupResult {
  grants: number
  requests: number
  inboxItems: number
}

/**
 * Soft-delete companion: stop the conversation holding anyone hostage, without
 * destroying anything that a restore would need.
 *
 * Open requests are voided (nobody can answer a thread they cannot open, and an
 * unanswerable request would keep the hand-off banner up forever) and inbox items
 * are marked inert with their payloads wiped, so a quoted snippet cannot outlive
 * access to the thread it was quoted from.
 *
 * Grants are deliberately LEFT INTACT — the same reasoning as losing project
 * access (spec SH-13): a grant is inert while the resource is unreachable, and
 * keeping it means a restore returns the previous sharing state instead of
 * silently losing it.
 */
export async function neutralizeConversationCollaboration(
  conversationId: string,
): Promise<CollaborationCleanupResult> {
  const [requests, inboxItems] = await Promise.all([
    voidOpenRequestsForResource('conversation', conversationId),
    markItemsInertForResource('conversation', conversationId),
  ])
  return { grants: 0, requests: requests.length, inboxItems }
}

/**
 * Hard-delete companion: remove every trace.
 *
 * Ordering is not significant (no FKs between these tables), so the three run
 * concurrently. Best-effort per table: one failure must not leave the other two
 * uncleaned, because a half-cascade is harder to reason about than a failed one —
 * so failures are logged and reported, never thrown.
 */
export async function purgeResourceCollaboration(
  resourceType: import('@/lib/db/schema').ShareableResourceType,
  resourceId: string,
): Promise<CollaborationCleanupResult> {
  const [grants, requests, inboxItems] = await Promise.all([
    deleteAllGrantsForResource(resourceType, resourceId).catch((error) => {
      console.warn(`[collaboration-cleanup] grants purge failed for ${resourceType}:${resourceId}:`, error)
      return 0
    }),
    deleteRequestsForResource(resourceType, resourceId).catch((error) => {
      console.warn(`[collaboration-cleanup] requests purge failed for ${resourceType}:${resourceId}:`, error)
      return 0
    }),
    deleteItemsForResource(resourceType, resourceId).catch((error) => {
      console.warn(`[collaboration-cleanup] inbox purge failed for ${resourceType}:${resourceId}:`, error)
      return 0
    }),
  ])
  return { grants, requests, inboxItems }
}

export async function purgeConversationCollaboration(
  conversationId: string,
): Promise<CollaborationCleanupResult> {
  return purgeResourceCollaboration('conversation', conversationId)
}

/**
 * Someone lost access to an entire PROJECT — clean up their collaboration state
 * inside it (spec SH-13).
 *
 * The bug this closes: removing a person from a project ends their effective
 * access to every conversation in it, but any thread that was **waiting on them**
 * would wait forever — they can no longer read it, so they can never answer, and
 * the hand-off banner has no way to clear. Their inbox items would likewise stay
 * live (redacted at read time, but never resolved).
 *
 * Grants are deliberately left intact, exactly as for a container-access loss
 * (spec SH-13): they are inert while the container is unreachable, so keeping them
 * means re-adding the person to the project restores their previous sharing state
 * instead of silently losing it.
 *
 * Best-effort and non-throwing: a project-membership change must not fail because
 * notification bookkeeping did.
 */
export async function revokeCollaborationForProjectMember(
  organizationId: string,
  projectId: string,
  userId: string,
): Promise<{ requests: number; inboxItems: number }> {
  const [requests, inboxItems] = await Promise.all([
    voidOpenRequestsForSubjectInProject(organizationId, projectId, userId)
      .then(async (voided) => {
        if (voided.length > 0) {
          // Resolve the matching inbox items so the request does not sit in their
          // list pointing at something they can no longer open.
          //
          // Anchor-less requests are FILTERED, not defaulted: `mention.requested`
          // groups per anchor, so `inboxGroupKey` throws for one, and building the
          // list eagerly would let a single anchor-less row take the whole batch
          // into the catch below — every other recipient's item would silently stay
          // unresolved.
          //
          // Each row is paired with ITS recipient: a group key is shared by
          // everyone mentioned on the same message, so an update keyed on the group
          // alone would settle a colleague's still-open request too (spec MN-10).
          await resolveInboxItemsFor(
            voided
              .filter((request) => request.anchorId)
              .map((request) => ({
                organizationId: request.organizationId,
                recipientUserId: request.requestedOf,
                groupKey: inboxGroupKey(
                  'mention.requested',
                  request.resourceType,
                  request.resourceId,
                  request.anchorId,
                ),
              })),
          )
        }
        return voided.length
      })
      .catch((error) => {
        console.warn(`[collaboration-cleanup] request void failed for ${userId} in ${projectId}:`, error)
        return 0
      }),
    markItemsInertForSubjectInProject(organizationId, projectId, userId).catch((error) => {
      console.warn(`[collaboration-cleanup] inbox inert failed for ${userId} in ${projectId}:`, error)
      return 0
    }),
  ])
  return { requests, inboxItems }
}

/**
 * A project was soft-deleted — neutralise collaboration state for every
 * conversation inside it.
 *
 * Soft delete means "may come back", so nothing is destroyed: open requests are
 * voided (the thread is unreachable, so no request in it can be answered) and
 * inbox items go inert with their payloads wiped. Grants survive, so a restore
 * returns the project's threads with their sharing intact.
 */
export async function neutralizeCollaborationForProject(
  organizationId: string,
  projectId: string,
  conversationIds: readonly string[],
): Promise<CollaborationCleanupResult> {
  const total: CollaborationCleanupResult = { grants: 0, requests: 0, inboxItems: 0 }
  for (const conversationId of conversationIds) {
    try {
      const result = await neutralizeConversationCollaboration(conversationId)
      total.requests += result.requests
      total.inboxItems += result.inboxItems
    } catch (error) {
      console.warn(`[collaboration-cleanup] neutralize failed for ${conversationId}:`, error)
    }
  }
  return total
}

/**
 * Self-healing sweep for rows whose target conversation is gone.
 *
 * A hard delete of a conversation — including the cascade from purging its
 * project, which happens outside this tier — cannot cascade into these tables,
 * because `resource_id` is a polymorphic `text` column with no foreign key. Rather
 * than hook every possible purge path (some of which are not in the BFF at all),
 * housekeeping reconciles. Idempotent and bounded, so it is safe to run often.
 */
export async function sweepOrphanedCollaborationRows(
  limit = 500,
): Promise<CollaborationCleanupResult> {
  const [grants, requests, inboxItems] = await Promise.all([
    deleteOrphanedGrants(limit).catch((error) => {
      console.warn('[collaboration-cleanup] orphan grant sweep failed:', error)
      return 0
    }),
    deleteOrphanedMentionRequests(limit).catch((error) => {
      console.warn('[collaboration-cleanup] orphan request sweep failed:', error)
      return 0
    }),
    deleteOrphanedInboxItems(limit).catch((error) => {
      console.warn('[collaboration-cleanup] orphan inbox sweep failed:', error)
      return 0
    }),
  ])
  return { grants, requests, inboxItems }
}

/*
 * There is deliberately NO project-wide purge helper here.
 *
 * One existed (`purgeCollaborationForConversations`, a loop over
 * `purgeConversationCollaboration`) and had no caller in any tier. The one job it
 * was written for — a hard project purge — belongs to the purger service
 * (`frontends/ui/purger/`), which is a separate CommonJS process that cannot
 * import this module and must not use it if it could:
 *
 *   - it runs as `node purger/index.js` with no bundler and no TS step, so a
 *     `'server-only'` TypeScript module behind `@/…` path aliases is not
 *     reachable from it at all;
 *   - it does its grid_app deletes inside ONE postgres.js transaction so a
 *     mid-purge crash rolls back. This module's repositories open their own
 *     drizzle connection, so its writes would land outside that transaction;
 *   - `purgeConversationCollaboration` is best-effort and never throws. The
 *     purger needs a failure to abort the transaction and leave the queue row
 *     retryable — a swallowed error there marks a project purged while its
 *     collaboration rows survive;
 *   - it is per conversation. A project with tens of thousands of them would
 *     mean 3×N round trips where the purger issues three statements.
 *
 * The purger therefore states the same cascade as raw SQL. That duplication is
 * real and is recorded as debt in
 * `docs/architecture/adding-a-shareable-resource-type.md` §3.5 — the honest place
 * for it, since the fix is a substrate one (a shared, resource-type-parameterised
 * statement source both runtimes can use), not another wrapper in this file.
 * `sweepOrphanedCollaborationRows` above is the backstop that keeps the two from
 * silently diverging.
 */
