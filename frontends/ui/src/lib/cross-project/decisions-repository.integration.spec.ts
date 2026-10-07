/**
 * @vitest-environment node
 *
 * The decisions other projects recorded (docs/roadmap/office-experience.md,
 * „Entscheidungen"), against a REAL Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/cross-project/decisions-repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - German full-text search matches a natural question to a decision by its
 *     stems („gelöst" finds „lösen", „Stiegenhäuser" finds „Stiegenhaus"),
 *     with one shared subject enough, and finds nothing unrelated;
 *   - only active `decision` and `constraint` items of the projects asked
 *     about come back: no open question, no superseded item, no other
 *     project's, no organization-wide note;
 *   - a restricted item comes back only for a reader cleared for all of its
 *     folders, as in the project's own memory panel;
 *   - another organization's decisions are invisible.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_decisions_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_decisions_${STAMP}`

describe('the decisions suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('recorded decisions against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./decisions-repository')
  const ids = { baden: '', moedling: '', other: '', folder: '' }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) => withTenant({ organizationId, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${`proj_dec_${name}_${STAMP}`}) returning id`)
      )
    )
  }

  async function note(
    organizationId: string,
    projectId: string | null,
    kind: string,
    content: string,
    extra: { status?: string; restricted?: string[]; scope?: string } = {}
  ) {
    const restricted = extra.restricted ? sql`${`{${extra.restricted.join(',')}}`}::uuid[]` : sql`null`
    await inOrg(organizationId, () =>
      db.execute(sql`
        insert into project_memory (scope, project_id, organization_id, kind, content, status, restricted_folder_ids)
        values (${extra.scope ?? 'project'}, ${projectId}::uuid, ${organizationId}, ${kind}, ${content},
                ${extra.status ?? 'active'}, ${restricted})`)
    )
  }

  const search = (organizationId: string, question: string, readable: Record<string, string[]> = {}) =>
    inOrg(organizationId, () =>
      repo.searchProjectDecisions(
        organizationId,
        [ids.baden, ids.moedling].map((projectId) => ({ projectId, readableFolderIds: readable[projectId] ?? [] })),
        question
      )
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./decisions-repository')
    ids.baden = await project(ORG, 'Baden')
    ids.moedling = await project(ORG, 'Moedling')
    ids.other = await project(ORG, 'Nebenprojekt')
    ids.folder = first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          with folder as (
            insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
            values (${ORG}, ${ids.baden}::uuid, 'Verträge', 'Verträge', 'custom', ${USER}, now())
            returning id, project_id
          ), grants as (
            insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            select ${ORG}, project_id, id, 'org-gf', 'read' from folder
          )
          select id from folder`)
      )
    )
    await note(ORG, ids.baden, 'decision', 'Das Stiegenhaus wird in Stahlbeton ausgeführt, weil das Brandschutzgutachten nur so die Abweichung zulässt.')
    await note(ORG, ids.moedling, 'constraint', 'Die Baubehörde Mödling verlangt die Fluchtwegbreite in allen Grundrissen bemaßt.')
    await note(ORG, ids.baden, 'open_question', 'Ist das Stiegenhaus als Fluchtweg ausreichend breit?')
    await note(ORG, ids.baden, 'decision', 'Stiegenhaus zuerst in Holz geplant.', { status: 'superseded' })
    await note(ORG, ids.other, 'decision', 'Stiegenhaus des Nebenprojekts in Holz-Massivbau.')
    await note(ORG, null, 'decision', 'Stiegenhäuser plant das Büro immer in Stahlbeton.', { scope: 'organization' })
    await note(ORG, ids.baden, 'decision', 'Das Honorar für das Stiegenhaus wurde pauschal vereinbart.', {
      restricted: [ids.folder],
    })
    await note(OTHER_ORG, await project(OTHER_ORG, 'Fremd'), 'decision', 'Stiegenhaus in Stahlbeton, fremdes Büro.')
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from project_memory where organization_id = ${organizationId}`)
        await db.execute(sql`delete from project_folders where organization_id = ${organizationId}`)
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('finds a decision by the stems of a natural question, one shared subject being enough', async () => {
    const found = await search(ORG, 'Wie haben wir die Stiegenhäuser gelöst?')

    expect(found.map((decision) => decision.content)).toEqual([
      'Das Stiegenhaus wird in Stahlbeton ausgeführt, weil das Brandschutzgutachten nur so die Abweichung zulässt.',
    ])
    expect(found[0]).toMatchObject({ projectId: ids.baden, kind: 'decision', restrictedFolderIds: null })
  })

  it('finds a constraint too, and nothing for a question no decision shares a word with', async () => {
    expect((await search(ORG, 'Fluchtwegbreite Behörde')).map((decision) => decision.projectId)).toEqual([ids.moedling])
    expect(await search(ORG, 'Photovoltaik Dachbegrünung')).toEqual([])
  })

  it('serves a restricted decision only to a reader cleared for its folder', async () => {
    expect((await search(ORG, 'Honorar Stiegenhaus')).map((decision) => decision.content)).not.toContain(
      'Das Honorar für das Stiegenhaus wurde pauschal vereinbart.'
    )

    const cleared = await search(ORG, 'Honorar Stiegenhaus', { [ids.baden]: [ids.folder] })
    expect(cleared.find((decision) => decision.restrictedFolderIds !== null)).toMatchObject({
      content: 'Das Honorar für das Stiegenhaus wurde pauschal vereinbart.',
      restrictedFolderIds: [ids.folder],
    })
  })

  it('is blind to another organization, and finds nothing there for this one', async () => {
    const found = await search(ORG, 'Stiegenhaus Stahlbeton')

    expect(found.every((decision) => [ids.baden, ids.moedling].includes(decision.projectId))).toBe(true)
    expect(found.map((decision) => decision.content).join(' ')).not.toContain('fremdes Büro')
    expect(await search(OTHER_ORG, 'Stiegenhaus Stahlbeton')).toEqual([])
  })
})
