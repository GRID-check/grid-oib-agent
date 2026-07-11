/**
 * Conversation messages API — list a conversation's history and append
 * messages (single object or batch array; both return an array). Thin
 * handlers; all logic lives in `@/lib/conversations/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { createConversationMessages, listConversationMessages } from '@/lib/conversations/service'

type Params = { id: string }

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
})

const createMessagesSchema = z.union([createMessageSchema, z.array(createMessageSchema).min(1)])

export const GET = apiRoute<Params>(async ({ session, params }) => listConversationMessages(session, params.id))

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, createMessagesSchema)
    const inputs = Array.isArray(body) ? body : [body]
    return createConversationMessages(session, params.id, inputs)
  },
  { status: 201 },
)
