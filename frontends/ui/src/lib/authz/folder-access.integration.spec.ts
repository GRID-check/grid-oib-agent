/**
 * @vitest-environment node
 *
 * Read/write folder access against a REAL Postgres (ADR-0088, migrations 0111
 * and 0128), through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/authz/folder-access.integration.spec.ts
 *
 * The unit specs prove the rule and that every read path passes the hidden
 * folders on; this proves the SQL that receives them leaves the documents out,
 * that the tree the decision reads (whether everyone reads, and tombstones) is
 * the one in the database, that a custom folder needs no grant row any more
 * (who is on its list is WorkOS's, ADR-0097) but still needs who set it, that
 * the old grants stay inside the tenant boundary, and that a deleted folder's
 * tombstone frees its name.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { REVIEWER_READER } from '@/lib/documents/document-reader'
import type { FolderClearance } from './folder-access-rule'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_folders_${Date.now()}`
const OTHER_ORG = `${ORG}_other`
const USER = 'user_folders'
const COLLECTION = `proj_folders_${Date.now()}`

/** A folder's own list as the database holds it: whether everyone reads. Its people are WorkOS's. */
type OwnList = { everyoneReads: boolean }

describe.skipIf(!url)('read/write folder access against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let access: typeof import('./folder-access')
  let accessRepo: typeof import('./folder-access-repository')
  let documentsRepo: typeof import('@/lib/documents/repository')
  let projectId: string
  const folder: Record<'verwaltung' | 'vertraege' | 'honorare' | 'statik', string> = {
    verwaltung: '',
    vertraege: '',
    honorare: '',
    statik: '',
  }

  const inTenant = <T>(run: () => Promise<T>, organizationId = ORG): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)
  /** What WorkOS would report for someone holding these folder roles in the project. */
  const holding = (levels: FolderClearance['levels']): FolderClearance => ({ levels, seesEverything: false })

  async function insertFolder(name: string, parentId: string | null, path: string, list: OwnList | null) {
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO project_folders
          (organization_id, project_id, parent_id, name, path, access_mode, everyone_reads, access_changed_by, access_changed_at)
        VALUES (${ORG}, ${projectId}::uuid, ${parentId}::uuid, ${name}, ${path}, ${list ? 'custom' : 'inherit'},
                ${list?.everyoneReads ?? false}, ${list ? USER : null}, ${list ? new Date().toISOString() : null}::timestamptz)
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
    //   Verwaltung/                inherits
    //     Verträge/                its own list (in WorkOS: GF write, PL write, BH read)
    //       Honorare/              its own list (in WorkOS: GF write)
    //   Statik/                    its own list, everyone reads
    folder.verwaltung = await insertFolder('Verwaltung', null, 'Verwaltung', null)
    folder.vertraege = await insertFolder('Verträge', folder.verwaltung, 'Verwaltung/Verträge', { everyoneReads: false })
    folder.honorare = await insertFolder('Honorare', folder.vertraege, 'Verwaltung/Verträge/Honorare', { everyoneReads: false })
    folder.statik = await insertFolder('Statik', null, 'Statik', { everyoneReads: true })

    await insertDocument('Lageplan.pdf', null, COLLECTION)
    await insertDocument('Protokoll.pdf', folder.verwaltung, COLLECTION)
    await insertDocument('Werkvertrag.pdf', folder.vertraege, access.restrictedCollectionName(COLLECTION, folder.vertraege))
    await insertDocument('Honorarnote.pdf', folder.honorare, access.restrictedCollectionName(COLLECTION, folder.honorare))
    await insertDocument('Statik.pdf', folder.statik, COLLECTION)
  })

  afterAll(async () => {
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('reads the tree the decision needs, whether everyone reads and all, and finds an own list in one probe', async () => {
    expect(await accessRepo.projectHasCustomFolders(ORG, projectId)).toBe(true)
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    expect(tree.find((entry) => entry.id === folder.honorare)).toEqual({
      id: folder.honorare,
      parentId: folder.vertraege,
      accessMode: 'custom',
      everyoneReads: false,
      deleted: false,
    })
    expect(tree.find((entry) => entry.id === folder.statik)).toMatchObject({ accessMode: 'custom', everyoneReads: true })
    expect(tree.find((entry) => entry.id === folder.verwaltung)).toMatchObject({ accessMode: 'inherit', everyoneReads: false })
    expect(await accessRepo.listProjectDocumentCollections(ORG, projectId)).toHaveLength(3)
  })

  it('reads a stale `everyone_reads` on a folder that inherits as nothing', async () => {
    const stale = await insertFolder('Stale', null, 'Stale', null)
    try {
      await inTenant(() => db.execute(sql`UPDATE project_folders SET everyone_reads = true WHERE id = ${stale}::uuid`))
      const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
      expect(tree.find((entry) => entry.id === stale)).toMatchObject({ accessMode: 'inherit', everyoneReads: false })
    } finally {
      await inTenant(() => db.execute(sql`UPDATE project_folders SET deleted_at = now(), purged_at = now() WHERE id = ${stale}::uuid`))
    }
  })

  it('leaves out of every listing what a member on no list may not read, and keeps a list everyone reads', async () => {
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    const intern = access.computeFolderAccess(tree, access.ANY_MEMBER, COLLECTION)
    const hiddenFolderIds = [...intern.hiddenFolderIds]

    const page = await documentsRepo.listProjectDocumentPage(projectId, ORG, { hiddenFolderIds, reader: REVIEWER_READER })
    expect(page.rows.map((row) => row.filename).sort()).toEqual(['Lageplan.pdf', 'Protokoll.pdf', 'Statik.pdf'])
    expect(intern.levelOf(folder.statik)).toBe('read')

    const byName = await documentsRepo.findProjectDocumentsByFilenames(
      projectId,
      ORG,
      ['Werkvertrag.pdf', 'Honorarnote.pdf', 'Lageplan.pdf'],
      { hiddenFolderIds, reader: REVIEWER_READER }
    )
    expect(byName.map((row) => row.filename)).toEqual(['Lageplan.pdf'])

    const probe = await documentsRepo.findProjectDocumentsByNames(projectId, ORG, ['Werkvertrag.pdf', 'Honorarnote.pdf'], {
      hiddenFolderIds,
      reader: REVIEWER_READER,
    })
    expect(probe).toEqual([])
  })

  it('lists the contracts to someone holding folder-reader there, read-only, and not the fees; an admin everything', async () => {
    const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
    const accountant = access.computeFolderAccess(tree, holding({ [folder.vertraege]: 'read' }), COLLECTION)
    const page = await documentsRepo.listProjectDocumentPage(projectId, ORG, {
      hiddenFolderIds: [...accountant.hiddenFolderIds],
      reader: REVIEWER_READER,
    })
    expect(page.rows.map((row) => row.filename).sort()).toEqual(['Lageplan.pdf', 'Protokoll.pdf', 'Statik.pdf', 'Werkvertrag.pdf'])
    expect(accountant.levelOf(folder.vertraege)).toBe('read')
    expect(accountant.levelOf(folder.honorare)).toBe('none')

    const admin = access.computeFolderAccess(tree, access.EVERY_FOLDER, COLLECTION)
    const adminPage = await documentsRepo.listProjectDocumentPage(projectId, ORG, {
      hiddenFolderIds: [...admin.hiddenFolderIds],
      reader: REVIEWER_READER,
    })
    expect(adminPage.rows).toHaveLength(5)
  })

  it('knows a name is taken under another restriction, which the per-collection index cannot', async () => {
    const holders = await documentsRepo.findProjectCollectionsHoldingFilename(ORG, projectId, 'Honorarnote.pdf')
    expect(holders).toEqual([access.restrictedCollectionName(COLLECTION, folder.honorare)])
  })

  it('takes a custom folder with no grant row (0128 dropped the 1–20 trigger), and still refuses one nobody set', async () => {
    const own = await insertFolder('Eigen', null, 'Eigen', null)
    try {
      // Made custom with nothing in project_folder_grants: its people are folder roles in WorkOS.
      await inTenant(() =>
        db.execute(sql`
          UPDATE project_folders SET access_mode = 'custom', access_changed_by = ${USER}, access_changed_at = now()
          WHERE id = ${own}::uuid
        `)
      )
      const tree = await accessRepo.listProjectFolderTree(ORG, projectId)
      expect(tree.find((entry) => entry.id === own)).toMatchObject({ accessMode: 'custom', everyoneReads: false })
      // A custom folder nobody set: the 0111 CHECK stays.
      await expect(
        inTenant(() => db.execute(sql`UPDATE project_folders SET access_changed_by = NULL WHERE id = ${own}::uuid`))
      ).rejects.toThrow()
    } finally {
      await inTenant(() => db.execute(sql`UPDATE project_folders SET deleted_at = now(), purged_at = now() WHERE id = ${own}::uuid`))
    }
  })

  it('refuses a level other than read or write, and a slug that could be confused with `*`, in the grants the conversion reads', async () => {
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

  it('keeps the old grants inside the tenant: another organization neither sees nor writes them', async () => {
    await inTenant(() =>
      db.execute(sql`
        INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
        VALUES (${ORG}, ${projectId}::uuid, ${folder.vertraege}::uuid, 'org-geschaeftsfuehrung', 'write')
      `)
    )
    const own = await inTenant(() =>
      db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM project_folder_grants WHERE folder_id = ${folder.vertraege}::uuid`
      )
    )
    expect(Number(Array.from(own)[0]?.n)).toBe(1)
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
    const archiv = await insertFolder('Archiv', null, 'Archiv', { everyoneReads: false })
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
    expect(access.effectiveFolderLevel(lookup, holding({ [archiv]: 'read' }), archiv)).toBe('read')
    expect(access.effectiveFolderLevel(lookup, access.ANY_MEMBER, archiv)).toBe('none')
    // Hidden from every listing, for everyone.
    expect(access.computeFolderAccess(tree, access.EVERY_FOLDER, COLLECTION).isVisible(archiv)).toBe(false)
  })
})

/**
 * Restricted folders do not hold IFC models (ADR-0087). The unit specs prove
 * the BIM read paths pass the hidden folders on and the guard asks for the
 * count; this proves the two queries that receive them.
 */
describe.skipIf(!url)('IFC models and restricted folders against Postgres', () => {
  const IFC_ORG = `org_ifc_folders_${Date.now()}`
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let accessRepo: typeof import('./folder-access-repository')
  let bimRepo: typeof import('@/lib/bim/repository')
  let projectId: string
  let modelle: string
  let plaene: string
  let hiddenModel: string
  let openModel: string

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

  async function insertModel(documentId: string): Promise<string> {
    return firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO bim_models (organization_id, project_id, document_id, status)
          VALUES (${IFC_ORG}, ${projectId}::uuid, ${documentId}::uuid, 'ready')
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
    bimRepo = await import('@/lib/bim/repository')

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
    hiddenModel = await insertModel(await insertDocument('Haus-A.ifc', modelle))
    await insertDocument(' Haus-B.IFCZIP ', modelle)
    await insertDocument('Haus-A.ifc.pdf', modelle)
    await insertDocument('Grundriss.pdf', plaene)
    openModel = await insertModel(await insertDocument('Bestand.ifc', null))
  })

  afterAll(async () => {
    await inTenant(() => db.execute(sql`DELETE FROM bim_models WHERE organization_id = ${IFC_ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${IFC_ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${IFC_ORG}`))
  })

  it('counts the IFC models filed in the given folders, by the name the dispatcher reads', async () => {
    expect(await accessRepo.countIfcDocumentsInFolders(IFC_ORG, projectId, [modelle])).toBe(2)
    expect(await accessRepo.countIfcDocumentsInFolders(IFC_ORG, projectId, [plaene])).toBe(0)
    expect(await accessRepo.countIfcDocumentsInFolders(IFC_ORG, projectId, [])).toBe(0)
  })

  it('leaves a hidden folder’s model out of the model list', async () => {
    const all = await bimRepo.listBimModels(IFC_ORG, { projectId, includeArchiv: true, reader: REVIEWER_READER })
    expect(all.map((model) => model.id).sort()).toEqual([hiddenModel, openModel].sort())

    const visible = await bimRepo.listBimModels(IFC_ORG, { projectId, includeArchiv: true, hiddenFolderIds: [modelle], reader: REVIEWER_READER })
    expect(visible.map((model) => model.id)).toEqual([openModel])
  })
})
