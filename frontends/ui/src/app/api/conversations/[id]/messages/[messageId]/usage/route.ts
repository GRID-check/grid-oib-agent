/**
 * What one answer cost — the line in its details (`AnswerDetails`).
 *
 * GET — the credits billed for the answer (frozen at record time, ADR-0053),
 *       or on the organization's own key the tokens, plus the token split.
 *       `{ usage: null }` when no ledger row names the answer. Thin handler;
 *       the logic lives in `@/lib/budgets/service`.
 */

import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { getAnswerUsage } from '@/lib/budgets/service'

type Params = { id: string; messageId: string }

/** `messages.id` is a uuid; so is the answer id the backend derives. */
const messageIdSchema = z.string().uuid()

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const messageId = messageIdSchema.safeParse(params.messageId)
    if (!messageId.success) throw new BadRequestError('Invalid message id')
    return { usage: await getAnswerUsage(session, params.id, messageId.data) }
  },
  { authz: { enforcedBy: 'getAnswerUsage (requireResourceAccess)' } }
)
