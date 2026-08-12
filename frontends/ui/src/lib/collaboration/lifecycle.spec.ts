/**
 * @vitest-environment node
 */
/**
 * Collaboration lifecycle: deletion, modification, revocation (spec SH-13, IB-14,
 * IB-15, MN-9.4).
 *
 * The happy paths are covered next to their services. This file covers the ones
 * that only run when something is taken AWAY, which is where a collaboration
 * feature rots quietly: a purge that forgets a table nothing cascades from, a
 * narrowing that also drops the grants a restore needs, a revocation that leaves a
 * quoted snippet readable by the person who just lost access.
 *
 * **Mocking strategy.** `@/lib/sharing/access`, `@/lib/sharing/registry`,
 * `@/lib/sharing/service`, `@/lib/mentions/service`, `@/lib/inbox/service` and
 * `@/lib/collaboration/cleanup` all run FOR REAL; only the repositories, WorkOS,
 * the audit trail and the event bus are stubbed. A test that mocked
 * `requireResourceAccess` or the cleanup module would assert nothing about whether
 * the cascade actually happens.
 *
 * Where the guarantee lives in SQL (the orphan predicate, the payload wipe, the
 * project scoping) the REAL repository is imported with `vi.importActual` and its
 * statement is captured through drizzle's proxy driver, so the assertion is about
 * the emitted SQL rather than about a hand-rolled builder stub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/lib/events/bus', () => ({
  publishToUser: vi.fn().mockResolvedValue(undefined),
  publishToUsers: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))

vi.mock('@/lib/authz/project-membership', () => ({
  canUserAccessProject: vi.fn(),
  filterUsersWithProjectAccess: vi.fn(),
}))

const listRoleAssignmentsForResource = vi.fn()
const removeRoleAssignment = vi.fn().mockResolvedValue(undefined)
const getOrganizationMembership = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    authorization: { listRoleAssignmentsForResource, removeRoleAssignment },
    userManagement: { getOrganizationMembership },
  }),
}))

// `@/lib/conversations/service` reaches the naming backend through
// `@/lib/backend-proxy`, which pulls in the AuthKit session helpers.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/session-documents/repository', () => ({
  // Discarding a chat erases the files attached to it (ADR-0047 Phase 2).
  // Stubbed empty here: the erasure has its own spec, and what matters for
  // these tests is that it runs BEFORE the conversation row goes.
  listSessionDocumentsForCleanup: vi.fn().mockResolvedValue([]),
  deleteSessionDocumentsByIds: vi.fn().mockResolvedValue(undefined),
  SESSION_DOCUMENT_LIST_LIMIT: 100,
}))

vi.mock('@/lib/conversations/repository', () => ({
  deleteConversationInOrg: vi.fn().mockResolvedValue(undefined),
  findConversationInOrg: vi.fn(),
  findConversationRead: vi.fn(),
  findConversationTenancy: vi.fn(),
  findMessageInConversation: vi.fn(),
  insertConversation: vi.fn(),
  insertMessages: vi.fn(),
  listConversationIdsForProject: vi.fn(),
  listMessagesForConversation: vi.fn(),
  listVisibleConversations: vi.fn(),
  mergeMessageMetadata: vi.fn(),
  updateConversationMetaInOrg: vi.fn(),
  updateConversationTitleInOrg: vi.fn(),
  updateConversationVisibilityInOrg: vi.fn(),
  upsertConversationRead: vi.fn(),
}))

vi.mock('@/lib/sharing/repository', () => ({
  SHARE_ROSTER_LIMIT: 200,
  countGrantsForResource: vi.fn(),
  deleteAllGrantsForResource: vi.fn(),
  deleteGrant: vi.fn(),
  deleteOrphanedGrants: vi.fn(),
  findGrantForSubject: vi.fn(),
  listGrantsForResource: vi.fn(),
  upsertGrant: vi.fn(),
}))

vi.mock('@/lib/mentions/repository', () => ({
  deleteOrphanedMentionRequests: vi.fn(),
  deleteRequestsForResource: vi.fn(),
  findRequestById: vi.fn(),
  insertMentionRequests: vi.fn(),
  listOpenRequestsForResource: vi.fn(),
  listOpenRequestsForSubject: vi.fn(),
  resolveRequests: vi.fn(),
  voidOpenRequestsForResource: vi.fn(),
  voidOpenRequestsForSubject: vi.fn(),
  voidOpenRequestsForSubjectInProject: vi.fn(),
}))

vi.mock('@/lib/inbox/repository', () => ({
  INBOX_LIST_LIMIT: 50,
  archiveInboxItem: vi.fn(),
  countPendingInboxItems: vi.fn(),
  deleteItemsForResource: vi.fn(),
  deleteOrphanedInboxItems: vi.fn(),
  listInboxItems: vi.fn(),
  markAllInboxItemsRead: vi.fn(),
  markInboxItemsRead: vi.fn(),
  markItemsInertForResource: vi.fn(),
  markItemsInertForSubjectInProject: vi.fn(),
  markItemsInertForSubjectRow: vi.fn(),
  markResourceItemsRead: vi.fn(),
  pruneInboxItemsOlderThan: vi.fn(),
  resolveInboxItemsForTargets: vi.fn(),
  upsertInboxItems: vi.fn(),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(),
  findProjectWorkosResourceId: vi.fn(),
  insertProject: vi.fn(),
  listProjectsInOrg: vi.fn(),
  renameProjectInOrg: vi.fn(),
  restoreProjectIfPending: vi.fn(),
  setProjectWorkosResourceId: vi.fn(),
  softDeleteProjectAndEnqueue: vi.fn().mockResolvedValue(undefined),
}))

// The real `unknownPerson` fallback is part of what row E32 protects, so only the
// WorkOS-backed lookup is replaced.
vi.mock('@/lib/sharing/directory', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/sharing/directory')>()),
  loadOrganizationDirectory: vi.fn(),
}))

// The real bounds are part of the rules under test; only the counter is stubbed.
vi.mock('@/lib/limits', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/limits')>()),
  consumeLimit: vi.fn(),
}))

import { drizzle as proxyDrizzle } from 'drizzle-orm/pg-proxy'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canUserAccessProject } from '@/lib/authz/project-membership'
import { requireProjectAccess, type ProjectRole } from '@/lib/authz/projects'
import {
  neutralizeCollaborationForProject,
  revokeCollaborationForProjectMember,
  sweepOrphanedCollaborationRows,
} from '@/lib/collaboration/cleanup'
import { pruneExpiredInboxItems } from '@/lib/collaboration/retention'
import {
  deleteConversationInOrg,
  findConversationInOrg,
  findConversationTenancy,
  listConversationIdsForProject,
  updateConversationTitleInOrg,
  updateConversationVisibilityInOrg,
} from '@/lib/conversations/repository'
import { deleteConversation, getConversation, updateConversationTitle } from '@/lib/conversations/service'
import { getDb } from '@/lib/db'
import type { MentionRequest, ResourceRole, ResourceVisibility } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { INBOX_TYPE_DEFINITIONS } from '@/lib/inbox/registry'
import {
  countPendingInboxItems,
  deleteItemsForResource,
  deleteOrphanedInboxItems,
  markItemsInertForResource,
  markItemsInertForSubjectInProject,
  markItemsInertForSubjectRow,
  pruneInboxItemsOlderThan,
  resolveInboxItemsForTargets,
} from '@/lib/inbox/repository'
import {
  deleteOrphanedMentionRequests,
  deleteRequestsForResource,
  voidOpenRequestsForResource,
  voidOpenRequestsForSubject,
  voidOpenRequestsForSubjectInProject,
} from '@/lib/mentions/repository'
import { removeProjectRoleAssignment } from '@/lib/projects/members-service'
import { deleteProject } from '@/lib/projects/service'
import { findProjectInOrg, findProjectWorkosResourceId } from '@/lib/projects/repository'
import {
  countGrantsForResource,
  deleteAllGrantsForResource,
  deleteGrant,
  deleteOrphanedGrants,
  findGrantForSubject,
  listGrantsForResource,
  upsertGrant,
} from '@/lib/sharing/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  changeResourceRole,
  getSharingState,
  revokeResourceAccess,
  setResourceVisibility,
} from '@/lib/sharing/service'
import { SHARE_LIMIT, consumeLimit } from '@/lib/limits'
import { allowedDecision } from '@/test-utils/limit-fixtures'

const CONVERSATION_ID = 'conv_1'
const PROJECT_ID = 'proj_1'
const ANNA = 'user_anna'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

/** The registry's one probe: existence, tenancy, container, visibility, creator. */
function stubConversation(
  overrides: Partial<{
    organizationId: string
    projectId: string | null
    visibility: ResourceVisibility
    createdBy: string | null
    deletedAt: Date | null
  }> = {},
): void {
  const tenancy = {
    organizationId: 'org_1',
    projectId: PROJECT_ID,
    visibility: 'private' as ResourceVisibility,
    createdBy: session.userId,
    deletedAt: null,
    ...overrides,
  }
  vi.mocked(findConversationTenancy).mockResolvedValue(tenancy as never)
  vi.mocked(findConversationInOrg).mockResolvedValue({
    id: CONVERSATION_ID,
    title: 'Brandschutz Halle 3',
    tags: [],
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-02T10:00:00Z'),
    ...tenancy,
  } as never)
}

function stubContainer(role: ProjectRole | 'denied'): void {
  if (role === 'denied') {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    return
  }
  vi.mocked(requireProjectAccess).mockResolvedValue({ role } as never)
}

function stubGrants(grants: Array<{ subjectUserId: string; role: ResourceRole }>): void {
  vi.mocked(listGrantsForResource).mockResolvedValue(
    grants.map((grant, index) => ({
      id: `share_${index}`,
      organizationId: 'org_1',
      resourceType: 'conversation',
      resourceId: CONVERSATION_ID,
      subjectUserId: grant.subjectUserId,
      role: grant.role,
      grantedBy: session.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as never,
  )
}

/** The caller's OWN grant, which is what `resolveResourceAccess` probes. */
function stubMyGrant(role: ResourceRole | null): void {
  vi.mocked(findGrantForSubject).mockResolvedValue(role ? ({ role } as never) : null)
}

function requestRow(overrides: Partial<MentionRequest> = {}): MentionRequest {
  return {
    id: 'req_1',
    organizationId: 'org_1',
    resourceType: 'conversation',
    resourceId: CONVERSATION_ID,
    anchorId: 'msg_1',
    requestedBy: session.userId,
    requestedOf: ANNA,
    note: 'Atrium als OIB 2.3?',
    status: 'open',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date('2026-07-29T10:00:00.000Z'),
    ...overrides,
  }
}

interface CapturedQuery {
  sql: string
  params: unknown[]
}

/**
 * Point `getDb()` at drizzle's proxy driver so the REAL repository emits its real
 * statement and we can assert the SQL instead of a stubbed builder chain.
 * `rows` is what every statement "returns".
 */
function captureSql(rows: unknown[][] = []): CapturedQuery[] {
  const queries: CapturedQuery[] = []
  const db = proxyDrizzle(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params })
    return { rows }
  })
  vi.mocked(getDb).mockReturnValue(db as never)
  return queries
}

beforeEach(() => {
  stubConversation()
  stubContainer('project-editor')
  stubMyGrant(null)
  stubGrants([])
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
  vi.mocked(consumeLimit).mockResolvedValue(allowedDecision(SHARE_LIMIT))
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
  vi.mocked(countPendingInboxItems).mockResolvedValue(0)
  vi.mocked(canUserAccessProject).mockResolvedValue(true)
  vi.mocked(upsertGrant).mockResolvedValue({} as never)
  vi.mocked(deleteGrant).mockResolvedValue(true)
  vi.mocked(updateConversationVisibilityInOrg).mockResolvedValue({} as never)
  vi.mocked(updateConversationTitleInOrg).mockResolvedValue({} as never)
  vi.mocked(deleteAllGrantsForResource).mockResolvedValue(0)
  vi.mocked(deleteRequestsForResource).mockResolvedValue(0)
  vi.mocked(deleteItemsForResource).mockResolvedValue(0)
  vi.mocked(voidOpenRequestsForSubject).mockResolvedValue([])
  vi.mocked(voidOpenRequestsForResource).mockResolvedValue([])
  vi.mocked(voidOpenRequestsForSubjectInProject).mockResolvedValue([])
  vi.mocked(markItemsInertForResource).mockResolvedValue(0)
  vi.mocked(markItemsInertForSubjectRow).mockResolvedValue(0)
  vi.mocked(markItemsInertForSubjectInProject).mockResolvedValue(0)
  vi.mocked(resolveInboxItemsForTargets).mockResolvedValue(0)
})

// ---------------------------------------------------------------------------
// A. Deletion
// ---------------------------------------------------------------------------

describe('deleting a conversation (matrix A1–A3, spec SH-13)', () => {
  it('purges the grants, mention requests and inbox items that no foreign key cascades', async () => {
    // These three tables address their target as a polymorphic
    // (resource_type, resource_id) pair, so nothing in Postgres removes them.
    await deleteConversation(session, CONVERSATION_ID)

    expect(deleteConversationInOrg).toHaveBeenCalledWith(CONVERSATION_ID, 'org_1')
    expect(deleteAllGrantsForResource).toHaveBeenCalledWith('conversation', CONVERSATION_ID)
    expect(deleteRequestsForResource).toHaveBeenCalledWith('conversation', CONVERSATION_ID)
    expect(deleteItemsForResource).toHaveBeenCalledWith('conversation', CONVERSATION_ID)
  })

  it('purges nothing for an id that only ever lived in the browser', async () => {
    // The service reports the same `NotFoundError` here as for a row that exists
    // and is not the caller's, so the two cannot be told apart (spec SH-6); the
    // DELETE route turns both into the 204 the chat store needs. What matters at
    // THIS level is that nothing was purged either way.
    vi.mocked(findConversationTenancy).mockResolvedValue(null)

    await expect(deleteConversation(session, CONVERSATION_ID)).rejects.toBeInstanceOf(NotFoundError)

    expect(deleteConversationInOrg).not.toHaveBeenCalled()
    expect(deleteAllGrantsForResource).not.toHaveBeenCalled()
    expect(deleteRequestsForResource).not.toHaveBeenCalled()
    expect(deleteItemsForResource).not.toHaveBeenCalled()
  })

  it('leaves the row AND the collaboration state untouched when the caller is not the owner', async () => {
    // A project collaborator can read and contribute, but deletion is an owner's
    // call — and a refused delete must not have purged anything on its way out.
    stubConversation({ visibility: 'project', createdBy: 'user_other' })

    await expect(deleteConversation(session, CONVERSATION_ID)).rejects.toBeInstanceOf(NotFoundError)

    expect(deleteConversationInOrg).not.toHaveBeenCalled()
    expect(deleteAllGrantsForResource).not.toHaveBeenCalled()
    expect(deleteRequestsForResource).not.toHaveBeenCalled()
    expect(deleteItemsForResource).not.toHaveBeenCalled()
  })
})

describe('soft-deleting a project (matrix A4–A5, spec SH-13)', () => {
  const CONVERSATIONS = ['conv_a', 'conv_b', 'conv_c']

  beforeEach(() => {
    vi.mocked(findProjectInOrg).mockResolvedValue({ id: PROJECT_ID, name: 'Halle 3' } as never)
    vi.mocked(listConversationIdsForProject).mockResolvedValue(CONVERSATIONS)
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' } as never)
  })

  it('voids open requests and inerts inbox items for every conversation, but keeps the grants', async () => {
    await deleteProject(session, PROJECT_ID, 'Halle 3', new Request('https://grid.test/p'))

    expect(vi.mocked(voidOpenRequestsForResource).mock.calls.map((call) => call[1])).toEqual(CONVERSATIONS)
    expect(vi.mocked(markItemsInertForResource).mock.calls.map((call) => call[1])).toEqual(CONVERSATIONS)
    // A restore must return the project's threads shared exactly as they were.
    expect(deleteAllGrantsForResource).not.toHaveBeenCalled()
    expect(deleteGrant).not.toHaveBeenCalled()
  })

  it('still records the deletion when the collaboration cleanup throws', async () => {
    vi.mocked(listConversationIdsForProject).mockRejectedValue(new Error('database went away'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      deleteProject(session, PROJECT_ID, 'Halle 3', new Request('https://grid.test/p')),
    ).resolves.toMatchObject({ purgeAfter: expect.any(Date) })

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.deleted', targetId: PROJECT_ID }),
    )
    warn.mockRestore()
  })

  it('keeps neutralising the remaining conversations when one of them fails', async () => {
    vi.mocked(voidOpenRequestsForResource).mockImplementation(async (_type, resourceId) => {
      if (resourceId === 'conv_b') throw new Error('deadlock detected')
      return [requestRow({ resourceId })]
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await neutralizeCollaborationForProject('org_1', PROJECT_ID, CONVERSATIONS)

    // conv_b's failure costs conv_b only — a half-cascade is harder to reason
    // about than a failed one, but abandoning the rest is worse than both.
    expect(result.requests).toBe(2)
    expect(vi.mocked(markItemsInertForResource).mock.calls.map((call) => call[1])).toEqual(CONVERSATIONS)
    warn.mockRestore()
  })
})

describe('the orphan sweep (matrix A6)', () => {
  it('targets only rows whose conversation no longer exists', async () => {
    // The predicate IS the guarantee: a row whose conversation still exists must
    // be excluded in SQL, not filtered in JS after the fact.
    const queries = captureSql()

    const grants = await vi.importActual<typeof import('@/lib/sharing/repository')>(
      '@/lib/sharing/repository',
    )
    const requests = await vi.importActual<typeof import('@/lib/mentions/repository')>(
      '@/lib/mentions/repository',
    )
    const items = await vi.importActual<typeof import('@/lib/inbox/repository')>('@/lib/inbox/repository')

    expect(await grants.deleteOrphanedGrants(500)).toBe(0)
    expect(await requests.deleteOrphanedMentionRequests(500)).toBe(0)
    expect(await items.deleteOrphanedInboxItems(500)).toBe(0)

    expect(queries).toHaveLength(3)
    expect(queries[0]!.sql).toContain(
      'not exists (select 1 from "conversations" where "conversations"."id" = "resource_shares"."resource_id")',
    )
    expect(queries[1]!.sql).toContain(
      'not exists (select 1 from "conversations" where "conversations"."id" = "mention_requests"."resource_id")',
    )
    expect(queries[2]!.sql).toContain(
      'not exists (select 1 from "conversations" where "conversations"."id" = "inbox_items"."resource_id")',
    )
    // Nothing orphaned → no DELETE at all. Three statements, all of them SELECTs.
    expect(queries.every((query) => query.sql.startsWith('select'))).toBe(true)
    expect(queries.every((query) => query.params.includes(500))).toBe(true)
  })

  it('reports what each table gave up, and one failing table does not stop the others', async () => {
    vi.mocked(deleteOrphanedGrants).mockRejectedValue(new Error('lock timeout'))
    vi.mocked(deleteOrphanedMentionRequests).mockResolvedValue(4)
    vi.mocked(deleteOrphanedInboxItems).mockResolvedValue(7)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await sweepOrphanedCollaborationRows()).toEqual({ grants: 0, requests: 4, inboxItems: 7 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('inbox retention (matrix A7, spec IB-15)', () => {
  it('deletes only items older than the LONGEST registered retention window', async () => {
    vi.mocked(pruneInboxItemsOlderThan).mockResolvedValue(12)
    const now = new Date('2026-07-30T12:00:00.000Z')

    const result = await pruneExpiredInboxItems(now)

    const longestDays = Math.max(
      ...Object.values(INBOX_TYPE_DEFINITIONS).map((definition) => definition.retentionDays),
    )
    const expected = new Date(now.getTime() - longestDays * 24 * 60 * 60 * 1000)
    expect(pruneInboxItemsOlderThan).toHaveBeenCalledWith(expected, 1000)
    // Conservative on purpose: never delete something a registered type still
    // wants, even at the cost of keeping shorter-lived types a little longer.
    expect(result).toEqual({ deleted: 12, cutoff: expected.toISOString() })
    expect(expected.getTime()).toBeLessThan(now.getTime())
  })
})

// ---------------------------------------------------------------------------
// B. Modification
// ---------------------------------------------------------------------------

describe('changing visibility (matrix B8–B10, spec SH-2, SH-13, SH-14)', () => {
  it('keeps explicit grants when visibility narrows from project to private', async () => {
    // People who only had project-derived access lose it; the invitees do not —
    // otherwise "narrow the audience" would silently un-invite everyone.
    stubConversation({ visibility: 'project' })
    stubGrants([{ subjectUserId: ANNA, role: 'collaborator' }])

    const state = await setResourceVisibility(session, 'conversation', CONVERSATION_ID, 'private')

    expect(updateConversationVisibilityInOrg).toHaveBeenCalledWith(CONVERSATION_ID, 'org_1', 'private')
    expect(deleteGrant).not.toHaveBeenCalled()
    expect(deleteAllGrantsForResource).not.toHaveBeenCalled()
    expect(state.entries.map((entry) => entry.person.userId)).toContain(ANNA)
  })

  it('writes no audit event and publishes nothing when the save changes nothing', async () => {
    stubConversation({ visibility: 'project' })

    await setResourceVisibility(session, 'conversation', CONVERSATION_ID, 'project')

    expect(updateConversationVisibilityInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('refuses a visibility the registry does not permit for the type', async () => {
    // The column carries `organization`, but conversations expose only
    // private/project in phase 1 (spec SH-15) — the API must say so.
    const failure = await setResourceVisibility(
      session,
      'conversation',
      CONVERSATION_ID,
      'organization',
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).details).toEqual({ allowed: ['private', 'project'] })
    expect(updateConversationVisibilityInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})

describe('changing a role (matrix B11–B13, spec MN-9.4)', () => {
  // A role change edits an existing grant, so every case here starts from one.
  beforeEach(() => {
    stubGrants([{ subjectUserId: ANNA, role: 'collaborator' }])
  })

  it('voids the open requests of someone downgraded to viewer', async () => {
    // A viewer has no composer, so a request waiting on them could never be
    // answered and the hand-off banner would wait forever.
    vi.mocked(voidOpenRequestsForSubject).mockResolvedValue([requestRow()])

    await changeResourceRole(session, 'conversation', CONVERSATION_ID, {
      subjectUserId: ANNA,
      role: 'viewer',
    })

    expect(voidOpenRequestsForSubject).toHaveBeenCalledWith('conversation', CONVERSATION_ID, ANNA)
    // …and THEIR inbox item stops pointing at a question they cannot answer —
    // paired with the recipient, so a colleague mentioned on the same message
    // keeps their own row open (spec MN-10).
    expect(resolveInboxItemsForTargets).toHaveBeenCalledWith([
      {
        organizationId: 'org_1',
        recipientUserId: ANNA,
        groupKey: 'mention.requested:conversation:conv_1:msg_1',
      },
    ])
  })

  it('voids nothing when a role is upgraded', async () => {
    for (const role of ['collaborator', 'owner'] as const) {
      vi.mocked(voidOpenRequestsForSubject).mockClear()
      vi.mocked(upsertGrant).mockClear()
      // Anna starts BELOW the target every time, so each iteration is a genuine
      // upgrade. Starting at `collaborator` made the first pass a no-op, which now
      // returns early — and a no-op does not exercise "an upgrade voids nothing".
      stubGrants([
        { subjectUserId: session.userId, role: 'owner' },
        { subjectUserId: ANNA, role: 'viewer' },
      ])

      await changeResourceRole(session, 'conversation', CONVERSATION_ID, { subjectUserId: ANNA, role })

      expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ subjectUserId: ANNA, role }))
      expect(voidOpenRequestsForSubject).not.toHaveBeenCalled()
    }
  })

  it('does nothing at all when the role is already what was asked for', async () => {
    stubGrants([
      { subjectUserId: session.userId, role: 'owner' },
      { subjectUserId: ANNA, role: 'collaborator' },
    ])

    await changeResourceRole(session, 'conversation', CONVERSATION_ID, {
      subjectUserId: ANNA,
      role: 'collaborator',
    })

    // A repeated click is not a change, so it reaches neither the audit log nor the
    // subject's event channel.
    expect(upsertGrant).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('tells the subject their role changed, so their UI stops offering the composer', async () => {
    // Without this a downgraded participant keeps a composer they may no longer use
    // until their next full reload — and an upgrade goes unnoticed just as long.
    stubGrants([
      { subjectUserId: session.userId, role: 'owner' },
      { subjectUserId: ANNA, role: 'collaborator' },
    ])

    await changeResourceRole(session, 'conversation', CONVERSATION_ID, {
      subjectUserId: ANNA,
      role: 'viewer',
    })

    expect(publishToUsers).toHaveBeenCalledWith(
      [ANNA],
      expect.objectContaining({ kind: 'resource.access.changed', change: 'role_changed' }),
    )
  })

  it('refuses a rename from a collaborator — naming a shared thread is an owner call', async () => {
    stubConversation({ visibility: 'project', createdBy: 'user_other' })
    stubMyGrant('collaborator')

    await expect(
      updateConversationTitle(session, CONVERSATION_ID, 'Neuer Name'),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(updateConversationTitleInOrg).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// C. Access revocation
// ---------------------------------------------------------------------------

describe('revoking a grant (matrix C14–C15, spec SH-13, IB-14)', () => {
  beforeEach(() => {
    stubConversation({ createdBy: 'user_creator' })
    stubMyGrant('owner')
  })

  it('voids the revoked person\'s open requests and neutralises their inbox items', async () => {
    vi.mocked(voidOpenRequestsForSubject).mockResolvedValue([requestRow()])
    vi.mocked(markItemsInertForSubjectRow).mockResolvedValue(2)

    await revokeResourceAccess(session, 'conversation', CONVERSATION_ID, ANNA)

    expect(deleteGrant).toHaveBeenCalledWith('org_1', 'conversation', CONVERSATION_ID, ANNA)
    expect(voidOpenRequestsForSubject).toHaveBeenCalledWith('conversation', CONVERSATION_ID, ANNA)
    expect(markItemsInertForSubjectRow).toHaveBeenCalledWith('conversation', CONVERSATION_ID, ANNA)
  })

  it('wipes the stored payload when it makes an item inert, so a quoted snippet does not outlive access', async () => {
    // The wipe is in the UPDATE's SET clause, so that is what gets asserted:
    // hiding the snippet at render time would still leave it in the row.
    const queries = captureSql([['item_1']])
    const inbox = await vi.importActual<typeof import('@/lib/inbox/repository')>('@/lib/inbox/repository')

    await inbox.markItemsInertForSubjectRow('conversation', CONVERSATION_ID, ANNA)

    expect(queries).toHaveLength(1)
    expect(queries[0]!.sql).toMatch(/^update "inbox_items" set "payload" = \$1/)
    expect(queries[0]!.params[0]).toBe('{}')
    expect(queries[0]!.sql).toContain('"inbox_items"."recipient_user_id" = ')
    expect(queries[0]!.sql).toContain('"inbox_items"."inert_at" is null')
  })

  it('tells the person who lost access that they lost it', async () => {
    await revokeResourceAccess(session, 'conversation', CONVERSATION_ID, ANNA)

    expect(publishToUsers).toHaveBeenCalledWith([ANNA], {
      kind: 'resource.access.changed',
      resourceType: 'conversation',
      resourceId: CONVERSATION_ID,
      change: 'revoked',
    })
  })

  it('does not blow up the revocation for a request that carries no anchor', async () => {
    // `anchor_id` is nullable and `mention.requested` groups per anchor, so a
    // blind group-key build throws here — after the grant is gone but before the
    // inbox is wiped and before the revoked event is published.
    vi.mocked(voidOpenRequestsForSubject).mockResolvedValue([requestRow({ anchorId: null })])

    await expect(
      revokeResourceAccess(session, 'conversation', CONVERSATION_ID, ANNA),
    ).resolves.toBeDefined()

    expect(resolveInboxItemsForTargets).toHaveBeenCalledWith([])
    expect(markItemsInertForSubjectRow).toHaveBeenCalledWith('conversation', CONVERSATION_ID, ANNA)
    expect(publishToUsers).toHaveBeenCalledWith([ANNA], expect.objectContaining({ change: 'revoked' }))
  })
})

describe('leaving, and the last-owner invariant (matrix C16–C17, spec SH-11, SH-12)', () => {
  it('lets a viewer remove their own grant without any ownership', async () => {
    stubConversation({ visibility: 'private', createdBy: 'user_creator' })
    stubMyGrant('viewer')

    await revokeResourceAccess(session, 'conversation', CONVERSATION_ID, session.userId)

    expect(deleteGrant).toHaveBeenCalledWith('org_1', 'conversation', CONVERSATION_ID, session.userId)
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'resource.share.revoked', metadata: expect.objectContaining({ self: true }) }),
    )
  })

  it('refuses the last owner\'s self-demotion, with a machine-readable reason', async () => {
    stubConversation({ createdBy: session.userId })
    stubGrants([{ subjectUserId: session.userId, role: 'owner' }])

    const failure = await changeResourceRole(session, 'conversation', CONVERSATION_ID, {
      subjectUserId: session.userId,
      role: 'collaborator',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).details).toEqual({ reason: 'last-owner' })
    // The guard runs before the write, so a refused demotion changes nothing.
    expect(upsertGrant).not.toHaveBeenCalled()
  })

  it('refuses to let the only remaining owner leave', async () => {
    // The creator is gone (a legacy row), so the sole owner grant is all that
    // stands between the resource and having no in-app way to recover it.
    stubConversation({ createdBy: null })
    stubMyGrant('owner')
    stubGrants([{ subjectUserId: session.userId, role: 'owner' }])

    const failure = await revokeResourceAccess(
      session,
      'conversation',
      CONVERSATION_ID,
      session.userId,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).details).toEqual({ reason: 'last-owner' })
    expect(deleteGrant).not.toHaveBeenCalled()
    expect(voidOpenRequestsForSubject).not.toHaveBeenCalled()
  })

  it('allows the removal once a second owner exists', async () => {
    stubConversation({ createdBy: null })
    stubMyGrant('owner')
    stubGrants([
      { subjectUserId: session.userId, role: 'owner' },
      { subjectUserId: ANNA, role: 'owner' },
    ])

    await revokeResourceAccess(session, 'conversation', CONVERSATION_ID, ANNA)
    expect(deleteGrant).toHaveBeenCalledWith('org_1', 'conversation', CONVERSATION_ID, ANNA)
  })
})

describe('losing PROJECT membership (matrix C18–C20, spec SH-13)', () => {
  it('settles that person\'s state in the project they left, and only there', async () => {
    vi.mocked(voidOpenRequestsForSubjectInProject).mockResolvedValue([
      requestRow({ resourceId: 'conv_a' }),
      requestRow({ id: 'req_2', resourceId: 'conv_b', anchorId: 'msg_2' }),
    ])
    vi.mocked(markItemsInertForSubjectInProject).mockResolvedValue(3)

    const result = await revokeCollaborationForProjectMember('org_1', PROJECT_ID, ANNA)

    expect(result).toEqual({ requests: 2, inboxItems: 3 })
    // Both writes are scoped by (organization, project, subject) — the same person
    // may still hold legitimate state in another project.
    expect(voidOpenRequestsForSubjectInProject).toHaveBeenCalledWith('org_1', PROJECT_ID, ANNA)
    expect(markItemsInertForSubjectInProject).toHaveBeenCalledWith('org_1', PROJECT_ID, ANNA)
    expect(resolveInboxItemsForTargets).toHaveBeenCalledWith([
      {
        organizationId: 'org_1',
        recipientUserId: ANNA,
        groupKey: 'mention.requested:conversation:conv_a:msg_1',
      },
      {
        organizationId: 'org_1',
        recipientUserId: ANNA,
        groupKey: 'mention.requested:conversation:conv_b:msg_2',
      },
    ])
  })

  it('confines both cleanup statements to the conversations of that one project', async () => {
    const queries = captureSql()
    const mentions = await vi.importActual<typeof import('@/lib/mentions/repository')>(
      '@/lib/mentions/repository',
    )
    const inbox = await vi.importActual<typeof import('@/lib/inbox/repository')>('@/lib/inbox/repository')

    await mentions.voidOpenRequestsForSubjectInProject('org_1', PROJECT_ID, ANNA)
    await inbox.markItemsInertForSubjectInProject('org_1', PROJECT_ID, ANNA)

    expect(queries).toHaveLength(2)
    // The ROW's resource id must be the thing constrained to the project's
    // conversations — narrowing some other column would leave the person's state in
    // every other project inside the blast radius.
    expect(queries[0]!.sql).toContain(
      '"mention_requests"."resource_id" in (select "id" from "conversations" where ("conversations"."organization_id" = ',
    )
    expect(queries[1]!.sql).toContain(
      '"inbox_items"."resource_id" in (select "id" from "conversations" where ("conversations"."organization_id" = ',
    )
    for (const query of queries) {
      expect(query.sql).toContain('"conversations"."project_id" = ')
      expect(query.params).toContain(PROJECT_ID)
      expect(query.params).toContain(ANNA)
    }
  })

  it('does not fail the membership change when the cleanup throws', async () => {
    vi.mocked(voidOpenRequestsForSubjectInProject).mockRejectedValue(new Error('lock timeout'))
    vi.mocked(markItemsInertForSubjectInProject).mockRejectedValue(new Error('lock timeout'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(revokeCollaborationForProjectMember('org_1', PROJECT_ID, ANNA)).resolves.toEqual({
      requests: 0,
      inboxItems: 0,
    })
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('does not fail the role removal itself when the cleanup blows up at the call site', async () => {
    // Same guarantee one layer out: `removeProjectRoleAssignment` resolves the
    // membership before it can clean up, and that lookup failing must cost the
    // bookkeeping, not the access-control change the admin actually asked for.
    vi.mocked(findProjectWorkosResourceId).mockResolvedValue('res_project_1')
    listRoleAssignmentsForResource.mockResolvedValue({
      autoPagination: async () => [
        { id: 'ra_1', organizationMembershipId: 'om_anna', role: { slug: 'project-admin' } },
        { id: 'ra_2', organizationMembershipId: 'om_me', role: { slug: 'project-admin' } },
      ],
    })
    getOrganizationMembership.mockRejectedValue(new Error('WorkOS unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      removeProjectRoleAssignment(session, PROJECT_ID, 'ra_1', new Request('https://grid.test/m')),
    ).resolves.toBeUndefined()

    expect(removeRoleAssignment).toHaveBeenCalledWith({
      organizationMembershipId: 'om_anna',
      roleAssignmentId: 'ra_1',
    })
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.role.removed' }),
    )
    warn.mockRestore()
  })

  it('resolves the anchored items even when one voided request has no anchor', async () => {
    // One anchor-less row must not take the whole batch into the catch, or every
    // other recipient's item silently stays unresolved.
    vi.mocked(voidOpenRequestsForSubjectInProject).mockResolvedValue([
      requestRow({ resourceId: 'conv_a', anchorId: null }),
      requestRow({ id: 'req_2', resourceId: 'conv_b', anchorId: 'msg_2' }),
    ])

    const result = await revokeCollaborationForProjectMember('org_1', PROJECT_ID, ANNA)

    expect(result.requests).toBe(2)
    expect(resolveInboxItemsForTargets).toHaveBeenCalledWith([
      {
        organizationId: 'org_1',
        recipientUserId: ANNA,
        groupKey: 'mention.requested:conversation:conv_b:msg_2',
      },
    ])
  })

  it('leaves a retained grant inert: it does not grant access while the container is unreachable', async () => {
    // Grants are additive but always gated by the container (spec SH-5), which is
    // exactly what makes keeping them on a membership removal safe.
    stubConversation({ visibility: 'private', createdBy: 'user_creator' })
    stubMyGrant('owner')
    stubContainer('denied')

    await expect(getConversation(session, CONVERSATION_ID)).rejects.toBeInstanceOf(NotFoundError)
    await expect(getSharingState(session, 'conversation', CONVERSATION_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})
