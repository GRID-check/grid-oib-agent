/**
 * Conversation naming API — generate a ChatGPT-style title and OIB topic tags
 * for a conversation's opening exchange and persist them on the row. Thin
 * handler; the backend call and persistence live in
 * `@/lib/conversations/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { generateConversationTitle } from '@/lib/conversations/service'

type Params = { id: string }

const generateTitleSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .max(20),
  locale: z.string().optional(),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { messages, locale } = await parseJsonBody(request, generateTitleSchema)
    return generateConversationTitle(session, params.id, { messages, locale })
  },
  { authz: { enforcedBy: 'generateConversationTitle (requireResourceAccess)' } }
)
