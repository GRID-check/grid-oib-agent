/**
 * Sharing invariants (ADR-0032, spec SH-2, SH-5, SH-11, SH-14).
 *
 * Three rules are worth a regression test each, because each one is a way the
 * feature could quietly become wrong rather than loudly broken:
 *   - a resource can be left with no owner (SH-11);
 *   - a grant can become a back door into a project (SH-5);
 *   - the audit trail can fill with saves that changed nothing (SH-14).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/events/bus', () => ({
  publishToUsers: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/authz/project-membership', () => ({
  canUserAccessProject: vi.fn(),
  isUserInOrganization: vi.fn(),
}))

vi.mock('@/lib/conversations/repository', () => ({
  findConversationTenancy: vi.fn(),
  updateConversationVisibilityInOrg: vi.fn(),
}))

vi.mock('@/lib/mentions/service', () => ({
  voidRequestsForSubject: vi.fn().mockResolvedValue(0),
}))

vi.mock('@/lib/inbox/service', () => ({
  markItemsInertForSubject: vi.fn().mockResolvedValue(0),
}))

vi.mock('./access', () => ({
  requireResourceAccess: vi.fn(),
  resolveResourceAccess: vi.fn(),
}))

vi.mock('./directory', () => ({
  loadOrganizationDirectory: vi.fn(),
  unknownPerson: (userId: string) => ({ userId, email: null, name: userId, profilePictureUrl: null }),
}))

vi.mock('./rate-limit', () => ({
  consumeRateLimit: vi.fn(),
  SHARE_RATE_LIMIT: { action: 'share', limit: 60, windowMs: 3_600_000 },
}))

vi.mock('./repository', () => ({
  countGrantsForResource: vi.fn(),
  deleteGrant: vi.fn(),
  listGrantsForResource: vi.fn(),
  upsertGrant: vi.fn(),
  SHARE_ROSTER_LIMIT: 200,
}))

import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canUserAccessProject, isUserInOrganization } from '@/lib/authz/project-membership'
import { findConversationTenancy, updateConversationVisibilityInOrg } from '@/lib/conversations/repository'
import type { ResourceRole, ResourceVisibility } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { requireResourceAccess } from './access'
import { loadOrganizationDirectory } from './directory'
import { consumeRateLimit } from './rate-limit'
import { countGrantsForResource, deleteGrant, listGrantsForResource, upsertGrant } from './repository'
import {
  changeResourceRole,
  grantResourceAccess,
  revokeResourceAccess,
  setResourceVisibility,
} from './service'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

/** The caller's own access, as `./access` would have resolved it. */
function stubCallerAccess(role: ResourceRole, visibility: ResourceVisibility = 'private'): void {
  vi.mocked(requireResourceAccess).mockResolvedValue({
    role,
    reason: 'grant',
    visibility,
    container: { organizationId: 'org_1', projectId: 'proj_1' },
    canEscalate: false,
  })
}

/**
 * The creator is an immovable owner, so the last-owner invariant can only be
 * violated by demoting or removing the creator's OWN owner grant — which is why
 * these tests point `createdBy` at the target rather than at a bystander.
 */
function stubConversation(createdBy: string, visibility: ResourceVisibility = 'private'): void {
  vi.mocked(findConversationTenancy).mockResolvedValue({
    organizationId: 'org_1',
    projectId: 'proj_1',
    visibility,
    createdBy,
    deletedAt: null,
  })
}

function stubGrants(grants: Array<{ subjectUserId: string; role: ResourceRole }>): void {
  vi.mocked(listGrantsForResource).mockResolvedValue(
    grants.map((grant, index) => ({
      id: `share_${index}`,
      organizationId: 'org_1',
      resourceType: 'conversation',
      resourceId: 'conv_1',
      subjectUserId: grant.subjectUserId,
      role: grant.role,
      grantedBy: 'user_me',
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as never,
  )
}

beforeEach(() => {
  stubCallerAccess('owner')
  stubConversation('user_owner')
  stubGrants([])
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
  vi.mocked(consumeRateLimit).mockResolvedValue({ allowed: true, current: 1, limit: 60 })
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
  vi.mocked(canUserAccessProject).mockResolvedValue(true)
  vi.mocked(isUserInOrganization).mockResolvedValue(true)
  vi.mocked(upsertGrant).mockResolvedValue({} as never)
  vi.mocked(deleteGrant).mockResolvedValue(true)
  vi.mocked(updateConversationVisibilityInOrg).mockResolvedValue({} as never)
})

describe('the last-owner invariant (spec SH-11)', () => {
  it('refuses to demote the only owner, with a machine-readable reason', async () => {
    stubGrants([{ subjectUserId: 'user_owner', role: 'owner' }])

    await expect(
      changeResourceRole(session, 'conversation', 'conv_1', {
        subjectUserId: 'user_owner',
        role: 'collaborator',
      }),
    ).rejects.toBeInstanceOf(ConflictError)

    await changeResourceRole(session, 'conversation', 'conv_1', {
      subjectUserId: 'user_owner',
      role: 'collaborator',
    }).catch((error: unknown) => {
      expect((error as ConflictError).details).toEqual({ reason: 'last-owner' })
    })

    // The guard runs BEFORE the write, so a refused demotion changes nothing.
    expect(upsertGrant).not.toHaveBeenCalled()
  })

  it('refuses to remove the only owner', async () => {
    stubGrants([{ subjectUserId: 'user_owner', role: 'owner' }])

    await expect(
      revokeResourceAccess(session, 'conversation', 'conv_1', 'user_owner'),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(deleteGrant).not.toHaveBeenCalled()
  })

  it('allows demoting an owner while another owner remains', async () => {
    stubGrants([
      { subjectUserId: 'user_owner', role: 'owner' },
      { subjectUserId: 'user_other', role: 'owner' },
    ])

    await changeResourceRole(session, 'conversation', 'conv_1', {
      subjectUserId: 'user_owner',
      role: 'collaborator',
    })
    expect(upsertGrant).toHaveBeenCalledTimes(1)
  })

  it('holds trivially while the creator is around — they are an immovable owner', async () => {
    stubConversation('user_creator')
    stubGrants([{ subjectUserId: 'user_owner', role: 'owner' }])

    await changeResourceRole(session, 'conversation', 'conv_1', {
      subjectUserId: 'user_owner',
      role: 'viewer',
    })
    expect(upsertGrant).toHaveBeenCalledTimes(1)
  })
})

describe('the container precondition (spec SH-5)', () => {
  it('refuses to invite someone who cannot reach the container project', async () => {
    vi.mocked(canUserAccessProject).mockResolvedValue(false)

    const failure = await grantResourceAccess(session, 'conversation', 'conv_1', {
      subjectUserId: 'user_outsider',
      role: 'collaborator',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).details).toMatchObject({
      reason: 'container-access-required',
      projectId: 'proj_1',
    })

    // Sharing is never a back door: no grant, and nothing in the audit trail
    // implying one was made.
    expect(upsertGrant).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('still demands ORGANIZATION membership when there is no container to gate on', async () => {
    // A legacy conversation with no `project_id` used to return early here, so
    // nothing checked the subject at all: a grant could be written for a user in
    // another tenant, and `publishToUsers` would then write to that foreign
    // user's channel.
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: null,
      visibility: 'private',
      createdBy: 'user_owner',
      deletedAt: null,
    })
    vi.mocked(isUserInOrganization).mockResolvedValue(false)

    const failure = await grantResourceAccess(session, 'conversation', 'conv_1', {
      subjectUserId: 'user_of_another_tenant',
      role: 'collaborator',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).details).toEqual({
      reason: 'organization-membership-required',
    })
    expect(isUserInOrganization).toHaveBeenCalledWith(session, 'user_of_another_tenant')
    // No grant row, no audit entry, and nothing published to a channel that is
    // not ours to write to.
    expect(upsertGrant).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('grants on a container-less resource to a member of the organization', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: null,
      visibility: 'private',
      createdBy: 'user_owner',
      deletedAt: null,
    })

    await grantResourceAccess(session, 'conversation', 'conv_1', {
      subjectUserId: 'user_member',
      role: 'collaborator',
    })

    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: 'user_member' }),
    )
    // No project, so no project question is asked.
    expect(canUserAccessProject).not.toHaveBeenCalled()
  })

  it('refuses a role change for someone who holds no grant — it is not a second grant path', async () => {
    // `upsertGrant` is create-or-update, so a `role_changed` call naming an
    // arbitrary user id would otherwise write a brand-new grant while skipping
    // the container check, the roster cap and the rate limit above.
    stubConversation('user_creator')
    stubGrants([{ subjectUserId: 'user_owner', role: 'owner' }])

    await expect(
      changeResourceRole(session, 'conversation', 'conv_1', {
        subjectUserId: 'user_outsider',
        role: 'collaborator',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    expect(upsertGrant).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('grants access to someone who can reach the project', async () => {
    await grantResourceAccess(session, 'conversation', 'conv_1', {
      subjectUserId: 'user_member',
      role: 'collaborator',
    })

    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: 'user_member', role: 'collaborator' }),
    )
    expect(recordAuditEvent).toHaveBeenCalledTimes(1)
  })
})

describe('setResourceVisibility (spec SH-2, SH-14)', () => {
  it('writes no audit event and publishes nothing for a no-op save', async () => {
    stubCallerAccess('owner', 'project')

    await setResourceVisibility(session, 'conversation', 'conv_1', 'project')

    expect(updateConversationVisibilityInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('audits and announces a real change', async () => {
    stubCallerAccess('owner', 'private')

    await setResourceVisibility(session, 'conversation', 'conv_1', 'project')

    expect(updateConversationVisibilityInOrg).toHaveBeenCalledWith('conv_1', 'org_1', 'project')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'resource.visibility.changed',
        metadata: { from: 'private', to: 'project' },
      }),
    )
    expect(publishToUsers).toHaveBeenCalled()
  })

  it('rejects a visibility the resource type does not permit', async () => {
    // Organization-wide chats are withheld until the org policy control exists
    // (spec SH-15); the registry says so, and the API must enforce it.
    await expect(
      setResourceVisibility(session, 'conversation', 'conv_1', 'organization'),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(updateConversationVisibilityInOrg).not.toHaveBeenCalled()
  })
})
