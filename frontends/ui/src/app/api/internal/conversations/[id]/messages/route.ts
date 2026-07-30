/**
 * INTERNAL service endpoint — the backend's fail-soft persist path for a
 * finished assistant turn whose client dropped mid-turn. Keeps grid_app
 * single-writer: the Python backend never touches the database; it POSTs here
 * over the compose network, authenticated by the shared service token
 * (GRID_INTERNAL_API_TOKEN on both services) instead of replaying the browser's
 * handshake cookie — that token expires on long deep-research turns and the old
 * cookie-replay POST would silently 401, dropping the answer.
 *
 * Not user-facing; requests without the token are rejected and the route fails
 * closed when the token is unconfigured (both enforced by `internalApiRoute`).
 * Tenancy is enforced in the service by resolving the conversation against the
 * caller-supplied `organizationId` — the token grants no cross-org bypass.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { persistInternalConversationMessages } from '@/lib/conversations/service'

type Params = { id: string }

const internalMessageSchema = z.object({
  // The conversation's owning org, forwarded by the backend from the WS
  // upgrade's `x-grid-organization-id`. Used to scope the conversation lookup.
  organizationId: z.string().min(1),
  // Client/backend-generated id; length-capped so caller-controlled strings
  // never reach the database unbounded. The backend derives this
  // deterministically per turn so a double-write no-ops (onConflictDoNothing).
  id: z.string().min(1).max(128),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  messageType: z.string().min(1).max(64).optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
})

export const POST = internalApiRoute<Params>(
  'Internal Conversation Messages',
  async ({ request, params }) => {
    const { organizationId, ...message } = await parseJsonBody(request, internalMessageSchema)
    const messages = await persistInternalConversationMessages(organizationId, params.id, [message])
    return { messages }
  },
  { status: 201 }
)
