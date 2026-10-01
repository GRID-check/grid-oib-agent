/**
 * @vitest-environment node
 *
 * `uploadDocument`'s `onNameTaken`, against a REAL Postgres (review findings
 * K1/C1, C5).
 *
 * The claims here are about the live-name unique index, which is per PROJECT
 * rather than per folder, and about what the rows look like afterwards. A
 * drizzle double agrees with its fixture, so these run the real repository
 * through the restricted runtime role. Only the object store, the bucket, the
 * FGA check, the audit trail, the VLM probe and the backend's `/v1/ingest` are
 * stubbed. Runs under `task db:test:rls`:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/upload-name-taken.integration.spec.ts
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// The real clients, with `send` replaced: code on the path reads their config
// (the endpoint provider), so a bare `{ send }` double is not enough.
vi.mock('@/lib/s3', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/s3')>()
  const send = vi.fn(async () => ({}))
  for (const client of [real.s3Client, real.signingS3Client, real.bucketAdminS3Client]) {
    Object.assign(client, { send })
  }
  return real
})
vi.mock('@/lib/storage/bucket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/bucket')>()),
  ensureTenantBucketChecked: vi.fn(async () => 'grid-documents'),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => ({ role: 'project-editor' })) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/documents/vlm-capability', () => ({ isVlmConfigured: vi.fn(async () => false) }))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_name_taken_${Date.now()}`
const ALICE = 'user_alice'
const BOB = 'user_bob'

describe('the onNameTaken suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(
      url,
      'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set, so the ' +
        'onNameTaken suite skipped. Check `task db:test:rls`.',
    ).toBeTruthy()
  })
})

describe.skipIf(!url)("uploadDocument's onNameTaken against the live-name index", () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let uploadDocument: typeof import('./service').uploadDocument
  let projectId: string

  const inTenant = <T>(run: () => Promise<T>, userId = ALICE): Promise<T> =>
    withTenant({ organizationId: ORG, userId }, run)

  const session = (userId: string) => ({
    userId,
    email: `${userId}@grid.test`,
    name: null,
    accessToken: '',
    organizationId: ORG,
    organizationMembershipId: `om_${userId}`,
    role: 'member',
    permissions: [],
    featureFlags: null,
  })

  const pdf = (text: string, name = 'Plan.pdf') =>
    new File([Buffer.from(`%PDF-1.4\n${text}\n%%EOF`)], name, { type: 'application/pdf' })

  const mail = { channel: 'inbound-mail' as const, ref: 'msg-row-1' }

  let folderSeq = 0
  async function folder(name: string): Promise<string> {
    folderSeq += 1
    const unique = `${name}-${folderSeq}`
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO project_folders (project_id, parent_id, name, path)
        VALUES (${projectId}::uuid, NULL, ${unique}, ${unique}) RETURNING id
      `),
    )
    return String(Array.from(rows)[0].id)
  }

  const docRow = (id: string) =>
    inTenant(async () =>
      Array.from(
        await db.execute<{ id: string; filename: string; folder_id: string | null; created_by: string; status: string }>(sql`
          SELECT id, filename, folder_id, created_by, status FROM documents WHERE id = ${id}::uuid
        `),
      )[0],
    )

  const versions = (id: string) =>
    inTenant(async () =>
      Array.from(
        await db.execute<{ version_number: number; created_by: string }>(sql`
          SELECT version_number, created_by FROM document_versions
          WHERE document_id = ${id}::uuid ORDER BY version_number
        `),
      ),
    )

  const namesIn = (folderId: string) =>
    inTenant(async () =>
      Array.from(
        await db.execute<{ filename: string }>(sql`
          SELECT filename FROM documents WHERE folder_id = ${folderId}::uuid ORDER BY filename
        `),
      ).map((row) => row.filename),
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    // The test environment's global `crypto` lacks `randomUUID`; the service mints ids with it.
    vi.stubGlobal('crypto', (await import('node:crypto')).webcrypto)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ job_id: `job-${randomUUID()}` }), { status: 202 })),
    )
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    uploadDocument = (await import('./service')).uploadDocument
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Wohnbau', ${ALICE}, ${`coll_${ORG}`}) RETURNING id
      `),
    )
    projectId = String(Array.from(rows)[0].id)
  }, 60_000)

  it("'suffix' leaves Alice's Plaene/Plan.pdf alone and files an unrelated Plan.pdf as Plan (2).pdf", async () => {
    const plaene = await folder('Plaene')
    const alice = await inTenant(
      () => uploadDocument(session(ALICE), { projectId, folderId: plaene, file: pdf('ALICE statik plan') }, new Request('http://bff/x')),
      ALICE,
    )
    await inTenant(() => db.execute(sql`UPDATE documents SET status = 'completed' WHERE id = ${alice.documentId}::uuid`))
    const before = await docRow(alice.documentId)
    const versionsBefore = await versions(alice.documentId)

    const inbox = await folder('E-Mail-Eingang')
    const bob = await inTenant(
      () =>
        uploadDocument(session(BOB), {
          projectId,
          folderId: inbox,
          file: pdf('BOB unrelated plan from a mail'),
          onNameTaken: 'suffix',
          audit: mail,
        }),
      BOB,
    )

    expect(bob.documentId).not.toBe(alice.documentId)
    expect(bob).toMatchObject({ filename: 'Plan (2).pdf', unchanged: false })
    expect(await docRow(alice.documentId)).toEqual(before)
    expect(before).toMatchObject({ folder_id: plaene, created_by: ALICE, filename: 'Plan.pdf' })
    expect(await versions(alice.documentId)).toEqual(versionsBefore)
    expect(await docRow(bob.documentId)).toMatchObject({ folder_id: inbox, created_by: BOB, filename: 'Plan (2).pdf' })
    expect(await namesIn(inbox)).toEqual(['Plan (2).pdf'])
  })

  it("'suffix' answers unchanged for the same bytes into the same folder, even while pending", async () => {
    const inbox = await folder('E-Mail-Eingang')
    const upload = () =>
      inTenant(
        () =>
          uploadDocument(session(BOB), {
            projectId,
            folderId: inbox,
            file: pdf('retry', 'Retry.pdf'),
            onNameTaken: 'suffix',
            audit: mail,
          }),
        BOB,
      )

    const first = await upload()
    expect((await docRow(first.documentId)).status).not.toBe('completed')
    const second = await upload()

    expect(second).toMatchObject({ documentId: first.documentId, filename: 'Retry.pdf', unchanged: true })
    expect(await versions(first.documentId)).toHaveLength(1)
    expect(await namesIn(inbox)).toEqual(['Retry.pdf'])
  })

  it("'suffix' finds its own earlier numbered copy on a retry instead of filing another", async () => {
    const elsewhere = await folder('Bestand')
    await inTenant(
      () => uploadDocument(session(ALICE), { projectId, folderId: elsewhere, file: pdf('older', 'Schnitt.pdf') }, new Request('http://bff/x')),
      ALICE,
    )
    const inbox = await folder('E-Mail-Eingang')
    const upload = () =>
      inTenant(
        () =>
          uploadDocument(session(BOB), {
            projectId,
            folderId: inbox,
            file: pdf('mailed', 'Schnitt.pdf'),
            onNameTaken: 'suffix',
            audit: mail,
          }),
        BOB,
      )

    const first = await upload()
    const retry = await upload()

    expect(first).toMatchObject({ filename: 'Schnitt (2).pdf', unchanged: false })
    expect(retry).toMatchObject({ documentId: first.documentId, filename: 'Schnitt (2).pdf', unchanged: true })
    expect(await namesIn(inbox)).toEqual(['Schnitt (2).pdf'])
  })

  it("'suffix' turns a concurrent race for one free name into two distinct documents", async () => {
    const inbox = await folder('E-Mail-Eingang')
    const upload = (text: string) =>
      inTenant(
        () =>
          uploadDocument(session(BOB), {
            projectId,
            folderId: inbox,
            file: pdf(text, 'Detail.pdf'),
            onNameTaken: 'suffix',
            audit: mail,
          }),
        BOB,
      )

    const [a, b] = await Promise.all([upload('first detail'), upload('second detail')])

    expect(a.documentId).not.toBe(b.documentId)
    expect(new Set([a.filename, b.filename])).toEqual(new Set(['Detail.pdf', 'Detail (2).pdf']))
    expect(await namesIn(inbox)).toEqual(['Detail (2).pdf', 'Detail.pdf'])
  })

  it("'version' (the default) is unchanged from today: the name is the document, wherever it sits", async () => {
    const plaene = await folder('Plaene')
    const alice = await inTenant(
      () => uploadDocument(session(ALICE), { projectId, folderId: plaene, file: pdf('ALICE v1', 'Grundriss.pdf') }, new Request('http://bff/x')),
      ALICE,
    )
    await inTenant(() => db.execute(sql`UPDATE documents SET status = 'completed' WHERE id = ${alice.documentId}::uuid`))

    const other = await folder('Neu')
    const bob = await inTenant(
      () => uploadDocument(session(BOB), { projectId, folderId: other, file: pdf('BOB v2', 'Grundriss.pdf') }, new Request('http://bff/x')),
      BOB,
    )

    expect(bob).toMatchObject({ documentId: alice.documentId, filename: 'Grundriss.pdf', unchanged: false })
    expect(await docRow(alice.documentId)).toMatchObject({ folder_id: other, created_by: BOB })
    expect((await versions(alice.documentId)).map((v) => [v.version_number, v.created_by])).toEqual([
      [1, ALICE],
      [2, BOB],
    ])
  })
})
