/**
 * Session documents API — list the files attached to one conversation.
 * Thin handler; all logic lives in `@/lib/session-documents/service`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listSessionDocuments } from '@/lib/session-documents/service'

const listSessionDocumentsQuerySchema = z.object({
  conversationId: z.string().min(1),
})

export const GET = apiRoute(
  async ({ session, request }) => {
    const { conversationId } = parseQuery(request, listSessionDocumentsQuerySchema)
    return listSessionDocuments(session, conversationId)
  },
  { authz: { enforcedBy: 'listSessionDocuments (requireResourceAccess conversation:viewer)' } },
)
