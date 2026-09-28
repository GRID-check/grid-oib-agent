/**
 * Opt-in integration test: what a legal hold covers, and that the database
 * refuses to delete a covered row (migration 0093), against a REAL Postgres
 * with every migration applied, as the restricted runtime role.
 *
 * The unit suites double `isCoveredByActiveHold` and prove the delete paths
 * ask before they erase. Only this can prove the answer: the predicate is a
 * plpgsql function (`grid_legal_hold_blocks`) that joins documents,
 * conversations and holds, and it runs under row-level security.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/compliance/legal-hold.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const STAMP = Date.now()
const ORG = `org_hold_${STAMP}`
const OTHER_ORG = `org_hold_other_${STAMP}`
const USER = `user_hold_${STAMP}`
const COLLEAGUE = `user_hold_colleague_${STAMP}`

const PROJECT = '0a0a0a0a-0000-4000-8000-000000000001'
const OTHER_PROJECT = '0a0a0a0a-0000-4000-8000-000000000002'
const PROJECT_DOC = '0b0b0b0b-0000-4000-8000-000000000001'
const OTHER_DOC = '0b0b0b0b-0000-4000-8000-000000000002'
const SESSION_DOC = '0b0b0b0b-0000-4000-8000-000000000003'
const CHAT = `s_hold_chat_${STAMP}`

function rootCause(error: unknown): Error & { code?: string } {
  let current = error as Error
  while (current?.cause instanceof Error) current = current.cause
  return current as Error & { code?: string }
}

describe.skipIf(!url)('legal holds against live Postgres (migration 0093)', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let isCoveredByActiveHold: typeof import('./repository').isCoveredByActiveHold

  const inOrg = <T>(fn: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: USER }, fn)

  async function hold(entityType: string, entityId: string, organizationId = ORG): Promise<void> {
    await withTenant({ organizationId, userId: USER }, () =>
      db.execute(sql`
        insert into legal_holds (entity_type, entity_id, organization_id, reason, created_by)
        values (${entityType}, ${entityId}, ${organizationId}, 'integration test', ${USER})
      `),
    )
  }

  async function covered(entityType: 'document' | 'conversation' | 'project' | 'organization' | 'user', id: string) {
    return isCoveredByActiveHold(ORG, entityType, id)
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    ;({ isCoveredByActiveHold } = await import('./repository'))
    db = (await import('@/lib/db')).getDb()

    await withPlatformAccess('test seed: organizations', async () => {
      for (const org of [ORG, OTHER_ORG]) {
        await db.execute(
          sql`insert into organizations (workos_organization_id, display_name) values (${org}, ${org}) on conflict do nothing`,
        )
      }
    })
    await inOrg(async () => {
      await db.execute(sql`
        insert into projects (id, organization_id, name, created_by, collection_name) values
          (${PROJECT}, ${ORG}, 'Held', ${USER}, ${'proj_' + PROJECT}),
          (${OTHER_PROJECT}, ${ORG}, 'Free', ${USER}, ${'proj_' + OTHER_PROJECT})
      `)
      await db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id)
        values (${CHAT}, ${ORG}, ${USER}, ${PROJECT})
      `)
      await db.execute(sql`
        insert into documents (id, organization_id, project_id, scope, conversation_id, filename, storage_key, collection_name, created_by) values
          (${PROJECT_DOC}, ${ORG}, ${PROJECT}, 'project', null, 'plan.pdf', 'k/plan.pdf', ${'proj_' + PROJECT}, ${USER}),
          (${OTHER_DOC}, ${ORG}, ${OTHER_PROJECT}, 'project', null, 'frei.pdf', 'k/frei.pdf', ${'proj_' + OTHER_PROJECT}, ${COLLEAGUE}),
          (${SESSION_DOC}, ${ORG}, null, 'session', ${CHAT}, 'anhang.pdf', 'k/anhang.pdf', ${CHAT}, ${COLLEAGUE})
      `)
    })
  })

  beforeEach(async () => {
    await withPlatformAccess('test: clear holds', () =>
      db.execute(sql`delete from legal_holds where organization_id in (${ORG}, ${OTHER_ORG})`),
    )
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from legal_holds where organization_id in (${ORG}, ${OTHER_ORG})`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(
        sql`delete from organizations where workos_organization_id in (${ORG}, ${OTHER_ORG})`,
      )
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('covers nothing while the organization holds nothing', async () => {
    for (const [type, id] of [
      ['document', PROJECT_DOC],
      ['conversation', CHAT],
      ['project', PROJECT],
      ['organization', ORG],
    ] as const) {
      expect(await covered(type, id)).toBe(false)
    }
  })

  it('a hold on a document covers it and every container whose erasure takes it', async () => {
    await hold('document', PROJECT_DOC)

    expect(await covered('document', PROJECT_DOC)).toBe(true)
    expect(await covered('project', PROJECT)).toBe(true)
    expect(await covered('organization', ORG)).toBe(true)
    expect(await covered('document', OTHER_DOC)).toBe(false)
    expect(await covered('project', OTHER_PROJECT)).toBe(false)
    expect(await covered('conversation', CHAT)).toBe(false)
  })

  it("a hold on a chat's attachment covers the chat and the chat's project", async () => {
    await hold('document', SESSION_DOC)

    expect(await covered('conversation', CHAT)).toBe(true)
    expect(await covered('project', PROJECT)).toBe(true)
  })

  it('a hold on a container covers what is inside it', async () => {
    await hold('project', PROJECT)
    expect(await covered('document', PROJECT_DOC)).toBe(true)
    expect(await covered('conversation', CHAT)).toBe(true)
    expect(await covered('document', OTHER_DOC)).toBe(false)

    await withPlatformAccess('test: clear holds', () =>
      db.execute(sql`delete from legal_holds where organization_id = ${ORG}`),
    )
    await hold('conversation', CHAT)
    expect(await covered('document', SESSION_DOC)).toBe(true)
    expect(await covered('document', PROJECT_DOC)).toBe(false)
  })

  it('a hold on a user covers what that user created (custodian hold)', async () => {
    await hold('user', COLLEAGUE)

    expect(await covered('document', OTHER_DOC)).toBe(true)
    expect(await covered('document', SESSION_DOC)).toBe(true)
    // The chat is USER's, but erasing it erases COLLEAGUE's attachment.
    expect(await covered('conversation', CHAT)).toBe(true)
    expect(await covered('document', PROJECT_DOC)).toBe(false)
  })

  it('an organization hold covers everything in it; a released one covers nothing', async () => {
    await hold('organization', ORG)
    expect(await covered('document', OTHER_DOC)).toBe(true)
    expect(await covered('conversation', CHAT)).toBe(true)

    await inOrg(() => db.execute(sql`update legal_holds set released_at = now() where organization_id = ${ORG}`))
    expect(await covered('document', OTHER_DOC)).toBe(false)
    expect(await covered('conversation', CHAT)).toBe(false)
  })

  it("never lets another organization's hold cover this one's rows", async () => {
    await hold('document', PROJECT_DOC, OTHER_ORG)
    await hold('organization', ORG, OTHER_ORG)

    expect(await covered('document', PROJECT_DOC)).toBe(false)
  })

  it('answers false, not an error, for an id that is not a uuid', async () => {
    await hold('user', COLLEAGUE)
    expect(await covered('document', 'not-a-uuid')).toBe(false)
    expect(await covered('project', 'not-a-uuid')).toBe(false)
  })

  it('the delete trigger refuses a covered row with GLH01 and lets it go once released', async () => {
    await hold('document', OTHER_DOC)

    const refusal = await inOrg(() => db.execute(sql`delete from documents where id = ${OTHER_DOC}`)).then(
      () => null,
      (error: unknown) => rootCause(error),
    )
    expect(refusal?.code).toBe('GLH01')
    const [still] = await inOrg(() => db.execute(sql`select count(*)::int as n from documents where id = ${OTHER_DOC}`))
    expect(Number(still.n)).toBe(1)

    await inOrg(() => db.execute(sql`update legal_holds set released_at = now() where organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`delete from documents where id = ${OTHER_DOC}`))
    const [gone] = await inOrg(() => db.execute(sql`select count(*)::int as n from documents where id = ${OTHER_DOC}`))
    expect(Number(gone.n)).toBe(0)
  })

  it("refuses a cascade that would take a held attachment with its chat's project", async () => {
    await hold('document', SESSION_DOC)

    // The purger's last step, as the platform role: the project row cascades
    // into the chat and from there into the attachment, and the attachment's
    // trigger stops the whole statement.
    const refusal = await withPlatformAccess('test: purge a project', () =>
      db.execute(sql`delete from projects where id = ${PROJECT}`),
    ).then(
      () => null,
      (error: unknown) => rootCause(error),
    )
    expect(refusal?.code).toBe('GLH01')

    const [left] = await inOrg(() =>
      db.execute(sql`select count(*)::int as n from conversations where id = ${CHAT}`),
    )
    expect(Number(left.n)).toBe(1)
  })
})
