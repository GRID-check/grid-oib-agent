/**
 * @vitest-environment node
 *
 * Upload batches and the quarantine release, against a REAL Postgres
 * (ADR-0085, migrations 0108 and 0109), through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/upload-batches/upload-batches.integration.spec.ts
 *
 * The unit specs mock the repository; these prove the SQL the claims rest on:
 * a batch completes only once it is sealed and nothing of it is in flight, it
 * completes ONCE however often it is settled (the inbox item it triggers must
 * go out once), another organization cannot see it, and a release takes only
 * for the exact bytes the reviewer saw.
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
  let repo: typeof import('./repository')
  let documentsRepo: typeof import('@/lib/documents/repository')
  let projectId: string

  const inTenant = <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)

  async function insertDocument(
    filename: string,
    status: string,
    extra: { hash?: string; batch?: string; folderId?: string | null } = {}
  ): Promise<string> {
    const rows = await inTenant(ORG, () =>
      db.execute<{ id: string }>(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
           upload_batch_id, content_hash, folder_id)
        VALUES
          (${ORG}, ${USER}, ${filename}, ${`k/${filename}`}, 'coll_uploads', ${status}, 'project', ${projectId}::uuid,
           ${extra.batch ?? BATCH}::uuid, ${extra.hash ?? null}, ${extra.folderId ?? null}::uuid)
        RETURNING id
      `)
    )
    return String(Array.from(rows)[0]?.id)
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    documentsRepo = await import('@/lib/documents/repository')
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

    await documentsRepo.setDocumentReconciledStatus(reading, ORG, { status: 'quarantined', errorMessage: 'quarantined:{}' })
    const completed = await repo.completeSettledBatches(ORG, [BATCH], new Date())
    expect(completed.map((batch) => batch.id)).toEqual([BATCH])
    expect(completed[0]?.excluded).toEqual([{ term: 'Rechnung', count: 1 }])

    expect(await repo.completeSettledBatches(ORG, [BATCH], new Date())).toEqual([])
    expect(await repo.batchIdsOfDocuments(ORG, [reading])).toEqual([BATCH])
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
