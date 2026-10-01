/**
 * INTERNAL service endpoint — is this conversation still its asker's alone?
 * (ADR-0078.)
 *
 * The WebSocket upgrade puts a cleared member's restricted-folder collections
 * into the signed scope only on a conversation nobody else can read, and that
 * scope is fixed for the socket's life. Sharing the thread while the socket is
 * open would let the next turn write restricted content into a thread others
 * read and watch live. So the agent asks here before every turn whose signed
 * scope carries a restricted collection (`aiq_api.chat_socket`), and closes the
 * socket when the answer is no: the reconnect is signed a scope without them.
 *
 * `POST` with `{ organizationId, userId }` → `{ confined: boolean }`. A POST for
 * a read, like every other `/api/internal/*` call the agent makes, so the
 * organization travels in the body the tenancy contract reads it from.
 * Token-guarded (`internalApiRoute`); the lookup runs in that organization, so
 * the token grants no cross-tenant reach.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { conversationConfinedInOrg } from '@/lib/conversations/confinement'

type Params = { id: string }

const confinementSchema = z.object({
  organizationId: z.string().min(1).max(128),
  // The asker, as the BFF signed it into the socket's envelope.
  userId: z.string().min(1).max(128),
})

export const POST = internalApiRoute<Params>(
  'Internal Conversation Confinement',
  async ({ request, params }) => {
    const { organizationId, userId } = await parseJsonBody(request, confinementSchema)
    const confined = await withTenant({ organizationId }, () =>
      conversationConfinedInOrg(organizationId, userId, params.id)
    )
    return { confined }
  },
  { tenancy: { fromPayload: 'body.organizationId' } }
)
