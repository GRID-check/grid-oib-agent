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

/** ORG's project, which the chat belongs to, with a federal state in its profile. */
const PROJECT = '0f0f0f0f-0000-4000-8000-0000000000a1'
/** A deep-research run's backend job id, named by A2's provenance. */
const JOB = `job_feedback_${STAMP}`
const LESSON = '0f0f0f0f-0000-4000-8000-0000000000b1'

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
  let exportRepo: typeof import('./export-repository')
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
    exportRepo = await import('./export-repository')
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
      // A1 is a researched chat answer with three sources, one retrieved but
      // not cited; A2 is a deep-research run's report.
      await db.execute(sql`
        update messages set metadata = jsonb_build_object(
          'trace_id', ${TRACE_A1}::text,
          'provenance', jsonb_build_object(
            'routingDecision', 'deep',
            'answerConfidence', 'medium',
            'skillsActivated', jsonb_build_array('oib-rl-2'),
            'answerDurationMs', 41230,
            'citationsRemoved', jsonb_build_object('count', 1, 'reasons', jsonb_build_array('unverified')),
            'thinkingSteps', jsonb_build_array(jsonb_build_object('kind', 'search', 'huge', repeat('x', 1000)))
          ),
          'citations', jsonb_build_object('v', 1, 'sources', jsonb_build_array(
            jsonb_build_object('title', 'OIB-RL 2', 'is_cited', true),
            jsonb_build_object('title', 'OIB-RL 4'),
            jsonb_build_object('title', 'gelesen', 'is_cited', false)
          ))
        ) where id = ${A1}::uuid
      `)
      await db.execute(sql`
        update messages set metadata = jsonb_build_object(
          'provenance', jsonb_build_object('deepResearchJobId', ${JOB}::text, 'researchTruncated', true)
        ) where id = ${A2}::uuid
      `)
      await db.execute(sql`
        insert into projects (id, organization_id, name, created_by, collection_name, profile)
        values (${PROJECT}::uuid, ${ORG}, 'Wohnanlage West', ${USER}, ${`p_feedback_${STAMP}`},
                '{"facts": {"bundesland": {"value": "tirol"}}}'::jsonb)
      `)
      await db.execute(sql`update conversations set project_id = ${PROJECT}::uuid where id = ${CHAT}`)
      // The ledger: two calls for A1's turn, one of them in another
      // conversation that must not count, and two for the research run.
      await db.execute(sql`
        insert into llm_usage_events (organization_id, conversation_id, message_id, job_id, model, total_tokens, cost_usd) values
          (${ORG}, ${CHAT},       ${A1}, null,    'model-a', 1000, 0.010000),
          (${ORG}, ${CHAT},       ${A1}, null,    'model-b',  500, 0.002500),
          (${ORG}, 'elsewhere',   ${A1}, null,    'model-a', 9999, 9.000000),
          (${ORG}, null,          null,  ${JOB},  'model-c', 7000, 0.300000),
          (${ORG}, null,          null,  ${JOB},  'model-c', 3000, 0.100000)
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
    // A2's down-vote became a lesson (A1's stays unprocessed for the sweep spec below).
    await platform(async () => {
      await db.execute(sql`
        insert into platform_lessons (id, content, category, status) values (${LESSON}::uuid, 'Fluchtweglänge je GK prüfen', 'inaccurate', 'active')
      `)
      await db.execute(sql`
        insert into platform_lesson_reports (feedback_id, lesson_id, outcome, org_hash)
        select id, ${LESSON}::uuid, 'created', 'h' from answer_feedback
        where organization_id = ${ORG} and message_id = ${A2} and verdict = 'down'
      `)
    })
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
      await db.execute(sql`delete from projects where id = ${PROJECT}::uuid`)
      await db.execute(sql`delete from platform_lessons where id = ${LESSON}::uuid`)
      await db.execute(sql`delete from llm_usage_events where organization_id = ${ORG}`)
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

  describe('the export', () => {
    const everything = {
      windowDays: 7,
      verdict: null,
      reason: null,
      organizationId: ORG,
      topic: null,
      query: null,
    } as const
    const exportRows = () => platform(() => exportRepo.listFeedbackExportRows(everything, 100))

    it('lists both verdicts, one row per vote, newest first', async () => {
      const rows = await exportRows()

      expect(rows).toHaveLength(6)
      expect(new Set(rows.map((row) => row.verdict))).toEqual(new Set(['up', 'down']))
      const times = rows.map((row) => row.firstVotedAt.getTime())
      expect([...times].sort((a, b) => b - a)).toEqual(times)
    })

    it('agrees with its own totals, which are not capped', async () => {
      const totals = await platform(() => exportRepo.getFeedbackExportTotals(everything))
      expect(totals).toEqual({ votes: 6, up: 3, down: 3, voters: 6, organizations: 1 })
      expect(await platform(() => exportRepo.listFeedbackExportRows(everything, 2))).toHaveLength(2)
    })

    it('names a voter by a stable 12-character pseudonym, never by the user id', async () => {
      const rows = await exportRows()
      for (const row of rows) {
        expect(row.voterKey).toMatch(/^[0-9a-f]{12}$/)
        expect(JSON.stringify(row)).not.toContain(USER)
      }
      const { createHash } = await import('node:crypto')
      const a1Down = rows.find((row) => row.messageId === A1 && row.verdict === 'down')
      expect(a1Down?.voterKey).toBe(
        createHash('sha256').update(`${ORG}:${USER}_${A1}`).digest('hex').slice(0, 12),
      )
    })

    it('reads how the answer was produced off its normalized metadata', async () => {
      const a1 = (await exportRows()).find((row) => row.messageId === A1 && row.verdict === 'down')

      expect(a1).toMatchObject({
        answerMode: 'deep',
        answerConfidence: 'medium',
        sourcesCited: 2,
        citationsRemoved: 1,
        researchTruncated: false,
        skills: ['oib-rl-2'],
        clientDurationMs: 41230,
        traceId: TRACE_A1,
        jobId: null,
        projectId: PROJECT,
        projectName: 'Wohnanlage West',
        bundesland: 'tirol',
        conversationTitle: 'Fluchtwege',
        conversationFound: true,
        topics: [],
      })
      expect(a1?.answeredAt).toBeInstanceOf(Date)
    })

    it("sums a chat turn's cost from its own conversation only, and a report's by its job", async () => {
      const rows = await exportRows()
      const a1 = rows.find((row) => row.messageId === A1 && row.verdict === 'down')
      const a2 = rows.find((row) => row.messageId === A2)

      expect(a1).toMatchObject({ llmCalls: 2, models: ['model-a', 'model-b'], tokensTotal: 1500 })
      expect(a1?.costUsd).toBeCloseTo(0.0125)
      expect(a2).toMatchObject({ answerMode: 'report', jobId: JOB, llmCalls: 2, models: ['model-c'], tokensTotal: 10000 })
      expect(a2?.researchTruncated).toBe(true)
    })

    it('carries the lesson a vote became, and nothing for one the pipeline never saw', async () => {
      const rows = await exportRows()
      expect(rows.find((row) => row.messageId === A2)).toMatchObject({ lessonId: LESSON, lessonStatus: 'active' })
      expect(rows.find((row) => row.messageId === A_MISSING)).toMatchObject({ lessonId: null, lessonStatus: null })
    })

    it('counts a chip-less down-vote as `other`, and leaves a turn nobody stored empty', async () => {
      const missing = (await exportRows()).find((row) => row.messageId === A_MISSING)
      expect(missing).toMatchObject({
        reason: 'other',
        answer: null,
        question: null,
        llmCalls: null,
        costUsd: null,
        sourcesCited: null,
        researchTruncated: null,
      })
    })

    it('narrows to a selection with the same filters as the page', async () => {
      const selection = await platform(() =>
        exportRepo.listFeedbackExportRows({ ...everything, verdict: 'down', reason: 'inaccurate', query: '40 m bei' }, 100),
      )
      expect(selection.map((row) => row.messageId)).toEqual([A1])
    })

    it("never pairs a vote with another tenant's answer", async () => {
      const crossed = (await exportRows()).find((row) => row.messageId === OTHER_A)
      // The vote named ORG's own chat, so that title is fine; OTHER_ORG's text is not.
      expect(crossed).toMatchObject({ answer: null, question: null, conversationTitle: 'Fluchtwege' })
    })
  })

  describe('the weekly summary', () => {
    it('counts the answers a week is about, so coverage cannot pass 100 %', async () => {
      const { weeks, truncated } = await platform(() =>
        repo.getFeedbackWeeklySummary({ windowDays: 7, organizationId: ORG }),
      )
      const total = weeks.reduce(
        (sum, week) => ({ answers: sum.answers + week.answers, rated: sum.rated + week.ratedAnswers, votes: sum.votes + week.up + week.down }),
        { answers: 0, rated: 0, votes: 0 },
      )

      expect(truncated).toBe(false)
      expect(total.votes).toBe(6)
      for (const week of weeks) expect(week.ratedAnswers).toBeLessThanOrEqual(week.answers)
      expect(total.rated).toBeGreaterThanOrEqual(5)
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
