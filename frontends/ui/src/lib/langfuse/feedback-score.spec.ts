/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const api = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  listQueues: vi.fn(),
  createQueueItem: vi.fn(),
  constructed: vi.fn(),
}))

vi.mock('@langfuse/client', () => ({
  LangfuseClient: class {
    api = {
      scores: { create: api.create },
      legacy: { scoreV1: { delete: api.remove } },
      annotationQueues: { listQueues: api.listQueues, createQueueItem: api.createQueueItem },
    }
    constructor(params: unknown) {
      api.constructed(params)
    }
  },
}))

import {
  FEEDBACK_REASON_SCORE_NAME,
  FEEDBACK_SCORE_NAME,
  QUEUE_CACHE_TTL_MS,
  REVIEW_QUEUE_NAME,
  SCORE_DEADLINE_MS,
  deleteFeedbackScore,
  feedbackReasonScoreId,
  feedbackScoreId,
  resetReviewQueueCacheForTests,
  shouldEnqueueForReview,
  toFeedbackReasonScore,
  toFeedbackScore,
  upsertFeedbackScore,
  type FeedbackScoreInput,
} from './feedback-score'

const TRACE = '6135ac80f26d5f7dab0f1633fe313293'
const vote = (overrides: Partial<FeedbackScoreInput> = {}): FeedbackScoreInput => ({
  feedbackId: '9b2f1c7e-0000-4000-8000-000000000001',
  traceId: TRACE,
  verdict: 'down',
  reason: 'inaccurate',
  comment: 'R 60, nicht R 90',
  expectedAnswer: null,
  ...overrides,
})

const configure = () => {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-1')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-1')
  vi.stubEnv('LANGFUSE_HOST', 'http://langfuse-web:3000')
}

const QUEUE_ID = 'cmq-answer-review'
const queuePage = (names: string[], page = 1, totalPages = 1) => ({
  data: names.map((name) => ({
    id: name === REVIEW_QUEUE_NAME ? QUEUE_ID : `cmq-${name}`,
    name,
    description: null,
    scoreConfigIds: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  })),
  meta: { page, limit: 100, totalItems: names.length, totalPages },
})

/** A Langfuse API error as the client throws it: an Error carrying the HTTP status. */
const httpError = (statusCode: number) => Object.assign(new Error(`Status code: ${statusCode}`), { statusCode })

beforeEach(() => {
  api.create.mockReset().mockResolvedValue({ id: 'ignored' })
  api.remove.mockReset().mockResolvedValue(undefined)
  api.listQueues.mockReset().mockResolvedValue(queuePage(['triage', REVIEW_QUEUE_NAME]))
  api.createQueueItem.mockReset().mockResolvedValue({ id: 'item-1' })
  api.constructed.mockReset()
  resetReviewQueueCacheForTests()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** The scores sent, by name. */
const sentScores = (name: string) =>
  api.create.mock.calls.map(([score]) => score).filter((score) => score.name === name)

describe('toFeedbackScore', () => {
  it('maps a thumb to a NUMERIC user-feedback score of 1 or 0 on the trace', () => {
    expect(toFeedbackScore(vote({ verdict: 'up', reason: null, comment: null }))).toEqual({
      id: feedbackScoreId(vote().feedbackId),
      traceId: TRACE,
      name: 'user-feedback',
      dataType: 'NUMERIC',
      value: 1,
      comment: undefined,
      metadata: { verdict: 'up', reason: null },
    })
    expect(toFeedbackScore(vote()).value).toBe(0)
    expect(FEEDBACK_SCORE_NAME).toBe('user-feedback')
  })

  it('writes the reason and the free text as the comment, and what was expected', () => {
    const score = toFeedbackScore(vote({ expectedAnswer: '  R 60 laut OIB-RL 2  ' }))
    expect(score.comment).toBe('reason: inaccurate\nR 60, nicht R 90\nexpected: R 60 laut OIB-RL 2')
    expect(score.metadata).toEqual({
      verdict: 'down',
      reason: 'inaccurate',
      expected_answer: 'R 60 laut OIB-RL 2',
    })
  })

  it('leaves out blank text rather than writing empty lines', () => {
    expect(toFeedbackScore(vote({ reason: null, comment: '   ' })).comment).toBeUndefined()
  })
})

describe('feedbackScoreId', () => {
  /** Langfuse upserts by score id: a re-vote replaces, a retraction finds the same score. */
  it('is a pure function of the feedback row id', () => {
    const id = vote().feedbackId
    expect(feedbackScoreId(id)).toBe(feedbackScoreId(id))
    expect(feedbackScoreId(id)).toBe(`user-feedback-${id}`)
    expect(feedbackScoreId('other-row')).not.toBe(feedbackScoreId(id))
    expect(toFeedbackScore(vote({ verdict: 'up' })).id).toBe(toFeedbackScore(vote({ verdict: 'down' })).id)
  })
})

describe('without configuration', () => {
  it('sends nothing, queues nothing and builds no client', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '')
    vi.stubEnv('LANGFUSE_SECRET_KEY', '')
    vi.stubEnv('LANGFUSE_HOST', '')

    await expect(upsertFeedbackScore(vote())).resolves.toBe(false)
    await expect(upsertFeedbackScore(vote({ verdict: 'up', reason: null }))).resolves.toBe(false)
    await expect(deleteFeedbackScore(vote().feedbackId)).resolves.toBe(false)
    expect(api.constructed).not.toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
    expect(api.remove).not.toHaveBeenCalled()
    expect(api.listQueues).not.toHaveBeenCalled()
    expect(api.createQueueItem).not.toHaveBeenCalled()
  })
})

describe('with configuration', () => {
  beforeEach(configure)

  it('creates the score against the configured host, bounded in time', async () => {
    await expect(upsertFeedbackScore(vote())).resolves.toBe(true)

    expect(api.constructed).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: 'pk-lf-1', secretKey: 'sk-lf-1', baseUrl: 'http://langfuse-web:3000' })
    )
    const [score, options] = api.create.mock.calls[0]
    expect(score).toEqual(toFeedbackScore(vote()))
    expect(options).toMatchObject({ timeoutInSeconds: expect.any(Number), maxRetries: 1 })
    expect(options.timeoutInSeconds * 1000).toBeLessThanOrEqual(SCORE_DEADLINE_MS)
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('deletes the score derived from the retracted row', async () => {
    await expect(deleteFeedbackScore(vote().feedbackId)).resolves.toBe(true)
    expect(api.remove).toHaveBeenCalledWith(feedbackScoreId(vote().feedbackId), expect.any(Object))
  })

  /** A Langfuse outage must never surface in the vote that triggered it. */
  it('swallows and logs a failure instead of rejecting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.create.mockRejectedValueOnce(new Error('503 from Langfuse'))
    api.remove.mockRejectedValueOnce(new Error('404 score not found'))

    await expect(upsertFeedbackScore(vote())).resolves.toBe(true)
    await expect(deleteFeedbackScore(vote().feedbackId)).resolves.toBe(true)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  /**
   * Re-vote then retract, a moment apart: the delete must not overtake the
   * upsert, or Langfuse ends up holding a score for a vote that no longer exists.
   */
  it('keeps calls for one score in the order they were made', async () => {
    const order: string[] = []
    const scoreId = feedbackScoreId(vote().feedbackId)
    let releaseCreate!: () => void
    api.create.mockImplementation((score: { id: string }) =>
      score.id === scoreId
        ? new Promise<void>((resolve) => {
            releaseCreate = () => {
              order.push('create')
              resolve()
            }
          })
        : Promise.resolve({ id: score.id })
    )
    api.remove.mockImplementation(async (id: string) => {
      if (id === scoreId) order.push('delete')
    })

    const created = upsertFeedbackScore(vote())
    const deleted = deleteFeedbackScore(vote().feedbackId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.remove).not.toHaveBeenCalledWith(scoreId, expect.anything())

    releaseCreate()
    await Promise.all([created, deleted])
    expect(order).toEqual(['create', 'delete'])
  })

  it('does not hold one score behind another', async () => {
    api.create.mockImplementationOnce(() => new Promise(() => {}))
    void upsertFeedbackScore(vote({ feedbackId: 'stuck' }))
    await expect(upsertFeedbackScore(vote({ feedbackId: 'free' }))).resolves.toBe(true)
  })
})

describe('toFeedbackReasonScore', () => {
  it('maps a down-vote to a CATEGORICAL user-feedback-reason score on the trace', () => {
    expect(toFeedbackReasonScore(vote({ reason: 'wrong_source' }))).toEqual({
      id: feedbackReasonScoreId(vote().feedbackId),
      traceId: TRACE,
      name: 'user-feedback-reason',
      dataType: 'CATEGORICAL',
      value: 'wrong_source',
      metadata: { verdict: 'down', reason: 'wrong_source' },
    })
    expect(FEEDBACK_REASON_SCORE_NAME).toBe('user-feedback-reason')
  })

  /** The platform page and the export count a reasonless down-vote as `other`; so does Langfuse. */
  it('scores a down-vote without a reason as other, and keeps that it had none', () => {
    const score = toFeedbackReasonScore(vote({ reason: null }))
    expect(score?.value).toBe('other')
    expect(score?.metadata).toEqual({ verdict: 'down', reason: null })
  })

  it('has no reason score for an up-vote', () => {
    expect(toFeedbackReasonScore(vote({ verdict: 'up', reason: null }))).toBeNull()
  })

  it('derives its id from the feedback row, apart from the vote score', () => {
    const id = vote().feedbackId
    expect(feedbackReasonScoreId(id)).toBe(`user-feedback-reason-${id}`)
    expect(feedbackReasonScoreId(id)).not.toBe(feedbackScoreId(id))
  })
})

describe('shouldEnqueueForReview', () => {
  it('queues a vote that becomes a down-vote, and nothing else', () => {
    expect(shouldEnqueueForReview(vote())).toBe(true)
    expect(shouldEnqueueForReview(vote({ previousVerdict: null }))).toBe(true)
    expect(shouldEnqueueForReview(vote({ previousVerdict: 'up' }))).toBe(true)
    expect(shouldEnqueueForReview(vote({ previousVerdict: 'down' }))).toBe(false)
    expect(shouldEnqueueForReview(vote({ verdict: 'up', reason: null }))).toBe(false)
  })
})

describe('the reason score, with configuration', () => {
  beforeEach(configure)

  it('is written beside the vote score on a down-vote, bounded like it', async () => {
    await expect(upsertFeedbackScore(vote())).resolves.toBe(true)

    expect(sentScores(FEEDBACK_SCORE_NAME)).toEqual([toFeedbackScore(vote())])
    expect(sentScores(FEEDBACK_REASON_SCORE_NAME)).toEqual([toFeedbackReasonScore(vote())])
    for (const [, options] of api.create.mock.calls) {
      expect(options).toMatchObject({ maxRetries: 1, abortSignal: expect.any(AbortSignal) })
    }
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('is deleted when the vote is changed to up', async () => {
    await upsertFeedbackScore(vote({ verdict: 'up', reason: null, comment: null, previousVerdict: 'down' }))

    expect(sentScores(FEEDBACK_SCORE_NAME)).toHaveLength(1)
    expect(sentScores(FEEDBACK_REASON_SCORE_NAME)).toHaveLength(0)
    expect(api.remove).toHaveBeenCalledWith(feedbackReasonScoreId(vote().feedbackId), expect.any(Object))
  })

  it('is deleted with the vote score when the vote is retracted', async () => {
    await deleteFeedbackScore(vote().feedbackId)
    expect(api.remove.mock.calls.map(([id]) => id).sort()).toEqual(
      [feedbackScoreId(vote().feedbackId), feedbackReasonScoreId(vote().feedbackId)].sort()
    )
  })

  /** An up-vote that never had a reason deletes a score that is not there: the outcome wanted. */
  it('does not log a delete that found nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.remove.mockRejectedValue(httpError(404))

    await expect(upsertFeedbackScore(vote({ verdict: 'up', reason: null, comment: null }))).resolves.toBe(true)
    await expect(deleteFeedbackScore(vote().feedbackId)).resolves.toBe(true)
    expect(warn).not.toHaveBeenCalled()

    api.remove.mockRejectedValueOnce(httpError(500))
    await deleteFeedbackScore(vote().feedbackId)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('is ordered against its own delete like the vote score', async () => {
    const reasonId = feedbackReasonScoreId(vote().feedbackId)
    const order: string[] = []
    let release!: () => void
    api.create.mockImplementation((score: { id: string }) =>
      score.id === reasonId
        ? new Promise<void>((resolve) => {
            release = () => {
              order.push('create')
              resolve()
            }
          })
        : Promise.resolve({ id: score.id })
    )
    api.remove.mockImplementation(async (id: string) => {
      if (id === reasonId) order.push('delete')
    })

    const created = upsertFeedbackScore(vote())
    const deleted = upsertFeedbackScore(vote({ verdict: 'up', reason: null, comment: null }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.remove).not.toHaveBeenCalledWith(reasonId, expect.anything())

    release()
    await Promise.all([created, deleted])
    expect(order).toEqual(['create', 'delete'])
  })
})

describe('the review queue, with configuration', () => {
  beforeEach(configure)

  it('adds a down-voted trace to the answer-review queue, bounded in time', async () => {
    await upsertFeedbackScore(vote())

    expect(REVIEW_QUEUE_NAME).toBe('answer-review')
    expect(api.createQueueItem).toHaveBeenCalledTimes(1)
    const [queueId, item, options] = api.createQueueItem.mock.calls[0]
    expect(queueId).toBe(QUEUE_ID)
    expect(item).toEqual({ objectId: TRACE, objectType: 'TRACE' })
    expect(options).toMatchObject({ maxRetries: 1, abortSignal: expect.any(AbortSignal) })
  })

  it('queues nothing for an up-vote, a retraction, or an edit of a standing down-vote', async () => {
    await upsertFeedbackScore(vote({ verdict: 'up', reason: null, comment: null }))
    await deleteFeedbackScore(vote().feedbackId)
    await upsertFeedbackScore(vote({ reason: 'too_slow', previousVerdict: 'down' }))

    expect(api.createQueueItem).not.toHaveBeenCalled()
    expect(api.listQueues).not.toHaveBeenCalled()
  })

  it('looks further than the first page of queues', async () => {
    api.listQueues
      .mockResolvedValueOnce(queuePage(['triage'], 1, 2))
      .mockResolvedValueOnce(queuePage([REVIEW_QUEUE_NAME], 2, 2))

    await upsertFeedbackScore(vote())

    expect(api.listQueues.mock.calls.map(([request]) => request.page)).toEqual([1, 2])
    expect(api.createQueueItem).toHaveBeenCalledWith(QUEUE_ID, expect.any(Object), expect.any(Object))
  })

  it('looks the queue up once per window, and again after it', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    await upsertFeedbackScore(vote({ feedbackId: 'a' }))
    await upsertFeedbackScore(vote({ feedbackId: 'b' }))
    expect(api.listQueues).toHaveBeenCalledTimes(1)
    expect(api.createQueueItem).toHaveBeenCalledTimes(2)

    now.mockReturnValue(1_000_000 + QUEUE_CACHE_TTL_MS + 1)
    await upsertFeedbackScore(vote({ feedbackId: 'c' }))
    expect(api.listQueues).toHaveBeenCalledTimes(2)
  })

  it('shares one lookup between votes that arrive together', async () => {
    await Promise.all([
      upsertFeedbackScore(vote({ feedbackId: 'a' })),
      upsertFeedbackScore(vote({ feedbackId: 'b' })),
      upsertFeedbackScore(vote({ feedbackId: 'c' })),
    ])
    expect(api.listQueues).toHaveBeenCalledTimes(1)
    expect(api.createQueueItem).toHaveBeenCalledTimes(3)
  })

  /** Before provisioning: the scores still land, nothing is queued, and the miss costs one lookup. */
  it('does nothing without the queue, caches the miss, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    api.listQueues.mockResolvedValue(queuePage(['triage']))

    await expect(upsertFeedbackScore(vote({ feedbackId: 'a' }))).resolves.toBe(true)
    await upsertFeedbackScore(vote({ feedbackId: 'b' }))

    expect(api.listQueues).toHaveBeenCalledTimes(1)
    expect(api.createQueueItem).not.toHaveBeenCalled()
    expect(sentScores(FEEDBACK_REASON_SCORE_NAME)).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(`No annotation queue named "${REVIEW_QUEUE_NAME}"`)

    now.mockReturnValue(1_000_000 + QUEUE_CACHE_TTL_MS + 1)
    await upsertFeedbackScore(vote({ feedbackId: 'c' }))
    expect(api.listQueues).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('finds the queue once it has been provisioned', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    api.listQueues.mockResolvedValueOnce(queuePage([]))
    await upsertFeedbackScore(vote({ feedbackId: 'a' }))
    expect(api.createQueueItem).not.toHaveBeenCalled()

    now.mockReturnValue(1_000_000 + QUEUE_CACHE_TTL_MS + 1)
    await upsertFeedbackScore(vote({ feedbackId: 'b' }))
    expect(api.createQueueItem).toHaveBeenCalledWith(QUEUE_ID, expect.any(Object), expect.any(Object))
  })

  /** An outage is not a missing queue: it is not cached, and it never reaches the vote. */
  it('swallows a failed lookup or add, and retries the lookup on the next vote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.listQueues.mockRejectedValueOnce(httpError(503))

    await expect(upsertFeedbackScore(vote({ feedbackId: 'a' }))).resolves.toBe(true)
    expect(api.createQueueItem).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)

    api.createQueueItem.mockRejectedValueOnce(httpError(500))
    await expect(upsertFeedbackScore(vote({ feedbackId: 'b' }))).resolves.toBe(true)
    expect(api.listQueues).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
