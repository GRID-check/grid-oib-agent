/**
 * @vitest-environment node
 */
/**
 * Effective-access rules (ADR-0032, spec SH-4…SH-6).
 *
 * These are the security-critical cases: each one is a way access could leak or
 * vanish, and each is a line in the spec's decision tree. The registry's probe
 * and the grant lookup are mocked so the assertions are about the RULE, not about
 * drizzle.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/conversations/repository', () => ({
  findConversationTenancy: vi.fn(),
}))

vi.mock('./repository', () => ({
  findGrantForSubject: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/authz/folder-access', () => ({
  isFolderVisibleTo: vi.fn(),
  clearanceOf: vi.fn(() => ({ roles: [], seesEverything: false })),
  requireFolderWrite: vi.fn(),
}))

// What the conversation recorded, judged per person at read time, has its own
// specs (`restricted-use.spec.ts`). Here it is a stub whose answer each test
// sets: by default everybody may read.
vi.mock('@/lib/conversations/restricted-use', () => ({
  peopleWhoMayRead: vi.fn(async (_organizationId: string, _conversationId: string, userIds: readonly string[]) => new Set(userIds)),
  assertMayWidenConversation: vi.fn(),
  widenConversationAudience: vi.fn(),
}))

vi.mock('@/lib/documents/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/repository')>()),
  findDocumentTenancy: vi.fn(),
}))

import { NotFoundError, ResourceRightsLostError } from '@/lib/api/errors'
import { peopleWhoMayRead } from '@/lib/conversations/restricted-use'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { isFolderVisibleTo } from '@/lib/authz/folder-access'
import { findDocumentTenancy } from '@/lib/documents/repository'
import { findConversationTenancy } from '@/lib/conversations/repository'
import type { ProjectRole } from '@/lib/authz/projects'
import type { ResourceRole, ResourceVisibility } from '@/lib/db/schema'
import { isShared, requireResourceAccess, resolveResourceAccess } from './access'
import { findGrantForSubject } from './repository'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

/** Stub the registry's one probe: existence, tenancy, container, visibility, creator. */
function stubConversation(
  overrides: Partial<{
    organizationId: string
    projectId: string | null
    visibility: ResourceVisibility
    createdBy: string
    deletedAt: Date | null
  }> = {},
): void {
  vi.mocked(findConversationTenancy).mockResolvedValue({
    organizationId: 'org_1',
    projectId: 'proj_1',
    visibility: 'private',
    createdBy: 'user_creator',
    deletedAt: null,
    ...overrides,
  })
}

/** The caller's project role, i.e. whether they can reach the container at all. */
function stubContainer(role: ProjectRole | 'denied'): void {
  if (role === 'denied') {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    return
  }
  vi.mocked(requireProjectAccess).mockResolvedValue({ role, closed: false, readsBecauseClosed: false })
}

function stubGrant(role: ResourceRole | null): void {
  vi.mocked(findGrantForSubject).mockResolvedValue(
    role
      ? ({
          id: 'share_1',
          organizationId: 'org_1',
          resourceType: 'conversation',
          resourceId: 'conv_1',
          subjectUserId: session.userId,
          role,
          grantedBy: 'user_creator',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never)
      : null,
  )
}

beforeEach(() => {
  vi.mocked(peopleWhoMayRead).mockImplementation(async (_organizationId, _conversationId, userIds) => new Set(userIds))
  vi.mocked(peopleWhoMayRead).mockClear()
  stubConversation()
  stubContainer('project-editor')
  stubGrant(null)
})

describe('resolveResourceAccess — the two preconditions no grant can override', () => {
  it('treats a resource in another organization as non-existent', async () => {
    stubConversation({ organizationId: 'org_other' })
    stubGrant('owner')

    await expect(resolveResourceAccess(session, 'conversation', 'conv_1')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    // Tenancy is checked FIRST: the grant lookup must not even happen.
    expect(findGrantForSubject).not.toHaveBeenCalled()
  })

  it('treats a soft-deleted resource as non-existent', async () => {
    stubConversation({ deletedAt: new Date() })

    await expect(resolveResourceAccess(session, 'conversation', 'conv_1')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('denies access when the container project is unreachable, even with an owner grant', async () => {
    // Spec SH-5: losing project membership removes effective access to
    // everything inside it, whatever grants remain recorded.
    stubContainer('denied')
    stubGrant('owner')

    await expect(resolveResourceAccess(session, 'conversation', 'conv_1')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})

describe('resolveResourceAccess — effective role is the STRONGEST applicable', () => {
  it('lets a grant raise a weaker visibility-derived role', async () => {
    stubConversation({ visibility: 'project' })
    stubContainer('project-viewer') // → viewer
    stubGrant('collaborator')

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access.role).toBe('collaborator')
    expect(access.reason).toBe('grant')
  })

  it('keeps the visibility-derived role when the grant is weaker (grants never lower access)', async () => {
    stubConversation({ visibility: 'project' })
    stubContainer('project-editor') // → collaborator
    stubGrant('viewer')

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access.role).toBe('collaborator')
    expect(access.reason).toBe('visibility-project')
  })

  it('gives the creator ownership of their own private resource', async () => {
    stubConversation({ visibility: 'private', createdBy: session.userId })
    stubGrant(null)

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access.role).toBe('owner')
    expect(access.reason).toBe('creator')
  })

  it('gives a project admin canEscalate but NOT ownership of a private resource', async () => {
    // Spec SH-10: if admins silently owned every private thread, "private" would
    // be a lie. They get an explicit, audited escalation instead.
    stubConversation({ visibility: 'private', createdBy: 'user_creator' })
    stubContainer('project-admin')
    stubGrant(null)

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access.role).toBeNull()
    expect(access.canEscalate).toBe(true)

    // And escalation does not silently satisfy an authorization check.
    await expect(
      requireResourceAccess(session, 'conversation', 'conv_1', 'viewer'),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('withholds canEscalate from a project admin who ALREADY owns the resource', async () => {
    // An audit-integrity claim, not a cosmetic one: offering the button to an
    // owner would let them "take ownership" of something they already own,
    // writing `resource.ownership.escalated` with `previousRole: 'owner'` — a
    // permanent record of an escalation that never happened, in the very log
    // spec SH-10 exists to keep trustworthy.
    stubConversation({ visibility: 'private', createdBy: 'user_creator' })
    stubContainer('project-admin')
    stubGrant('owner')

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access.role).toBe('owner')
    expect(access.canEscalate).toBe(false)
  })

  it('still offers canEscalate to that same admin when their grant is only collaborator', async () => {
    // The other half of the rule: ownership is what withholds escalation, not
    // holding a grant, so a project admin party to the thread as a collaborator
    // keeps the capability spec SH-10 gives them.
    stubConversation({ visibility: 'private', createdBy: 'user_creator' })
    stubContainer('project-admin')
    stubGrant('collaborator')

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access.role).toBe('collaborator')
    expect(access.canEscalate).toBe(true)
  })

  it('maps a project admin to collaborator under project visibility', async () => {
    stubConversation({ visibility: 'project' })
    stubContainer('project-admin')

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access.role).toBe('collaborator')
    expect(access.canEscalate).toBe(true)
  })

  it('does not require a container when the resource hangs off the organization', async () => {
    // A conversation with no project stamp cannot be described by any project
    // membership, so there is nothing to gate on.
    stubConversation({ projectId: null, visibility: 'private', createdBy: session.userId })

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(access.role).toBe('owner')
    expect(access.canEscalate).toBe(false)
  })
})

describe('requireResourceAccess', () => {
  it('denies as NOT FOUND when the role is too weak', async () => {
    stubConversation({ visibility: 'project' })
    stubContainer('project-viewer') // → viewer

    await expect(
      requireResourceAccess(session, 'conversation', 'conv_1', 'owner'),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns the access when the role satisfies the minimum', async () => {
    stubConversation({ visibility: 'private', createdBy: session.userId })

    const access = await requireResourceAccess(session, 'conversation', 'conv_1', 'owner')
    expect(access.role).toBe('owner')
  })
})

describe('isShared', () => {
  it('treats a private resource with no grants as single-player (ADR-0033)', () => {
    expect(isShared('private', 0)).toBe(false)
    expect(isShared('private', 1)).toBe(true)
    expect(isShared('project', 0)).toBe(true)
  })
})

describe('resolveResourceAccess — a document in a restricted folder (ADR-0080)', () => {
  function stubDocument(folderId: string | null): void {
    vi.mocked(findDocumentTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: 'proj_1',
      folderId,
      visibility: 'project',
      createdBy: session.userId,
      filename: 'Honorarnote.pdf',
      displayName: null,
    })
  }

  it('does not exist for a session not cleared for its folder, whatever grant or ownership it holds', async () => {
    stubDocument('folder_honorare')
    stubGrant('owner')
    vi.mocked(isFolderVisibleTo).mockResolvedValue(false)

    await expect(resolveResourceAccess(session, 'document', 'doc_1')).rejects.toBeInstanceOf(NotFoundError)
    expect(isFolderVisibleTo).toHaveBeenCalledWith(session, 'proj_1', 'folder_honorare')
  })

  it('resolves a cleared session as owner, and asks nothing for an unfiled document', async () => {
    stubDocument('folder_open')
    vi.mocked(isFolderVisibleTo).mockResolvedValue(true)
    await expect(resolveResourceAccess(session, 'document', 'doc_1')).resolves.toMatchObject({ role: 'owner' })

    vi.mocked(isFolderVisibleTo).mockClear()
    stubDocument(null)
    await expect(resolveResourceAccess(session, 'document', 'doc_1')).resolves.toMatchObject({ role: 'owner' })
    expect(isFolderVisibleTo).not.toHaveBeenCalled()
  })
})

describe('the read gate: a role is not the right to read what the conversation drew on (ADR-0081)', () => {
  /** The folders the conversation recorded are no longer ones the asker may read. */
  function lockFor(...locked: string[]): void {
    vi.mocked(peopleWhoMayRead).mockImplementation(async (_organizationId, _conversationId, userIds) =>
      new Set(userIds.filter((userId) => !locked.includes(userId))),
    )
  }

  it('locks the CREATOR who lost a recorded folder: ownership is a role, not a right to read', async () => {
    stubConversation({ createdBy: session.userId })
    lockFor(session.userId)

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access).toMatchObject({ role: 'owner', reason: 'creator', contentLocked: true })
    await expect(requireResourceAccess(session, 'conversation', 'conv_1', 'viewer')).rejects.toBeInstanceOf(
      ResourceRightsLostError,
    )
  })

  it('locks a grantee, at every minimum, not only the weakest', async () => {
    stubGrant('collaborator')
    lockFor(session.userId)

    for (const minimum of ['viewer', 'collaborator'] as const) {
      await expect(requireResourceAccess(session, 'conversation', 'conv_1', minimum)).rejects.toBeInstanceOf(
        ResourceRightsLostError,
      )
    }
  })

  it('locks a member who reads the thread through project visibility', async () => {
    stubConversation({ visibility: 'project' })
    lockFor(session.userId)

    await expect(requireResourceAccess(session, 'conversation', 'conv_1', 'viewer')).rejects.toBeInstanceOf(
      ResourceRightsLostError,
    )
  })

  it('asks the record about the CALLER, with the caller as the asker (their own clearance)', async () => {
    stubGrant('viewer')

    await requireResourceAccess(session, 'conversation', 'conv_1', 'viewer')

    expect(peopleWhoMayRead).toHaveBeenCalledWith('org_1', 'conv_1', [session.userId], undefined, expect.anything())
  })

  it('lets a caller who only manages their own place through: the roster, leaving, deleting their own', async () => {
    stubGrant('viewer')
    lockFor(session.userId)

    await expect(
      requireResourceAccess(session, 'conversation', 'conv_1', 'viewer', { allowLocked: true }),
    ).resolves.toMatchObject({ role: 'viewer', contentLocked: true })
  })

  it('does not look at the record for someone with no role: that stays a plain 404', async () => {
    stubGrant(null)
    stubConversation({ visibility: 'private' })

    await expect(requireResourceAccess(session, 'conversation', 'conv_1', 'viewer')).rejects.toBeInstanceOf(NotFoundError)
    expect(peopleWhoMayRead).not.toHaveBeenCalled()
  })

  it('never locks a document: its content is judged by its folder, not by a record', async () => {
    vi.mocked(findDocumentTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: 'proj_1',
      folderId: null,
      visibility: 'project',
      createdBy: session.userId,
      filename: 'Plan.pdf',
      displayName: null,
    })
    lockFor(session.userId)

    await expect(resolveResourceAccess(session, 'document', 'doc_1')).resolves.toMatchObject({ contentLocked: false })
    expect(peopleWhoMayRead).not.toHaveBeenCalled()
  })
})
