/**
 * INTERNAL service endpoint — the purger's retry of a chat erasure that the
 * delete request could not finish (`docs/architecture/deletion-pipeline.md`).
 *
 * `DELETE /api/conversations/[id]` marks the chat deleting and queues a
 * `deletion_queue` row before it erases anything; when the agent service is down
 * its erase stops with a 502 and the chat stays marked. The purger claims the
 * row (attempts, backoff, legal-hold guard, terminal `failed`) and POSTs here,
 * and this runs the SAME erasure the request runs — the purger is plain Node
 * and cannot import it, and a second copy of the steps in JavaScript would be a
 * second deletion path to keep in step with the first.
 *
 * Token-guarded (`internalApiRoute`); the organization is the queue row's and
 * the scope is opened from it, so the token grants no cross-tenant reach.
 * Answers 409 `details.reason = 'legal_hold'` when a hold covers the chat (the
 * purger defers the row) and 502 when the external stores still fail (the
 * purger records the attempt).
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { retryConversationErasure } from '@/lib/conversations/service'

type Params = { id: string }

const eraseSchema = z.object({
  organizationId: z.string().min(1).max(128),
})

export const POST = internalApiRoute<Params>(
  'Internal Conversation Erase',
  async ({ request, params }) => {
    const { organizationId } = await parseJsonBody(request, eraseSchema)
    return withTenant({ organizationId }, () => retryConversationErasure(organizationId, params.id))
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
