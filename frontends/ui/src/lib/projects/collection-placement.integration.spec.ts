/**
 * @vitest-environment node
 *
 * Moving documents into the collection their folder puts them in (ADR-0086),
 * against a REAL Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/collection-placement.integration.spec.ts
 *
 * The backend is mocked; the rows are not. What is proven: the purge comes
 * before the re-point, a failed purge leaves the row where it is (and reports
 * it), a second placement moves nothing, the sweep finds the project and
 * finishes what an outage left, and lifting the restriction brings the
 * document back. Then completeness: a misplaced row behind a thousand placed
 * ones is moved, the moves per call are bounded and the rest reported pending,
 * a row whose ingest is still running waits, and the sweep reaches a project
 * beyond its first page.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/documents/service', () => ({ dispatchDocument: vi.fn().mockResolvedValue({ jobId: 'job', status: 'pending' }) }))
vi.mock('@/lib/documents/collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/collection-file-ref')>()),
  purgeIngestedChunks: vi.fn(),
}))
// The backend's job status: by default every in-flight job is still running.
vi.mock('@/lib/documents/reconcile-status', () => ({ reconcileDocumentStatuses: vi.fn(async (rows: unknown[]) => rows) }))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_placement_${Date.now()}`
const USER = 'user_placement'
const COLLECTION = `proj_placement_${Date.now()}`

describe.skipIf(!url)('collection placement against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let placement: typeof import('./collection-placement')
  let sweep: typeof import('./placement-sweep')
  let purge: typeof import('@/lib/documents/collection-file-ref').purgeIngestedChunks
  let dispatch: typeof import('@/lib/documents/service').dispatchDocument
  let reconcile: typeof import('@/lib/documents/reconcile-status').reconcileDocumentStatuses
  let restrictedCollectionName: typeof import('@/lib/authz/folder-access').restrictedCollectionName
  let projectId: string
  let folderId: string
  let documentId: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)
  const collectionOf = async (id: string): Promise<string> =>
    String(
      Array.from(
        await inTenant(() =>
          db.execute<{ c: string }>(sql`SELECT collection_name AS c FROM documents WHERE id = ${id}::uuid`)
        )
      )[0]?.c
    )
  /**
   * Give the folder its own list of `roles` (each `write`), or make it inherit
   * again with `null`: one statement, so the 0110 trigger sees the finished
   * list at commit. `everyone` adds `*: read`, a list every member may read.
   */
  const restrict = (roles: string[] | null, everyone = false) =>
    inTenant(() =>
      db.execute(sql`
        WITH cleared AS (
          DELETE FROM project_folder_grants WHERE folder_id = ${folderId}::uuid
        ), listed AS (
          INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          SELECT ${ORG}, ${projectId}::uuid, ${folderId}::uuid, entry.role_slug, entry.level
          FROM jsonb_to_recordset(${JSON.stringify([
            ...(roles ?? []).map((role) => ({ role_slug: role, level: 'write' })),
            ...(roles && everyone ? [{ role_slug: '*', level: 'read' }] : []),
          ])}::jsonb) AS entry(role_slug text, level text)
        )
        UPDATE project_folders
        SET access_mode = ${roles ? 'custom' : 'inherit'},
            access_changed_by = ${USER}, access_changed_at = now()
        WHERE id = ${folderId}::uuid
      `)
    )

  /** Sweep, as the internal route does (inside platform access), until `done` or the walk has gone round twice. */
  const sweepUntil = async (done: () => Promise<boolean>): Promise<void> => {
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    const restrictingProjects = Number(
      Array.from(
        await withPlatformAccess('test: count restricting projects', () =>
          db.execute<{ n: string }>(
            sql`SELECT count(DISTINCT project_id) AS n FROM project_folders WHERE access_mode = 'custom' AND deleted_at IS NULL`
          )
        )
      )[0]?.n
    )
    const laps = 2 * Math.ceil(restrictingProjects / sweep.PLACEMENT_SWEEP_PROJECTS) + 1
    for (let i = 0; i < laps && !(await done()); i++) {
      await withPlatformAccess('test: placement sweep', () => sweep.sweepCollectionPlacement())
    }
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    placement = await import('./collection-placement')
    sweep = await import('./placement-sweep')
    purge = (await import('@/lib/documents/collection-file-ref')).purgeIngestedChunks
    dispatch = (await import('@/lib/documents/service')).dispatchDocument
    reconcile = (await import('@/lib/documents/reconcile-status')).reconcileDocumentStatuses
    restrictedCollectionName = (await import('@/lib/authz/folder-access')).restrictedCollectionName

    projectId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Placement', ${USER}, ${COLLECTION}) RETURNING id
        `)
      )
    )
    folderId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (organization_id, project_id, name, path) VALUES (${ORG}, ${projectId}::uuid, 'Honorare', 'Honorare')
          RETURNING id
        `)
      )
    )
    documentId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
          VALUES (${ORG}, ${USER}, 'Honorarnote.pdf', 'k/Honorarnote.pdf', ${COLLECTION}, 'completed', 'project',
                  ${projectId}::uuid, ${folderId}::uuid)
          RETURNING id
        `)
      )
    )
  })

  beforeEach(() => {
    vi.mocked(purge).mockReset()
    vi.mocked(dispatch).mockClear()
    vi.mocked(reconcile).mockClear()
  })

  afterAll(async () => {
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('leaves a document where it is when its old chunks could not be purged, and says so', async () => {
    await restrict(['org-geschaeftsfuehrung'])
    vi.mocked(purge).mockResolvedValue(false)

    const result = await placement.placeProjectDocuments(ORG, projectId)

    expect(result).toEqual({ moved: 0, failed: [documentId], pending: 0 })
    expect(await collectionOf(documentId)).toBe(COLLECTION)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('is finished by the sweep: purge first, then the row, then the re-read into the folder collection', async () => {
    const order: string[] = []
    vi.mocked(purge).mockImplementation(async (_backend, ref) => {
      if (ref.filename === 'Honorarnote.pdf') order.push(`purge while row in ${await collectionOf(documentId)}`)
      return true
    })
    vi.mocked(dispatch).mockImplementation(async (input) => {
      // The sweep is cross-tenant: another suite's restricted project, running
      // at the same time, has its documents dispatched by this sweep too.
      if (input.documentId === documentId) order.push(`dispatch into ${input.collectionName}`)
      return { jobId: 'job', status: 'pending' } as Awaited<ReturnType<typeof dispatch>>
    })

    // As the internal route runs it: discovery is cross-tenant, stated as such.
    // A sweep places a page of projects; other suites' restricted projects may
    // share this database, so it is swept until it comes round to this one.
    const target = restrictedCollectionName(COLLECTION, folderId)
    await sweepUntil(async () => (await collectionOf(documentId)) === target)

    expect(await collectionOf(documentId)).toBe(target)
    expect(order).toEqual([`purge while row in ${COLLECTION}`, `dispatch into ${target}`])
    // The sweep is cross-tenant, so other suites' documents may be purged first.
    const ours = vi.mocked(purge).mock.calls.find(([, ref]) => ref.filename === 'Honorarnote.pdf')
    expect(ours?.[1]).toMatchObject({ collectionName: COLLECTION, filename: 'Honorarnote.pdf' })
  })

  it('moves nothing the second time', async () => {
    vi.mocked(purge).mockResolvedValue(true)
    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 0, failed: [], pending: 0 })
    expect(purge).not.toHaveBeenCalled()
  })

  it('brings the document back to the open collection when the restriction is lifted', async () => {
    await restrict(null)
    vi.mocked(purge).mockResolvedValue(true)

    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 1, failed: [], pending: 0 })
    expect(await collectionOf(documentId)).toBe(COLLECTION)
  })

  it('moves nothing for a list that narrows only who writes: every member still reads (`*`), retrieval keys on read', async () => {
    await restrict(['org-geschaeftsfuehrung'], true)
    vi.mocked(purge).mockResolvedValue(true)

    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 0, failed: [], pending: 0 })
    expect(await collectionOf(documentId)).toBe(COLLECTION)
    expect(purge).not.toHaveBeenCalled()
    await restrict(null)
  })

  describe('completeness', () => {
    const BULK = `${COLLECTION}_bulk`
    let bulkProjectId: string
    let bulkFolderId: string
    let bulkTarget: string

    /** Misplaced rows: filed under the restricted folder, still in the project's open collection. */
    const insertMisplaced = async (prefix: string, count: number, status = 'completed'): Promise<string[]> =>
      Array.from(
        await inTenant(() =>
          db.execute<{ id: string }>(sql`
            INSERT INTO documents
              (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
            SELECT ${ORG}, ${USER}, ${prefix} || '-' || g || '.pdf', 'k/' || ${prefix} || '-' || g || '.pdf', ${BULK},
                   ${status}, 'project', ${bulkProjectId}::uuid, ${bulkFolderId}::uuid
            FROM generate_series(1, ${count}::int) AS g
            RETURNING id
          `)
        ),
        (row) => String(row.id)
      )

    beforeAll(async () => {
      bulkProjectId = firstId(
        await inTenant(() =>
          db.execute<{ id: string }>(sql`
            INSERT INTO projects (organization_id, name, created_by, collection_name)
            VALUES (${ORG}, 'Placement bulk', ${USER}, ${BULK}) RETURNING id
          `)
        )
      )
      bulkFolderId = firstId(
        await inTenant(() =>
          db.execute<{ id: string }>(sql`
            WITH folder AS (
              INSERT INTO project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
              VALUES (${ORG}, ${bulkProjectId}::uuid, 'Angebote', 'Angebote', 'custom', ${USER}, now())
              RETURNING id, project_id
            ), listed AS (
              INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
              SELECT ${ORG}, project_id, id, 'org-geschaeftsfuehrung', 'write' FROM folder
            )
            SELECT id FROM folder
          `)
        )
      )
      bulkTarget = restrictedCollectionName(BULK, bulkFolderId)
    })

    it('moves a misplaced document whose id sorts after a thousand correctly placed ones', async () => {
      await inTenant(() =>
        db.execute(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
          SELECT ${ORG}, ${USER}, 'Angebot-' || g || '.pdf', 'k/Angebot-' || g || '.pdf', ${bulkTarget}, 'completed',
                 'project', ${bulkProjectId}::uuid, ${bulkFolderId}::uuid
          FROM generate_series(1, 1000) AS g
        `)
      )
      const lastId = `ffffffff-ffff-4fff-bfff-${Date.now().toString(16).padStart(12, '0').slice(-12)}`
      await inTenant(() =>
        db.execute(sql`
          INSERT INTO documents
            (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
          VALUES (${lastId}::uuid, ${ORG}, ${USER}, 'Honorarangebot.pdf', 'k/Honorarangebot.pdf', ${BULK}, 'completed',
                  'project', ${bulkProjectId}::uuid, ${bulkFolderId}::uuid)
        `)
      )
      vi.mocked(purge).mockResolvedValue(true)

      expect(await placement.placeProjectDocuments(ORG, bulkProjectId)).toEqual({ moved: 1, failed: [], pending: 0 })
      expect(await collectionOf(lastId)).toBe(bulkTarget)
    })

    it('attempts a bounded number of moves per call, reports the rest pending, and the next call finishes', async () => {
      const ids = await insertMisplaced('Nachtrag', placement.PLACEMENT_MOVES + 1)
      vi.mocked(purge).mockResolvedValue(true)

      const first = await placement.placeProjectDocuments(ORG, bulkProjectId)
      expect(first).toEqual({ moved: placement.PLACEMENT_MOVES, failed: [], pending: 1 })
      expect(purge).toHaveBeenCalledTimes(placement.PLACEMENT_MOVES)

      expect(await placement.placeProjectDocuments(ORG, bulkProjectId)).toEqual({ moved: 1, failed: [], pending: 0 })
      const collections = await Promise.all(ids.map((id) => collectionOf(id)))
      expect(new Set(collections)).toEqual(new Set([bulkTarget]))
    })

    it('does not move a document whose ingest is still running, and moves it once the job has settled', async () => {
      const [running] = await insertMisplaced('Laufend', 1, 'pending')
      vi.mocked(purge).mockResolvedValue(true)

      expect(await placement.placeProjectDocuments(ORG, bulkProjectId)).toEqual({ moved: 0, failed: [], pending: 1 })
      expect(purge).not.toHaveBeenCalled()
      expect(await collectionOf(String(running))).toBe(BULK)
      expect(vi.mocked(reconcile).mock.calls[0]?.[0].map((row) => row.id)).toEqual([running])

      // The backend now reports the job finished: the same call reconciles and moves it.
      vi.mocked(reconcile).mockImplementationOnce(async (rows) => rows.map((row) => ({ ...row, status: 'completed' })))
      expect(await placement.placeProjectDocuments(ORG, bulkProjectId)).toEqual({ moved: 1, failed: [], pending: 0 })
      expect(await collectionOf(String(running))).toBe(bulkTarget)
    })

    it('sweeps a project beyond the first page of restricting projects', async () => {
      const count = sweep.PLACEMENT_SWEEP_PROJECTS + 1
      await inTenant(() =>
        db.execute(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          SELECT ${ORG}, 'Sweep ' || g, ${USER}, ${COLLECTION} || '_sweep_' || g FROM generate_series(1, ${count}::int) AS g
        `)
      )
      await inTenant(() =>
        db.execute(sql`
          WITH folders AS (
            INSERT INTO project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
            SELECT organization_id, id, 'Verträge', 'Verträge', 'custom', ${USER}, now()
            FROM projects WHERE organization_id = ${ORG} AND name LIKE 'Sweep %'
            RETURNING id, project_id
          )
          INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          SELECT ${ORG}, project_id, id, 'org-geschaeftsfuehrung', 'write' FROM folders
        `)
      )
      await inTenant(() =>
        db.execute(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
          SELECT ${ORG}, ${USER}, 'Vertrag.pdf', 'k/' || f.id || '/Vertrag.pdf', p.collection_name, 'completed', 'project',
                 p.id, f.id
          FROM project_folders f JOIN projects p ON p.id = f.project_id
          WHERE p.organization_id = ${ORG} AND p.name LIKE 'Sweep %'
        `)
      )
      const stillOpen = async (): Promise<number> =>
        Number(
          Array.from(
            await inTenant(() =>
              db.execute<{ n: string }>(sql`
                SELECT count(*) AS n FROM documents d JOIN projects p ON p.id = d.project_id
                WHERE p.organization_id = ${ORG} AND p.name LIKE 'Sweep %' AND d.collection_name = p.collection_name
              `)
            )
          )[0]?.n
        )
      expect(await stillOpen()).toBe(count)
      vi.mocked(purge).mockResolvedValue(true)

      await sweepUntil(async () => (await stillOpen()) === 0)

      expect(await stillOpen()).toBe(0)
    })
  })
})
