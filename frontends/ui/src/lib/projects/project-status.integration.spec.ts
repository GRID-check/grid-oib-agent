/**
 * @vitest-environment node
 *
 * A closed project (ADR-0090, migration 0116) against a REAL Postgres, through
 * the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/project-status.integration.spec.ts
 *
 * What only the database can prove: that closing and reopening never open a
 * folder with its own role list (the real tree, the real rule, the real listing
 * SQL), that the status CHECKs hold, and that the 0115 trigger refuses an insert
 * into a closed project while an update still goes through. WorkOS is the only
 * thing stubbed: who holds which organization role, and who holds a grant on
 * the project.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_CLOSED_SQLSTATE } from './project-status'

vi.mock('server-only', () => ({}))

/** Organization roles per user, as WorkOS would report them. */
const ROLES: Record<string, string[]> = {
  user_member: ['org-geschaeftsfuehrung'],
  user_outsider: ['org-geschaeftsfuehrung'],
  user_plain: ['member'],
}
/** Who holds an FGA grant on the project. */
const PROJECT_MEMBERS = new Set(['om_member'])

vi.mock('@/lib/auth/membership-roles', () => ({
  resolveMembershipRoles: vi.fn(async (_org: string, userId: string) => ROLES[userId] ?? null),
}))
vi.mock('@/lib/authz/org-role-permissions', () => ({ orgRoleHoldsPermission: vi.fn(async () => false) }))
vi.mock('@/lib/authz/project-membership', () => ({
  resolveSubjectMembership: vi.fn(async (_org: string, userId: string) => ({
    organizationMembershipId: userId.replace('user_', 'om_'),
    role: 'member',
  })),
}))
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    authorization: {
      check: vi.fn(async ({ organizationMembershipId }: { organizationMembershipId: string }) => ({
        authorized: PROJECT_MEMBERS.has(organizationMembershipId),
      })),
    },
  }),
}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_closed_${STAMP}`
const COLLECTION = `proj_closed_${STAMP}`
const USER = 'user_member'

describe.skipIf(!url)('a closed project against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let access: typeof import('@/lib/authz/folder-access')
  let authz: typeof import('@/lib/authz/projects')
  let repo: typeof import('./repository')
  let documentsRepo: typeof import('@/lib/documents/repository')
  let projectId: string
  const folder = { vertraege: '', plaene: '', verwaltung: '' }

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)
  const session = (who: 'member' | 'outsider' | 'plain') => ({
    userId: `user_${who}`,
    email: `${who}@buero.at`,
    name: who,
    accessToken: 'token',
    organizationId: ORG,
    organizationMembershipId: `om_${who}`,
    role: 'member',
    roles: ROLES[`user_${who}`],
    permissions: [],
    featureFlags: null,
  })

  async function insertFolder(name: string, grants: Array<[string, 'read' | 'write']> | null) {
    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        WITH folder AS (
          INSERT INTO project_folders (organization_id, project_id, parent_id, name, path, access_mode, access_changed_by, access_changed_at)
          VALUES (${ORG}, ${projectId}::uuid, NULL, ${name}, ${name}, ${grants ? 'custom' : 'inherit'},
                  ${grants ? USER : null}, ${grants ? new Date().toISOString() : null}::timestamptz)
          RETURNING id, project_id
        ), listed AS (
          INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          SELECT ${ORG}, folder.project_id, folder.id, grant_row.role_slug, grant_row.level
          FROM folder, jsonb_to_recordset(${JSON.stringify((grants ?? []).map(([role_slug, level]) => ({ role_slug, level })))}::jsonb)
            AS grant_row(role_slug text, level text)
        )
        SELECT id FROM folder
      `)
    )
    return firstId(rows)
  }

  const insertDocument = (filename: string, folderId: string | null, collection = COLLECTION) =>
    inTenant(() =>
      db.execute(sql`
        INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
        VALUES (${ORG}, ${USER}, ${filename}, ${`k/${STAMP}/${filename}`}, ${collection}, 'completed', 'project', ${projectId}::uuid, ${folderId}::uuid)
      `)
    )

  /** The file names a session's own folder access lets it list, through the real listing SQL. */
  async function listedFor(who: 'member' | 'outsider' | 'plain'): Promise<string[]> {
    const folderAccess = await access.getProjectFolderAccess(session(who), projectId, COLLECTION)
    const page = await documentsRepo.listProjectDocumentPage(projectId, ORG, {
      hiddenFolderIds: [...folderAccess.hiddenFolderIds],
    })
    return page.rows.map((row) => row.filename).sort()
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    process.env.GRID_AUTHZ_CACHE_TTL_MS = '0'
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    access = await import('@/lib/authz/folder-access')
    authz = await import('@/lib/authz/projects')
    repo = await import('./repository')
    documentsRepo = await import('@/lib/documents/repository')

    projectId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Seestadt D12', ${USER}, ${COLLECTION}) RETURNING id
        `)
      )
    )
    //   Verträge/   Geschäftsführung: write   (restricted, its own collection)
    //   Pläne/      *: read                    (every project member)
    //   Verwaltung/ inherits
    folder.vertraege = await insertFolder('Verträge', [['org-geschaeftsfuehrung', 'write']])
    folder.plaene = await insertFolder('Pläne', [['*', 'read']])
    folder.verwaltung = await insertFolder('Verwaltung', null)
    await insertDocument('Lageplan.pdf', null)
    await insertDocument('Einreichplan.pdf', folder.plaene)
    await insertDocument('Protokoll.pdf', folder.verwaltung)
    await insertDocument('Werkvertrag.pdf', folder.vertraege, access.restrictedCollectionName(COLLECTION, folder.vertraege))
  })

  beforeEach(async () => {
    // Every test starts from an active project.
    await repo.setProjectStatusInOrg(projectId, ORG, { status: 'active' })
  })

  afterAll(async () => {
    await repo.setProjectStatusInOrg(projectId, ORG, { status: 'active' })
    await inTenant(() => db.execute(sql`DELETE FROM project_memory WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  const close = () => repo.setProjectStatusInOrg(projectId, ORG, { status: 'closed', closedBy: USER, at: new Date() })

  it('closes once and reopens once, stamping and clearing who and when', async () => {
    const closed = await close()
    expect(closed).toMatchObject({ status: 'closed', closedBy: USER })
    expect(closed?.closedAt).toBeInstanceOf(Date)
    expect(await close()).toBeNull()

    const reopened = await repo.setProjectStatusInOrg(projectId, ORG, { status: 'active' })
    expect(reopened).toMatchObject({ status: 'active', closedAt: null, closedBy: null })
    expect(await repo.setProjectStatusInOrg(projectId, ORG, { status: 'active' })).toBeNull()
  })

  it('refuses a status that is not one, and a closed row that does not say when and by whom', async () => {
    await expect(inTenant(() => db.execute(sql`UPDATE projects SET status = 'archived' WHERE id = ${projectId}::uuid`))).rejects.toThrow()
    await expect(
      inTenant(() =>
        db.execute(sql`UPDATE projects SET status = 'closed', closed_at = now(), closed_by = NULL WHERE id = ${projectId}::uuid`)
      )
    ).rejects.toThrow()
    await expect(
      inTenant(() =>
        db.execute(sql`UPDATE projects SET status = 'active', closed_at = now(), closed_by = ${USER} WHERE id = ${projectId}::uuid`)
      )
    ).rejects.toThrow()
  })

  it('opens the project to an organization member who holds no grant on it, as a reader', async () => {
    await expect(authz.requireProjectAccess(session('outsider'), projectId, 'project:view')).rejects.toMatchObject({ status: 404 })
    await close()
    await expect(authz.requireProjectAccess(session('outsider'), projectId, 'project:view')).resolves.toEqual({
      role: 'project-viewer',
      closed: true,
      readsBecauseClosed: true,
    })
    await expect(
      authz.requireProjectAccess(session('member'), projectId, ['project:documents:write', 'project:edit'])
    ).rejects.toMatchObject({ status: 403, details: { reason: 'project-closed' } })
  })

  it('never opens a folder with its own role list: not by closing, not by reopening', async () => {
    const before = {
      member: await listedFor('member'),
      outsider: await listedFor('outsider'),
      plain: await listedFor('plain'),
    }
    expect(before.member).toEqual(['Einreichplan.pdf', 'Lageplan.pdf', 'Protokoll.pdf', 'Werkvertrag.pdf'])

    await close()
    // The member keeps exactly what their role gave them.
    expect(await listedFor('member')).toEqual(before.member)
    // The outsider holds the very role Verträge grants, and still does not see it.
    expect(await listedFor('outsider')).toEqual(['Einreichplan.pdf', 'Lageplan.pdf', 'Protokoll.pdf'])
    expect(await listedFor('plain')).toEqual(['Einreichplan.pdf', 'Lageplan.pdf', 'Protokoll.pdf'])
    const outsider = await access.getProjectFolderAccess(session('outsider'), projectId, COLLECTION)
    expect(outsider.clearedRestrictedCollections).toEqual([])
    expect(await access.isFolderVisibleToMember(ORG, projectId, folder.vertraege, 'user_outsider')).toBe(false)
    expect(await access.isFolderVisibleToMember(ORG, projectId, folder.vertraege, 'user_member')).toBe(true)

    await repo.setProjectStatusInOrg(projectId, ORG, { status: 'active' })
    expect(await listedFor('member')).toEqual(before.member)
    await expect(authz.requireProjectAccess(session('outsider'), projectId, 'project:view')).rejects.toMatchObject({ status: 404 })
  })

  it('refuses an insert into a closed project (SQLSTATE GPC01), and still lets an update through', async () => {
    await close()
    /** The SQLSTATE of a failed query: drizzle wraps the driver's error as `cause`. */
    const sqlstate = (error: unknown): unknown => {
      for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
        const code = (current as { code?: unknown }).code
        if (code) return code
      }
      return null
    }
    const refused = async (statement: Promise<unknown>) => {
      const error = await statement.then(() => null, (failure: unknown) => failure)
      expect(sqlstate(error)).toBe(PROJECT_CLOSED_SQLSTATE)
    }

    await refused(insertDocument('Nachtrag.pdf', null))
    await refused(insertFolder('Neu', null))
    await refused(
      inTenant(() =>
        db.execute(sql`
          INSERT INTO project_memory (scope, project_id, organization_id, kind, content)
          VALUES ('project', ${projectId}::uuid, ${ORG}, 'decision', 'Neu')
        `)
      )
    )
    // Ingestion finishing for a file uploaded before the close is an update.
    await inTenant(() => db.execute(sql`UPDATE documents SET status = 'completed' WHERE project_id = ${projectId}::uuid`))

    await repo.setProjectStatusInOrg(projectId, ORG, { status: 'active' })
    await insertDocument('Nachtrag.pdf', null)
  })
})
