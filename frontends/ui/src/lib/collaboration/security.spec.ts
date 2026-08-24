/**
 * @vitest-environment node
 */
/**
 * Security probes for the collaboration feature (spec SH-5, SH-6, IB-1, IB-13,
 * IB-14, NF-8).
 *
 * These are the cases where being wrong is not a bug report but an incident: a
 * conversation readable across tenants, an inbox mutable by somebody else, a
 * mention release on a thread the caller cannot open, a grant that smuggles someone
 * into a project, a notification that keeps working after access is gone, a
 * container check that fails OPEN when a lookup breaks.
 *
 * `@/lib/sharing/access`, `@/lib/sharing/registry` and
 * `@/lib/authz/project-membership` all run FOR REAL — the last one is driven through
 * a stubbed WorkOS client and a controllable cache store, because "fails closed" is
 * a property of that module's error handling and cannot be asserted through a mock
 * of itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/lib/events/bus', () => ({
  publishToUser: vi.fn().mockResolvedValue(undefined),
  publishToUsers: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))

const listOrganizationMemberships = vi.fn()
const authorizationCheck = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    userManagement: { listOrganizationMemberships },
    authorization: { check: authorizationCheck },
  }),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/conversations/repository', () => ({
  deleteConversationInOrg: vi.fn(),
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
  deleteGrant: vi.fn(),
  findGrantForSubject: vi.fn(),
  listGrantsForResource: vi.fn(),
  upsertGrant: vi.fn(),
}))

vi.mock('@/lib/mentions/repository', () => ({
  findRequestById: vi.fn(),
  insertMentionRequests: vi.fn(),
  listOpenRequestsForResource: vi.fn(),
  listOpenRequestsForSubject: vi.fn(),
  resolveRequests: vi.fn(),
  voidOpenRequestsForResource: vi.fn(),
  voidOpenRequestsForSubject: vi.fn(),
}))

vi.mock('@/lib/inbox/repository', () => ({
  INBOX_LIST_LIMIT: 50,
  archiveInboxItem: vi.fn(),
  countPendingInboxItems: vi.fn(),
  listInboxItems: vi.fn(),
  markAllInboxItemsRead: vi.fn(),
  markInboxItemsRead: vi.fn(),
  markItemsInertForResource: vi.fn(),
  markItemsInertForSubjectRow: vi.fn(),
  markResourceItemsRead: vi.fn(),
  resolveInboxItemsForTargets: vi.fn(),
  upsertInboxItems: vi.fn(),
}))

// Both WorkOS-backed lookups are replaced (the real `unknownPerson` fallback is
// kept): identity resolution is not what this file is about, and letting it reach
// the stubbed WorkOS client would make every inbox render log a failure.
vi.mock('@/lib/sharing/directory', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/sharing/directory')>()),
  loadOrganizationDirectory: vi.fn(),
  resolvePeople: vi.fn(),
}))

vi.mock('@/lib/limits', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/limits')>()),
  consumeLimit: vi.fn(),
}))

import { drizzle as proxyDrizzle } from 'drizzle-orm/pg-proxy'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canUserAccessProject } from '@/lib/authz/project-membership'
import { requireProjectAccess, type ProjectRole } from '@/lib/authz/projects'
import { setCacheStore, type CacheStore } from '@/lib/cache'
import {
  findConversationInOrg,
  findConversationTenancy,
  insertConversation,
  insertMessages,
  listMessagesForConversation,
  updateConversationTitleInOrg,
  upsertConversationRead,
} from '@/lib/conversations/repository'
import {
  createConversation,
  createConversationMessages,
  deleteConversation,
  getConversation,
  listConversationMessages,
  markConversationRead,
  updateConversationTitle,
} from '@/lib/conversations/service'
import { getDb } from '@/lib/db'
import {
  SHAREABLE_RESOURCE_TYPES,
  type InboxItem,
  type Message,
  type MentionRequest,
  type ResourceRole,
  type ResourceVisibility,
  type ShareableResourceType,
} from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import {
  archiveInboxItem,
  countPendingInboxItems,
  listInboxItems,
  markInboxItemsRead,
  upsertInboxItems,
} from '@/lib/inbox/repository'
import { archiveItem, listInbox, markRead } from '@/lib/inbox/service'
import {
  findRequestById,
  listOpenRequestsForResource,
  listOpenRequestsForSubject,
  resolveRequests,
} from '@/lib/mentions/repository'
import {
  applyMessageMentions,
  getAwaitingState,
  listMentionCandidates,
  releaseRequest,
} from '@/lib/mentions/service'
import { resolveResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory, resolvePeople } from '@/lib/sharing/directory'
import { SHAREABLE_REGISTRY, describeResource } from '@/lib/sharing/registry'
import { MENTION_LIMIT, consumeLimit } from '@/lib/limits'
import { allowedDecision } from '@/test-utils/limit-fixtures'
import {
  countGrantsForResource,
  findGrantForSubject,
  listGrantsForResource,
  upsertGrant,
} from '@/lib/sharing/repository'
import {
  escalateToOwner,
  getSharingState,
  grantResourceAccess,
  revokeResourceAccess,
  setResourceVisibility,
} from '@/lib/sharing/service'

const CONVERSATION_ID = 'conv_1'
const PROJECT_ID = 'proj_1'
const ANNA = 'user_anna'
const OUTSIDER = 'user_outsider'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

/** In-process cache so the real `canUserAccessProject` can be exercised. */
class TestStore implements CacheStore {
  map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key)
  }
}

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
    updatedAt: new Date('2026-07-01T10:00:00Z'),
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
    requestedBy: 'user_other',
    requestedOf: session.userId,
    note: 'Atrium als OIB 2.3?',
    status: 'open',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date('2026-07-29T10:00:00.000Z'),
    ...overrides,
  }
}

const at = new Date('2026-07-29T10:00:00.000Z')

function inboxRow(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'item_1',
    organizationId: 'org_1',
    recipientUserId: session.userId,
    type: 'mention.requested',
    resourceType: 'conversation',
    resourceId: CONVERSATION_ID,
    anchorId: 'msg_1',
    actorUserId: 'user_other',
    groupKey: 'mention.requested:conversation:conv_1:msg_1',
    actionable: true,
    count: 1,
    payload: { subject: 'Brandschutz Halle 3', excerpt: 'Ist das Atrium OIB 2.3?' },
    createdAt: at,
    updatedAt: at,
    readAt: null,
    resolvedAt: null,
    archivedAt: null,
    inertAt: null,
    ...overrides,
  }
}

interface CapturedQuery {
  sql: string
  params: unknown[]
}

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
  setCacheStore(new TestStore())
  stubConversation()
  stubContainer('project-editor')
  stubMyGrant(null)
  vi.mocked(listGrantsForResource).mockResolvedValue([])
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
  vi.mocked(countPendingInboxItems).mockResolvedValue(0)
  vi.mocked(listInboxItems).mockResolvedValue([])
  vi.mocked(listOpenRequestsForResource).mockResolvedValue([])
  vi.mocked(listOpenRequestsForSubject).mockResolvedValue([])
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
  vi.mocked(resolvePeople).mockResolvedValue(new Map())
  vi.mocked(consumeLimit).mockResolvedValue(allowedDecision(MENTION_LIMIT))
  vi.mocked(insertMessages).mockImplementation(async (rows) => rows as Message[])
  vi.mocked(insertConversation).mockResolvedValue(null)
  vi.mocked(listMessagesForConversation).mockResolvedValue([])
  vi.mocked(upsertConversationRead).mockResolvedValue({} as never)
  vi.mocked(upsertGrant).mockResolvedValue({} as never)
  vi.mocked(upsertInboxItems).mockImplementation(async (rows) => rows as never)
  listOrganizationMemberships.mockResolvedValue({ data: [{ id: 'om_1', role: { slug: 'member' } }] })
  authorizationCheck.mockResolvedValue({ authorized: true })
})

describe('a conversation in another organization does not exist (matrix F33, spec SH-6)', () => {
  /** Every session-carrying entry point that resolves a conversation. */
  const entryPoints: Array<[string, () => Promise<unknown>]> = [
    ['getConversation', () => getConversation(session, CONVERSATION_ID)],
    ['listConversationMessages', () => listConversationMessages(session, CONVERSATION_ID)],
    ['updateConversationTitle', () => updateConversationTitle(session, CONVERSATION_ID, 'Neu')],
    ['deleteConversation', () => deleteConversation(session, CONVERSATION_ID)],
    ['markConversationRead', () => markConversationRead(session, CONVERSATION_ID)],
    ['createConversation (id conflict)', () => createConversation(session, { id: CONVERSATION_ID })],
    [
      'createConversationMessages',
      () => createConversationMessages(session, CONVERSATION_ID, [{ id: 'msg_1', role: 'user', content: 'hi' }]),
    ],
    ['getSharingState', () => getSharingState(session, 'conversation', CONVERSATION_ID)],
    ['setResourceVisibility', () => setResourceVisibility(session, 'conversation', CONVERSATION_ID, 'project')],
    [
      'grantResourceAccess',
      () => grantResourceAccess(session, 'conversation', CONVERSATION_ID, { subjectUserId: ANNA, role: 'viewer' }),
    ],
    ['revokeResourceAccess', () => revokeResourceAccess(session, 'conversation', CONVERSATION_ID, ANNA)],
    ['escalateToOwner', () => escalateToOwner(session, 'conversation', CONVERSATION_ID)],
    ['getAwaitingState', () => getAwaitingState(session, CONVERSATION_ID)],
    ['listMentionCandidates', () => listMentionCandidates(session, CONVERSATION_ID)],
    [
      'applyMessageMentions',
      () =>
        applyMessageMentions({
          session,
          resourceType: 'conversation',
          resourceId: CONVERSATION_ID,
          anchorId: 'msg_1',
          mentions: [{ targetId: ANNA }],
        }),
    ],
  ]

  it.each(entryPoints)('refuses %s with a plain 404, never a distinguishable error', async (_name, call) => {
    // The caller holds an OWNER grant. Tenancy is checked first and is never
    // overridable, so the grant buys nothing across the tenant boundary.
    stubConversation({ organizationId: 'org_2', createdBy: session.userId })
    stubMyGrant('owner')

    const failure = await call().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(NotFoundError)
    // Not a 403, and never a container probe: asking about the project would leak
    // that the id resolves to something.
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })

  it('writes nothing on the way out of a cross-tenant mutation', async () => {
    stubConversation({ organizationId: 'org_2', createdBy: session.userId })
    stubMyGrant('owner')

    await expect(
      updateConversationTitle(session, CONVERSATION_ID, 'Neu'),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      grantResourceAccess(session, 'conversation', CONVERSATION_ID, { subjectUserId: ANNA, role: 'viewer' }),
    ).rejects.toBeInstanceOf(NotFoundError)

    expect(updateConversationTitleInOrg).not.toHaveBeenCalled()
    expect(upsertGrant).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })
})

describe('an inbox is only ever the caller\'s own (matrix F34, spec IB-1)', () => {
  it('scopes marking read to the caller in SQL, so foreign ids match nothing', async () => {
    const queries = captureSql()
    const inbox = await vi.importActual<typeof import('@/lib/inbox/repository')>('@/lib/inbox/repository')

    await inbox.markInboxItemsRead('org_1', session.userId, ['item_of_another_user'], inbox.EVERY_INBOX_TYPE)

    expect(queries).toHaveLength(1)
    expect(queries[0]!.sql).toContain('"inbox_items"."organization_id" = ')
    expect(queries[0]!.sql).toContain('"inbox_items"."recipient_user_id" = ')
    expect(queries[0]!.params).toContain(session.userId)
    expect(queries[0]!.params).toContain('org_1')
  })

  it('scopes archiving to the caller in SQL as well', async () => {
    const queries = captureSql()
    const inbox = await vi.importActual<typeof import('@/lib/inbox/repository')>('@/lib/inbox/repository')

    await inbox.archiveInboxItem('org_1', session.userId, 'item_of_another_user', inbox.EVERY_INBOX_TYPE)

    expect(queries[0]!.sql).toContain('"inbox_items"."recipient_user_id" = ')
    expect(queries[0]!.params).toEqual(expect.arrayContaining(['org_1', session.userId, 'item_of_another_user']))
  })

  it('stays quietly a no-op when marking somebody else\'s item read', async () => {
    vi.mocked(markInboxItemsRead).mockResolvedValue(0)

    const result = await markRead(session, ['item_of_another_user'])

    // Reporting "that item is not yours" would confirm the item exists.
    expect(markInboxItemsRead).toHaveBeenCalledWith(
      'org_1',
      session.userId,
      ['item_of_another_user'],
      // The type gate travels with the mutation now: recipient scoping alone let
      // an id kept from before collaboration was disabled still be marked read.
      expect.any(Array),
    )
    expect(result.affected).toBe(0)
  })

  it('answers 404 when archiving somebody else\'s item', async () => {
    vi.mocked(archiveInboxItem).mockResolvedValue(false)

    await expect(archiveItem(session, 'item_of_another_user')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('releasing a mention on an unreachable thread (matrix F35, spec MN-9.2)', () => {
  it('404s a release on a conversation the caller cannot open', async () => {
    // Anyone in the room may release a wait — but only someone in the room.
    vi.mocked(findRequestById).mockResolvedValue(requestRow())
    stubConversation({ visibility: 'private', createdBy: 'user_other' })
    stubMyGrant(null)

    await expect(releaseRequest(session, 'req_1')).rejects.toBeInstanceOf(NotFoundError)
    expect(resolveRequests).not.toHaveBeenCalled()
  })

  it('404s a release on a request from another organization', async () => {
    vi.mocked(findRequestById).mockResolvedValue(requestRow({ organizationId: 'org_2' }))

    await expect(releaseRequest(session, 'req_1')).rejects.toBeInstanceOf(NotFoundError)
    // Tenancy first: never even resolves access on the referenced resource.
    expect(findConversationTenancy).not.toHaveBeenCalled()
    expect(resolveRequests).not.toHaveBeenCalled()
  })
})

describe('sharing is never a back door into a project (matrix F36, spec SH-5)', () => {
  it('refuses an invitee who cannot reach the container project, and writes no grant', async () => {
    // The real `canUserAccessProject` runs: no membership in this organization, so
    // the container precondition is unmet.
    listOrganizationMemberships.mockResolvedValue({ data: [] })

    const failure = await grantResourceAccess(session, 'conversation', CONVERSATION_ID, {
      subjectUserId: OUTSIDER,
      role: 'collaborator',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).details).toMatchObject({
      reason: 'container-access-required',
      projectId: PROJECT_ID,
    })

    // No grant, no silent container grant, and nothing in the audit trail implying
    // either happened.
    expect(upsertGrant).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('refuses when the invitee is in the organization but not in the project', async () => {
    authorizationCheck.mockResolvedValue({ authorized: false })

    await expect(
      grantResourceAccess(session, 'conversation', CONVERSATION_ID, {
        subjectUserId: OUTSIDER,
        role: 'collaborator',
      }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(upsertGrant).not.toHaveBeenCalled()
  })
})

describe('an unregistered resource type (matrix F37)', () => {
  it('is refused before any lookup happens', async () => {
    const unknownType = 'not-a-resource' as ShareableResourceType

    expect(() => describeResource(unknownType)).toThrow(/No registry entry/)
    await expect(resolveResourceAccess(session, unknownType, 'doc_1')).rejects.toThrow(
      /No registry entry/,
    )
    await expect(getSharingState(session, unknownType, 'doc_1')).rejects.toThrow(/No registry entry/)

    // Nothing was probed, so an unregistered type cannot be used to reach data.
    expect(findConversationTenancy).not.toHaveBeenCalled()
    expect(listGrantsForResource).not.toHaveBeenCalled()
  })

  it('registers every declared shareable type, so the list cannot silently drift', async () => {
    expect(Object.keys(SHAREABLE_REGISTRY).sort()).toEqual([...SHAREABLE_RESOURCE_TYPES].sort())
  })
})

describe('the container precondition fails CLOSED (matrix F38, spec SH-5)', () => {
  it('says no for a user with no membership in the organization', async () => {
    listOrganizationMemberships.mockResolvedValue({ data: [] })

    expect(await canUserAccessProject(session, PROJECT_ID, 'user_unknown')).toBe(false)
    // No point asking FGA about a membership that does not exist.
    expect(authorizationCheck).not.toHaveBeenCalled()
  })

  it('says no for a user outside the organization, because the lookup is org-scoped', async () => {
    listOrganizationMemberships.mockResolvedValue({ data: [] })

    expect(await canUserAccessProject(session, PROJECT_ID, 'user_other_tenant')).toBe(false)
    expect(listOrganizationMemberships).toHaveBeenCalledWith({
      userId: 'user_other_tenant',
      organizationId: session.organizationId,
      limit: 1,
    })
  })

  it('says no when the membership lookup itself throws', async () => {
    listOrganizationMemberships.mockRejectedValue(new Error('WorkOS unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await canUserAccessProject(session, PROJECT_ID, ANNA)).toBe(false)
    warn.mockRestore()
  })

  it('says no when the FGA check throws', async () => {
    authorizationCheck.mockRejectedValue(new Error('FGA unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A sharing decision must never default to "yes" because a lookup broke.
    expect(await canUserAccessProject(session, PROJECT_ID, ANNA)).toBe(false)
    warn.mockRestore()
  })

  it('says yes for an org admin without an FGA round-trip, mirroring requireProjectAccess', async () => {
    listOrganizationMemberships.mockResolvedValue({ data: [{ id: 'om_1', role: { slug: 'admin' } }] })

    expect(await canUserAccessProject(session, PROJECT_ID, ANNA)).toBe(true)
    expect(authorizationCheck).not.toHaveBeenCalled()
  })
})

describe('a notification never outlives the access it describes (matrix F39, spec IB-13)', () => {
  it('redacts the link and the snippet once the target is unreachable', async () => {
    vi.mocked(listInboxItems).mockResolvedValue([inboxRow()])
    // The thread is somebody else's private conversation now — a revoked grant, a
    // narrowed visibility, or a project the recipient left all land here.
    stubConversation({ visibility: 'private', createdBy: 'user_other' })
    stubMyGrant(null)

    const { items } = await listInbox(session)

    expect(items[0]!.href).toBeNull()
    expect(items[0]!.excerpt).toBeNull()
    // The SUBJECT is the conversation's title, so it is withheld too. This
    // assertion used to pin `'Brandschutz Halle 3'` — deliberately, on the
    // reading that a redacted row must still "explain itself". It does explain
    // itself: the row survives, carries its inert/unavailable label and its
    // timestamp, and the client renders the generic `inbox.inert` copy in place of
    // the name. What it must not do is keep leaking the title of a thread the
    // recipient can no longer open (spec IB-13, SH-19).
    expect(items[0]!.subject).toBeNull()
    // Redacted, not dropped — the row is still there to explain itself.
    expect(items).toHaveLength(1)
    expect(items[0]!.type).toBe('mention.requested')
  })

  it('returns a working link only while the recipient can still reach the thread', async () => {
    vi.mocked(listInboxItems).mockResolvedValue([inboxRow()])
    stubConversation({ visibility: 'project', createdBy: 'user_other' })

    const { items } = await listInbox(session)

    expect(items[0]!.href).toBe(
      `/app/projects/${PROJECT_ID}/chat?session=${CONVERSATION_ID}#message-msg_1`,
    )
    expect(items[0]!.excerpt).toBe('Ist das Atrium OIB 2.3?')
  })

  it('redacts an inert row without spending a re-authorization query', async () => {
    vi.mocked(listInboxItems).mockResolvedValue([
      inboxRow({ inertAt: at, payload: { subject: 'Brandschutz Halle 3', excerpt: 'leaked' } }),
    ])

    const { items } = await listInbox(session)

    expect(items[0]!.state).toBe('inert')
    expect(items[0]!.href).toBeNull()
    expect(items[0]!.excerpt).toBeNull()
    expect(findConversationTenancy).not.toHaveBeenCalled()
  })
})

describe('a single-player user cannot notice this feature exists (matrix F40, spec NF-8)', () => {
  it('emits no events and no inbox items for a private conversation with no grants', async () => {
    stubConversation({ visibility: 'private', createdBy: session.userId })
    vi.mocked(countGrantsForResource).mockResolvedValue(0)

    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage' },
      { id: 'msg_2', role: 'assistant', content: 'Antwort' },
    ])

    expect(publishToUsers).not.toHaveBeenCalled()
    expect(upsertInboxItems).not.toHaveBeenCalled()
    // The participant set is never even resolved — that is the differential.
    expect(listGrantsForResource).not.toHaveBeenCalled()
  })

  it('starts fanning out as soon as ONE grant exists', async () => {
    stubConversation({ visibility: 'private', createdBy: session.userId })
    vi.mocked(countGrantsForResource).mockResolvedValue(1)
    vi.mocked(listGrantsForResource).mockResolvedValue([
      { subjectUserId: ANNA, role: 'collaborator' } as never,
    ])

    await createConversationMessages(session, CONVERSATION_ID, [
      { id: 'msg_1', role: 'user', content: 'Frage' },
    ])

    expect(publishToUsers).toHaveBeenCalled()
    expect(vi.mocked(upsertInboxItems).mock.calls[0]![0]).toHaveLength(1)
  })
})
