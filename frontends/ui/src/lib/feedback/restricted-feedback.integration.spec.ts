/**
 * @vitest-environment node
 *
 * An answer written while its conversation drew on a restricted folder is
 * marked by the database, and every cross-tenant reader keys on that mark by
 * the vote's message id (ADR-0089, ADR-0084, ADR-0085), against a REAL Postgres
 * through the restricted runtime role:
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
 *   - `listProfiledConversations`, the staff profiler's list and search.
 * The aggregates still count the vote: a count quotes nothing. The mark is
 * written by a trigger on `messages` (migration 0122), survives the chat's
 * deletion, cannot be lifted by the runtime role, and never reads the
 * `conversation_id` a vote's client sent.
 */

import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { executeRows } from '@/lib/db/execute-rows'

vi.mock('server-only', () => ({}))

const STAMP = Date.now()
const ORG = `org_rfb_${STAMP}`
const USER = `user_rfb_${STAMP}`
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
  async function vote(messageId: string, claimedChat: string | null, answer: string) {
    await inOrg((executor) =>
      executor.execute(sql`
        insert into answer_feedback (organization_id, conversation_id, message_id, user_id, verdict, reason, comment, expected_answer)
        values (${ORG}, ${claimedChat}, ${messageId}, ${USER}, 'down', 'inaccurate', ${`Kommentar ${answer}`}, ${`Erwartet ${answer}`})`)
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

  it('marks the answer of the turn that drew on the folder, and leaves it out of the drill-in, the export and the lessons input', async () => {
    await seedVotedChat(OPEN_CHAT, 'Wie hoch muss die Brüstung sein?', OPEN_ANSWER, false)
    // An earlier turn of the restricted chat, before anything restricted entered it.
    await conversation(RESTRICTED_CHAT)
    await message(RESTRICTED_CHAT, 'user', 'Wie lang darf der Fluchtweg sein?', 10)
    const earlier = await message(RESTRICTED_CHAT, 'assistant', EARLIER_ANSWER, 9)
    await vote(earlier, RESTRICTED_CHAT, EARLIER_ANSWER)
    await message(RESTRICTED_CHAT, 'user', 'Was kostet der Zimmerer laut Angebot?', 3)
    await admit(RESTRICTED_CHAT)
    const answer = await message(RESTRICTED_CHAT, 'assistant', RESTRICTED_ANSWER, 2)
    await vote(answer, RESTRICTED_CHAT, RESTRICTED_ANSWER)

    expect(await marksIn(RESTRICTED_CHAT)).toEqual([answer])
    expect(await marksIn(OPEN_CHAT)).toEqual([])

    const { turns, reports, health } = await readers()
    expect(turns.map((turn) => turn.answer).sort()).toEqual([EARLIER_ANSWER, OPEN_ANSWER].sort())
    expect(JSON.stringify(turns)).not.toContain('Zimmerer')
    expect(reports.map((report) => report.answer).sort()).toEqual([EARLIER_ANSWER, OPEN_ANSWER].sort())
    expect(JSON.stringify(reports)).not.toContain('Zimmerer')
    // Counted, never quoted.
    expect(health.totals.down).toBe(3)
  })

  /**
   * Deleting the chat deletes its messages and its record. The vote has no
   * foreign key and stays to be counted; its comment and expected answer
   * still quote the folder. The mark has none either, and stays with it.
   */
  it('keeps the vote out after the restricted conversation is deleted', async () => {
    const answer = await seedVotedChat(DELETED_CHAT, 'Was kostet der Spengler laut Angebot?', DELETED_ANSWER, true)
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
    expect(left).toEqual({ records: 0, messages: 0, votes: 1 })
    expect(await marksIn(DELETED_CHAT)).toEqual([answer])

    const { turns, reports, health } = await readers()
    expect(JSON.stringify(turns)).not.toContain('Spengler')
    expect(JSON.stringify(reports)).not.toContain('Spengler')
    expect(health.totals.down).toBe(4)
  })

  /**
   * The vote's `conversation_id` is the client's. A vote on a marked answer
   * that names an open chat stays out; a vote on an open answer that names a
   * restricted chat is shown with ITS conversation's question and title, never
   * the named chat's.
   */
  it('never trusts the conversation id a vote was sent with', async () => {
    await conversation(NAMING_CHAT)
    await message(NAMING_CHAT, 'user', 'Was kostet der Maler laut Angebot?', 3)
    await admit(NAMING_CHAT)
    const marked = await message(NAMING_CHAT, 'assistant', NAMING_ANSWER, 2)
    await vote(marked, OPEN_CHAT, NAMING_ANSWER)

    await conversation(NAMED_CHAT, `Treppen ${STAMP}`)
    await message(NAMED_CHAT, 'user', 'Wie viele Stufen hat die Treppe?', 3)
    const open = await message(NAMED_CHAT, 'assistant', NAMED_ANSWER, 2)
    await vote(open, RESTRICTED_CHAT, NAMED_ANSWER)

    const { turns, reports } = await readers()
    expect(JSON.stringify(turns)).not.toContain('Maler')
    expect(JSON.stringify(reports)).not.toContain('Maler')
    const named = turns.find((turn) => turn.answer === NAMED_ANSWER)
    expect(named?.question).toBe('Wie viele Stufen hat die Treppe?')
    expect(named?.conversationTitle).toBe(`Treppen ${STAMP}`)
    expect(reports.find((report) => report.answer === NAMED_ANSWER)?.question).toBe('Wie viele Stufen hat die Treppe?')
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
