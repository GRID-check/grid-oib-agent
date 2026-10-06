/**
 * @vitest-environment node
 *
 * A conversation's restricted use (ADR-0080, migration 0108) against a REAL
 * Postgres, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/conversations/restricted-use.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * Who holds which WorkOS role is the one thing faked (`clearanceOfMember`);
 * the folder tree, the conversation, its grants and the record are real rows.
 * What it proves:
 *   - a chat of a cleared member that never admits restricted content records
 *     nothing and can be shared with anyone;
 *   - admitting X records X; sharing then reaches a person cleared for X and
 *     refuses one who is not, and the project-wide visibility is refused;
 *   - a conversation shared with someone not cleared for X never admits X;
 *   - a share cannot slip between an admission's audience check and its
 *     record, nor an admission between a share's check and its write;
 *   - the erasure takes the record with the conversation, and another
 *     organization can neither see nor write one.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { FolderClearance } from '@/lib/authz/folder-access'

vi.mock('server-only', () => ({}))

const STAMP = Date.now()
const ORG = `org_ruse_${STAMP}`
const OTHER_ORG = `${ORG}_other`
/** Owner of every chat here, cleared for the restricted folder. */
const OWNER = `user_ruse_owner_${STAMP}`
/** Cleared for the restricted folder too. */
const CLEARED = `user_ruse_cleared_${STAMP}`
/** A project member holding no clearance role. */
const UNCLEARED = `user_ruse_uncleared_${STAMP}`

/**
 * The WorkOS answer, per person. `pause` holds the NEXT lookup until released,
 * which is how the interleaving tests put a share inside an admission's window.
 */
const roles = new Map<string, FolderClearance>([
  [OWNER, { roles: ['org-gf'], seesEverything: false }],
  [CLEARED, { roles: ['org-gf'], seesEverything: false }],
])
let pause: { reached: () => void; release: Promise<void> } | null = null

vi.mock('@/lib/authz/folder-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authz/folder-access')>()
  return {
    ...actual,
    clearanceOfMember: vi.fn(async (_organizationId: string, userId: string) => {
      const held = pause
      if (held) {
        pause = null
        held.reached()
        await held.release
      }
      return roles.get(userId) ?? { roles: [], seesEverything: false }
    }),
  }
})
vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(async () => new Map([[UNCLEARED, { userId: UNCLEARED, email: null, name: 'Ina Praktikantin', profilePictureUrl: null }]])),
}))

const url = process.env.GRID_TEST_DATABASE_URL

describe('the restricted-use suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('restricted use against Postgres (migrations 0108, 0109)', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let use: typeof import('./restricted-use')
  let repo: typeof import('./repository')
  let upsertGrant: typeof import('@/lib/sharing/repository').upsertGrant
  let projectId = ''
  let restricted = ''
  /** The source folder of `restricted`: what the record names (ADR-0081). */
  let folderId = ''

  const session: AuthorizedSession = {
    userId: OWNER,
    email: 'owner@grid.test',
    name: 'Owner',
    accessToken: 'token',
    organizationId: ORG,
    organizationMembershipId: 'om_owner',
    role: 'org-gf',
    roles: ['org-gf'],
    permissions: [],
    featureFlags: null,
  }

  const inOrg = <T>(organizationId: string, fn: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: OWNER }, fn)
  let chatSeq = 0

  /** A fresh private chat of OWNER in the project, optionally already shared. */
  async function chat(grantees: readonly string[] = [], visibility: 'private' | 'project' = 'private') {
    chatSeq += 1
    const id = `s_ruse_${STAMP}_${chatSeq}`
    await inOrg(ORG, async () => {
      await db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, visibility)
        values (${id}, ${ORG}, ${OWNER}, ${projectId}::uuid, ${visibility})`)
    })
    for (const grantee of grantees) await inOrg(ORG, () => grant(id, grantee))
    return id
  }

  const grant = (conversationId: string, subjectUserId: string, executor?: Parameters<typeof upsertGrant>[1]) =>
    upsertGrant(
      {
        organizationId: ORG,
        resourceType: 'conversation',
        resourceId: conversationId,
        subjectUserId,
        role: 'collaborator',
        grantedBy: OWNER,
      },
      executor
    )

  const admit = (conversationId: string, collections = [restricted]) =>
    inOrg(ORG, () =>
      use.admitRestrictedUse({ organizationId: ORG, conversationId, userId: OWNER, projectId }, collections)
    )
  const recorded = (conversationId: string) => inOrg(ORG, () => use.recordedRestrictedFolders(conversationId, ORG))
  const shareWith = (conversationId: string, userId: string) =>
    inOrg(ORG, () =>
      use.widenConversationAudience(session, conversationId, { kind: 'person', userId, self: false }, (executor) =>
        grant(conversationId, userId, executor)
      )
    )
  const grantees = async (conversationId: string): Promise<string[]> => {
    const rows = await inOrg(ORG, () =>
      db.execute<{ subject_user_id: string }>(sql`
        select subject_user_id from resource_shares
         where organization_id = ${ORG} and resource_type = 'conversation' and resource_id = ${conversationId}`)
    )
    return Array.from(rows).map((row) => String(row.subject_user_id))
  }
  const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => 'went through',
      (error: { details?: { reason?: unknown } }) => error.details?.reason ?? error
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    use = await import('./restricted-use')
    repo = await import('./repository')
    upsertGrant = (await import('@/lib/sharing/repository')).upsertGrant
    const folderAccess = await import('@/lib/authz/folder-access')
    const collection = `proj_ruse_${STAMP}`
    const [project] = Array.from(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${ORG}, 'Restricted use', ${OWNER}, ${collection}) returning id`)
      )
    )
    projectId = String(project.id)
    // One statement: the 0109 trigger checks at commit that a custom list is
    // not empty, and every statement here commits on its own.
    const [folder] = Array.from(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          with folder as (
            insert into project_folders (project_id, name, path, access_mode, access_changed_by, access_changed_at)
            values (${projectId}::uuid, 'Verträge', 'Verträge', 'custom', ${OWNER}, now())
            returning id, project_id
          ), grants as (
            insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            select ${ORG}, project_id, id, 'org-gf', 'write' from folder
          )
          select id from folder`)
      )
    )
    folderId = String(folder.id)
    restricted = folderAccess.restrictedCollectionName(collection, folderId)
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from conversation_restricted_folders where organization_id = ${ORG}`)
      await db.execute(sql`delete from resource_shares where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from project_folders where project_id = ${projectId}::uuid`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('records nothing for a cleared member’s chat that never admits restricted content, which anyone may join', async () => {
    const id = await chat()
    const drawable = await inOrg(ORG, () =>
      use.drawableRestrictedCollections({ organizationId: ORG, conversationId: id, userId: OWNER, projectId }, [
        restricted,
      ])
    )
    expect(drawable).toEqual([restricted])

    expect(await recorded(id)).toEqual([])
    await shareWith(id, UNCLEARED)
    expect(await grantees(id)).toEqual([UNCLEARED])
  })

  it('records X when X is admitted, then shares with a person cleared for X and refuses one who is not', async () => {
    const id = await chat()
    const admission = await admit(id)
    expect(admission).toEqual({ admitted: [restricted], refused: [], recorded: [folderId] })
    expect(await recorded(id)).toEqual([folderId])

    expect(await reasonOf(shareWith(id, UNCLEARED))).toBe('restricted-content')
    expect(await grantees(id)).toEqual([])
    expect(await reasonOf(shareWith(id, CLEARED))).toBe('went through')
    expect(await grantees(id)).toEqual([CLEARED])
  })

  it('names the person, and the folder to a sharer cleared for it, in the refusal', async () => {
    const id = await chat()
    await admit(id)
    const error = await shareWith(id, UNCLEARED).catch((caught: { details?: unknown }) => caught)
    expect(error).toMatchObject({ details: { reason: 'restricted-content', person: 'Ina Praktikantin', folders: ['Verträge'] } })
  })

  it('refuses to make a chat that drew on X visible to the project, and allows it for one that did not', async () => {
    const drew = await chat()
    await admit(drew)
    const visibility = (conversationId: string) =>
      inOrg(ORG, () =>
        use.widenConversationAudience(session, conversationId, { kind: 'visibility' }, (executor) =>
          repo.updateConversationVisibilityInOrg(conversationId, ORG, 'project', executor)
        )
      )
    expect(await reasonOf(visibility(drew))).toBe('restricted-content-project')
    expect(await reasonOf(visibility(await chat()))).toBe('went through')
  })

  it('records the first use of a chat whose row does not exist yet, in the stated project', async () => {
    const id = `s_ruse_new_${STAMP}`
    expect((await admit(id)).admitted).toEqual([restricted])
    expect(await inOrg(ORG, () => use.recordedRestrictedFolders(id, ORG))).toEqual([folderId])
  })

  it('never admits X in a chat already shared with someone not cleared for it, nor in a project-visible one', async () => {
    const shared = await chat([UNCLEARED])
    expect(await admit(shared)).toEqual({ admitted: [], refused: [restricted], recorded: [] })
    const visible = await chat([], 'project')
    expect((await admit(visible)).refused).toEqual([restricted])
    expect(await recorded(shared)).toEqual([])
    expect(await recorded(visible)).toEqual([])
  })

  it('refuses a collection that is not a current restricted collection of the project', async () => {
    const id = await chat()
    expect((await admit(id, ['proj_elsewhere_r0123456789ab'])).refused).toEqual(['proj_elsewhere_r0123456789ab'])
    expect(await recorded(id)).toEqual([])
  })

  it('does not let a share slip between an admission’s audience check and its record', async () => {
    const id = await chat()
    let reached!: () => void
    const atCheck = new Promise<void>((resolve) => (reached = resolve))
    let release!: () => void
    pause = { reached, release: new Promise<void>((resolve) => (release = resolve)) }

    // The admission reads the audience (OWNER alone), then stops while it asks
    // WorkOS for the clearances, before it takes the lock.
    const admission = admit(id)
    await atCheck
    // The share runs entirely inside that window: nothing is recorded yet, so
    // it goes through.
    expect(await reasonOf(shareWith(id, UNCLEARED))).toBe('went through')
    release()

    // Under the lock the admission reads the audience again, finds a reader it
    // never asked about, and refuses.
    expect((await admission).refused).toEqual([restricted])
    expect(await recorded(id)).toEqual([])
    expect(await grantees(id)).toEqual([UNCLEARED])
  })

  it('does not let a use slip between a share’s record check and its write', async () => {
    const id = await chat()
    let inside!: () => void
    const atWrite = new Promise<void>((resolve) => (inside = resolve))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))

    // The share has checked the record (empty) under the lock and stops
    // before its write.
    const share = inOrg(ORG, () =>
      use.widenConversationAudience(session, id, { kind: 'person', userId: UNCLEARED, self: false }, async (executor) => {
        inside()
        await held
        return grant(id, UNCLEARED, executor)
      })
    )
    await atWrite
    // The admission blocks on the same lock until the share commits...
    const admission = admit(id)
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    await share

    // ...and then sees the grant: refused, nothing recorded.
    expect((await admission).refused).toEqual([restricted])
    expect(await recorded(id)).toEqual([])
    expect(await grantees(id)).toEqual([UNCLEARED])
  })

  it('never ends with both a grant to an uncleared reader and a record, however the two race', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const id = await chat()
        await Promise.allSettled([admit(id), shareWith(id, UNCLEARED)])
        return { recorded: await recorded(id), grantees: await grantees(id) }
      })
    )
    for (const outcome of outcomes) {
      expect(outcome.recorded.length > 0 && outcome.grantees.includes(UNCLEARED)).toBe(false)
    }
  })

  it('judges the record at read time: loosening the folder opens the chat, tightening it closes it again', async () => {
    const id = await chat()
    await admit(id)
    expect(await reasonOf(shareWith(id, UNCLEARED))).toBe('restricted-content')

    // Everyone may read the folder now: nothing recorded restricts anyone.
    await inOrg(ORG, () =>
      db.execute(sql`
        with gone as (delete from project_folder_grants where folder_id = ${folderId}::uuid)
        update project_folders set access_mode = 'inherit' where id = ${folderId}::uuid`)
    )
    expect(await recorded(id)).toEqual([])
    const other = await chat()
    await inOrg(ORG, () =>
      db.execute(sql`
        insert into conversation_restricted_folders (organization_id, conversation_id, folder_id)
        values (${ORG}, ${other}, ${folderId}::uuid)`)
    )
    expect(await reasonOf(shareWith(other, UNCLEARED))).toBe('went through')

    // Back to Geschäftsführung only: the same record restricts again, unrewritten.
    await inOrg(ORG, () =>
      db.execute(sql`
        with listed as (
          insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          values (${ORG}, ${projectId}::uuid, ${folderId}::uuid, 'org-gf', 'write')
        )
        update project_folders set access_mode = 'custom' where id = ${folderId}::uuid`)
    )
    expect(await recorded(id)).toEqual([folderId])
    expect(await reasonOf(shareWith(id, UNCLEARED))).toBe('restricted-content')
  })

  describe('who may still read a chat that recorded the folder (ADR-0081)', () => {
    /** The same people, with the roles WorkOS reports for them NOW. */
    const withRoles = (userId: string, roleList: string[]): AuthorizedSession => ({
      ...session,
      userId,
      role: roleList[0] ?? '',
      roles: roleList,
    })

    let own = ''
    beforeAll(async () => {
      const [created] = Array.from(
        await inOrg(ORG, () =>
          db.execute<{ id: string }>(sql`
            with folder as (
              insert into project_folders (project_id, name, path, access_mode, access_changed_by, access_changed_at)
              values (${projectId}::uuid, 'Lesen', 'Lesen', 'custom', ${OWNER}, now())
              returning id, project_id
            ), grants as (
              insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
              select ${ORG}, project_id, id, 'org-gf', 'write' from folder
            )
            select id from folder`)
        )
      )
      own = String(created.id)
    })

    /** Record that the chat drew on this block's folder. */
    const admitOwn = (conversationId: string) =>
      inOrg(ORG, () => use.admitSourceFolders({ organizationId: ORG, conversationId, userId: OWNER, projectId }, [own]))

    it('locks the CREATOR and a grantee who lost the role, leaves the cleared one, and unlocks when the role is back', async () => {
      // Shared only with a person cleared for it: an admission refuses a folder
      // somebody in the audience may not read, so this is the chat that has one.
      const id = await chat([CLEARED])
      await admitOwn(id)
      const plain = await chat()
      const asked = [
        { id, projectId },
        { id: plain, projectId },
      ]
      const locked = (who: AuthorizedSession) => inOrg(ORG, () => use.lockedConversationIds(who, asked))

      expect([...(await locked(withRoles(OWNER, ['org-gf'])))]).toEqual([])
      // The creator lost the role: ownership is not the right to read.
      expect([...(await locked(withRoles(OWNER, ['member'])))]).toEqual([id])
      expect([...(await locked(withRoles(UNCLEARED, ['member'])))]).toEqual([id])
      // Given back, with nothing rewritten, the chat opens again.
      expect([...(await locked(withRoles(OWNER, ['org-gf'])))]).toEqual([])
    })

    it('answers per person from the folder as it is now: tightened closes, loosened opens', async () => {
      // Shared only with a person cleared for it: an admission refuses a folder
      // somebody in the audience may not read, so this is the chat that has one.
      const id = await chat([CLEARED])
      await admitOwn(id)
      const readers = () =>
        inOrg(ORG, async () => [...(await use.peopleWhoMayRead(ORG, id, [OWNER, CLEARED, UNCLEARED]))].sort())

      expect(await readers()).toEqual([CLEARED, OWNER].sort())

      await inOrg(ORG, () =>
        db.execute(sql`
          with gone as (delete from project_folder_grants where folder_id = ${own}::uuid)
          update project_folders set access_mode = 'inherit' where id = ${own}::uuid`)
      )
      expect(await readers()).toEqual([CLEARED, OWNER, UNCLEARED].sort())

      await inOrg(ORG, () =>
        db.execute(sql`
          with listed as (
            insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            values (${ORG}, ${projectId}::uuid, ${own}::uuid, 'org-gf', 'write')
          )
          update project_folders set access_mode = 'custom' where id = ${own}::uuid`)
      )
      expect(await readers()).toEqual([CLEARED, OWNER].sort())
    })

    it('reads the record of a whole list in one query, and another organization’s list is empty', async () => {
      const a = await chat()
      const b = await chat()
      await admitOwn(a)
      const read = (organizationId: string) =>
        inOrg(organizationId, () => use.lockedConversationIds(withRoles(OWNER, ['member']), [{ id: a, projectId }, { id: b, projectId }]))

      expect([...(await read(ORG))]).toEqual([a])
      // Another organization cannot read the record at all, so it cannot lock anything.
      expect([...(await read(OTHER_ORG))]).toEqual([])
    })
  })

  it('takes the record with the conversation when the chat is erased', async () => {
    const id = await chat()
    await admit(id)
    await inOrg(ORG, () => repo.deleteConversationInOrg(id, ORG))
    expect(await recorded(id)).toEqual([])
  })

  it('is invisible to another organization, which cannot write one here either', async () => {
    const id = await chat()
    await admit(id)
    const seen = await inOrg(OTHER_ORG, () =>
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from conversation_restricted_folders where conversation_id = ${id}`
      )
    )
    expect(Number(Array.from(seen)[0]?.n)).toBe(0)
    await expect(
      inOrg(OTHER_ORG, () =>
        db.execute(sql`
          insert into conversation_restricted_folders (organization_id, conversation_id, folder_id)
          values (${ORG}, ${`s_ruse_forged_${STAMP}`}, ${folderId}::uuid)`)
      )
    ).rejects.toThrow()
  })
})
