/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const api = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  constructed: vi.fn(),
}))

vi.mock('@langfuse/client', () => ({
  LangfuseClient: class {
    api = { scores: { create: api.create }, legacy: { scoreV1: { delete: api.remove } } }
    constructor(params: unknown) {
      api.constructed(params)
    }
  },
}))

import {
  FEEDBACK_SCORE_NAME,
  SCORE_DEADLINE_MS,
  deleteFeedbackScore,
  feedbackScoreId,
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

beforeEach(() => {
  api.create.mockReset().mockResolvedValue({ id: 'ignored' })
  api.remove.mockReset().mockResolvedValue(undefined)
  api.constructed.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

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
  it('sends nothing and builds no client', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '')
    vi.stubEnv('LANGFUSE_SECRET_KEY', '')
    vi.stubEnv('LANGFUSE_HOST', '')

    await expect(upsertFeedbackScore(vote())).resolves.toBe(false)
    await expect(deleteFeedbackScore(vote().feedbackId)).resolves.toBe(false)
    expect(api.constructed).not.toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
    expect(api.remove).not.toHaveBeenCalled()
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
    let releaseCreate!: () => void
    api.create.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCreate = () => {
            order.push('create')
            resolve()
          }
        })
    )
    api.remove.mockImplementationOnce(async () => {
      order.push('delete')
    })

    const created = upsertFeedbackScore(vote())
    const deleted = deleteFeedbackScore(vote().feedbackId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.remove).not.toHaveBeenCalled()

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
