/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { CONVERSATION_TAG_KEYS } from '@/lib/conversations/tags'
import {
  CONVERSATION_FEEDBACK_LIST_LIMIT,
  FEEDBACK_WEEKLY_SUMMARY_LIMIT,
  deleteAnswerFeedbackForUser,
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

  it('returns true when a row was deleted (scoped user + message + org)', async () => {
    const { where } = mockDelete([{ id: 'fb_1' }])
    await expect(deleteAnswerFeedbackForUser('user_1', 'msg_1', 'org_1')).resolves.toBe(true)
    expect(where).toHaveBeenCalledTimes(1)
    expect(where.mock.calls[0]![0]).toBeDefined() // and(user, message, org)
  })

  it('returns false when nothing matched', async () => {
    mockDelete([])
    await expect(deleteAnswerFeedbackForUser('user_1', 'msg_gone', 'org_1')).resolves.toBe(false)
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

  /** The literal SQL of a fragment, nested fragments included. */
  const sqlText = (fragment: unknown): string => {
    if (fragment === null || typeof fragment !== 'object') return ''
    const value = (fragment as { value?: unknown }).value
    if (Array.isArray(value)) return value.join('')
    const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks
    return Array.isArray(chunks) ? chunks.map(sqlText).join('') : ''
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
  it('drops a reason filter on the praised list', async () => {
    const execute = capture()
    await listFeedbackTurns({ verdict: 'up', reason: 'inaccurate' })
    expect(params(execute.mock.calls[0][0])).not.toContain('inaccurate')

    await listFeedbackTurns({ verdict: 'down', reason: 'inaccurate' })
    expect(params(execute.mock.calls[1][0])).toContain('inaccurate')
  })

  /**
   * Its question, answer, comment and expected answer may quote a restricted
   * folder, and every reader of this list (platform staff, the CSV export, the
   * digest's model) is outside that folder's audience. The SQL is checked
   * against Postgres in `restricted-feedback.integration.spec.ts`.
   */
  it('leaves out votes on an answer the server marked, by the vote\'s message id', async () => {
    const execute = capture()
    await listFeedbackTurns({})
    expect(sqlText(execute.mock.calls[0][0])).toMatch(
      /not exists \(\s*select 1 from message_restricted_use mr\s+where mr\.organization_id = f\.organization_id\s+and mr\.message_id = f\.message_id/
    )
  })

  /**
   * The vote's `conversation_id` is whatever the client sent (ADR-0089). Read
   * through it, a vote naming a restricted chat would show that chat's title
   * and question under an unmarked answer.
   */
  it('reads the title and the question through the voted message, never the vote\'s conversation id', async () => {
    const execute = capture()
    await listFeedbackTurns({ topic: CONVERSATION_TAG_KEYS[0] })
    const text = sqlText(execute.mock.calls[0][0])
    expect(text).not.toContain('f.conversation_id =')
    expect(text).not.toContain('= f.conversation_id')
    expect(text).toMatch(/left join conversations c on c\.id = m\.conversation_id and c\.organization_id = f\.organization_id/)
    expect(text).toMatch(/where conversation_id = m\.conversation_id\s+and organization_id = f\.organization_id/)
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
