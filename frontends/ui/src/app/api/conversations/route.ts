/**
 * Conversations API — list and create conversations for the current
 * organization. Thin handlers; all logic lives in
 * `@/lib/conversations/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { createConversation, listConversations } from '@/lib/conversations/service'

const createConversationSchema = z.object({
  // Client-generated id; length-capped so user-controlled strings never
  // reach the database unbounded.
  id: z.string().min(1).max(128),
  title: z.string().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
})

export const GET = apiRoute(async ({ session }) => listConversations(session))

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createConversationSchema)
    return createConversation(session, input)
  },
  { status: 201 },
)
