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
  WEEKLY_APPLIED_RATINGS_FILTERS,
} from './repository'
import { NO_RATINGS_FILTERS, type FeedbackQuery, type RatingsFilters } from './filters'

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

/** Every vote of 2026-09-10..2026-10-09, no filters. */
const ALL: FeedbackQuery = {
  scope: { from: '2026-09-10', to: '2026-10-09', organizationIds: [], projectIds: [] },
  ratings: NO_RATINGS_FILTERS,
}
const narrowed = (ratings: Partial<RatingsFilters>, scope: Partial<FeedbackQuery['scope']> = {}): FeedbackQuery => ({
  scope: { ...ALL.scope, ...scope },
  ratings: { ...NO_RATINGS_FILTERS, ...ratings },
})
const sqlOf = (fragment: unknown) => new PgDialect().sqlToQuery(fragment as never)

/**
 * The drill-in serves BOTH directions from one query. These are the guards on
 * that: a second, near-identical query for the praised answers would drift, and
 * the half that drifts is always the one nobody is watching.
 */
describe('listFeedbackTurns', () => {
  const capture = () => {
    const execute = vi.fn().mockResolvedValue([])
    mockGetDb.mockReturnValue({ execute } as never)
    return execute
  }

  it('lists both directions unless the filters name one, and binds the one they name', async () => {
    const execute = capture()
    await listFeedbackTurns(ALL)
    expect(sqlOf(execute.mock.calls[0][0]).sql).not.toMatch(/f\.verdict = \$/)

    await listFeedbackTurns(narrowed({ verdict: 'up' }))
    const { sql, params } = sqlOf(execute.mock.calls[1][0])
    expect(sql).toMatch(/f\.verdict = \$\d+/)
    expect(params).toContain('up')
  })

  /** The digest samples each direction; an override may narrow a request, never widen it. */
  it('narrows to a direction on request, but never widens a filtered one', async () => {
    const execute = capture()
    await listFeedbackTurns(ALL, { verdict: 'down' })
    expect(sqlOf(execute.mock.calls[0][0]).params).toContain('down')

    expect(await listFeedbackTurns(narrowed({ verdict: 'up' }), { verdict: 'down' })).toEqual([])
    expect(await listFeedbackTurns(narrowed({ reasons: ['inaccurate'] }), { verdict: 'up' })).toEqual([])
    expect(execute).toHaveBeenCalledOnce()
  })

  it('never reads more than one row past the export cap, whatever it is asked for', async () => {
    const execute = capture()
    await listFeedbackTurns(ALL, { limit: 1_000_000 })
    expect(sqlOf(execute.mock.calls[0][0]).params).toContain(FEEDBACK_EXPORT_ROW_CAP + 1)
  })

  /** A chip-less down-vote counts as `other` in the aggregate, so the filter must find it there too. */
  it('filters `other` with chip-less down-votes included', async () => {
    const execute = capture()
    await listFeedbackTurns(narrowed({ reasons: ['other'] }))
    expect(sqlOf(execute.mock.calls[0][0]).sql).toContain("coalesce(f.reason, 'other') in (")
  })

  /** The range is UTC calendar days, both ends inclusive: `[from, to + 1 day)`. */
  it('reads the range as UTC days, the last one included', async () => {
    const execute = capture()
    await listFeedbackTurns(narrowed({}, { from: '2026-07-24', to: '2026-07-30' }))
    expect(sqlOf(execute.mock.calls[0][0]).params).toEqual(
      expect.arrayContaining(['2026-07-24T00:00:00.000Z', '2026-07-31T00:00:00.000Z'])
    )
  })

  /** `100%` used to match every answer starting with "100"; `_` matched any character. */
  it('searches the free text literally, with LIKE wildcards escaped', async () => {
    const execute = capture()
    await listFeedbackTurns(narrowed({ query: '100%_R\\60' }))
    expect(sqlOf(execute.mock.calls[0][0]).params).toContain('%100\\%\\_R\\\\60%')
  })

  /**
   * Its question, answer, comment and expected answer may quote a restricted
   * folder, and every reader of this list (platform staff, the CSV export, the
   * digest's model) is outside that folder's audience. The SQL is checked
   * against Postgres in `restricted-feedback.integration.spec.ts`.
   */
  it('leaves out votes the database\'s one rule answers yes for, asked of the whole vote', async () => {
    const execute = capture()
    await listFeedbackTurns(ALL)
    expect(sqlOf(execute.mock.calls[0][0]).sql).toMatch(
      /not grid_feedback_restricted_use\(f\.organization_id, f\.message_id, f\.conversation_id\)/
    )
  })

  /**
   * The question used to be "the newest user message at or before the answer —
   * or ANY, when the answer row is missing", so an unpersisted answer was shown
   * under whatever was asked last. The behaviour is proven against Postgres in
   * `repository.integration.spec.ts`; this pins that the anchor stays the answer.
   */
  it('anchors the question to the answer row, never to "any user message"', async () => {
    const execute = capture()
    await listFeedbackTurns(ALL)
    const text = sqlOf(execute.mock.calls[0][0]).sql

    expect(text).not.toMatch(/m\.created_at is null/)
    expect(text).toContain('qm.conversation_id = m.conversation_id')
    expect(text).toContain('qm.created_at <= m.created_at')
  })

  /**
   * `message_id` is client text. Joined on the id alone, a vote that named
   * another tenant's answer showed (and exported, and distilled) that tenant's
   * text under the voter's row. Proven against Postgres in the integration spec.
   */
  it("pins every join to the voter's organization", async () => {
    const execute = capture()
    await listFeedbackTurns(ALL)
    const text = sqlOf(execute.mock.calls[0][0]).sql

    expect(text).toContain('m.organization_id = f.organization_id')
    expect(text).toContain('qm.organization_id = m.organization_id')
    expect(text).toContain('c.organization_id = f.organization_id')
    expect(text).toContain('tr.organization_id = m.organization_id')
  })

  /** The client sends `conversation_id`; the answer row is the authority when it exists. */
  it("takes the conversation from the persisted answer, inside the voter's organization", async () => {
    const execute = capture()
    await listFeedbackTurns(ALL)
    const text = sqlOf(execute.mock.calls[0][0]).sql

    expect(text).toContain('c.id = coalesce(m.conversation_id, f.conversation_id)')
    expect(text).not.toMatch(/c\.id = f\.conversation_id/)
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

    const [row] = await listFeedbackTurns(ALL)

    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.topics).toEqual(['brandschutz'])
    expect(row.expectedAnswer).toBeNull()
  })
})

describe('getFeedbackWeeklySummary', () => {
  it('coerces counts, which the driver returns as strings', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        organization_id: 'org_1',
        iso_week: '2026-W41',
        week_start: '2026-10-05',
        answers: '40',
        rated_answers: '8',
        up: '6',
        down: null,
      },
    ])
    mockGetDb.mockReturnValue({ execute } as never)

    const summary = await getFeedbackWeeklySummary(ALL)

    expect(summary.weeks).toEqual([
      { organizationId: 'org_1', isoWeek: '2026-W41', weekStart: '2026-10-05', answers: 40, ratedAnswers: 8, up: 6, down: 0 },
    ])
    expect(summary.truncated).toBe(false)
  })

  /** It used to stop at the cap and say nothing; a reader saw a complete-looking quarter. */
  it('reads one row past the cap, reports the cut and keeps the newest weeks', async () => {
    const rows = Array.from({ length: FEEDBACK_WEEKLY_SUMMARY_LIMIT + 1 }, (_, index) => ({
      organization_id: `org_${index}`,
      iso_week: '2026-W41',
      week_start: '2026-10-05',
      answers: '1',
      up: '0',
      down: '0',
    }))
    const execute = vi.fn().mockResolvedValue(rows)
    mockGetDb.mockReturnValue({ execute } as never)

    const summary = await getFeedbackWeeklySummary(ALL)
    const query = sqlOf(execute.mock.calls[0][0])

    expect(summary.truncated).toBe(true)
    expect(summary.weeks).toHaveLength(FEEDBACK_WEEKLY_SUMMARY_LIMIT)
    expect(query.params).toContain(FEEDBACK_WEEKLY_SUMMARY_LIMIT + 1)
    expect(query.sql).toContain('order by week_start desc')
  })

  /**
   * A rate needs both verdicts and every answer: the scope and the topic narrow
   * answers and votes alike, and nothing that only describes a vote reaches it.
   */
  it('applies the scope and the topic to both halves, and no vote-only filter', async () => {
    const execute = vi.fn().mockResolvedValue([])
    mockGetDb.mockReturnValue({ execute } as never)

    await getFeedbackWeeklySummary(
      narrowed(
        { verdict: 'down', reasons: ['inaccurate'], topics: ['statik'], hasComment: true, query: 'GK' },
        { from: '2026-10-07', to: '2026-10-09', organizationIds: ['org_9'], projectIds: ['0b6f2a1e-5c3d-4e8f-9a7b-1c2d3e4f5a61'] }
      )
    )
    const { sql, params } = sqlOf(execute.mock.calls[0][0])

    expect(sql.match(/organization_id in \(/g)).toHaveLength(2)
    expect(sql).toContain('c.project_id in (')
    expect(sql).toContain('coalesce(f.project_id, c.project_id) in (')
    expect(sql.match(/c\.tags && array\[/g)).toHaveLength(2)
    expect(params).toEqual(expect.arrayContaining(['org_9', 'statik', '2026-10-05T00:00:00.000Z', '2026-10-10T00:00:00.000Z']))
    expect(params).not.toContain('inaccurate')
    expect(params).not.toContain('%GK%')
    expect(sql).not.toContain('btrim')
    expect(WEEKLY_APPLIED_RATINGS_FILTERS).toEqual(['topics'])
  })

  it('starts the window on the Monday of an ISO week', () => {
    // Wednesday 2026-10-07 -> Monday 2026-10-05; Sunday 2026-10-11 -> the same Monday.
    expect(isoWeekStart(new Date('2026-10-07T13:00:00Z'))).toBe('2026-10-05T00:00:00.000Z')
    expect(isoWeekStart(new Date('2026-10-11T23:59:00Z'))).toBe('2026-10-05T00:00:00.000Z')
  })
})

/**
 * Every figure on the tab is read over the same votes as the list, so a filter
 * on the tab is a filter on all of it; and the rollups group by values nothing
 * bounds (customers, LLM-written tags), so each carries a LIMIT.
 */
describe('getFeedbackHealth', () => {
  const run = async (query: FeedbackQuery) => {
    const execute = vi.fn().mockResolvedValue([])
    mockGetDb.mockReturnValue({ execute } as never)
    const health = await getFeedbackHealth(query, { turnLimit: 0 })
    return { health, queries: execute.mock.calls.map(([fragment]) => sqlOf(fragment)) }
  }

  it('applies every filter to every aggregate, not only to the list', async () => {
    const { queries } = await run(
      narrowed({ reasons: ['wrong_source'], modes: ['deep'], hasExpectedAnswer: true }, { organizationIds: ['org_9'] })
    )
    // coverage, totals, reasons, daily, organizations, topics
    expect(queries).toHaveLength(6)
    for (const query of queries) {
      expect(query.params).toEqual(expect.arrayContaining(['org_9', 'wrong_source', 'deep']))
      expect(query.sql).toContain("nullif(btrim(f.expected_answer), '') is not null")
    }
  })

  it('bounds the organization and the topic rollups', async () => {
    const { queries } = await run(ALL)
    const organizations = queries.find((query) => query.sql.includes('group by f.organization_id'))
    const topics = queries.find((query) => query.sql.includes('unnest(c.tags)'))
    expect(organizations?.params).toContain(FEEDBACK_ORG_ROLLUP_LIMIT)
    expect(topics?.sql).toMatch(/limit \$\d+\s*$/)
    expect(topics?.params).toContain(FEEDBACK_TOPIC_ROLLUP_LIMIT)
  })

  it('names the range it was read for', async () => {
    const { health } = await run(narrowed({}, { from: '2026-10-01', to: '2026-10-09' }))
    expect(health).toMatchObject({ from: '2026-10-01', to: '2026-10-09', windowDays: 9 })
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
