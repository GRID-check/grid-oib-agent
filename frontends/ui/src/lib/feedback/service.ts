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
import { requirePlatformPermission } from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import {
  ANSWER_FEEDBACK_REASONS,
  ANSWER_FEEDBACK_VERDICTS,
  type AnswerFeedback,
} from '@/lib/db/schema'
import type { AnswerFeedbackView, UpsertAnswerFeedbackInput } from './types'
import {
  deleteAnswerFeedbackForUser,
  getAnswerFeedbackForUser,
  getAnswerTraceId,
  getFeedbackHealth,
  getPersistedAnswerConversationId,
  listAnswerFeedbackForConversation,
  upsertAnswerFeedback,
  type FeedbackHealth,
  type FeedbackOrgRollup,
  type FeedbackTurn,
} from './repository'
import type { FeedbackQuery } from './filters'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import { langfuseProjectUrl, langfuseTraceUrl, langfuseUiConfig } from '@/lib/langfuse/config'
import {
  deleteFeedbackScore,
  feedbackScoringEnabled,
  upsertFeedbackScore,
} from '@/lib/langfuse/feedback-score'
import { getFeedbackDigest, type FeedbackDigestOptions, type FeedbackDigestResult } from './digest'
import { resolveLessonsHoldout } from '@/lib/platform-lessons/holdout'
import { reopenReportForRedistillation } from '@/lib/platform-lessons/service'
import { implicateMemoryFromFeedback } from '@/lib/projects/memory-service'
import { memoryClearance } from '@/lib/projects/service'
import { maskChatText } from '@/lib/upload-screening/service'

/** Upsert the caller's vote on one assistant answer. */
export async function submitAnswerFeedback(
  session: AuthorizedSession,
  input: UpsertAnswerFeedbackInput
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
  if (input.verdict === 'up' && (input.comment || input.expectedAnswer)) {
    throw new BadRequestError('A comment is only valid with a down verdict.')
  }

  if (input.projectId) {
    // Also verifies the project belongs to the caller's org (404 otherwise).
    await requireProjectAccess(session, input.projectId, 'project:view')
  }

  // The conversation is the persisted answer's when there is one, not the
  // client's say-so: readers join topics and titles on it. A turn with no row
  // yet keeps the client's value rather than losing its vote (see the
  // repository note), and the readers prefer the answer row's either way.
  const conversationId =
    (await getPersistedAnswerConversationId(input.messageId, session.organizationId)) ??
    input.conversationId ??
    null

  // Which arm of the lessons experiment this turn was in, decided by the same
  // pure function the agent used when it chose whether to inject. Null when
  // the holdout is off, which is the default — see lib/platform-lessons/holdout.
  const lessonsHoldout = await resolveLessonsHoldout(conversationId)

  // Read the prior vote before the upsert: memory implication (below) must
  // fire on NEW complaint text only, or a re-saved identical comment would
  // penalize the same notes twice.
  const prior = await getAnswerFeedbackForUser(session.userId, input.messageId)

  // The comment is typed text, and it goes on to the embedder (memory
  // implication below, the lesson pipeline) and to the distilling model: stored
  // masked against the office's „Sensible Daten" policy (ADR-0086), like a chat
  // message. Masked before the comparison with `prior`, which was stored masked.
  const comment =
    input.verdict === 'down' && input.comment
      ? (await maskChatText(session.organizationId, input.comment)).text
      : null
  // The answer the person expected is typed text too, and it becomes an eval
  // case a model answers against (`feedback-to-cases`): masked the same way.
  const expectedAnswer =
    input.verdict === 'down' && input.expectedAnswer
      ? (await maskChatText(session.organizationId, input.expectedAnswer)).text
      : null

  const row = await upsertAnswerFeedback({
    lessonsHoldout,
    organizationId: session.organizationId,
    userId: session.userId,
    messageId: input.messageId,
    verdict: input.verdict,
    reason: input.verdict === 'down' ? (input.reason ?? null) : null,
    comment,
    expectedAnswer,
    conversationId,
    projectId: input.projectId ?? null,
  })
  // A re-vote that adds detail (a comment, a corrected reason) deserves another
  // look from the lesson pipeline: clear a previous "nothing to learn here"
  // verdict so the next sweep reconsiders the report. A report that already
  // produced a lesson is untouched. Fire-and-forget — the vote is the user's
  // business, this is ours.
  if (row.verdict === 'down') {
    void reopenReportForRedistillation(row.id)
  }

  // The memory half of feedback attribution: a fresh complaint implicates the
  // active notes it sits semantically next to, inside this tenant's own scope
  // (the raw comment never leaves it). Fire-and-forget like the sweep kick —
  // the vote is the user's business, this is ours.
  if (row.verdict === 'down' && row.comment && row.comment !== prior?.comment) {
    void implicateFeedbackMemory(session, row.projectId ?? null, row.comment)
  }

  // The vote as a score on the answer's Langfuse trace (ADR-0044, Amendment 3).
  // After the write, never awaited: Langfuse being slow or down must not cost
  // the voter anything, and the vote in the database is the record either way.
  // The prior verdict decides whether a down-vote is new enough to queue for
  // review (an edited complaint is not a second one).
  void scoreVoteInLangfuse(session.organizationId, row, prior?.verdict ?? null)

  return toView(row)
}

/**
 * Lower the salience of the notes a complaint sits next to, among the notes the
 * voter may see (ADR-0087): a member not cleared for a restricted folder cannot
 * see its notes, so their down-vote must not bury them for those who can.
 * Fire-and-forget like the call itself; never throws.
 */
async function implicateFeedbackMemory(
  session: AuthorizedSession,
  projectId: string | null,
  comment: string
): Promise<void> {
  try {
    const { cleared } = projectId ? await memoryClearance(session, projectId) : { cleared: [] }
    await implicateMemoryFromFeedback({
      organizationId: session.organizationId,
      projectId,
      comment,
      readableFolderIds: cleared,
    })
  } catch (error) {
    console.warn('[feedback] Memory implication skipped (non-fatal):', error)
  }
}

/**
 * Mirror one stored vote into Langfuse. Never rejects: the score is bookkeeping
 * about a vote that has already been recorded.
 *
 * Nothing is sent when Langfuse is not configured, and nothing when the answer's
 * row does not name its trace (an unpersisted turn, or one from before the agent
 * recorded traces): a score on a guessed trace id would attach to nothing.
 */
async function scoreVoteInLangfuse(
  organizationId: string,
  row: AnswerFeedback,
  previousVerdict: AnswerFeedback['verdict'] | null
): Promise<void> {
  if (!feedbackScoringEnabled()) return
  try {
    const traceId = await getAnswerTraceId(row.messageId, organizationId)
    if (!traceId) return
    await upsertFeedbackScore({
      feedbackId: row.id,
      traceId,
      verdict: row.verdict,
      reason: row.reason ?? null,
      comment: row.comment ?? null,
      expectedAnswer: row.expectedAnswer ?? null,
      previousVerdict,
    })
  } catch (error) {
    console.warn('[Feedback] Langfuse score failed (non-fatal):', error)
  }
}

/**
 * Toggle-off: retract the caller's vote. Idempotent — deleting a vote that
 * does not exist (already retracted in another tab) is a success.
 */
export async function retractAnswerFeedback(
  session: AuthorizedSession,
  messageId: string
): Promise<void> {
  const deletedId = await deleteAnswerFeedbackForUser(
    session.userId,
    messageId,
    session.organizationId
  )
  // Its Langfuse score goes with it, keyed by the row id the score was derived
  // from. Fire-and-forget, like the write; a no-op when Langfuse is not set up.
  if (deletedId) void deleteFeedbackScore(deletedId)
}

/** The caller's own votes in one conversation, for client-side hydration. */
export async function getOwnConversationFeedback(
  session: AuthorizedSession,
  conversationId: string
): Promise<AnswerFeedbackView[]> {
  const rows = await listAnswerFeedbackForConversation(
    session.userId,
    conversationId,
    session.organizationId
  )
  return rows.map(toView)
}

function toView(row: AnswerFeedback): AnswerFeedbackView {
  return {
    messageId: row.messageId,
    verdict: row.verdict,
    reason: row.reason ?? null,
    comment: row.comment ?? null,
    expectedAnswer: row.expectedAnswer ?? null,
  }
}

/**
 * The platform owner's cross-organization view of answer feedback.
 *
 * This is the one function in this service that is NOT tenant-scoped, and the
 * gate is therefore the whole of its authorization: `requirePlatformPermission`
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
/** One organization's rollup, named for the reader. */
export interface FeedbackOrgRollupView extends FeedbackOrgRollup {
  /** The organization's display name; null when the name lookup failed or missed. */
  organizationName: string | null
}

/** One voted turn, named for the reader. */
export interface FeedbackTurnView extends FeedbackTurn {
  /** The organization's display name; null when the name lookup failed or missed. */
  organizationName: string | null
  /**
   * The turn's trace in the Langfuse UI, where its vote is also a score. Null
   * when Langfuse links are not configured or the answer row names no trace.
   */
  langfuseTraceUrl: string | null
}

/** What the platform quality view is served: the aggregate, with the tenants named. */
export interface AnswerFeedbackHealthView extends Omit<FeedbackHealth, 'organizations' | 'turns'> {
  organizations: FeedbackOrgRollupView[]
  turns: FeedbackTurnView[]
  /**
   * The Langfuse project the votes are scored in (its scores dashboard lives
   * under it); null when Langfuse links are not configured.
   */
  langfuse: { projectUrl: string } | null
}

export async function getAnswerFeedbackHealth(
  session: GridSession | null,
  query: FeedbackQuery
): Promise<AnswerFeedbackHealthView> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsView)
  // The read groups BY organization across every tenant, so it must not run
  // pinned to the owner's active one — row-level security would quietly return
  // that org's rows, or none at all, and the page would look merely empty
  // rather than broken (ADR-0041). The gate above is the authorization this
  // bypass rests on; it sits here so no caller can reach the data without it.
  //
  // Names come from the same resolver citation health uses, so the two cards
  // never call one tenant two things. It fails soft to an empty map.
  const health = await withPlatformAccess('answer feedback: cross-organization quality view', () =>
    getFeedbackHealth(query)
  )
  // Resolved per id, not from one WorkOS list page, so a tenant past the first
  // hundred is still named.
  const names = await getOrganizationDisplayNames([
    ...health.organizations.map((org) => org.organizationId),
    ...health.turns.map((turn) => turn.organizationId),
  ])
  const nameOf = (organizationId: string): string | null => names.get(organizationId) ?? null
  const ui = langfuseUiConfig()
  const projectUrl = langfuseProjectUrl(ui)
  return {
    ...health,
    organizations: health.organizations.map((org) => ({
      ...org,
      organizationName: nameOf(org.organizationId),
    })),
    turns: health.turns.map((turn) => ({
      ...turn,
      organizationName: nameOf(turn.organizationId),
      langfuseTraceUrl: langfuseTraceUrl(turn.traceId, ui),
    })),
    langfuse: projectUrl ? { projectUrl } : null,
  }
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
  query: FeedbackQuery,
  options: FeedbackDigestOptions = {}
): Promise<FeedbackDigestResult> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsView)
  // The samples are read inside the same bypass as the figures: both are the
  // cross-organization read the gate above authorizes.
  return withPlatformAccess('answer feedback digest: cross-organization quality view', async () => {
    const health = await getFeedbackHealth(query, { turnLimit: 0 })
    return getFeedbackDigest(health, query, options)
  })
}
