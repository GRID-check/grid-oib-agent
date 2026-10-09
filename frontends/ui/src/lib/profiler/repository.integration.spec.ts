/**
 * Opt-in integration test: the profiler's conversation directory against a
 * REAL Postgres with every migration applied, as the restricted runtime role.
 *
 * What a mocked handle cannot say: that the range bounds the turns Postgres
 * aggregates (so the counts are the range's), that the organization falls back
 * to the span's when the conversation row is gone, and that a project filter
 * resolves through `conversations.project_id`.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/profiler/repository.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database.
 */

import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProfiledConversationFilter } from './repository'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const STAMP = Date.now()
const ORG_A = `org_prof_a_${STAMP}`
const ORG_B = `org_prof_b_${STAMP}`
const USER = `user_prof_${STAMP}`
const CHAT_P = `s_prof_p_${STAMP}`
const CHAT_A = `s_prof_a_${STAMP}`
const CHAT_B = `s_prof_b_${STAMP}`
/** Spans whose conversation row was never written. */
const CHAT_GONE = `s_prof_gone_${STAMP}`
const PROJECT = '0f0f0f0f-0000-4000-8000-0000000000d1'

/** March 2031: far from any other suite's rows. */
const MARCH: ProfiledConversationFilter = {
  start: new Date('2031-03-01T00:00:00.000Z'),
  endExclusive: new Date('2031-04-01T00:00:00.000Z'),
  organizationIds: [],
  projectIds: [],
}

describe.skipIf(!url)('profiler directory scope against live Postgres', () => {
  let platform: <T>(fn: () => PromiseLike<T>) => Promise<T>
  let repo: typeof import('./repository')

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    platform = (fn) => context.withPlatformAccess('test: profiler scope', fn)
    repo = await import('./repository')
    const db = (await import('@/lib/db')).getDb()

    await platform(async () => {
      for (const org of [ORG_A, ORG_B]) {
        await db.execute(
          sql`insert into organizations (workos_organization_id, display_name) values (${org}, ${org}) on conflict do nothing`
        )
      }
      await db.execute(sql`
        insert into projects (id, organization_id, name, created_by, collection_name)
        values (${PROJECT}::uuid, ${ORG_A}, 'Scope', ${USER}, ${`p_prof_${STAMP}`})
      `)
      await db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, title) values
          (${CHAT_P}, ${ORG_A}, ${USER}, ${PROJECT}::uuid, 'Im Projekt'),
          (${CHAT_A}, ${ORG_A}, ${USER}, null, 'Ohne Projekt'),
          (${CHAT_B}, ${ORG_B}, ${USER}, null, 'Andere Organisation')
      `)
      await db.execute(sql`
        insert into agent_profiler_spans
          (organization_id, conversation_id, turn_id, span_id, kind, name, started_at, ended_at, duration_ms)
        values
          -- CHAT_P: one turn in March, one in April (outside), one in February.
          (${ORG_A}, ${CHAT_P}, 'p1', 'p1', 'turn', 'turn', '2031-03-05T10:00:00Z', '2031-03-05T10:00:01Z', 1000),
          (${ORG_A}, ${CHAT_P}, 'p2', 'p2', 'turn', 'turn', '2031-04-01T00:00:00Z', '2031-04-01T00:00:02Z', 2000),
          (${ORG_A}, ${CHAT_P}, 'p0', 'p0', 'turn', 'turn', '2031-02-20T10:00:00Z', '2031-02-20T10:00:04Z', 4000),
          -- A node span is not a turn and never counts.
          (${ORG_A}, ${CHAT_P}, 'p1', 'p1n', 'node', 'plan', '2031-03-05T10:00:00Z', '2031-03-05T10:00:01Z', 800),
          (${ORG_A}, ${CHAT_A}, 'a1', 'a1', 'turn', 'turn', '2031-03-06T10:00:00Z', '2031-03-06T10:00:01Z', 500),
          (${ORG_B}, ${CHAT_B}, 'b1', 'b1', 'turn', 'turn', '2031-03-07T10:00:00Z', '2031-03-07T10:00:01Z', 700),
          (${ORG_B}, ${CHAT_GONE}, 'g1', 'g1', 'turn', 'turn', '2031-03-08T10:00:00Z', '2031-03-08T10:00:01Z', 300)
      `)
    })
  })

  const ids = (rows: { conversationId: string }[]) => rows.map((row) => row.conversationId)

  it('lists conversations with a turn in the range, newest first, counting only those turns', async () => {
    const { rows } = await platform(() => repo.listProfiledConversations(MARCH))
    expect(ids(rows)).toEqual([CHAT_GONE, CHAT_B, CHAT_A, CHAT_P])
    const inProject = rows.find((row) => row.conversationId === CHAT_P)
    expect(inProject).toMatchObject({ turnCount: 1, totalDurationMs: 1000 })
    expect(inProject?.lastActiveAt.toISOString()).toBe('2031-03-05T10:00:00.000Z')
  })

  it("filters by organization, using the span's when the conversation row is gone", async () => {
    const { rows } = await platform(() =>
      repo.listProfiledConversations({ ...MARCH, organizationIds: [ORG_B] })
    )
    expect(ids(rows)).toEqual([CHAT_GONE, CHAT_B])
  })

  it("filters by the conversation's project", async () => {
    const { rows } = await platform(() =>
      repo.listProfiledConversations({ ...MARCH, projectIds: [PROJECT] })
    )
    expect(ids(rows)).toEqual([CHAT_P])
  })

  it('searches within the scope', async () => {
    const { rows } = await platform(() =>
      repo.listProfiledConversations({ ...MARCH, organizationIds: [ORG_A] }, 'Projekt')
    )
    // Both ORG_A titles contain "Projekt"; ORG_B's does not and is out of scope anyway.
    expect(ids(rows)).toEqual([CHAT_A, CHAT_P])
  })

  it('finds one conversation in the scope, and nothing for one outside it', async () => {
    const found = await platform(() => repo.findProfiledConversation(MARCH, CHAT_P))
    expect(found).toMatchObject({ conversationId: CHAT_P, turnCount: 1 })
    const april = {
      ...MARCH,
      start: new Date('2031-04-02T00:00:00.000Z'),
      endExclusive: new Date('2031-05-01T00:00:00.000Z'),
    }
    expect(await platform(() => repo.findProfiledConversation(april, CHAT_P))).toBeNull()
  })
})
