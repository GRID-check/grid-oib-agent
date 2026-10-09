/**
 * @vitest-environment node
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import {
  CONVERSATION_FEEDBACK_LIST_LIMIT,
  FEEDBACK_EXPORT_ROW_CAP,
  FEEDBACK_ORG_ROLLUP_LIMIT,
  FEEDBACK_TOPIC_ROLLUP_LIMIT,
  getFeedbackHealth,
  FEEDBACK_WEEKLY_SUMMARY_LIMIT,
  deleteAnswerFeedbackForUser,
  getAnswerTraceId,
  getFeedbackWeeklySummary,
  isoWeekStart,
  listAnswerFeedbackForConversation,
  listFeedbackTurns,
  upsertAnswerFeedback,
} from './repository'

const mockGetDb = vi.mocked(getDb)

const values = {
  organizationId: 'org_1',
  projectId: null,
  conversationId: 'conv_1',
  messageId: 'msg_1',
  userId: 'user_1',
  verdict: 'up' as const,
  reason: null,
  comment: null,
  expectedAnswer: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('upsertAnswerFeedback', () => {
  it('inserts with ON CONFLICT (user_id, message_id) DO UPDATE', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'fb_1', ...values }])
    const onConflictDoUpdate = vi.fn((_config: unknown) => ({ returning }))
    const valuesFn = vi.fn(() => ({ onConflictDoUpdate }))
    mockGetDb.mockReturnValue({ insert: vi.fn(() => ({ values: valuesFn })) } as never)

    const row = await upsertAnswerFeedback(values)

    expect(valuesFn).toHaveBeenCalledWith(values)
    // Conflict target pins the row to the voting user (one vote per answer).
    const config = onConflictDoUpdate.mock.calls[0]![0] as unknown as {
      target: unknown[]
      set: Record<string, unknown>
    }
    expect(config.target).toHaveLength(2)
    expect(config.set).toMatchObject({ verdict: 'up', reason: null, organizationId: 'org_1' })
    expect(config.set.updatedAt).toBeInstanceOf(Date)
    expect(row.id).toBe('fb_1')
  })
})

describe('deleteAnswerFeedbackForUser', () => {
  function mockDelete(rows: unknown[]) {
    const returning = vi.fn().mockResolvedValue(rows)
    const where = vi.fn((_condition: unknown) => ({ returning }))
    mockGetDb.mockReturnValue({ delete: vi.fn(() => ({ where })) } as never)
    return { where }
  }

  it('returns the deleted row id (scoped user + message + org); its Langfuse score is keyed by it', async () => {
    const { where } = mockDelete([{ id: 'fb_1' }])
    await expect(deleteAnswerFeedbackForUser('user_1', 'msg_1', 'org_1')).resolves.toBe('fb_1')
    expect(where).toHaveBeenCalledTimes(1)
    expect(where.mock.calls[0]![0]).toBeDefined() // and(user, message, org)
  })

  it('returns null when nothing matched', async () => {
    mockDelete([])
    await expect(deleteAnswerFeedbackForUser('user_1', 'msg_gone', 'org_1')).resolves.toBeNull()
  })
})

describe('listAnswerFeedbackForConversation', () => {
  it('is bounded by the hard cap and scoped by org + user + conversation', async () => {
    const limit = vi.fn().mockResolvedValue([])
    const orderBy = vi.fn(() => ({ limit }))
    const where = vi.fn(() => ({ orderBy }))
    const from = vi.fn(() => ({ where }))
    mockGetDb.mockReturnValue({ select: vi.fn(() => ({ from })) } as never)

    await listAnswerFeedbackForConversation('user_1', 'conv_1', 'org_1')

    expect(where).toHaveBeenCalledTimes(1)
    expect(limit).toHaveBeenCalledWith(CONVERSATION_FEEDBACK_LIST_LIMIT)
  })
})

/**
 * The drill-in serves BOTH directions from one query. These are the guards on
 * that: a second, near-identical query for the praised answers would drift, and
 * the half that drifts is always the one nobody is watching.
 */
describe('listFeedbackTurns', () => {
  /**
   * Every bound value in a drizzle `sql` fragment, in order.
   *
   * Interpolated primitives sit in `queryChunks` as themselves; the literal SQL
   * around them is a `StringChunk`, and the conditional `and …` clauses are
   * nested `SQL` objects with chunks of their own — hence the recursion.
   */
  const params = (fragment: unknown): unknown[] => {
    if (fragment === null || typeof fragment !== 'object') return [fragment]
    const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks
    return Array.isArray(chunks) ? chunks.flatMap(params) : []
  }

  const capture = () => {
    const execute = vi.fn().mockResolvedValue([])
    mockGetDb.mockReturnValue({ execute } as never)
    return execute
  }

  it('binds the verdict rather than baking it into the SQL', async () => {
    const execute = capture()
    await listFeedbackTurns({ verdict: 'up' })
    expect(params(execute.mock.calls[0][0])).toContain('up')

    await listFeedbackTurns({ verdict: 'down' })
    expect(params(execute.mock.calls[1][0])).toContain('down')
  })

  it('defaults to the failures when no direction is asked for', async () => {
    const execute = capture()
    await listFeedbackTurns({})
    expect(params(execute.mock.calls[0][0])).toContain('down')
  })

  /**
   * A reason only exists on a down-vote. Applying it to `up` would return
   * nothing and read as "nobody liked anything" — a wrong answer that looks
   * like a real one.
   */
  it('never reads more than one row past the export cap, whatever it is asked for', async () => {
    const execute = capture()
    await listFeedbackTurns({ limit: 1_000_000 })
    expect(params(execute.mock.calls[0][0])).toContain(FEEDBACK_EXPORT_ROW_CAP + 1)
  })

  /** A chip-less down-vote counts as `other` in the aggregate, so the filter must find it there too. */
  it('filters `other` with chip-less down-votes included', async () => {
    const execute = capture()
    await listFeedbackTurns({ verdict: 'down', reason: 'other' })
    const text = new PgDialect().sqlToQuery(execute.mock.calls[0][0]).sql

    expect(text).toContain("coalesce(f.reason, 'other') =")
  })

  /**
   * The window used to be `now - N x 24h`, which starts mid-day: the headline
   * then counted part of a day the chart (UTC calendar days) does not draw.
   */
  it('starts the window at UTC midnight, on the first day the chart draws', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T15:45:00Z'))
    try {
      const execute = capture()
      await listFeedbackTurns({ windowDays: 7 })
      expect(params(execute.mock.calls[0][0])).toContain('2026-07-24T00:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  /** `100%` used to match every answer starting with "100"; `_` matched any character. */
  it('searches the free text literally, with LIKE wildcards escaped', async () => {
    const execute = capture()
    await listFeedbackTurns({ query: '100%_R\\60' })
    expect(params(execute.mock.calls[0][0])).toContain('%100\\%\\_R\\\\60%')
  })

  it('drops a reason filter on the praised list', async () => {
    const execute = capture()
    await listFeedbackTurns({ verdict: 'up', reason: 'inaccurate' })
    expect(params(execute.mock.calls[0][0])).not.toContain('inaccurate')

    await listFeedbackTurns({ verdict: 'down', reason: 'inaccurate' })
    expect(params(execute.mock.calls[1][0])).toContain('inaccurate')
  })

  /**
   * The question used to be "the newest user message at or before the answer —
   * or ANY, when the answer row is missing", so an unpersisted answer was shown
   * under whatever was asked last. The behaviour is proven against Postgres in
   * `repository.integration.spec.ts`; this pins that the anchor stays the answer.
   */
  it('anchors the question to the answer row, never to "any user message"', async () => {
    const execute = capture()
    await listFeedbackTurns({})
    const text = new PgDialect().sqlToQuery(execute.mock.calls[0][0]).sql

    expect(text).not.toMatch(/m\.created_at is null/)
    expect(text).toContain('qm.conversation_id = m.conversation_id')
    expect(text).toContain('qm.created_at <= m.created_at')
  })

  /**
   * `message_id` is client text. Joined on the id alone, a vote that named
   * another tenant's answer showed (and exported, and distilled) that tenant's
   * text under the voter's row. Proven against Postgres in the integration spec.
   */
  it("pins the voted answer to the voter's organization", async () => {
    const execute = capture()
    await listFeedbackTurns({})
    const text = new PgDialect().sqlToQuery(execute.mock.calls[0][0]).sql

    expect(text).toContain('m.organization_id = f.organization_id')
    expect(text).toContain('qm.organization_id = m.organization_id')
  })

  it('coerces the raw row — `sql` results are not runtime-validated', async () => {
    const execute = vi.fn().mockResolvedValue([
        {
          id: 'fb_1',
          organization_id: 'org_1',
          project_id: null,
          conversation_id: 'conv_1',
          message_id: 'msg_1',
          verdict: 'down',
          reason: 'inaccurate',
          expected_answer: '  ',
          created_at: '2026-07-30T09:00:00.000Z',
          answer: 'A',
          question: 'Q',
          conversation_title: 'T',
          // A tag the vocabulary does not know — written by an LLM, or a row
          // that predates the current keys. The UI has no label for it.
          topics: ['brandschutz', 'not_a_real_tag'],
        },
    ])
    mockGetDb.mockReturnValue({ execute } as never)

    const [row] = await listFeedbackTurns({})

    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.topics).toEqual(['brandschutz'])
    expect(row.expectedAnswer).toBeNull()
  })
})

describe('getFeedbackWeeklySummary', () => {
  const params = (fragment: unknown): unknown[] => {
    if (fragment === null || typeof fragment !== 'object') return [fragment]
    const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks
    return Array.isArray(chunks) ? chunks.flatMap(params) : []
  }

  it('coerces counts, which the driver returns as strings', async () => {
    const execute = vi.fn().mockResolvedValue([
      { organization_id: 'org_1', iso_week: '2026-W41', week_start: '2026-10-05', answers: '40', up: '6', down: null },
    ])
    mockGetDb.mockReturnValue({ execute } as never)

    const rows = await getFeedbackWeeklySummary({})

    expect(rows).toEqual([
      { organizationId: 'org_1', isoWeek: '2026-W41', weekStart: '2026-10-05', answers: 40, up: 6, down: 0 },
    ])
  })

  it('is bounded and scopes to one organization only when asked', async () => {
    const execute = vi.fn().mockResolvedValue([])
    mockGetDb.mockReturnValue({ execute } as never)

    await getFeedbackWeeklySummary({ organizationId: 'org_9' })
    await getFeedbackWeeklySummary({})

    expect(params(execute.mock.calls[0][0])).toContain(FEEDBACK_WEEKLY_SUMMARY_LIMIT)
    expect(params(execute.mock.calls[0][0])).toContain('org_9')
    expect(params(execute.mock.calls[1][0])).not.toContain('org_9')
  })

  it('starts the window on the Monday of an ISO week', () => {
    // Wednesday 2026-10-07 -> Monday 2026-10-05; Sunday 2026-10-11 -> the same Monday.
    expect(isoWeekStart(new Date('2026-10-07T13:00:00Z'))).toBe('2026-10-05T00:00:00.000Z')
    expect(isoWeekStart(new Date('2026-10-11T23:59:00Z'))).toBe('2026-10-05T00:00:00.000Z')
  })
})

/**
 * The file header promises every list is bounded. The two rollups group by
 * values nothing bounds (customers, LLM-written tags), and had no LIMIT.
 */
describe('getFeedbackHealth rollups', () => {
  /** A drizzle builder double: every call chains, awaiting it yields no rows. */
  function chain(calls: { method: string; args: unknown[] }[]) {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'from', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit']) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ method, args })
        return builder
      }
    }
    builder.then = (resolve: (rows: unknown[]) => unknown) => resolve([])
    return builder
  }

  it('bounds the organization and the topic rollups', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    const execute = vi.fn().mockResolvedValue([])
    mockGetDb.mockReturnValue({ ...chain(calls), execute } as never)

    await getFeedbackHealth({ limit: 0 })

    expect(calls.filter((call) => call.method === 'limit').map((call) => call.args[0])).toContain(
      FEEDBACK_ORG_ROLLUP_LIMIT,
    )
    const topicQuery = execute.mock.calls
      .map(([query]) => new PgDialect().sqlToQuery(query))
      .find((query) => query.sql.includes('unnest(c.tags)'))
    expect(topicQuery?.sql).toMatch(/limit \$\d+\s*$/)
    expect(topicQuery?.params).toContain(FEEDBACK_TOPIC_ROLLUP_LIMIT)
  })
})

describe('getAnswerTraceId', () => {
  const ANSWER = '6135ac80-f26d-5f7d-ab0f-1633fe313293'

  it('reads the trace the answer row names, scoped to the tenant', async () => {
    const execute = vi.fn().mockResolvedValue([{ trace_id: '6135ac80f26d5f7dab0f1633fe313293' }])
    mockGetDb.mockReturnValue({ execute } as never)

    await expect(getAnswerTraceId(ANSWER, 'org_1')).resolves.toBe('6135ac80f26d5f7dab0f1633fe313293')
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0])
    expect(query.sql).toContain("metadata->>'trace_id'")
    expect(query.params).toEqual(expect.arrayContaining([ANSWER, 'org_1']))
  })

  it('is null for a row without one, or with something that is not a trace id', async () => {
    for (const rows of [[], [{ trace_id: null }], [{ trace_id: 'not-a-trace' }]]) {
      mockGetDb.mockReturnValue({ execute: vi.fn().mockResolvedValue(rows) } as never)
      await expect(getAnswerTraceId(ANSWER, 'org_1')).resolves.toBeNull()
    }
  })

  it('does not query for an id that is not a UUID (the dev page votes on "af-msg")', async () => {
    const execute = vi.fn()
    mockGetDb.mockReturnValue({ execute } as never)
    await expect(getAnswerTraceId('af-msg', 'org_1')).resolves.toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })
})
