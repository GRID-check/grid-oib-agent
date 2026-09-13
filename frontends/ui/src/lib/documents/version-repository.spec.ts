/**
 * @vitest-environment node
 */
/**
 * `findPreviousVersion` — the diff base for a review round.
 *
 * The predecessor used to be found by scanning the asc-limited-200 page in
 * memory. Past 200 versions that page no longer contains the predecessor at
 * all, and the scan then named the wrong row (the highest inside the window)
 * as the diff base. These tests pin the statement instead: a direct
 * `version_number < $n ORDER BY version_number DESC LIMIT 1` inside the tenant
 * boundary, so Postgres answers the predecessor no matter how long the history
 * is.
 *
 * Same pg-proxy harness as `lib/inbox/repository.spec.ts`: a real query
 * builder over a callback driver that records the SQL instead of connecting.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: [] }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))

import { findPreviousVersion } from './version-repository'

function onlyQuery(): CapturedQuery {
  expect(captured).toHaveLength(1)
  return captured[0]
}

beforeEach(() => {
  captured.length = 0
})

describe('findPreviousVersion — the diff base', () => {
  it('asks for the highest version below the given number, newest first, one row', async () => {
    const result = await findPreviousVersion('doc_1', 'org_1', 201)

    expect(result).toBeNull()
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"version_number" </)
    expect(sql.toLowerCase()).toContain('order by')
    expect(sql.toLowerCase()).toContain('desc')
    expect(sql.toLowerCase()).toContain('limit')
    // Tenant boundary travels with the query.
    expect(params).toContain('doc_1')
    expect(params).toContain('org_1')
    expect(params).toContain(201)
  })
})
