/**
 * @vitest-environment node
 */
/**
 * Sharing a Büro conversation, against a REAL Postgres with a FAKE WorkOS —
 * the integration test [ADR-0054](../../../../docs/adr/0054-workspace-chat-mounts-projects-on-demand.md)
 * asks for by name: *a member without `project:view` on P is refused a shared
 * workspace conversation that mounts P* (spec AC-7, AC-8, AC-9).
 *
 * It has to be an integration test, for the reason the mocked specs beside it
 * cannot cover: the rule is a JOIN between three tables that nothing else joins
 * — `conversations` (which thread), `conversation_mounts` (which projects) and
 * `resource_shares` (which people) — and each of those reads runs inside the
 * tenant scope as `grid_app_rw`, under row-level security. A mocked repository
 * agrees with whatever the author expected of it, including a mount row that
 * row-level security would never have handed back.
 *
 * What is faked is exactly one thing: WorkOS. `authorization.check` answers
 * from a per-user set of readable projects, so "Anna may view Seestadt but not
 * Nordbahnhof" is a fixture rather than a network call. Everything else — the
 * sharing service, the access resolution, the mounts service, the SQL — is the
 * shipped code.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/sharing/workspace-sharing.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs
 * this file alongside the isolation, BIM, memory and register-recall suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/** Who may view what, rewritten per test. `userId → project ids`. */
const readable = new Map<string, Set<string>>()
/** Everyone the fake directory knows, so a refusal can name them. */
const people = new Map<string, string>()

/**
 * The whole fake: one WorkOS.
 *
 * Every authorization answer this feature needs comes through this client —
 * the per-project FGA check (`requireProjectAccess`, `canUserAccessProject`),
 * the subject's membership, the environment roles behind the org-admin bypass,
 * and the people directory the refusal is rendered with. Faking the client
 * rather than each seam is what keeps the code under test the shipped code.
 */
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    authorization: {
      check: async ({
        organizationMembershipId,
        resourceExternalId,
      }: {
        organizationMembershipId: string
        resourceExternalId: string
      }) => ({
        authorized: Boolean(
          readable.get(organizationMembershipId.replace(/^om_/, ''))?.has(resourceExternalId)
        ),
      }),
      // No custom roles: the catalog decides what `member` holds, which is what
      // the union in `org-role-permissions` falls back to.
      listEnvironmentRoles: async () => ({ data: [] }),
    },
    userManagement: {
      listOrganizationMemberships: async ({ userId }: { userId: string }) => ({
        data: [{ id: `om_${userId}`, organizationId: ORG, status: 'active', role: { slug: 'member' } }],
      }),
      listUsers: async () => ({
        autoPagination: async () =>
          [...people].map(([userId, name]) => ({ id: userId, email: `${userId}@grid.test`, firstName: name, lastName: null })),
      }),
    },
  }),
}))

// Peripheral to the rule and each other's own suite: the audit record, the live
// fan-out and the share rate limit. Left real, they would need Dragonfly and a
// WorkOS audit stream to say nothing about who may read what.
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ publishToUsers: vi.fn() }))
vi.mock('@/lib/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/limits')>()),
  consumeLimit: vi.fn(async () => ({ allowed: true, remaining: 10, limit: 10, resetAt: new Date() })),
}))

import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'

const url = process.env.GRID_TEST_DATABASE_URL

const ORG = `org_share_${Date.now()}`
const OWNER = `user_owner_${Date.now()}`
const COLLEAGUE = `user_colleague_${Date.now()}`
const CONVERSATION = `conv_buero_${Date.now()}`

describe('the workspace sharing suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(
      url,
      'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set, so the ' +
        'workspace sharing suite skipped and nothing verified that a shared Büro thread ' +
        'stays inside the mounted projects. Check `task db:test:rls`.'
    ).toBeTruthy()
  })
})

describe.skipIf(!url)('sharing a Büro conversation against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let grantResourceAccess: typeof import('./service').grantResourceAccess
  let requireResourceAccess: typeof import('./access').requireResourceAccess
  let mountProject: typeof import('@/lib/workspace/mounts-service').mountProject
  let WorkspaceMountExclusionError: typeof import('@/lib/workspace/mounts-service').WorkspaceMountExclusionError

  let seestadt = ''
  let nordbahnhof = ''

  const session = (userId: string): AuthorizedSession =>
    ({
      userId,
      email: `${userId}@grid.test`,
      name: null,
      accessToken: 'tok',
      organizationId: ORG,
      organizationMembershipId: `om_${userId}`,
      role: 'member',
      permissions: [],
      featureFlags: null,
    }) as AuthorizedSession

  const as = <T>(userId: string, run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId }, run)

  async function seedProject(name: string): Promise<string> {
    const rows = await as(OWNER, () =>
      db.execute(
        sql`insert into projects (organization_id, name, created_by, collection_name)
            values (${ORG}, ${name}, ${OWNER}, ${`coll_${name}_${Date.now()}`})
            returning id`
      )
    )
    return String([...rows][0].id)
  }

  /** A mount written straight to the table — the state, without the service. */
  async function mountRow(projectId: string): Promise<void> {
    await as(OWNER, () =>
      db.execute(
        sql`insert into conversation_mounts
              (conversation_id, organization_id, project_id, mounted_by, mounted_by_user_id)
            values (${CONVERSATION}, ${ORG}, ${projectId}, 'user', ${OWNER})
            on conflict do nothing`
      )
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    process.env.WORKOS_API_KEY = 'test-key'
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    grantResourceAccess = (await import('./service')).grantResourceAccess
    requireResourceAccess = (await import('./access')).requireResourceAccess
    const mounts = await import('@/lib/workspace/mounts-service')
    mountProject = mounts.mountProject
    WorkspaceMountExclusionError = mounts.WorkspaceMountExclusionError

    people.set(OWNER, 'Otto Besitzer')
    people.set(COLLEAGUE, 'Anna Meier')

    await withPlatformAccess('test seed: the organization', () =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name)
            values (${ORG}, ${ORG}) on conflict do nothing`
      )
    )
    seestadt = await seedProject('Seestadt')
    nordbahnhof = await seedProject('Nordbahnhof')

    // The Büro thread: no project, `scope = 'workspace'` (0081's CHECK ties the
    // two together), private, owned by its creator.
    await as(OWNER, () =>
      db.execute(
        sql`insert into conversations (id, organization_id, created_by, project_id, scope, visibility)
            values (${CONVERSATION}, ${ORG}, ${OWNER}, null, 'workspace', 'private')`
      )
    )
  })

  beforeEach(async () => {
    // The FGA check cache is ON by default since 2026-09
    // (`DEFAULT_AUTHZ_CACHE_TTL_MS`), and these cases REVOKE a project mid-test
    // to prove the read check answers to the roster as it is now. With the
    // cache in the way they would answer to the roster as it was, which is a
    // statement about caching rather than about access. Off here for the same
    // reason `lib/projects/service.spec.ts` switches it off: in production the
    // revocation lands within the TTL, and the TTL is not what is under test.
    process.env.GRID_AUTHZ_CACHE_TTL_MS = '0'
    readable.clear()
    // The owner may reach both projects; the colleague may reach only Seestadt.
    readable.set(OWNER, new Set([seestadt, nordbahnhof]))
    readable.set(COLLEAGUE, new Set([seestadt]))
    await withPlatformAccess('test: reset the thread’s mounts and roster', async () => {
      await db.execute(sql`delete from conversation_mounts where organization_id = ${ORG}`)
      await db.execute(sql`delete from resource_shares where organization_id = ${ORG}`)
    })
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from conversation_mounts where organization_id = ${ORG}`)
      await db.execute(sql`delete from resource_shares where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
      await db.execute(sql`delete from organizations where workos_organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('refuses the share to a member who may not view a mounted project (AC-7), writing no grant', async () => {
    await mountRow(nordbahnhof)

    const failure = await as(OWNER, () =>
      grantResourceAccess(session(OWNER), 'conversation', CONVERSATION, {
        subjectUserId: COLLEAGUE,
        role: 'collaborator',
      })
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).message).toContain('Nordbahnhof')

    const grants = await as(OWNER, () =>
      db.execute(sql`select subject_user_id from resource_shares where resource_id = ${CONVERSATION}`)
    )
    expect([...grants]).toEqual([])
  })

  it('permits the share when every mounted project is viewable, and the colleague can then read it', async () => {
    await mountRow(seestadt)

    await as(OWNER, () =>
      grantResourceAccess(session(OWNER), 'conversation', CONVERSATION, {
        subjectUserId: COLLEAGUE,
        role: 'collaborator',
      })
    )

    const access = await as(COLLEAGUE, () =>
      requireResourceAccess(session(COLLEAGUE), 'conversation', CONVERSATION, 'viewer')
    )
    expect(access.role).toBe('collaborator')
  })

  it('refuses the READ when the mount happened after the grant (AC-7 read-time, AC-9)', async () => {
    // The grant is written while the thread mounts only Seestadt, which the
    // colleague may view. Nordbahnhof arrives afterwards — the row is written
    // directly, which is also what a revocation of `project:view` looks like
    // from the read path's side. A grant is not a key: the read closes.
    await mountRow(seestadt)
    await as(OWNER, () =>
      grantResourceAccess(session(OWNER), 'conversation', CONVERSATION, {
        subjectUserId: COLLEAGUE,
        role: 'collaborator',
      })
    )
    await mountRow(nordbahnhof)

    await expect(
      as(COLLEAGUE, () =>
        requireResourceAccess(session(COLLEAGUE), 'conversation', CONVERSATION, 'viewer')
      )
    ).rejects.toBeInstanceOf(NotFoundError)

    // And the grant row is still there: access was denied, not revoked. The
    // colleague gets the thread back the moment they may view Nordbahnhof.
    const grants = await as(OWNER, () =>
      db.execute(sql`select subject_user_id from resource_shares where resource_id = ${CONVERSATION}`)
    )
    expect([...grants].map((row) => row.subject_user_id)).toEqual([COLLEAGUE])
  })

  it('still lets the OWNER read the thread they mounted it into', async () => {
    await mountRow(nordbahnhof)

    const access = await as(OWNER, () =>
      requireResourceAccess(session(OWNER), 'conversation', CONVERSATION, 'viewer')
    )
    expect(access.role).toBe('owner')
  })

  it('closes the thread on its own OWNER once they lose a mounted project', async () => {
    // The creator is not exempt: the transcript quotes the project either way,
    // and "I mounted it" is not a right to keep reading it (AC-7, AC-9).
    await mountRow(nordbahnhof)
    readable.set(OWNER, new Set([seestadt]))

    await expect(
      as(OWNER, () => requireResourceAccess(session(OWNER), 'conversation', CONVERSATION, 'viewer'))
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('refuses a mount that would shut a participant out, naming them (AC-8)', async () => {
    await mountRow(seestadt)
    await as(OWNER, () =>
      grantResourceAccess(session(OWNER), 'conversation', CONVERSATION, {
        subjectUserId: COLLEAGUE,
        role: 'collaborator',
      })
    )

    const failure = await as(OWNER, () =>
      mountProject({
        session: session(OWNER),
        conversationId: CONVERSATION,
        projectId: nordbahnhof,
        mountedBy: 'user',
      })
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WorkspaceMountExclusionError)
    expect((failure as InstanceType<typeof WorkspaceMountExclusionError>).excluded).toEqual([
      'Anna Meier',
    ])

    // Refused means nothing was written: the conversation still reads exactly
    // what it read before, so the colleague still has it.
    const mounts = await as(OWNER, () =>
      db.execute(sql`select project_id from conversation_mounts where conversation_id = ${CONVERSATION}`)
    )
    expect([...mounts].map((row) => String(row.project_id))).toEqual([seestadt])
  })

  it('lets the mount through when every participant may view the project', async () => {
    await as(OWNER, () =>
      grantResourceAccess(session(OWNER), 'conversation', CONVERSATION, {
        subjectUserId: COLLEAGUE,
        role: 'collaborator',
      })
    )

    const result = await as(OWNER, () =>
      mountProject({
        session: session(OWNER),
        conversationId: CONVERSATION,
        projectId: seestadt,
        mountedBy: 'user',
      })
    )

    expect(result.created).toBe(true)
    expect(result.mount.projectName).toBe('Seestadt')
  })
})
