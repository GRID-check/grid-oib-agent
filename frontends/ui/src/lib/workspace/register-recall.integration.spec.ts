/**
 * @vitest-environment node
 */
/**
 * The tenancy gate ADR-0054 demands, against a REAL Postgres with the full
 * migration chain: **a project a member may not read never appears in register
 * recall, at any ranking position** (spec PR-16, AC-3, AC-4).
 *
 * It has to be an integration test and not a unit one, for two reasons the
 * mocked spec beside this file cannot cover:
 *
 *  1. The ranking is SQL. Hybrid recall is a `grid_cosine_similarity` scan
 *     fused with a `to_tsvector('german', …)` match, and a mocked `execute`
 *     returns whatever shape the author expected. Only the real driver shows
 *     what postgres-js hands back — which is how the memory suite found the
 *     semantic gate reading `.rows` off an array every mock had agreed with.
 *  2. The claim is about the ORDER the filter runs in. "Rank, then filter,
 *     over-fetching" is only meaningful when something actually ranked: the
 *     denied project has to WIN the ranking and still be absent from the
 *     result, and a stubbed candidate list cannot demonstrate that.
 *
 * The embedder is stubbed deterministically — the backend is not part of this
 * harness — and WorkOS FGA is stubbed per project, which is the one thing this
 * suite is asserting about.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/workspace/register-recall.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs
 * this file alongside the isolation, BIM and memory suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/knowledge/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge/embeddings')>()
  return { ...actual, embedNote: vi.fn(async () => null) }
})

vi.mock('@/lib/authz/resource-check', () => ({
  checkResourcePermission: vi.fn(async () => true),
  authzCacheTtlMs: () => 0,
}))

import { embedNote } from '@/lib/knowledge/embeddings'
import { checkResourcePermission } from '@/lib/authz/resource-check'
import type { AuthorizedSession } from '@/lib/auth/types'

const url = process.env.GRID_TEST_DATABASE_URL

const ORG = `org_register_${Date.now()}`
const USER = `user_${ORG}`
const MEMBERSHIP = `om_${ORG}`

const FINGERPRINT = 'integration-test-embedder'
const DIMENSIONS = 8

/**
 * One axis per topic, so two Steckbriefe about the same subject are near
 * identical and two about different subjects are orthogonal. Enough to make
 * the dense channel rank deterministically; nothing here is a claim about
 * embedding quality.
 */
const TOPIC_AXES: ReadonlyArray<readonly [RegExp, number]> = [
  [/holzbau|holz/i, 0],
  [/tiefgarage/i, 1],
  [/sanierung/i, 2],
]

function topicVector(text: string): number[] {
  const axis = TOPIC_AXES.find(([pattern]) => pattern.test(text))?.[1] ?? DIMENSIONS - 1
  const vector = new Array<number>(DIMENSIONS).fill(0)
  vector[axis] = 1
  return vector
}

function useEmbedder(): void {
  vi.mocked(embedNote).mockImplementation(async (text: string) => ({
    vector: topicVector(text),
    fingerprint: FINGERPRINT,
  }))
}

describe('the register recall suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(
      url,
      'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set, so the ' +
        'register recall suite skipped and nothing verified that an unreadable project ' +
        'stays out of the Büro. Check `task db:test:rls`.'
    ).toBeTruthy()
  })
})

describe.skipIf(!url)('register recall against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let recallSteckbriefe: typeof import('./register-service').recallSteckbriefe

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: USER }, run)

  /** A project plus its Steckbrief, embedded on the same deterministic axis. */
  async function seedProject(name: string, steckbrief: string): Promise<string> {
    const rows = await inTenant(() =>
      db.execute(
        sql`insert into projects (organization_id, name, created_by, collection_name)
            values (${ORG}, ${name}, ${USER}, ${`coll_${name}_${Date.now()}`})
            returning id`
      )
    )
    const projectId = String([...rows][0].id)
    const vector = `{${topicVector(steckbrief).join(',')}}`
    await inTenant(() =>
      db.execute(
        sql`insert into project_register
              (project_id, organization_id, project_name, steckbrief,
               embedding, embedding_model, embedded_at, last_activity_at)
            values (${projectId}, ${ORG}, ${name}, ${steckbrief},
               ${vector}::real[], ${FINGERPRINT}, now(), now())`
      )
    )
    return projectId
  }

  const session = (permissions: string[] = []): AuthorizedSession =>
    ({
      userId: USER,
      email: 'member@grid.test',
      name: 'Member',
      accessToken: 'token',
      organizationId: ORG,
      organizationMembershipId: MEMBERSHIP,
      role: 'member',
      permissions,
      featureFlags: null,
    }) as AuthorizedSession

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    recallSteckbriefe = (await import('./register-service')).recallSteckbriefe

    await withPlatformAccess('test seed: create the organization', () =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name)
            values (${ORG}, ${ORG}) on conflict do nothing`
      )
    )
  })

  afterEach(() => {
    vi.mocked(embedNote).mockReset()
    vi.mocked(embedNote).mockResolvedValue(null)
    vi.mocked(checkResourcePermission).mockReset()
    vi.mocked(checkResourcePermission).mockResolvedValue(true)
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from project_register where organization_id = ${ORG}`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
      await db.execute(sql`delete from organizations where workos_organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('never returns a project the member may not view, even when it ranks first', async () => {
    useEmbedder()
    const denied = await seedProject(
      'Holzbau Nord',
      'PROJECT_STECKBRIEF v1\nprojekt=Holzbau Nord\nHolzbau, Massivholz, GK5'
    )
    const allowed = await seedProject(
      'Holzbau Süd',
      'PROJECT_STECKBRIEF v1\nprojekt=Holzbau Süd\nHolzbau in Holzbauweise'
    )
    vi.mocked(checkResourcePermission).mockImplementation(
      async ({ resourceExternalId }) => resourceExternalId !== denied
    )

    const hits = await recallSteckbriefe({ session: session() }, 'Holzbau', 5)

    const ids = hits.map((hit) => hit.id)
    expect(ids).toContain(allowed)
    expect(ids).not.toContain(denied)
    // And nothing about it leaked through the payload either — not the name,
    // not the Steckbrief (spec PR-16).
    expect(JSON.stringify(hits)).not.toContain('Holzbau Nord')
  })

  it('returns nothing at all when the member may read no project', async () => {
    useEmbedder()
    await seedProject('Tiefgarage Ost', 'PROJECT_STECKBRIEF v1\nTiefgarage, Sprinkler')
    vi.mocked(checkResourcePermission).mockResolvedValue(false)

    await expect(recallSteckbriefe({ session: session() }, 'Tiefgarage')).resolves.toEqual([])
  })

  it('serves an org administrator everything without a single FGA call', async () => {
    // The bypass is the PERMISSION `org:projects:administer`, never the role
    // slug `admin` (ADR-0038). Same function the projects grid uses, so the
    // office and the grid cannot disagree about what an admin sees.
    useEmbedder()
    const project = await seedProject('Sanierung West', 'PROJECT_STECKBRIEF v1\nSanierung Bestand')

    const hits = await recallSteckbriefe(
      { session: session(['org:projects:administer']) },
      'Sanierung'
    )

    expect(hits.map((hit) => hit.id)).toContain(project)
    expect(checkResourcePermission).not.toHaveBeenCalled()
  })

  it('finds a Steckbrief through the lexical channel with no embedder at all', async () => {
    // `embedNote` resolves null (the afterEach default), so the dense channel
    // contributes nothing and `to_tsvector('german', …)` has to carry the
    // query on its own. This is the deployment where the embedding backend is
    // down, and recall keeps working there.
    const project = await seedProject(
      'Speicher Mitte',
      'PROJECT_STECKBRIEF v1\nprojekt=Speicher Mitte\nDachgeschossausbau eines Speichergebäudes'
    )

    const hits = await recallSteckbriefe({ session: session() }, 'Speichergebäude')

    expect(hits.map((hit) => hit.id)).toContain(project)
  })

  it('falls back to last activity when the turn carries no question', async () => {
    const project = await seedProject('Zubau Süd', 'PROJECT_STECKBRIEF v1\nZubau')

    const hits = await recallSteckbriefe({ session: session() }, null, 10)

    expect(hits.map((hit) => hit.id)).toContain(project)
    // Still readability-filtered: no question is not a reason to widen.
    expect(checkResourcePermission).toHaveBeenCalled()
  })

  it('cannot see another tenant’s Steckbriefe', async () => {
    const otherOrg = `${ORG}_other`
    await withPlatformAccess('test seed: a second tenant', () =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name)
            values (${otherOrg}, ${otherOrg}) on conflict do nothing`
      )
    )
    const rows = await withTenant({ organizationId: otherOrg, userId: 'u' }, async () => {
      const inserted = await db.execute(
        sql`insert into projects (organization_id, name, created_by, collection_name)
            values (${otherOrg}, 'Fremdes Projekt', 'u', ${`coll_other_${Date.now()}`})
            returning id`
      )
      const id = String([...inserted][0].id)
      await db.execute(
        sql`insert into project_register (project_id, organization_id, project_name, steckbrief)
            values (${id}, ${otherOrg}, 'Fremdes Projekt', 'PROJECT_STECKBRIEF v1\nHolzbau')`
      )
      return id
    })

    const hits = await recallSteckbriefe({ session: session() }, 'Holzbau', 10)
    expect(hits.map((hit) => hit.id)).not.toContain(rows)

    await withPlatformAccess('test cleanup', async () => {
      await db.execute(sql`delete from project_register where organization_id = ${otherOrg}`)
      await db.execute(sql`delete from projects where organization_id = ${otherOrg}`)
      await db.execute(sql`delete from organizations where workos_organization_id = ${otherOrg}`)
    })
  })
})
