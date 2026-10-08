/**
 * @vitest-environment node
 *
 * A quarantined document in the listings and on the agent's byte path
 * (ADR-0085), against a REAL Postgres.
 *
 * The unit spec proves the services pass the reader; this one proves the SQL
 * keeps what it should: a reader who may not review the quarantine sees the
 * quarantined rows they uploaded and no other, and the agent's
 * `(collection, filename)` lookup never resolves one at all. It runs under
 * `task db:test:rls`, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/quarantine-listing.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_quarantine_${Date.now()}`
const UPLOADER = 'user_q_uploader'
const OTHER_UPLOADER = 'user_q_other'
const MEMBER = 'user_q_member'
const COLLECTION = `coll_quarantine_${Date.now()}`

describe.skipIf(!url)('quarantined documents in listings, against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./repository')
  let archiv: typeof import('@/lib/archiv/repository')
  let sessions: typeof import('@/lib/session-documents/repository')
  let bim: typeof import('@/lib/bim/repository')
  let projectId: string
  let conversationId: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: UPLOADER }, run)

  async function insert(
    shelf: 'project' | 'archiv' | 'session',
    filename: string,
    createdBy: string,
    status: string
  ): Promise<void> {
    const collection = shelf === 'project' ? COLLECTION : shelf === 'archiv' ? `archiv_${ORG}` : `session_${ORG}`
    await inTenant(() =>
      db.execute(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, conversation_id)
        VALUES
          (${ORG}, ${createdBy}, ${filename}, ${`k/${shelf}/${filename}`}, ${collection}, ${status}, ${shelf},
           ${shelf === 'project' ? projectId : null}::uuid, ${shelf === 'session' ? conversationId : null})
      `)
    )
  }

  /** One ready file, the uploader's quarantined one, and somebody else's quarantined one. */
  async function seed(shelf: 'project' | 'archiv' | 'session'): Promise<void> {
    await insert(shelf, `${shelf}-ready.pdf`, OTHER_UPLOADER, 'completed')
    await insert(shelf, `${shelf}-own.pdf`, UPLOADER, 'quarantined')
    await insert(shelf, `${shelf}-foreign.pdf`, OTHER_UPLOADER, 'quarantined')
  }

  const names = (rows: ReadonlyArray<{ filename: string }>): string[] => rows.map((row) => row.filename).sort()

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    archiv = await import('@/lib/archiv/repository')
    sessions = await import('@/lib/session-documents/repository')
    bim = await import('@/lib/bim/repository')

    const projects = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Quarantäne', ${UPLOADER}, ${COLLECTION})
        RETURNING id
      `)
    )
    projectId = String(Array.from(projects)[0].id)
    conversationId = `conv_quarantine_${Date.now()}`
    await inTenant(() =>
      db.execute(sql`
        INSERT INTO conversations (id, organization_id, created_by)
        VALUES (${conversationId}, ${ORG}, ${UPLOADER})
      `)
    )
    await seed('project')
    await seed('archiv')
    await seed('session')
    // A model for each project file: an IFC is extracted before its digest is
    // screened, so a quarantined one has a `ready` model too.
    await inTenant(() =>
      db.execute(sql`
        INSERT INTO bim_models (organization_id, project_id, document_id, status)
        SELECT organization_id, project_id, id, 'ready' FROM documents
        WHERE organization_id = ${ORG} AND scope = 'project'
      `)
    )
  }, 60_000)

  afterAll(async () => {
    if (!db) return
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`DELETE FROM bim_models WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM conversations WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('lists a project member only the ready file', async () => {
    const page = await repo.listProjectDocumentPage(projectId, ORG, { quarantineReader: MEMBER })
    expect(names(page.rows)).toEqual(['project-ready.pdf'])
  })

  it('lists the uploader their own quarantined file and nobody else’s', async () => {
    const page = await repo.listProjectDocumentPage(projectId, ORG, { quarantineReader: UPLOADER })
    expect(names(page.rows)).toEqual(['project-own.pdf', 'project-ready.pdf'])
  })

  it('lists a reviewer, who passes no reader, all three', async () => {
    const page = await repo.listProjectDocumentPage(projectId, ORG)
    expect(names(page.rows)).toHaveLength(3)
  })

  it('narrows the by-name lookup the same way', async () => {
    const wanted = ['project-ready.pdf', 'project-own.pdf', 'project-foreign.pdf']
    expect(names(await repo.findProjectDocumentsByFilenames(projectId, ORG, wanted, { quarantineReader: MEMBER }))).toEqual([
      'project-ready.pdf',
    ])
    expect(names(await repo.findProjectDocumentsByFilenames(projectId, ORG, wanted, { quarantineReader: UPLOADER }))).toEqual(
      ['project-own.pdf', 'project-ready.pdf']
    )
  })

  it('narrows the name probes the same way, digest and all', async () => {
    const wanted = ['project-ready.pdf', 'project-own.pdf', 'project-foreign.pdf']
    expect(names(await repo.findProjectDocumentsByNames(projectId, ORG, wanted, { quarantineReader: MEMBER }))).toEqual([
      'project-ready.pdf',
    ])
    expect(names(await repo.findProjectDocumentsByNames(projectId, ORG, wanted, { quarantineReader: UPLOADER }))).toEqual([
      'project-own.pdf',
      'project-ready.pdf',
    ])
    const archived = ['archiv-ready.pdf', 'archiv-own.pdf', 'archiv-foreign.pdf']
    expect(names(await archiv.findArchivDocumentsByNames(ORG, archived, { quarantineReader: MEMBER }))).toEqual([
      'archiv-ready.pdf',
    ])
    expect(await archiv.findArchivDocumentsByNames(ORG, archived)).toHaveLength(3)
  })

  it('narrows the project overview the same way', async () => {
    const { getProjectOverviewData } = await import('@/lib/projects/overview-query')
    const forMember = await inTenant(() =>
      getProjectOverviewData(projectId, ORG, { hiddenFolderIds: [], quarantineReader: MEMBER })
    )
    expect(forMember?.documentCount).toBe(1)
    expect(names(forMember?.recentDocuments ?? [])).toEqual(['project-ready.pdf'])
    const forReviewer = await inTenant(() =>
      getProjectOverviewData(projectId, ORG, { hiddenFolderIds: [], quarantineReader: undefined })
    )
    expect(forReviewer?.documentCount).toBe(3)
  })

  it('narrows the Büroablage listing the same way', async () => {
    const page = await archiv.listArchivDocuments(ORG, { quarantineReader: MEMBER })
    expect(names(page.rows)).toEqual(['archiv-ready.pdf'])
  })

  it("narrows a chat's attachments the same way", async () => {
    const rows = await sessions.listSessionDocuments(conversationId, ORG, undefined, MEMBER)
    expect(names(rows)).toEqual(['session-ready.pdf'])
    const own = await sessions.listSessionDocuments(conversationId, ORG, undefined, UPLOADER)
    expect(names(own)).toEqual(['session-own.pdf', 'session-ready.pdf'])
  })

  it("never resolves a quarantined file for the agent's byte lookup", async () => {
    await expect(repo.findStorageKeyByCollectionAndFilename(COLLECTION, 'project-own.pdf', ORG)).resolves.toBeNull()
    await expect(repo.findStorageKeyByCollectionAndFilename(COLLECTION, 'project-ready.pdf', ORG)).resolves.toMatchObject({
      storageKey: 'k/project/project-ready.pdf',
    })
  })

  it('narrows the IFC model list the same way, and gives the agent none', async () => {
    const forMember = await bim.listBimModels(ORG, { projectId, quarantineReaders: { project: MEMBER, archiv: MEMBER } })
    expect(names(forMember)).toEqual(['project-ready.pdf'])
    const forUploader = await bim.listBimModels(ORG, {
      projectId,
      quarantineReaders: { project: UPLOADER, archiv: UPLOADER },
    })
    expect(names(forUploader)).toEqual(['project-own.pdf', 'project-ready.pdf'])
    const forAgent = await bim.listBimModels(ORG, { projectId, withoutQuarantined: true })
    expect(names(forAgent)).toEqual(['project-ready.pdf'])
    expect(await bim.listBimModels(ORG, { projectId })).toHaveLength(3)
  })

  it("asks each shelf's own reader of the IFC model list that spans both", async () => {
    await inTenant(() =>
      db.execute(sql`
        INSERT INTO bim_models (organization_id, project_id, document_id, status)
        SELECT organization_id, NULL, id, 'ready' FROM documents
        WHERE organization_id = ${ORG} AND scope = 'archiv'
      `)
    )
    // A project admin who does not curate the Büroablage: every project model,
    // and of the Büroablage's only what is not held back.
    const forProjectAdmin = await bim.listBimModels(ORG, {
      projectId,
      includeArchiv: true,
      quarantineReaders: { project: undefined, archiv: MEMBER },
    })
    expect(names(forProjectAdmin)).toEqual([
      'archiv-ready.pdf',
      'project-foreign.pdf',
      'project-own.pdf',
      'project-ready.pdf',
    ])
    // A curator who is a plain member of the project: the reverse.
    const forCurator = await bim.listBimModels(ORG, {
      projectId,
      includeArchiv: true,
      quarantineReaders: { project: MEMBER, archiv: undefined },
    })
    expect(names(forCurator)).toEqual(['archiv-foreign.pdf', 'archiv-own.pdf', 'archiv-ready.pdf', 'project-ready.pdf'])
  })
})
