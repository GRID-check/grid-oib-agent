/**
 * Feedback service — business logic + authorization for per-answer thumbs
 * feedback (WS-7; ADR-0017 repository/service architecture).
 *
 * Tenancy: every repository call is scoped by the session's organizationId
 * and userId — a user can only ever read or write their OWN votes. When a
 * vote carries a projectId, project membership is additionally enforced via
 * `requireProjectAccess` (view suffices: voting is reading-adjacent, not a
 * content mutation).
 *
 * Voting model (see schema/answer-feedback.ts): re-vote = upsert;
 * toggle-off = delete (idempotent — retracting a non-existent vote is a
 * no-op, so a double-click race never surfaces an error).
 */

import 'server-only'
import { requireProjectAccess } from '@/lib/authz/projects'
import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  ANSWER_FEEDBACK_REASONS,
  ANSWER_FEEDBACK_VERDICTS,
  type AnswerFeedback,
} from '@/lib/db/schema'
import type { AnswerFeedbackView, UpsertAnswerFeedbackInput } from './types'
import {
  deleteAnswerFeedbackForUser,
  listAnswerFeedbackForConversation,
  upsertAnswerFeedback,
} from './repository'

/** Upsert the caller's vote on one assistant answer. */
export async function submitAnswerFeedback(
  session: AuthorizedSession,
  input: UpsertAnswerFeedbackInput,
): Promise<AnswerFeedbackView> {
  // Defense in depth: the route's zod schema already constrains these, but a
  // service must not rely on its transport (validates verdict/reason itself).
  if (!ANSWER_FEEDBACK_VERDICTS.includes(input.verdict)) {
    throw new BadRequestError('Unknown verdict.')
  }
  if (input.reason != null && !ANSWER_FEEDBACK_REASONS.includes(input.reason)) {
    throw new BadRequestError('Unknown feedback reason.')
  }
  if (input.verdict === 'up' && input.reason != null) {
    throw new BadRequestError('A reason is only valid with a down verdict.')
  }

  if (input.projectId) {
    // Also verifies the project belongs to the caller's org (404 otherwise).
    await requireProjectAccess(session, input.projectId, 'project:view')
  }

  const row = await upsertAnswerFeedback({
    organizationId: session.organizationId,
    userId: session.userId,
    messageId: input.messageId,
    verdict: input.verdict,
    reason: input.verdict === 'down' ? (input.reason ?? null) : null,
    conversationId: input.conversationId ?? null,
    projectId: input.projectId ?? null,
  })
  return toView(row)
}

/**
 * Toggle-off: retract the caller's vote. Idempotent — deleting a vote that
 * does not exist (already retracted in another tab) is a success.
 */
export async function retractAnswerFeedback(session: AuthorizedSession, messageId: string): Promise<void> {
  await deleteAnswerFeedbackForUser(session.userId, messageId, session.organizationId)
}

/** The caller's own votes in one conversation, for client-side hydration. */
export async function getOwnConversationFeedback(
  session: AuthorizedSession,
  conversationId: string,
): Promise<AnswerFeedbackView[]> {
  const rows = await listAnswerFeedbackForConversation(
    session.userId,
    conversationId,
    session.organizationId,
  )
  return rows.map(toView)
}

function toView(row: AnswerFeedback): AnswerFeedbackView {
  return { messageId: row.messageId, verdict: row.verdict, reason: row.reason ?? null }
}
