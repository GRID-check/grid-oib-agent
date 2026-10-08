/**
 * @vitest-environment node
 *
 * A conversation that drew on a restricted folder has its messages and the
 * votes on them marked by the database, and every cross-tenant reader asks the
 * database's one rule of each vote (ADR-0091, ADR-0086, ADR-0087), against a
 * REAL Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/feedback/restricted-feedback.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * The readers, all under `withPlatformAccess` as in production:
 *   - `listFeedbackTurns`, the drill-in behind the platform feedback view, its
 *     CSV export (and so the eval-case converter that reads the export) and the
 *     digest's model;
 *   - `listUnprocessedDownvotes`, the lessons distiller's input, whose output
 *     is injected into every organization's turns;
 *   - `listProfiledConversations`, the staff profiler's list and search;
 *   - `isRestrictedUseVote`, which decides whether a vote's Langfuse score
 *     carries its comment and expected answer.
 * The aggregates still count the vote: a count quotes nothing. Marks are
 * written by triggers (migration 0123): on a message written into such a
 * conversation, on its first admission (every message it holds, every vote
 * naming it), and on a vote cast on either. They survive the chat's deletion
 * and cannot be lifted by the runtime role. The ids a vote's client sends can
 * only add a mark: a vote whose message id names no row, cast in a restricted
 * chat through the vote service itself, stays out.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { executeRows } from '@/lib/db/execute-rows'

vi.mock('server-only', () => ({}))
// What the vote service does besides writing the vote: none of it is the
// question here, and each would reach for a model, a cache or a setting.
vi.mock('@/lib/upload-screening/service', () => ({
  maskChatText: vi.fn(async (_organizationId: string, text: string) => ({ text })),
}))
vi.mock('@/lib/platform-lessons/holdout', () => ({ resolveLessonsHoldout: vi.fn(async () => null) }))
vi.mock('@/lib/platform-lessons/service', () => ({ reopenReportForRedistillation: vi.fn(async () => undefined) }))
vi.mock('@/lib/projects/memory-service', () => ({ implicateMemoryFromFeedback: vi.fn(async () => undefined) }))

const STAMP = Date.now()
const ORG = `org_rfb_${STAMP}`
const USER = `user_rfb_${STAMP}`
const COLLEAGUE = `user_rfb_colleague_${STAMP}`
const RESTRICTED_TITLE = `Honorare Zimmerer AAA ${STAMP}`
const PHANTOM_CHAT = `s_rfb_phantom_${STAMP}`
const OPEN_CHAT = `s_rfb_open_${STAMP}`
const RESTRICTED_CHAT = `s_rfb_restricted_${STAMP}`
const OPEN_ANSWER = `Die Brüstung ist 1,00 m hoch ${STAMP}`
const RESTRICTED_ANSWER = `Das Honorar des Zimmerers beträgt 48.000 EUR ${STAMP}`
const EARLIER_ANSWER = `Die Fluchtweglänge beträgt 40 m ${STAMP}`
const DELETED_CHAT = `s_rfb_deleted_${STAMP}`
const DELETED_ANSWER = `Das Honorar des Spenglers beträgt 31.000 EUR ${STAMP}`
const NAMING_CHAT = `s_rfb_naming_${STAMP}`
const NAMING_ANSWER = `Das Honorar des Malers beträgt 12.000 EUR ${STAMP}`
const NAMED_CHAT = `s_rfb_named_${STAMP}`
const NAMED_ANSWER = `Die Treppe hat 18 Stufen ${STAMP}`
const RUN_CHAT = `s_rfb_run_${STAMP}`
const RUN_REPORT = `Bericht: Honorar des Elektrikers 22.000 EUR ${STAMP}`
const PROFILED_CHAT = `s_rfb_profiled_${STAMP}`
const PROFILED_TITLE = `Honorare Zimmerer ${STAMP}`
const OPEN_PROFILED_CHAT = `s_rfb_profiled_open_${STAMP}`
const OPEN_PROFILED_TITLE = `Brüstungshöhen ${STAMP}`

const url = process.env.GRID_TEST_DATABASE_URL

describe('the restricted-feedback suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('answer feedback from a restricted conversation, against Postgres', () => {
  async function db() {
    process.env.GRID_APP_DATABASE_URL = url
    const { getDb } = await import('@/lib/db')
    return getDb()
  }

  async function inOrg<T>(fn: (executor: Awaited<ReturnType<typeof db>>) => Promise<T>): Promise<T> {
    const { withTenant } = await import('@/lib/db/tenant-context')
    const executor = await db()
    return withTenant({ organizationId: ORG, userId: USER }, () => fn(executor))
  }

  async function conversation(chat: string, title: string | null = null) {
    await inOrg((executor) =>
      executor.execute(sql`
        insert into conversations (id, organization_id, created_by, title)
        values (${chat}, ${ORG}, ${USER}, ${title})`)
    )
  }

  /** Content of a restricted folder entered this chat's context: what `admitRestrictedUse` records. */
  async function admit(chat: string) {
    await inOrg((executor) =>
      executor.execute(sql`
        insert into conversation_restricted_folders (organization_id, conversation_id, folder_id)
        values (${ORG}, ${chat}, gen_random_uuid())`)
    )
  }

  async function message(chat: string, role: 'user' | 'assistant', content: string, minutesAgo: number): Promise<string> {
    const [row] = executeRows<{ id: string }>(
      await inOrg((executor) =>
        executor.execute(sql`
          insert into messages (conversation_id, organization_id, role, content, created_at)
          values (${chat}, ${ORG}, ${role}, ${content}, now() - make_interval(mins => ${minutesAgo}))
          returning id`)
      )
    )
    return String(row.id)
  }

  /** A down-vote quoting the answer; `claimedChat` is the conversation id the client sent. */
  async function vote(messageId: string, claimedChat: string | null, answer: string, voter = USER) {
    await inOrg((executor) =>
      executor.execute(sql`
        insert into answer_feedback (organization_id, conversation_id, message_id, user_id, verdict, reason, comment, expected_answer)
        values (${ORG}, ${claimedChat}, ${messageId}, ${voter}, 'down', 'inaccurate', ${`Kommentar ${answer}`}, ${`Erwartet ${answer}`})`)
    )
  }

  /**
   * A chat in production order: the question is persisted, the turn admits
   * restricted content (when `restricted`), then the answer is persisted.
   */
  async function seedVotedChat(chat: string, question: string, answer: string, restricted: boolean) {
    await conversation(chat)
    await message(chat, 'user', question, 3)
    if (restricted) await admit(chat)
    const answerId = await message(chat, 'assistant', answer, 2)
    await vote(answerId, chat, answer)
    return answerId
  }

  const marksIn = async (chat: string) =>
    executeRows<{ message_id: string }>(
      await inOrg((executor) =>
        executor.execute(sql`select message_id from message_restricted_use where conversation_id = ${chat} order by message_id`)
      )
    ).map((row) => String(row.message_id))

  /** Whether the vote on `messageId` is scored in Langfuse without its words: the same rule, asked in the voter's tenant. */
  async function scoredWithoutWords(messageId: string, voter = USER): Promise<boolean> {
    const { isRestrictedUseVote } = await import('./repository')
    const [row] = executeRows<{ id: string }>(
      await inOrg((executor) =>
        executor.execute(
          sql`select id from answer_feedback where organization_id = ${ORG} and message_id = ${messageId} and user_id = ${voter}`
        )
      )
    )
    return inOrg(() => isRestrictedUseVote(String(row.id), ORG))
  }

  async function readers() {
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    const { getFeedbackHealth, listFeedbackTurns } = await import('./repository')
    const { listUnprocessedDownvotes } = await import('@/lib/platform-lessons/repository')
    const turns = await withPlatformAccess('test: feedback drill-in', () =>
      listFeedbackTurns({ organizationId: ORG, verdict: 'down' })
    )
    const reports = (await withPlatformAccess('test: lessons sweep input', () => listUnprocessedDownvotes(500))).filter(
      (report) => report.organizationId === ORG
    )
    const health = await withPlatformAccess('test: feedback aggregates', () =>
      getFeedbackHealth({ organizationId: ORG, limit: 0 })
    )
    return { turns, reports, health }
  }

  /**
   * A vote cast after the admission on an answer from before it is typed by
   * someone who has read the restricted content, and its comment can quote it.
   * The first admission marks every message the conversation already holds.
   */
  it('marks every message of the conversation from its first admission, and leaves their votes out of the drill-in, the export and the lessons input', async () => {
    const openAnswer = await seedVotedChat(OPEN_CHAT, 'Wie hoch muss die Brüstung sein?', OPEN_ANSWER, false)
    // An earlier turn of the restricted chat, before anything restricted entered it.
    await conversation(RESTRICTED_CHAT, RESTRICTED_TITLE)
    const firstQuestion = await message(RESTRICTED_CHAT, 'user', 'Wie lang darf der Fluchtweg sein?', 10)
    const earlier = await message(RESTRICTED_CHAT, 'assistant', EARLIER_ANSWER, 9)
    await vote(earlier, RESTRICTED_CHAT, EARLIER_ANSWER)
    const secondQuestion = await message(RESTRICTED_CHAT, 'user', 'Was kostet der Zimmerer laut Angebot?', 3)
    expect(await marksIn(RESTRICTED_CHAT)).toEqual([])
    await admit(RESTRICTED_CHAT)
    const answer = await message(RESTRICTED_CHAT, 'assistant', RESTRICTED_ANSWER, 2)
    await vote(answer, RESTRICTED_CHAT, RESTRICTED_ANSWER)
    // After the admission a colleague down-votes the EARLIER answer, quoting the offer.
    await vote(earlier, RESTRICTED_CHAT, 'Falsch, laut Angebot ZIMMERER-AAA 48.000 EUR', COLLEAGUE)

    expect(await marksIn(RESTRICTED_CHAT)).toEqual([firstQuestion, earlier, secondQuestion, answer].sort())
    expect(await marksIn(OPEN_CHAT)).toEqual([])

    const { turns, reports, health } = await readers()
    expect(turns.map((turn) => turn.answer)).toEqual([OPEN_ANSWER])
    for (const quoted of ['Zimmerer', 'ZIMMERER-AAA', 'Fluchtweg', RESTRICTED_TITLE]) {
      expect(JSON.stringify(turns)).not.toContain(quoted)
      expect(JSON.stringify(reports)).not.toContain(quoted)
    }
    expect(reports.map((report) => report.answer)).toEqual([OPEN_ANSWER])
    // Counted, never quoted.
    expect(health.totals.down).toBe(4)

    // Langfuse has the same readers: the number and the chip, never the words.
    expect(await scoredWithoutWords(answer)).toBe(true)
    expect(await scoredWithoutWords(earlier, COLLEAGUE)).toBe(true)
    expect(await scoredWithoutWords(openAnswer)).toBe(false)
  })

  /**
   * Deleting the chat deletes its messages and its record. The votes have no
   * foreign key and stay to be counted; their comments and expected answers
   * still quote the folder. The marks have none either, and stay with them:
   * the answer written after the admission, and the earlier answer, whose
   * vote from before the admission was edited after it to quote the offer.
   */
  it('keeps the votes out after the restricted conversation is deleted, the earlier answer\'s included', async () => {
    await conversation(DELETED_CHAT)
    const firstQuestion = await message(DELETED_CHAT, 'user', 'Wie hoch ist die Attika?', 10)
    const earlier = await message(DELETED_CHAT, 'assistant', `Die Attika ist 0,90 m hoch ${STAMP}`, 9)
    await vote(earlier, DELETED_CHAT, 'Attika')
    await message(DELETED_CHAT, 'user', 'Was kostet der Spengler laut Angebot?', 3)
    await admit(DELETED_CHAT)
    const answer = await message(DELETED_CHAT, 'assistant', DELETED_ANSWER, 2)
    await vote(answer, DELETED_CHAT, DELETED_ANSWER)
    await inOrg((executor) =>
      executor.execute(sql`
        update answer_feedback set comment = 'Falsch, laut Angebot Spengler 31.000 EUR'
        where organization_id = ${ORG} and message_id = ${earlier} and user_id = ${USER}`)
    )
    const { deleteConversationInOrg } = await import('@/lib/conversations/repository')

    await inOrg(() => deleteConversationInOrg(DELETED_CHAT, ORG))
    const [left] = executeRows<{ records: number; messages: number; votes: number }>(
      await inOrg((executor) =>
        executor.execute(sql`
          select
            (select count(*)::int from conversation_restricted_folders where conversation_id = ${DELETED_CHAT}) as records,
            (select count(*)::int from messages where conversation_id = ${DELETED_CHAT}) as messages,
            (select count(*)::int from answer_feedback where conversation_id = ${DELETED_CHAT}) as votes`)
      )
    )
    expect(left).toEqual({ records: 0, messages: 0, votes: 2 })
    // Every message the conversation held at its admission, and the answer written after it.
    const marks = await marksIn(DELETED_CHAT)
    expect(marks).toHaveLength(4)
    expect(marks).toEqual(expect.arrayContaining([firstQuestion, earlier, answer]))

    const { turns, reports, health } = await readers()
    for (const quoted of ['Spengler', 'Attika']) {
      expect(JSON.stringify(turns)).not.toContain(quoted)
      expect(JSON.stringify(reports)).not.toContain(quoted)
    }
    expect(health.totals.down).toBe(6)
    expect(await scoredWithoutWords(answer)).toBe(true)
    expect(await scoredWithoutWords(earlier)).toBe(true)
  })

  /**
   * `messages.id` is minted by the client, and a shallow turn, or one whose
   * persist failed, has no row. A vote whose id names nothing is judged by the
   * chat it was cast in: through the vote service itself, the way every vote
   * is written, it marks its own id, and the mark outlives the chat.
   */
  it('keeps out a vote whose message id names no row, cast in a restricted chat, before and after the chat is deleted', async () => {
    await conversation(PHANTOM_CHAT)
    await message(PHANTOM_CHAT, 'user', 'Was kostet der Spengler laut Angebot?', 3)
    await admit(PHANTOM_CHAT)
    const phantom = randomUUID()
    const { submitAnswerFeedback } = await import('./service')
    const session: AuthorizedSession = {
      userId: USER,
      email: `${USER}@grid.test`,
      name: USER,
      accessToken: 'token',
      organizationId: ORG,
      organizationMembershipId: `om_${USER}`,
      role: 'member',
      roles: [],
      permissions: [],
      featureFlags: null,
    }
    await inOrg(() =>
      submitAnswerFeedback(session, {
        messageId: phantom,
        conversationId: PHANTOM_CHAT,
        verdict: 'down',
        reason: 'inaccurate',
        comment: 'Erwartet SPENGLER-BBB 31.000 EUR',
        expectedAnswer: 'SPENGLER-BBB 31.000 EUR',
      })
    )
    expect(await marksIn(PHANTOM_CHAT)).toContain(phantom)

    const before = await readers()
    expect(JSON.stringify(before.turns)).not.toContain('SPENGLER-BBB')
    expect(JSON.stringify(before.reports)).not.toContain('SPENGLER-BBB')

    const { deleteConversationInOrg } = await import('@/lib/conversations/repository')
    await inOrg(() => deleteConversationInOrg(PHANTOM_CHAT, ORG))
    const after = await readers()
    expect(JSON.stringify(after.turns)).not.toContain('SPENGLER-BBB')
    expect(JSON.stringify(after.reports)).not.toContain('SPENGLER-BBB')
    expect(await scoredWithoutWords(phantom)).toBe(true)

    // The chat and its record are gone; its marks keep it answering yes (sticky).
    const late = randomUUID()
    await vote(late, PHANTOM_CHAT, 'SPENGLER-BBB nach dem Löschen', COLLEAGUE)
    expect(await marksIn(PHANTOM_CHAT)).toContain(late)
  })

  /**
   * The vote's `conversation_id` is the client's, and it can only add to the
   * answer. A vote on a marked answer that names an open chat stays out. A vote
   * on an open answer that names a restricted chat stays out too, since its
   * comment was typed where the client says; the mark names the restricted
   * chat, so the open chat does not read as restricted, and an honest vote in
   * it is shown with ITS question and title.
   */
  it('lets the conversation id a vote was sent with add to the answer, never lift it', async () => {
    await conversation(NAMING_CHAT)
    await message(NAMING_CHAT, 'user', 'Was kostet der Maler laut Angebot?', 3)
    await admit(NAMING_CHAT)
    const marked = await message(NAMING_CHAT, 'assistant', NAMING_ANSWER, 2)
    await vote(marked, OPEN_CHAT, NAMING_ANSWER)

    await conversation(NAMED_CHAT, `Treppen ${STAMP}`)
    await message(NAMED_CHAT, 'user', 'Wie viele Stufen hat die Treppe?', 5)
    const open = await message(NAMED_CHAT, 'assistant', NAMED_ANSWER, 4)
    await vote(open, RESTRICTED_CHAT, `${NAMED_ANSWER} laut Angebot Maler`)
    await message(NAMED_CHAT, 'user', 'Wie breit ist die Treppe?', 3)
    const honest = await message(NAMED_CHAT, 'assistant', `Die Treppe ist 1,20 m breit ${STAMP}`, 2)
    await vote(honest, NAMED_CHAT, 'Breite')

    expect(await marksIn(NAMED_CHAT)).toEqual([])
    const { turns, reports } = await readers()
    expect(JSON.stringify(turns)).not.toContain('Maler')
    expect(JSON.stringify(reports)).not.toContain('Maler')
    const shown = turns.find((turn) => turn.answer === `Die Treppe ist 1,20 m breit ${STAMP}`)
    expect(shown?.question).toBe('Wie breit ist die Treppe?')
    expect(shown?.conversationTitle).toBe(`Treppen ${STAMP}`)
    expect(reports.find((report) => report.answer === `Die Treppe ist 1,20 m breit ${STAMP}`)?.question).toBe(
      'Wie breit ist die Treppe?'
    )
    expect(await scoredWithoutWords(marked)).toBe(true)
    expect(await scoredWithoutWords(open)).toBe(true)
    expect(await scoredWithoutWords(honest)).toBe(false)
  })

  /** A run's message is created empty at dispatch and its report written into it after the run. */
  it('marks a message whose content is written after the conversation drew on the folder', async () => {
    await conversation(RUN_CHAT)
    const runMessage = await message(RUN_CHAT, 'assistant', '', 5)
    expect(await marksIn(RUN_CHAT)).toEqual([])
    await admit(RUN_CHAT)
    await inOrg((executor) =>
      executor.execute(sql`update messages set content = ${RUN_REPORT} where id = ${runMessage}::uuid`)
    )
    expect(await marksIn(RUN_CHAT)).toEqual([runMessage])
  })

  it('lets the runtime role neither change nor delete a mark', async () => {
    const before = await marksIn(RESTRICTED_CHAT)
    // Drizzle wraps the driver's error; Postgres's own words are its cause.
    const refusal = (attempt: Promise<unknown>) =>
      attempt.then(
        () => 'went through',
        (error: { cause?: { message?: string }; message?: string }) => error.cause?.message ?? error.message
      )
    expect(
      await refusal(
        inOrg((executor) => executor.execute(sql`delete from message_restricted_use where conversation_id = ${RESTRICTED_CHAT}`))
      )
    ).toMatch(/permission denied for table message_restricted_use/)
    expect(
      await refusal(
        inOrg((executor) =>
          executor.execute(sql`update message_restricted_use set conversation_id = 'x' where conversation_id = ${RESTRICTED_CHAT}`)
        )
      )
    ).toMatch(/permission denied for table message_restricted_use/)
    expect(await marksIn(RESTRICTED_CHAT)).toEqual(before)
  })

  it('withholds the title of a conversation with restricted use from the profiler list and its search', async () => {
    await conversation(PROFILED_CHAT, PROFILED_TITLE)
    await admit(PROFILED_CHAT)
    await conversation(OPEN_PROFILED_CHAT, OPEN_PROFILED_TITLE)
    for (const chat of [PROFILED_CHAT, OPEN_PROFILED_CHAT]) {
      await inOrg((executor) =>
        executor.execute(sql`
          insert into agent_profiler_spans (organization_id, conversation_id, turn_id, span_id, kind, name, started_at, ended_at, duration_ms)
          values (${ORG}, ${chat}, ${`turn_${chat}`}, ${`span_${chat}`}, 'turn', 'turn', now(), now(), 10)`)
      )
    }
    const { listProfiledConversations } = await import('@/lib/profiler/repository')

    const { rows } = await listProfiledConversations(String(STAMP))
    const restricted = rows.find((row) => row.conversationId === PROFILED_CHAT)
    expect(restricted).toMatchObject({ title: null, titleWithheld: true })
    expect(rows.find((row) => row.conversationId === OPEN_PROFILED_CHAT)).toMatchObject({
      title: OPEN_PROFILED_TITLE,
      titleWithheld: false,
    })

    // The search must not confirm a word of the title either; the id still finds it.
    const byTitle = await listProfiledConversations('Honorare Zimmerer')
    expect(byTitle.rows.map((row) => row.conversationId)).not.toContain(PROFILED_CHAT)
    const byId = await listProfiledConversations(PROFILED_CHAT)
    expect(byId.rows.map((row) => row.conversationId)).toEqual([PROFILED_CHAT])
  })
})
