/**
 * @vitest-environment node
 *
 * Restricted folders against a REAL Postgres (ADR-0078, migration 0104),
 * through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/authz/folder-access.integration.spec.ts
 *
 * The unit specs prove that every read path passes the hidden folders on; this
 * proves the SQL that receives them leaves the documents out, that the folder
 * tree the decision reads is the one in the database, and that the CHECK keeps
 * a restriction from naming nobody or nothing.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_folders_${Date.now()}`
const USER = 'user_folders'
const COLLECTION = `proj_folders_${Date.now()}`

describe.skipIf(!url)('restricted folders against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let access: typeof import('./folder-access')
  let accessRepo: typeof import('./folder-access-repository')
  let documentsRepo: typeof import('@/lib/documents/repository')
  let projectId: string
  const folder: Record<'verwaltung' | 'vertraege' | 'honorare', string> = { verwaltung: '', vertraege: '', honorare: '' }

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)

  async function insertFolder(name: string, parentId: string | null, path: string, roles: string[] | null) {
    const rolesSql = roles ? sql`ARRAY[${sql.join(roles.map((role) => sql`${role}`), sql`, `)}]::text[]` : sql`NULL`
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO project_folders (project_id, parent_id, name, path, restricted_roles, restricted_by, restricted_at)
        VALUES (${projectId}::uuid, ${parentId}::uuid, ${name}, ${path}, ${rolesSql},
                ${roles ? USER : null}, ${roles ? new Date().toISOString() : null}::timestamptz)
        RETURNING id
      `)
    )
    return firstId(rows)
  }

  async function insertDocument(filename: string, folderId: string | null, collection: string) {
    await inTenant(() =>
      db.execute(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
        VALUES
          (${ORG}, ${USER}, ${filename}, ${`k/${filename}`}, ${collection}, 'completed', 'project',
           ${projectId}::uuid, ${folderId}::uuid)
      `)
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    access = await import('./folder-access')
    accessRepo = await import('./folder-access-repository')
    documentsRepo = await import('@/lib/documents/repository')

    projectId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Folders', ${USER}, ${COLLECTION})
          RETURNING id
        `)
      )
    )
    //   Verwaltung/                (open)
    //     Verträge/                (org-geschaeftsfuehrung, org-projektleitung)
    //       Honorare/              (org-geschaeftsfuehrung)
    folder.verwaltung = await insertFolder('Verwaltung', null, 'Verwaltung', null)
    folder.vertraege = await insertFolder('Verträge', folder.verwaltung, 'Verwaltung/Verträge', [
      'org-geschaeftsfuehrung',
      'org-projektleitung',
    ])
    folder.honorare = await insertFolder('Honorare', folder.vertraege, 'Verwaltung/Verträge/Honorare', [
      'org-geschaeftsfuehrung',
    ])

    await insertDocument('Lageplan.pdf', null, COLLECTION)
    await insertDocument('Protokoll.pdf', folder.verwaltung, COLLECTION)
    await insertDocument('Werkvertrag.pdf', folder.vertraege, access.restrictedCollectionName(COLLECTION, folder.vertraege))
    await insertDocument('Honorarnote.pdf', folder.honorare, access.restrictedCollectionName(COLLECTION, folder.honorare))
  })

  afterAll(async () => {
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('reads the tree the decision needs, and finds the restriction in one probe', async () => {
    expect(await accessRepo.projectHasRestrictedFolders(ORG, projectId)).toBe(true)
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    expect(tree.find((entry) => entry.id === folder.honorare)).toEqual({
      id: folder.honorare,
      parentId: folder.vertraege,
      restrictedRoles: ['org-geschaeftsfuehrung'],
    })
    expect(await accessRepo.listProjectDocumentCollections(ORG, projectId)).toHaveLength(3)
  })

  it('leaves out of every listing what an uncleared member may not see', async () => {
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    const intern = access.computeFolderAccess(tree, { roles: ['member'], seesEverything: false }, COLLECTION)
    const hiddenFolderIds = [...intern.hiddenFolderIds]

    const page = await documentsRepo.listProjectDocumentPage(projectId, ORG, { hiddenFolderIds })
    expect(page.rows.map((row) => row.filename).sort()).toEqual(['Lageplan.pdf', 'Protokoll.pdf'])

    const byName = await documentsRepo.findProjectDocumentsByFilenames(
      projectId,
      ORG,
      ['Werkvertrag.pdf', 'Honorarnote.pdf', 'Lageplan.pdf'],
      { hiddenFolderIds }
    )
    expect(byName.map((row) => row.filename)).toEqual(['Lageplan.pdf'])

    const probe = await documentsRepo.findProjectDocumentsByNames(projectId, ORG, ['Werkvertrag.pdf', 'Honorarnote.pdf'], {
      hiddenFolderIds,
    })
    expect(probe).toEqual([])
  })

  it('shows Projektleitung the contracts but not the fees, and an admin everything', async () => {
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    const lead = access.computeFolderAccess(tree, { roles: ['org-projektleitung'], seesEverything: false }, COLLECTION)
    const leadPage = await documentsRepo.listProjectDocumentPage(projectId, ORG, {
      hiddenFolderIds: [...lead.hiddenFolderIds],
    })
    expect(leadPage.rows.map((row) => row.filename).sort()).toEqual(['Lageplan.pdf', 'Protokoll.pdf', 'Werkvertrag.pdf'])

    const admin = access.computeFolderAccess(tree, { roles: [], seesEverything: true }, COLLECTION)
    const adminPage = await documentsRepo.listProjectDocumentPage(projectId, ORG, {
      hiddenFolderIds: [...admin.hiddenFolderIds],
    })
    expect(adminPage.rows).toHaveLength(4)
  })

  it('knows a name is taken under another restriction, which the per-collection index cannot', async () => {
    const holders = await documentsRepo.findProjectCollectionsHoldingFilename(ORG, projectId, 'Honorarnote.pdf')
    expect(holders).toEqual([access.restrictedCollectionName(COLLECTION, folder.honorare)])
  })

  it('refuses a restriction that names no role, or that nobody drew', async () => {
    await expect(
      inTenant(() =>
        db.execute(sql`
          UPDATE project_folders SET restricted_roles = ARRAY[]::text[], restricted_by = ${USER}, restricted_at = now()
          WHERE id = ${folder.verwaltung}::uuid
        `)
      )
    ).rejects.toThrow()
    await expect(
      inTenant(() =>
        db.execute(sql`
          UPDATE project_folders SET restricted_roles = ARRAY['org-x']::text[], restricted_by = NULL, restricted_at = NULL
          WHERE id = ${folder.verwaltung}::uuid
        `)
      )
    ).rejects.toThrow()
  })
})
