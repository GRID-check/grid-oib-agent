/**
 * @vitest-environment node
 *
 * Moving documents into the collection their folder puts them in (ADR-0087),
 * against a REAL Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/collection-placement.integration.spec.ts
 *
 * The backend is mocked; the rows and the job queue are not. What is proven:
 * the purge comes before the re-point, a failed purge leaves the row where it
 * is (and reports it), the re-point hands the re-read to ONE queued
 * `placement_reingest` job and the job dispatches it at bulk, a second
 * placement moves nothing, the sweep finds the project and finishes what an
 * outage left, lifting the restriction brings the document back, a row still
 * waiting for its re-read moves again while a row the job has taken waits.
 * Then completeness: a misplaced row behind a thousand placed ones is moved,
 * the moves per call are bounded and the rest reported pending, a row whose
 * ingest is still running waits, and the sweep reaches a project beyond its
 * first page.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/documents/service', () => ({
  dispatchDocument: vi.fn().mockResolvedValue({ jobId: 'job', status: 'pending' }),
  INGEST_DISPATCH_FAILED_MESSAGE: 'dispatch failed',
}))
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
   * Give the folder its own list, or make it inherit again with `null`. Who is
   * on the list is WorkOS's (ADR-0096) and placement never asks: it keys on
   * whether every member reads (`everyoneReads`), which a list of people does
   * not decide.
   */
  const restrict = (list: { everyoneReads: boolean } | null) =>
    inTenant(() =>
      db.execute(sql`
        UPDATE project_folders
        SET access_mode = ${list ? 'custom' : 'inherit'},
            everyone_reads = ${list?.everyoneReads ?? false},
            access_changed_by = ${USER}, access_changed_at = now()
        WHERE id = ${folderId}::uuid
      `)
    )

  /** What the row says about its re-read: status, the placement mark, the job it names. */
  const handOffOf = async (id: string) =>
    Array.from(
      await inTenant(() =>
        db.execute<{ status: string; marked: boolean; job: string | null }>(sql`
          SELECT status, metadata ? 'placementReingest' AS marked, metadata ->> 'bffJobId' AS job
          FROM documents WHERE id = ${id}::uuid
        `)
      )
    )[0]
  /** The project's `placement_reingest` jobs no worker has claimed. */
  const waitingJobs = async (project: string): Promise<string[]> =>
    Array.from(
      await inTenant(() =>
        db.execute<{ job_id: string }>(sql`
          SELECT job_id FROM bff_job_queue
          WHERE kind = 'placement_reingest' AND lane = ${ORG} AND status = 'queued' AND payload ->> 'projectId' = ${project}
        `)
      ),
      (row) => String(row.job_id)
    )
  /** Run the project's re-read job to the end, as a `bff-jobs` worker would, inside the job's lane. */
  const runReingestJob = async (project: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const { done } = await inTenant(() => placement.runPlacementReingestSlice(ORG, { projectId: project }))
      if (done) break
    }
    await inTenant(() => db.execute(sql`DELETE FROM bff_job_queue WHERE kind = 'placement_reingest' AND lane = ${ORG}`))
  }
  /** The backend finished the re-read the mocked dispatch stands for. */
  const ingestSettled = (id: string) =>
    inTenant(() => db.execute(sql`UPDATE documents SET status = 'completed', metadata = '{}'::jsonb WHERE id = ${id}::uuid`))

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
    // The job-queue suites claim across lanes: leave no job of ours behind for them.
    await inTenant(() => db.execute(sql`DELETE FROM bff_job_queue WHERE lane = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('leaves a document where it is when its old chunks could not be purged, and says so', async () => {
    await restrict({ everyoneReads: false })
    vi.mocked(purge).mockResolvedValue(false)

    const result = await placement.placeProjectDocuments(ORG, projectId)

    expect(result).toEqual({ moved: 0, failed: [documentId], pending: 0 })
    expect(await collectionOf(documentId)).toBe(COLLECTION)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('is finished by the sweep: purge first, then the row, then ONE bulk job re-reads it into the folder collection', async () => {
    const order: string[] = []
    vi.mocked(purge).mockImplementation(async (_backend, ref) => {
      if (ref.filename === 'Honorarnote.pdf') order.push(`purge while row in ${await collectionOf(documentId)}`)
      return true
    })
    vi.mocked(dispatch).mockImplementation(async (input) => {
      // The sweep is cross-tenant: another suite's restricted project, running
      // at the same time, has its documents dispatched by this sweep too.
      if (input.documentId === documentId) order.push(`dispatch into ${input.collectionName} at ${input.priority}`)
      return { jobId: 'job', status: 'pending' } as Awaited<ReturnType<typeof dispatch>>
    })

    // As the internal route runs it: discovery is cross-tenant, stated as such.
    // A sweep places a page of projects; other suites' restricted projects may
    // share this database, so it is swept until it comes round to this one.
    const target = restrictedCollectionName(COLLECTION, folderId)
    await sweepUntil(async () => (await collectionOf(documentId)) === target)

    // The sweep purged and re-pointed; the re-read is the job's, and nothing was dispatched yet.
    expect(await collectionOf(documentId)).toBe(target)
    expect(order).toEqual([`purge while row in ${COLLECTION}`])
    const [jobId] = await waitingJobs(projectId)
    expect(await waitingJobs(projectId)).toEqual([jobId])
    expect(await handOffOf(documentId)).toEqual({ status: 'processing', marked: true, job: jobId })

    await runReingestJob(projectId)

    expect(order).toEqual([`purge while row in ${COLLECTION}`, `dispatch into ${target} at bulk`])
    expect((await handOffOf(documentId))?.marked).toBe(false)
    // The sweep is cross-tenant, so other suites' documents may be purged first.
    const ours = vi.mocked(purge).mock.calls.find(([, ref]) => ref.filename === 'Honorarnote.pdf')
    expect(ours?.[1]).toMatchObject({ collectionName: COLLECTION, filename: 'Honorarnote.pdf' })
    await ingestSettled(documentId)
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

  it('moves a row still waiting for its re-read like a settled one, into one job, and dispatches it where it now belongs', async () => {
    vi.mocked(purge).mockResolvedValue(true)
    const target = restrictedCollectionName(COLLECTION, folderId)
    // Waiting since the lift above. Restricted again before its job ran:
    await restrict({ everyoneReads: false })
    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 1, failed: [], pending: 0 })
    expect(await collectionOf(documentId)).toBe(target)
    // The lift's job had not started, so it serves this move too.
    expect(await waitingJobs(projectId)).toHaveLength(1)

    // Lifted again, and the job runs only now: it reads the folder tree as it is.
    await restrict(null)
    await runReingestJob(projectId)

    expect(await collectionOf(documentId)).toBe(COLLECTION)
    expect(vi.mocked(dispatch).mock.calls.map(([input]) => [input.collectionName, input.priority])).toEqual([[COLLECTION, 'bulk']])
    await ingestSettled(documentId)
  })

  it('does not move a row the re-read job has already taken', async () => {
    vi.mocked(purge).mockResolvedValue(true)
    await restrict({ everyoneReads: false })
    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 1, failed: [], pending: 0 })
    // The job takes the row (its mark goes) and has not dispatched yet when the restriction is lifted.
    await inTenant(() => db.execute(sql`UPDATE documents SET metadata = metadata - 'placementReingest' WHERE id = ${documentId}::uuid`))
    await restrict(null)

    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 0, failed: [], pending: 1 })
    expect(await collectionOf(documentId)).toBe(restrictedCollectionName(COLLECTION, folderId))

    await ingestSettled(documentId)
    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 1, failed: [], pending: 0 })
    await inTenant(() => db.execute(sql`DELETE FROM bff_job_queue WHERE kind = 'placement_reingest' AND lane = ${ORG}`))
    await ingestSettled(documentId)
  })

  it('moves nothing for a list that narrows only who writes: every member still reads, retrieval keys on read', async () => {
    await restrict({ everyoneReads: true })
    vi.mocked(purge).mockResolvedValue(true)

    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 0, failed: [], pending: 0 })
    expect(await collectionOf(documentId)).toBe(COLLECTION)
    expect(purge).not.toHaveBeenCalled()
    await restrict(null)
  })

  // A quarantined row moves with its folder, so the file lands in the right
  // collection once a reviewer releases it, and stays quarantined: only a
  // release takes it out (ADR-0086, migration 0122's trigger), so it is
  // re-pointed without the hand-off to the re-read job, which would set it
  // `processing`. The release dispatches it into the collection it is in.
  it('moves a quarantined row without handing it to the re-read, and it stays quarantined', async () => {
    vi.mocked(purge).mockResolvedValue(true)
    const held = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id,
             screening_outcome, content_hash, screened_hash)
          VALUES (${ORG}, ${USER}, 'Lohnliste.pdf', 'k/Lohnliste.pdf', ${COLLECTION}, 'quarantined', 'project',
                  ${projectId}::uuid, ${folderId}::uuid, 'quarantined', 'sha256:lohn', 'sha256:lohn')
          RETURNING id
        `)
      )
    )
    await restrict({ everyoneReads: false })

    const result = await placement.placeProjectDocuments(ORG, projectId)

    expect(result.failed).toEqual([])
    expect(await collectionOf(held)).toBe(restrictedCollectionName(COLLECTION, folderId))
    const handOff = await handOffOf(held)
    expect(handOff).toMatchObject({ status: 'quarantined', job: null })
    expect(handOff?.marked).not.toBe(true)
    await runReingestJob(projectId)
    expect(vi.mocked(dispatch).mock.calls.map(([input]) => input.documentId)).not.toContain(held)

    await restrict(null)
    await placement.placeProjectDocuments(ORG, projectId)
    await runReingestJob(projectId)
    await ingestSettled(documentId)
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE id = ${held}::uuid`))
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
            INSERT INTO project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
            VALUES (${ORG}, ${bulkProjectId}::uuid, 'Angebote', 'Angebote', 'custom', ${USER}, now())
            RETURNING id
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
          INSERT INTO project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
          SELECT organization_id, id, 'Verträge', 'Verträge', 'custom', ${USER}, now()
          FROM projects WHERE organization_id = ${ORG} AND name LIKE 'Sweep %'
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
