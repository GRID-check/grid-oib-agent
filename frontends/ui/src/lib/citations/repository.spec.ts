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
  const where = vi.fn(() => ({ groupBy, then: (fn: (rows: unknown[]) => unknown) => fn(driverRows) }))
  const from = vi.fn(() => ({ where }))
  mockGetDb.mockReturnValue({ select: vi.fn(() => ({ from })) } as never)
}

function mockExecute(driverRows: unknown[]) {
  const execute = vi.fn().mockResolvedValue(driverRows)
  mockGetDb.mockReturnValue({ execute } as never)
  return execute
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
    expect(await aggregateByKind(new Date())).toEqual([{ kind: 'citations_removed', turns: 18, items: 61 }])
  })

  it('coerces the observed-turn count', async () => {
    mockSelect([{ turns: '204' }])
    expect(await countObservedTurns(new Date())).toBe(204)
  })

  it('returns zero observed turns when the window is empty', async () => {
    mockSelect([])
    expect(await countObservedTurns(new Date())).toBe(0)
  })

  it('coerces the daily turn series', async () => {
    mockSelect([{ day: '2026-07-28', turns: '12' }])
    expect(await aggregateDailyTurns(new Date())).toEqual([{ day: '2026-07-28', turns: 12 }])
  })

  it('shapes the raw reason expansion', async () => {
    mockExecute([{ kind: 'citations_removed', reason: 'duplicate', occurrences: '9' }])
    expect(await aggregateReasons(new Date())).toEqual([
      { kind: 'citations_removed', reason: 'duplicate', occurrences: 9 },
    ])
  })

  it('shapes the raw per-organization rollup, keeping the unattributed bucket', async () => {
    mockExecute([{ organization_id: null, turns: '7', defect_turns: '2', error_turns: '1' }])
    expect(await aggregateByOrganization(new Date())).toEqual([
      { organizationId: null, turns: 7, defectTurns: 2, errorTurns: 1 },
    ])
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
  ]

  it.each(RAW_QUERIES)('%s binds no Date parameter', async (_name, run) => {
    const execute = mockExecute([])
    await run(new Date('2026-06-29T00:00:00.000Z'))

    const query = execute.mock.calls[0][0] as ReturnType<typeof sql>
    const dateParams = (query.queryChunks as unknown[]).filter(
      (chunk) => chunk instanceof Date || (chunk as { value?: unknown })?.value instanceof Date,
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
