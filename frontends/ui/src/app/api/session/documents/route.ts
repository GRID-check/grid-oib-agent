/**
 * Session documents API — list the files attached to one conversation.
 * Thin handler; all logic lives in `@/lib/session-documents/service`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listSessionDocuments } from '@/lib/session-documents/service'
import { conversationIdSchema } from './conversation-id'

const listSessionDocumentsQuerySchema = z.object({
  // Not `z.string().min(1)`: a non-empty string is not a conversation id, and
  // this one reaches a database comparison and a collection name. Not
  // `z.string().uuid()` either — see `./conversation-id` for why that would
  // break the feature rather than tighten it.
  conversationId: conversationIdSchema,
})

export const GET = apiRoute(
  async ({ session, request }) => {
    const { conversationId } = parseQuery(request, listSessionDocumentsQuerySchema)
    return listSessionDocuments(session, conversationId)
  },
  { authz: { enforcedBy: 'listSessionDocuments (requireResourceAccess conversation:viewer)' } },
)
