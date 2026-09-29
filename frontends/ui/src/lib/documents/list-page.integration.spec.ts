/**
 * @vitest-environment node
 *
 * The document listing's keyset pager, against a REAL Postgres.
 *
 * The unit spec pins the statement; this one proves the claim the statement
 * exists for: following `nextCursor` visits every row exactly once, in the
 * listing's order, when rows share a timestamp and when they differ by less
 * than a millisecond — the case a cursor built from a JS `Date` gets wrong.
 * It runs under `task db:test:rls`, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/list-page.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_listpage_${Date.now()}`
const USER = 'user_listpage'

/**
 * Timestamps with two exact ties and three rows inside ONE millisecond: a
 * cursor truncated to milliseconds would re-serve or drop some of them.
 */
const CREATED_AT = [
  '2026-03-01 10:00:00.000900+00',
  '2026-03-01 10:00:00.000500+00',
  '2026-03-01 10:00:00.000500+00',
  '2026-03-01 10:00:00.000100+00',
  '2026-02-01 09:00:00+00',
  '2026-02-01 09:00:00+00',
  '2026-01-01 08:00:00.123456+00',
]

describe.skipIf(!url)('document listing pages against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./repository')
  let archiv: typeof import('@/lib/archiv/repository')
  let projectId: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: USER }, run)

  async function seed(scope: 'project' | 'archiv', prefix: string): Promise<void> {
    for (const [index, createdAt] of CREATED_AT.entries()) {
      const collection = scope === 'project' ? 'coll_listpage' : `archiv_${ORG}`
      await inTenant(() =>
        db.execute(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status,
             scope, project_id, created_at)
          VALUES
            (${ORG}, ${USER}, ${`${prefix}-${index}.pdf`}, ${`k/${prefix}/${index}`}, ${collection},
             'completed', ${scope}, ${scope === 'project' ? projectId : null}::uuid, ${createdAt}::timestamptz)
        `),
      )
    }
  }

  /** The order the listing promises, as Postgres itself computes it. */
  async function expectedIds(scope: 'project' | 'archiv'): Promise<string[]> {
    const rows = await inTenant(async () =>
      Array.from(
        await db.execute<{ id: string }>(sql`
          SELECT id FROM documents WHERE organization_id = ${ORG} AND scope = ${scope}
          ORDER BY created_at DESC, id ASC
        `),
      ),
    )
    return rows.map((row) => String(row.id))
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    archiv = await import('@/lib/archiv/repository')

    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Listing', ${USER}, 'coll_listpage')
        RETURNING id
      `),
    )
    projectId = String(Array.from(rows)[0].id)
    await seed('project', 'plan')
    await seed('archiv', 'norm')
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

  it('visits every project document once, in order, two rows a page', async () => {
    const seen: string[] = []
    let cursor: import('./list-cursor').DocumentListCursor | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await repo.listProjectDocumentPage(projectId, ORG, { limit: 2, cursor })
      seen.push(...page.rows.map((row) => row.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(await expectedIds('project'))
    expect(seen).toHaveLength(CREATED_AT.length)
  })

  it('visits every Archiv document once, in order, three rows a page', async () => {
    const seen: string[] = []
    let cursor: import('./list-cursor').DocumentListCursor | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await inTenant(() => archiv.listArchivDocuments(ORG, { limit: 3, cursor }))
      seen.push(...page.rows.map((row) => row.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(await expectedIds('archiv'))
  })

  it('says a full last page is the last one', async () => {
    const page = await repo.listProjectDocumentPage(projectId, ORG, { limit: CREATED_AT.length })
    expect(page.rows).toHaveLength(CREATED_AT.length)
    expect(page.nextCursor).toBeNull()
  })

  it('finds an Archiv document by name whatever page it is on', async () => {
    const oldest = `norm-${CREATED_AT.length - 1}.pdf`
    const rows = await inTenant(() => archiv.findArchivDocumentsByFilenames(ORG, [oldest]))
    expect(rows.map((row) => row.filename)).toEqual([oldest])
  })

  // The upload planner's probe answers with the rows the upload would version:
  // archived ones too, a name in the other Unicode form, a rename or a case
  // variant as recognition — and never a machine-authored namesake.
  it('probes names the way the upload matches them', async () => {
    const decomposed = 'Übersicht.pdf'.normalize('NFD')
    await inTenant(async () => {
      await db.execute(sql`UPDATE documents SET lifecycle = 'archived'
        WHERE organization_id = ${ORG} AND filename = 'plan-6.pdf'`)
      await db.execute(sql`UPDATE documents SET display_name = 'Grundriss EG.pdf'
        WHERE organization_id = ${ORG} AND filename = 'plan-5.pdf'`)
      await db.execute(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
        VALUES
          (${ORG}, ${USER}, ${decomposed}, 'k/nfd', 'coll_listpage', 'completed', 'project', ${projectId}::uuid)
      `)
      // A machine-authored namesake: it coexists with the person's file and
      // must never be offered to the planner as the document to replace.
      await db.execute(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
           authored_by, authored_by_ref, authored_by_ref_kind, authored_by_producer)
        VALUES
          (${ORG}, ${USER}, 'plan-0.pdf', 'k/agent', 'coll_listpage', 'stored', 'project', ${projectId}::uuid,
           'agent', 'run-1', 'agent_run', 'report')
      `)
    })

    const rows = await repo.findProjectDocumentsByNames(projectId, ORG, [
      'plan-6.pdf',
      'PLAN-1.PDF',
      'Übersicht.pdf'.normalize('NFC'),
      'grundriss eg.pdf',
      'plan-0.pdf',
    ])

    const byName = Object.fromEntries(rows.map((row) => [row.filename, row]))
    expect(Object.keys(byName).sort()).toEqual(
      ['plan-0.pdf', 'plan-1.pdf', 'plan-5.pdf', 'plan-6.pdf', decomposed].sort(),
    )
    expect(byName['plan-6.pdf'].lifecycle).toBe('archived')
    expect(byName['plan-0.pdf'].authoredBy).toBe('user')
  })
})
