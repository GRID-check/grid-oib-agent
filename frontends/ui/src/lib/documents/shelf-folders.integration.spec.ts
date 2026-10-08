/**
 * @vitest-environment node
 *
 * One folder implementation, two shelves, against a REAL Postgres (ADR-0078).
 *
 * The unit suites pin the service against a doubled handle; this one proves the
 * claims that only a database can: the unique index really is per shelf and per
 * tenant, a rename really rewrites only its own shelf's subtree, a delete really
 * re-files documents into the parent, and the listing is ONE query that serves a
 * project and the Archiv the same row. It runs under `task db:test:rls`, through
 * the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/shelf-folders.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// Project access is FGA (WorkOS), which is not this suite's subject: the shelf's
// authorization is unit-tested, and the database's half is the point here.
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn().mockResolvedValue(undefined) }))
// The backend mirror is best-effort; nothing listens.
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://127.0.0.1:9' }))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_folders_${Date.now()}`
const OTHER_ORG = `org_folders_other_${Date.now()}`
const USER = 'user_folders'

describe.skipIf(!url)('shelf folders against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let folders: typeof import('./shelf-folders')
  let shelf: typeof import('./shelf')
  let move: typeof import('./move-to-folder')
  let repo: typeof import('./repository')
  let projectId: string

  const session = (organizationId = ORG) =>
    ({
      userId: USER,
      organizationId,
      role: 'member',
      permissions: ['org:archiv:manage'],
    }) as unknown as import('@/lib/auth/types').AuthorizedSession
  const inTenant = <T>(run: () => Promise<T>, organizationId = ORG): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)

  async function insertDocument(
    id: string,
    scope: 'project' | 'archiv',
    extra: { lifecycle?: 'active' | 'archived'; agent?: boolean } = {},
  ): Promise<void> {
    await inTenant(() =>
      db.execute(sql`
        INSERT INTO documents
          (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
           lifecycle, authored_by, authored_by_producer, authored_by_ref, authored_by_ref_kind)
        VALUES
          (${id}, ${ORG}, ${USER}, ${id + '.pdf'}, ${'k/' + id},
           ${scope === 'project' ? 'coll_folders' : 'archiv_' + ORG}, 'completed', ${scope},
           ${scope === 'project' ? projectId : null}::uuid, ${extra.lifecycle ?? 'active'},
           ${extra.agent ? 'agent' : 'user'}, ${extra.agent ? 'deep_research' : null},
           ${extra.agent ? 'run-1' : null}, ${extra.agent ? 'agent_run' : null})
      `),
    )
  }

  const folderOf = async (documentId: string): Promise<string | null> => {
    const rows = await inTenant(() =>
      db.execute<{ folder_id: string | null }>(sql`SELECT folder_id FROM documents WHERE id = ${documentId}`),
    )
    return Array.from(rows)[0].folder_id
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    folders = await import('./shelf-folders')
    shelf = await import('./shelf')
    move = await import('./move-to-folder')
    repo = await import('./repository')

    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Folders', ${USER}, 'coll_folders') RETURNING id
      `),
    )
    projectId = String(Array.from(rows)[0].id)
  }, 60_000)

  afterAll(async () => {
    if (!db) return
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`DELETE FROM documents WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`DELETE FROM project_folders WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('keeps one folder per name per parent on each shelf, and the same name on both', async () => {
    const archiv = await inTenant(() =>
      folders.createShelfFolder(session(), shelf.ARCHIV_SHELF, { name: 'Normen' }),
    )
    const project = await inTenant(() =>
      folders.createShelfFolder(session(), shelf.projectShelf(projectId), { name: 'Normen' }),
    )
    const duplicate = await inTenant(() =>
      folders.createShelfFolder(session(), shelf.ARCHIV_SHELF, { name: 'Normen' }),
    )
    // The same name in another tenant's Archiv is another folder.
    const elsewhere = await inTenant(
      () => folders.createShelfFolder(session(OTHER_ORG), shelf.ARCHIV_SHELF, { name: 'Normen' }),
      OTHER_ORG,
    )

    expect(archiv.ok && project.ok && elsewhere.ok).toBe(true)
    expect(duplicate).toEqual({ ok: false, error: 'A folder with this name already exists here.' })
    expect(archiv.ok && archiv.folder.projectId).toBeNull()
    expect(project.ok && project.folder.projectId).toBe(projectId)
  })

  it('lists a shelf and nothing of another shelf or tenant', async () => {
    const archivRows = await inTenant(() => folders.listShelfFolders(session(), shelf.ARCHIV_SHELF))
    const projectRows = await inTenant(() => folders.listShelfFolders(session(), shelf.projectShelf(projectId)))
    const otherRows = await inTenant(
      () => folders.listShelfFolders(session(OTHER_ORG), shelf.ARCHIV_SHELF),
      OTHER_ORG,
    )

    expect(archivRows.map((row) => row.projectId)).toEqual([null])
    expect(projectRows.map((row) => row.projectId)).toEqual([projectId])
    expect(otherRows).toHaveLength(1)
    expect(otherRows[0].id).not.toBe(archivRows[0].id)
  })

  it('renames an Archiv subtree without touching a project folder of the same path', async () => {
    const root = await inTenant(() =>
      folders.createShelfFolder(session(), shelf.ARCHIV_SHELF, { name: 'Pläne' }),
    )
    if (!root.ok) throw new Error(root.error)
    const child = await inTenant(() =>
      folders.createShelfFolder(session(), shelf.ARCHIV_SHELF, { name: 'EG', parentId: root.folder.id }),
    )
    const projectTwin = await inTenant(() =>
      folders.createShelfFolder(session(), shelf.projectShelf(projectId), { name: 'Pläne' }),
    )
    if (!child.ok || !projectTwin.ok) throw new Error('setup')

    const renamed = await inTenant(() =>
      folders.updateShelfFolder(session(), shelf.ARCHIV_SHELF, { folderId: root.folder.id, name: 'Plaene' }),
    )

    expect(renamed.ok).toBe(true)
    const after = await inTenant(() => folders.listShelfFolders(session(), shelf.ARCHIV_SHELF))
    expect(after.map((row) => row.path)).toEqual(expect.arrayContaining(['Plaene', 'Plaene/EG']))
    const projectAfter = await inTenant(() => folders.listShelfFolders(session(), shelf.projectShelf(projectId)))
    expect(projectAfter.map((row) => row.path)).toContain('Pläne')
    expect(projectAfter.map((row) => row.path)).not.toContain('Plaene')
  })

  it('refuses to move an Archiv folder into its own subfolder, and to a folder of another shelf', async () => {
    const [root] = (await inTenant(() => folders.listShelfFolders(session(), shelf.ARCHIV_SHELF))).filter(
      (row) => row.path === 'Plaene',
    )
    const [child] = (await inTenant(() => folders.listShelfFolders(session(), shelf.ARCHIV_SHELF))).filter(
      (row) => row.path === 'Plaene/EG',
    )
    const [projectFolder] = await inTenant(() => folders.listShelfFolders(session(), shelf.projectShelf(projectId)))

    const intoSubtree = await inTenant(() =>
      folders.updateShelfFolder(session(), shelf.ARCHIV_SHELF, { folderId: root.id, parentId: child.id }),
    )
    const intoProject = await inTenant(() =>
      folders.updateShelfFolder(session(), shelf.ARCHIV_SHELF, { folderId: root.id, parentId: projectFolder.id }),
    )

    expect(intoSubtree).toEqual({ ok: false, error: 'A folder cannot be moved into its own subfolder.' })
    expect(intoProject).toEqual({ ok: false, error: 'Parent folder not found.' })
  })

  it('files an Archiv document, refuses a project document there, and re-files on delete', async () => {
    const archivDoc = '00000000-0000-4000-8000-0000000f0001'
    const projectDoc = '00000000-0000-4000-8000-0000000f0002'
    await insertDocument(archivDoc, 'archiv')
    await insertDocument(projectDoc, 'project')
    const all = await inTenant(() => folders.listShelfFolders(session(), shelf.ARCHIV_SHELF))
    const root = all.find((row) => row.path === 'Plaene')!
    const child = all.find((row) => row.path === 'Plaene/EG')!

    const filed = await inTenant(() => move.moveDocumentToFolder({ documentId: archivDoc, folderId: child.id }, session()))
    const refused = await inTenant(() =>
      move.moveDocumentToFolder({ documentId: projectDoc, folderId: child.id }, session()),
    )

    expect(filed.ok).toBe(true)
    expect(await folderOf(archivDoc)).toBe(child.id)
    expect(refused).toEqual({ ok: false, error: 'Folder not found in this project.' })
    expect(await folderOf(projectDoc)).toBeNull()

    // Deleting the folder re-files its document into the parent: nothing is
    // left for the ON DELETE CASCADE to find.
    const deleted = await inTenant(() => folders.deleteShelfFolder(session(), shelf.ARCHIV_SHELF, child.id))
    expect(deleted.ok && deleted.result).toEqual({ documentsMoved: 1, foldersMoved: 0 })
    expect(await folderOf(archivDoc)).toBe(root.id)
    // The row is gone, not a tombstone: the Archiv has no Papierkorb (ADR-0085),
    // and `project_folders_bin_state_check` would refuse a deleted Archiv folder.
    const left = await inTenant(() => db.execute(sql`SELECT id FROM project_folders WHERE id = ${child.id}`))
    expect(Array.from(left)).toHaveLength(0)

    const rootDeleted = await inTenant(() => folders.deleteShelfFolder(session(), shelf.ARCHIV_SHELF, root.id))
    expect(rootDeleted.ok && rootDeleted.result).toEqual({ documentsMoved: 1, foldersMoved: 0 })
    expect(await folderOf(archivDoc)).toBeNull()
    // The document itself survived both deletes.
    const survivors = await inTenant(() =>
      db.execute(sql`SELECT id FROM documents WHERE id = ${archivDoc}`),
    )
    expect(Array.from(survivors)).toHaveLength(1)
  })

  it('serves a project and the Archiv one listing: same columns, same filters', async () => {
    await insertDocument('00000000-0000-4000-8000-0000000f0011', 'archiv')
    await insertDocument('00000000-0000-4000-8000-0000000f0012', 'archiv', { lifecycle: 'archived' })
    await insertDocument('00000000-0000-4000-8000-0000000f0013', 'archiv', { agent: true })
    await insertDocument('00000000-0000-4000-8000-0000000f0021', 'project')
    await insertDocument('00000000-0000-4000-8000-0000000f0022', 'project', { lifecycle: 'archived' })
    await insertDocument('00000000-0000-4000-8000-0000000f0023', 'project', { agent: true })

    const archiv = (options = {}) => repo.listDocumentPage(shelf.ARCHIV_SHELF, ORG, options)
    const project = (options = {}) => repo.listDocumentPage(shelf.projectShelf(projectId), ORG, options)
    const ids = async (page: ReturnType<typeof archiv>) => (await page).rows.map((row) => row.id.slice(-2)).sort()

    // The working set by default, both shelves alike.
    // (`01` and `02` are the documents the previous test left behind.)
    expect(await ids(archiv())).toEqual(['01', '11', '13'])
    expect(await ids(project())).toEqual(['02', '21', '23'])
    // Archived ones on request.
    expect(await ids(archiv({ includeArchived: true }))).toContain('12')
    expect(await ids(project({ includeArchived: true }))).toContain('22')
    // The author filter.
    expect(await ids(archiv({ authoredBy: 'agent' }))).toEqual(['13'])
    expect(await ids(project({ authoredBy: 'agent' }))).toEqual(['23'])

    // One row shape: the key sets cannot diverge because the query is one.
    const archivRow = (await archiv()).rows[0]
    const projectRow = (await project()).rows[0]
    expect(Object.keys(archivRow).sort()).toEqual(Object.keys(projectRow).sort())
    expect(Object.keys(archivRow)).toEqual(
      expect.arrayContaining(['folderId', 'originPath', 'authoredBy', 'lifecycle', 'contentHash']),
    )
  })
})
