/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
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
  citationScopeWhere,
  insertCitationEvents,
  listEventsForExport,
  listRecentDefects,
  type CitationScopeFilter,
} from './repository'

const mockGetDb = vi.mocked(getDb)

/** September 2026, every organization and project. */
const SEPTEMBER: CitationScopeFilter = {
  start: new Date('2026-09-01T00:00:00.000Z'),
  endExclusive: new Date('2026-10-01T00:00:00.000Z'),
  organizationIds: [],
  projectIds: [],
}

const PROJECT = '0f0f0f0f-0000-4000-8000-0000000000a1'

/** What Postgres would receive: the SQL text with placeholders, and the bound values. */
function render(fragment: SQL): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(fragment)
}

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
    expect(await aggregateByKind(SEPTEMBER)).toEqual([
      { kind: 'citations_removed', turns: 18, items: 61 },
    ])
  })

  it('coerces the observed-turn count', async () => {
    mockSelect([{ turns: '204' }])
    expect(await countObservedTurns(SEPTEMBER)).toBe(204)
  })

  it('returns zero observed turns when the window is empty', async () => {
    mockSelect([])
    expect(await countObservedTurns(SEPTEMBER)).toBe(0)
  })

  it('coerces the daily turn series, including the distinct defective turns', async () => {
    mockSelect([{ day: '2026-07-28', turns: '12', defectTurns: '5' }])
    expect(await aggregateDailyTurns(SEPTEMBER)).toEqual([
      { day: '2026-07-28', turns: 12, defectTurns: 5 },
    ])
  })

  it('shapes the raw reason expansion', async () => {
    mockExecute([{ kind: 'citations_removed', reason: 'duplicate', occurrences: '9' }])
    expect(await aggregateReasons(SEPTEMBER)).toEqual([
      { kind: 'citations_removed', reason: 'duplicate', occurrences: 9 },
    ])
  })

  it('bounds reasons per kind, so one kind cannot crowd another out of the list', async () => {
    const execute = mockExecute([])
    await aggregateReasons(SEPTEMBER)
    expect(sqlText(execute)).toMatch(/partition by kind/)
  })

  it('shapes the raw per-organization rollup, keeping the unattributed bucket and the exact total', async () => {
    mockExecute([
      { organization_id: null, turns: '7', defect_turns: '2', error_turns: '1', total: '64' },
    ])
    expect(await aggregateByOrganization(SEPTEMBER)).toEqual({
      rows: [{ organizationId: null, turns: 7, defectTurns: 2, errorTurns: 1 }],
      total: 64,
    })
  })

  it('reports zero organizations for an empty window', async () => {
    mockExecute([])
    expect(await aggregateByOrganization(SEPTEMBER)).toEqual({ rows: [], total: 0 })
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
    const result = await aggregateFailedTargets(SEPTEMBER)
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
    expect(await aggregateUnavailableTools(SEPTEMBER)).toEqual({
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
    expect(await aggregateDefectiveSourceMix(SEPTEMBER)).toEqual([
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
    expect(await countTurnsForTargets(SEPTEMBER, ['a.pdf', 'b.pdf', 'c.pdf'])).toBe(1)
  })

  it('makes no DB round trip for an empty target list', async () => {
    expect(await countTurnsForTargets(SEPTEMBER, [])).toBe(0)
    expect(mockGetDb).not.toHaveBeenCalled()
  })

  it('binds every target as a parameter rather than interpolating it', async () => {
    const execute = mockExecute([{ turns: '2' }])
    await countTurnsForTargets(SEPTEMBER, ["o'brien.pdf", 'b.pdf'])

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

describe('the scope predicate', () => {
  it('bounds created_at to [start, endExclusive) as cast ISO strings, never a Date', () => {
    const { sql: text, params } = render(citationScopeWhere(SEPTEMBER, 'e'))
    expect(text).toBe('"e".created_at >= $1::timestamptz and "e".created_at < $2::timestamptz')
    // A raw fragment carries no column type: a bare Date reaches postgres-js
    // unencodable and the query dies at bind time.
    expect(params).toEqual(['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'])
  })

  it('binds each organization as a parameter', () => {
    const { sql: text, params } = render(
      citationScopeWhere({ ...SEPTEMBER, organizationIds: ['org_1', "o'rg"] })
    )
    expect(text).toContain('"citation_events".organization_id in ($3, $4)')
    expect(params.slice(2)).toEqual(['org_1', "o'rg"])
    expect(text).not.toContain("o'rg")
  })

  it('resolves a project through the conversation, in the same organization', () => {
    const { sql: text, params } = render(
      citationScopeWhere({ ...SEPTEMBER, projectIds: [PROJECT] }, 'e')
    )
    expect(text).toMatch(/exists \(\s*select 1 from "conversations" scope_c/)
    expect(text).toContain('scope_c.id = "e".conversation_id')
    expect(text).toContain('scope_c.organization_id = "e".organization_id')
    expect(text).toContain('scope_c.project_id in ($3::uuid)')
    expect(params[2]).toBe(PROJECT)
  })

  it('matches nothing for a project id that cannot be a project, rather than failing the cast', () => {
    const { sql: text, params } = render(
      citationScopeWhere({ ...SEPTEMBER, projectIds: ['not-a-uuid'] })
    )
    expect(text).toMatch(/ and false$/)
    expect(params).not.toContain('not-a-uuid')
  })

  /**
   * Every query, select builder or raw, must carry the whole scope: one that
   * forgot the organization filter would mix tenants into a narrowed view.
   */
  const SCOPED: CitationScopeFilter = {
    ...SEPTEMBER,
    organizationIds: ['org_scope'],
    projectIds: [PROJECT],
  }
  const RAW_QUERIES: [string, () => Promise<unknown>][] = [
    ['aggregateReasons', () => aggregateReasons(SCOPED)],
    ['aggregateDefectiveSourceMix', () => aggregateDefectiveSourceMix(SCOPED)],
    ['aggregateFailedTargets', () => aggregateFailedTargets(SCOPED)],
    ['aggregateUnavailableTools', () => aggregateUnavailableTools(SCOPED)],
    ['aggregateByOrganization', () => aggregateByOrganization(SCOPED)],
    ['countTurnsForTargets', () => countTurnsForTargets(SCOPED, ['a.pdf'])],
  ]

  it.each(RAW_QUERIES)('%s filters by range, organization and project', async (_name, run) => {
    const execute = mockExecute([])
    await run()
    const { sql: text, params } = render(execute.mock.calls[0][0] as SQL)
    expect(text).toContain('"e".created_at <')
    expect(text).toContain('"e".organization_id in (')
    expect(text).toContain('scope_c.project_id in (')
    expect(params).toEqual(
      expect.arrayContaining(['2026-10-01T00:00:00.000Z', 'org_scope', PROJECT])
    )
    expect(params.some((value) => value instanceof Date)).toBe(false)
  })

  it('scopes the defective-turn CTE AND the baseline rows of the source mix', async () => {
    const execute = mockExecute([])
    await aggregateDefectiveSourceMix(SCOPED)
    const { sql: text } = render(execute.mock.calls[0][0] as SQL)
    expect(text.match(/scope_c\.project_id in \(/g)).toHaveLength(2)
  })

  it.each([
    ['listRecentDefects', () => listRecentDefects(SCOPED)],
    ['listEventsForExport', () => listEventsForExport(SCOPED)],
  ])('%s filters by range, organization and project', async (_name, run) => {
    let where: SQL | undefined
    const chain = {
      where: vi.fn((condition: SQL) => {
        where = condition
        return chain
      }),
      orderBy: vi.fn(() => chain),
      limit: vi.fn().mockResolvedValue([]),
    }
    mockGetDb.mockReturnValue({ select: vi.fn(() => ({ from: vi.fn(() => chain) })) } as never)
    await run()
    const { sql: text, params } = render(where as SQL)
    expect(text).toContain('"citation_events".created_at >=')
    expect(text).toContain('"citation_events".organization_id in (')
    expect(text).toContain('scope_c.project_id in (')
    expect(params).toEqual(expect.arrayContaining(['org_scope', PROJECT]))
  })
})
