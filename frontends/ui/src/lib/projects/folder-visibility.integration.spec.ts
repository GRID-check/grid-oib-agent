/**
 * @vitest-environment node
 *
 * The project overview and the document-role bindings against a REAL Postgres
 * (ADR-0086), through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/folder-visibility.integration.spec.ts
 *
 * Each reads `documents` beside the listing repository: the overview's recent
 * list and its counts, the projects grid's number, and a binding's filename in
 * the roles route and in every member's agent prompt. The unit specs prove the hidden
 * folders are passed on; this proves the SQL that receives them leaves the
 * documents out.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_folder_vis_${Date.now()}`
const USER = 'user_folder_vis'
const COLLECTION = `proj_folder_vis_${Date.now()}`

describe.skipIf(!url)('restricted folders in the overview and the role bindings', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let access: typeof import('@/lib/authz/folder-access')
  let overview: typeof import('./overview-query')
  let roles: typeof import('@/lib/document-roles/repository')
  let documentsRepository: typeof import('@/lib/documents/repository')
  let projectId: string
  const folder = { verwaltung: '', vertraege: '' }
  const doc: Record<string, string> = {}

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)

  /**
   * A folder whose own list grants each of `roleSlugs` write, or one that inherits (null); one statement for the 0109 trigger.
   * The slugs travel as one array literal: drizzle spreads a JS array into a parameter list, and an empty one into `()`.
   */
  async function insertFolder(name: string, parentId: string | null, path: string, roleSlugs: string[] | null) {
    return firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          WITH folder AS (
            INSERT INTO project_folders (organization_id, project_id, parent_id, name, path, access_mode, access_changed_by, access_changed_at)
            VALUES (${ORG}, ${projectId}::uuid, ${parentId}::uuid, ${name}, ${path}, ${roleSlugs ? 'custom' : 'inherit'},
                    ${roleSlugs ? USER : null}, ${roleSlugs ? new Date().toISOString() : null}::timestamptz)
            RETURNING id, project_id
          ), listed AS (
            INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            SELECT ${ORG}, folder.project_id, folder.id, slug, 'write'
            FROM folder, unnest(${`{${(roleSlugs ?? []).join(',')}}`}::text[]) AS slug
          )
          SELECT id FROM folder
        `)
      )
    )
  }

  async function insertDocument(filename: string, folderId: string | null, size: number) {
    doc[filename] = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id, file_size)
          VALUES
            (${ORG}, ${USER}, ${filename}, ${`k/${filename}`}, ${COLLECTION}, 'completed', 'project',
             ${projectId}::uuid, ${folderId}::uuid, ${size})
          RETURNING id
        `)
      )
    )
  }

  async function bindRole(filename: string, role: string) {
    await inTenant(() =>
      db.execute(sql`
        INSERT INTO document_roles (organization_id, project_id, document_id, role, created_by)
        VALUES (${ORG}, ${projectId}::uuid, ${doc[filename]}::uuid, ${role}, ${USER})
      `)
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    access = await import('@/lib/authz/folder-access')
    overview = await import('./overview-query')
    roles = await import('@/lib/document-roles/repository')
    documentsRepository = await import('@/lib/documents/repository')

    projectId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Folder visibility', ${USER}, ${COLLECTION})
          RETURNING id
        `)
      )
    )
    //   Lageplan.pdf             (root, 100 bytes)
    //   Verwaltung/              (open)    Protokoll.pdf (200)
    //     Verträge/              (org-gf)  Honorarvertrag.pdf (4000)
    folder.verwaltung = await insertFolder('Verwaltung', null, 'Verwaltung', null)
    folder.vertraege = await insertFolder('Verträge', folder.verwaltung, 'Verwaltung/Verträge', ['org-gf'])
    await insertDocument('Lageplan.pdf', null, 100)
    await insertDocument('Protokoll.pdf', folder.verwaltung, 200)
    await insertDocument('Honorarvertrag.pdf', folder.vertraege, 4000)
    await bindRole('Lageplan.pdf', 'lageplan')
    await bindRole('Protokoll.pdf', 'protokoll')
    await bindRole('Honorarvertrag.pdf', 'vertrag')
  })

  afterAll(async () => {
    await inTenant(() => db.execute(sql`DELETE FROM document_roles WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('finds every folder under a restriction, for a reader with no clearance', async () => {
    expect(await access.getRestrictedFolderIds(ORG, projectId)).toEqual([folder.vertraege])
  })

  it('leaves a hidden folder out of the overview count, size and recent list', async () => {
    const hiddenFolderIds = await access.getRestrictedFolderIds(ORG, projectId)
    const data = await inTenant(() => overview.getProjectOverviewData(projectId, ORG, { hiddenFolderIds }))

    expect(data?.documentCount).toBe(2)
    expect(data?.totalFileSize).toBe(300)
    expect(data?.recentDocuments.map((row) => row.filename).sort()).toEqual(['Lageplan.pdf', 'Protokoll.pdf'])

    const everything = await inTenant(() => overview.getProjectOverviewData(projectId, ORG, { hiddenFolderIds: [] }))
    expect(everything?.documentCount).toBe(3)
    expect(everything?.totalFileSize).toBe(4300)
  })

  it('leaves a hidden folder out of the number on the projects grid', async () => {
    const hiddenFolderIds = await access.getRestrictedFolderIds(ORG, projectId)

    const counted = await inTenant(() => documentsRepository.countDocumentsByProject(ORG, [projectId], hiddenFolderIds))
    expect(counted).toEqual({ [projectId]: 2 })

    const everything = await inTenant(() => documentsRepository.countDocumentsByProject(ORG, [projectId], []))
    expect(everything).toEqual({ [projectId]: 3 })
    // Without a reader's hidden list the count is what it always was.
    expect(await inTenant(() => documentsRepository.countDocumentsByProject(ORG, [projectId]))).toEqual({ [projectId]: 3 })
  })

  it('lists no binding to a document in a hidden folder', async () => {
    const hiddenFolderIds = await access.getRestrictedFolderIds(ORG, projectId)
    const listed = await inTenant(() => roles.listProjectDocumentRoles(projectId, { hiddenFolderIds }))
    expect(listed.map((row) => row.filename).sort()).toEqual(['Lageplan.pdf', 'Protokoll.pdf'])

    const all = await inTenant(() => roles.listProjectDocumentRoles(projectId, { hiddenFolderIds: [] }))
    expect(all).toHaveLength(3)
  })

  it('names only unfiled documents when no folder can be decided', async () => {
    const listed = await inTenant(() => roles.listProjectDocumentRoles(projectId, { unfiledOnly: true }))
    expect(listed.map((row) => row.filename)).toEqual(['Lageplan.pdf'])
  })

  it('answers a hidden document like a missing one when it is to be bound', async () => {
    const hiddenFolderIds = await access.getRestrictedFolderIds(ORG, projectId)
    const reader = { hiddenFolderIds }
    expect(await inTenant(() => roles.documentBelongsToProject(doc['Honorarvertrag.pdf'], projectId, reader))).toBe(false)
    expect(await inTenant(() => roles.documentBelongsToProject(doc['Protokoll.pdf'], projectId, reader))).toBe(true)
  })
})
