/**
 * Opt-in integration test: a chat marked deleting is queued for the purger, and
 * the purger's claim picks it up — or leaves it, under a legal hold — against a
 * REAL Postgres with every migration applied, as the restricted runtime role.
 *
 * The unit suites double the repository and the purger's transaction. Only this
 * can prove the SQL: that the mark and the queue row land together under
 * row-level security, that `deletion_queue_active_entity_idx` keeps one active
 * row per chat, that closing it leaves the purger's own claim alone, that the
 * claim query (`purger/db.js`) with its `grid_legal_hold_blocks` guard treats a
 * conversation row the way it treats a project, and that migration 0095's
 * backfill queues exactly the chats stuck before it.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/conversations/erasure-queue.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const STAMP = Date.now()
const ORG = `org_erase_${STAMP}`
const USER = `user_erase_${STAMP}`
const CHAT = `s_erase_chat_${STAMP}`
const HELD_CHAT = `s_erase_held_${STAMP}`
const STUCK_CHAT = `s_erase_stuck_${STAMP}`
const LIVE_CHAT = `s_erase_live_${STAMP}`

type QueueRow = {
  entity_id: string
  status: string
  requested_by: string
  display_name: string
  purge_after: Date
  attempts: number
}

class Rollback extends Error {}

describe.skipIf(!url)('chat erasure retry queue against live Postgres (migration 0095)', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')

  const inOrg = <T>(fn: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: USER }, fn)

  async function queueRows(entityId: string): Promise<QueueRow[]> {
    const rows = await withPlatformAccess('test: read queue', () =>
      db.execute<QueueRow>(sql`
        select entity_id, status, requested_by, display_name, purge_after, attempts
          from deletion_queue
         where entity_type = 'conversation' and entity_id = ${entityId}
         order by requested_at`),
    )
    return Array.from(rows).map((row) => ({ ...row, purge_after: new Date(row.purge_after) }))
  }

  async function makeDue(entityId: string): Promise<void> {
    await withPlatformAccess('test: make due', () =>
      db.execute(sql`
        update deletion_queue set purge_after = now() - interval '1 minute'
         where entity_type = 'conversation' and entity_id = ${entityId} and status = 'pending'`),
    )
  }

  /**
   * Every row the purger's claim would take right now, claimed one at a time
   * exactly as `processOne` does — then rolled back, so the database (which
   * other suites share) is left as it was.
   */
  async function claimableIds(): Promise<string[]> {
    const { claimNext } = await import('../../../purger/db.js')
    const client = postgres(url as string, { prepare: false, max: 1 })
    const claimed: string[] = []
    try {
      await client.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE grid_app_platform')
        for (let i = 0; i < 1000; i += 1) {
          const entry = await claimNext(tx as never)
          if (!entry) break
          claimed.push(entry.entity_id)
        }
        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) throw error
    } finally {
      await client.end()
    }
    return claimed
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    repo = await import('./repository')
    db = (await import('@/lib/db')).getDb()

    await withPlatformAccess('test seed: organization', () =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name) values (${ORG}, ${ORG}) on conflict do nothing`,
      ),
    )
    await inOrg(() =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, title) values
          (${CHAT}, ${ORG}, ${USER}, 'Brandschutz'),
          (${HELD_CHAT}, ${ORG}, ${USER}, null),
          (${STUCK_CHAT}, ${ORG}, ${USER}, '  '),
          (${LIVE_CHAT}, ${ORG}, ${USER}, 'Lebendig')
      `),
    )
  })

  beforeEach(async () => {
    await withPlatformAccess('test: clear holds', () =>
      db.execute(sql`delete from legal_holds where organization_id = ${ORG}`),
    )
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from legal_holds where organization_id = ${ORG}`)
      await db.execute(sql`delete from deletion_queue where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from organizations where workos_organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('marking a chat deleting queues its erasure in the same write, once', async () => {
    const before = Date.now()
    const marked = await inOrg(() => repo.markConversationDeleting(CHAT, ORG, USER))
    expect(marked?.deletedAt).toBeInstanceOf(Date)

    // A second DELETE re-stamps the mark and leaves the queued retry alone.
    await inOrg(() => repo.markConversationDeleting(CHAT, ORG, USER))

    const rows = await queueRows(CHAT)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'pending', requested_by: USER, display_name: 'Brandschutz', attempts: 0 })
    // Not claimable while the request that marked it is still erasing.
    expect(rows[0].purge_after.getTime()).toBeGreaterThanOrEqual(
      before + repo.CONVERSATION_ERASURE_RETRY_DELAY_MS - 5_000,
    )
    expect(await claimableIds()).not.toContain(CHAT)
  })

  it('marks nothing and queues nothing for a chat of another organization', async () => {
    const marked = await withTenant({ organizationId: `${ORG}_other`, userId: USER }, () =>
      repo.markConversationDeleting(LIVE_CHAT, `${ORG}_other`, USER),
    )
    expect(marked).toBeNull()
    expect(await queueRows(LIVE_CHAT)).toHaveLength(0)
  })

  it('the purger claims a due chat erasure, and a legal hold keeps it waiting', async () => {
    await inOrg(() => repo.markConversationDeleting(HELD_CHAT, ORG, USER))
    await makeDue(HELD_CHAT)
    await makeDue(CHAT)

    expect(await claimableIds()).toEqual(expect.arrayContaining([CHAT, HELD_CHAT]))

    await inOrg(() =>
      db.execute(sql`
        insert into legal_holds (entity_type, entity_id, organization_id, reason, created_by)
        values ('conversation', ${HELD_CHAT}, ${ORG}, 'integration test', ${USER})`),
    )
    const claimable = await claimableIds()
    expect(claimable).toContain(CHAT)
    expect(claimable).not.toContain(HELD_CHAT)
    // Surfaced, not lost: still pending in the admin deletions list.
    expect((await queueRows(HELD_CHAT))[0].status).toBe('pending')
  })

  it('closing the erasure takes pending and failed rows, never the purger’s claimed one', async () => {
    await withPlatformAccess('test: a failed and a claimed row', () =>
      db.execute(sql`
        update deletion_queue set status = 'failed', attempts = 10
         where entity_type = 'conversation' and entity_id = ${HELD_CHAT}`),
    )
    // A person deletes again after the purger gave up: a new pending row.
    await inOrg(() => repo.markConversationDeleting(HELD_CHAT, ORG, USER))
    expect((await queueRows(HELD_CHAT)).map((row) => row.status)).toEqual(['failed', 'pending'])

    expect(await inOrg(() => repo.recordConversationErased(HELD_CHAT, ORG))).toBe(2)
    expect((await queueRows(HELD_CHAT)).map((row) => row.status)).toEqual(['purged', 'purged'])

    await withPlatformAccess('test: purger claimed', () =>
      db.execute(sql`
        update deletion_queue set status = 'purging', claimed_at = now()
         where entity_type = 'conversation' and entity_id = ${CHAT}`),
    )
    expect(await inOrg(() => repo.recordConversationErased(CHAT, ORG))).toBe(0)
    expect((await queueRows(CHAT))[0].status).toBe('purging')
  })

  it('migration 0095 queues the chats stuck deleting before it, and only those', async () => {
    // Stuck the old way: marked, no queue row.
    await inOrg(() =>
      db.execute(sql`update conversations set deleted_at = now() where id = ${STUCK_CHAT}`),
    )
    const backfill = readFileSync(
      path.join(process.cwd(), 'drizzle/0095_conversation_erasure_retry.sql'),
      'utf8',
    )
    await withPlatformAccess('test: re-run the 0095 backfill', () => db.execute(sql.raw(backfill)))

    const stuck = await queueRows(STUCK_CHAT)
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatchObject({ status: 'pending', requested_by: USER, display_name: 'Chat' })
    // A live chat is never queued, and a chat that already has an active row
    // (CHAT, claimed above) does not get a second one.
    expect(await queueRows(LIVE_CHAT)).toHaveLength(0)
    expect(await queueRows(CHAT)).toHaveLength(1)
  })
})
