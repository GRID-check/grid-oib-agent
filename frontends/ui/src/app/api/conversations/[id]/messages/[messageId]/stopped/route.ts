/**
 * Stopped-answer API: cut the asker's answer to what they had on screen when
 * they pressed Stop, when the Stop crossed the agent's finished answer and the
 * stored row holds all of it. Thin handler; who may cut, and what the cut
 * keeps, live in `cutStoppedAnswer` (`@/lib/conversations/service`).
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { cutStoppedAnswer } from '@/lib/conversations/service'

type Params = { id: string; messageId: string }

/** `messages.id` is a uuid column: a malformed id must 400, not blow up in SQL. */
const messageIdSchema = z.string().uuid()

/**
 * Longer than any chat answer the reveal draws. The text is only compared
 * against the stored one, never stored, but it is still a client string and
 * gets a bound.
 */
const MAX_SHOWN_CHARS = 200_000

const cutSchema = z.object({
  /** The question that opened the turn: its id is the turn's, and it names the asker. */
  turnId: z.string().uuid(),
  /** The answer's text as it was on screen at the press. */
  shown: z.string().max(MAX_SHOWN_CHARS),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const messageId = messageIdSchema.safeParse(params.messageId)
    if (!messageId.success) throw new BadRequestError('Invalid message id')

    const body = await parseJsonBody(request, cutSchema)
    return cutStoppedAnswer(session, params.id, messageId.data, body)
  },
  { authz: { enforcedBy: 'cutStoppedAnswer (requireResourceAccess, asker of the turn)' } }
)
