/**
 * Opt-in integration test: the answer-feedback platform reads against a REAL
 * Postgres with every migration applied, as the restricted runtime role.
 *
 * The unit suite doubles drizzle and can only pin the SQL's shape. Every claim
 * here is a claim about what Postgres does with it: which question a lateral
 * join pairs with an answer, how a NULL groups, where a window starts. Those
 * are exactly the claims a mocked handle agrees with whatever the fixture says.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/feedback/repository.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const STAMP = Date.now()
const ORG = `org_feedback_${STAMP}`
const USER = `user_feedback_${STAMP}`
const CHAT = `s_feedback_chat_${STAMP}`

/** Fixed ids, so a failing assertion names the row it is about. */
const Q1 = '0f0f0f0f-0000-4000-8000-000000000001'
const A1 = '0f0f0f0f-0000-4000-8000-000000000002'
const Q2 = '0f0f0f0f-0000-4000-8000-000000000003'
const A2 = '0f0f0f0f-0000-4000-8000-000000000004'
/** An answer id with no message row: the turn was never persisted. */
const A_MISSING = '0f0f0f0f-0000-4000-8000-0000000000ff'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

describe.skipIf(!url)('answer-feedback platform reads against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let lessons: typeof import('@/lib/platform-lessons/repository')

  const inOrg = <T>(fn: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: USER }, fn)
  const platform = <T>(fn: () => PromiseLike<T>) => withPlatformAccess('test: feedback platform read', fn)

  async function vote(messageId: string, verdict: 'up' | 'down', fields: { reason?: string | null } = {}) {
    await inOrg(() =>
      db.execute(sql`
        insert into answer_feedback (organization_id, conversation_id, message_id, user_id, verdict, reason)
        values (${ORG}, ${CHAT}, ${messageId}, ${`${USER}_${messageId}`}, ${verdict}, ${fields.reason ?? null})
      `),
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    repo = await import('./repository')
    lessons = await import('@/lib/platform-lessons/repository')
    db = (await import('@/lib/db')).getDb()

    await platform(() =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name) values (${ORG}, ${ORG}) on conflict do nothing`,
      ),
    )
    await inOrg(async () => {
      await db.execute(sql`
        insert into conversations (id, organization_id, created_by, title) values (${CHAT}, ${ORG}, ${USER}, 'Fluchtwege')
      `)
      // Two turns, in order: Q1 -> A1, then Q2 -> A2. Q2 is the NEWEST user
      // message, which is what the old predicate paired with an answer it
      // could not find.
      await db.execute(sql`
        insert into messages (id, conversation_id, role, content, created_at) values
          (${Q1}::uuid, ${CHAT}, 'user',      'Wie lang darf der Fluchtweg sein?', ${minutesAgo(40)}::timestamptz),
          (${A1}::uuid, ${CHAT}, 'assistant', '40 m bei GK 4.',                    ${minutesAgo(39)}::timestamptz),
          (${Q2}::uuid, ${CHAT}, 'user',      'Und bei GK 5?',                     ${minutesAgo(20)}::timestamptz),
          (${A2}::uuid, ${CHAT}, 'assistant', 'Ebenfalls 40 m.',                   ${minutesAgo(19)}::timestamptz)
      `)
    })
    await vote(A1, 'down', { reason: 'inaccurate' })
    await vote(A2, 'down', { reason: 'other' })
    await vote(A_MISSING, 'down')
  })

  afterAll(async () => {
    if (!db) return
    await platform(async () => {
      await db.execute(sql`delete from platform_lesson_reports where feedback_id in (
        select id from answer_feedback where organization_id = ${ORG})`)
      await db.execute(sql`delete from answer_feedback where organization_id = ${ORG}`)
      await db.execute(sql`delete from messages where conversation_id = ${CHAT}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from organizations where workos_organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('reason counts', () => {
    /**
     * A down-vote with no chip used to group as its own NULL row beside
     * `other`, and the digest keyed both as `other`, keeping whichever came last.
     */
    it('folds a missing reason into `other`, so the rows sum to the down-votes', async () => {
      const health = await platform(() => repo.getFeedbackHealth({ organizationId: ORG }))
      const byReason = Object.fromEntries(health.reasons.map((row) => [row.reason, row.count]))

      expect(health.reasons.every((row) => row.reason !== null)).toBe(true)
      expect(byReason).toEqual({ inaccurate: 1, other: 2 })
      expect(health.reasons.reduce((sum, row) => sum + row.count, 0)).toBe(health.totals.down)
    })

    it('lists a chip-less down-vote under the `other` filter', async () => {
      const turns = await platform(() =>
        repo.listFeedbackTurns({ organizationId: ORG, verdict: 'down', reason: 'other' }),
      )
      expect(turns.map((turn) => turn.messageId).sort()).toEqual([A2, A_MISSING].sort())
    })
  })

  describe('pairing an answer with its question', () => {
    it('pairs each answer with the user message that preceded it, not the newest one', async () => {
      const turns = await platform(() => repo.listFeedbackTurns({ organizationId: ORG, verdict: 'down' }))
      const byMessage = new Map(turns.map((turn) => [turn.messageId, turn]))

      expect(byMessage.get(A1)).toMatchObject({ answer: '40 m bei GK 4.', question: 'Wie lang darf der Fluchtweg sein?' })
      expect(byMessage.get(A2)).toMatchObject({ answer: 'Ebenfalls 40 m.', question: 'Und bei GK 5?' })
    })

    it('leaves the question empty when the answer row is missing, rather than guessing', async () => {
      const turns = await platform(() => repo.listFeedbackTurns({ organizationId: ORG, verdict: 'down' }))
      const orphan = turns.find((turn) => turn.messageId === A_MISSING)

      expect(orphan).toBeDefined()
      expect(orphan?.answer).toBeNull()
      expect(orphan?.question).toBeNull()
    })

    it('feeds the lesson sweep the same pairing', async () => {
      const pending = await platform(() => lessons.listUnprocessedDownvotes(500))
      const ours = pending.filter((row) => row.organizationId === ORG)
      const byAnswer = new Map(ours.map((row) => [row.answer, row.question]))

      expect(byAnswer.get('40 m bei GK 4.')).toBe('Wie lang darf der Fluchtweg sein?')
      expect(byAnswer.get(null)).toBeNull()
    })
  })
})
