/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import {
  getSpansForConversation,
  listProfiledConversations,
  TIMELINE_SPAN_CAP,
  TIMELINE_TURN_CAP,
} from './repository'

const mockGetDb = vi.mocked(getDb)

/**
 * Build a db stand-in whose SELECT chain
 * (`.from().leftJoin().where().groupBy().orderBy().limit()`) resolves to the
 * given driver rows — i.e. what the pg driver actually hands back, BEFORE any
 * row shaping. Aggregate columns come back as strings even where the drizzle
 * `sql<...>` annotation claims otherwise.
 */
function mockSelect(driverRows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(driverRows)
  const orderBy = vi.fn(() => ({ limit }))
  const groupBy = vi.fn(() => ({ orderBy }))
  const where = vi.fn((_condition?: SQL) => ({ groupBy }))
  const leftJoin = vi.fn(() => ({ where }))
  const from = vi.fn(() => ({ leftJoin }))
  mockGetDb.mockReturnValue({ select: vi.fn(() => ({ from })) } as never)
  return { limit, where }
}

/**
 * The timeline issues two selects: the newest turn ids (`…groupBy().orderBy().limit()`)
 * and then their spans (`…where().orderBy().limit()`). Each resolves to the
 * next queued result.
 */
function mockTimelineSelects(turnRows: unknown[], spanRows: unknown[]) {
  const results = [turnRows, spanRows]
  const limits: ReturnType<typeof vi.fn>[] = []
  const select = vi.fn(() => {
    const limit = vi.fn().mockResolvedValue(results[limits.length])
    limits.push(limit)
    const orderBy = vi.fn(() => ({ limit }))
    const where = vi.fn(() => ({ groupBy: vi.fn(() => ({ orderBy })), orderBy }))
    return { from: vi.fn(() => ({ where })) }
  })
  mockGetDb.mockReturnValue({ select } as never)
  return { select, limits }
}

const spanRow = (index: number) => ({ spanId: `span_${index}`, turnId: 'turn_1' })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listProfiledConversations', () => {
  it('coerces the raw driver row to the domain shape (string aggregates → Date/number)', async () => {
    // The pg driver returns `max(started_at)` as a timestamp STRING and
    // `sum(...)::bigint` as a STRING, despite the `sql<Date>` / `sql<string>`
    // annotations. Regression guard for the production crash
    // "e.lastActiveAt.toISOString is not a function" in the service layer.
    const { limit } = mockSelect([
      {
        conversationId: 'conv_1',
        organizationId: 'org_1',
        title: 'Bauantrag Wien',
        turnCount: 2,
        totalDurationMsRaw: '4200',
        lastActiveAt: '2026-01-01T00:00:02.000Z',
      },
    ])

    const { rows, capped } = await listProfiledConversations()

    expect(capped).toBe(false)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    // lastActiveAt is coerced to a real Date so downstream `.toISOString()` works.
    expect(row.lastActiveAt).toBeInstanceOf(Date)
    expect(row.lastActiveAt.toISOString()).toBe('2026-01-01T00:00:02.000Z')
    // bigint string is coerced to a number.
    expect(row.totalDurationMs).toBe(4200)
    expect(typeof row.totalDurationMs).toBe('number')
    expect(row.conversationId).toBe('conv_1')
    expect(row.organizationId).toBe('org_1')
    expect(row.title).toBe('Bauantrag Wien')
    // Absent from the driver row (no restricted use): coerced to a real boolean.
    expect(row.titleWithheld).toBe(false)
    expect(row.turnCount).toBe(2)
    // Chain terminates at the list cap + 1 probe.
    expect(limit).toHaveBeenCalledWith(201)
  })

  it('reports capped=true when the driver returns more than the list cap', async () => {
    const driverRows = Array.from({ length: 201 }, (_, i) => ({
      conversationId: `conv_${i}`,
      organizationId: 'org_1',
      title: null,
      turnCount: 1,
      totalDurationMsRaw: '10',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    }))
    mockSelect(driverRows)

    const { rows, capped } = await listProfiledConversations()

    expect(capped).toBe(true)
    // Capped back down to 200, and every retained row is still coerced.
    expect(rows).toHaveLength(200)
    expect(rows.every((r) => r.lastActiveAt instanceof Date)).toBe(true)
  })
})

describe('listProfiledConversations search', () => {
  it("escapes LIKE wildcards in the operator's query", async () => {
    // Regression: `100%` or `a_b` were used as raw patterns, so `%` matched
    // every conversation and `_` matched any character.
    const { where } = mockSelect([])
    await listProfiledConversations('100%_x')

    const condition = where.mock.calls[0][0] as SQL
    const { params } = new PgDialect().sqlToQuery(condition)
    expect(params).toContain('%100\\%\\_x%')
  })
})

describe('getSpansForConversation', () => {
  it('loads the newest turns only, and says when older ones exist', async () => {
    const turnRows = Array.from({ length: TIMELINE_TURN_CAP }, (_, index) => ({
      turnId: `t${index}`,
      totalTurns: '80',
    }))
    const { limits } = mockTimelineSelects(turnRows, [spanRow(1)])

    const result = await getSpansForConversation('conv_1')

    expect(limits[0]).toHaveBeenCalledWith(TIMELINE_TURN_CAP)
    expect(result).toMatchObject({ totalTurns: 80, capped: true })
  })

  it('is not capped when every turn fits', async () => {
    mockTimelineSelects([{ turnId: 't1', totalTurns: '1' }], [spanRow(1), spanRow(2)])

    const result = await getSpansForConversation('conv_1')
    expect(result).toMatchObject({ totalTurns: 1, capped: false })
    expect(result.spans).toHaveLength(2)
  })

  it('caps the spans, keeps the newest, and returns them oldest first', async () => {
    // The span query reads newest first with one row over the ceiling.
    const newestFirst = Array.from({ length: TIMELINE_SPAN_CAP + 1 }, (_, index) =>
      spanRow(TIMELINE_SPAN_CAP - index)
    )
    const { limits } = mockTimelineSelects([{ turnId: 't1', totalTurns: '1' }], newestFirst)

    const result = await getSpansForConversation('conv_1')

    expect(limits[1]).toHaveBeenCalledWith(TIMELINE_SPAN_CAP + 1)
    expect(result.capped).toBe(true)
    expect(result.spans).toHaveLength(TIMELINE_SPAN_CAP)
    expect(result.spans[0].spanId).toBe('span_1')
    expect(result.spans.at(-1)?.spanId).toBe(`span_${TIMELINE_SPAN_CAP}`)
  })

  it('makes no span query for a conversation with no turns', async () => {
    const { select } = mockTimelineSelects([], [])

    expect(await getSpansForConversation('conv_none')).toEqual({
      spans: [],
      totalTurns: 0,
      capped: false,
    })
    expect(select).toHaveBeenCalledTimes(1)
  })
})
