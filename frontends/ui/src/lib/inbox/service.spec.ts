import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/sharing/access', () => ({ resolveResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ resolvePeople: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({ describeResource: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ publishToUser: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/platform', () => ({
  hasPlatformPermission: vi.fn(),
  getPlatformOrganizationId: vi.fn(),
}))
// Records the organization each lane's query ran as. Pass-through otherwise.
const laneScopes: string[] = []
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (scope: { organizationId: string }, fn: () => unknown) => {
    laneScopes.push(scope.organizationId)
    return await fn()
  }),
}))

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
import { requireProjectAccess } from '@/lib/authz/projects'
import { getPlatformOrganizationId, hasPlatformPermission } from '@/lib/authz/platform'
import { resolveResourceAccess } from '@/lib/sharing/access'
import { resolvePeople } from '@/lib/sharing/directory'
import { describeResource } from '@/lib/sharing/registry'
import * as repository from './repository'
import {
  upsertWaves,
  archiveItem,
  emitInboxItems,
  type InboxEmission,
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
  'document.assigned_to_you',
  'job.completed',
  'job.failed',
  'job.waiting',
  'document.review_requested',
  'upload.completed',
  'document.quarantined',
  'mail_import.completed',
  'mail_import.failed',
  'inbound_mail.filed',
  'inbound_mail.failed',
] as const satisfies readonly InboxItemType[]

/** What a tenant WITHOUT collaboration may see: the operational types only. */
const OPERATIONAL_TYPES = [
  'storage.quota_warning',
  'job.completed',
  'job.failed',
  // A run stopped to ask its requester something: the same operational class
  // as a run that finished or failed, and invisible without the badge.
  'job.waiting',
  // A Freigabe is not a chat feature (ADR-0054): an office that never bought
  // collaboration still has documents to approve, and gating the one review
  // queue in the product would make it invisible for exactly them.
  'document.review_requested',
  // ADR-0086: an upload being read and a file held back by the content check
  // are about the office's own files, not about working together.
  'upload.completed',
  'document.quarantined',
  // An Outlook archive import ended (ADR-0085): an office without
  // collaboration imports mail too.
  'mail_import.completed',
  'mail_import.failed',
  // A mail the reader sent to a project address was filed (ADR-0075): the
  // inbox is the sender's only receipt, whether or not collaboration is on.
  'inbound_mail.filed',
  // ...and the only word the sender gets when the inbox gave up on the mail.
  'inbound_mail.failed',
] as const satisfies readonly InboxItemType[]

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
  contentLocked: false,
}

beforeEach(() => {
  // Most of this file is about collaboration items, so the default world is a
  // tenant that HAS collaboration. Flag enforcement is off in tests, so this env
  // opt-in is what `isCollaborationEnabled` reads. The gate's other state is
  // exercised explicitly rather than inherited from an unset variable.
  vi.stubEnv('GRID_COLLABORATION_ENABLED', 'true')
  laneScopes.length = 0
  // Not platform staff unless a test says so: the platform lane stays shut.
  vi.mocked(hasPlatformPermission).mockResolvedValue(false)
  vi.mocked(getPlatformOrganizationId).mockResolvedValue('org_platform')
  vi.mocked(repository.listInboxItems).mockResolvedValue([])
  vi.mocked(repository.countPendingInboxItems).mockResolvedValue(3)
  vi.mocked(resolveResourceAccess).mockResolvedValue(reachable)
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-viewer' } as never)
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

describe('listInbox — project href threads the delegated task', () => {
  it('lands on the task detail when the payload names taskId', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({
        id: 'job-done',
        type: 'job.completed',
        resourceType: 'project',
        resourceId: 'proj_1',
        anchorId: 'backend-job-1',
        payload: { subject: 'Wochenbericht', taskId: 'task-1', filedDocumentId: 'doc-9' },
      }),
    ])

    const { items } = await listInbox(session)

    expect(items[0]!.href).toBe('/app/projects/proj_1/automation?tab=tasks&task=task-1')
  })

  it('falls back to the automation page when taskId is absent or blank', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      row({
        id: 'job-no-task',
        type: 'job.completed',
        resourceType: 'project',
        resourceId: 'proj_1',
        anchorId: 'backend-job-1',
        payload: { subject: 'Wochenbericht', taskId: null, filedDocumentId: null },
      }),
      row({
        id: 'job-blank-task',
        type: 'job.failed',
        resourceType: 'project',
        resourceId: 'proj_1',
        anchorId: 'backend-job-2',
        payload: { subject: 'Nachtlauf', taskId: '   ' },
      }),
    ])

    const { items } = await listInbox(session)
    const byId = new Map(items.map((item) => [item.id, item]))

    expect(byId.get('job-no-task')!.href).toBe('/app/projects/proj_1/automation?tab=jobs')
    expect(byId.get('job-blank-task')!.href).toBe('/app/projects/proj_1/automation?tab=jobs')
  })
})

describe('listInbox — a filed mail (ADR-0075)', () => {
  const filed = (overrides: Partial<InboxItem> = {}) =>
    row({
      id: 'mail-1',
      type: 'inbound_mail.filed',
      resourceType: 'project',
      resourceId: 'proj_1',
      anchorId: 'msg-row-1',
      actorUserId: null,
      payload: {
        subject: 'Pläne',
        folderId: 'folder-9',
        params: {
          filed: 3,
          skipped: 1,
          project: 'Wohnbau Hietzing',
          skippedFiles: [{ name: 'Einladung.ics', reason: 'calendar' }],
        },
      },
      ...overrides,
    })

  it('opens the mail folder and carries the counts the copy interpolates', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([filed()])

    const { items } = await listInbox(session)

    expect(items[0]).toMatchObject({
      href: '/app/projects/proj_1/files?folder=folder-9',
      subject: 'Pläne',
      params: {
        filed: 3,
        skipped: 1,
        project: 'Wohnbau Hietzing',
        skippedFiles: [{ name: 'Einladung.ics', reason: 'calendar' }],
      },
    })
  })

  it('renders a subject the mail did not have as null, for the copy to word', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      filed({ payload: { subject: null, params: { filed: 0, skipped: 0, project: 'W', skippedFiles: [] } } }),
    ])

    const { items } = await listInbox(session)

    expect(items[0].subject).toBeNull()
    expect(items[0].params).toEqual({ filed: 0, skipped: 0, project: 'W', skippedFiles: [] })
  })

  it('drops params that do not fit the type\'s schema, and withholds it all when redacted', async () => {
    vi.mocked(repository.listInboxItems).mockResolvedValue([
      filed({
        id: 'junk',
        payload: {
          subject: 'x',
          params: { filed: Number.NaN, skipped: 2, 'bad key': 'x', nested: { a: 1 }, project: 'p'.repeat(500) },
        },
      }),
      filed({ id: 'inert', inertAt: at }),
      // Params written for another type are not this type's.
      row({ id: 'foreign', type: 'job.failed', payload: { params: { filed: 1 } } }),
    ])

    const { items } = await listInbox(session)
    const byId = new Map(items.map((item) => [item.id, item]))

    // Not a part of them: a row whose params no longer fit renders without.
    expect(byId.get('junk')!.params).toBeUndefined()
    expect(byId.get('foreign')!.params).toBeUndefined()
    // No folder named: the project's file root.
    expect(byId.get('junk')!.href).toBe('/app/projects/proj_1/files')
    expect(byId.get('inert')!.params).toBeUndefined()
  })
})

describe('emitInboxItems — params are checked against the type (D11)', () => {
  const mail = (params: unknown, subject: string | null = null) =>
    ({
      organizationId: 'org_1',
      recipientUserId: 'user_1',
      type: 'inbound_mail.filed',
      resourceType: 'project',
      resourceId: 'proj_1',
      anchorId: 'msg-row-1',
      actorUserId: null,
      groupKey: 'inbound_mail.filed:project:proj_1:msg-row-1',
      payload: { subject, folderId: null, params },
    }) as InboxEmission

  beforeEach(() => {
    vi.mocked(repository.upsertInboxItems).mockResolvedValue([{ id: 'i1' }] as never)
  })

  it('writes params that match, with a null subject left for the copy', async () => {
    const params = { filed: 0, skipped: 1, project: 'Wohnbau', skippedFiles: [{ name: 'a.ics', reason: 'calendar' }] }

    await emitInboxItems([mail(params)])

    const [rows] = vi.mocked(repository.upsertInboxItems).mock.calls[0]
    expect(rows[0].payload).toEqual({ subject: null, folderId: null, params })
  })

  it.each([
    ['a dropped value', { filed: 1, skipped: 0, project: 'W' }],
    ['a renamed value', { filed: 1, skippedCount: 0, project: 'W', skippedFiles: [] }],
    ['an unknown reason', { filed: 1, skipped: 1, project: 'W', skippedFiles: [{ name: 'x', reason: 'rejected' }] }],
    ['more than ten skipped files', {
      filed: 0, skipped: 11, project: 'W',
      skippedFiles: Array.from({ length: 11 }, (_, n) => ({ name: `f${n}`, reason: 'limit' })),
    }],
    ['an uncapped name', { filed: 0, skipped: 1, project: 'W', skippedFiles: [{ name: 'n'.repeat(121), reason: 'type' }] }],
  ])('refuses %s before anything is written', async (_label, params) => {
    await expect(emitInboxItems([mail(params)])).rejects.toThrow(/inbound_mail\.filed/)
    expect(repository.upsertInboxItems).not.toHaveBeenCalled()
  })

  it('refuses params on a type that declares none', async () => {
    const stray = { ...mail(undefined), type: 'job.failed', payload: { params: { filed: 1 } } } as unknown as InboxEmission
    await expect(emitInboxItems([stray])).rejects.toThrow(/takes no params/)
  })

  it('takes the failure notice with its project alone', async () => {
    const failed = {
      ...mail(undefined),
      type: 'inbound_mail.failed',
      groupKey: 'inbound_mail.failed:project:proj_1:msg-row-1',
      payload: { subject: null, params: { project: 'Wohnbau' } },
    } as InboxEmission
    await expect(emitInboxItems([failed])).resolves.toBe(1)
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

    // The type scope travels with the mutation, not just with the reads: an id
    // kept from before collaboration was disabled belongs to this recipient
    // either way, so recipient scoping alone did not enforce the gate.
    expect(repository.markInboxItemsRead).toHaveBeenCalledWith(
      'org_1',
      'user_1',
      ['item_of_another_user'],
      [...ALL_TYPES],
    )
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

    expect(repository.archiveInboxItem).toHaveBeenCalledWith(
      'org_1',
      'user_1',
      'item_of_another_user',
      [...ALL_TYPES],
    )
    // No badge event for a mutation that did not happen.
    expect(publishToUser).not.toHaveBeenCalled()
  })

  // The gap the type scope closes. A caller who kept an item id from before
  // collaboration was switched off could still archive or read that now-hidden
  // item: the row is theirs, so recipient scoping matched it, and the gate lived
  // only on the read paths. Both mutations now carry the same scope the list
  // does, and the repository takes it as a REQUIRED argument so a new query
  // cannot omit it silently.
  it('narrows both mutations to the types the caller may see', async () => {
    // Collaboration off, the way the rest of this file does it.
    vi.stubEnv('GRID_COLLABORATION_ENABLED', 'false')
    vi.mocked(repository.markInboxItemsRead).mockResolvedValue(0)
    vi.mocked(repository.archiveInboxItem).mockResolvedValue(false)

    await markRead(session, ['collab_item'])
    const readScope = vi.mocked(repository.markInboxItemsRead).mock.calls[0]![3]
    expect(readScope).not.toContain('mention.requested')
    expect(readScope).toContain('storage.quota_warning')

    await expect(archiveItem(session, 'collab_item')).rejects.toBeInstanceOf(NotFoundError)
    const archiveScope = vi.mocked(repository.archiveInboxItem).mock.calls[0]![3]
    expect(archiveScope).toEqual(readScope)
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
    await real.listInboxItems('org_1', 'user_1', {
      pendingOnly: true,
      types: real.EVERY_INBOX_TYPE,
    })
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

/**
 * The platform lane: rows addressed to platform staff live in the PLATFORM
 * organization (product feedback), and an owner reads them from whichever
 * organization they are working in.
 */
describe('the platform lane', () => {
  const feedbackRow = row({
    id: 'item_feedback',
    organizationId: 'org_platform',
    type: 'feedback.submitted',
    resourceType: 'product_feedback',
    resourceId: 'report_1',
    actorUserId: 'user_elsewhere',
    groupKey: 'feedback.submitted:product_feedback:report_1',
    payload: { subject: 'Büro Nord', excerpt: 'Upload hängt', actorName: 'Maria Huber' },
    updatedAt: new Date('2026-07-29T11:00:00.000Z'),
  })

  function listByOrganization(tenantRows: InboxItem[], platformRows: InboxItem[]) {
    vi.mocked(repository.listInboxItems).mockImplementation(async (organizationId) =>
      organizationId === 'org_platform' ? platformRows : tenantRows,
    )
  }

  it('stays shut for a reader without the platform permission', async () => {
    listByOrganization([row()], [feedbackRow])

    const { items } = await listInbox(session)

    expect(items.map((item) => item.id)).toEqual(['item_1'])
    expect(laneScopes).toEqual([])
    expect(vi.mocked(repository.listInboxItems).mock.calls.map((call) => call[0])).toEqual(['org_1'])
  })

  it('merges platform rows into the list, newest first, queried AS the platform organization', async () => {
    vi.mocked(hasPlatformPermission).mockResolvedValue(true)
    listByOrganization([row()], [feedbackRow])

    const { items } = await listInbox(session)

    expect(items.map((item) => item.id)).toEqual(['item_feedback', 'item_1'])
    // RLS shows the platform rows only inside that tenant scope, and only
    // the platform lane pays for it (its list and its badge count).
    expect(laneScopes.length).toBeGreaterThan(0)
    expect(new Set(laneScopes)).toEqual(new Set(['org_platform']))
    const platformCall = vi
      .mocked(repository.listInboxItems)
      .mock.calls.find((call) => call[0] === 'org_platform')!
    expect(platformCall[1]).toBe('user_1')
    expect(platformCall[2].types).toEqual(['feedback.submitted'])
  })

  it('links the report and names its author from the payload snapshot', async () => {
    vi.mocked(hasPlatformPermission).mockResolvedValue(true)
    listByOrganization([], [feedbackRow])

    const { items } = await listInbox(session)

    expect(items[0]!.href).toBe('/app/platform/feedback?report=report_1')
    // The author is in another organization, which the reader's directory
    // cannot resolve.
    expect(items[0]!.actorName).toBe('Maria Huber')
    expect(items[0]!.excerpt).toBe('Upload hängt')
  })

  it('never asks the tenant lane for a platform type, so no row is listed twice', async () => {
    vi.mocked(hasPlatformPermission).mockResolvedValue(true)
    // The owner is ACTING in the platform organization.
    const insidePlatform = makeSession({ organizationId: 'org_platform' })

    await listInbox(insidePlatform)

    const typeSets = vi.mocked(repository.listInboxItems).mock.calls.map((call) => call[2].types)
    expect(typeSets).toHaveLength(2)
    const [tenant, platform] = typeSets as InboxItemType[][]
    expect(tenant).not.toContain('feedback.submitted')
    expect(platform).toEqual(['feedback.submitted'])
  })

  it('counts both lanes in the badge', async () => {
    vi.mocked(hasPlatformPermission).mockResolvedValue(true)
    vi.mocked(repository.countPendingInboxItems).mockImplementation(async (organizationId) =>
      organizationId === 'org_platform' ? 2 : 3,
    )

    expect(await getInboxSummary(session)).toEqual({ pending: 5 })
  })

  it('archives a platform row through its own lane', async () => {
    vi.mocked(hasPlatformPermission).mockResolvedValue(true)
    vi.mocked(repository.archiveInboxItem).mockImplementation(
      async (organizationId) => organizationId === 'org_platform',
    )

    const result = await archiveItem(session, 'item_feedback')

    expect(result.affected).toBe(1)
  })

  it('stays shut when the platform organization is not provisioned', async () => {
    vi.mocked(hasPlatformPermission).mockResolvedValue(true)
    vi.mocked(getPlatformOrganizationId).mockResolvedValue(null)

    await getInboxSummary(session)

    expect(vi.mocked(repository.countPendingInboxItems).mock.calls.map((call) => call[0])).toEqual([
      'org_1',
    ])
  })
})

/**
 * Two emissions that fold into one row in the same call (two files of one
 * settle quarantined for the same reviewer) used to reach one INSERT … ON
 * CONFLICT DO UPDATE, which Postgres refuses. They go in successive waves.
 */
describe('emitInboxItems — repeated keys in one call', () => {
  it('splits rows so no wave repeats a (recipient, group) key, keeping order', () => {
    const row = (recipientUserId: string, groupKey: string, n: number) => ({ recipientUserId, groupKey, n })
    const waves = upsertWaves([row('a', 'g', 1), row('b', 'g', 2), row('a', 'g', 3), row('a', 'g', 4), row('a', 'h', 5)])
    expect(waves.map((wave) => wave.map((r) => r.n))).toEqual([[1, 2, 5], [3], [4]])
  })

  it('upserts each wave on its own', async () => {
    vi.mocked(repository.upsertInboxItems).mockResolvedValue([])
    const emission = {
      organizationId: 'org-1',
      recipientUserId: 'reviewer',
      type: 'document.quarantined' as const,
      resourceType: 'organization' as const,
      resourceId: 'org-1',
      actorUserId: 'uploader',
      groupKey: 'document.quarantined:organization:org-1',
    }
    await emitInboxItems([emission, emission])
    expect(repository.upsertInboxItems).toHaveBeenCalledTimes(2)
  })
})
