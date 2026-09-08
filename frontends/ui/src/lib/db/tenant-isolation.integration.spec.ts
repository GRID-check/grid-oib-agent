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

/**
 * The suite below is opt-in, and `describe.skipIf` exits 0 when it skips. That
 * makes a green `tenant-isolation` job indistinguishable from one that ran
 * nothing — a typo'd variable, a renamed script or a dropped `env:` line would
 * silently remove every isolation guarantee from the merge gate. This asserts
 * the suite actually ran.
 *
 * The trigger is deliberately NOT `CI`: this file is part of the ordinary unit
 * suite too, and the six unit shards run in CI with no database anywhere near
 * them, so keying on `CI` fails whichever shard happens to own this file. The
 * marker is set by the `tenant-isolation` JOB rather than by
 * `scripts/rls-test-db.sh`, so that the job — the thing wired into the merge
 * gate — is what demands a database, and a harness that stops handing one over
 * still fails here instead of quietly skipping.
 */
describe('the isolation suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(
      url,
      'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set, so ' +
        'the tenant-isolation suite skipped and nothing verified the boundary. ' +
        'Check `task db:test:rls`.'
    ).toBeTruthy()
  })
})

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
    // `beforeAll` may have thrown before `db` was assigned. Cleaning up then
    // raises a TypeError that REPLACES the real setup failure in the output,
    // which is the one worth reading.
    if (!db) return
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

    // The one documented exception set: the lesson tables are secured AND
    // deliberately unreadable for the tenant role (0068 revokes the platform
    // helper's SELECT — see the migration's comment). Their posture has its
    // own test below ('hides the lesson tables from tenants entirely'), which
    // fails if the revoke disappears, so excluding them here does not leave
    // them untested — it leaves them tested for the OPPOSITE claim.
    const tenantInvisible = new Set([
      'platform_lessons',
      'platform_lesson_reports',
      'platform_lesson_events',
    ])

    const broken: Array<{ table: string; error: string }> = []
    for (const table of names.filter((name) => !tenantInvisible.has(name))) {
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

  it('isolates rows keyed to a person, not an organization', async () => {
    // `user_preferences` is the only table whose rule is grid.user_id. Both the
    // policy and the app-side SET LOCAL for that setting could be deleted with
    // a green suite before this existed.
    await withTenant({ organizationId: ORG_A, userId: 'user_one' }, () =>
      db.execute(
        sql`insert into user_preferences (workos_user_id, prefs) values ('user_one', '{"a":1}')
            on conflict do nothing`
      )
    )

    const asOwner = await withTenant({ organizationId: ORG_A, userId: 'user_one' }, () =>
      db.execute(sql`select workos_user_id from user_preferences`)
    )
    expect([...asOwner].map((row) => row.workos_user_id)).toEqual(['user_one'])

    const asOther = await withTenant({ organizationId: ORG_A, userId: 'user_two' }, () =>
      db.execute(sql`select workos_user_id from user_preferences`)
    )
    expect([...asOther]).toEqual([])

    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_A, userId: 'user_one' }, () =>
        db.execute(
          sql`insert into user_preferences (workos_user_id, prefs) values ('user_two', '{"b":2}')`
        )
      )
    )
    expect(cause.message).toMatch(/row-level security/i)

    await withPlatformAccess('test cleanup', () =>
      db.execute(sql`delete from user_preferences where workos_user_id in ('user_one','user_two')`)
    )
  })

  it('keeps a tenant-scoped row isolated even when its optional FK is NULL', async () => {
    // The org clause is load-bearing precisely BECAUSE the FK clause is
    // `project_id IS NULL OR EXISTS(...)`: for a project-less row that half is
    // TRUE for everyone, so dropping the org half would make the row globally
    // readable while every FK test still passed.
    const id = `conv_orphan_${ORG_A}`
    // `scope` is not decoration here: migration 0081's CHECK refuses a
    // project-less row that still calls itself a project conversation, so an
    // office chat has to say so to exist at all.
    await withTenant({ organizationId: ORG_A }, () =>
      db.execute(
        sql`insert into conversations (id, organization_id, created_by, project_id, scope)
            values (${id}, ${ORG_A}, 'u', NULL, 'workspace')`
      )
    )

    const seenByB = await withTenant({ organizationId: ORG_B }, () =>
      db.execute(sql`select id from conversations where id = ${id}`)
    )
    expect([...seenByB]).toEqual([])

    await withPlatformAccess('test cleanup', () =>
      db.execute(sql`delete from conversations where id = ${id}`)
    )
  })

  /**
   * The Büro-Chat's one invariant (ADR-0054, spec WS-7), tested against the
   * database rather than against the service that is supposed to uphold it.
   *
   * Both halves matter and they fail for different mistakes. A `workspace` row
   * carrying a project is the office chat that quietly reads one project's
   * corpus. A `project` row carrying none is the chat that belongs nowhere and
   * that every project list has to decide about — which is precisely the guess
   * spec WS-9 forbids. The application checks both at the edge (a 400 from
   * `POST /api/conversations`); this is what holds when a repository, a
   * backfill or somebody's psql session does not.
   */
  it("refuses a workspace conversation that names a project", async () => {
    const [ownProject] = [
      ...(await withTenant({ organizationId: ORG_A }, () =>
        db.execute(sql`select id from projects where organization_id = ${ORG_A}`)
      )),
    ]

    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into conversations (id, organization_id, created_by, project_id, scope)
              values (${'conv_ws_with_project_' + ORG_A}, ${ORG_A}, 'u', ${ownProject.id}, 'workspace')`
        )
      )
    )
    expect(cause.message).toMatch(/conversations_scope_matches_project/)
  })

  it('refuses a project conversation with no project', async () => {
    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into conversations (id, organization_id, created_by, project_id, scope)
              values (${'conv_project_no_project_' + ORG_A}, ${ORG_A}, 'u', NULL, 'project')`
        )
      )
    )
    expect(cause.message).toMatch(/conversations_scope_matches_project/)
  })

  /**
   * The value half. Kept separate from the shape half so a violation says which
   * of the two rules was broken — a scope nobody can render is a different
   * defect from a scope that contradicts its project column.
   */
  it('refuses a scope nothing knows how to render', async () => {
    const cause = await rejectionCause(() =>
      withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into conversations (id, organization_id, created_by, project_id, scope)
              values (${'conv_scope_unknown_' + ORG_A}, ${ORG_A}, 'u', NULL, 'buero')`
        )
      )
    )
    expect(cause.message).toMatch(/conversations_scope_known/)
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
   * The lesson tables are tighter than the platform-table norm: 0068 revokes
   * even the tenant READ grant, because nothing tenant-facing queries them
   * (the injected digest is built under the platform role) and a CANDIDATE
   * lesson is exactly the text the auditor model flagged as possibly
   * identifying. This test is what keeps that revoke from being "simplified"
   * away as an inconsistency with the other platform_* tables.
   */
  it('hides the lesson tables from tenants entirely, in both directions', async () => {
    for (const table of [
      'platform_lessons',
      'platform_lesson_reports',
      'platform_lesson_events',
    ] as const) {
      const cause = await rejectionCause(() =>
        withTenant({ organizationId: ORG_A }, () =>
          db.execute(sql`select count(*) from ${sql.raw(table)}`)
        )
      )
      expect(cause.message, `${table} must not be tenant-readable`).toMatch(/permission denied/i)
    }
    // The platform role still reads them — that is where the pipeline runs.
    const rows = await withPlatformAccess('test: lesson register read', () =>
      db.execute(sql`select count(*)::int as n from platform_lessons`)
    )
    expect([...rows][0]).toMatchObject({ n: 0 })
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
    // Since 0031 this is refused by the composite foreign key rather than the
    // policy: the row's organization defaults to the active tenant, and
    // `(conv_of_A, ORG_B)` is not a pair that exists in `conversations`. A
    // stronger refusal than the policy's, and it fires before it.
    expect(cause.message).toMatch(/row-level security|violates foreign key/i)

    await withPlatformAccess('test cleanup', async () => {
      await db.execute(sql`delete from messages where conversation_id = ${conversationId}`)
      await db.execute(sql`delete from conversations where id = ${conversationId}`)
    })
  })

  /**
   * The Projektregister (0082, ADR-0054). It is a DERIVED table — every column
   * copies something `projects`, `project_memory` and `documents` hold — which
   * is exactly why it needs its own boundary test: a derived copy is the kind
   * of table somebody adds without thinking of tenancy, and it carries the
   * Steckbriefe an office chat reads by name.
   */
  describe('project_register', () => {
    async function projectOf(org: string): Promise<string> {
      const rows = await withPlatformAccess('test: read the seeded project', () =>
        db.execute(sql`select id from projects where organization_id = ${org} limit 1`)
      )
      return String([...rows][0].id)
    }

    afterAll(async () => {
      if (!db) return
      await withPlatformAccess('test cleanup', () =>
        db.execute(sql`delete from project_register where organization_id in (${ORG_A}, ${ORG_B})`)
      )
    })

    it('refuses a Steckbrief planted under another tenant', async () => {
      const projectA = await projectOf(ORG_A)
      const cause = await rejectionCause(() =>
        withTenant({ organizationId: ORG_B }, () =>
          db.execute(
            sql`insert into project_register (project_id, organization_id, project_name, steckbrief)
                values (${projectA}, ${ORG_B}, 'stolen', 'PROJECT_STECKBRIEF v1')`
          )
        )
      )
      // Either half of the belt-and-braces may fire first: the composite
      // foreign key has no `(projectA, ORG_B)` pair to point at, and the policy
      // refuses the row on its own. Both are the correct refusal.
      expect(cause.message).toMatch(/row-level security|violates foreign key/i)
    })

    it('hides one tenant’s Steckbriefe from another', async () => {
      const projectA = await projectOf(ORG_A)
      await withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into project_register (project_id, organization_id, project_name, steckbrief)
              values (${projectA}, ${ORG_A}, 'Projekt A', 'PROJECT_STECKBRIEF v1')`
        )
      )

      const seenByB = await withTenant({ organizationId: ORG_B }, () =>
        db.execute(sql`select project_name from project_register`)
      )
      expect([...seenByB]).toEqual([])

      const seenByA = await withTenant({ organizationId: ORG_A }, () =>
        db.execute(sql`select project_name from project_register`)
      )
      expect([...seenByA].map((row) => row.project_name)).toEqual(['Projekt A'])
    })

    it('refuses a Steckbrief over the 3000-character budget', async () => {
      // The budget is a database invariant, not a convention the builder is
      // trusted to keep (spec PR-3): five of these plus the office digest have
      // to fit in one prompt, so a builder bug must fail here rather than as a
      // context overflow in production.
      const projectB = await projectOf(ORG_B)
      const cause = await rejectionCause(() =>
        withTenant({ organizationId: ORG_B }, () =>
          db.execute(
            sql`insert into project_register (project_id, organization_id, project_name, steckbrief)
                values (${projectB}, ${ORG_B}, 'Projekt B', ${'x'.repeat(3001)})`
          )
        )
      )
      expect(cause.message).toMatch(/project_register_steckbrief_bounded/i)
    })

    it('refuses a vector with no model fingerprint beside it', async () => {
      // A similarity score against an unknown embedder is noise wearing the
      // right shape, so the three embedding columns are one fact and the
      // database says so.
      const projectB = await projectOf(ORG_B)
      const cause = await rejectionCause(() =>
        withTenant({ organizationId: ORG_B }, () =>
          db.execute(
            sql`insert into project_register
                  (project_id, organization_id, project_name, steckbrief, embedding)
                values (${projectB}, ${ORG_B}, 'Projekt B', 'PROJECT_STECKBRIEF v1', '{0.1,0.2}')`
          )
        )
      )
      expect(cause.message).toMatch(/project_register_embedding_complete/i)
    })
  })

  /**
   * The mounted projects of a Büro conversation (0083, ADR-0054).
   *
   * This table is the only place where a conversation and a project meet
   * without one owning the other, which makes it the one place a mount could
   * tie one tenant's thread to another tenant's corpus. Three claims, and each
   * of them is a constraint rather than a habit somewhere in the service:
   *
   *   1. the pair cannot cross the tenant boundary at all (the composite keys);
   *   2. a project purge takes its mounts AND STOPS — the conversation belongs
   *      to the organisation and survives (spec MT-15, ADR-0011);
   *   3. `mounted_by` and `mounted_by_user_id` are one fact, so the attribution
   *      the UI renders is never a guess.
   */
  describe('conversation_mounts', () => {
    const OFFICE_CONVERSATION = `conv_buero_${ORG_A}`

    async function projectOf(org: string): Promise<string> {
      const rows = await withPlatformAccess('test: read the seeded project', () =>
        db.execute(sql`select id from projects where organization_id = ${org} limit 1`)
      )
      return String([...rows][0].id)
    }

    beforeAll(async () => {
      // A Büro conversation: no project, and `scope = 'workspace'` because the
      // 0081 CHECK ties the two together (the absence of a project is never the
      // only thing that says which kind of conversation this is).
      await withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into conversations (id, organization_id, created_by, project_id, scope)
              values (${OFFICE_CONVERSATION}, ${ORG_A}, 'u', null, 'workspace')`
        )
      )
    })

    afterAll(async () => {
      if (!db) return
      await withPlatformAccess('test cleanup', async () => {
        await db.execute(
          sql`delete from conversation_mounts where organization_id in (${ORG_A}, ${ORG_B})`
        )
        await db.execute(sql`delete from conversations where id = ${OFFICE_CONVERSATION}`)
      })
    })

    it('refuses a mount tying this tenant’s conversation to another tenant’s project', async () => {
      const projectB = await projectOf(ORG_B)

      const cause = await rejectionCause(() =>
        withTenant({ organizationId: ORG_A }, () =>
          db.execute(
            sql`insert into conversation_mounts
                  (conversation_id, organization_id, project_id, mounted_by, mounted_by_user_id)
                values (${OFFICE_CONVERSATION}, ${ORG_A}, ${projectB}, 'user', 'u')`
          )
        )
      )
      // Belt and braces, either of which is the correct refusal: `(projectB,
      // ORG_A)` is not a pair `projects` holds, and the policy's second half
      // refuses a row naming a project outside the active tenant.
      expect(cause.message).toMatch(/row-level security|violates foreign key/i)
    })

    it('hides one tenant’s mounts from another', async () => {
      const projectA = await projectOf(ORG_A)
      await withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into conversation_mounts
                (conversation_id, organization_id, project_id, mounted_by, mounted_by_user_id)
              values (${OFFICE_CONVERSATION}, ${ORG_A}, ${projectA}, 'user', 'u')
              on conflict do nothing`
        )
      )

      const seenByB = await withTenant({ organizationId: ORG_B }, () =>
        db.execute(sql`select conversation_id from conversation_mounts`)
      )
      expect([...seenByB]).toEqual([])

      const seenByA = await withTenant({ organizationId: ORG_A }, () =>
        db.execute(sql`select conversation_id from conversation_mounts`)
      )
      expect([...seenByA].map((row) => row.conversation_id)).toEqual([OFFICE_CONVERSATION])
    })

    it('drops the mount when the project is purged and KEEPS the conversation (MT-15)', async () => {
      // A project of its own, so the purge under test destroys nothing the rest
      // of this suite reads.
      const doomed = await withTenant({ organizationId: ORG_A }, async () => {
        const [row] = [
          ...(await db.execute(
            sql`insert into projects (organization_id, name, created_by, collection_name)
                values (${ORG_A}, 'Projekt Seestadt', 'u', ${'coll_doomed_' + ORG_A})
                returning id`
          )),
        ]
        await db.execute(
          sql`insert into conversation_mounts
                (conversation_id, organization_id, project_id, mounted_by)
              values (${OFFICE_CONVERSATION}, ${ORG_A}, ${String(row.id)}, 'agent')`
        )
        return String(row.id)
      })

      await withTenant({ organizationId: ORG_A }, () =>
        db.execute(sql`delete from projects where id = ${doomed}`)
      )

      const [mounts, conversations] = await withTenant(
        { organizationId: ORG_A },
        async () =>
          [
            [
              ...(await db.execute(
                sql`select project_id from conversation_mounts where project_id = ${doomed}`
              )),
            ],
            [
              ...(await db.execute(
                sql`select id from conversations where id = ${OFFICE_CONVERSATION}`
              )),
            ],
          ] as const
      )

      // The cascade is the WHOLE of the deletion story for a mount: the row goes
      // with its project, and the conversation — which belongs to the
      // organisation — is untouched. A purge that enumerated "every conversation
      // of this project" and learned about this table would take the office
      // thread with it.
      expect(mounts).toEqual([])
      expect(conversations).toHaveLength(1)
    })

    it('refuses a half-filled attribution in either direction', async () => {
      const projectA = await projectOf(ORG_A)

      // A person's mount that names no person…
      const anonymousUser = await rejectionCause(() =>
        withTenant({ organizationId: ORG_A }, () =>
          db.execute(
            sql`insert into conversation_mounts
                  (conversation_id, organization_id, project_id, mounted_by, mounted_by_user_id)
                values (${OFFICE_CONVERSATION}, ${ORG_A}, ${projectA}, 'user', null)`
          )
        )
      )
      expect(anonymousUser.message).toMatch(/conversation_mounts_user_is_named/i)

      // …and an agent's mount that names one.
      const attributedAgent = await rejectionCause(() =>
        withTenant({ organizationId: ORG_A }, () =>
          db.execute(
            sql`insert into conversation_mounts
                  (conversation_id, organization_id, project_id, mounted_by, mounted_by_user_id)
                values (${OFFICE_CONVERSATION}, ${ORG_A}, ${projectA}, 'agent', 'u')`
          )
        )
      )
      expect(attributedAgent.message).toMatch(/conversation_mounts_user_is_named/i)

      // And an actor the renderer has never heard of. Written with a NULL user
      // id on purpose, so the biconditional above is satisfied and only the
      // vocabulary CHECK can be the one that fires.
      const unknownActor = await rejectionCause(() =>
        withTenant({ organizationId: ORG_A }, () =>
          db.execute(
            sql`insert into conversation_mounts
                  (conversation_id, organization_id, project_id, mounted_by, mounted_by_user_id)
                values (${OFFICE_CONVERSATION}, ${ORG_A}, ${projectA}, 'workflow', null)`
          )
        )
      )
      expect(unknownActor.message).toMatch(/conversation_mounts_actor_known/i)
    })
  })
})
