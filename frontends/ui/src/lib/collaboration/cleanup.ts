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
import { deleteItemsForResource, markItemsInertForResource } from '@/lib/inbox/repository'
import { deleteRequestsForResource, voidOpenRequestsForResource } from '@/lib/mentions/repository'
import { deleteAllGrantsForResource } from '@/lib/sharing/repository'

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
export async function purgeConversationCollaboration(
  conversationId: string,
): Promise<CollaborationCleanupResult> {
  const [grants, requests, inboxItems] = await Promise.all([
    deleteAllGrantsForResource('conversation', conversationId).catch((error) => {
      console.warn(`[collaboration-cleanup] grants purge failed for ${conversationId}:`, error)
      return 0
    }),
    deleteRequestsForResource('conversation', conversationId).catch((error) => {
      console.warn(`[collaboration-cleanup] requests purge failed for ${conversationId}:`, error)
      return 0
    }),
    deleteItemsForResource('conversation', conversationId).catch((error) => {
      console.warn(`[collaboration-cleanup] inbox purge failed for ${conversationId}:`, error)
      return 0
    }),
  ])
  return { grants, requests, inboxItems }
}

/**
 * Purge collaboration data for many conversations — the project/organization
 * cascade.
 *
 * A project purge hard-deletes its conversations through the `project_id` FK,
 * which is exactly the path that would otherwise orphan these rows. Callers pass
 * the conversation ids they are about to destroy (or just destroyed).
 *
 * Sequential rather than one big `IN (…)`: a purge is a background operation with
 * no latency budget, and keeping the statements small avoids taking long locks on
 * tables that serve every page render.
 */
export async function purgeCollaborationForConversations(
  conversationIds: readonly string[],
): Promise<CollaborationCleanupResult> {
  const total: CollaborationCleanupResult = { grants: 0, requests: 0, inboxItems: 0 }
  for (const conversationId of conversationIds) {
    const result = await purgeConversationCollaboration(conversationId)
    total.grants += result.grants
    total.requests += result.requests
    total.inboxItems += result.inboxItems
  }
  return total
}
