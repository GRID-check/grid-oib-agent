/**
 * Conversation messages API — list a conversation's history and append
 * messages (single object or batch array; both return an array). Thin
 * handlers; all logic lives in `@/lib/conversations/service`.
 *
 * The POST response carries the server's addressee ruling on each persisted
 * message (`addressees`, `createdRequests`) alongside the row, so the client can
 * decide whether to open an agent turn (ADR-0034). Extra fields only — the array
 * shape existing callers expect is unchanged.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { createConversationMessages, listConversationMessages } from '@/lib/conversations/service'
import { MAX_MENTIONS_PER_MESSAGE } from '@/lib/sharing/rate-limit'

type Params = { id: string }

const mentionSchema = z.object({
  // A WorkOS user id or the agent's sentinel id; length-capped like every other
  // client-supplied identifier. Legitimacy is decided server-side, not here.
  targetId: z.string().min(1).max(128),
})

const createMessageSchema = z.object({
  // Client-generated id; length-capped so user-controlled strings never
  // reach the database unbounded.
  id: z.string().min(1).max(128),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  // UI display type (user, agent_response, …); stored in metadata so past
  // chats rehydrate with the right renderer. Length-capped like `id`.
  messageType: z.string().min(1).max(64).optional(),
  metadata: z.record(z.unknown()).optional(),
  // Kept as a plain string: the chat store sends both ISO strings and
  // `String(Date)` output, which `.datetime()` would reject.
  createdAt: z.string().optional(),
  // Structured mentions (spec MN-3) — never a text match on a name. The
  // addressee set is resolved from these server-side (spec MN-2).
  //
  // Bounded by the SAME constant the service enforces (`@/lib/sharing/rate-limit`
  // owns the product bound MN-13 asks for) so the two cannot drift: this schema
  // used to cap the array at 20 while the service refused anything over 10, which
  // meant an 11-mention message passed validation and then hit a 403. The two are
  // still both needed — this bounds the PAYLOAD, the service bounds the
  // DEDUPLICATED target count, which is the number the abuse bound is about.
  mentions: z.array(mentionSchema).max(MAX_MENTIONS_PER_MESSAGE).optional(),
  // The asker's question, carried into the recipient's inbox item (spec MN-12).
  mentionNote: z.string().max(500).nullable().optional(),
})

const createMessagesSchema = z.union([createMessageSchema, z.array(createMessageSchema).min(1)])

export const GET = apiRoute<Params>(
  async ({ session, params }) => listConversationMessages(session, params.id),
  { authz: { enforcedBy: 'listConversationMessages (requireResourceAccess)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, createMessagesSchema)
    const inputs = Array.isArray(body) ? body : [body]
    return createConversationMessages(session, params.id, inputs)
  },
  { status: 201, authz: { enforcedBy: 'createConversationMessages (requireResourceAccess)' } }
)
