/**
 * @vitest-environment node
 *
 * Upload batches and the quarantine release, against a REAL Postgres
 * (ADR-0083, migrations 0107 and 0108), through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/upload-batches/upload-batches.integration.spec.ts
 *
 * The unit specs mock the repository; these prove the SQL the claims rest on:
 * a batch completes only once it is sealed and nothing of it is in flight, it
 * completes ONCE however often it is settled (the inbox item it triggers must
 * go out once), another organization cannot see it, and a release takes only
 * for the exact bytes the reviewer saw. And the content gate's decisions
 * (migration 0117): a status write lands only on the dispatch it resolved,
 * records one decision per dispatch, and the decision stays owed to the audit
 * trail, outliving its document, until it is marked once.
 */

import { sql } from 'drizzle-orm'
import type { Document } from '@/lib/db/schema'
import type { QuarantineCursor } from '@/lib/documents/repository'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_uploads_${Date.now()}`
const OTHER_ORG = `${ORG}_other`
const USER = 'user_uploads'
const BATCH = '7c1f0f8e-0b6a-4f41-9d3b-5a0b2f9e1a01'

describe.skipIf(!url)('upload batches against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let documentsRepo: typeof import('@/lib/documents/repository')
  let decisionsRepo: typeof import('@/lib/upload-screening/repository')
  let projectId: string

  const inTenant = <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)

  async function insertDocument(
    filename: string,
    status: string,
    extra: { hash?: string; batch?: string; folderId?: string | null; jobId?: string } = {}
  ): Promise<string> {
    const metadata = extra.jobId ? JSON.stringify({ ingestJobId: extra.jobId }) : null
    const rows = await inTenant(ORG, () =>
      db.execute<{ id: string }>(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
           upload_batch_id, content_hash, folder_id, metadata)
        VALUES
          (${ORG}, ${USER}, ${filename}, ${`k/${filename}`}, 'coll_uploads', ${status}, 'project', ${projectId}::uuid,
           ${extra.batch ?? BATCH}::uuid, ${extra.hash ?? null}, ${extra.folderId ?? null}::uuid, ${metadata}::jsonb)
        RETURNING id
      `)
    )
    return String(Array.from(rows)[0]?.id)
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    documentsRepo = await import('@/lib/documents/repository')
    decisionsRepo = await import('@/lib/upload-screening/repository')
    const rows = await inTenant(ORG, () =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Uploads', ${USER}, 'coll_uploads')
        RETURNING id
      `)
    )
    projectId = String(Array.from(rows)[0]?.id)
    await repo.insertUploadBatch({
      id: BATCH,
      organizationId: ORG,
      createdBy: USER,
      scope: 'project',
      projectId,
      expectedCount: 2,
      excluded: [{ term: 'Rechnung', count: 1 }],
    })
  })

  afterAll(async () => {
    await inTenant(ORG, () => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inTenant(ORG, () => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('is invisible to another organization', async () => {
    expect(await repo.findUploadBatch(OTHER_ORG, BATCH)).toBeNull()
    const seen = await inTenant(OTHER_ORG, () =>
      db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM upload_batches WHERE id = ${BATCH}::uuid`)
    )
    expect(Number(Array.from(seen)[0]?.n)).toBe(0)
  })

  it('does not complete while unsealed, nor while a document is in flight, and completes once', async () => {
    const reading = await insertDocument('a.pdf', 'pending')
    await insertDocument('b.pdf', 'completed')

    expect(await repo.completeSettledBatches(ORG, [BATCH], new Date())).toEqual([])

    expect(await repo.sealUploadBatch(ORG, BATCH, 'someone-else', { unchanged: 0, failed: 0 }, new Date())).toBe(false)
    expect(await repo.sealUploadBatch(ORG, BATCH, USER, { unchanged: 1, failed: 0 }, new Date())).toBe(true)
    expect(await repo.sealUploadBatch(ORG, BATCH, USER, { unchanged: 1, failed: 0 }, new Date())).toBe(false)
    expect(await repo.completeSettledBatches(ORG, [BATCH], new Date())).toEqual([])

    const quarantine = { status: 'quarantined', errorMessage: 'quarantined:{}' }
    const seen = { status: 'pending', jobId: null }
    expect(await documentsRepo.setDocumentReconciledStatus(reading, ORG, quarantine, seen)).toBe(true)
    // A second read that saw the same `pending` lost the race: it moves
    // nothing, so it settles nothing and the quarantine is audited once.
    expect(await documentsRepo.setDocumentReconciledStatus(reading, ORG, quarantine, seen)).toBe(false)
    const completed = await repo.completeSettledBatches(ORG, [BATCH], new Date())
    expect(completed.map((batch) => batch.id)).toEqual([BATCH])
    expect(completed[0]?.excluded).toEqual([{ term: 'Rechnung', count: 1 }])

    expect(await repo.completeSettledBatches(ORG, [BATCH], new Date())).toEqual([])
    expect(await repo.batchIdsOfDocuments(ORG, [reading])).toEqual([BATCH])
  })

  it('settles a quarantine only on the dispatch it resolved, and records one decision per dispatch', async () => {
    const verdict = 'quarantined:' + JSON.stringify({ reasons: [{ kind: 'term', term: 'Lohnzettel' }], checked: 'full' })
    const quarantine = { status: 'quarantined', errorMessage: verdict, screeningOutcome: 'quarantined' as const }
    const id = await insertDocument('lohn.pdf', 'pending', { jobId: 'job-1' })
    const settle = (jobId: string) =>
      documentsRepo.setDocumentReconciledStatus(id, ORG, quarantine, { status: 'pending', jobId })
    const decisions = async () =>
      Array.from(
        await inTenant(ORG, () =>
          db.execute<{
            job_id: string
            reasons: string
            checked: string
            filename: string
            uploaded_by: string
            folder_id: string | null
          }>(sql`
            SELECT job_id, reasons, checked, filename, uploaded_by, folder_id FROM document_quarantine_decisions
            WHERE document_id = ${id}::uuid ORDER BY decided_at, job_id
          `)
        )
      )

    // A read that resolved another dispatch moves nothing.
    expect(await settle('job-0')).toBe(false)
    expect(await settle('job-1')).toBe(true)
    expect(await decisions()).toEqual([
      { job_id: 'job-1', reasons: 'term:Lohnzettel', checked: 'full', filename: 'lohn.pdf', uploaded_by: USER, folder_id: null },
    ])

    // A reviewer releases it: back in flight under a new job. A read that saw
    // the row in flight before and resolved job-1 must not land on job-2's
    // dispatch, though the status it saw is the row's status again.
    await inTenant(ORG, () =>
      db.execute(sql`
        UPDATE documents SET status = 'pending', error_message = NULL, metadata = '{"ingestJobId":"job-2"}'::jsonb
        WHERE id = ${id}::uuid
      `)
    )
    expect(await settle('job-1')).toBe(false)
    expect(await decisions()).toHaveLength(1)

    // job-2 quarantines it again: a second decision, a second row.
    expect(await settle('job-2')).toBe(true)
    expect((await decisions()).map((row) => row.job_id)).toEqual(['job-1', 'job-2'])
  })

  it('keeps a decision owed until it is marked audited, once, and never rewritten', async () => {
    const verdict = 'quarantined:' + JSON.stringify({ reasons: [{ kind: 'iban' }] })
    const id = await insertDocument('konto.pdf', 'pending', { jobId: 'job-owed' })
    const resolution = { status: 'quarantined', errorMessage: verdict }
    await documentsRepo.setDocumentReconciledStatus(id, ORG, resolution, { status: 'pending', jobId: 'job-owed' })

    const [owed] = await decisionsRepo.listOwedQuarantineDecisions(ORG, [id])
    expect(owed).toMatchObject({ documentId: id, jobId: 'job-owed', reasons: 'iban', auditedAt: null })
    expect(await decisionsRepo.listOwedQuarantineDecisions(OTHER_ORG, [id])).toEqual([])
    // The sweep's discovery, across organizations.
    const found = await withPlatformAccess('test: the quarantine audit sweep', () =>
      decisionsRepo.listOwedQuarantineDecisionsBetween(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000), 50)
    )
    expect(found.map((row) => row.id)).toContain(owed.id)

    // The document goes; the decision it was stays owed.
    await inTenant(ORG, () => db.execute(sql`DELETE FROM documents WHERE id = ${id}::uuid`))
    expect(await decisionsRepo.listOwedQuarantineDecisions(ORG, [id])).toHaveLength(1)

    expect(await decisionsRepo.markQuarantineDecisionAudited(OTHER_ORG, owed.id, new Date())).toBe(false)
    expect(await decisionsRepo.markQuarantineDecisionAudited(ORG, owed.id, new Date())).toBe(true)
    expect(await decisionsRepo.markQuarantineDecisionAudited(ORG, owed.id, new Date())).toBe(false)
    expect(await decisionsRepo.listOwedQuarantineDecisions(ORG, [id])).toEqual([])

    await expect(
      inTenant(ORG, () => db.execute(sql`UPDATE document_quarantine_decisions SET reasons = 'x' WHERE id = ${owed.id}::uuid`))
    ).rejects.toThrow()
    await expect(
      inTenant(ORG, () => db.execute(sql`DELETE FROM document_quarantine_decisions WHERE id = ${owed.id}::uuid`))
    ).rejects.toThrow()
  })

  it('reopens a completion its uploader was not told of, and only the one it wrote', async () => {
    const batch = '7c1f0f8e-0b6a-4f41-9d3b-5a0b2f9e1a03'
    await repo.insertUploadBatch({ id: batch, organizationId: ORG, createdBy: USER, scope: 'project', projectId, expectedCount: 1 })
    await insertDocument('reopen.pdf', 'completed', { batch })
    expect(await repo.sealUploadBatch(ORG, batch, USER, { unchanged: 0, failed: 0 }, new Date())).toBe(true)
    const completedAt = new Date()
    expect((await repo.completeSettledBatches(ORG, [batch], completedAt)).map((row) => row.id)).toEqual([batch])

    // Another organization, or another completion time, reopens nothing.
    await repo.reopenCompletedBatches(OTHER_ORG, [batch], completedAt)
    await repo.reopenCompletedBatches(ORG, [batch], new Date(completedAt.getTime() + 1))
    expect((await repo.findUploadBatch(ORG, batch))?.completedAt).not.toBeNull()

    await repo.reopenCompletedBatches(ORG, [batch], completedAt)
    expect((await repo.findUploadBatch(ORG, batch))?.completedAt).toBeNull()
    // Open again, so the next settle completes it and tells the uploader.
    expect((await repo.completeSettledBatches(ORG, [batch], new Date())).map((row) => row.id)).toEqual([batch])
  })

  it('refuses a completed-but-unsealed batch at the CHECK, whatever the writer', async () => {
    await expect(
      inTenant(ORG, () =>
        db.execute(sql`
          INSERT INTO upload_batches (id, organization_id, created_by, scope, project_id, expected_count, completed_at)
          VALUES (gen_random_uuid(), ${ORG}, ${USER}, 'project', ${projectId}::uuid, 1, now())
        `)
      )
    ).rejects.toThrow()
  })

  it('releases only the quarantined row whose bytes the reviewer saw', async () => {
    const id = await insertDocument('honorar.pdf', 'quarantined', { hash: 'sha256:seen' })
    const release = (contentHash: string) =>
      documentsRepo.markScreeningReleased(id, ORG, { contentHash, releasedBy: 'reviewer', releasedAt: new Date() })

    expect(await release('sha256:other')).toBe(false)
    expect(await release('sha256:seen')).toBe(true)
    // No longer quarantined, so a second release takes nothing.
    expect(await release('sha256:seen')).toBe(false)

    const row = await documentsRepo.findDocumentInOrg(id, ORG)
    expect(row).toMatchObject({
      status: 'uploaded',
      screeningOutcome: 'released',
      screeningReleasedHash: 'sha256:seen',
      screeningReleasedBy: 'reviewer',
    })
  })

  it('refuses a half-recorded release at the CHECK', async () => {
    const id = await insertDocument('half.pdf', 'quarantined', { hash: 'sha256:x' })
    await expect(
      inTenant(ORG, () => db.execute(sql`UPDATE documents SET screening_released_by = 'r' WHERE id = ${id}::uuid`))
    ).rejects.toThrow()
  })

  it('pages the quarantine newest first, with ties on the timestamp broken by id, each row once', async () => {
    const ids = await Promise.all(['q1.pdf', 'q2.pdf', 'q3.pdf'].map((name) => insertDocument(name, 'quarantined')))
    // Two rows on one timestamp: the tie a plain `updated_at <` cursor would skip.
    await inTenant(ORG, () =>
      db.execute(sql`
        UPDATE documents SET updated_at = '2026-10-01T10:00:00Z'
        WHERE id IN (${sql.join(ids.slice(0, 2).map((id) => sql`${id}::uuid`), sql`, `)})
      `)
    )
    await inTenant(ORG, () =>
      db.execute(sql`UPDATE documents SET updated_at = '2026-10-01T09:00:00Z' WHERE id = ${ids[2]}::uuid`)
    )

    const seen: string[] = []
    let cursor: QuarantineCursor | null = null
    for (let page = 0; page < 10; page += 1) {
      const rows: Document[] = (await documentsRepo.listQuarantinedDocuments(ORG, cursor)).filter((row) =>
        ids.includes(row.id)
      )
      if (rows.length === 0) break
      // One row per "page" here, by walking the cursor row by row.
      const first: Document = rows[0]
      seen.push(first.id)
      cursor = { updatedAt: new Date(first.updatedAt), id: first.id }
    }

    expect([...seen].sort()).toEqual([...ids].sort())
    expect(seen[2]).toBe(ids[2])
  })

  it('records the folder a quarantined document was filed in, so the trail can withhold its name', async () => {
    const folders = await inTenant(ORG, () =>
      db.execute<{ id: string }>(sql`
        INSERT INTO project_folders (organization_id, project_id, name, path)
        VALUES (${ORG}, ${projectId}::uuid, 'Personal Quarantäne', 'Personal Quarantäne')
        RETURNING id
      `)
    )
    const folderId = String(Array.from(folders)[0]?.id)
    const id = await insertDocument('gehalt.pdf', 'pending', { jobId: 'job-f', folderId })

    const quarantine = { status: 'quarantined', errorMessage: 'quarantined:{}' }
    expect(await documentsRepo.setDocumentReconciledStatus(id, ORG, quarantine, { status: 'pending', jobId: 'job-f' })).toBe(true)

    const rows = await inTenant(ORG, () =>
      db.execute<{ folder_id: string | null }>(sql`
        SELECT folder_id FROM document_quarantine_decisions WHERE document_id = ${id}::uuid
      `)
    )
    expect(Array.from(rows)).toEqual([{ folder_id: folderId }])
  })

  it("leaves a batch's documents in a hidden folder uncounted, with the listing's own predicate", async () => {
    const batch = '7c1f0f8e-0b6a-4f41-9d3b-5a0b2f9e1a02'
    await repo.insertUploadBatch({ id: batch, organizationId: ORG, createdBy: USER, scope: 'project', projectId, expectedCount: 3 })
    const folders = await inTenant(ORG, () =>
      db.execute<{ id: string }>(sql`
        INSERT INTO project_folders (organization_id, project_id, name, path)
        VALUES (${ORG}, ${projectId}::uuid, 'Honorare', 'Honorare')
        RETURNING id
      `)
    )
    const folderId = String(Array.from(folders)[0]?.id)
    await insertDocument('root.pdf', 'completed', { batch })
    await insertDocument('honorar-1.pdf', 'completed', { batch, folderId })
    await insertDocument('honorar-2.pdf', 'quarantined', { batch, folderId })

    const byStatus = (rows: Awaited<ReturnType<typeof repo.countBatchDocumentsByStatus>>) =>
      Object.fromEntries(rows.map((row) => [row.status, row.count]))

    expect(byStatus(await repo.countBatchDocumentsByStatus(ORG, [batch]))).toEqual({ completed: 2, quarantined: 1 })
    expect(byStatus(await repo.countBatchDocumentsByStatus(ORG, [batch], { hiddenFolderIds: [folderId] }))).toEqual({
      completed: 1,
    })
  })

  it("pages a project's whole history newest first, ties broken by id, each upload once", async () => {
    const rows = await inTenant(ORG, () =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Many uploads', ${USER}, 'coll_many_uploads')
        RETURNING id
      `)
    )
    const many = String(Array.from(rows)[0]?.id)
    const total = repo.UPLOAD_HISTORY_LIMIT + 7
    // One minute apart, except that the last upload of the first page and the
    // first of the second share one timestamp: the tie a plain `created_at <`
    // cursor would skip across the page boundary.
    await inTenant(ORG, () =>
      db.execute(sql`
        INSERT INTO upload_batches (id, organization_id, created_by, scope, project_id, expected_count, created_at)
        SELECT gen_random_uuid(), ${ORG}, ${USER}, 'project', ${many}::uuid, 1,
               timestamptz '2026-10-01T12:00:00.123Z' - make_interval(mins => n - CASE WHEN n = ${repo.UPLOAD_HISTORY_LIMIT} THEN 1 ELSE 0 END)
        FROM generate_series(0, ${total - 1}) AS n
      `)
    )

    const seen: string[] = []
    let cursor: Awaited<ReturnType<typeof repo.listProjectUploadBatchPage>>['nextCursor'] = null
    let pages = 0
    do {
      const page: Awaited<ReturnType<typeof repo.listProjectUploadBatchPage>> = await repo.listProjectUploadBatchPage(
        ORG,
        many,
        cursor ? { cursor } : {}
      )
      expect(page.batches.length).toBeLessThanOrEqual(repo.UPLOAD_HISTORY_LIMIT)
      seen.push(...page.batches.map((batch) => batch.id))
      cursor = page.nextCursor
      pages += 1
    } while (cursor && pages < 10)

    expect(pages).toBe(2)
    expect(seen).toHaveLength(total)
    expect(new Set(seen).size).toBe(total)
    const ordered = await inTenant(ORG, () =>
      db.execute<{ id: string }>(sql`
        SELECT id FROM upload_batches WHERE project_id = ${many}::uuid ORDER BY created_at DESC, id ASC
      `)
    )
    expect(seen).toEqual(Array.from(ordered).map((row) => String(row.id)))
  })
})
