/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

import { getDb } from '@/lib/db'
import { listProfiledConversations } from './repository'

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
  const where = vi.fn(() => ({ groupBy }))
  const leftJoin = vi.fn(() => ({ where }))
  const from = vi.fn(() => ({ leftJoin }))
  mockGetDb.mockReturnValue({ select: vi.fn(() => ({ from })) } as never)
  return { limit }
}

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
