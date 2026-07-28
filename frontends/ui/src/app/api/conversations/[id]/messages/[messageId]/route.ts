/**
 * Conversation message detail API — record the user's answers to an answer's
 * interactive cards. Thin handler; all logic lives in
 * `@/lib/conversations/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { updateMessageCardInteractions } from '@/lib/conversations/service'
import { CARD_DECISIONS } from '@/features/grid-cards/card-decision'

type Params = { id: string; messageId: string }

/** `messages.id` is a uuid column — a malformed id must 400, not blow up in SQL. */
const messageIdSchema = z.string().uuid()

/**
 * One answer carries a handful of cards, so a map this size is generous; the
 * cap exists because the value lands in a jsonb column and `z.record` bounds
 * key length but not key COUNT.
 */
const MAX_CARD_INTERACTIONS = 64

/**
 * Keys are `cardKey(card, index)` values (`memory_proposal-0`); the decision is
 * validated against the closed union so no free-form status can reach the
 * stored message, and `decidedAt` must be a real instant.
 */
const updateMessageSchema = z.object({
  cardInteractions: z
    .record(
      z.string().min(1).max(64),
      z.object({
        decision: z.enum(CARD_DECISIONS),
        decidedAt: z.string().datetime(),
      }),
    )
    .refine((map) => Object.keys(map).length <= MAX_CARD_INTERACTIONS, {
      message: `At most ${MAX_CARD_INTERACTIONS} card interactions per message`,
    }),
})

export const PATCH = apiRoute<Params>(async ({ session, params, request }) => {
  const messageId = messageIdSchema.safeParse(params.messageId)
  if (!messageId.success) throw new BadRequestError('Invalid message id')

  const { cardInteractions } = await parseJsonBody(request, updateMessageSchema)
  return updateMessageCardInteractions(session, params.id, messageId.data, cardInteractions)
})
