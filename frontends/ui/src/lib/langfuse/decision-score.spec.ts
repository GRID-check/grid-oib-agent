/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const api = vi.hoisted(() => ({ create: vi.fn(), constructed: vi.fn() }))
vi.mock('@langfuse/client', () => ({
  LangfuseClient: class {
    api = { scores: { create: api.create } }
    constructor(params: unknown) {
      api.constructed(params)
    }
  },
}))

const rows = vi.hoisted(() => ({ changes: [] as Array<{ messageId: string }>, select: vi.fn() }))
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: (...args: unknown[]) => {
      rows.select(...args)
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows.changes),
      }
      return chain
    },
  }),
}))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: <T>(_scope: unknown, run: () => T) => run(),
}))
vi.mock('@/lib/feedback/repository', () => ({ getAnswerTraceId: vi.fn() }))
vi.mock('@/lib/proposals/repository', () => ({ findProposedChange: vi.fn() }))

import { getAnswerTraceId } from '@/lib/feedback/repository'
import { findProposedChange } from '@/lib/proposals/repository'
import {
  DECISION_SCORE_NAME,
  decisionScoreId,
  recordDecisionScore,
  toDecisionScore,
} from './decision-score'
import { SCORE_DEADLINE_MS } from './feedback-score'

const TRACE = '6135ac80f26d5f7dab0f1633fe313293'
const MESSAGE = '0b1c2d3e-0000-4000-8000-000000000001'
const ORG = 'org_1'

const configure = () => {
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-1')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-1')
  vi.stubEnv('LANGFUSE_HOST', 'http://langfuse-web:3000')
}

beforeEach(() => {
  vi.clearAllMocks()
  rows.changes = []
  api.create.mockResolvedValue({})
  vi.mocked(getAnswerTraceId).mockResolvedValue(TRACE)
  vi.mocked(findProposedChange).mockResolvedValue(null)
  configure()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const decision = (patch: Partial<Parameters<typeof recordDecisionScore>[0]> = {}) =>
  recordDecisionScore({
    organizationId: ORG,
    subject: 'proposal',
    subjectId: 'prop-1',
    decision: 'accepted',
    decidedBy: 'user_1',
    ...patch,
  })

describe('toDecisionScore', () => {
  it('is one categorical score named for the subject, with the decision as its value', () => {
    expect(toDecisionScore({ traceId: TRACE, subject: 'annotation', subjectId: 'mark-1', decision: 'dismissed' })).toEqual({
      id: 'piloti-decision-annotation-mark-1',
      traceId: TRACE,
      name: DECISION_SCORE_NAME,
      dataType: 'CATEGORICAL',
      value: 'dismissed',
      metadata: { subject: 'annotation', subject_id: 'mark-1' },
    })
  })

  it('derives the id from the subject only, so a repeated decision upserts', () => {
    expect(decisionScoreId('proposal', 'x')).toBe(decisionScoreId('proposal', 'x'))
    expect(decisionScoreId('proposal', 'x')).not.toBe(decisionScoreId('change', 'x'))
  })
})

describe('recordDecisionScore — finding the turn', () => {
  it('uses the origin the caller knows, without touching a table', async () => {
    await decision({ origin: { conversationId: 'conv-1', messageId: MESSAGE } })

    expect(getAnswerTraceId).toHaveBeenCalledWith(MESSAGE, ORG)
    expect(findProposedChange).not.toHaveBeenCalled()
    expect(rows.select).not.toHaveBeenCalled()
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.create.mock.calls[0][0]).toMatchObject({ traceId: TRACE, value: 'accepted' })
    expect(api.create.mock.calls[0][1]).toMatchObject({ maxRetries: 1 })
  })

  it('reads a proposal’s turn from its own row', async () => {
    vi.mocked(findProposedChange).mockResolvedValue({ originMessageId: MESSAGE } as never)

    await decision({ subject: 'proposal', decision: 'dismissed' })

    expect(findProposedChange).toHaveBeenCalledWith(ORG, 'prop-1')
    expect(getAnswerTraceId).toHaveBeenCalledWith(MESSAGE, ORG)
    expect(api.create.mock.calls[0][0]).toMatchObject({ value: 'dismissed', metadata: { subject: 'proposal', subject_id: 'prop-1' } })
  })

  it('reads a mark’s turn from the change that created it', async () => {
    rows.changes = [{ messageId: MESSAGE }]

    await decision({ subject: 'annotation', subjectId: 'mark-1' })

    expect(rows.select).toHaveBeenCalledTimes(1)
    expect(getAnswerTraceId).toHaveBeenCalledWith(MESSAGE, ORG)
    expect(api.create.mock.calls[0][0]).toMatchObject({ id: 'piloti-decision-annotation-mark-1', value: 'accepted' })
  })

  it('reads an undone change’s turn from the change itself', async () => {
    rows.changes = [{ messageId: MESSAGE }]

    await decision({ subject: 'change', subjectId: 'chg-1', decision: 'undone' })

    expect(getAnswerTraceId).toHaveBeenCalledWith(MESSAGE, ORG)
    expect(api.create.mock.calls[0][0]).toMatchObject({ id: 'piloti-decision-change-chg-1', value: 'undone' })
  })

  it('puts an intake suggestion’s decision on the reading’s own trace, without looking for a turn', async () => {
    await decision({ subject: 'intake_suggestion', subjectId: 'intake-job-1-escape_level_m@bldg1', traceId: 'trace-reading' })

    expect(getAnswerTraceId).not.toHaveBeenCalled()
    expect(rows.select).not.toHaveBeenCalled()
    expect(api.create.mock.calls[0][0]).toMatchObject({
      id: 'piloti-decision-intake_suggestion-intake-job-1-escape_level_m@bldg1',
      traceId: 'trace-reading',
      metadata: { subject: 'intake_suggestion', subject_id: 'intake-job-1-escape_level_m@bldg1' },
    })
  })

  it('puts a held mail’s suggestion decision on its filing-fit trace, with the codes of what was not followed', async () => {
    await decision({
      subject: 'inbound_mail_suggestion',
      subjectId: 'part-1',
      decision: 'dismissed',
      traceId: TRACE,
      // A detail cannot rename the subject.
      detail: { folder: 'other', type: 'same', subject: 'proposal' },
    })

    expect(getAnswerTraceId).not.toHaveBeenCalled()
    expect(api.create.mock.calls[0][0]).toEqual({
      id: 'piloti-decision-inbound_mail_suggestion-part-1',
      traceId: TRACE,
      name: DECISION_SCORE_NAME,
      dataType: 'CATEGORICAL',
      value: 'dismissed',
      metadata: { folder: 'other', type: 'same', subject: 'inbound_mail_suggestion', subject_id: 'part-1' },
    })
  })

  it('posts nothing for a held mail’s suggestion without a trace', async () => {
    await decision({ subject: 'inbound_mail_suggestion', subjectId: 'part-1', traceId: null })

    expect(api.create).not.toHaveBeenCalled()
  })

  it('posts nothing for an intake suggestion whose reading left no trace', async () => {
    await expect(decision({ subject: 'intake_suggestion', subjectId: 's', traceId: null })).resolves.toBeUndefined()

    expect(getAnswerTraceId).not.toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
  })

  it('posts nothing when no row names the turn', async () => {
    await expect(decision({ subject: 'proposal' })).resolves.toBeUndefined()
    await expect(decision({ subject: 'annotation' })).resolves.toBeUndefined()
    await expect(decision({ subject: 'change' })).resolves.toBeUndefined()

    expect(getAnswerTraceId).not.toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
  })

  it('posts nothing when the answer names no trace', async () => {
    vi.mocked(getAnswerTraceId).mockResolvedValue(null)

    await expect(decision({ origin: { conversationId: 'c', messageId: MESSAGE } })).resolves.toBeUndefined()

    expect(api.create).not.toHaveBeenCalled()
  })
})

describe('recordDecisionScore — never in the way', () => {
  it('is a no-op when Langfuse is not configured', async () => {
    vi.stubEnv('LANGFUSE_HOST', '')

    await decision({ origin: { conversationId: 'c', messageId: MESSAGE } })

    expect(getAnswerTraceId).not.toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
  })

  it('swallows a Langfuse failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    api.create.mockRejectedValue(new Error('langfuse down'))

    await expect(decision({ origin: { conversationId: 'c', messageId: MESSAGE } })).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalled()
  })

  it('swallows a failed lookup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(findProposedChange).mockRejectedValue(new Error('db down'))

    await expect(decision()).resolves.toBeUndefined()

    expect(api.create).not.toHaveBeenCalled()
  })

  it('bounds the call', async () => {
    await decision({ origin: { conversationId: 'c', messageId: MESSAGE } })

    const options = api.create.mock.calls[0][1] as { abortSignal: AbortSignal }
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(SCORE_DEADLINE_MS).toBeLessThanOrEqual(5000)
  })
})
