/**
 * Conversation detail API — read, rename, and delete a single conversation.
 * Thin handlers; all logic lives in `@/lib/conversations/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { deleteConversation, getConversation, updateConversationTitle } from '@/lib/conversations/service'

type Params = { id: string }

const updateConversationSchema = z.object({
  title: z.string().min(1),
})

export const GET = apiRoute<Params>(async ({ session, params }) => getConversation(session, params.id))

export const PATCH = apiRoute<Params>(async ({ session, params, request }) => {
  const { title } = await parseJsonBody(request, updateConversationSchema)
  return updateConversationTitle(session, params.id, title)
})

export const DELETE = apiRoute<Params>(async ({ session, params }) => {
  await deleteConversation(session, params.id)
  return null
})
