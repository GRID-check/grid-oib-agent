/**
 * @vitest-environment node
 *
 * „Ausmisten" against a REAL Postgres (ADR-0084), through the restricted role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/cleanup.integration.spec.ts
 *
 * What the database must show: a confirmed document lands in a subfolder of its
 * OWN folder that inherits its access (so its readers and its retrieval
 * collection are unchanged), that subfolder is in the Papierkorb, a restore
 * puts it back where it was, and a document the closer may not write is not
 * removed. A clean-out that fails halfway leaves the project as it was. WorkOS
 * and the backend are stubbed; the rows, the folder rule and the bin are real.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { restrictedCollectionName } from '@/lib/authz/folder-access-rule'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn(async () => new Map()) }))
vi.mock('@/lib/documents/collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/collection-file-ref')>()),
  purgeIngestedChunks: vi.fn(async () => true),
}))
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn(async (rows: unknown[]) => rows) }))
vi.mock('@/lib/documents/folder-path', () => ({ resolveDocumentFolderPath: vi.fn(async () => null) }))
vi.mock('@/lib/documents/service', () => ({
  dispatchDocument: vi.fn(async () => ({ jobId: 'job', status: 'pending' })),
  eraseProjectDocument: vi.fn(async () => true),
}))
vi.mock('@/lib/authz/projects', async () => {
  const { NotFoundError: NotFound } = await import('@/lib/api/errors')
  return {
    requireProjectAccess: vi.fn(async (session: { permissions: string[] }, _projectId: string, needed: string | readonly string[]) => {
      const wanted = typeof needed === 'string' ? [needed] : needed
      if (!wanted.some((permission) => session.permissions.includes(permission))) throw new NotFound()
      return { role: 'project-editor', closed: false, readsBecauseClosed: false }
    }),
  }
})
vi.mock('@/lib/auth/membership-roles', () => ({ resolveMembershipRoles: vi.fn(async () => null) }))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_cleanup_${STAMP}`
const USER = 'user_gf'
const COLLECTION = `proj_cleanup_${STAMP}`
const GF = 'org-gf'
const PROJECT_WRITE = ['project:view', 'project:documents:write', 'project:edit']

const sessionOf = (userId: string, roles: string[]): AuthorizedSession =>
  ({ userId, organizationId: ORG, email: `${userId}@grid.test`, role: 'member', roles, permissions: PROJECT_WRITE }) as unknown as AuthorizedSession
const gf = sessionOf('user_gf', [GF])
const member = sessionOf('user_member', ['member'])

describe.skipIf(!url)('Ausmisten against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let cleanup: typeof import('./cleanup-service')
  let bin: typeof import('./folder-bin')
  let access: typeof import('@/lib/authz/folder-access')
  let projectId: string
  const folder: Record<string, string> = {}
  const doc: Record<string, string> = {}

  const inOrg = <T>(run: () => PromiseLike<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run) as Promise<T>
  const one = <T>(rows: Iterable<T>): T => Array.from(rows)[0] as T

  async function insertFolder(name: string, grants: Array<[string, 'read' | 'write']> | null): Promise<string> {
    const rows = await inOrg(() =>
      db.execute<{ id: string }>(sql`
        WITH folder AS (
          INSERT INTO project_folders (organization_id, project_id, parent_id, name, path, access_mode, access_changed_by, access_changed_at)
          VALUES (${ORG}, ${projectId}::uuid, NULL, ${name}, ${name}, ${grants ? 'custom' : 'inherit'},
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
    return one(rows).id
  }

  async function insertDocument(filename: string, folderId: string | null, collection: string): Promise<string> {
    const rows = await inOrg(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
        VALUES (${ORG}, ${USER}, ${filename}, ${`k/${STAMP}/${filename}`}, ${collection}, 'completed', 'project', ${projectId}::uuid, ${folderId}::uuid)
        RETURNING id
      `)
    )
    return one(rows).id
  }

  const documentRow = (id: string) =>
    inOrg(() =>
      db.execute<{ folder_id: string; collection_name: string }>(sql`SELECT folder_id, collection_name FROM documents WHERE id = ${id}::uuid`)
    ).then(one)
  const folderRow = (id: string) =>
    inOrg(() =>
      db.execute<{ parent_id: string | null; access_mode: string; deleted_at: string | null; name: string }>(
        sql`SELECT parent_id, access_mode, deleted_at, name FROM project_folders WHERE id = ${id}::uuid`
      )
    ).then(one)

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    cleanup = await import('./cleanup-service')
    bin = await import('./folder-bin')
    access = await import('@/lib/authz/folder-access')
    projectId = one(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Seestadt D12', ${USER}, ${COLLECTION}) RETURNING id
        `)
      )
    ).id
    folder.vertraege = await insertFolder('Verträge', [[GF, 'write']])
    folder.plaene = await insertFolder('Pläne', null)
    doc.werkvertragAlt = await insertDocument('Werkvertrag_alt.pdf', folder.vertraege, restrictedCollectionName(COLLECTION, folder.vertraege))
    doc.planV1 = await insertDocument('Grundriss_v1.pdf', folder.plaene, COLLECTION)
    doc.planV2 = await insertDocument('Grundriss_v2.pdf', folder.plaene, COLLECTION)
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await inOrg(() => db.execute(sql`DELETE FROM deletion_queue WHERE organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('does not let someone remove what they may not write, and removes nothing at all then', async () => {
    await expect(
      inOrg(() => cleanup.confirmCleanup(member, projectId, { documentIds: [doc.werkvertragAlt, doc.planV1], proposedIds: [], aiUsed: false }))
    ).rejects.toMatchObject({ details: { reason: 'not-writable' } })
    expect((await documentRow(doc.planV1)).folder_id).toBe(folder.plaene)
  })

  it('moves each document into an inheriting subfolder of its own folder, and puts that in the Papierkorb', async () => {
    const result = await inOrg(() =>
      cleanup.confirmCleanup(gf, projectId, {
        documentIds: [doc.werkvertragAlt, doc.planV1],
        proposedIds: [doc.werkvertragAlt, doc.planV1],
        aiUsed: true,
      })
    )
    expect(result).toEqual({ removed: 2, binEntries: 2 })

    const contract = await documentRow(doc.werkvertragAlt)
    const holder = await folderRow(contract.folder_id)
    expect(holder).toMatchObject({ parent_id: folder.vertraege, access_mode: 'inherit' })
    expect(holder.name).toMatch(/^Ausgemistet /)
    expect(holder.deleted_at).not.toBeNull()
    // Same readers, same collection: the restricted one of Verträge, never the open project collection.
    expect(contract.collection_name).toBe(restrictedCollectionName(COLLECTION, folder.vertraege))
    expect((await folderRow((await documentRow(doc.planV1)).folder_id)).parent_id).toBe(folder.plaene)

    // In the bin, hidden from everyone, the closer included; the newest version stays.
    expect((await inOrg(() => access.getProjectFolderAccess(gf, projectId, COLLECTION))).isVisible(contract.folder_id)).toBe(false)
    expect((await documentRow(doc.planV2)).folder_id).toBe(folder.plaene)

    // A restore puts it back inside Verträge, where only Geschäftsführung reads it.
    await inOrg(() => bin.restoreFolderFromBin(gf, { projectId, folderId: contract.folder_id }))
    expect(await folderRow(contract.folder_id)).toMatchObject({ parent_id: folder.vertraege, deleted_at: null })
    expect((await inOrg(() => access.getProjectFolderAccess(member, projectId, COLLECTION))).isVisible(contract.folder_id)).toBe(false)
    expect((await inOrg(() => access.getProjectFolderAccess(gf, projectId, COLLECTION))).isVisible(contract.folder_id)).toBe(true)
  })

  it('undoes everything when the second folder cannot go to the bin (the index does not confirm)', async () => {
    const { purgeIngestedChunks } = await import('@/lib/documents/collection-file-ref')
    const plan = await insertDocument('Lageplan_alt.pdf', folder.plaene, COLLECTION)
    const contract = await insertDocument('Nachtrag_Entwurf.pdf', folder.vertraege, restrictedCollectionName(COLLECTION, folder.vertraege))
    const folderCount = async () =>
      Number(one(await inOrg(() => db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM project_folders WHERE project_id = ${projectId}::uuid`))).n)
    const binCount = async () =>
      Number(one(await inOrg(() => db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM deletion_queue WHERE organization_id = ${ORG} AND status = 'pending'`))).n)
    const [foldersBefore, binBefore] = [await folderCount(), await binCount()]
    // Pläne's subfolder goes to the bin; Verträge's purge is not confirmed.
    vi.mocked(purgeIngestedChunks).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(
      inOrg(() => cleanup.confirmCleanup(gf, projectId, { documentIds: [plan, contract], proposedIds: [], aiUsed: true }))
    ).rejects.toMatchObject({ status: 502 })

    // Every document where it was, in the collection it was in; no subfolder, no bin entry left.
    expect(await documentRow(plan)).toMatchObject({ folder_id: folder.plaene, collection_name: COLLECTION })
    expect(await documentRow(contract)).toMatchObject({
      folder_id: folder.vertraege,
      collection_name: restrictedCollectionName(COLLECTION, folder.vertraege),
    })
    expect(await folderCount()).toBe(foldersBefore)
    expect(await binCount()).toBe(binBefore)
    const visible = await inOrg(() => access.getProjectFolderAccess(gf, projectId, COLLECTION))
    expect(visible.isVisible(folder.plaene) && visible.isVisible(folder.vertraege)).toBe(true)
  })

  it('never bins a file someone else filed into the subfolder: the bin checks its contents under its lock', async () => {
    const holder = await insertFolder(`Ausgemistet probe ${STAMP}`, null)
    const ours = await insertDocument('Skizze_alt.pdf', holder, COLLECTION)
    const theirs = await insertDocument('Protokoll_neu.pdf', holder, COLLECTION)

    await expect(
      inOrg(() => bin.moveFolderToBin(gf, { projectId, folderId: holder }, undefined, { onlyDocuments: [ours] }))
    ).rejects.toMatchObject({ status: 409, details: { reason: bin.FOLDER_CONTENTS_CHANGED_REASON } })
    expect((await folderRow(holder)).deleted_at).toBeNull()
    expect((await documentRow(theirs)).folder_id).toBe(holder)

    const binned = await inOrg(() => bin.moveFolderToBin(gf, { projectId, folderId: holder }, undefined, { onlyDocuments: [ours, theirs] }))
    expect(binned.documentsBinned).toBe(2)
  })

  it('makes no proposal and removes nothing in a project the session cannot write', async () => {
    const reader = { ...gf, permissions: ['project:view'] } as AuthorizedSession
    await expect(inOrg(() => cleanup.proposeCleanup(reader, projectId, 'de'))).rejects.toBeInstanceOf(NotFoundError)
  })
})
