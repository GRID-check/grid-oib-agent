/**
 * @vitest-environment node
 *
 * The restricted-turn mark (ADR-0078, migration 0105) against a REAL Postgres,
 * through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/conversations/restricted-turns.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * The unit specs fake the store; these prove the SQL the share refusal rests
 * on: the admission's upsert is idempotent and counts, a first turn marks a
 * conversation that does not exist yet, the real descriptor refuses on the mark
 * with no stored source at all, a refused first ask leaves nothing behind, the
 * erasure takes the mark with the row, and another organization can neither
 * see a mark nor write one into this organization.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_rturn_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_rturn_${STAMP}`
const NEW_CHAT = `s_rturn_new_${STAMP}`
const SHARED_CHAT = `s_rturn_shared_${STAMP}`
const ERASED_CHAT = `s_rturn_erased_${STAMP}`

type MarkRow = { turn_count: number; first_at: Date; last_at: Date }

describe.skipIf(!url)('restricted-turn marks against Postgres (migration 0105)', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./repository')
  let confinement: typeof import('./confinement')
  let registry: typeof import('@/lib/sharing/registry')

  const inOrg = <T>(organizationId: string, fn: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: USER }, fn)

  async function markOf(organizationId: string, conversationId: string): Promise<MarkRow | null> {
    const rows = await inOrg(organizationId, () =>
      db.execute<MarkRow>(sql`
        select turn_count, first_at, last_at from conversation_restricted_turns
         where organization_id = ${organizationId} and conversation_id = ${conversationId}`)
    )
    const row = Array.from(rows)[0]
    return row
      ? { turn_count: Number(row.turn_count), first_at: new Date(row.first_at), last_at: new Date(row.last_at) }
      : null
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    confinement = await import('./confinement')
    registry = await import('@/lib/sharing/registry')
    await inOrg(ORG, () =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, visibility) values
          (${SHARED_CHAT}, ${ORG}, ${USER}, 'project'),
          (${ERASED_CHAT}, ${ORG}, ${USER}, 'private')`)
    )
  })

  afterAll(async () => {
    await inOrg(ORG, () => db.execute(sql`delete from conversation_restricted_turns where organization_id = ${ORG}`))
    await inOrg(ORG, () => db.execute(sql`delete from conversations where organization_id = ${ORG}`))
  })

  it('admits the first turn of a chat that does not exist yet, and marks it once', async () => {
    expect(await inOrg(ORG, () => confinement.admitRestrictedTurn(ORG, USER, NEW_CHAT))).toBe(true)

    const first = await markOf(ORG, NEW_CHAT)
    expect(first?.turn_count).toBe(1)

    expect(await inOrg(ORG, () => confinement.admitRestrictedTurn(ORG, USER, NEW_CHAT))).toBe(true)
    const second = await markOf(ORG, NEW_CHAT)
    expect(second?.turn_count).toBe(2)
    expect(second?.first_at.getTime()).toBe(first?.first_at.getTime())
    expect(second!.last_at.getTime()).toBeGreaterThanOrEqual(first!.last_at.getTime())
  })

  it('refuses to share on the mark alone: no stored answer names a restricted collection', async () => {
    const confinedToOwner = registry.describeResource('conversation').confinedToOwner!
    expect(await inOrg(ORG, () => repo.listRestrictedAnswerCollections(NEW_CHAT, ORG))).toEqual([])

    expect(await inOrg(ORG, () => confinedToOwner(NEW_CHAT, ORG))).toBe(true)
    expect(await inOrg(ORG, () => confinedToOwner(SHARED_CHAT, ORG))).toBe(false)
  })

  it('refuses a turn on a thread already shared, and leaves no mark behind', async () => {
    expect(await inOrg(ORG, () => confinement.admitRestrictedTurn(ORG, USER, SHARED_CHAT))).toBe(false)

    expect(await markOf(ORG, SHARED_CHAT)).toBeNull()
  })

  it('keeps a mark a second turn also wrote when withdrawing a first ask', async () => {
    await inOrg(ORG, () => repo.withdrawFreshRestrictedTurn(NEW_CHAT, ORG))

    expect((await markOf(ORG, NEW_CHAT))?.turn_count).toBe(2)
  })

  it('takes the mark with the conversation when the chat is erased', async () => {
    expect(await inOrg(ORG, () => confinement.admitRestrictedTurn(ORG, USER, ERASED_CHAT))).toBe(true)
    expect(await markOf(ORG, ERASED_CHAT)).not.toBeNull()

    await inOrg(ORG, () => repo.deleteConversationInOrg(ERASED_CHAT, ORG))

    expect(await markOf(ORG, ERASED_CHAT)).toBeNull()
  })

  it('is invisible to another organization, which cannot write one here either', async () => {
    expect(await inOrg(OTHER_ORG, () => repo.hasRestrictedTurn(NEW_CHAT, ORG))).toBe(false)
    const seen = await inOrg(OTHER_ORG, () =>
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from conversation_restricted_turns where conversation_id = ${NEW_CHAT}`
      )
    )
    expect(Number(Array.from(seen)[0]?.n)).toBe(0)

    await expect(
      inOrg(OTHER_ORG, () => repo.recordRestrictedTurn(`s_rturn_forged_${STAMP}`, ORG))
    ).rejects.toThrow()
  })
})
