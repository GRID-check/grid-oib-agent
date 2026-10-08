/**
 * @vitest-environment node
 *
 * Read/write folder access against a REAL Postgres (ADR-0085, migration 0109),
 * through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/authz/folder-access.integration.spec.ts
 *
 * The unit specs prove the rule and that every read path passes the hidden
 * folders on; this proves the SQL that receives them leaves the documents out,
 * that the tree the decision reads (grants and tombstones included) is the one
 * in the database, that the deferred trigger keeps a custom list from being
 * empty, that the grants are inside the tenant boundary, and that a deleted
 * folder's tombstone frees its name.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_folders_${Date.now()}`
const OTHER_ORG = `${ORG}_other`
const USER = 'user_folders'
const COLLECTION = `proj_folders_${Date.now()}`

type Grants = Array<[string, 'read' | 'write']>

describe.skipIf(!url)('read/write folder access against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let access: typeof import('./folder-access')
  let accessRepo: typeof import('./folder-access-repository')
  let documentsRepo: typeof import('@/lib/documents/repository')
  let projectId: string
  const folder: Record<'verwaltung' | 'vertraege' | 'honorare', string> = { verwaltung: '', vertraege: '', honorare: '' }

  const inTenant = <T>(run: () => Promise<T>, organizationId = ORG): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)

  /** A folder, with its own list in the same statement: the 0109 trigger checks at commit. */
  async function insertFolder(name: string, parentId: string | null, path: string, grants: Grants | null) {
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        WITH folder AS (
          INSERT INTO project_folders (organization_id, project_id, parent_id, name, path, access_mode, access_changed_by, access_changed_at)
          VALUES (${ORG}, ${projectId}::uuid, ${parentId}::uuid, ${name}, ${path}, ${grants ? 'custom' : 'inherit'},
                  ${grants ? USER : null}, ${grants ? new Date().toISOString() : null}::timestamptz)
          RETURNING id, project_id
        ), listed AS (
          INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          SELECT ${ORG}, folder.project_id, folder.id, grant_row.role_slug, grant_row.level
          FROM folder, jsonb_to_recordset(${JSON.stringify((grants ?? []).map(([role_slug, level]) => ({ role_slug, level })))}::jsonb)
            AS grant_row(role_slug text, level text)
        )
        SELECT id FROM folder
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
    //   Verwaltung/                inherits
    //     Verträge/                GF: write, PL: write, BH: read
    //       Honorare/              GF: write
    folder.verwaltung = await insertFolder('Verwaltung', null, 'Verwaltung', null)
    folder.vertraege = await insertFolder('Verträge', folder.verwaltung, 'Verwaltung/Verträge', [
      ['org-geschaeftsfuehrung', 'write'],
      ['org-projektleitung', 'write'],
      ['org-buchhaltung', 'read'],
    ])
    folder.honorare = await insertFolder('Honorare', folder.vertraege, 'Verwaltung/Verträge/Honorare', [
      ['org-geschaeftsfuehrung', 'write'],
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

  it('reads the tree the decision needs, grants and all, and finds an own list in one probe', async () => {
    expect(await accessRepo.projectHasCustomFolders(ORG, projectId)).toBe(true)
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    expect(tree.find((entry) => entry.id === folder.honorare)).toEqual({
      id: folder.honorare,
      parentId: folder.vertraege,
      accessMode: 'custom',
      grants: [{ role: 'org-geschaeftsfuehrung', level: 'write' }],
      deleted: false,
    })
    expect(tree.find((entry) => entry.id === folder.verwaltung)).toMatchObject({ accessMode: 'inherit', grants: [] })
    expect(await accessRepo.listProjectDocumentCollections(ORG, projectId)).toHaveLength(3)
  })

  it('leaves out of every listing what a member may not read', async () => {
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

  it('lists the contracts to Buchhaltung, read-only, and neither the fees; an admin everything', async () => {
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    const accountant = access.computeFolderAccess(tree, { roles: ['org-buchhaltung'], seesEverything: false }, COLLECTION)
    const page = await documentsRepo.listProjectDocumentPage(projectId, ORG, {
      hiddenFolderIds: [...accountant.hiddenFolderIds],
    })
    expect(page.rows.map((row) => row.filename).sort()).toEqual(['Lageplan.pdf', 'Protokoll.pdf', 'Werkvertrag.pdf'])
    expect(accountant.levelOf(folder.vertraege)).toBe('read')
    expect(accountant.levelOf(folder.honorare)).toBe('none')

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

  it('refuses a custom list with no entry, at commit, whichever table the statement touched', async () => {
    // A folder made custom with nothing listed.
    await expect(
      inTenant(() =>
        db.execute(sql`
          UPDATE project_folders SET access_mode = 'custom', access_changed_by = ${USER}, access_changed_at = now()
          WHERE id = ${folder.verwaltung}::uuid
        `)
      )
    ).rejects.toThrow()
    // The last grant of a custom folder taken away.
    await expect(
      inTenant(() => db.execute(sql`DELETE FROM project_folder_grants WHERE folder_id = ${folder.honorare}::uuid`))
    ).rejects.toThrow()
    // A custom folder nobody set.
    await expect(
      inTenant(() =>
        db.execute(sql`
          UPDATE project_folders SET access_changed_by = NULL WHERE id = ${folder.honorare}::uuid
        `)
      )
    ).rejects.toThrow()
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    expect(tree.find((entry) => entry.id === folder.honorare)?.grants).toHaveLength(1)
  })

  it('refuses a level other than read or write, and a slug that could be confused with `*`', async () => {
    const insertGrant = (role: string, level: string) =>
      inTenant(() =>
        db.execute(sql`
          INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          VALUES (${ORG}, ${projectId}::uuid, ${folder.honorare}::uuid, ${role}, ${level})
        `)
      )
    await expect(insertGrant('org-projektleitung', 'admin')).rejects.toThrow()
    await expect(insertGrant('*evil', 'read')).rejects.toThrow()
    await expect(insertGrant('org x', 'read')).rejects.toThrow()
  })

  it('keeps grants inside the tenant: another organization neither sees nor writes them', async () => {
    const seen = await inTenant(
      () =>
        db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM project_folder_grants WHERE folder_id = ${folder.vertraege}::uuid`
        ),
      OTHER_ORG
    )
    expect(Number(Array.from(seen)[0]?.n)).toBe(0)
    await expect(
      inTenant(
        () =>
          db.execute(sql`
            INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            VALUES (${ORG}, ${projectId}::uuid, ${folder.vertraege}::uuid, 'org-forged', 'write')
          `),
        OTHER_ORG
      )
    ).rejects.toThrow()
  })

  it('keeps a deleted folder as a tombstone that frees its name and still answers for its access', async () => {
    const archiv = await insertFolder('Archiv', null, 'Archiv', [['org-geschaeftsfuehrung', 'read']])
    await inTenant(() =>
      db.execute(sql`UPDATE project_folders SET deleted_at = now(), deleted_by = ${USER} WHERE id = ${archiv}::uuid`)
    )
    // The name is free again for a living sibling.
    const again = await insertFolder('Archiv', null, 'Archiv', null)
    expect(again).not.toBe(archiv)

    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    const tombstone = tree.find((entry) => entry.id === archiv)
    expect(tombstone).toMatchObject({ deleted: true, accessMode: 'custom' })
    const lookup = access.folderTree(tree)
    expect(access.effectiveFolderLevel(lookup, { roles: ['org-geschaeftsfuehrung'], seesEverything: false }, archiv)).toBe('read')
    expect(access.effectiveFolderLevel(lookup, { roles: ['member'], seesEverything: false }, archiv)).toBe('none')
    // Hidden from every listing, for everyone.
    expect(access.computeFolderAccess(tree, { roles: [], seesEverything: true }, COLLECTION).isVisible(archiv)).toBe(false)
  })
})

/**
 * Restricted folders do not hold IFC models (ADR-0084). The unit specs prove
 * the guard asks for the count; this proves the query that answers it.
 */
describe.skipIf(!url)('IFC models and restricted folders against Postgres', () => {
  const IFC_ORG = `org_ifc_folders_${Date.now()}`
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let accessRepo: typeof import('./folder-access-repository')
  let projectId: string
  let modelle: string
  let plaene: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: IFC_ORG, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)

  async function insertFolder(name: string): Promise<string> {
    return firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (organization_id, project_id, parent_id, name, path)
          VALUES (${IFC_ORG}, ${projectId}::uuid, NULL, ${name}, ${name})
          RETURNING id
        `)
      )
    )
  }

  async function insertDocument(filename: string, folderId: string | null): Promise<string> {
    return firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
          VALUES
            (${IFC_ORG}, ${USER}, ${filename}, ${`k/${filename}`}, 'proj_ifc', 'completed', 'project',
             ${projectId}::uuid, ${folderId}::uuid)
          RETURNING id
        `)
      )
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    accessRepo = await import('./folder-access-repository')

    projectId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${IFC_ORG}, 'IFC', ${USER}, 'proj_ifc')
          RETURNING id
        `)
      )
    )
    modelle = await insertFolder('Modelle')
    plaene = await insertFolder('Pläne')
    await insertDocument('Haus-A.ifc', modelle)
    await insertDocument(' Haus-B.IFCZIP ', modelle)
    await insertDocument('Haus-A.ifc.pdf', modelle)
    await insertDocument('Grundriss.pdf', plaene)
    await insertDocument('Bestand.ifc', null)
  })

  afterAll(async () => {
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${IFC_ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${IFC_ORG}`))
  })

  it('counts the IFC models filed in the given folders, by the name the dispatcher reads', async () => {
    expect(await accessRepo.countIfcDocumentsInFolders(IFC_ORG, projectId, [modelle])).toBe(2)
    expect(await accessRepo.countIfcDocumentsInFolders(IFC_ORG, projectId, [plaene])).toBe(0)
    expect(await accessRepo.countIfcDocumentsInFolders(IFC_ORG, projectId, [])).toBe(0)
  })
})
