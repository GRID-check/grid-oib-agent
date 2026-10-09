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
/** A1's trace id, as the agent writes it: the answer UUID's 32 hex digits. */
const TRACE_A1 = A1.replace(/-/g, '')
/** An answer from before every window, rated today. */
const A_OLD = '0f0f0f0f-0000-4000-8000-000000000005'

/** Another tenant, with an answer of its own that ORG's vote will name. */
const OTHER_ORG = `org_feedback_other_${STAMP}`
const OTHER_CHAT = `s_feedback_other_${STAMP}`
const OTHER_Q = '0f0f0f0f-0000-4000-8000-000000000011'
const OTHER_A = '0f0f0f0f-0000-4000-8000-000000000012'

/**
 * A third tenant whose votes CLAIM a conversation: the client sends
 * `conversation_id` with every vote, and here it names OTHER_ORG's chat.
 */
const CLAIM_ORG = `org_feedback_claims_${STAMP}`
const CLAIM_CHAT = `s_feedback_claims_${STAMP}`
const CLAIM_A = '0f0f0f0f-0000-4000-8000-000000000021'
const CLAIM_MISSING = '0f0f0f0f-0000-4000-8000-0000000000fe'

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
          (${A2}::uuid, ${CHAT}, 'assistant', 'Ebenfalls 40 m.',                   ${minutesAgo(19)}::timestamptz),
          (${A_OLD}::uuid, ${CHAT}, 'assistant', 'Eine alte Antwort.',             ${minutesAgo(100 * 24 * 60)}::timestamptz)
      `)
      // The agent names the trace an answer was produced in on its row
      // (`observability/turn_trace.py`); A1 has one, A2 predates the field.
      await db.execute(sql`
        update messages set metadata = jsonb_build_object('trace_id', ${TRACE_A1}::text) where id = ${A1}::uuid
      `)
    })
    // The other tenant's turn. ORG's vote names its answer id below: nothing at
    // vote time can see that row, so only the read can keep the two apart.
    await platform(() =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name) values (${OTHER_ORG}, ${OTHER_ORG}) on conflict do nothing`,
      ),
    )
    await withTenant({ organizationId: OTHER_ORG, userId: USER }, async () => {
      await db.execute(sql`
        insert into conversations (id, organization_id, created_by, title, tags)
        values (${OTHER_CHAT}, ${OTHER_ORG}, ${USER}, 'Vertraulich', array['schallschutz'])
      `)
      await db.execute(sql`
        insert into messages (id, conversation_id, role, content, created_at) values
          (${OTHER_Q}::uuid, ${OTHER_CHAT}, 'user',      'Geheime Frage',  ${minutesAgo(30)}::timestamptz),
          (${OTHER_A}::uuid, ${OTHER_CHAT}, 'assistant', 'Geheime Antwort', ${minutesAgo(29)}::timestamptz)
      `)
    })
    await vote(OTHER_A, 'up')

    await platform(() =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name) values (${CLAIM_ORG}, ${CLAIM_ORG}) on conflict do nothing`,
      ),
    )
    await withTenant({ organizationId: CLAIM_ORG, userId: USER }, async () => {
      await db.execute(sql`
        insert into conversations (id, organization_id, created_by, title, tags)
        values (${CLAIM_CHAT}, ${CLAIM_ORG}, ${USER}, 'Eigene', array['brandschutz'])
      `)
      await db.execute(sql`
        insert into messages (id, conversation_id, role, content, created_at)
        values (${CLAIM_A}::uuid, ${CLAIM_CHAT}, 'assistant', 'Eigene Antwort', ${minutesAgo(10)}::timestamptz)
      `)
      // Both votes name OTHER_ORG's chat. The first rated an answer whose row
      // says otherwise; the second rated a turn that was never persisted.
      await db.execute(sql`
        insert into answer_feedback (organization_id, conversation_id, message_id, user_id, verdict) values
          (${CLAIM_ORG}, ${OTHER_CHAT}, ${CLAIM_A},       ${`${USER}_claim_a`},       'down'),
          (${CLAIM_ORG}, ${OTHER_CHAT}, ${CLAIM_MISSING}, ${`${USER}_claim_missing`}, 'down')
      `)
    })
    await vote(A1, 'down', { reason: 'inaccurate' })
    await vote(A2, 'down', { reason: 'other' })
    await vote(A_MISSING, 'down')
    await vote(A_OLD, 'up')
    // A second person rating the same answer: one more vote, no more answers.
    await inOrg(() =>
      db.execute(sql`
        insert into answer_feedback (organization_id, conversation_id, message_id, user_id, verdict)
        values (${ORG}, ${CHAT}, ${A1}, ${`${USER}_second`}, 'up')
      `),
    )
  })

  afterAll(async () => {
    if (!db) return
    await platform(async () => {
      await db.execute(sql`delete from platform_lesson_reports where feedback_id in (
        select id from answer_feedback where organization_id = ${ORG})`)
      await db.execute(sql`delete from answer_feedback where organization_id = ${ORG}`)
      await db.execute(sql`delete from messages where conversation_id = ${CHAT}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from answer_feedback where organization_id = ${CLAIM_ORG}`)
      await db.execute(sql`delete from messages where conversation_id in (${OTHER_CHAT}, ${CLAIM_CHAT})`)
      await db.execute(sql`delete from conversations where organization_id = ${CLAIM_ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${OTHER_ORG}`)
      await db.execute(
        sql`delete from organizations where workos_organization_id in (${ORG}, ${OTHER_ORG}, ${CLAIM_ORG})`,
      )
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('the Langfuse trace of a rated answer', () => {
    it('is read off the answer row, for the vote path and the drill-in alike', async () => {
      await expect(inOrg(() => repo.getAnswerTraceId(A1, ORG))).resolves.toBe(TRACE_A1)
      await expect(inOrg(() => repo.getAnswerTraceId(A2, ORG))).resolves.toBeNull()
      await expect(inOrg(() => repo.getAnswerTraceId(A_MISSING, ORG))).resolves.toBeNull()

      const turns = await platform(() => repo.listFeedbackTurns({ organizationId: ORG, verdict: 'down' }))
      const traceOf = new Map(turns.map((turn) => [turn.messageId, turn.traceId]))
      expect(traceOf.get(A1)).toBe(TRACE_A1)
      expect(traceOf.get(A2)).toBeNull()
      expect(traceOf.get(A_MISSING)).toBeNull()
    })

    it("is not another organization's to read", async () => {
      await expect(inOrg(() => repo.getAnswerTraceId(A1, `${ORG}_other`))).resolves.toBeNull()
    })
  })

  describe('coverage', () => {
    /**
     * Two answers were produced in the window and six votes landed on five
     * answers: one old, one never persisted (from this tenant's side: OTHER_A is
     * another tenant's), one rated twice. Votes over produced answers said 300 %.
     */
    it('counts every answer the window is about, so coverage cannot pass 100 %', async () => {
      const health = await platform(() => repo.getFeedbackHealth({ organizationId: ORG, windowDays: 7 }))

      expect(health.totals.up + health.totals.down).toBe(6)
      expect(health.ratedAnswers).toBe(5) // A1, A2, A_MISSING, A_OLD, OTHER_A
      expect(health.answers).toBe(5) // {A1, A2} produced, united with the five rated
      expect(health.coverage).toBe(1)
    })

    it('reports no coverage, not 0 %, for a window with no answers', async () => {
      const health = await platform(() =>
        repo.getFeedbackHealth({ organizationId: `${ORG}_nobody`, windowDays: 7 }),
      )
      expect(health.answers).toBe(0)
      expect(health.coverage).toBeNull()
    })
  })

  describe('free-text search', () => {
    it('matches what was typed, literally', async () => {
      const search = (query: string) =>
        platform(() => repo.listFeedbackTurns({ organizationId: ORG, verdict: 'down', query }))

      expect((await search('40 m bei')).map((turn) => turn.messageId)).toEqual([A1])
      // Unescaped, `_` is "any one character" and this matched both answers.
      expect(await search('4_ m')).toEqual([])
    })
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

  describe("another tenant's answer", () => {
    /**
     * A vote's `message_id` is client text. Joined on the id alone, ORG's vote on
     * OTHER_A showed OTHER_ORG's answer, question and topic under ORG's row.
     */
    it('is never paired with a vote cast in a different organization', async () => {
      const turns = await platform(() => repo.listFeedbackTurns({ organizationId: ORG, verdict: 'up' }))
      const crossed = turns.find((turn) => turn.messageId === OTHER_A)

      expect(crossed).toBeDefined()
      expect(crossed?.answer).toBeNull()
      expect(crossed?.question).toBeNull()
      expect(crossed?.traceId).toBeNull()
    })

    it('is not resolved as the voted conversation at vote time', async () => {
      await expect(inOrg(() => repo.getPersistedAnswerConversationId(OTHER_A, ORG))).resolves.toBeNull()
      await expect(inOrg(() => repo.getPersistedAnswerConversationId(A1, ORG))).resolves.toBe(CHAT)
    })
  })

  describe('the conversation a vote belongs to', () => {
    /**
     * `answer_feedback.conversation_id` is what the client sent. The readers
     * joined titles and topics on it, so a vote could wear another tenant's
     * conversation title and count under its topics.
     */
    it("is the persisted answer's, whatever the client claimed", async () => {
      const turns = await platform(() => repo.listFeedbackTurns({ organizationId: CLAIM_ORG, verdict: 'down' }))
      const byMessage = new Map(turns.map((turn) => [turn.messageId, turn]))

      expect(byMessage.get(CLAIM_A)).toMatchObject({
        conversationId: CLAIM_CHAT,
        conversationTitle: 'Eigene',
        topics: ['brandschutz'],
      })
    })

    it("is never another organization's, even when no answer row says otherwise", async () => {
      const turns = await platform(() => repo.listFeedbackTurns({ organizationId: CLAIM_ORG, verdict: 'down' }))
      const orphan = turns.find((turn) => turn.messageId === CLAIM_MISSING)

      expect(orphan?.conversationTitle).toBeNull()
      expect(orphan?.topics).toEqual([])
    })

    it('decides the topic rollup and the topic filter the same way', async () => {
      const health = await platform(() => repo.getFeedbackHealth({ organizationId: CLAIM_ORG, limit: 0 }))
      expect(health.topics.map((row) => [row.topic, row.down])).toEqual([['brandschutz', 1]])

      const borrowed = await platform(() =>
        repo.getFeedbackHealth({ organizationId: CLAIM_ORG, topic: 'schallschutz', limit: 0 }),
      )
      expect(borrowed.totals.down).toBe(0)
      expect(borrowed.ratedAnswers).toBe(0)

      const own = await platform(() =>
        repo.getFeedbackHealth({ organizationId: CLAIM_ORG, topic: 'brandschutz', limit: 0 }),
      )
      expect(own.totals.down).toBe(1)
      expect(own.ratedAnswers).toBe(1)
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
