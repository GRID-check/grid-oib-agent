/**
 * @vitest-environment node
 *
 * Votes on a conversation that drew on a restricted folder stay out of every
 * cross-tenant reader of answer feedback (ADR-0084, ADR-0085), against a REAL
 * Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/feedback/restricted-feedback.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * Two readers, both under `withPlatformAccess` as in production:
 *   - `listFeedbackTurns`, the drill-in behind the platform feedback view, its
 *     CSV export (and so the eval-case converter that reads the export) and the
 *     digest's model;
 *   - `listUnprocessedDownvotes`, the lessons distiller's input, whose output
 *     is injected into every organization's turns.
 * The aggregates still count the vote: a count quotes nothing. The vote stays
 * out after its chat is deleted, which takes the record with it but not the
 * vote (migration 0119).
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
const DELETED_CHAT = `s_rfb_deleted_${STAMP}`
const DELETED_ANSWER = `Das Honorar des Spenglers beträgt 31.000 EUR ${STAMP}`

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

  /** A chat with one question, one answer and a down-vote quoting the answer. */
  async function seedVotedChat(chat: string, question: string, answer: string, restricted: boolean) {
    const { withTenant } = await import('@/lib/db/tenant-context')
    const executor = await db()
    await withTenant({ organizationId: ORG, userId: USER }, async () => {
      await executor.execute(sql`
        insert into conversations (id, organization_id, created_by)
        values (${chat}, ${ORG}, ${USER})`)
      await executor.execute(sql`
        insert into messages (conversation_id, organization_id, role, content, created_at)
        values (${chat}, ${ORG}, 'user', ${question}, now() - interval '2 minutes')`)
      const [message] = executeRows<{ id: string }>(
        await executor.execute(sql`
          insert into messages (conversation_id, organization_id, role, content, created_at)
          values (${chat}, ${ORG}, 'assistant', ${answer}, now() - interval '1 minute')
          returning id`)
      )
      await executor.execute(sql`
        insert into answer_feedback (organization_id, conversation_id, message_id, user_id, verdict, reason, comment, expected_answer)
        values (${ORG}, ${chat}, ${String(message.id)}, ${USER}, 'down', 'inaccurate', ${`Kommentar ${answer}`}, ${`Erwartet ${answer}`})`)
      if (!restricted) return
      // Content of a restricted folder entered this chat's context.
      await executor.execute(sql`
        insert into conversation_restricted_folders (organization_id, conversation_id, folder_id)
        values (${ORG}, ${chat}, gen_random_uuid())`)
    })
  }

  async function seed() {
    await seedVotedChat(OPEN_CHAT, 'Wie hoch muss die Brüstung sein?', OPEN_ANSWER, false)
    await seedVotedChat(RESTRICTED_CHAT, 'Was kostet der Zimmerer laut Angebot?', RESTRICTED_ANSWER, true)
  }

  it('leaves the restricted conversation out of the drill-in, the export and the lessons input', async () => {
    await seed()
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    const { getFeedbackHealth, listFeedbackTurns } = await import('./repository')
    const { listUnprocessedDownvotes } = await import('@/lib/platform-lessons/repository')

    const turns = await withPlatformAccess('test: feedback drill-in', () =>
      listFeedbackTurns({ organizationId: ORG, verdict: 'down' })
    )
    expect(turns.map((turn) => turn.conversationId)).toEqual([OPEN_CHAT])
    expect(turns[0].answer).toBe(OPEN_ANSWER)
    expect(JSON.stringify(turns)).not.toContain('Zimmerer')

    const reports = await withPlatformAccess('test: lessons sweep input', () => listUnprocessedDownvotes(500))
    const ours = reports.filter((report) => report.organizationId === ORG)
    expect(ours.map((report) => report.answer)).toEqual([OPEN_ANSWER])
    expect(JSON.stringify(ours)).not.toContain('Zimmerer')

    // Counted, never quoted.
    const health = await withPlatformAccess('test: feedback aggregates', () =>
      getFeedbackHealth({ organizationId: ORG, limit: 0 })
    )
    expect(health.totals.down).toBe(2)
  })

  /**
   * Deleting the chat deletes its `conversation_restricted_folders` rows, and
   * the vote, which has no foreign key to the conversation, stays to be
   * counted. Its comment and expected answer still quote the folder.
   */
  it('keeps the vote out after the restricted conversation is deleted', async () => {
    await seedVotedChat(DELETED_CHAT, 'Was kostet der Spengler laut Angebot?', DELETED_ANSWER, true)
    const { withPlatformAccess, withTenant } = await import('@/lib/db/tenant-context')
    const { deleteConversationInOrg } = await import('@/lib/conversations/repository')
    const { getFeedbackHealth, listFeedbackTurns } = await import('./repository')
    const { listUnprocessedDownvotes } = await import('@/lib/platform-lessons/repository')

    await withTenant({ organizationId: ORG, userId: USER }, () => deleteConversationInOrg(DELETED_CHAT, ORG))
    const [left] = executeRows<{ records: number; votes: number }>(
      await withTenant({ organizationId: ORG, userId: USER }, async () =>
        (await db()).execute(sql`
          select
            (select count(*)::int from conversation_restricted_folders where conversation_id = ${DELETED_CHAT}) as records,
            (select count(*)::int from answer_feedback where conversation_id = ${DELETED_CHAT}) as votes`)
      )
    )
    expect(left).toEqual({ records: 0, votes: 1 })

    const turns = await withPlatformAccess('test: feedback drill-in', () =>
      listFeedbackTurns({ organizationId: ORG, verdict: 'down' })
    )
    expect(turns.map((turn) => turn.conversationId)).not.toContain(DELETED_CHAT)
    expect(JSON.stringify(turns)).not.toContain('Spengler')

    const reports = await withPlatformAccess('test: lessons sweep input', () => listUnprocessedDownvotes(500))
    expect(JSON.stringify(reports.filter((report) => report.organizationId === ORG))).not.toContain('Spengler')

    const health = await withPlatformAccess('test: feedback aggregates', () =>
      getFeedbackHealth({ organizationId: ORG, limit: 0 })
    )
    expect(health.totals.down).toBe(3)
  })
})
