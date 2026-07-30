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

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
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
  vi.mocked(requireProjectAccess).mockResolvedValue({ role })
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

  it('maps a project admin to collaborator under project visibility', async () => {
    stubConversation({ visibility: 'project' })
    stubContainer('project-admin')

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(access.role).toBe('collaborator')
    expect(access.canEscalate).toBe(true)
  })

  it('does not require a container when the resource hangs off the organization', async () => {
    // Legacy conversations predate project stamping; no project membership could
    // describe them, so there is nothing to gate on.
    stubConversation({ projectId: null, visibility: 'private', createdBy: session.userId })

    const access = await resolveResourceAccess(session, 'conversation', 'conv_1')
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(access.role).toBe('owner')
    expect(access.canEscalate).toBe(false)
  })
})

describe('requireResourceAccess', () => {
  it('denies as NOT FOUND when the role is too weak (spec SH-6)', async () => {
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
