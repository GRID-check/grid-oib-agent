/**
 * Opt-in integration test: the citation-health reads against a REAL Postgres
 * with every migration applied, as the restricted runtime role.
 *
 * The unit suite renders the scope predicate and can only pin its text. Every
 * claim here is one about what Postgres does with it: that the raw lateral
 * queries still parse with the predicate spliced in, that the range end is
 * exclusive, that a project resolves through the conversation of the same
 * organization, and that an event with no conversation drops out of a
 * project-filtered view.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/citations/repository.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database.
 */

import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { CitationScopeFilter } from './repository'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const STAMP = Date.now()
const ORG_A = `org_cite_a_${STAMP}`
const ORG_B = `org_cite_b_${STAMP}`
const USER = `user_cite_${STAMP}`
/** ORG_A's conversation in PROJECT, its conversation without one, and ORG_B's. */
const CHAT_P = `s_cite_p_${STAMP}`
const CHAT_A = `s_cite_a_${STAMP}`
const CHAT_B = `s_cite_b_${STAMP}`
const PROJECT = '0f0f0f0f-0000-4000-8000-0000000000c1'
const turn = (name: string) => `turn_cite_${name}_${STAMP}`

/**
 * March 2031: far from any other suite's rows, so an unnarrowed read sees only
 * what this file seeded.
 */
const MARCH: CitationScopeFilter = {
  start: new Date('2031-03-01T00:00:00.000Z'),
  endExclusive: new Date('2031-04-01T00:00:00.000Z'),
  organizationIds: [],
  projectIds: [],
}

describe.skipIf(!url)('citation-health scope against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let platform: <T>(fn: () => PromiseLike<T>) => Promise<T>
  let repo: typeof import('./repository')

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    platform = (fn) => context.withPlatformAccess('test: citation scope', fn)
    repo = await import('./repository')
    db = (await import('@/lib/db')).getDb()

    await platform(async () => {
      for (const org of [ORG_A, ORG_B]) {
        await db.execute(
          sql`insert into organizations (workos_organization_id, display_name) values (${org}, ${org}) on conflict do nothing`
        )
      }
      await db.execute(sql`
        insert into projects (id, organization_id, name, created_by, collection_name)
        values (${PROJECT}::uuid, ${ORG_A}, 'Scope', ${USER}, ${`p_cite_${STAMP}`})
      `)
      await db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id) values
          (${CHAT_P}, ${ORG_A}, ${USER}, ${PROJECT}::uuid),
          (${CHAT_A}, ${ORG_A}, ${USER}, null),
          (${CHAT_B}, ${ORG_B}, ${USER}, null)
      `)
      const targets = JSON.stringify({
        targets: [{ target: 'oib-rl-2.pdf', reason: 'citation_key_not_in_registry' }],
      })
      const baseline = JSON.stringify({ lanes: { oib: 2 } })
      const empty = JSON.stringify({ unavailable_tools: ['ris_search_tool'] })
      await db.execute(sql`
        insert into citation_events
          (organization_id, conversation_id, turn_id, agent, kind, severity, count, reasons, detail, created_at)
        values
          -- In March, in the project: a verified turn with a removed citation.
          (${ORG_A}, ${CHAT_P}, ${turn('p')}, 'shallow', 'turn_verified', 'ok', 1, null, ${baseline}::jsonb, '2031-03-10T09:00:00Z'),
          (${ORG_A}, ${CHAT_P}, ${turn('p')}, 'shallow', 'citations_removed', 'warn', 2, '{"citation_key_not_in_registry": 2}'::jsonb, ${targets}::jsonb, '2031-03-10T09:00:00Z'),
          -- In March, ORG_A, no project.
          (${ORG_A}, ${CHAT_A}, ${turn('a')}, 'shallow', 'turn_verified', 'ok', 1, null, null, '2031-03-11T09:00:00Z'),
          -- In March, ORG_B: retrieval was down.
          (${ORG_B}, ${CHAT_B}, ${turn('b')}, 'shallow', 'registry_empty', 'error', 1, null, ${empty}::jsonb, '2031-03-12T09:00:00Z'),
          -- In March, ORG_A, a turn whose conversation was never recorded.
          (${ORG_A}, null, ${turn('orphan')}, 'deep', 'quote_unverified', 'warn', 1, null, null, '2031-03-13T09:00:00Z'),
          -- The instants either side of the range.
          (${ORG_A}, ${CHAT_P}, ${turn('before')}, 'shallow', 'turn_verified', 'ok', 1, null, null, '2031-02-28T23:59:59.999Z'),
          (${ORG_A}, ${CHAT_P}, ${turn('after')}, 'shallow', 'turn_verified', 'ok', 1, null, null, '2031-04-01T00:00:00Z')
      `)
    })
  })

  it('reads [start, endExclusive): the last instant before and the first after stay out', async () => {
    expect(await platform(() => repo.countObservedTurns(MARCH))).toBe(4)
  })

  it('narrows to the named organizations', async () => {
    expect(
      await platform(() => repo.countObservedTurns({ ...MARCH, organizationIds: [ORG_A] }))
    ).toBe(3)
    const orgs = await platform(() =>
      repo.aggregateByOrganization({ ...MARCH, organizationIds: [ORG_B] })
    )
    expect(orgs).toEqual({
      rows: [{ organizationId: ORG_B, turns: 1, defectTurns: 1, errorTurns: 1 }],
      total: 1,
    })
  })

  it('narrows to a project through the conversation, leaving out turns without one', async () => {
    const inProject = { ...MARCH, projectIds: [PROJECT] }
    expect(await platform(() => repo.countObservedTurns(inProject))).toBe(1)
    expect(await platform(() => repo.countDefectiveTurns(inProject))).toBe(1)
    // The orphan quote turn is ORG_A's, and still not in the project.
    const recent = await platform(() => repo.listRecentDefects(inProject))
    expect(recent.map((row) => row.turnId)).toEqual([turn('p')])
    // A project of ORG_A combined with ORG_B only: nothing satisfies both.
    expect(
      await platform(() => repo.countObservedTurns({ ...inProject, organizationIds: [ORG_B] }))
    ).toBe(0)
  })

  it('runs every raw aggregate with the whole scope spliced in', async () => {
    const scoped = { ...MARCH, organizationIds: [ORG_A], projectIds: [PROJECT] }
    const [reasons, mix, targets, targetTurns, tools, daily, byKind, exported] = await platform(
      () =>
        Promise.all([
          repo.aggregateReasons(scoped),
          repo.aggregateDefectiveSourceMix(scoped),
          repo.aggregateFailedTargets(scoped),
          repo.countTurnsForTargets(scoped, ['oib-rl-2.pdf']),
          repo.aggregateUnavailableTools(scoped),
          repo.aggregateDailyTurns(scoped),
          repo.aggregateDailyByKind(scoped),
          repo.listEventsForExport(scoped),
        ])
    )
    expect(reasons).toEqual([
      { kind: 'citations_removed', reason: 'citation_key_not_in_registry', occurrences: 2 },
    ])
    expect(mix).toEqual([{ dimension: 'lane', label: 'oib', turns: 1 }])
    expect(targets.rows.map((row) => row.target)).toEqual(['oib-rl-2.pdf'])
    expect(targetTurns).toBe(1)
    // ORG_B's outage is outside an ORG_A scope.
    expect(tools).toEqual({ rows: [], total: 0 })
    expect(daily).toEqual([{ day: '2031-03-10', turns: 1, defectTurns: 1 }])
    expect(byKind.map((row) => row.kind).sort()).toEqual(['citations_removed', 'turn_verified'])
    expect(exported).toHaveLength(2)
  })

  it('reports the outage for the organization that had it', async () => {
    const tools = await platform(() =>
      repo.aggregateUnavailableTools({ ...MARCH, organizationIds: [ORG_B] })
    )
    expect(tools).toEqual({ rows: [{ tool: 'ris_search_tool', turns: 1 }], total: 1 })
  })
})
