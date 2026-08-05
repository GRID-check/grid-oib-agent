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
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { requireProjectAccess } from '@/lib/authz/projects'
import { BadRequestError } from '@/lib/api/errors'
import { requirePlatformOwner } from '@/lib/authz/platform'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import {
  ANSWER_FEEDBACK_REASONS,
  ANSWER_FEEDBACK_VERDICTS,
  type AnswerFeedback,
} from '@/lib/db/schema'
import type { AnswerFeedbackView, UpsertAnswerFeedbackInput } from './types'
import {
  deleteAnswerFeedbackForUser,
  getFeedbackHealth,
  listAnswerFeedbackForConversation,
  upsertAnswerFeedback,
  type FeedbackHealth,
  type FeedbackHealthFilters,
} from './repository'
import {
  getFeedbackDigest,
  type FeedbackDigestOptions,
  type FeedbackDigestResult,
} from './digest'

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

/**
 * The platform owner's cross-organization view of answer feedback.
 *
 * This is the one function in this service that is NOT tenant-scoped, and the
 * gate is therefore the whole of its authorization: `requirePlatformOwner`
 * throws `PlatformAccessDeniedError` for everyone else, and the repository read
 * it wraps takes no `organizationId` at all. Keeping the guard here rather than
 * in the route means a second caller cannot reach the data by forgetting it.
 *
 * Why a platform surface and not an org one: thumbs are collected everywhere and
 * were, until now, readable nowhere — the product asked users for a signal and
 * then had no way to look at it. The reader is whoever is answerable for answer
 * quality across tenants, which is the same person the citation-health and
 * profiler surfaces on this page already serve.
 */
export async function getAnswerFeedbackHealth(
  session: GridSession | null,
  filters: FeedbackHealthFilters = {},
): Promise<FeedbackHealth> {
  await requirePlatformOwner(session)
  // The read groups BY organization across every tenant, so it must not run
  // pinned to the owner's active one — row-level security would quietly return
  // that org's rows, or none at all, and the page would look merely empty
  // rather than broken (ADR-0041). The gate above is the authorization this
  // bypass rests on; it sits here so no caller can reach the data without it.
  return withPlatformAccess('answer feedback: cross-organization quality view', () =>
    getFeedbackHealth(filters),
  )
}

/**
 * The same view, in sentences — see `./digest` for what is sent and why.
 *
 * Behind the SAME gate as the numbers, and for a sharper reason: the digest
 * reads across every tenant's questions at once and hands a model a summary of
 * all of them. Anyone who can read that can already read the underlying page.
 *
 * The aggregate is computed here and passed down rather than recomputed inside
 * the digest, so the sentences and the figures beside them can never describe
 * two different windows.
 */
export async function getAnswerFeedbackDigest(
  session: GridSession | null,
  filters: FeedbackHealthFilters = {},
  options: FeedbackDigestOptions = {},
): Promise<FeedbackDigestResult> {
  await requirePlatformOwner(session)
  const health = await withPlatformAccess(
    'answer feedback digest: cross-organization quality view',
    () => getFeedbackHealth({ ...filters, limit: 0 }),
  )
  return getFeedbackDigest(health, filters, options)
}
