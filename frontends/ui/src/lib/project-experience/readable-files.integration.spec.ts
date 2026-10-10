/**
 * @vitest-environment node
 *
 * Which files the closing extraction may read (`readable-files.ts`), against a
 * REAL Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/project-experience/readable-files.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 * the extraction is offered a file of the project's main collection only while
 * every member may open it now and a model may read it. A held upload, a
 * document filed in a restricted folder whose chunks placement has not moved
 * yet, one in the Papierkorb and an archived one are not offered; another
 * collection and another organization never are.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_readable_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_readable_${STAMP}`

describe('the closing extraction files suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('the files the closing extraction may read, against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let readable: typeof import('./readable-files')
  let projectId = ''
  let foreignProjectId = ''
  const collection = `proj_rf_${STAMP}`

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) => withTenant({ organizationId, userId: USER }, run)
  const change = (statement: ReturnType<typeof sql>) => inOrg(ORG, () => db.execute(statement))
  const inserted = (statement: ReturnType<typeof sql>) => inOrg(ORG, () => db.execute<{ id: string }>(statement))
  const idOf = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return idOf(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${collection}) returning id`)
      )
    )
  }

  let keys = 0
  const storageKey = () => `k/${STAMP}/${(keys += 1)}`

  /** An upload the ingest read to the end and the screen let through. */
  async function document(
    organizationId: string,
    owner: string,
    filename: string,
    extra: { collection?: string; status?: string; outcome?: string | null } = {}
  ): Promise<string> {
    return idOf(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${organizationId}, ${owner}::uuid, 'project', ${filename}, ${storageKey()},
                  ${extra.collection ?? collection}, ${USER}, ${extra.status ?? 'completed'},
                  ${extra.outcome === undefined ? 'clean' : extra.outcome}) returning id`)
      )
    )
  }

  async function folder(name: string): Promise<string> {
    return idOf(
      await inserted(sql`
        insert into project_folders (organization_id, project_id, name, path)
        values (${ORG}, ${projectId}::uuid, ${name}, ${name}) returning id`)
    )
  }

  /** A folder with its own access list (one role, not every member): it restricts reading. */
  async function restrictedFolder(name: string): Promise<string> {
    return idOf(
      // One statement: the 0110 trigger wants the list in the same commit.
      await inserted(sql`
        with folder as (
          insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
          values (${ORG}, ${projectId}::uuid, ${name}, ${name}, 'custom', ${USER}, now())
          returning id, project_id
        ), grants as (
          insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          select ${ORG}, project_id, id, 'org-gf', 'write' from folder
        )
        select id from folder`)
    )
  }

  const fileTo = (documentId: string, folderId: string) =>
    change(sql`update documents set folder_id = ${folderId}::uuid where id = ${documentId}::uuid`)

  const offered = (organizationId = ORG, owner = projectId) =>
    inOrg(organizationId, () => readable.extractableFileNames(organizationId, owner, collection))

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    readable = await import('./readable-files')
    projectId = await project(ORG, 'Ablage')
    foreignProjectId = await project(OTHER_ORG, 'Fremd')

    await document(ORG, projectId, 'Baubeschreibung.pdf')
    await fileTo(await document(ORG, projectId, 'Bescheid.pdf'), await folder(`Behoerde_${STAMP}`))
    // Moved into a folder with its own list; placement has not re-pointed its collection yet.
    await fileTo(await document(ORG, projectId, 'Honorare.pdf'), await restrictedFolder(`Vertraulich_${STAMP}`))
    // Held by the upload screen, and one still being read, whose verdict is to come.
    await document(ORG, projectId, 'Gesperrt.pdf', { status: 'quarantined', outcome: 'quarantined' })
    await document(ORG, projectId, 'Ungeprueft.pdf', { status: 'processing', outcome: null })
    await change(sql`update documents set lifecycle = 'archived' where id = ${await document(ORG, projectId, 'Archiviert.pdf')}::uuid`)
    const bin = await folder(`Papierkorb_${STAMP}`)
    await fileTo(await document(ORG, projectId, 'Weggeworfen.pdf'), bin)
    await change(sql`update project_folders set deleted_at = now(), bin_root_id = id where id = ${bin}::uuid`)
    // A restricted folder's own collection, and another organization's document of the same collection name.
    await document(ORG, projectId, 'Eigene_Sammlung.pdf', { collection: `${collection}_r0123456789ab` })
    await document(OTHER_ORG, foreignProjectId, 'Fremd.pdf')
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('offers only the active, screened files every member may open now', async () => {
    expect(await offered()).toEqual(['Baubeschreibung.pdf', 'Bescheid.pdf'])
  })

  it('offers nothing of another organization’s project, and that project only its own file', async () => {
    expect(await offered(ORG, foreignProjectId)).toEqual([])
    expect(await offered(OTHER_ORG, foreignProjectId)).toEqual(['Fremd.pdf'])
  })
})
