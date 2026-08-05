/**
 * Opt-in integration test: the tenant boundary, exercised through the REAL
 * `getDb()` against a REAL Postgres with every migration applied (ADR-0041).
 *
 * Unit tests can show that the context is plumbed. Only this can show that the
 * database refuses, which is the entire claim. It therefore connects as
 * `grid_app_rw` — the role the BFF actually runs as — because connecting as the
 * owner would pass every assertion below while proving nothing: owners are
 * exempt from row-level security.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/db/tenant-isolation.integration.spec.ts
 *
 * Setting up that database is `task db:test:rls` (see Taskfile.yml), which
 * builds a throwaway cluster, applies the migration chain and runs this file.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const ORG_A = `org_rls_a_${Date.now()}`
const ORG_B = `org_rls_b_${Date.now()}`

/**
 * drizzle wraps every driver failure in a `DrizzleQueryError` whose message is
 * just "Failed query: …", so the refusal we care about — the Postgres error, or
 * our own `MissingTenantContextError` — is one or more links down `.cause`.
 * Asserting on the wrapper would pass for ANY failed query, including a typo.
 */
function rootCause(error: unknown): Error {
  let current = error as Error
  while (current?.cause instanceof Error) current = current.cause
  return current
}

/** Await a promise that must reject, and return the underlying reason. */
async function rejectionCause(run: () => PromiseLike<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    return rootCause(error)
  }
  throw new Error('expected the query to be refused, but it succeeded')
}

describe.skipIf(!url)('tenant isolation against live Postgres', () => {
  let db: Awaited<ReturnType<typeof loadDb>>
  let withTenant: typeof import('./tenant-context').withTenant
  let withPlatformAccess: typeof import('./tenant-context').withPlatformAccess
  let MissingTenantContextError: typeof import('./tenant-context').MissingTenantContextError

  async function loadDb() {
    const { getDb } = await import('./index')
    return getDb()
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('./tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    MissingTenantContextError = context.MissingTenantContextError
    db = await loadDb()

    // Seed both tenants. Writing rows for org B from inside org B's own context
    // is itself part of the contract: WITH CHECK has to accept a row that
    // matches the active tenant.
    for (const org of [ORG_A, ORG_B]) {
      await withPlatformAccess('test seed: create organizations across tenants', async () => {
        await db.execute(
          sql`insert into organizations (workos_organization_id, display_name) values (${org}, ${org}) on conflict do nothing`
        )
      })
      await withTenant({ organizationId: org, userId: `user_${org}` }, async () => {
        await db.execute(
          sql`insert into projects (organization_id, name, created_by, collection_name)
              values (${org}, ${'project of ' + org}, ${'user_' + org}, ${'coll_' + org})`
        )
      })
    }
  })

  afterAll(async () => {
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from projects where organization_id in (${ORG_A}, ${ORG_B})`)
      await db.execute(
        sql`delete from organizations where workos_organization_id in (${ORG_A}, ${ORG_B})`
      )
    })
    const { closeDb } = await import('./index')
    await closeDb()
  })

  /**
   * The cheapest test here, and the one that would have caught the worst bug in
   * this feature's history: a policy on `project_folders` that referenced
   * `project_folders` is rejected by Postgres outright —
   * "infinite recursion detected in policy" — and because `documents`' policy
   * joined that table, BOTH were completely unreadable for the runtime role.
   * Every other test passed, because none of them touched those two tables.
   *
   * So: every secured table, selected as the role the app actually uses. Not a
   * sample.
   */
  it('can SELECT from every table inside the boundary', async () => {
    const secured = await withPlatformAccess('test: enumerate secured tables', () =>
      db.execute(sql`
        SELECT c.relname AS table_name
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        WHERE p.polname = 'grid_tenant_isolation'
          AND c.relnamespace = 'public'::regnamespace
        ORDER BY 1
      `)
    )
    const names = [...secured].map((row) => String(row.table_name))
    expect(names.length).toBeGreaterThanOrEqual(28)

    const broken: Array<{ table: string; error: string }> = []
    for (const table of names) {
      try {
        await withTenant({ organizationId: ORG_A, userId: `user_${ORG_A}` }, () =>
          db.execute(sql.raw(`SELECT count(*) FROM "${table}"`))
        )
      } catch (error) {
        broken.push({ table, error: rootCause(error).message })
      }
    }

    expect(broken, 'These tables are inside the boundary but cannot be read.').toEqual([])
  })

  /**
   * The reason this feature exists. The query has NO tenant predicate — it is
   * the mistake a repository makes when someone forgets the WHERE clause — and
   * it still cannot see another tenant's rows.
   */
  it('confines a query that forgot its WHERE clause to the active tenant', async () => {
    const fromA = await withTenant({ organizationId: ORG_A }, () =>
      db.execute(sql`select organization_id from projects`)
    )
    const fromB = await withTenant({ organizationId: ORG_B }, () =>
      db.execute(sql`select organization_id from projects`)
    )

    expect([...fromA].map((row) => row.organization_id)).toEqual([ORG_A])
    expect([...fromB].map((row) => row.organization_id)).toEqual([ORG_B])
  })

  it('refuses to write a row belonging to another tenant', async () => {
    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into projects (organization_id, name, created_by, collection_name)
              values (${ORG_B}, 'planted', 'attacker', 'c')`
        )
      )
    )
    expect(cause.message).toMatch(/row-level security/i)
  })

  it('updates and deletes nothing in another tenant', async () => {
    await withTenant({ organizationId: ORG_A }, async () => {
      await db.execute(sql`update projects set name = 'overwritten' where organization_id = ${ORG_B}`)
      await db.execute(sql`delete from projects where organization_id = ${ORG_B}`)
    })

    const survived = await withTenant({ organizationId: ORG_B }, () =>
      db.execute(sql`select name from projects`)
    )
    expect([...survived].map((row) => row.name)).toEqual([`project of ${ORG_B}`])
  })

  /**
   * `SET LOCAL` is a UTILITY statement; `SELECT set_config(...)` is a query, and
   * Postgres refuses `SET TRANSACTION ISOLATION LEVEL` after any query. So an
   * earlier version of the context broke isolation levels for tenant scopes
   * while leaving the platform path (already `SET LOCAL ROLE`) working — the
   * kind of asymmetry that hides for a long time.
   */
  it('still allows an isolation level to be set on the transaction', async () => {
    const rows = await withTenant({ organizationId: ORG_A }, () =>
      db.transaction((tx) => tx.execute(sql`select organization_id from projects`), {
        isolationLevel: 'serializable',
      })
    )
    expect([...rows].map((row) => row.organization_id)).toEqual([ORG_A])
  })

  it('refuses a setting value that is not a plain identifier', async () => {
    // `SET LOCAL` takes no bind parameters, so the value is interpolated. It is
    // validated rather than escaped: anything that could carry quoting fails
    // closed instead of reaching the server.
    const cause = await rejectionCause(() =>
      withTenant({ organizationId: "org_a'; drop table projects; --" }, () =>
        db.execute(sql`select 1`)
      )
    )
    expect(cause.message).toMatch(/not a plain identifier/i)
  })

  it('carries the context through an explicit transaction', async () => {
    const rows = await withTenant({ organizationId: ORG_A }, () =>
      db.transaction((tx) => tx.execute(sql`select organization_id from projects`))
    )
    expect([...rows].map((row) => row.organization_id)).toEqual([ORG_A])
  })

  it('reaches every tenant under an explicit platform bypass, as the platform role', async () => {
    const rows = await withPlatformAccess('test: cross-tenant read', () =>
      db.execute(
        sql`select current_user as role, count(*)::int as n from projects
            where organization_id in (${ORG_A}, ${ORG_B}) group by 1`
      )
    )
    expect([...rows][0]).toMatchObject({ role: 'grid_app_platform', n: 2 })
  })

  it('rejects database access with no context at all', async () => {
    const cause = await rejectionCause(() => db.execute(sql`select 1`))
    expect(cause).toBeInstanceOf(MissingTenantContextError)
  })

  it('does not leak the context to work that follows it', async () => {
    await withTenant({ organizationId: ORG_A }, async () => {
      await db.execute(sql`select 1`)
    })
    // A pooled connection is reused; transaction-local settings must not ride
    // along to whoever borrows it next.
    const cause = await rejectionCause(() => db.execute(sql`select 1`))
    expect(cause).toBeInstanceOf(MissingTenantContextError)
  })

  it('lets a tenant read platform configuration but never write it', async () => {
    await withTenant({ organizationId: ORG_A }, async () => {
      await expect(
        db.execute(sql`select count(*) from platform_model_defaults`)
      ).resolves.toBeDefined()
    })
    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_A }, () =>
        db.execute(sql`insert into platform_model_defaults (agent_group, model) values ('x', 'y')`)
      )
    )
    expect(cause.message).toMatch(/permission denied/i)
  })

  /**
   * A row's own organization_id is not the whole rule. Nothing stopped a tenant
   * from REFERENCING another tenant's row, and the FKs cascade: org A could
   * attach its conversation to org B's project, and org B deleting that project
   * — an ordinary, authorised action — would destroy org A's data. The policies
   * validate the referenced row's organization for exactly this reason.
   */
  it('refuses to reference another tenant\'s row', async () => {
    const [projectOfB] = [
      ...(await withTenant({ organizationId: ORG_B }, () =>
        db.execute(sql`select id from projects where organization_id = ${ORG_B}`)
      )),
    ]

    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into conversations (id, organization_id, created_by, project_id)
              values (${'conv_cross_' + ORG_A}, ${ORG_A}, 'u', ${projectOfB.id})`
        )
      )
    )
    expect(cause.message).toMatch(/row-level security/i)
  })

  it('refuses to re-point an existing row at another tenant', async () => {
    const [projectOfB] = [
      ...(await withTenant({ organizationId: ORG_B }, () =>
        db.execute(sql`select id from projects where organization_id = ${ORG_B}`)
      )),
    ]
    const conversationId = `conv_repoint_${ORG_A}`

    await withTenant({ organizationId: ORG_A }, async () => {
      const [own] = [
        ...(await db.execute(sql`select id from projects where organization_id = ${ORG_A}`)),
      ]
      await db.execute(
        sql`insert into conversations (id, organization_id, created_by, project_id)
            values (${conversationId}, ${ORG_A}, 'u', ${own.id})`
      )
    })

    // The UPDATE that used to be accepted: the row keeps its own organization,
    // but the project underneath it becomes another tenant's. WITH CHECK now
    // rejects it outright rather than letting it through.
    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`update conversations set project_id = ${projectOfB.id} where id = ${conversationId}`
        )
      )
    )
    expect(cause.message).toMatch(/row-level security/i)

    const survived = await withPlatformAccess('test: verify no cross-tenant link', () =>
      db.execute(
        sql`select p.organization_id as owner
            from conversations c join projects p on p.id = c.project_id
            where c.id = ${conversationId}`
      )
    )
    expect([...survived][0]?.owner).toBe(ORG_A)

    await withPlatformAccess('test cleanup', () =>
      db.execute(sql`delete from conversations where id = ${conversationId}`)
    )
  })

  it('isolates child tables through their parent', async () => {
    const conversationId = `conv_${ORG_A}`
    await withTenant({ organizationId: ORG_A }, async () => {
      const [project] = [
        ...(await db.execute(sql`select id from projects where organization_id = ${ORG_A}`)),
      ]
      await db.execute(
        sql`insert into conversations (id, organization_id, created_by, project_id)
            values (${conversationId}, ${ORG_A}, 'u', ${project.id})`
      )
      await db.execute(
        sql`insert into messages (conversation_id, role, content)
            values (${conversationId}, 'user', 'private to A')`
      )
    })

    // `messages` has no organization_id of its own; the policy resolves tenancy
    // through the parent conversation.
    const seenByB = await withTenant({ organizationId: ORG_B }, () =>
      db.execute(sql`select content from messages`)
    )
    expect([...seenByB]).toEqual([])

    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_B }, () =>
        db.execute(
          sql`insert into messages (conversation_id, role, content)
              values (${conversationId}, 'user', 'planted by B')`
        )
      )
    )
    expect(cause.message).toMatch(/row-level security/i)

    await withPlatformAccess('test cleanup', async () => {
      await db.execute(sql`delete from messages where conversation_id = ${conversationId}`)
      await db.execute(sql`delete from conversations where id = ${conversationId}`)
    })
  })
})
