/**
 * Answer feedback as Langfuse scores: every thumb a user leaves on an answer is
 * also a score on the trace that produced the answer (ADR-0044, Amendment 3).
 *
 * The votes already live in `answer_feedback`, and the platform page reads them
 * there. What Langfuse adds is the other half of the question: the trace. A
 * down-voted answer next to its retrieval, its prompt version, its model and its
 * cost is something to diagnose; a down-vote alone is a number. Scoring the
 * trace also makes the vote filterable in Langfuse's own trace list and
 * dashboards, which is where the rest of answer quality is analysed.
 *
 * ## The score
 *
 * - `name`: `user-feedback`.
 * - `dataType: NUMERIC`, `value` 1 for helpful and 0 for not. Not BOOLEAN,
 *   although a thumb is binary: Langfuse aggregates a numeric score by its mean,
 *   and the mean of 1/0 IS the helpful rate, the figure the platform page
 *   headlines. A boolean score is charted as a true/false distribution, which
 *   answers the same question one step less directly.
 * - `comment`: the reason chip and the voter's own words (and what they
 *   expected, when they said), because that is what a person reads next to a
 *   trace. `metadata` carries the same as fields, for filtering.
 * - `id`: derived from the feedback row id (`feedbackScoreId`). Langfuse
 *   upserts a score by id, so a re-vote (the row is upserted in place and keeps
 *   its id) replaces the score instead of adding a second one, and a retraction
 *   deletes exactly this score.
 *
 * ## The rules that make it safe to call from the vote path
 *
 * - **Server only, never the browser.** The secret key is the project's
 *   ingestion key.
 * - **A no-op without configuration** (`langfuseApiConfig` returns null).
 * - **Never fails or slows the vote.** The callers fire and forget AFTER the
 *   database write; every call here is bounded (`SCORE_DEADLINE_MS`, one retry)
 *   and catches, logs and swallows its own failure.
 * - **Ordered per score.** A re-vote and a retraction a moment apart must reach
 *   Langfuse in that order, or the delete can land before the upsert and the
 *   score comes back. Calls for one score id are chained in this process.
 */

import 'server-only'
import { LangfuseClient } from '@langfuse/client'
import { langfuseApiConfig, type LangfuseApiConfig } from './config'

/** The score's name in Langfuse. A contract: dashboards and filters select it by name. */
export const FEEDBACK_SCORE_NAME = 'user-feedback'

/** The whole budget for one Langfuse call, retries included. Off the request path either way. */
export const SCORE_DEADLINE_MS = 5000
const ATTEMPT_TIMEOUT_SECONDS = 3
const MAX_RETRIES = 1

type ScoreRequest = Parameters<LangfuseClient['api']['scores']['create']>[0]

/** What a vote says, as far as its score is concerned. */
export interface FeedbackScoreInput {
  /** The `answer_feedback` row id; the score id is derived from it. */
  feedbackId: string
  /** The trace the rated answer was produced in (32 hex digits). */
  traceId: string
  verdict: 'up' | 'down'
  reason: string | null
  comment: string | null
  expectedAnswer: string | null
}

/** The Langfuse score id for one feedback row. Stable for the row's lifetime, so a re-vote upserts. */
export function feedbackScoreId(feedbackId: string): string {
  return `${FEEDBACK_SCORE_NAME}-${feedbackId}`
}

/** The text a person reads beside the trace: reason, then their words, then what they expected. */
function scoreComment(input: FeedbackScoreInput): string | undefined {
  const lines = [
    input.reason ? `reason: ${input.reason}` : null,
    input.comment?.trim() || null,
    input.expectedAnswer?.trim() ? `expected: ${input.expectedAnswer.trim()}` : null,
  ].filter((line): line is string => Boolean(line))
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** The vote as a Langfuse score. Pure, so the mapping is tested without a network. */
export function toFeedbackScore(input: FeedbackScoreInput): ScoreRequest {
  return {
    id: feedbackScoreId(input.feedbackId),
    traceId: input.traceId,
    name: FEEDBACK_SCORE_NAME,
    dataType: 'NUMERIC',
    value: input.verdict === 'up' ? 1 : 0,
    comment: scoreComment(input),
    metadata: {
      verdict: input.verdict,
      reason: input.reason,
      ...(input.expectedAnswer?.trim() ? { expected_answer: input.expectedAnswer.trim() } : {}),
    },
  }
}

/* ------------------------------------------------------------------ *
 * The client and the calls
 * ------------------------------------------------------------------ */

let cached: { key: string; client: LangfuseClient } | null = null

/** One client per configuration; rebuilt only if the keys or host change. */
function clientFor(config: LangfuseApiConfig): LangfuseClient {
  const key = `${config.baseUrl}\u0000${config.publicKey}\u0000${config.secretKey}`
  if (cached?.key !== key) {
    cached = {
      key,
      client: new LangfuseClient({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        timeout: ATTEMPT_TIMEOUT_SECONDS,
      }),
    }
  }
  return cached.client
}

const requestOptions = () => ({
  timeoutInSeconds: ATTEMPT_TIMEOUT_SECONDS,
  maxRetries: MAX_RETRIES,
  abortSignal: AbortSignal.timeout(SCORE_DEADLINE_MS),
})

/** The tail of the work queued per score id; see "Ordered per score" above. */
const inFlight = new Map<string, Promise<void>>()

/** Run `work` after whatever is already queued for `scoreId`, and never reject. */
function serialized(scoreId: string, what: string, work: () => Promise<unknown>): Promise<void> {
  const previous = inFlight.get(scoreId) ?? Promise.resolve()
  const next = previous
    .then(work)
    .then(
      () => undefined,
      (error: unknown) => {
        console.warn(`[Langfuse] ${what} failed for score ${scoreId} (non-fatal):`, error)
      }
    )
  inFlight.set(scoreId, next)
  void next.finally(() => {
    if (inFlight.get(scoreId) === next) inFlight.delete(scoreId)
  })
  return next
}

/**
 * Create or replace the vote's score. Resolves when Langfuse answered or the
 * attempt was given up; never rejects. Returns false when nothing was sent.
 */
export async function upsertFeedbackScore(input: FeedbackScoreInput): Promise<boolean> {
  const config = langfuseApiConfig()
  if (!config) return false
  const score = toFeedbackScore(input)
  await serialized(feedbackScoreId(input.feedbackId), 'score upsert', () =>
    clientFor(config).api.scores.create(score, requestOptions())
  )
  return true
}

/**
 * Delete the vote's score (the vote was retracted). A score that was never
 * written answers 404, which is the outcome wanted, so it is logged like any
 * other failure and otherwise ignored. Never rejects.
 */
export async function deleteFeedbackScore(feedbackId: string): Promise<boolean> {
  const config = langfuseApiConfig()
  if (!config) return false
  const scoreId = feedbackScoreId(feedbackId)
  await serialized(scoreId, 'score delete', () =>
    clientFor(config).api.legacy.scoreV1.delete(scoreId, requestOptions())
  )
  return true
}

/** Whether a call would be made at all; lets a caller skip the work of building one. */
export function feedbackScoringEnabled(): boolean {
  return langfuseApiConfig() !== null
}
