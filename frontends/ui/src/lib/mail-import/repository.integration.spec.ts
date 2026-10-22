/**
 * @vitest-environment node
 *
 * The import list's keyset paging and the open-import lookup against a REAL
 * Postgres, through the restricted runtime role (`scripts/rls-test-db.sh`):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/mail-import/repository.integration.spec.ts
 *
 * The unit specs mock the repository; these prove the SQL: paging the whole
 * list a row at a time returns every import once, newest first, two imports
 * started in the same millisecond included (the id breaks the tie), and never
 * one of another project; and an open import is found however many finished
 * ones came after it.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DocumentListCursor } from '@/lib/documents/list-cursor'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_mail_imports_${Date.now()}`
const USER = 'user_mail_imports'
const COLLEAGUE = 'user_mail_imports_colleague'
const SAME_INSTANT = '2026-10-01T08:00:00.123Z'

describe.skipIf(!url)('mail imports against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let projectId: string
  let otherProjectId: string
  /** The project's imports, newest first, as the list must answer them. */
  const expected: string[] = []

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run)

  async function insertProject(name: string): Promise<string> {
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, ${name}, ${USER}, ${`coll_${name}`})
        RETURNING id
      `),
    )
    return String(Array.from(rows)[0]?.id)
  }

  async function insertImport(
    project: string,
    createdAt: string,
    status: 'uploading' | 'completed' = 'completed',
    userId = COLLEAGUE,
  ): Promise<string> {
    const completedAt = status === 'completed' ? createdAt : null
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO mail_imports
          (organization_id, project_id, user_id, filename, size_bytes, status, staging_bucket, staging_key,
           created_at, completed_at)
        VALUES
          (${ORG}, ${project}::uuid, ${userId}, 'Postfach.pst', 1000, ${status}, 'grid-documents',
           ${`org/${ORG}/project/${project}/mail-imports/x/archive`}, ${createdAt}::timestamptz, ${completedAt}::timestamptz)
        RETURNING id
      `),
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
    projectId = await insertProject('mail_imports')
    otherProjectId = await insertProject('mail_imports_other')

    // The person's open import is the OLDEST row, behind a page of finished ones.
    const open = await insertImport(projectId, '2026-09-01T08:00:00Z', 'uploading', USER)
    const tied = [await insertImport(projectId, SAME_INSTANT), await insertImport(projectId, SAME_INSTANT)]
    const later = []
    for (let day = 2; day <= 4; day++) later.push(await insertImport(projectId, `2026-10-0${day}T08:00:00Z`))
    await insertImport(otherProjectId, '2026-10-05T08:00:00Z')
    expected.push(...later.reverse(), ...tied.sort().reverse(), open)
  })

  afterAll(async () => {
    if (!url) return
    await withPlatformAccess('test teardown: mail imports', () =>
      db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`),
    )
  })

  it('pages the whole list once, newest first, the id breaking a tie, one project only', async () => {
    const seen: string[] = []
    let cursor: DocumentListCursor | null = null
    for (let pages = 0; pages < 20; pages++) {
      const page: Awaited<ReturnType<typeof repo.listProjectMailImports>> = await repo.listProjectMailImports(
        ORG,
        projectId,
        { limit: 1, cursor },
      )
      seen.push(...page.rows.map((row) => row.id))
      cursor = page.next
      if (!cursor) break
    }
    expect(seen).toEqual(expected)
    expect(cursor).toBeNull()
  })

  it('says a full last page is the last', async () => {
    const page = await repo.listProjectMailImports(ORG, projectId, { limit: expected.length, cursor: null })
    expect(page.rows).toHaveLength(expected.length)
    expect(page.next).toBeNull()
  })

  it('finds the open import of one person, however old', async () => {
    expect((await repo.findOpenMailImportOf(ORG, projectId, USER))?.id).toBe(expected.at(-1))
    expect(await repo.findOpenMailImportOf(ORG, projectId, COLLEAGUE)).toBeNull()
    expect(await repo.findOpenMailImportOf(ORG, otherProjectId, USER)).toBeNull()
  })
})
