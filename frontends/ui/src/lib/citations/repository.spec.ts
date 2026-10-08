/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  aggregateByKind,
  aggregateByOrganization,
  aggregateDailyTurns,
  aggregateDefectiveSourceMix,
  aggregateFailedTargets,
  aggregateReasons,
  aggregateUnavailableTools,
  countObservedTurns,
  countTurnsForTargets,
  insertCitationEvents,
} from './repository'

const mockGetDb = vi.mocked(getDb)

/**
 * SELECT-chain stand-in resolving to the rows the pg driver actually hands
 * back — aggregate columns arrive as STRINGS even where the drizzle
 * `sql<number>` annotation claims otherwise, so the repository must coerce.
 */
function mockSelect(driverRows: unknown[]) {
  const groupBy = vi.fn().mockResolvedValue(driverRows)
  const where = vi.fn(() => ({
    groupBy,
    then: (fn: (rows: unknown[]) => unknown) => fn(driverRows),
  }))
  const from = vi.fn(() => ({ where }))
  mockGetDb.mockReturnValue({ select: vi.fn(() => ({ from })) } as never)
}

function mockExecute(driverRows: unknown[]) {
  const execute = vi.fn().mockResolvedValue(driverRows)
  mockGetDb.mockReturnValue({ execute } as never)
  return execute
}

/** The literal SQL text of the first executed query (bound values excluded). */
function sqlText(execute: ReturnType<typeof vi.fn>): string {
  const chunks = (execute.mock.calls[0][0] as ReturnType<typeof sql>).queryChunks as unknown[]
  return chunks
    .map((chunk) =>
      chunk !== null && typeof chunk === 'object' && chunk.constructor?.name === 'StringChunk'
        ? ((chunk as { value: string[] }).value ?? []).join('')
        : ' '
    )
    .join('')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('insertCitationEvents', () => {
  it('is a no-op for an empty batch (no DB round trip)', async () => {
    expect(await insertCitationEvents([])).toBe(0)
    expect(mockGetDb).not.toHaveBeenCalled()
  })

  it('ignores conflicts on (turn_id, kind) so a retried flush cannot double-count', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'row_1' }])
    const onConflictDoNothing = vi.fn((_config: { target: unknown[] }) => ({ returning }))
    const values = vi.fn(() => ({ onConflictDoNothing }))
    mockGetDb.mockReturnValue({ insert: vi.fn(() => ({ values })) } as never)

    const recorded = await insertCitationEvents([
      { turnId: 'turn_1', agent: 'shallow', kind: 'turn_verified', severity: 'ok' },
    ] as never)

    expect(recorded).toBe(1)
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1)
    expect(onConflictDoNothing.mock.calls[0][0].target).toHaveLength(2)
  })
})

describe('aggregate coercion', () => {
  it('coerces string count aggregates from aggregateByKind', async () => {
    mockSelect([{ kind: 'citations_removed', turns: '18', items: '61' }])
    expect(await aggregateByKind(new Date())).toEqual([
      { kind: 'citations_removed', turns: 18, items: 61 },
    ])
  })

  it('coerces the observed-turn count', async () => {
    mockSelect([{ turns: '204' }])
    expect(await countObservedTurns(new Date())).toBe(204)
  })

  it('returns zero observed turns when the window is empty', async () => {
    mockSelect([])
    expect(await countObservedTurns(new Date())).toBe(0)
  })

  it('coerces the daily turn series, including the distinct defective turns', async () => {
    mockSelect([{ day: '2026-07-28', turns: '12', defectTurns: '5' }])
    expect(await aggregateDailyTurns(new Date())).toEqual([
      { day: '2026-07-28', turns: 12, defectTurns: 5 },
    ])
  })

  it('shapes the raw reason expansion', async () => {
    mockExecute([{ kind: 'citations_removed', reason: 'duplicate', occurrences: '9' }])
    expect(await aggregateReasons(new Date())).toEqual([
      { kind: 'citations_removed', reason: 'duplicate', occurrences: 9 },
    ])
  })

  it('bounds reasons per kind, so one kind cannot crowd another out of the list', async () => {
    const execute = mockExecute([])
    await aggregateReasons(new Date())
    expect(sqlText(execute)).toMatch(/partition by kind/)
  })

  it('shapes the raw per-organization rollup, keeping the unattributed bucket and the exact total', async () => {
    mockExecute([
      { organization_id: null, turns: '7', defect_turns: '2', error_turns: '1', total: '64' },
    ])
    expect(await aggregateByOrganization(new Date())).toEqual({
      rows: [{ organizationId: null, turns: 7, defectTurns: 2, errorTurns: 1 }],
      total: 64,
    })
  })

  it('reports zero organizations for an empty window', async () => {
    mockExecute([])
    expect(await aggregateByOrganization(new Date())).toEqual({ rows: [], total: 0 })
  })

  it('returns the failed targets with the exact distinct-target total', async () => {
    mockExecute([
      {
        target: 'a.pdf',
        reason: 'citation_key_not_in_registry',
        turns: '4',
        organizations: '2',
        last_seen_at: '2026-07-28T10:00:00.000Z',
        total: '1200',
      },
    ])
    const result = await aggregateFailedTargets(new Date())
    expect(result.total).toBe(1200)
    expect(result.rows[0]).toEqual({
      target: 'a.pdf',
      reason: 'citation_key_not_in_registry',
      turns: 4,
      organizations: 2,
      lastSeenAt: new Date('2026-07-28T10:00:00.000Z'),
    })
  })

  it('returns the unavailable tools with the exact distinct-tool total', async () => {
    mockExecute([{ tool: 'ris_search_tool', turns: '3', total: '11' }])
    expect(await aggregateUnavailableTools(new Date())).toEqual({
      rows: [{ tool: 'ris_search_tool', turns: 3 }],
      total: 11,
    })
  })

  it('reads the lanes the emitter writes into the source mix', async () => {
    // Regression: detail.lanes was written by build_turn_events and never read.
    const execute = mockExecute([
      { dimension: 'lane', label: 'oib', turns: '6' },
      { dimension: 'origin', label: 'baurecht', turns: '4' },
      { dimension: 'tool', label: 'ris_search_tool', turns: '2' },
    ])
    expect(await aggregateDefectiveSourceMix(new Date())).toEqual([
      { dimension: 'lane', label: 'oib', turns: 6 },
      { dimension: 'origin', label: 'baurecht', turns: 4 },
      { dimension: 'tool', label: 'ris_search_tool', turns: 2 },
    ])
    expect(sqlText(execute)).toContain("detail -> 'lanes'")
  })
})

describe('countTurnsForTargets', () => {
  it('counts the DISTINCT turns behind a set of rejected targets', async () => {
    // The union, not the sum: three documents rejected on the same turn are
    // three `aggregateFailedTargets` rows of one turn each.
    mockExecute([{ turns: '1' }])
    expect(await countTurnsForTargets(new Date(), ['a.pdf', 'b.pdf', 'c.pdf'])).toBe(1)
  })

  it('makes no DB round trip for an empty target list', async () => {
    expect(await countTurnsForTargets(new Date(), [])).toBe(0)
    expect(mockGetDb).not.toHaveBeenCalled()
  })

  it('binds every target as a parameter rather than interpolating it', async () => {
    const execute = mockExecute([{ turns: '2' }])
    await countTurnsForTargets(new Date(), ["o'brien.pdf", 'b.pdf'])

    // Walk only the chunk tree (arrays + nested SQL), never arbitrary object
    // properties — `queryChunks` also holds the drizzle table, which is cyclic.
    const params: unknown[] = []
    const literalSql: string[] = []
    // A value passed THROUGH the template sits in the chunk list as a bare
    // string (drizzle binds it); text drizzle will emit verbatim is wrapped in
    // a StringChunk. That distinction is exactly what this test is about.
    const collect = (node: unknown): void => {
      if (typeof node === 'string') return void params.push(node)
      if (Array.isArray(node)) return node.forEach(collect)
      if (node === null || typeof node !== 'object') return
      if (node.constructor?.name === 'StringChunk') {
        return void literalSql.push(...((node as { value: string[] }).value ?? []))
      }
      if ('queryChunks' in node) collect((node as { queryChunks: unknown[] }).queryChunks)
    }
    collect((execute.mock.calls[0][0] as ReturnType<typeof sql>).queryChunks)

    expect(params).toContain("o'brien.pdf")
    expect(params).toContain('b.pdf')
    expect(literalSql.join(' ')).not.toContain("o'brien.pdf")
  })
})

describe('raw-SQL window bounds', () => {
  /**
   * Regression guard for a production failure: a raw `db.execute(sql`…`)`
   * carries no column type, so a bare `Date` parameter reaches postgres-js
   * unencodable and the query dies at bind time with
   * `The "string" argument must be of type string … Received an instance of Date`.
   * The select-builder queries are unaffected — only the raw ones, so every one
   * of them must bind an ISO string instead.
   */
  const RAW_QUERIES: [string, (start: Date) => Promise<unknown>][] = [
    ['aggregateReasons', aggregateReasons],
    ['aggregateDefectiveSourceMix', aggregateDefectiveSourceMix],
    ['aggregateFailedTargets', aggregateFailedTargets],
    ['aggregateUnavailableTools', aggregateUnavailableTools],
    ['aggregateByOrganization', aggregateByOrganization],
    ['countTurnsForTargets', (start: Date) => countTurnsForTargets(start, ['a.pdf'])],
  ]

  it.each(RAW_QUERIES)('%s binds no Date parameter', async (_name, run) => {
    const execute = mockExecute([])
    await run(new Date('2026-06-29T00:00:00.000Z'))

    const query = execute.mock.calls[0][0] as ReturnType<typeof sql>
    const dateParams = (query.queryChunks as unknown[]).filter(
      (chunk) => chunk instanceof Date || (chunk as { value?: unknown })?.value instanceof Date
    )
    expect(dateParams).toEqual([])
  })

  it('still binds the requested window, as an ISO string', async () => {
    const execute = mockExecute([])
    await aggregateReasons(new Date('2026-06-29T00:00:00.000Z'))

    // Walk the whole SQL object rather than assuming drizzle's chunk shape —
    // the point is that the timestamp survives as a string, wherever it lands.
    const seen: unknown[] = []
    const walk = (node: unknown, depth: number): void => {
      if (depth > 6 || node === null || typeof node !== 'object') return
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (typeof value === 'string' || value instanceof Date) seen.push(value)
        else walk(value, depth + 1)
      }
    }
    walk(execute.mock.calls[0][0], 0)
    expect(seen).toContain('2026-06-29T00:00:00.000Z')
    expect(seen.some((value) => value instanceof Date)).toBe(false)
  })
})
