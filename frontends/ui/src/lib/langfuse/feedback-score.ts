/**
 * Answer feedback in Langfuse: every thumb a user leaves on an answer is also a
 * score on the trace that produced the answer, and every down-voted answer is
 * put in front of a human reviewer (ADR-0044, Amendment 3).
 *
 * The votes already live in `answer_feedback`, and the platform page reads them
 * there. What Langfuse adds is the other half of the question: the trace. A
 * down-voted answer next to its retrieval, its prompt version, its model and its
 * cost is something to diagnose; a down-vote alone is a number. Scoring the
 * trace also makes the vote filterable in Langfuse's own trace list and
 * dashboards, which is where the business analysts and domain experts analyse
 * answer quality.
 *
 * ## The scores
 *
 * `user-feedback`, on every vote:
 *
 * - `dataType: NUMERIC`, `value` 1 for helpful and 0 for not. Not BOOLEAN,
 *   although a thumb is binary: Langfuse aggregates a numeric score by its mean,
 *   and the mean of 1/0 IS the helpful rate, the figure the platform page
 *   headlines. A boolean score is charted as a true/false distribution, which
 *   answers the same question one step less directly.
 * - `comment`: the reason chip and the voter's own words (and what they
 *   expected, when they said), because that is what a person reads next to a
 *   trace. `metadata` carries the same as fields, for filtering.
 *
 * `user-feedback-reason`, on down-votes only:
 *
 * - `dataType: CATEGORICAL`, `value` the reason key (`inaccurate`,
 *   `wrong_source`, `too_slow`, `other`). A down-vote without a reason is
 *   `other`, the way the platform page and the export count it
 *   (`coalesce(reason, 'other')`). Its own score because Langfuse charts a
 *   categorical score as a distribution and filters by its value; the reason
 *   inside the numeric score's comment or metadata is neither.
 * - A re-vote to up, or a retraction, deletes it: an answer that is now helpful
 *   has no reason it was not.
 *
 * Both ids are derived from the feedback row id (`feedbackScoreId`,
 * `feedbackReasonScoreId`). Langfuse upserts a score by id, so a re-vote (the
 * row is upserted in place and keeps its id) replaces the score instead of
 * adding a second one, and a retraction deletes exactly these scores. Neither
 * sets `source`, so both are `API`, which is what tells them apart from the
 * reviewers' `ANNOTATION` scores in the queue below.
 *
 * ## The review queue
 *
 * A down-vote also adds the trace to the annotation queue named
 * `answer-review` (`REVIEW_QUEUE_NAME`), where the Fachbereich reviews it. The
 * queue is provisioned outside this module (`task langfuse:provision`); here it
 * is found by name, and the id (or its absence) is cached for
 * `QUEUE_CACHE_TTL_MS`, so a missing queue costs one lookup per window, not one
 * per vote. Without the queue nothing is enqueued, and the miss is logged once
 * (until a later lookup finds the queue, after which a new miss logs again).
 *
 * Langfuse's queue-item endpoint takes no client id and the API offers no
 * filter by object, so an add cannot be made idempotent the way a score is.
 * Duplicates are avoided at the source instead: the trace is enqueued only when
 * the vote BECOMES a down-vote (`previousVerdict` is not `down`), so editing
 * the comment or reason of a standing down-vote adds nothing. Down, retract,
 * down again does add a second item; that is a second complaint about the same
 * answer, and the earlier item may already be completed. A retraction leaves
 * the item in the queue: the vote is gone, the answer a user disliked is not.
 *
 * ## The rules that make it safe to call from the vote path
 *
 * - **Server only, never the browser.** The secret key is the project's
 *   ingestion key.
 * - **A no-op without configuration** (`langfuseApiConfig` returns null).
 * - **Never fails or slows the vote.** The callers fire and forget AFTER the
 *   database write; every call here is bounded (`SCORE_DEADLINE_MS`, one retry)
 *   and catches, logs and swallows its own failure. A delete that answers 404
 *   found nothing to delete, which is the outcome wanted, and is not logged.
 * - **Ordered per score.** A re-vote and a retraction a moment apart must reach
 *   Langfuse in that order, or the delete can land before the upsert and the
 *   score comes back. Calls for one score id are chained in this process.
 */

import 'server-only'
import { LangfuseClient } from '@langfuse/client'
import { langfuseApiConfig, type LangfuseApiConfig } from './config'

/** The score's name in Langfuse. A contract: dashboards and filters select it by name. */
export const FEEDBACK_SCORE_NAME = 'user-feedback'

/** The down-vote reason's score name in Langfuse. A contract, like `FEEDBACK_SCORE_NAME`. */
export const FEEDBACK_REASON_SCORE_NAME = 'user-feedback-reason'

/** What a down-vote without a reason counts as, here and on the platform page. */
export const FALLBACK_REASON = 'other'

/** The annotation queue down-voted answers land in. Created by `task langfuse:provision`. */
export const REVIEW_QUEUE_NAME = 'answer-review'

/** How long a queue lookup, found or not, is trusted before it is repeated. */
export const QUEUE_CACHE_TTL_MS = 10 * 60 * 1000

/** The whole budget for one Langfuse call, retries included. Off the request path either way. */
export const SCORE_DEADLINE_MS = 5000
const ATTEMPT_TIMEOUT_SECONDS = 3
const MAX_RETRIES = 1

/** Queues are listed this many at a time, and no further than this many pages. */
const QUEUE_PAGE_SIZE = 100
const MAX_QUEUE_PAGES = 10

type ScoreRequest = Parameters<LangfuseClient['api']['scores']['create']>[0]

/** What a vote says, as far as Langfuse is concerned. */
export interface FeedbackScoreInput {
  /** The `answer_feedback` row id; the score ids are derived from it. */
  feedbackId: string
  /** The trace the rated answer was produced in (32 hex digits). */
  traceId: string
  verdict: 'up' | 'down'
  reason: string | null
  comment: string | null
  expectedAnswer: string | null
  /**
   * The verdict this user's row held before this vote, or null for a first
   * vote. A down-vote enqueues the trace for review only when this is not
   * `down`; left out, the vote is treated as new.
   */
  previousVerdict?: 'up' | 'down' | null
}

/** The Langfuse score id for one feedback row. Stable for the row's lifetime, so a re-vote upserts. */
export function feedbackScoreId(feedbackId: string): string {
  return `${FEEDBACK_SCORE_NAME}-${feedbackId}`
}

/** The reason score's id for one feedback row. Stable like `feedbackScoreId`. */
export function feedbackReasonScoreId(feedbackId: string): string {
  return `${FEEDBACK_REASON_SCORE_NAME}-${feedbackId}`
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

/**
 * A down-vote's reason as a CATEGORICAL score, or null for an up-vote (which
 * has none). `metadata.reason` keeps what was actually chosen, so a defaulted
 * `other` stays distinguishable from a chosen one. Pure, like `toFeedbackScore`.
 */
export function toFeedbackReasonScore(input: FeedbackScoreInput): ScoreRequest | null {
  if (input.verdict !== 'down') return null
  return {
    id: feedbackReasonScoreId(input.feedbackId),
    traceId: input.traceId,
    name: FEEDBACK_REASON_SCORE_NAME,
    dataType: 'CATEGORICAL',
    value: input.reason ?? FALLBACK_REASON,
    metadata: { verdict: input.verdict, reason: input.reason },
  }
}

/** Whether this vote should put its trace in the review queue; see "The review queue" above. */
export function shouldEnqueueForReview(input: FeedbackScoreInput): boolean {
  return input.verdict === 'down' && input.previousVerdict !== 'down'
}

/* ------------------------------------------------------------------ *
 * The client and the calls
 * ------------------------------------------------------------------ */

let cached: { key: string; client: LangfuseClient } | null = null

const configKey = (config: LangfuseApiConfig): string =>
  `${config.baseUrl}\u0000${config.publicKey}\u0000${config.secretKey}`

/** One client per configuration; rebuilt only if the keys or host change. */
function clientFor(config: LangfuseApiConfig): LangfuseClient {
  const key = configKey(config)
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

/** Langfuse answered 404: for a delete, nothing was there, which is what a delete wants. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'statusCode' in error && error.statusCode === 404
}

/** Run `work`, and never reject: a failure is logged and swallowed. */
function quietly(what: string, subject: string, work: () => Promise<unknown>): Promise<void> {
  return work().then(
    () => undefined,
    (error: unknown) => {
      console.warn(`[Langfuse] ${what} failed for ${subject} (non-fatal):`, error)
    }
  )
}

/** The tail of the work queued per score id; see "Ordered per score" above. */
const inFlight = new Map<string, Promise<void>>()

/** Run `work` after whatever is already queued for `scoreId`, and never reject. */
function serialized(scoreId: string, what: string, work: () => Promise<unknown>): Promise<void> {
  const previous = inFlight.get(scoreId) ?? Promise.resolve()
  const next = previous.then(() => quietly(what, `score ${scoreId}`, work))
  inFlight.set(scoreId, next)
  void next.finally(() => {
    if (inFlight.get(scoreId) === next) inFlight.delete(scoreId)
  })
  return next
}

function upsertScore(config: LangfuseApiConfig, scoreId: string, score: ScoreRequest): Promise<void> {
  return serialized(scoreId, 'score upsert', () =>
    clientFor(config).api.scores.create(score, requestOptions())
  )
}

function deleteScore(config: LangfuseApiConfig, scoreId: string): Promise<void> {
  return serialized(scoreId, 'score delete', async () => {
    try {
      await clientFor(config).api.legacy.scoreV1.delete(scoreId, requestOptions())
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  })
}

/* ------------------------------------------------------------------ *
 * The review queue
 * ------------------------------------------------------------------ */

let queueLookup: { key: string; queueId: string | null; expiresAt: number } | null = null
let pendingLookup: { key: string; promise: Promise<string | null> } | null = null
let queueMissLogged = false

/** Walk the project's queues for `REVIEW_QUEUE_NAME`. Null when it is not there. */
async function findReviewQueueId(client: LangfuseClient): Promise<string | null> {
  for (let page = 1; page <= MAX_QUEUE_PAGES; page += 1) {
    const { data, meta } = await client.api.annotationQueues.listQueues(
      { page, limit: QUEUE_PAGE_SIZE },
      requestOptions()
    )
    const match = data.find((queue) => queue.name === REVIEW_QUEUE_NAME)
    if (match) return match.id
    if (page >= meta.totalPages) return null
  }
  return null
}

function rememberLookup(key: string, queueId: string | null): void {
  queueLookup = { key, queueId, expiresAt: Date.now() + QUEUE_CACHE_TTL_MS }
  if (queueId) {
    queueMissLogged = false
  } else if (!queueMissLogged) {
    queueMissLogged = true
    // warn, not info: the repo's no-console allow-list has no info, and once
    // per process is quiet enough for a deployment that is not provisioned yet.
    console.warn(
      `[Langfuse] No annotation queue named "${REVIEW_QUEUE_NAME}"; down-votes are not queued for review ` +
        '(run `task langfuse:provision`).'
    )
  }
}

/**
 * The review queue's id, cached for `QUEUE_CACHE_TTL_MS` whether it was found
 * or not. Concurrent votes share one lookup. A failed lookup is not cached, so
 * an outage is not mistaken for a missing queue; it rejects to the caller.
 */
function resolveReviewQueueId(config: LangfuseApiConfig): Promise<string | null> {
  const key = configKey(config)
  if (queueLookup?.key === key && queueLookup.expiresAt > Date.now()) {
    return Promise.resolve(queueLookup.queueId)
  }
  if (pendingLookup?.key === key) return pendingLookup.promise
  const promise = findReviewQueueId(clientFor(config)).then((queueId) => {
    rememberLookup(key, queueId)
    return queueId
  })
  pendingLookup = { key, promise }
  void promise
    .finally(() => {
      if (pendingLookup?.promise === promise) pendingLookup = null
    })
    .catch(() => undefined)
  return promise
}

function enqueueForReview(config: LangfuseApiConfig, traceId: string): Promise<void> {
  return quietly('review enqueue', `trace ${traceId}`, async () => {
    const queueId = await resolveReviewQueueId(config)
    if (!queueId) return
    await clientFor(config).api.annotationQueues.createQueueItem(
      queueId,
      { objectId: traceId, objectType: 'TRACE' },
      requestOptions()
    )
  })
}

/** Forget the cached queue lookup. Tests only: the cache is process state. */
export function resetReviewQueueCacheForTests(): void {
  queueLookup = null
  pendingLookup = null
  queueMissLogged = false
}

/* ------------------------------------------------------------------ *
 * What the vote path calls
 * ------------------------------------------------------------------ */

/**
 * Mirror a vote into Langfuse: create or replace its score, write or delete its
 * reason score, and queue a fresh down-vote for review. Resolves when Langfuse
 * answered or each attempt was given up; never rejects. Returns false when
 * nothing was sent.
 */
export async function upsertFeedbackScore(input: FeedbackScoreInput): Promise<boolean> {
  const config = langfuseApiConfig()
  if (!config) return false
  const reasonScore = toFeedbackReasonScore(input)
  const reasonScoreId = feedbackReasonScoreId(input.feedbackId)
  await Promise.all([
    upsertScore(config, feedbackScoreId(input.feedbackId), toFeedbackScore(input)),
    reasonScore
      ? upsertScore(config, reasonScoreId, reasonScore)
      : deleteScore(config, reasonScoreId),
    shouldEnqueueForReview(input) ? enqueueForReview(config, input.traceId) : Promise.resolve(),
  ])
  return true
}

/**
 * Delete the vote's scores (the vote was retracted): the score and, if there
 * was one, the reason score. A score that was never written answers 404, which
 * is the outcome wanted. The review-queue item stays. Never rejects.
 */
export async function deleteFeedbackScore(feedbackId: string): Promise<boolean> {
  const config = langfuseApiConfig()
  if (!config) return false
  await Promise.all([
    deleteScore(config, feedbackScoreId(feedbackId)),
    deleteScore(config, feedbackReasonScoreId(feedbackId)),
  ])
  return true
}

/** Whether a call would be made at all; lets a caller skip the work of building one. */
export function feedbackScoringEnabled(): boolean {
  return langfuseApiConfig() !== null
}
