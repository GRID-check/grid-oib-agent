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
 *   - the question's embedding is ranked against each item's stored one in
 *     SQL, and a vector from another model counts for nothing: a question in
 *     English finds a decision written in German by meaning alone;
 *   - without an embedder the token channel answers, and a question sharing
 *     nothing with any decision finds none;
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

/** The question's vector, as the embedder would return it; null is an embedder that is down. */
let queryVector: number[] | null = null
const MODEL = 'test-embedder'
vi.mock('@/lib/knowledge/embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/knowledge/embeddings')>()),
  embedNote: async () => (queryVector ? { vector: queryVector, fingerprint: MODEL } : null),
}))

// Three axes of meaning, so a test can say what a vector is about: stairs, escape widths, fees.
const STAIRS = [1, 0, 0]
const WIDTHS = [0, 1, 0]
const FEES = [0, 0, 1]

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
    extra: { status?: string; restricted?: string[]; scope?: string; vector?: number[]; model?: string } = {}
  ) {
    const restricted = extra.restricted ? sql`${`{${extra.restricted.join(',')}}`}::uuid[]` : sql`null`
    const vector = extra.vector ? sql`${`{${extra.vector.join(',')}}`}::real[]` : sql`null`
    await inOrg(organizationId, () =>
      db.execute(sql`
        insert into project_memory (scope, project_id, organization_id, kind, content, status, restricted_folder_ids,
                                    embedding, embedding_model)
        values (${extra.scope ?? 'project'}, ${projectId}::uuid, ${organizationId}, ${kind}, ${content},
                ${extra.status ?? 'active'}, ${restricted}, ${vector}, ${extra.vector ? (extra.model ?? MODEL) : null})`)
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
    await note(ORG, ids.baden, 'decision', 'Das Stiegenhaus wird in Stahlbeton ausgeführt, weil das Brandschutzgutachten nur so die Abweichung zulässt.', { vector: STAIRS })
    await note(ORG, ids.moedling, 'constraint', 'Die Baubehörde Mödling verlangt die Fluchtwegbreite in allen Grundrissen bemaßt.', { vector: WIDTHS })
    // The same meaning from another embedder: noise of the right shape, never compared.
    await note(ORG, ids.moedling, 'decision', 'Treppenkern betoniert.', { vector: STAIRS, model: 'another-embedder' })
    await note(ORG, ids.baden, 'open_question', 'Ist das Stiegenhaus als Fluchtweg ausreichend breit?', { vector: STAIRS })
    await note(ORG, ids.baden, 'decision', 'Stiegenhaus zuerst in Holz geplant.', { status: 'superseded', vector: STAIRS })
    await note(ORG, ids.other, 'decision', 'Stiegenhaus des Nebenprojekts in Holz-Massivbau.', { vector: STAIRS })
    await note(ORG, null, 'decision', 'Stiegenhäuser plant das Büro immer in Stahlbeton.', { scope: 'organization', vector: STAIRS })
    await note(ORG, ids.baden, 'decision', 'Das Honorar für das Stiegenhaus wurde pauschal vereinbart.', {
      restricted: [ids.folder],
      vector: FEES,
    })
    await note(OTHER_ORG, await project(OTHER_ORG, 'Fremd'), 'decision', 'Stiegenhaus in Stahlbeton, fremdes Büro.', { vector: STAIRS })
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

  it('ranks by meaning: a question in English finds the German decision, and another model’s vector counts for nothing', async () => {
    queryVector = STAIRS
    const found = await search(ORG, 'How did we build the stair core?')
    queryVector = null

    expect(found[0]).toMatchObject({
      projectId: ids.baden,
      kind: 'decision',
      content: 'Das Stiegenhaus wird in Stahlbeton ausgeführt, weil das Brandschutzgutachten nur so die Abweichung zulässt.',
      restrictedFolderIds: null,
    })
    // Its words share nothing with the question and its vector is another model's: not found.
    expect(found.map((decision) => decision.content)).not.toContain('Treppenkern betoniert.')
  })

  it('without an embedder, the token channel answers, and finds nothing for a question sharing no word', async () => {
    queryVector = null

    expect((await search(ORG, 'Fluchtwegbreite Baubehörde')).map((decision) => decision.projectId)).toEqual([ids.moedling])
    expect((await search(ORG, 'Stiegenhaus Stahlbeton'))[0]?.projectId).toBe(ids.baden)
    expect(await search(ORG, 'Photovoltaik Dachbegrünung')).toEqual([])
  })

  it('returns only active decisions and constraints of the projects asked about', async () => {
    queryVector = STAIRS
    const contents = (await search(ORG, 'Stiegenhaus')).map((decision) => decision.content)
    queryVector = null

    expect(contents).not.toContain('Ist das Stiegenhaus als Fluchtweg ausreichend breit?')
    expect(contents).not.toContain('Stiegenhaus zuerst in Holz geplant.')
    expect(contents).not.toContain('Stiegenhaus des Nebenprojekts in Holz-Massivbau.')
    expect(contents).not.toContain('Stiegenhäuser plant das Büro immer in Stahlbeton.')
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
    queryVector = STAIRS
    const found = await search(ORG, 'Stiegenhaus Stahlbeton')
    queryVector = null

    expect(found.every((decision) => [ids.baden, ids.moedling].includes(decision.projectId))).toBe(true)
    expect(found.map((decision) => decision.content).join(' ')).not.toContain('fremdes Büro')
    expect(await search(OTHER_ORG, 'Stiegenhaus Stahlbeton')).toEqual([])
  })
})
