/**
 * Conversation detail API — read, rename, and delete a single conversation.
 * Thin handlers; all logic lives in `@/lib/conversations/service`.
 */

import { z } from 'zod'
import { NotFoundError } from '@/lib/api/errors'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import {
  deleteConversation,
  getConversation,
  updateConversationEngagement,
  updateConversationTitle,
} from '@/lib/conversations/service'
import { CONVERSATION_ENGAGEMENTS } from '@/lib/db/schema'

type Params = { id: string }

/**
 * Either a rename or a change to when the agent answers (ADR-0036) — one PATCH,
 * because both are edits to the same resource. At least one field is required, so
 * an empty body is a 400 rather than a silent no-op that looks like success.
 */
const updateConversationSchema = z
  .object({
    title: z.string().min(1).optional(),
    engagement: z.enum(CONVERSATION_ENGAGEMENTS).optional(),
  })
  .refine((body) => body.title !== undefined || body.engagement !== undefined, {
    message: 'Provide title or engagement',
  })

export const GET = apiRoute<Params>(async ({ session, params }) => getConversation(session, params.id))

export const PATCH = apiRoute<Params>(async ({ session, params, request }) => {
  const body = await parseJsonBody(request, updateConversationSchema)
  // Engagement first: renaming needs `owner` while the mode needs only
  // `collaborator` (a thread stuck answering the wrong person must be fixable by
  // whoever is in the room), so a combined body must not be gated on the stricter
  // of the two for the looser change.
  if (body.engagement) {
    return updateConversationEngagement(session, params.id, body.engagement)
  }
  return updateConversationTitle(session, params.id, body.title!)
})

/**
 * DELETE answers **204 whether or not the conversation existed, and whether or not
 * it was the caller's** — one response, so it cannot be used as an existence
 * oracle (spec SH-6).
 *
 * Two constraints meet here and only this shape satisfies both. The chat store
 * deletes server rows for conversations that may only ever have lived in the
 * browser, so a genuinely-absent id must not surface an error. And a conversation
 * that exists in another tenant, or belongs to a colleague, must be
 * indistinguishable from absent — which the previous 204/404 split was not: it
 * told any signed-in member which guessed ids were real.
 *
 * The service still reports the truth (`NotFoundError`); the refusal is turned
 * into silence HERE, at the boundary that owns what the client learns. Nothing is
 * deleted in the refused case — `deleteConversation` throws before it writes.
 */
export const DELETE = apiRoute<Params>(async ({ session, params }) => {
  try {
    await deleteConversation(session, params.id)
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
  }
  return null
})
