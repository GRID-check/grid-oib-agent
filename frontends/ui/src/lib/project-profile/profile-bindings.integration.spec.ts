/**
 * @vitest-environment node
 *
 * A profile save and the bindings of the buildings it removes, against a REAL
 * Postgres, through the restricted runtime role.
 *
 * The unit specs show the cleanup is handed to the versioned update; only a
 * database can show that it commits with the profile or not at all, and that
 * the row lock a building binding takes is one the runtime role may take under
 * row-level security, and only on its own tenant's project. Runs under
 * `task db:test:rls`:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/project-profile/profile-bindings.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_profilebind_${Date.now()}`
const OTHER_ORG = `${ORG}_other`
const USER = 'user_profilebind'

describe.skipIf(!url)('profile saves and building bindings against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let projects: typeof import('@/lib/projects/repository')
  let roles: typeof import('@/lib/document-roles/repository')
  let projectId: string

  const inTenant = <T>(run: () => Promise<T>, organizationId = ORG): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)

  /** A profile naming exactly these buildings. */
  function profileWith(ids: string[]) {
    const facts: Record<string, unknown> = {}
    for (const id of ids) {
      facts[`bauwerk_name@${id}`] = {
        value: id,
        confidence: 'confirmed',
        source: 'onboarding',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
    }
    return { facts, goals: {}, unknowns: [], assumptions: {} }
  }

  async function bindingScopes(): Promise<string[]> {
    const rows = await inTenant(async () =>
      Array.from(
        await db.execute<{ scope: string }>(sql`
          SELECT scope_instance_id AS scope FROM document_roles
          WHERE project_id = ${projectId}::uuid ORDER BY scope_instance_id
        `)
      )
    )
    return rows.map((row) => String(row.scope))
  }

  async function profileVersion(): Promise<number> {
    const rows = await inTenant(async () =>
      Array.from(
        await db.execute<{ v: number }>(sql`SELECT profile_version AS v FROM projects WHERE id = ${projectId}::uuid`)
      )
    )
    return Number(rows[0].v)
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    db = (await import('@/lib/db')).getDb()
    projects = await import('@/lib/projects/repository')
    roles = await import('@/lib/document-roles/repository')

    const created = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name, profile)
        VALUES (${ORG}, 'Bindings', ${USER}, 'coll_profilebind',
                ${JSON.stringify(profileWith(['bw1', 'bw2']))}::jsonb)
        RETURNING id
      `)
    )
    projectId = String(Array.from(created)[0].id)
    for (const [index, scope] of ['bw1', 'bw2'].entries()) {
      await inTenant(async () => {
        const [doc] = Array.from(
          await db.execute<{ id: string }>(sql`
            INSERT INTO documents
              (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
            VALUES (${ORG}, ${USER}, ${`plan-${index}.pdf`}, ${`k/profilebind/${index}`}, 'coll_profilebind',
                    'completed', 'project', ${projectId}::uuid)
            RETURNING id
          `)
        )
        await db.execute(sql`
          INSERT INTO document_roles
            (organization_id, project_id, document_id, role, scope_instance_id, confidence, source, created_by)
          VALUES (${ORG}, ${projectId}::uuid, ${doc.id}::uuid, 'bestandsplan', ${scope}, 'declared', 'user', ${USER})
        `)
      })
    }
  }, 60_000)

  afterAll(async () => {
    if (!db) return
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`DELETE FROM document_roles WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('takes the project lock under row-level security, on its own tenant only', async () => {
    const own = await inTenant(() =>
      db.transaction((tx) => projects.lockProjectProfile(tx, projectId))
    )
    expect(own).not.toBeNull()

    // The same id from another tenant: no row, so no lock and no profile.
    const foreign = await inTenant(
      () => db.transaction((tx) => projects.lockProjectProfile(tx, projectId)),
      OTHER_ORG
    )
    expect(foreign).toBeNull()
  })

  it('rolls the profile back when the cleanup in its transaction fails', async () => {
    const before = await profileVersion()
    const values = (await inTenant(() => projects.findProjectProfileInOrg(projectId, ORG)))!

    await expect(
      projects.updateProjectProfileIfVersion(
        projectId,
        ORG,
        before,
        { ...values, profile: profileWith(['bw1']) as never, profileVersion: before + 1 },
        async () => {
          throw new Error('cleanup failed')
        }
      )
    ).rejects.toThrow('cleanup failed')

    expect(await profileVersion()).toBe(before)
    expect(await bindingScopes()).toEqual(['bw1', 'bw2'])
  })

  it('commits the profile and the removed building’s bindings together', async () => {
    const before = await profileVersion()
    const values = (await inTenant(() => projects.findProjectProfileInOrg(projectId, ORG)))!

    const saved = await projects.updateProjectProfileIfVersion(
      projectId,
      ORG,
      before,
      { ...values, profile: profileWith(['bw1']) as never, profileVersion: before + 1 },
      async (tx) => {
        await roles.deleteBindingsOutsideBauwerke(projectId, ['bw1'], tx)
      }
    )

    expect(saved?.profileVersion).toBe(before + 1)
    expect(await bindingScopes()).toEqual(['bw1'])
  })
})
