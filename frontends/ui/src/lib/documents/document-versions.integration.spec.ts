/**
 * @vitest-environment node
 *
 * The version table's concurrency claims, against a REAL Postgres.
 *
 * Every claim below is about what the database does when two requests arrive
 * at once — a per-document advisory lock, a UNIQUE constraint, a
 * compare-and-swap whose predicate carries the hash that was read, a
 * transaction rolled back by a thrown sentinel, the quota measured inside the
 * transaction that commits. A drizzle double agrees with whatever its fixture
 * says, so the unit specs pin the statements and this suite runs the races.
 * It runs under `task db:test:rls`, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/document-versions.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_versions_${Date.now()}`
const USER = 'user_versions'

describe('the document-versions suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(
      url,
      'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set, so the ' +
        'document-versions suite skipped and nothing raced the version table. ' +
        'Check `task db:test:rls`.',
    ).toBeTruthy()
  })
})

describe.skipIf(!url)('document versions under concurrency', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./version-repository')
  let storage: typeof import('@/lib/storage/repository')
  let projectId: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: USER }, run)

  let seq = 0
  /** A document of its own per case, so a count is a statement about that case. */
  async function seedDocument(fileSize = 1_000): Promise<{ id: string; storageKey: string }> {
    seq += 1
    const storageKey = `org/${ORG}/project/p/doc/d${seq}/plan-${seq}.md`
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status,
           scope, project_id, file_size, content_hash)
        VALUES
          (${ORG}, ${USER}, ${`plan-${seq}.md`}, ${storageKey}, 'coll_versions', 'completed',
           'project', ${projectId}::uuid, ${fileSize}, 'sha256:item')
        RETURNING id
      `),
    )
    return { id: String(Array.from(rows)[0].id), storageKey }
  }

  const baseVersion = (documentId: string, storageKey: string, fileSize = 1_000) => ({
    organizationId: ORG,
    documentId,
    projectId,
    storageKey,
    storageBucket: null,
    contentType: 'text/markdown',
    fileSize,
    contentHash: 'sha256:item',
    createdBy: USER,
  })

  const published = (documentId: string, storageKey: string, fileSize = 1_000) => ({
    ...baseVersion(documentId, storageKey, fileSize),
    state: 'published' as const,
    approvedBy: USER,
    approvedAt: new Date(),
    publishedBy: USER,
    publishedAt: new Date(),
  })

  const versionsOf = (documentId: string) =>
    inTenant(async () =>
      Array.from(
        await db.execute<{ version_number: number; state: string; storage_key: string }>(sql`
          SELECT version_number, state, storage_key FROM document_versions
          WHERE document_id = ${documentId}::uuid ORDER BY version_number
        `),
      ),
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./version-repository')
    storage = await import('@/lib/storage/repository')

    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Versionen', ${USER}, 'coll_versions')
        RETURNING id
      `),
    )
    projectId = String(Array.from(rows)[0].id)
  }, 60_000)

  afterAll(async () => {
    if (!db) return
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('gives two overlapping re-uploads consecutive numbers and one published row', async () => {
    const doc = await seedDocument()
    await inTenant(() => repo.insertPublishedVersion(published(doc.id, doc.storageKey)))

    // Both "re-uploads" arrive at once. Before 0092 both read max = 1 and both
    // recorded version 2; now the second waits on the document's lock.
    await Promise.all([
      inTenant(() => repo.insertPublishedVersion(published(doc.id, `${doc.storageKey}.a`))),
      inTenant(() => repo.insertPublishedVersion(published(doc.id, `${doc.storageKey}.b`))),
    ])

    const rows = await versionsOf(doc.id)
    expect(rows.map((row) => Number(row.version_number))).toEqual([1, 2, 3])
    expect(rows.filter((row) => row.state === 'published')).toHaveLength(1)
    expect(rows[2].state).toBe('published')
  })

  it('refuses a second row with the same number (migration 0092)', async () => {
    const doc = await seedDocument()
    await inTenant(() => repo.insertPublishedVersion(published(doc.id, doc.storageKey)))
    const refusal = await inTenant(() =>
      db.execute(sql`
        INSERT INTO document_versions
          (organization_id, document_id, project_id, version_number, state, storage_key, created_by)
        VALUES (${ORG}, ${doc.id}::uuid, ${projectId}::uuid, 1, 'superseded', 'k/dup', ${USER})
      `),
    ).then(
      () => null,
      (error: unknown) => error,
    )
    // drizzle wraps the driver's error ("Failed query: …"); the Postgres one is
    // its `cause`, and it names the constraint.
    const cause = (refusal as { cause?: { code?: string; constraint_name?: string } } | null)?.cause
    expect(cause?.code).toBe('23505')
    expect(cause?.constraint_name).toBe('document_versions_document_id_version_number_key')
  })

  it('answers the loser of a concurrent publish with null, never a thrown rollback', async () => {
    const doc = await seedDocument()
    await inTenant(() => repo.insertPublishedVersion(published(doc.id, doc.storageKey)))
    const approved = await inTenant(() =>
      repo.insertDocumentVersion({
        ...baseVersion(doc.id, `${doc.storageKey}.v2`),
        state: 'approved',
        approvedBy: USER,
        approvedAt: new Date(),
      }),
    )
    const stamp = { state: 'published' as const, publishedBy: USER, publishedAt: new Date() }

    const outcomes = await Promise.all([
      inTenant(() => repo.promoteVersionToPublished(approved.id, doc.id, ORG, 'approved', stamp)),
      inTenant(() => repo.promoteVersionToPublished(approved.id, doc.id, ORG, 'approved', stamp)),
    ])

    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1)
    const rows = await versionsOf(doc.id)
    // The loser's supersede rolled back with it: still exactly one published.
    expect(rows.map((row) => row.state)).toEqual(['superseded', 'published'])
  })

  it('lets exactly one of two writers holding the same If-Match win the content swap', async () => {
    const doc = await seedDocument()
    await inTenant(() => repo.insertPublishedVersion(published(doc.id, doc.storageKey)))
    const draft = await inTenant(() =>
      repo.insertDocumentVersion({
        ...baseVersion(doc.id, `${doc.storageKey}.draft`),
        state: 'draft',
        contentHash: 'sha256:read',
      }),
    )
    const swap = (key: string) =>
      inTenant(() =>
        repo.swapVersionContent({
          versionId: draft.id,
          documentId: doc.id,
          organizationId: ORG,
          expected: { state: 'draft', storageKey: draft.storageKey, contentHash: 'sha256:read' },
          patch: {
            state: 'draft',
            storageKey: key,
            storageBucket: null,
            contentType: 'text/markdown',
            fileSize: 10,
            contentHash: `sha256:${key}`,
          },
          mirrorsItem: false,
          quotaBytes: null,
        }),
      )

    const outcomes = await Promise.all([swap('k/writer-a'), swap('k/writer-b')])

    const won = outcomes.filter((outcome) => outcome.ok)
    expect(won).toHaveLength(1)
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([{ ok: false, reason: 'conflict' }])
    // The row names the winner's key AND the winner's hash — never a mix.
    const rows = await versionsOf(doc.id)
    const winnerKey = won[0].ok ? won[0].version.storageKey : ''
    expect(rows[1].storage_key).toBe(winnerKey)
    expect(won[0].ok && won[0].previousKeyOrphaned).toBe(true)
  })

  it('charges a fresh fork’s first write in full, under the lock, and rolls back a crossing', async () => {
    // Measured against the whole organization's usage, so the ceiling is set
    // relative to whatever the earlier cases left behind.
    const doc = await seedDocument(1_000)
    const live = await inTenant(() =>
      repo.insertPublishedVersion(published(doc.id, doc.storageKey, 1_000)),
    )
    // A fork: a second row over the SAME object, so it costs nothing yet.
    const fork = await inTenant(() =>
      repo.insertDocumentVersion({ ...baseVersion(doc.id, doc.storageKey, 1_000), state: 'draft' }),
    )
    const used = await inTenant(() =>
      db.transaction((tx) => storage.readStorageUsage(tx, ORG)),
    )
    const swap = (quotaBytes: number) =>
      inTenant(() =>
        repo.swapVersionContent({
          versionId: fork.id,
          documentId: doc.id,
          organizationId: ORG,
          expected: { state: 'draft', storageKey: doc.storageKey, contentHash: 'sha256:item' },
          patch: {
            storageKey: `${doc.storageKey}.fork`,
            storageBucket: null,
            contentType: 'text/markdown',
            fileSize: 1_000,
            contentHash: 'sha256:fork',
          },
          mirrorsItem: false,
          quotaBytes,
        }),
      )

    // A same-sized revision of a 1_000-byte file: the old delta was 0. The
    // published object stays, so the commit really adds 1_000.
    await expect(swap(used + 999)).resolves.toEqual({ ok: false, reason: 'quota', usedBytes: used })
    expect((await versionsOf(doc.id))[1].storage_key).toBe(doc.storageKey)

    const admitted = await swap(used + 1_000)
    expect(admitted).toMatchObject({ ok: true, previousKeyOrphaned: false })
    // The published row still names the shared object, so it was not orphaned.
    expect(live.version.storageKey).toBe(doc.storageKey)
  })

  it('charges a re-upload its full size, because the replaced bytes stay', async () => {
    const doc = await seedDocument(1_000)
    await inTenant(() => repo.insertPublishedVersion(published(doc.id, doc.storageKey, 1_000)))
    const used = await inTenant(() =>
      db.transaction((tx) => storage.readStorageUsage(tx, ORG)),
    )
    const next = (fileSize: number) => ({
      storageKey: `${doc.storageKey}.v2`,
      storageBucket: null,
      fileSize,
      contentType: 'text/markdown',
      contentHash: 'sha256:v2',
      folderId: null,
      createdBy: USER,
    })

    // The old arithmetic excluded this document and called 900 bytes free.
    await expect(
      inTenant(() => storage.replaceDocumentWithinQuota(ORG, doc.id, next(900), used + 899)),
    ).resolves.toEqual({ ok: false, usedBytes: used })
    await expect(
      inTenant(() => storage.replaceDocumentWithinQuota(ORG, doc.id, next(900), used + 900)),
    ).resolves.toEqual({ ok: true })
    // And the ledger agrees afterwards: the old version joined the overhead.
    const after = await inTenant(() => db.transaction((tx) => storage.readStorageUsage(tx, ORG)))
    expect(after).toBe(used + 900)
  })
})
