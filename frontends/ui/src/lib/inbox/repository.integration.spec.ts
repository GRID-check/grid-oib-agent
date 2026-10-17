/**
 * @vitest-environment node
 *
 * The inbox list's paging against a REAL Postgres, through the restricted
 * runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/inbox/repository.integration.spec.ts
 *
 * What it proves, a claim about SQL a mocked handle cannot disagree with:
 * reading page after page with the cursor each page hands back returns every
 * row exactly once, newest first, also when rows share a microsecond (the id
 * breaks the tie) or only a millisecond (the cursor carries the stored
 * microsecond, which a JS `Date` would have rounded away).
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_inbox_paging_${Date.now()}`
const ME = 'user_inbox_paging'

describe.skipIf(!url)('inbox paging against Postgres', () => {
  let repo: typeof import('./repository')
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let db: ReturnType<typeof import('@/lib/db').getDb>

  const asMe = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: ME }, run)

  /** Microsecond offsets from one base moment: ties, a shared millisecond, and plain steps. */
  const OFFSETS = [0, 0, 0, 1, 2, 999, 1000, 1000, 1500, 2000, 3001, 3001, 5000, 9000, 9001, 12000, 12000, 20000]

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    await asMe(async () => {
      for (const [index, offset] of OFFSETS.entries()) {
        await db.execute(sql`
          insert into inbox_items (organization_id, recipient_user_id, type, resource_type, resource_id,
                                   group_key, actionable, updated_at)
          values (${ORG}, ${ME}, 'conversation.activity', 'conversation', ${`c-${index}`},
                  ${`conversation.activity:conversation:${ORG}-${index}`}, false,
                  timestamptz '2026-10-01 10:00:00+00' + ${offset}::bigint * interval '1 microsecond')`)
      }
    })
  })

  afterAll(async () => {
    await withPlatformAccess('inbox paging spec cleanup', () =>
      db.execute(sql`DELETE FROM inbox_items WHERE organization_id = ${ORG}`)
    )
  })

  it('reads every row exactly once, newest first, page after page', async () => {
    const all = await asMe(() => repo.listInboxItems(ORG, ME, { limit: 100, types: repo.EVERY_INBOX_TYPE }))
    expect(all).toHaveLength(OFFSETS.length)
    expect(all.every((row) => typeof row.listedAtMicros === 'string')).toBe(true)

    for (const size of [1, 2, 3, 5]) {
      const seen: string[] = []
      let cursor: import('./repository').InboxCursor | null = null
      for (let guard = 0; guard < 100; guard++) {
        const page = await asMe(() => repo.listInboxItems(ORG, ME, { cursor, limit: size, types: repo.EVERY_INBOX_TYPE }))
        seen.push(...page.map((row) => row.id))
        const last = page.at(-1)
        if (page.length < size || !last?.listedAtMicros) break
        cursor = { micros: last.listedAtMicros, id: last.id }
      }
      expect(seen, `page size ${size}`).toEqual(all.map((row) => row.id))
    }
  })

  it('orders by the stored microsecond, then by id', async () => {
    const all = await asMe(() => repo.listInboxItems(ORG, ME, { limit: 100, types: repo.EVERY_INBOX_TYPE }))
    const keys = all.map((row) => [BigInt(row.listedAtMicros ?? '0'), row.id] as const)
    const sorted = [...keys].sort(([ta, ia], [tb, ib]) => (ta !== tb ? (tb > ta ? 1 : -1) : ia < ib ? 1 : ia > ib ? -1 : 0))
    expect(keys).toEqual(sorted)
  })
})
