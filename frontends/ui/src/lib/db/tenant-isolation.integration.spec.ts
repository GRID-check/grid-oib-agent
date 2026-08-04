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
