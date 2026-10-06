/**
 * @vitest-environment node
 *
 * The Papierkorb against a REAL Postgres (migration 0113, ADR-0081), through
 * the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/folder-bin.integration.spec.ts
 *
 * Every rule here is a claim about SQL: which rows a listing leaves out, what
 * the triggers refuse, what the hold predicate covers, which answers the
 * derived-content search finds, what the setting does at read time. The
 * backend (chunk purge, ingest) and the document's object-store steps are
 * stubbed; the rows are real.
 *
 *   Lageplan.pdf                  (project root)
 *   Verwaltung/                   inherits                Protokoll.pdf
 *     Verträge/                   org-gf: write, org-bh: read   Vertrag.pdf
 *       Alt/                      inherits                Alt.pdf
 *   Pläne/                        inherits                Plan.pdf
 *     Archiv/                     inherits                Archiv.pdf
 */

import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { restrictedCollectionName } from '@/lib/authz/folder-access-rule'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn(async () => new Map()) }))
vi.mock('@/lib/documents/collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/collection-file-ref')>()),
  purgeIngestedChunks: vi.fn(async () => true),
}))
// The document's own erasure is the document delete's (its specs cover the
// object store); here it deletes the row, through the hold trigger.
vi.mock('@/lib/documents/folder-path', () => ({ resolveDocumentFolderPath: vi.fn(async () => null) }))
vi.mock('@/lib/documents/service', () => ({
  dispatchDocument: vi.fn(async () => ({ jobId: 'job', status: 'pending' })),
  eraseProjectDocument: vi.fn(async (doc: { id: string; organizationId: string; projectId: string }) => {
    const { deleteProjectDocument } = await import('@/lib/documents/repository')
    await deleteProjectDocument(doc.id, doc.organizationId, doc.projectId)
    return true
  }),
}))
// Project permissions are WorkOS's; each session here states which it holds,
// and a denial is the real one's: not found.
vi.mock('@/lib/authz/projects', async () => {
  const { NotFoundError } = await import('@/lib/api/errors')
  return {
    requireProjectAccess: vi.fn(async (session: { permissions: string[] }, _projectId: string, needed: string | readonly string[]) => {
      const wanted = Array.isArray(needed) ? needed : [needed]
      if (session.permissions.includes('org:projects:administer')) return { role: 'project-admin' }
      if (!wanted.some((permission) => session.permissions.includes(permission))) throw new NotFoundError()
      return { role: session.permissions.includes('project:manage') ? 'project-admin' : 'project-editor' }
    }),
  }
})
vi.mock('@/lib/auth/membership-roles', () => ({ resolveMembershipRoles: vi.fn(async () => null) }))
// The real Langfuse client, with a fetch that reads the CURRENT global, so a
// test can stand in for Langfuse after the client was created.
vi.mock('../../../workers/langfuse-traces', async (importOriginal) => {
  const actual = await importOriginal<{
    createConversationTraceEraser: (options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }) => unknown
  }>()
  return {
    ...actual,
    createConversationTraceEraser: (options: { env?: NodeJS.ProcessEnv }) =>
      actual.createConversationTraceEraser({ ...options, fetchImpl: (input, init) => globalThis.fetch(input, init) }),
  }
})

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_bin_${STAMP}`
const USER = `user_bin_${STAMP}`
const COLLECTION = `proj_bin_${STAMP}`
const CHAT = `s_bin_chat_${STAMP}`
const GF = 'org-gf'
const BH = 'org-bh'
const PL = 'org-pl'
const PROJECT_WRITE = ['project:view', 'project:documents:write', 'project:edit']

/** One documented boundary: a session fixture carries only what these services read. */
const sessionOf = (userId: string, roles: string[], permissions: string[]): AuthorizedSession =>
  ({ userId, organizationId: ORG, email: `${userId}@grid.test`, role: 'member', roles, permissions }) as unknown as AuthorizedSession

const gf = sessionOf('user_gf', [GF], PROJECT_WRITE)
const bh = sessionOf('user_bh', [BH], PROJECT_WRITE)
const pl = sessionOf('user_pl', [PL], PROJECT_WRITE)
const manager = sessionOf('user_mgr', [GF], [...PROJECT_WRITE, 'project:manage'])
const admin = sessionOf('user_admin', [], ['org:projects:administer'])

class Rollback extends Error {}

describe.skipIf(!url)('the Papierkorb against live Postgres (migration 0113)', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let bin: typeof import('./folder-bin')
  let access: typeof import('@/lib/authz/folder-access')
  let docsRepo: typeof import('@/lib/documents/repository')
  let folders: typeof import('./folder-service')
  let restrictedUse: typeof import('@/lib/conversations/restricted-use')
  let setting: typeof import('@/lib/organizations/deleted-folder-content-service')
  let collectionRef: typeof import('@/lib/documents/collection-file-ref')
  let documentService: typeof import('@/lib/documents/service')
  let projectId: string
  const folder: Record<string, string> = {}
  const doc: Record<string, string> = {}
  const message: Record<string, string> = {}
  const memory: Record<string, string> = {}

  const inOrg = <T>(run: () => PromiseLike<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run) as Promise<T>
  /**
   * A module whose functions run in the organization's tenant scope, as a
   * request's would (`getGridSession` opens it there).
   */
  function inTenant<M extends object>(module: M): M {
    return new Proxy(module, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => inOrg(async () => (value as (...input: unknown[]) => unknown)(...args))
      },
    })
  }
  const ids = (rows: Iterable<{ id: string }>): string[] => Array.from(rows).map((row) => String(row.id))

  async function insertFolder(name: string, parentId: string | null, path: string, grants: Array<[string, 'read' | 'write']> | null): Promise<string> {
    const roles = (grants ?? []).map(([role]) => role)
    const levels = (grants ?? []).map(([, level]) => level)
    const [id] = ids(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          WITH folder AS (
            INSERT INTO project_folders (organization_id, project_id, parent_id, name, path, access_mode, access_changed_by, access_changed_at)
            VALUES (${ORG}, ${projectId}::uuid, ${parentId}::uuid, ${name}, ${path}, ${grants ? 'custom' : 'inherit'},
                    ${grants ? USER : null}, ${grants ? new Date().toISOString() : null}::timestamptz)
            RETURNING id, project_id
          ), listed AS (
            INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            SELECT ${ORG}, folder.project_id, folder.id, g.role, g.level
            FROM folder, unnest(${`{${roles.join(',')}}`}::text[], ${`{${levels.join(',')}}`}::text[]) AS g(role, level)
          )
          SELECT id FROM folder
        `)
      )
    )
    return id
  }

  async function insertDocument(filename: string, folderId: string | null, collection = COLLECTION, createdBy = USER): Promise<string> {
    const [id] = ids(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
          VALUES (${ORG}, ${createdBy}, ${filename}, ${`k/${filename}`}, ${collection}, 'completed', 'project', ${projectId}::uuid, ${folderId}::uuid)
          RETURNING id
        `)
      )
    )
    return id
  }

  async function insertAnswer(content: string, sources: Array<Record<string, string>>): Promise<string> {
    const metadata = JSON.stringify({ citations: { v: 1, sources }, provenance: { answerConfidence: 'high' } })
    const [id] = ids(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO messages (conversation_id, organization_id, role, content, metadata)
          VALUES (${CHAT}, ${ORG}, 'assistant', ${content}, ${metadata}::jsonb)
          RETURNING id
        `)
      )
    )
    return id
  }

  async function insertNote(content: string, restricted: string[] | null, sourceConversation: string | null): Promise<string> {
    const [id] = ids(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids, source_conversation_id)
          VALUES ('project', ${projectId}::uuid, ${ORG}, 'decision', ${content},
                  ${restricted ? `{${restricted.join(',')}}` : null}::uuid[], ${sourceConversation})
          RETURNING id
        `)
      )
    )
    return id
  }

  async function folderState(folderId: string) {
    const [row] = await inOrg(() =>
      db.execute<{ deleted_at: string | null; purged_at: string | null; bin_root_id: string | null; parent_id: string | null; path: string }>(
        sql`SELECT deleted_at, purged_at, bin_root_id, parent_id, path FROM project_folders WHERE id = ${folderId}::uuid`
      )
    )
    return row
  }

  async function queueRow(folderId: string) {
    const rows = await withPlatformAccess('test: read the folder queue', () =>
      db.execute<{ status: string; payload: Record<string, unknown>; requested_by: string; purge_after: string }>(sql`
        SELECT status, payload, requested_by, purge_after FROM deletion_queue
        WHERE entity_type = 'folder' AND entity_id = ${folderId} ORDER BY requested_at DESC`)
    )
    return Array.from(rows)
  }

  async function visibleDocumentNames(session: AuthorizedSession): Promise<string[]> {
    const hidden = await access.getHiddenFolderIds(session, projectId)
    const rows = await inOrg(() => docsRepo.listProjectDocuments(projectId, ORG, { hiddenFolderIds: hidden }))
    return rows.map((row) => row.filename).sort()
  }

  async function hold(entityType: string, entityId: string): Promise<void> {
    await inOrg(() =>
      db.execute(sql`
        INSERT INTO legal_holds (entity_type, entity_id, organization_id, reason, created_by)
        VALUES (${entityType}, ${entityId}, ${ORG}, 'integration test', ${USER})`)
    )
  }

  async function releaseHolds(): Promise<void> {
    await inOrg(() => db.execute(sql`UPDATE legal_holds SET released_at = now() WHERE organization_id = ${ORG} AND released_at IS NULL`))
  }

  /** The purger's claim, run and rolled back: what it would take right now. */
  async function claimable(): Promise<string[]> {
    const { claimNext } = await import('../../../purger/db.js')
    const client = postgres(url as string, { prepare: false, max: 1 })
    const claimed: string[] = []
    try {
      await client.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE grid_app_platform')
        for (let i = 0; i < 1000; i += 1) {
          const entry = await claimNext(tx as never)
          if (!entry) break
          claimed.push(entry.entity_id)
        }
        throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) throw error
    } finally {
      await client.end()
    }
    return claimed
  }

  async function makeDue(folderId: string): Promise<void> {
    await withPlatformAccess('test: make the bin entry due', () =>
      db.execute(sql`UPDATE deletion_queue SET purge_after = now() - interval '1 minute'
                     WHERE entity_type = 'folder' AND entity_id = ${folderId} AND status = 'pending'`)
    )
  }

  async function seed(): Promise<void> {
    folder.verwaltung = await insertFolder('Verwaltung', null, 'Verwaltung', null)
    folder.vertraege = await insertFolder('Verträge', folder.verwaltung, 'Verwaltung/Verträge', [
      [GF, 'write'],
      [BH, 'read'],
    ])
    folder.alt = await insertFolder('Alt', folder.vertraege, 'Verwaltung/Verträge/Alt', null)
    folder.plaene = await insertFolder('Pläne', null, 'Pläne', null)
    folder.archiv = await insertFolder('Archiv', folder.plaene, 'Pläne/Archiv', null)
    const restricted = restrictedCollectionName(COLLECTION, folder.vertraege)
    doc.lageplan = await insertDocument('Lageplan.pdf', null)
    doc.protokoll = await insertDocument('Protokoll.pdf', folder.verwaltung)
    doc.vertrag = await insertDocument('Vertrag.pdf', folder.vertraege, restricted, 'user_custodian')
    doc.alt = await insertDocument('Alt.pdf', folder.alt, restricted)
    doc.plan = await insertDocument('Plan.pdf', folder.plaene)
    doc.archiv = await insertDocument('Archiv.pdf', folder.archiv)
  }

  async function wipe(): Promise<void> {
    await releaseHolds()
    await withPlatformAccess('test: clean up', async () => {
      await db.execute(sql`DELETE FROM deletion_queue WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM project_memory WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM messages WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM conversation_restricted_folders WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM resource_shares WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM conversations WHERE organization_id = ${ORG} AND id <> ${CHAT}`)
      await db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`)
      // The grants go with their folders (ON DELETE CASCADE); deleting them
      // first would leave a custom list empty, which 0110 refuses.
      await db.execute(sql`DELETE FROM project_folders WHERE project_id = ${projectId}::uuid`)
      await db.execute(sql`DELETE FROM legal_holds WHERE organization_id = ${ORG}`)
    })
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    bin = inTenant(await import('./folder-bin'))
    access = inTenant(await import('@/lib/authz/folder-access'))
    docsRepo = inTenant(await import('@/lib/documents/repository'))
    folders = inTenant(await import('./folder-service'))
    restrictedUse = inTenant(await import('@/lib/conversations/restricted-use'))
    setting = inTenant(await import('@/lib/organizations/deleted-folder-content-service'))
    collectionRef = await import('@/lib/documents/collection-file-ref')
    documentService = await import('@/lib/documents/service')

    await withPlatformAccess('test seed: organization', () =>
      db.execute(sql`INSERT INTO organizations (workos_organization_id, display_name) VALUES (${ORG}, ${ORG}) ON CONFLICT DO NOTHING`)
    )
    const [id] = ids(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Papierkorb', ${USER}, ${COLLECTION}) RETURNING id`)
      )
    )
    projectId = id
    await inOrg(() =>
      db.execute(sql`INSERT INTO conversations (id, organization_id, created_by, project_id, title)
                     VALUES (${CHAT}, ${ORG}, ${USER}, ${projectId}::uuid, 'Pläne')`)
    )
  })

  beforeEach(async () => {
    await wipe()
    await seed()
    await setting.saveDeletedFolderContentPolicy(admin, 'unchanged', new Request('http://test'))
    vi.mocked(collectionRef.purgeIngestedChunks).mockReset()
    vi.mocked(collectionRef.purgeIngestedChunks).mockResolvedValue(true)
    vi.mocked(documentService.dispatchDocument).mockClear()
  })

  afterAll(async () => {
    await wipe()
    await withPlatformAccess('test: clean up project', async () => {
      await db.execute(sql`DELETE FROM conversations WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM organizations WHERE workos_organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('deleting a folder puts it, its subfolders and their documents in the bin', () => {
    it('hides them from every listing, every document read and the agent, for everyone, admins included', async () => {
      const result = await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      expect(result).toMatchObject({ documentsBinned: 2, foldersBinned: 2 })

      for (const session of [pl, gf, admin]) {
        expect((await folders.listProjectFolders(projectId, session)).map((row) => row.name)).not.toContain('Pläne')
        expect((await folders.listProjectFolders(projectId, session)).map((row) => row.name)).not.toContain('Archiv')
        expect(await visibleDocumentNames(session)).not.toContain('Plan.pdf')
        expect(await visibleDocumentNames(session)).not.toContain('Archiv.pdf')
        // `getAccessibleDocument` asks exactly this for a document by id.
        expect(await access.isFolderVisibleTo(session, projectId, folder.archiv)).toBe(false)
      }
      // The agent's service-token routes hide what no session may read.
      expect(await access.getRestrictedFolderIds(ORG, projectId)).toEqual(expect.arrayContaining([folder.plaene, folder.archiv]))
      // Everything else is where it was.
      expect(await visibleDocumentNames(pl)).toEqual(['Lageplan.pdf', 'Protokoll.pdf'])
    })

    it('hides them in a project where no folder has its own list, too (the probe finds the bin)', async () => {
      await inOrg(() =>
        db.execute(sql`UPDATE project_folders SET access_mode = 'inherit', access_changed_by = NULL, access_changed_at = NULL
                       WHERE project_id = ${projectId}::uuid`)
      )
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      expect(await visibleDocumentNames(pl)).toEqual(['Alt.pdf', 'Lageplan.pdf', 'Protokoll.pdf', 'Vertrag.pdf'])
      expect(await access.isFolderVisibleTo(pl, projectId, folder.plaene)).toBe(false)
    })

    it('takes their chunks out of retrieval in the same request, and an ingest still running is told the document is gone', async () => {
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      const purged = vi.mocked(collectionRef.purgeIngestedChunks).mock.calls.map(([, ref]) => ref.filename).sort()
      expect(purged).toEqual(['Archiv.pdf', 'Plan.pdf'])
      expect(await docsRepo.documentExistsInCollection(doc.plan, COLLECTION, ORG)).toBe(false)
      expect(await docsRepo.documentExistsInCollection(doc.lageplan, COLLECTION, ORG)).toBe(true)
    })

    it('is undone and refused when the index does not confirm, so it is never in the bin while searchable', async () => {
      vi.mocked(collectionRef.purgeIngestedChunks).mockImplementation(async (_backend, ref) => ref.filename !== 'Archiv.pdf')
      await expect(bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })).rejects.toMatchObject({ status: 502 })
      expect((await folderState(folder.plaene))?.deleted_at).toBeNull()
      expect((await folderState(folder.archiv))?.deleted_at).toBeNull()
      expect(await visibleDocumentNames(pl)).toContain('Plan.pdf')
      expect((await queueRow(folder.plaene))[0]?.status).toBe('restored')
      // The one whose chunks did go is read again.
      expect(vi.mocked(documentService.dispatchDocument).mock.calls.map(([input]) => input.filename)).toEqual(['Plan.pdf'])
    })

    it('is never placed back into a collection while it is in the bin', async () => {
      await bin.moveFolderToBin(gf, { projectId, folderId: folder.vertraege })
      vi.mocked(collectionRef.purgeIngestedChunks).mockClear()
      const placement = inTenant(await import('./collection-placement'))
      await expect(placement.placeProjectDocuments(ORG, projectId)).resolves.toMatchObject({ moved: 0, failed: [] })
      expect(documentService.dispatchDocument).not.toHaveBeenCalled()
      expect(collectionRef.purgeIngestedChunks).not.toHaveBeenCalled()
    })

    it('queues the purge for FOLDER_PURGE_GRACE_DAYS later, and the purger does not take it before', async () => {
      const before = Date.now()
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      const [row] = await queueRow(folder.plaene)
      expect(row.status).toBe('pending')
      expect(row.requested_by).toBe('user_pl')
      expect(new Date(row.purge_after).getTime()).toBeGreaterThanOrEqual(before + 14 * 86_400_000 - 5_000)
      expect(await claimable()).not.toContain(folder.plaene)
      await makeDue(folder.plaene)
      expect(await claimable()).toContain(folder.plaene)
    })
  })

  describe('who may delete what (a subtree the person cannot fully write is refused without naming it)', () => {
    it('refuses a folder holding a subfolder the person may not read, generically, and bins nothing', async () => {
      const refusal = await bin.moveFolderToBin(pl, { projectId, folderId: folder.verwaltung }).catch((error) => error)
      expect(refusal).toMatchObject({ status: 403, details: { reason: bin.FOLDER_CONTENTS_PROTECTED_REASON } })
      expect(String(refusal.message)).not.toMatch(/Vertr|Alt/)
      expect((await folderState(folder.verwaltung))?.deleted_at).toBeNull()
      expect(await queueRow(folder.verwaltung)).toEqual([])
    })

    it('gives the same refusal for a subfolder the person may only read', async () => {
      await expect(bin.moveFolderToBin(bh, { projectId, folderId: folder.verwaltung })).rejects.toMatchObject({
        status: 403,
        details: { reason: bin.FOLDER_CONTENTS_PROTECTED_REASON },
      })
    })

    it('answers a folder the person may only read as read-only, and one they may not read as not found', async () => {
      await expect(bin.moveFolderToBin(bh, { projectId, folderId: folder.vertraege })).rejects.toMatchObject({
        status: 403,
        details: { reason: 'folder-read-only' },
      })
      await expect(bin.moveFolderToBin(pl, { projectId, folderId: folder.vertraege })).rejects.toMatchObject({ status: 404 })
    })

    it('lets someone who writes the whole subtree delete it, restricted parts included', async () => {
      await expect(bin.moveFolderToBin(gf, { projectId, folderId: folder.verwaltung })).resolves.toMatchObject({
        documentsBinned: 3,
        foldersBinned: 3,
      })
    })
  })

  describe('nothing lands in a deleted folder (the triggers, migration 0113)', () => {
    it('refuses an upload, a move and a new subfolder into a folder in the bin', async () => {
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      await expect(insertDocument('Neu.pdf', folder.archiv)).rejects.toMatchObject({ cause: { code: 'GFD01' } })
      await expect(
        inOrg(() => db.execute(sql`UPDATE documents SET folder_id = ${folder.plaene}::uuid WHERE id = ${doc.lageplan}::uuid`))
      ).rejects.toMatchObject({ cause: { code: 'GFD01' } })
      await expect(insertFolder('Neu', folder.plaene, 'Pläne/Neu', null)).rejects.toMatchObject({ cause: { code: 'GFD01' } })
    })

    it('makes an upload that started before the delete finish first, and the delete takes it along', async () => {
      let release = (): void => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let insertedId = ''
      const upload = inOrg(() =>
        db.transaction(async (tx) => {
          const rows = await tx.execute<{ id: string }>(sql`
            INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
            VALUES (${ORG}, ${USER}, 'Spät.pdf', 'k/spaet', ${COLLECTION}, 'completed', 'project', ${projectId}::uuid, ${folder.archiv}::uuid)
            RETURNING id`)
          insertedId = ids(rows)[0]
          await gate
        })
      )
      // Let the upload take its share of the bin lock before the delete asks.
      await new Promise((resolve) => setTimeout(resolve, 100))
      const deleting = bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      await new Promise((resolve) => setTimeout(resolve, 200))
      release()
      await upload
      await expect(deleting).resolves.toMatchObject({ documentsBinned: 3 })
      expect(vi.mocked(collectionRef.purgeIngestedChunks).mock.calls.map(([, ref]) => ref.filename)).toContain('Spät.pdf')
      expect(await access.isFolderVisibleTo(pl, projectId, folder.archiv)).toBe(false)
      expect(insertedId).not.toBe('')
    })
  })

  describe('restoring', () => {
    it('brings the folder back with exactly the access it had, and reads its documents into the right collections', async () => {
      const before = await Promise.all([gf, bh, pl].map((session) => visibleDocumentNames(session)))
      await bin.moveFolderToBin(gf, { projectId, folderId: folder.verwaltung })
      expect(await visibleDocumentNames(bh)).toEqual(['Archiv.pdf', 'Lageplan.pdf', 'Plan.pdf'])

      const restored = await bin.restoreFolderFromBin(gf, { projectId, folderId: folder.verwaltung })
      expect(restored).toMatchObject({ restoredTo: 'original', folders: 3, documents: 3 })
      expect(await Promise.all([gf, bh, pl].map((session) => visibleDocumentNames(session)))).toEqual(before)
      expect(await access.getHiddenFolderIds(pl, projectId)).toEqual(expect.arrayContaining([folder.vertraege, folder.alt]))
      expect(await access.canWriteFolder(bh, projectId, folder.vertraege)).toBe(false)
      expect(await access.canWriteFolder(gf, projectId, folder.vertraege)).toBe(true)
      const dispatched = new Map(
        vi.mocked(documentService.dispatchDocument).mock.calls.map(([input]) => [input.filename, input.collectionName])
      )
      expect(dispatched.get('Vertrag.pdf')).toBe(restrictedCollectionName(COLLECTION, folder.vertraege))
      expect(dispatched.get('Protokoll.pdf')).toBe(COLLECTION)
      expect((await queueRow(folder.verwaltung))[0]?.status).toBe('restored')
    })

    it('needs write on the deleted folder: a reader sees the entry but may not restore it', async () => {
      await bin.moveFolderToBin(gf, { projectId, folderId: folder.vertraege })
      const listing = await bin.listFolderBin(bh, projectId)
      expect(listing.entries.map((entry) => [entry.name, entry.canRestore])).toEqual([['Verträge', false]])
      await expect(bin.restoreFolderFromBin(bh, { projectId, folderId: folder.vertraege })).rejects.toMatchObject({ status: 403 })
      // Someone who could not read it does not see it in the bin at all.
      expect((await bin.listFolderBin(pl, projectId)).entries).toEqual([])
      await expect(bin.restoreFolderFromBin(pl, { projectId, folderId: folder.vertraege })).rejects.toMatchObject({ status: 404 })
    })

    it('restores to the project root, and says so, when the parent is gone', async () => {
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.archiv })
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      const restored = await bin.restoreFolderFromBin(pl, { projectId, folderId: folder.archiv })
      expect(restored.restoredTo).toBe('root')
      expect(await folderState(folder.archiv)).toMatchObject({ deleted_at: null, parent_id: null, path: 'Archiv' })
      expect(await visibleDocumentNames(pl)).toContain('Archiv.pdf')
    })

    it('refuses while a living sibling holds the name, and changes nothing', async () => {
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      await insertFolder('Pläne', null, 'Pläne', null)
      await expect(bin.restoreFolderFromBin(pl, { projectId, folderId: folder.plaene })).rejects.toMatchObject({
        status: 409,
        details: { reason: bin.FOLDER_NAME_TAKEN_REASON },
      })
      expect((await folderState(folder.plaene))?.deleted_at).not.toBeNull()
      expect((await queueRow(folder.plaene))[0]?.status).toBe('pending')
    })
  })

  describe('the project shelf: the delete is the bin, and a binned folder is no folder of the shelf', () => {
    it('deleteProjectFolder moves the folder to the bin with its contents instead of re-filing them into the parent', async () => {
      const result = await folders.deleteProjectFolder({ projectId, folderId: folder.archiv }, pl)
      expect(result).toMatchObject({ documentsBinned: 1, foldersBinned: 1 })
      expect(await folderState(folder.archiv)).toMatchObject({ bin_root_id: folder.archiv })
      expect((await folderState(folder.archiv))?.deleted_at).not.toBeNull()
      // Archiv.pdf stayed in its folder (into the bin), not in Pläne.
      const [row] = await inOrg(() =>
        db.execute<{ folder_id: string }>(sql`SELECT folder_id FROM documents WHERE id = ${doc.archiv}::uuid`)
      )
      expect(String(row.folder_id)).toBe(folder.archiv)
      expect(await visibleDocumentNames(pl)).not.toContain('Archiv.pdf')
      expect((await queueRow(folder.archiv))[0]?.status).toBe('pending')
    })

    it('frees the name: a folder upload of the same path creates a new folder rather than matching the binned one', async () => {
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      const ensured = await folders.ensureProjectFolderPaths({ projectId, parentId: null, paths: ['Pläne/Archiv'] }, pl)
      expect(ensured.ok).toBe(true)
      const created = ensured.ok ? ensured.folderIdByPath['Pläne/Archiv'] : ''
      expect([folder.plaene, folder.archiv]).not.toContain(created)
      expect((await folders.listProjectFolders(projectId, pl)).map((row) => row.path).sort()).toEqual([
        'Pläne',
        'Pläne/Archiv',
        'Verwaltung',
      ])
    })

    it('answers a binned folder as missing to a rename, a move into it and a new subfolder', async () => {
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      await expect(folders.updateProjectFolder({ projectId, folderId: folder.plaene, name: 'Neu' }, pl)).resolves.toEqual({
        ok: false,
        error: 'Folder not found.',
      })
      await expect(
        folders.updateProjectFolder({ projectId, folderId: folder.verwaltung, parentId: folder.plaene }, gf)
      ).rejects.toMatchObject({ status: 404 })
      await expect(folders.createProjectFolder({ projectId, parentId: folder.archiv, name: 'Neu' }, pl)).rejects.toMatchObject({
        status: 404,
      })
    })
  })

  describe('a binned document is not handed to anyone (the download log’s readers all ask the folder rule first)', () => {
    it('refuses every reader, admins included, and a capability URL’s re-check, as not found', async () => {
      const documents = inTenant(await import('@/lib/documents/access'))
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      for (const session of [pl, gf, manager, admin]) {
        await expect(documents.getAccessibleDocument(session, doc.archiv)).rejects.toMatchObject({ status: 404 })
        await expect(documents.getAccessibleDocument(session, doc.plan, 'write')).rejects.toMatchObject({ status: 404 })
      }
      expect(await access.isFolderVisibleToMember(ORG, projectId, folder.archiv, 'user_admin')).toBe(false)
      // Restored, it is handed over again.
      await bin.restoreFolderFromBin(pl, { projectId, folderId: folder.plaene })
      await expect(documents.getAccessibleDocument(pl, doc.archiv)).resolves.toMatchObject({ id: doc.archiv })
    })
  })

  describe('a chat that drew on a purged folder: the setting and the read-time conversation lock are one rule', () => {
    /** A private chat of the GF, shared with BH, PL and the admin, whose answer cites Verträge. */
    async function chatOnVertraege(): Promise<string> {
      const id = `s_bin_lock_${STAMP}_${Math.random().toString(36).slice(2, 8)}`
      await inOrg(() =>
        db.execute(sql`INSERT INTO conversations (id, organization_id, created_by, project_id, title, visibility)
                       VALUES (${id}, ${ORG}, 'user_gf', ${projectId}::uuid, 'Honorar', 'private')`)
      )
      const { upsertGrant } = await import('@/lib/sharing/repository')
      for (const subject of ['user_bh', 'user_pl', 'user_admin']) {
        await inOrg(() =>
          upsertGrant({
            organizationId: ORG,
            resourceType: 'conversation',
            resourceId: id,
            subjectUserId: subject,
            role: 'viewer',
            grantedBy: 'user_gf',
          })
        )
      }
      const metadata = JSON.stringify({
        citations: { v: 1, sources: [{ collection: restrictedCollectionName(COLLECTION, folder.vertraege), file_name: 'Vertrag.pdf' }] },
      })
      await inOrg(() =>
        db.execute(sql`INSERT INTO messages (conversation_id, organization_id, role, content, metadata)
                       VALUES (${id}, ${ORG}, 'assistant', 'Laut Vertrag …', ${metadata}::jsonb)`)
      )
      return id
    }

    it.each([
      ['unchanged', { gf: false, bh: false, pl: true, admin: false }],
      ['project', { gf: false, bh: false, pl: false, admin: false }],
      ['admins', { gf: true, bh: true, pl: true, admin: false }],
      ['remove', { gf: true, bh: true, pl: true, admin: false }],
    ] as const)('%s: locked for exactly the people the folder rule leaves out', async (policy, expected) => {
      const sharing = inTenant(await import('@/lib/sharing/access'))
      const id = await chatOnVertraege()
      await bin.moveFolderToBin(gf, { projectId, folderId: folder.vertraege })
      await bin.purgeBinnedFolder(ORG, folder.vertraege)
      // The purge recorded the folder on the chat: from now on the rule judges it by it.
      expect(ids(await inOrg(() => db.execute<{ id: string }>(sql`
        SELECT folder_id AS id FROM conversation_restricted_folders WHERE conversation_id = ${id}`)))).toEqual([folder.vertraege])
      await setting.saveDeletedFolderContentPolicy(admin, policy, new Request('http://test'))

      const people = { gf: sessionOf('user_gf', [GF], PROJECT_WRITE), bh, pl, admin }
      const locked: Record<string, boolean> = {}
      for (const [name, session] of Object.entries(people)) {
        const answer = await sharing.resolveResourceAccess(session, 'conversation', id)
        expect(answer.role, name).not.toBeNull()
        locked[name] = answer.contentLocked
      }
      expect(locked).toEqual(expected)
      // A locked reader is refused the content with RESOURCE_RIGHTS_LOST; a readable one is not.
      const refused = (Object.keys(expected) as Array<keyof typeof expected>).find((name) => expected[name])
      if (refused) {
        await expect(sharing.requireResourceAccess(people[refused], 'conversation', id, 'viewer')).rejects.toMatchObject({
          code: 'RESOURCE_RIGHTS_LOST',
        })
      }
      await expect(sharing.requireResourceAccess(admin, 'conversation', id, 'viewer')).resolves.toBeDefined()
    })
  })

  describe('the purge', () => {
    it('erases the documents, keeps the folders as tombstones with their grants, and marks what was derived', async () => {
      const cites = await insertAnswer('Laut Plan.pdf ist …', [{ collection: COLLECTION, file_name: 'Plan.pdf', title: 'Plan' }])
      const other = await insertAnswer('Laut Lageplan.pdf …', [{ collection: COLLECTION, file_name: 'Lageplan.pdf' }])
      await bin.moveFolderToBin(gf, { projectId, folderId: folder.plaene })
      await makeDue(folder.plaene)

      const result = await bin.purgeBinnedFolder(ORG, folder.plaene)
      expect(result).toMatchObject({ status: 'purged', counts: { documents: 2, folders: 2, answers: 1, conversations: 1 } })
      expect(result.traceConversationIds).toEqual([])
      const remaining = await inOrg(() => db.execute<{ id: string }>(sql`SELECT id FROM documents WHERE organization_id = ${ORG}`))
      expect(ids(remaining)).not.toEqual(expect.arrayContaining([doc.plan]))
      expect(ids(remaining)).not.toContain(doc.archiv)
      expect((await folderState(folder.plaene))?.purged_at).not.toBeNull()
      expect((await folderState(folder.archiv))?.purged_at).not.toBeNull()
      const [marked] = await inOrg(() =>
        db.execute<{ metadata: Record<string, unknown>; content: string }>(sql`SELECT metadata, content FROM messages WHERE id = ${cites}::uuid`)
      )
      expect(marked.metadata.sourceDeleted).toMatchObject({ folderId: folder.plaene })
      expect(marked.content).toBe('Laut Plan.pdf ist …')
      const [untouched] = await inOrg(() =>
        db.execute<{ metadata: Record<string, unknown> }>(sql`SELECT metadata FROM messages WHERE id = ${other}::uuid`)
      )
      expect(untouched.metadata.sourceDeleted).toBeUndefined()
      expect(await restrictedUse.recordedRestrictedFolders(CHAT, ORG)).toEqual([])
    })

    it('keeps the grants of a purged restricted folder, which still decide who reads what came from it', async () => {
      await bin.moveFolderToBin(gf, { projectId, folderId: folder.vertraege })
      await makeDue(folder.vertraege)
      await bin.purgeBinnedFolder(ORG, folder.vertraege)
      const grants = await inOrg(() =>
        db.execute<{ role_slug: string }>(sql`SELECT role_slug FROM project_folder_grants WHERE folder_id = ${folder.vertraege}::uuid ORDER BY role_slug`)
      )
      expect(Array.from(grants).map((row) => row.role_slug)).toEqual([BH, GF])
      const clearance = { roles: [BH], seesEverything: false }
      expect(await access.readableFolderIdsFor(ORG, projectId, clearance)).toContain(folder.vertraege)
    })

    it('is idempotent: a second run finds it purged and does nothing', async () => {
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      await bin.purgeBinnedFolder(ORG, folder.plaene)
      await expect(bin.purgeBinnedFolder(ORG, folder.plaene)).resolves.toMatchObject({ status: 'already-purged' })
    })

    it('„Endgültig löschen" purges at once for a project admin and closes the record', async () => {
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      await expect(bin.purgeFolderFromBinNow(pl, { projectId, folderId: folder.plaene })).rejects.toMatchObject({ status: 404 })
      const result = await bin.purgeFolderFromBinNow(manager, { projectId, folderId: folder.plaene })
      expect(result.counts.documents).toBe(2)
      const [row] = await queueRow(folder.plaene)
      expect(row.status).toBe('purged')
      expect(row.payload.purged).toMatchObject({ documents: 2, folders: 2 })
    })
  })

  describe('a legal hold blocks the purge and the erasure', () => {
    it.each([
      ['the folder', () => ['folder', folder.vertraege]],
      ['a folder above it', () => ['folder', folder.verwaltung]],
      ['a document in it', () => ['document', doc.alt]],
      ['the project', () => ['project', projectId]],
      ['the custodian of a document in it', () => ['user', 'user_custodian']],
      ['the organization', () => ['organization', ORG]],
    ] as const)('covers a folder through a hold on %s', async (_label, target) => {
      const [entityType, entityId] = target()
      await hold(entityType, entityId)
      const [covered] = await inOrg(() =>
        db.execute<{ held: boolean }>(sql`SELECT grid_legal_hold_blocks('folder', ${folder.vertraege}, ${ORG}) AS held`)
      )
      expect(covered.held).toBe(true)
    })

    it('does not cover a folder for a hold elsewhere in the project', async () => {
      await hold('document', doc.plan)
      const [covered] = await inOrg(() =>
        db.execute<{ held: boolean }>(sql`SELECT grid_legal_hold_blocks('folder', ${folder.vertraege}, ${ORG}) AS held`)
      )
      expect(covered.held).toBe(false)
    })

    it('covers a document through a hold on a folder above it, and a project through a hold on one of its folders', async () => {
      await hold('folder', folder.verwaltung)
      const [document] = await inOrg(() =>
        db.execute<{ held: boolean }>(sql`SELECT grid_legal_hold_blocks('document', ${doc.alt}, ${ORG}) AS held`)
      )
      const [project] = await inOrg(() =>
        db.execute<{ held: boolean }>(sql`SELECT grid_legal_hold_blocks('project', ${projectId}, ${ORG}) AS held`)
      )
      expect([document.held, project.held]).toEqual([true, true])
    })

    it('keeps the purger from claiming, and refuses the purge and „Endgültig löschen" with 409', async () => {
      await bin.moveFolderToBin(gf, { projectId, folderId: folder.vertraege })
      await makeDue(folder.vertraege)
      await hold('document', doc.vertrag)
      expect(await claimable()).not.toContain(folder.vertraege)
      const held = { status: 409, details: { reason: 'legal_hold' } }
      await expect(bin.purgeBinnedFolder(ORG, folder.vertraege)).rejects.toMatchObject(held)
      await expect(bin.purgeFolderFromBinNow(sessionOf('user_mgr', [GF], [...PROJECT_WRITE, 'project:manage']), { projectId, folderId: folder.vertraege })).rejects.toMatchObject(held)
      const refusal = await bin.purgeBinnedFolder(ORG, folder.vertraege).catch((error) => error)
      expect(JSON.stringify(refusal.details)).not.toContain('integration test')
      const left = await inOrg(() => db.execute<{ id: string }>(sql`SELECT id FROM documents WHERE id = ${doc.vertrag}::uuid`))
      expect(ids(left)).toEqual([doc.vertrag])
      await releaseHolds()
      expect(await claimable()).toContain(folder.vertraege)
    })
  })

  describe('„Inhalte aus gelöschten Ordnern": applied when derived content is read', () => {
    async function purgeVertraege(): Promise<void> {
      await bin.moveFolderToBin(gf, { projectId, folderId: folder.vertraege })
      await bin.purgeBinnedFolder(ORG, folder.vertraege)
    }
    const reads = async (roles: string[], seesEverything = false) =>
      (await access.readableFolderIdsFor(ORG, projectId, { roles, seesEverything })).includes(folder.vertraege)

    it.each([
      ['unchanged', { gf: true, bh: true, pl: false, admin: true }],
      ['project', { gf: true, bh: true, pl: true, admin: true }],
      ['admins', { gf: false, bh: false, pl: false, admin: true }],
      ['remove', { gf: false, bh: false, pl: false, admin: true }],
    ] as const)('%s', async (policy, expected) => {
      await purgeVertraege()
      await setting.saveDeletedFolderContentPolicy(admin, policy, new Request('http://test'))
      expect({ gf: await reads([GF]), bh: await reads([BH]), pl: await reads([PL]), admin: await reads([], true) }).toEqual(expected)
    })

    it('decides a memory note and a conversation by the same rule', async () => {
      const note = await insertNote('Honorar 12 %', [folder.vertraege], null)
      const cites = await insertAnswer('Vertrag sagt …', [{ collection: restrictedCollectionName(COLLECTION, folder.vertraege), file_name: 'Vertrag.pdf' }])
      await purgeVertraege()
      const memory = inTenant(await import('./memory-service'))
      const visibleTo = async (roles: string[]) =>
        (
          await memory.listProjectMemory(projectId, {
            organizationId: ORG,
            readableFolderIds: await access.readableFolderIdsFor(ORG, projectId, { roles, seesEverything: false }),
          })
        ).map((item) => item.id)
      expect(await visibleTo([BH])).toContain(note)
      expect(await restrictedUse.recordedRestrictedFolders(CHAT, ORG)).toEqual([folder.vertraege])
      await setting.saveDeletedFolderContentPolicy(admin, 'project', new Request('http://test'))
      expect(await visibleTo([PL])).toContain(note)
      // Readable by every member now: the conversation no longer restricts anyone.
      expect(await restrictedUse.recordedRestrictedFolders(CHAT, ORG)).toEqual([])
      await setting.saveDeletedFolderContentPolicy(admin, 'admins', new Request('http://test'))
      expect(await visibleTo([BH])).not.toContain(note)
      expect(cites).not.toBe('')
    })

    it('restricts the conversations that drew on a purged OPEN folder once the setting says admins only', async () => {
      await insertAnswer('Plan …', [{ collection: COLLECTION, file_name: 'Plan.pdf' }])
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      await bin.purgeBinnedFolder(ORG, folder.plaene)
      expect(await restrictedUse.recordedRestrictedFolders(CHAT, ORG)).toEqual([])
      await setting.saveDeletedFolderContentPolicy(admin, 'admins', new Request('http://test'))
      expect(await restrictedUse.recordedRestrictedFolders(CHAT, ORG)).toEqual([folder.plaene])
    })

    it('„Mit dem Ordner entfernen": the purge removes the derived content with the folder', async () => {
      await setting.saveDeletedFolderContentPolicy(admin, 'remove', new Request('http://test'))
      const cites = await insertAnswer('Plan …', [{ collection: COLLECTION, file_name: 'Plan.pdf' }])
      const note = await insertNote('aus dem Plan', [folder.plaene], null)
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      const result = await bin.purgeBinnedFolder(ORG, folder.plaene)
      expect(result.counts).toMatchObject({ memoryNotes: 1, answers: 1 })
      expect(result.traceConversationIds).toEqual([CHAT])
      const [answer] = await inOrg(() => db.execute<{ content: string }>(sql`SELECT content FROM messages WHERE id = ${cites}::uuid`))
      expect(answer.content).toBe('Inhalt entfernt: Quelle gelöscht')
      const notes = await inOrg(() => db.execute<{ id: string }>(sql`SELECT id FROM project_memory WHERE id = ${note}::uuid`))
      expect(ids(notes)).toEqual([])
    })
  })

  describe('„Mit dem Ordner entfernen“ when „Endgültig löschen“ runs: everything derived goes, traces included', () => {
    const langfuse = { observations: [] as Array<{ traceId: string; sessionId: string }>, deleted: [] as string[][] }

    beforeEach(async () => {
      await setting.saveDeletedFolderContentPolicy(admin, 'remove', new Request('http://test'))
      process.env.LANGFUSE_HOST = 'http://langfuse.test'
      process.env.LANGFUSE_PUBLIC_KEY = 'pk'
      process.env.LANGFUSE_SECRET_KEY = 'sk' // pragma: allowlist secret (a stub Langfuse)
      langfuse.observations = [
        { traceId: 'trace-1', sessionId: CHAT },
        { traceId: 'trace-2', sessionId: CHAT },
      ]
      langfuse.deleted = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init?: RequestInit) => {
          const target = new URL(String(input))
          if (target.pathname === '/api/public/v2/observations') {
            const session = target.searchParams.get('sessionId')
            return Response.json({ data: langfuse.observations.filter((row) => row.sessionId === session), meta: {} })
          }
          if (target.pathname === '/api/public/traces' && init?.method === 'DELETE') {
            langfuse.deleted.push((JSON.parse(String(init.body)) as { traceIds: string[] }).traceIds)
            return Response.json({})
          }
          return new Response('unexpected', { status: 500 })
        })
      )
    })

    it('deletes the notes, replaces the answers, erases the traces, marks the reports, and records ids without content', async () => {
      memory.restricted = await insertNote('aus dem Plan', [folder.plaene], null)
      memory.fromChat = await insertNote('im Chat gelernt', null, CHAT)
      memory.unrelated = await insertNote('anderes Projektwissen', null, null)
      message.cites = await insertAnswer('Laut Plan.pdf hat Herr Muster …', [
        { collection: COLLECTION, file_name: 'Archiv.pdf', content: 'Herr Muster, geb. 1970' },
      ])
      message.other = await insertAnswer('Allgemein …', [{ collection: COLLECTION, file_name: 'Lageplan.pdf' }])
      const [report] = ids(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
                                   authored_by, authored_by_producer, authored_by_ref, authored_by_ref_kind)
            VALUES (${ORG}, ${USER}, 'piloti/bericht.pdf', 'k/bericht', ${COLLECTION}, 'completed', 'project', ${projectId}::uuid,
                    'agent', 'report', ${message.cites}, 'answer_artifact')
            RETURNING id`)
        )
      )
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })

      const result = await bin.purgeFolderFromBinNow(manager, { projectId, folderId: folder.plaene }, new Request('http://test'))

      expect(result.counts).toMatchObject({ documents: 2, folders: 2, memoryNotes: 2, answers: 1, conversations: 1, reports: 1, tracesErased: 2 })
      const notes = await inOrg(() => db.execute<{ id: string }>(sql`SELECT id FROM project_memory WHERE organization_id = ${ORG}`))
      expect(ids(notes)).toEqual([memory.unrelated])
      const [answer] = await inOrg(() =>
        db.execute<{ content: string; metadata: Record<string, unknown> }>(sql`SELECT content, metadata FROM messages WHERE id = ${message.cites}::uuid`)
      )
      expect(answer.content).toBe('Inhalt entfernt: Quelle gelöscht')
      expect(Object.keys(answer.metadata)).toEqual(['sourceRemoved'])
      const [other] = await inOrg(() => db.execute<{ content: string }>(sql`SELECT content FROM messages WHERE id = ${message.other}::uuid`))
      expect(other.content).toBe('Allgemein …')
      expect(langfuse.deleted).toEqual([['trace-1', 'trace-2']])
      // A filed report stays, marked „Quelle gelöscht am …".
      const [kept] = await inOrg(() =>
        db.execute<{ metadata: Record<string, unknown> }>(sql`SELECT metadata FROM documents WHERE id = ${report}::uuid`)
      )
      expect(kept.metadata.sourceDeleted).toMatchObject({ folderId: folder.plaene })

      const [record] = await queueRow(folder.plaene)
      expect(record.status).toBe('purged')
      expect(record.requested_by).toBe('user_pl')
      expect(record.payload.derivedRemoval).toMatchObject({
        conversationIds: [CHAT],
        messageIds: [message.cites],
        reportIds: [report],
      })
      expect(record.payload.purged).toMatchObject({ tracesErased: 2, memoryNotes: 2 })
      // The record holds no content: no answer text, no passage, no file name.
      const proof = JSON.stringify(record.payload)
      for (const content of ['Herr Muster', 'Plan.pdf', 'Archiv.pdf', 'aus dem Plan']) expect(proof).not.toContain(content)
    })

    it('leaves the row pending for the purger when Langfuse fails, and the retry still names the traces it owes', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
      message.cites = await insertAnswer('Plan …', [{ collection: COLLECTION, file_name: 'Plan.pdf' }])
      await bin.moveFolderToBin(pl, { projectId, folderId: folder.plaene })
      await expect(bin.purgeFolderFromBinNow(manager, { projectId, folderId: folder.plaene })).rejects.toThrow(/503/)
      expect((await queueRow(folder.plaene))[0]?.status).toBe('pending')
      // The purger's retry: the BFF's steps are done, and what is owed is the traces.
      const retry = await bin.purgeBinnedFolder(ORG, folder.plaene)
      expect(retry).toMatchObject({ status: 'already-purged', traceConversationIds: [CHAT] })
    })
  })
})
