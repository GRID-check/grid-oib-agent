/**
 * The conversation's working directory on the Python tier, and the one thing
 * this tier has to do about it: tell it when the conversation is gone.
 *
 * ## Why the BFF has to say anything at all
 *
 * The working directory is per-conversation scratch — drafts, notes, the file a
 * turn is editing — and it lives in the agent service's own LangGraph
 * `PostgresStore`, namespaced by conversation id
 * (`docs/roadmap/piloti-writes-artifacts-and-approval.md` §1). That store is on
 * the other side of ADR-0003's boundary: no foreign key reaches it, no cascade
 * touches it, and `deleteConversation` erasing every row it owns leaves those
 * namespaces standing forever, holding whatever the model had written into
 * them. „Chat gelöscht" has to mean the drafts went too, or the product keeps
 * private text in a store nothing lists.
 *
 * ## Best effort, and never in the way
 *
 * The delete is already two-phase and already stops on the one failure that
 * cannot be retried past (session attachments, whose rows still name the
 * objects). This is not that. A draft namespace is addressable by the
 * conversation id alone, so a failure here loses nothing that a later sweep
 * cannot address, and refusing the delete over it would leave the user with a
 * chat they asked to be rid of. So it is logged and swallowed — the ONE place
 * in this module that swallows, and it says why.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'

/** Same ceiling as the chunk purge: an unreachable backend must not hold the request. */
const DRAFT_DISCARD_TIMEOUT_MS = 10_000

/**
 * Ask the agent service to drop one conversation's drafts.
 *
 * Returns whether it confirmed. `false` is a log line and nothing else; the
 * caller is deleting a conversation and must not be stopped by it.
 */
export async function discardConversationDrafts(conversationId: string): Promise<boolean> {
  const token = process.env.GRID_INTERNAL_API_TOKEN
  if (!token) {
    console.warn('[conversations] GRID_INTERNAL_API_TOKEN is not configured; drafts not discarded')
    return false
  }
  try {
    const response = await fetch(
      `${getBackendUrl()}/v1/drafts/${encodeURIComponent(conversationId)}`,
      {
        method: 'DELETE',
        // The same service-to-service header every other call from this tier
        // carries (`lib/jobs/backend-client.ts`, the vector reconcile).
        headers: { 'x-grid-internal-token': token },
        signal: AbortSignal.timeout(DRAFT_DISCARD_TIMEOUT_MS),
      },
    )
    // 404 is a conversation that never wrote a draft, which is most of them,
    // and is a success: there is nothing left to discard.
    if (response.ok || response.status === 404) return true
    console.warn(
      `[conversations] draft discard refused for ${conversationId}: HTTP ${response.status}`,
    )
    return false
  } catch (error) {
    console.warn(`[conversations] draft discard failed for ${conversationId}`, error)
    return false
  }
}
