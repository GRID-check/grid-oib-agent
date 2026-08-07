import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/sharing/access', () => ({ resolveResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ resolvePeople: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({ describeResource: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ publishToUser: vi.fn().mockResolvedValue(undefined) }))

vi.mock('./repository', () => ({
  INBOX_LIST_LIMIT: 50,
  listInboxItems: vi.fn(),
  countPendingInboxItems: vi.fn(),
  markInboxItemsRead: vi.fn(),
  markAllInboxItemsRead: vi.fn(),
  archiveInboxItem: vi.fn(),
  markResourceItemsRead: vi.fn(),
  markItemsInertForResource: vi.fn(),
  markItemsInertForSubjectRow: vi.fn(),
  resolveInboxItemsForTargets: vi.fn(),
  upsertInboxItems: vi.fn(),
}))

// The pending/ambient predicates live in SQL, so the two tests that assert them
// render the real repository's WHERE clause with drizzle's dialect. `@/lib/db` is
// mocked so no connection is ever opened.
vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

import { PgDialect } from 'drizzle-orm/pg-core'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { InboxItem, InboxItemType } from '@/lib/db/schema'
import { getDb } from '@/lib/db'
import { publishToUser } from '@/lib/events/bus'
import { resolveResourceAccess } from '@/lib/sharing/access'
import { resolvePeople } from '@/lib/sharing/directory'
import { describeResource } from '@/lib/sharing/registry'
import * as repository from './repository'
import {
  archiveItem,
  getInboxSummary,
  listInbox,
  markAllRead,
  markRead,
  markResourceItemsReadFor,
} from './service'

/**
 * A COMPLETE session, not a two-field cast.
 *
 * This fixture used to be `{ userId, organizationId } as unknown as
 * AuthorizedSession`. That was harmless only while the service ignored
 * everything else on the session; it stopped being harmless when `listInbox`
 * began deriving the visible item types from `featureFlags` (ADR-0042), because
 * the cast made a session carrying NO flags look like a fully specified one.
 * Spelling the session out means the gate is exercised deliberately in both of
 * its states — see the `visibleInboxTypes` describe block — rather than
 * accidentally in whichever one the missing field happened to produce.
 */
function makeSession(overrides: Partial<AuthorizedSession> = {}): AuthorizedSession {
  return {
    userId: 'user_1',
    email: 'user_1@grid.test',
    name: 'Test User',
    accessToken: 'workos_token',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'admin',
    permissions: [],
    featureFlags: null,
    ...overrides,
  }
}

const session = makeSession()

/** Every type the registry knows — what a collaboration tenant may see. */
const ALL_TYPES = [
  'mention.requested',
  'mention.answered',
  'conversation.shared_with_you',
  'conversation.activity',
  'storage.quota_warning',
] as const satisfies readonly InboxItemType[]

/** What a tenant WITHOUT collaboration may see: the operational types only. */
const OPERATIONAL_TYPES = ['storage.quota_warning'] as const satisfies readonly InboxItemType[]

const at = new Date('2026-07-29T10:00:00.000Z')

function row(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'item_1',
    organizationId: 'org_1',
    recipientUserId: 'user_1',
    type: 'conversation.activity',
    resourceType: 'conversation',
    resourceId: 'conv_1',
    anchorId: null,
    actorUserId: 'user_2',
    groupKey: 'conversation.activity:conversation:conv_1',
    actionable: false,
    count: 1,
    payload: { subject: 'Brandschutz Halle 3', excerpt: 'Welche OIB-2 Anforderung gilt hier?' },
    createdAt: at,
    updatedAt: at,
    readAt: null,
    resolvedAt: null,
    archivedAt: null,
    inertAt: null,
    ...overrides,
  }
}

/** A reachable target in project `proj_1`. */
const reachable = {
  role: 'collaborator' as const,
  reason: 'visibility-project' as const,
  visibility: 'project' as const,
  container: { organizationId: 'org_1', projectId: 'proj_1' },
  canEscalate: false,
}

beforeEach(() => {
  // Most of this file is about collaboration items, so the default world is a
  // tenant that HAS collaboration. Flag enforcement is off in tests, so this env
  // opt-in is what `isCollaborationEnabled` reads. The gate's other state is
  // exercised explicitly rather than inherited from an unset variable.
  vi.stubEnv('GRID_COLLABORATION_ENABLED', 'true')
  vi.mocked(repository.listInboxItems).mockResolvedValue([])
  vi.mocked(repository.countPendingInboxItems).mockResolvedValue(3)
  vi.mocked(resolveResourceAccess).mockResolvedValue(reachable)
  vi.mocked(resolvePeople).mockResolvedValue(
    new Map([['user_2', { userId: 'user_2', email: 'anna@grid.test', name: 'Anna Berger', profilePictureUrl: null }]]),
  )
  vi.mocked(describeResource).mockReturnValue({
    deepLink: (resourceId: string, options?: { anchorId?: string; projectId?: string | null }) =>
      `/app/projects/${options?.projectId}/chat?session=${resourceId}` +
      (options?.anchorId ? `#message-${options.anchorId}` : ''),
  } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('listInbox — read-time re-authorization (IB-13)', () => {
  it('redacts an inert row: no working link, no snippet', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({ inertAt: at, payload: { subject: 'Brandschutz', excerpt: 'leaked text' } }),
    ])

    const { items } = await listInbox(session)

    expect(items[0]!.state).toBe('inert')
    expect(items[0]!.href).toBeNull()
    expect(items[0]!.excerpt).toBeNull()
    // Inert is already decided, so it must not cost a re-authorization query.
    expect(resolveResourceAccess).not.toHaveBeenCalled()
  })

  it('redacts an unreachable target, and one unreachable target does not break the page', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({ id: 'item_gone', resourceId: 'conv_gone' }),
      row({ id: 'item_ok', resourceId: 'conv_ok' }),
    ])
    vi.mocked(resolveResourceAccess).mockImplementation(async (_session, _type, resourceId) => {
      if (resourceId === 'conv_gone') throw new NotFoundError()
      return reachable
    })

    const { items } = await listInbox(session)

    const gone = items.find((item) => item.id === 'item_gone')!
    const ok = items.find((item) => item.id === 'item_ok')!
    // Redacted, NOT dropped: a vanished row would read as a bug.
    expect(gone.href).toBeNull()
    expect(gone.excerpt).toBeNull()
    // The subject is the conversation TITLE, so it is gated on access exactly as
    // the snippet is — otherwise "redacted" would only cover half the payload.
    expect(gone.subject).toBeNull()
    expect(ok.href).toBe('/app/projects/proj_1/chat?session=conv_ok')
    expect(ok.excerpt).toBe('Welche OIB-2 Anforderung gilt hier?')
  })

  it('redacts when a probe fails unexpectedly, rather than failing the whole inbox', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([row()])
    vi.mocked(resolveResourceAccess).mockRejectedValue(new Error('database went away'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { items } = await listInbox(session)

    expect(items[0]!.href).toBeNull()
    expect(items[0]!.excerpt).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('treats "exists but you have no role" as unreachable', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([row()])
    vi.mocked(resolveResourceAccess).mockResolvedValue({ ...reachable, role: null, reason: null })

    const { items } = await listInbox(session)

    expect(items[0]!.href).toBeNull()
    expect(items[0]!.excerpt).toBeNull()
  })

  it('re-authorizes each DISTINCT target once, not once per item', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({ id: 'a', resourceId: 'conv_1', anchorId: 'msg_1' }),
      row({ id: 'b', resourceId: 'conv_1', anchorId: 'msg_2' }),
      row({ id: 'c', resourceId: 'conv_1', anchorId: 'msg_3' }),
      row({ id: 'd', resourceId: 'conv_2' }),
    ])

    const { items } = await listInbox(session)

    expect(items).toHaveLength(4)
    // Four rows, two resources: two probes. Per-item probing is the thing that
    // would make this endpoint unusable on a busy inbox.
    expect(resolveResourceAccess).toHaveBeenCalledTimes(2)
    expect(vi.mocked(resolveResourceAccess).mock.calls.map((call) => call[2]).sort()).toEqual([
      'conv_1',
      'conv_2',
    ])
    // Actor names likewise: one directory call for the whole page.
    expect(resolvePeople).toHaveBeenCalledTimes(1)
  })
})

describe('listInbox — projection', () => {
  it('states who, what, where and when on every row', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({ type: 'mention.requested', actionable: true, anchorId: 'msg_7', count: 1 }),
    ])

    const { items, pending } = await listInbox(session)

    expect(items[0]).toMatchObject({
      type: 'mention.requested',
      state: 'unread',
      actionable: true,
      actorName: 'Anna Berger',
      actorUserId: 'user_2',
      href: '/app/projects/proj_1/chat?session=conv_1#message-msg_7',
      subject: 'Brandschutz Halle 3',
      createdAt: '2026-07-29T10:00:00.000Z',
    })
    expect(pending).toBe(3)
  })

  it('derives state strongest-fact-first (inert over archived over resolved over read)', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({ id: 'r', readAt: at }),
      row({ id: 's', readAt: at, resolvedAt: at }),
      row({ id: 't', readAt: at, resolvedAt: at, archivedAt: at }),
      row({ id: 'u', readAt: at, resolvedAt: at, archivedAt: at, inertAt: at }),
    ])

    const { items } = await listInbox(session)

    expect(items.map((item) => item.state)).toEqual(['read', 'resolved', 'archived', 'inert'])
  })

  it('coerces attacker-influenced payload text instead of trusting its shape', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({ id: 'junk', payload: { subject: 42, excerpt: { nested: true } } }),
      row({ id: 'padded', payload: { subject: '  spaced  ', excerpt: 'x'.repeat(2000) } }),
      row({ id: 'empty', payload: {} }),
    ])

    const { items } = await listInbox(session)
    const byId = new Map(items.map((item) => [item.id, item]))

    expect(byId.get('junk')).toMatchObject({ subject: null, excerpt: null })
    expect(byId.get('padded')!.subject).toBe('spaced')
    expect(byId.get('padded')!.excerpt!.length).toBeLessThanOrEqual(501)
    expect(byId.get('empty')).toMatchObject({ subject: null, excerpt: null })
  })

  it('leaves an unresolvable actor nameless rather than showing a raw user id', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([row({ actorUserId: 'user_deactivated' })])
    vi.mocked(resolvePeople).mockResolvedValue(new Map())

    const { items } = await listInbox(session)

    expect(items[0]!.actorName).toBeNull()
    expect(items[0]!.actorUserId).toBe('user_deactivated')
  })

  it('scopes the query to the caller and caps the page', async () => {
    await listInbox(session, { pendingOnly: true })

    expect(repository.listInboxItems).toHaveBeenCalledWith('org_1', 'user_1', {
      pendingOnly: true,
      limit: 50,
      // The type set travels INTO the query rather than filtering rows after
      // they come back, so a type this reader may not see is never fetched.
      types: [...ALL_TYPES],
    })
  })

  it('keeps a read-but-unresolved actionable request in the pending page', async () => {
    // The SQL predicate (asserted below) returns it; nothing in the service may
    // filter it out again — reading a request is not answering it.
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({ id: 'req', type: 'mention.requested', actionable: true, anchorId: 'msg_7', readAt: at }),
    ])

    const { items } = await listInbox(session, { pendingOnly: true })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ state: 'read', actionable: true })
    expect(items[0]!.href).not.toBeNull()
  })
})

describe('getInboxSummary', () => {
  it('is one count and nothing else — it runs on every page render', async () => {
    expect(await getInboxSummary(session)).toEqual({ pending: 3 })

    // Counted over the SAME type set the list uses, so the badge can never
    // promise a row the list will not show.
    expect(repository.countPendingInboxItems).toHaveBeenCalledWith('org_1', 'user_1', [
      ...ALL_TYPES,
    ])
    expect(repository.listInboxItems).not.toHaveBeenCalled()
    expect(resolveResourceAccess).not.toHaveBeenCalled()
    expect(resolvePeople).not.toHaveBeenCalled()
  })
})

describe('mutations are scoped to the caller\'s own inbox', () => {
  it('marks read with the caller\'s user + organization, so foreign ids match nothing', async () => {
    vi.mocked(repository.markInboxItemsRead).mockResolvedValue(0)

    const result = await markRead(session, ['item_of_another_user'])

    expect(repository.markInboxItemsRead).toHaveBeenCalledWith('org_1', 'user_1', [
      'item_of_another_user',
    ])
    // Quietly a no-op: saying "not yours" would confirm the item exists.
    expect(result).toEqual({ affected: 0, pending: 3 })
  })

  it('publishes the recomputed badge count after marking read', async () => {
    vi.mocked(repository.markInboxItemsRead).mockResolvedValue(2)
    vi.mocked(repository.countPendingInboxItems).mockResolvedValue(1)

    const result = await markRead(session, ['item_1', 'item_2'])

    expect(result).toEqual({ affected: 2, pending: 1 })
    expect(publishToUser).toHaveBeenCalledWith('user_1', { kind: 'inbox.changed', pending: 1 })
  })

  it('marks everything read for the caller only', async () => {
    vi.mocked(repository.markAllInboxItemsRead).mockResolvedValue(5)
    vi.mocked(repository.countPendingInboxItems).mockResolvedValue(0)

    expect(await markAllRead(session)).toEqual({ affected: 5, pending: 0 })
    // "All" means the list in front of the caller — scoped to the types they can
    // see, so it cannot settle rows they were never shown.
    expect(repository.markAllInboxItemsRead).toHaveBeenCalledWith('org_1', 'user_1', [
      ...ALL_TYPES,
    ])
    expect(publishToUser).toHaveBeenCalledWith('user_1', { kind: 'inbox.changed', pending: 0 })
  })

  it('answers 404 for archiving an item that is not the caller\'s', async () => {
    vi.mocked(repository.archiveInboxItem).mockResolvedValue(false)

    await expect(archiveItem(session, 'item_of_another_user')).rejects.toBeInstanceOf(NotFoundError)

    expect(repository.archiveInboxItem).toHaveBeenCalledWith('org_1', 'user_1', 'item_of_another_user')
    // No badge event for a mutation that did not happen.
    expect(publishToUser).not.toHaveBeenCalled()
  })

  it('archives the caller\'s own item and refreshes the badge', async () => {
    vi.mocked(repository.archiveInboxItem).mockResolvedValue(true)
    vi.mocked(repository.countPendingInboxItems).mockResolvedValue(2)

    expect(await archiveItem(session, 'item_1')).toEqual({ affected: 1, pending: 2 })
    expect(publishToUser).toHaveBeenCalledWith('user_1', { kind: 'inbox.changed', pending: 2 })
  })

  it('clears a resource\'s items for the caller when they open it (IB-9)', async () => {
    vi.mocked(repository.markResourceItemsRead).mockResolvedValue(4)
    vi.mocked(repository.countPendingInboxItems).mockResolvedValue(1)

    const result = await markResourceItemsReadFor(session, 'conversation', 'conv_1')

    expect(repository.markResourceItemsRead).toHaveBeenCalledWith(
      'org_1',
      'user_1',
      'conversation',
      'conv_1',
    )
    expect(result).toEqual({ affected: 4, pending: 1 })
  })
})

/**
 * The two predicates the inbox's correctness rests on live in SQL, so they are
 * asserted by rendering the real repository's WHERE clause through drizzle's
 * dialect — no database, but also no re-implementation of the predicate in the
 * test, which would prove nothing.
 */
describe('the SQL predicates behind the filters', () => {
  function render(condition: unknown): { sql: string; params: unknown[] } {
    const query = new PgDialect().sqlToQuery(condition as never)
    return { sql: query.sql, params: query.params }
  }

  async function realRepository() {
    return vi.importActual<typeof import('./repository')>('./repository')
  }

  it('pendingOnly keeps unresolved actionable requests but drops read informational ones', async () => {
    let condition: unknown
    const limit = vi.fn().mockResolvedValue([])
    const orderBy = vi.fn(() => ({ limit }))
    const where = vi.fn((value: unknown) => {
      condition = value
      return { orderBy }
    })
    vi.mocked(getDb).mockReturnValue({ select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) } as never)

    const real = await realRepository()
    await real.listInboxItems('org_1', 'user_1', { pendingOnly: true })
    const { sql, params } = render(condition)

    expect(sql).toContain('"inbox_items"."organization_id" = $1')
    expect(sql).toContain('"inbox_items"."recipient_user_id" = $2')
    expect(sql).toContain('"inbox_items"."archived_at" is null')
    // Never a redacted row, and either unread OR an actionable request still open.
    expect(sql).toContain('"inbox_items"."inert_at" is null')
    expect(sql).toContain(
      '"inbox_items"."read_at" is null or ("inbox_items"."actionable" = $3 and "inbox_items"."resolved_at" is null)',
    )
    expect(params).toEqual(['org_1', 'user_1', true])
  })

  it('resolves a settled request for ITS recipient only, never a colleague sharing the group key', async () => {
    // Everyone mentioned on the same message shares
    // `mention.requested:conversation:<id>:<anchor>` — only `recipient_user_id`
    // differs. An UPDATE keyed on the group alone therefore closed Bob's
    // untouched request when Anna answered hers (spec MN-10, lifecycle
    // invariant 3): his badge dropped and his row left `pendingOnly` while the
    // banner still said "awaiting Bob".
    let condition: unknown
    const returning = vi.fn().mockResolvedValue([])
    const where = vi.fn((value: unknown) => {
      condition = value
      return { returning }
    })
    vi.mocked(getDb).mockReturnValue({
      update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })),
    } as never)

    const real = await realRepository()
    await real.resolveInboxItemsForTargets([
      {
        organizationId: 'org_1',
        recipientUserId: 'user_anna',
        groupKey: 'mention.requested:conversation:conv_1:msg_1',
      },
    ])
    const { sql, params } = render(condition)

    expect(sql).toContain('"inbox_items"."organization_id" = ')
    expect(sql).toContain('"inbox_items"."recipient_user_id" = ')
    expect(sql).toContain('"inbox_items"."resolved_at" is null')
    expect(params).toEqual([
      'org_1',
      'user_anna',
      'mention.requested:conversation:conv_1:msg_1',
    ])
  })

  it('marking a resource read clears ambient items only, never actionable ones', async () => {
    let condition: unknown
    const returning = vi.fn().mockResolvedValue([])
    const where = vi.fn((value: unknown) => {
      condition = value
      return { returning }
    })
    vi.mocked(getDb).mockReturnValue({
      update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })),
    } as never)

    const real = await realRepository()
    await real.markResourceItemsRead('org_1', 'user_1', 'conversation', 'conv_1')
    const { sql, params } = render(condition)

    // `actionable = false` is the whole point: opening a thread is not answering
    // the question someone asked you inside it (spec IB-9 / MN-16).
    expect(sql).toContain('"inbox_items"."actionable" = $5')
    expect(sql).toContain('"inbox_items"."read_at" is null')
    expect(params).toEqual(['org_1', 'user_1', 'conversation', 'conv_1', false])
  })
})

/**
 * The per-type gate (ADR-0042).
 *
 * The inbox used to be gated as a whole, at the route: without the collaboration
 * flag every `/api/inbox/*` call answered 403. That became wrong the moment the
 * inbox carried something that is not a collaboration event, because it made the
 * storage warning unreachable for precisely the tenants most likely to hit a
 * quota. The gate now lives on the registry entry and is applied here, so what a
 * reader sees is decided per ITEM TYPE.
 */
describe('visibleInboxTypes gate — the inbox is not collaboration-only', () => {
  it('a tenant WITHOUT collaboration still sees operational items', async () => {
    vi.stubEnv('GRID_COLLABORATION_ENABLED', 'false')

    await listInbox(makeSession())

    // Not a 403 and not an empty set: the operational types, and only those.
    expect(repository.listInboxItems).toHaveBeenCalledWith('org_1', 'user_1', {
      pendingOnly: false,
      limit: 50,
      types: [...OPERATIONAL_TYPES],
    })
  })

  it('a tenant WITHOUT collaboration gets a badge counted over the same set', async () => {
    vi.stubEnv('GRID_COLLABORATION_ENABLED', 'false')

    await getInboxSummary(makeSession())

    expect(repository.countPendingInboxItems).toHaveBeenCalledWith('org_1', 'user_1', [
      ...OPERATIONAL_TYPES,
    ])
  })

  it('a tenant WITH collaboration sees every registered type', async () => {
    await listInbox(makeSession())

    expect(repository.listInboxItems).toHaveBeenCalledWith('org_1', 'user_1', {
      pendingOnly: false,
      limit: 50,
      types: [...ALL_TYPES],
    })
  })

  it('"clear all" without collaboration cannot settle collaboration rows', async () => {
    vi.stubEnv('GRID_COLLABORATION_ENABLED', 'false')
    vi.mocked(repository.markAllInboxItemsRead).mockResolvedValue(1)

    await markAllRead(makeSession())

    const [, , types] = vi.mocked(repository.markAllInboxItemsRead).mock.calls[0]!
    expect(types).toEqual([...OPERATIONAL_TYPES])
    expect(types).not.toContain('mention.requested')
  })
})
