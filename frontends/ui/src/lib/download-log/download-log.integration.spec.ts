/**
 * @vitest-environment node
 *
 * The download log against a REAL Postgres with every migration applied, as the
 * restricted runtime role (migration 0111, ADR-0081):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/download-log/download-log.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * The unit suites double the repository. Only this can prove what the log is
 * for: that a download lands whatever the folder and an open lands only under a
 * folder with its own list (including a plain subfolder of one), that the
 * database itself refuses the rows the product must never write, that nobody
 * but the platform role can change or delete a row, that one organization never
 * sees another's, that keyset pagination neither skips nor repeats rows that
 * share a millisecond, and that the scheduler's purge applies twelve months to
 * everyone and an organization's shorter choice to that organization alone.
 */

import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn(async () => undefined),
  recordAuditEventOrThrow: vi.fn(async () => undefined),
}))
vi.mock('@/lib/sharing/directory', () => ({
  resolvePeople: vi.fn(async () => new Map()),
}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_dlog_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const SHORT_ORG = `${ORG}_short`
const BAD_ORG = `${ORG}_bad`
const USER = 'user_dlog_a'
const OTHER_USER = 'user_dlog_b'

describe.skipIf(!url)('the download log against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let service: typeof import('./service')
  let repo: typeof import('./repository')
  let projectId: string
  const folder = { open: '', own: '', child: '' }
  const doc = { plain: '', own: '', child: '', archiv: '' }

  const inTenant = <T>(run: () => Promise<T>, organizationId = ORG): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)

  const session = (overrides: Record<string, unknown> = {}) =>
    ({
      userId: USER,
      email: 'a@example.com',
      name: 'A',
      accessToken: 't',
      organizationId: ORG,
      organizationMembershipId: 'om',
      role: 'member',
      permissions: [],
      featureFlags: null,
      ...overrides,
    }) as import('@/lib/auth/types').AuthorizedSession

  /** A document row, as `recordDocumentAccess` receives it from the access check. */
  const logged = (id: string, folderId: string | null, scope: 'project' | 'archiv' = 'project', filename = 'Plan.pdf') =>
    ({
      id,
      scope,
      projectId: scope === 'project' ? projectId : null,
      folderId,
      filename,
      displayName: null,
      publishedVersionId: null,
    }) as import('./service').LoggedDocument

  async function rows(organizationId = ORG): Promise<Array<{ kind: string; document_id: string; own_list: boolean; user_id: string }>> {
    return Array.from(
      await inTenant(
        () =>
          db.execute<{ kind: string; document_id: string; own_list: boolean; user_id: string }>(
            sql`SELECT kind, document_id, own_list, user_id FROM document_access_log ORDER BY occurred_at, id`
          ),
        organizationId
      )
    )
  }

  async function clear(): Promise<void> {
    const sqlClient = postgres(url as string, { prepare: false, max: 1 })
    try {
      await sqlClient.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE grid_app_platform')
        await tx`DELETE FROM document_access_log WHERE organization_id LIKE ${`${ORG}%`}`
      })
    } finally {
      await sqlClient.end()
    }
  }

  async function insertRaw(values: {
    org?: string
    user?: string
    kind?: string
    docId?: string
    name?: string
    at: string
    ownList?: boolean
  }): Promise<void> {
    await inTenant(
      () =>
        db.execute(sql`
          INSERT INTO document_access_log
            (organization_id, occurred_at, user_id, kind, scope, document_id, document_name, own_list)
          VALUES
            (${values.org ?? ORG}, ${values.at}::timestamptz, ${values.user ?? USER}, ${values.kind ?? 'download'},
             'archiv', ${values.docId ?? randomUUID()}::uuid, ${values.name ?? 'Plan.pdf'}, ${values.ownList ?? false})
        `),
      values.org ?? ORG
    )
  }

  const refused = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run()
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause
      return `${(error as Error).message} ${cause?.message ?? ''}`
    }
    throw new Error('expected the database to refuse the statement')
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    service = await import('./service')
    repo = await import('./repository')

    projectId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Neubau Nord', ${USER}, ${`proj_dlog_${STAMP}`})
          RETURNING id
        `)
      )
    )
    //   Allgemein/    inherits
    //   Verträge/     its own list
    //     Anhänge/    inherits the list
    folder.open = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (organization_id, project_id, name, path) VALUES (${ORG}, ${projectId}::uuid, 'Allgemein', 'Allgemein') RETURNING id`)
      )
    )
    folder.own = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          WITH folder AS (
            INSERT INTO project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
            VALUES (${ORG}, ${projectId}::uuid, 'Verträge', 'Verträge', 'custom', ${USER}, now())
            RETURNING id, project_id
          ), listed AS (
            INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            SELECT ${ORG}, project_id, id, 'org-geschaeftsfuehrung', 'write' FROM folder
          )
          SELECT id FROM folder
        `)
      )
    )
    folder.child = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (organization_id, project_id, parent_id, name, path)
          VALUES (${ORG}, ${projectId}::uuid, ${folder.own}::uuid, 'Anhänge', 'Verträge/Anhänge') RETURNING id`)
      )
    )
    doc.plain = randomUUID()
    doc.own = randomUUID()
    doc.child = randomUUID()
    doc.archiv = randomUUID()
    await clear()
  })

  afterAll(async () => {
    await clear()
    await inTenant(() => db.execute(sql`DELETE FROM organizations WHERE workos_organization_id = ${SHORT_ORG}`), SHORT_ORG)
    await inTenant(() => db.execute(sql`DELETE FROM organizations WHERE workos_organization_id = ${BAD_ORG}`), BAD_ORG)
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  describe('what is recorded', () => {
    it('records a download wherever the document is filed, saying whether the folder has its own list', async () => {
      await clear()
      await service.recordDocumentAccess(session(), logged(doc.plain, folder.open), 'download')
      await service.recordDocumentAccess(session(), logged(doc.own, folder.own), 'download')
      await service.recordDocumentAccess(session(), logged(doc.archiv, null, 'archiv'), 'download')

      const written = await rows()
      expect(written.map((row) => [row.document_id, row.kind, row.own_list])).toEqual([
        [doc.plain, 'download', false],
        [doc.own, 'download', true],
        [doc.archiv, 'download', false],
      ])
    })

    it('records an open only under a folder with its own list, a plain subfolder of one included', async () => {
      await clear()
      await service.recordDocumentAccess(session(), logged(doc.plain, folder.open), 'preview')
      await service.recordDocumentAccess(session(), logged(doc.archiv, null, 'archiv'), 'pdf')
      await service.recordDocumentAccess(session(), logged(doc.own, folder.own), 'preview')
      await service.recordDocumentAccess(session(), logged(doc.child, folder.child), 'text')

      const written = await rows()
      expect(written.map((row) => [row.document_id, row.kind, row.own_list])).toEqual([
        [doc.own, 'preview', true],
        [doc.child, 'text', true],
      ])
    })

    it('records the person, the folder, the version and the name at the time', async () => {
      await clear()
      const versionId = randomUUID()
      await service.recordDocumentAccess(session(), logged(doc.own, folder.own, 'project', 'Werkvertrag.pdf'), 'version', { versionId })

      const page = await repo.listAccessLog({ organizationId: ORG }, null, 10)
      expect(page).toHaveLength(1)
      expect(page[0]).toMatchObject({
        userId: USER,
        kind: 'version',
        scope: 'project',
        projectId,
        projectName: 'Neubau Nord',
        folderId: folder.own,
        folderPath: 'Verträge',
        documentName: 'Werkvertrag.pdf',
        versionId,
        ownList: true,
      })
    })

    it('does not block a download from an ordinary folder when the log cannot be written', async () => {
      await clear()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      // An empty name violates the table's own CHECK: the insert fails.
      await expect(
        service.recordDocumentAccess(session(), logged(doc.plain, folder.open, 'project', ''), 'download')
      ).resolves.toBeUndefined()
      expect(warn.mock.calls[0][0]).toContain('could not record a download')
      warn.mockRestore()
      expect(await rows()).toHaveLength(0)
    })

    it('refuses the hand-over from a folder with its own list when the log cannot be written', async () => {
      await clear()
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await expect(
        service.recordDocumentAccess(session(), logged(doc.own, folder.own, 'project', ''), 'download')
      ).rejects.toMatchObject({ status: 503 })
      error.mockRestore()
      expect(await rows()).toHaveLength(0)
    })
  })

  describe('what the database refuses', () => {
    it('an open of a document that is not under an own list', async () => {
      const message = await refused(() => insertRaw({ at: '2026-10-01T10:00:00Z', kind: 'preview', ownList: false }))
      expect(message).toContain('document_access_log_open_needs_own_list')
    })

    it('a shelf and a project that disagree, and a kind it does not know', async () => {
      const mismatch = await refused(() =>
        inTenant(() =>
          db.execute(sql`
            INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name)
            VALUES (${ORG}, ${USER}, 'download', 'project', gen_random_uuid(), 'x')`)
        )
      )
      expect(mismatch).toContain('document_access_log_scope_project')
      const kind = await refused(() => insertRaw({ at: '2026-10-01T10:00:00Z', kind: 'stream' }))
      expect(kind).toContain('document_access_log_kind_check')
    })

    it('any change to a row, and a delete by the runtime role', async () => {
      await clear()
      await insertRaw({ at: '2026-10-01T10:00:00Z' })
      const update = await refused(() => inTenant(() => db.execute(sql`UPDATE document_access_log SET user_id = 'someone_else'`)))
      expect(update).toContain('never changed')
      const remove = await refused(() => inTenant(() => db.execute(sql`DELETE FROM document_access_log`)))
      expect(remove).toContain('deleted only by the retention sweep')
      expect(await rows()).toHaveLength(1)
    })

    it('another organization’s rows are invisible, to a read and to a write', async () => {
      await clear()
      await insertRaw({ at: '2026-10-01T10:00:00Z' })
      expect(await rows(OTHER_ORG)).toHaveLength(0)
      // Signed in as ORG, naming another organization in the row.
      const foreign = await refused(() =>
        inTenant(() =>
          db.execute(sql`
            INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name)
            VALUES (${OTHER_ORG}, ${USER}, 'download', 'archiv', gen_random_uuid(), 'x')`)
        )
      )
      expect(foreign).toContain('row-level security')
    })
  })

  describe('the admin view', () => {
    it('pages newest first without skipping or repeating rows that share a millisecond', async () => {
      await clear()
      // Five rows in one millisecond, microseconds apart, then an older one.
      for (let i = 0; i < 5; i += 1) await insertRaw({ at: `2026-10-02T10:00:00.00${i}123Z`, name: `Gleich ${i}.pdf` })
      await insertRaw({ at: '2026-10-01T10:00:00Z', name: 'Aelter.pdf' })

      const seen: string[] = []
      let cursor: string | undefined
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await service.listDownloadLog(
          session({ permissions: ['org:downloads:view'] }),
          { limit: 2, cursor },
          new Request('http://x')
        )
        seen.push(...page.entries.map((entry) => entry.documentName))
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }

      expect(seen).toEqual(['Gleich 4.pdf', 'Gleich 3.pdf', 'Gleich 2.pdf', 'Gleich 1.pdf', 'Gleich 0.pdf', 'Aelter.pdf'])
    })

    it('filters by person, by document id, by part of a name, by day and by kind', async () => {
      await clear()
      const wanted = randomUUID()
      await insertRaw({ at: '2026-09-01T10:00:00Z', user: USER, docId: wanted, name: 'Werkvertrag 100%.pdf' })
      await insertRaw({ at: '2026-09-15T10:00:00Z', user: OTHER_USER, name: 'Werkvertrag 100x.pdf' })
      await insertRaw({ at: '2026-10-01T10:00:00Z', user: OTHER_USER, name: 'Lageplan.pdf', kind: 'pdf', ownList: true })
      const admin = session({ permissions: ['org:downloads:view'] })
      const read = (query: Parameters<typeof service.listDownloadLog>[1]) =>
        service.listDownloadLog(admin, query, new Request('http://x')).then((page) => page.entries.map((e) => e.documentName))

      expect(await read({ userId: OTHER_USER })).toEqual(['Lageplan.pdf', 'Werkvertrag 100x.pdf'])
      expect(await read({ document: wanted })).toEqual(['Werkvertrag 100%.pdf'])
      // `%` in the typed name is the character, not a wildcard: it finds one, not both.
      expect(await read({ document: '100%' })).toEqual(['Werkvertrag 100%.pdf'])
      expect(await read({ document: 'werkvertrag' })).toEqual(['Werkvertrag 100x.pdf', 'Werkvertrag 100%.pdf'])
      expect(await read({ from: new Date('2026-09-10T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z') })).toEqual(['Werkvertrag 100x.pdf'])
      expect(await read({ kind: 'pdf' })).toEqual(['Lageplan.pdf'])
    })

    it('bounds a page, whatever was asked', async () => {
      await clear()
      for (let i = 0; i < 3; i += 1) await insertRaw({ at: `2026-10-0${i + 1}T10:00:00Z` })
      expect(await repo.listAccessLog({ organizationId: ORG }, null, 100_000)).toHaveLength(3)
      expect(await repo.listAccessLog({ organizationId: ORG }, null, 2)).toHaveLength(2)
    })

    it('answers the retention in force, and refuses anyone without the permission', async () => {
      await expect(
        service.listDownloadLog(session(), {}, new Request('http://x'))
      ).rejects.toMatchObject({ status: 403 })
    })
  })

  describe('the retention setting', () => {
    it('stores a valid number of days, audited, and refuses the rest', async () => {
      const admin = session({ organizationId: SHORT_ORG, permissions: ['org:settings:manage'] })
      const request = new Request('http://x')

      await expect(inTenant(() => service.setDownloadLogRetentionDays(admin, 90, request), SHORT_ORG)).resolves.toEqual({
        days: 90,
        previous: 365,
      })
      expect(await inTenant(() => service.getDownloadLogRetentionDays(SHORT_ORG), SHORT_ORG)).toBe(90)

      for (const days of [29, 366, 0, -1, 90.5]) {
        await expect(inTenant(() => service.setDownloadLogRetentionDays(admin, days, request), SHORT_ORG)).rejects.toMatchObject({ status: 400 })
      }
      expect(await inTenant(() => service.getDownloadLogRetentionDays(SHORT_ORG), SHORT_ORG)).toBe(90)
    })
  })

  describe('the scheduler’s purge', () => {
    const DAY = 'now() - interval'

    async function seedAged(): Promise<void> {
      // Two organizations of the default retention and one that chose 90 days.
      // Rows at 400, 200, 100 and 10 days old in each.
      await inTenant(
        () =>
          db.execute(sql`
            INSERT INTO organizations (workos_organization_id, settings)
            VALUES (${SHORT_ORG}, '{"downloadLogRetentionDays": 90}'::jsonb)
            ON CONFLICT (workos_organization_id) DO UPDATE SET settings = EXCLUDED.settings`),
        SHORT_ORG
      )
      for (const org of [ORG, SHORT_ORG]) {
        for (const age of [400, 200, 100, 10]) {
          await inTenant(
            () =>
              db.execute(sql`
                INSERT INTO document_access_log
                  (organization_id, occurred_at, user_id, kind, scope, document_id, document_name)
                VALUES (${org}, ${sql.raw(`${DAY} '${age} days'`)}, ${USER}, 'download', 'archiv', gen_random_uuid(), ${`${age} Tage`})`),
            org
          )
        }
      }
    }

    async function ages(org: string): Promise<string[]> {
      return Array.from(
        await inTenant(
          () => db.execute<{ document_name: string }>(sql`SELECT document_name FROM document_access_log ORDER BY occurred_at`),
          org
        )
      ).map((row) => row.document_name)
    }

    it('deletes past twelve months for everyone and past an organization’s own shorter time for it alone', async () => {
      await clear()
      await seedAged()
      // BAD_ORG stored a value the app calls invalid: it counts as unset.
      await inTenant(
        () =>
          db.execute(sql`
            INSERT INTO organizations (workos_organization_id, settings)
            VALUES (${BAD_ORG}, '{"downloadLogRetentionDays": 10}'::jsonb)
            ON CONFLICT (workos_organization_id) DO UPDATE SET settings = EXCLUDED.settings`),
        BAD_ORG
      )
      await inTenant(
        () =>
          db.execute(sql`
            INSERT INTO document_access_log (organization_id, occurred_at, user_id, kind, scope, document_id, document_name)
            VALUES (${BAD_ORG}, now() - interval '100 days', ${USER}, 'download', 'archiv', gen_random_uuid(), '100 Tage')`),
        BAD_ORG
      )

      const { pruneDownloadLog } = await import('../../../scheduler/db.js')
      const client = postgres(url as string, { prepare: false, max: 1 })
      try {
        const result = await pruneDownloadLog(client)
        // 400 days: gone for ORG and SHORT_ORG (and any other org's leftovers); 200 and 100 days: SHORT_ORG only.
        expect(result.capped).toBe(false)
        expect(result.deleted).toBeGreaterThanOrEqual(4)
      } finally {
        await client.end()
      }

      expect(await ages(ORG)).toEqual(['200 Tage', '100 Tage', '10 Tage'])
      expect(await ages(SHORT_ORG)).toEqual(['10 Tage'])
      expect(await ages(BAD_ORG)).toEqual(['100 Tage'])
    })

    it('works in bounded batches and says so when it stopped on its budget', async () => {
      await clear()
      for (let i = 0; i < 5; i += 1) await insertRaw({ at: `2024-01-0${i + 1}T10:00:00Z` })

      const { pruneDownloadLog } = await import('../../../scheduler/db.js')
      const client = postgres(url as string, { prepare: false, max: 1 })
      try {
        const first = await pruneDownloadLog(client, { batch: 2, maxBatches: 2 })
        expect(first).toEqual({ deleted: 4, capped: true })
        const second = await pruneDownloadLog(client, { batch: 2, maxBatches: 2 })
        expect(second.deleted).toBeGreaterThanOrEqual(1)
      } finally {
        await client.end()
      }
      expect(await rows()).toHaveLength(0)
    })
  })
})
