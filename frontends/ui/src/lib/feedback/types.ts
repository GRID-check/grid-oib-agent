/**
 * Feedback domain — request/query schemas and shared constants (WS-7).
 *
 * Verdict/reason value sets live beside the table definition
 * (`@/lib/db/schema/answer-feedback`) so schema and validation can never
 * drift; this module wraps them in the zod shapes the routes parse.
 */

import { z } from 'zod'
import { ANSWER_FEEDBACK_REASONS, ANSWER_FEEDBACK_VERDICTS } from '@/lib/db/schema'

/** Client-side chat identifiers are short strings; keep abuse bounded. */
export const MAX_FEEDBACK_ID_LENGTH = 128

const messageIdSchema = z.string().trim().min(1).max(MAX_FEEDBACK_ID_LENGTH)
const conversationIdSchema = z.string().trim().min(1).max(MAX_FEEDBACK_ID_LENGTH)

/** POST /api/feedback/answers — upsert the caller's vote on one answer. */
export const upsertAnswerFeedbackSchema = z.object({
  messageId: messageIdSchema,
  verdict: z.enum(ANSWER_FEEDBACK_VERDICTS),
  /** Down-vote reason key; only meaningful with verdict 'down'. */
  reason: z.enum(ANSWER_FEEDBACK_REASONS).nullish(),
  conversationId: conversationIdSchema.nullish(),
  projectId: z.string().uuid().nullish(),
})

export type UpsertAnswerFeedbackInput = z.infer<typeof upsertAnswerFeedbackSchema>

/** DELETE /api/feedback/answers?messageId= — retract (toggle-off) a vote. */
export const retractAnswerFeedbackQuerySchema = z.object({
  messageId: messageIdSchema,
})

/** GET /api/feedback/answers?conversationId= — hydrate own votes for a chat. */
export const conversationFeedbackQuerySchema = z.object({
  conversationId: conversationIdSchema,
})

/** The wire shape the GET hydration route returns per vote. */
export interface AnswerFeedbackView {
  messageId: string
  verdict: (typeof ANSWER_FEEDBACK_VERDICTS)[number]
  reason: (typeof ANSWER_FEEDBACK_REASONS)[number] | null
}
