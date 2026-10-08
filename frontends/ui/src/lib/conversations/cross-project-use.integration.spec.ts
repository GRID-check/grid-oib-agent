/**
 * @vitest-environment node
 *
 * A solo chat's use of OTHER projects (ADR-0093, migration 0125) against a REAL
 * Postgres, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/conversations/cross-project-use.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * Who may open which project and who holds which role are the WorkOS answers,
 * faked; the projects, the folder tree, the conversations, the grants and the
 * records are real rows. What it proves:
 *   - a hand-out from the other project and a restricted folder of it records
 *     the project and the folder id;
 *   - the folder is then judged in the OTHER project's tree, so the creator
 *     still reads the chat, and a colleague who may open the project but not
 *     read the folder does not;
 *   - a share reaches only a person who may open the project and read the
 *     folder; the project-wide visibility is refused;
 *   - a chat shared before the hand-out is refused and records nothing;
 *   - the answer a hand-out with a restricted folder goes to is marked in
 *     `message_restricted_use` (ADR-0092); one of open content only is not;
 *   - no memory may be written from such a chat;
 *   - the erasure takes both records, and another organization sees neither.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { FolderClearance } from '@/lib/authz/folder-access'

vi.mock('server-only', () => ({}))

const STAMP = Date.now()
const ORG = `org_xp_${STAMP}`
const OTHER_ORG = `${ORG}_other`
/** Owner of every chat: opens both projects, holds the role the restricted folder names. */
const OWNER = `user_xp_owner_${STAMP}`
/** Opens the other project, holds no role. */
const MEMBER = `user_xp_member_${STAMP}`
/** Opens the other project and holds the role. */
const CLEARED = `user_xp_cleared_${STAMP}`
/** Opens only the chat's own project. */
const OUTSIDER = `user_xp_outsider_${STAMP}`

const roles = new Map<string, FolderClearance>([
  [OWNER, { roles: ['org-gf'], seesEverything: false }],
  [CLEARED, { roles: ['org-gf'], seesEverything: false }],
])
/** Who may open the OTHER project: everyone named here (and nobody else). */
const opensOther = new Set([OWNER, MEMBER, CLEARED])
const ids = { own: '', other: '' }

vi.mock('@/lib/authz/folder-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/folder-access')>()),
  clearanceOfMember: vi.fn(async (_org: string, userId: string) => roles.get(userId) ?? { roles: [], seesEverything: false }),
  clearanceOf: vi.fn(async (session: { userId: string }) => roles.get(session.userId) ?? { roles: [], seesEverything: false }),
}))
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(async (session: { userId: string }, projectId: string) => {
    if (projectId === ids.other && !opensOther.has(session.userId)) throw new Error('Not found')
    return { role: 'project-viewer' }
  }),
}))
vi.mock('@/lib/authz/project-membership', () => ({
  userHoldsProjectPermission: vi.fn(async (_session: unknown, projectId: string, userId: string) =>
    projectId === ids.other ? opensOther.has(userId) : true
  ),
}))
vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(async () => new Map([[OUTSIDER, { userId: OUTSIDER, email: null, name: 'Otto', profilePictureUrl: null }]])),
}))

const url = process.env.GRID_TEST_DATABASE_URL

describe('the cross-project suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('cross-project use against Postgres (migration 0125)', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let use: typeof import('./restricted-use')
  let crossUse: typeof import('./cross-project-use')
  let repo: typeof import('./repository')
  let upsertGrant: typeof import('@/lib/sharing/repository').upsertGrant
  const otherCollection = `proj_xp_other_${STAMP}`
  let folderId = ''

  const session = (userId = OWNER): AuthorizedSession => ({
    userId,
    email: `${userId}@grid.test`,
    name: 'Owner',
    accessToken: 'token',
    organizationId: ORG,
    organizationMembershipId: `om_${userId}`,
    role: 'org-gf',
    roles: ['org-gf'],
    permissions: [],
    featureFlags: null,
  })

  const inOrg = <T>(organizationId: string, fn: () => PromiseLike<T>) => withTenant({ organizationId, userId: OWNER }, fn)
  let chatSeq = 0

  async function chat(grantees: readonly string[] = []) {
    chatSeq += 1
    const id = `s_xp_${STAMP}_${chatSeq}`
    await inOrg(ORG, () =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, visibility)
        values (${id}, ${ORG}, ${OWNER}, ${ids.own}::uuid, 'private')`)
    )
    for (const grantee of grantees) await inOrg(ORG, () => grant(id, grantee))
    return id
  }

  const grant = (conversationId: string, subjectUserId: string, executor?: Parameters<typeof upsertGrant>[1]) =>
    upsertGrant(
      { organizationId: ORG, resourceType: 'conversation', resourceId: conversationId, subjectUserId, role: 'collaborator', grantedBy: OWNER },
      executor
    )
  const admit = (conversationId: string, folders: readonly string[] = [folderId], answerMessageId?: string) =>
    inOrg(ORG, () =>
      crossUse.recordCrossProjectHandOut(
        { organizationId: ORG, userId: OWNER, conversationId, answerMessageId },
        { projectIds: [ids.other], folderIds: folders }
      )
    )
  const marks = async (messageId: string) => {
    const rows = await inOrg(ORG, () =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from message_restricted_use where message_id = ${messageId}`)
    )
    return Number(Array.from(rows)[0]?.n)
  }
  const shareWith = (conversationId: string, userId: string) =>
    inOrg(ORG, () =>
      use.widenConversationAudience(session(), conversationId, { kind: 'person', userId, self: false }, (executor) =>
        grant(conversationId, userId, executor)
      )
    )
  const reasonOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'went through',
      (error: { details?: { reason?: unknown }; code?: string }) => error.details?.reason ?? error.code ?? error
    )
  const count = async (organizationId: string, table: 'conversation_source_projects' | 'conversation_restricted_folders', id: string) => {
    const rows = await inOrg(organizationId, () =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where conversation_id = ${id}`)
    )
    return Number(Array.from(rows)[0]?.n)
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    use = await import('./restricted-use')
    crossUse = await import('./cross-project-use')
    repo = await import('./repository')
    upsertGrant = (await import('@/lib/sharing/repository')).upsertGrant
    const insertProject = async (name: string, collection: string) => {
      const [row] = Array.from(
        await inOrg(ORG, () =>
          db.execute<{ id: string }>(sql`
            insert into projects (organization_id, name, created_by, collection_name)
            values (${ORG}, ${name}, ${OWNER}, ${collection}) returning id`)
        )
      )
      return String(row.id)
    }
    ids.own = await insertProject('Eigenes Projekt', `proj_xp_own_${STAMP}`)
    ids.other = await insertProject('Abgeschlossenes Projekt', otherCollection)
    const [folder] = Array.from(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          with folder as (
            insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
            values (${ORG}, ${ids.other}::uuid, 'Honorare', 'Honorare', 'custom', ${OWNER}, now())
            returning id, project_id
          ), grants as (
            insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            select ${ORG}, project_id, id, 'org-gf', 'read' from folder
          )
          select id from folder`)
      )
    )
    folderId = String(folder.id)
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from conversation_source_projects where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversation_restricted_folders where organization_id = ${ORG}`)
      await db.execute(sql`delete from resource_shares where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from project_folders where organization_id = ${ORG}`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('records the other project and its restricted folder by id, and judges the folder in that project’s tree', async () => {
    const id = await chat()

    await admit(id)
    expect(await count(ORG, 'conversation_source_projects', id)).toBe(1)
    expect(await inOrg(ORG, () => use.recordedRestrictedFolders(id, ORG))).toEqual([folderId])
    expect(await inOrg(ORG, () => use.recordedSourceProjects(id, ORG))).toEqual([ids.other])

    const readers = await inOrg(ORG, () => use.peopleWhoMayRead(ORG, id, [OWNER, MEMBER, CLEARED, OUTSIDER]))
    expect([...readers].sort()).toEqual([CLEARED, OWNER].sort())
  })

  it('shares only with a person who may open the project and read the folder, never with the project', async () => {
    const id = await chat()
    await admit(id)

    expect(await reasonOf(shareWith(id, OUTSIDER))).toBe('cross-project-content')
    expect(await reasonOf(shareWith(id, MEMBER))).toBe('restricted-content')
    expect(await reasonOf(shareWith(id, CLEARED))).toBe('went through')
    expect(
      await reasonOf(inOrg(ORG, () => use.assertMayWidenConversation(session(), id, { kind: 'visibility' })))
    ).toBe('cross-project-content-project')
  })

  it('refuses, and records nothing, in a chat that was shared before the lookup came back', async () => {
    const id = await chat([CLEARED])

    expect(await reasonOf(admit(id))).toBe('CROSS_PROJECT_SHARED_CHAT')
    expect(await count(ORG, 'conversation_source_projects', id)).toBe(0)
    expect(await count(ORG, 'conversation_restricted_folders', id)).toBe(0)
  })

  it('marks the answer a restricted folder is handed to, and not one that got open content only (ADR-0092)', async () => {
    const restricted = await chat()
    const open = await chat()
    const restrictedAnswer = randomUUID()
    const openAnswer = randomUUID()

    await admit(restricted, [folderId], restrictedAnswer)
    await admit(open, [], openAnswer)

    expect(await marks(restrictedAnswer)).toBe(1)
    // Another project's open content is not restricted use: the project record
    // stays outside `grid_conversation_restricted_use`.
    expect(await marks(openAnswer)).toBe(0)
  })

  it('refuses a memory from the chat once it drew on the other project', async () => {
    const id = await chat()
    await admit(id, [])

    expect(await reasonOf(inOrg(ORG, () => crossUse.requireMayRememberFrom(id, ORG)))).toBe('CROSS_PROJECT_MEMORY')
  })

  it('takes both records with the conversation when the chat is erased', async () => {
    const id = await chat()
    await admit(id)
    await inOrg(ORG, () => repo.deleteConversationInOrg(id, ORG))

    expect(await count(ORG, 'conversation_source_projects', id)).toBe(0)
    expect(await count(ORG, 'conversation_restricted_folders', id)).toBe(0)
  })

  it('is invisible to another organization, which cannot write one here either', async () => {
    const id = await chat()
    await admit(id, [])

    expect(await count(OTHER_ORG, 'conversation_source_projects', id)).toBe(0)
    await expect(
      inOrg(OTHER_ORG, () =>
        db.execute(sql`
          insert into conversation_source_projects (organization_id, conversation_id, project_id)
          values (${ORG}, ${`s_xp_forged_${STAMP}`}, ${ids.other}::uuid)`)
      )
    ).rejects.toThrow()
  })
})
