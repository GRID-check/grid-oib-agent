/**
 * Answer-feedback API — per-answer thumbs feedback (WS-7).
 * Thin transport adapters (ADR-0017); logic + authorization live in
 * `@/lib/feedback/service`. Gated by the `answer-feedback` feature flag
 * (fail-open while GRID_ENFORCE_FEATURE_FLAGS is off, like every flag).
 *
 * Voting model: POST = upsert (re-vote updates in place), DELETE = retract
 * (toggle-off removes the row), GET = the caller's own votes for one
 * conversation (client hydration).
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import {
  getOwnConversationFeedback,
  retractAnswerFeedback,
  submitAnswerFeedback,
} from '@/lib/feedback/service'
import {
  conversationFeedbackQuerySchema,
  retractAnswerFeedbackQuerySchema,
  upsertAnswerFeedbackSchema,
} from '@/lib/feedback/types'

export const GET = apiRoute(async ({ session, request }) => {
  const gated = requireFeature(session, FEATURE_FLAGS.answerFeedback)
  if (gated) return gated
  const { conversationId } = parseQuery(request, conversationFeedbackQuerySchema)
  return { feedback: await getOwnConversationFeedback(session, conversationId) }
})

export const POST = apiRoute(async ({ session, request }) => {
  const gated = requireFeature(session, FEATURE_FLAGS.answerFeedback)
  if (gated) return gated
  const input = await parseJsonBody(request, upsertAnswerFeedbackSchema)
  return submitAnswerFeedback(session, input)
})

export const DELETE = apiRoute(async ({ session, request }) => {
  const gated = requireFeature(session, FEATURE_FLAGS.answerFeedback)
  if (gated) return gated
  const { messageId } = parseQuery(request, retractAnswerFeedbackQuerySchema)
  await retractAnswerFeedback(session, messageId)
  return null // 204 — retraction is idempotent
})
