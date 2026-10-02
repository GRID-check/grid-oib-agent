/**
 * @vitest-environment node
 */
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
  findConversationInOrg: vi.fn(),
  conversationIdsExisting: vi.fn(),
  listConversationIdsForProject: vi.fn(),
  listRestrictedAnswerCollections: vi.fn(),
  hasRestrictedTurn: vi.fn(),
}))

vi.mock('@/lib/documents/repository', () => ({
  findDocumentTenancy: vi.fn(),
  updateDocumentVisibilityInOrg: vi.fn(),
  documentIdsExisting: vi.fn(),
  listDocumentIdsForProject: vi.fn(),
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

vi.mock('@/lib/limits', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/limits')>()),
  consumeLimit: vi.fn(),
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
import {
  findConversationTenancy,
  hasRestrictedTurn,
  listRestrictedAnswerCollections,
  updateConversationVisibilityInOrg,
} from '@/lib/conversations/repository'
import type { ResourceRole, ResourceVisibility } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { requireResourceAccess, resolveResourceAccess } from './access'
import { loadOrganizationDirectory } from './directory'
import { SHARE_LIMIT, consumeLimit } from '@/lib/limits'
import { allowedDecision } from '@/test-utils/limit-fixtures'
import { countGrantsForResource, deleteGrant, listGrantsForResource, upsertGrant } from './repository'
import {
  changeResourceRole,
  escalateToOwner,
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
  vi.mocked(consumeLimit).mockResolvedValue(allowedDecision(SHARE_LIMIT))
  vi.mocked(countGrantsForResource).mockResolvedValue(0)
  vi.mocked(canUserAccessProject).mockResolvedValue(true)
  vi.mocked(isUserInOrganization).mockResolvedValue(true)
  vi.mocked(upsertGrant).mockResolvedValue({} as never)
  vi.mocked(deleteGrant).mockResolvedValue(true)
  vi.mocked(updateConversationVisibilityInOrg).mockResolvedValue({} as never)
  vi.mocked(listRestrictedAnswerCollections).mockResolvedValue([])
  vi.mocked(hasRestrictedTurn).mockResolvedValue(false)
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

describe('escalateToOwner (spec SH-10)', () => {
  beforeEach(() => {
    // A project admin who is not yet party to the thread — what `./access`
    // resolves for the only caller allowed through here.
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: null,
      reason: null,
      visibility: 'private',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: true,
    })
    stubConversation('user_creator')
    // The roster as it reads once the admin's own owner grant has landed.
    stubGrants([{ subjectUserId: 'user_me', role: 'owner' }])
  })

  it('announces the new owner to everyone party to the resource', async () => {
    await escalateToOwner(session, 'conversation', 'conv_1')

    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: 'user_me', role: 'owner' }),
    )
    // Every other mutation here publishes and this one did not, so the creator's
    // open share dialog kept rendering a roster the escalating admin was absent
    // from until a focus event or the minute-long disconnected poll came round.
    expect(publishToUsers).toHaveBeenCalledWith(['user_creator', 'user_me'], {
      kind: 'resource.access.changed',
      resourceType: 'conversation',
      resourceId: 'conv_1',
      change: 'granted',
    })
  })

  it('survives a participant lookup that throws — the escalation is already committed', async () => {
    // The grant and its audit record are durable before the fan-out's two reads
    // even start. Letting one of them throw answered 500 for an escalation that
    // had in fact succeeded, so the admin retried an act already in the log.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(findConversationTenancy).mockRejectedValueOnce(new Error('roster read unavailable'))

    await expect(escalateToOwner(session, 'conversation', 'conv_1')).resolves.toMatchObject({
      resourceId: 'conv_1',
      canManage: true,
    })

    expect(upsertGrant).toHaveBeenCalledTimes(1)
    expect(recordAuditEvent).toHaveBeenCalledTimes(1)
    expect(publishToUsers).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('a conversation that drew on a restricted folder stays with its owner (ADR-0078)', () => {
  const RESTRICTED = 'proj_8f2c3b1e_0000_4000_8000_000000000001_r0123456789ab'

  beforeEach(() => {
    vi.mocked(listRestrictedAnswerCollections).mockResolvedValue([RESTRICTED])
  })

  async function refusal(promise: Promise<unknown>): Promise<ConflictError> {
    const error = await promise.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConflictError)
    return error as ConflictError
  }

  it('refuses to widen its visibility, with a machine-readable reason', async () => {
    stubCallerAccess('owner', 'private')

    const error = await refusal(setResourceVisibility(session, 'conversation', 'conv_1', 'project'))

    expect(error.details).toMatchObject({ reason: 'restricted-content' })
    expect(listRestrictedAnswerCollections).toHaveBeenCalledWith('conv_1', 'org_1')
    expect(updateConversationVisibilityInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('still lets it narrow back to private', async () => {
    stubCallerAccess('owner', 'project')

    await setResourceVisibility(session, 'conversation', 'conv_1', 'private')

    expect(updateConversationVisibilityInOrg).toHaveBeenCalledWith('conv_1', 'org_1', 'private')
  })

  it('refuses a grant — and so a mention that would invite — before spending the rate limit', async () => {
    await refusal(
      grantResourceAccess(session, 'conversation', 'conv_1', { subjectUserId: 'user_member', role: 'viewer' }),
    )

    expect(consumeLimit).not.toHaveBeenCalled()
    expect(upsertGrant).not.toHaveBeenCalled()
  })

  it('refuses a project admin taking ownership: they need not be cleared for the folder', async () => {
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: null,
      reason: null,
      visibility: 'private',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: true,
    })

    await refusal(escalateToOwner(session, 'conversation', 'conv_1'))

    expect(upsertGrant).not.toHaveBeenCalled()
  })

  it('ignores a stored collection that only looks restricted to the SQL pre-filter', async () => {
    // The repository's jsonpath filter is a pre-filter; the decision is the
    // canonical name rule, which wants twelve hex digits after `_r`.
    vi.mocked(listRestrictedAnswerCollections).mockResolvedValue(['proj_x_rNOTHEX000000'])

    await grantResourceAccess(session, 'conversation', 'conv_1', { subjectUserId: 'user_member', role: 'viewer' })

    expect(upsertGrant).toHaveBeenCalled()
  })
})

describe('a conversation that ran a restricted turn stays with its owner, cited or not (ADR-0078)', () => {
  // No stored answer names a restricted collection: the turn used a summary the
  // inventory block put into the prompt, or its answer is still streaming.
  beforeEach(() => {
    vi.mocked(listRestrictedAnswerCollections).mockResolvedValue([])
    vi.mocked(hasRestrictedTurn).mockResolvedValue(true)
  })

  async function refusal(promise: Promise<unknown>): Promise<ConflictError> {
    const error = await promise.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details).toMatchObject({ reason: 'restricted-content' })
    return error as ConflictError
  }

  it('refuses to widen its visibility on the mark alone', async () => {
    stubCallerAccess('owner', 'private')

    await refusal(setResourceVisibility(session, 'conversation', 'conv_1', 'project'))

    expect(hasRestrictedTurn).toHaveBeenCalledWith('conv_1', 'org_1')
    expect(updateConversationVisibilityInOrg).not.toHaveBeenCalled()
  })

  it('refuses a grant, and so a mention that would invite, on the mark alone', async () => {
    await refusal(
      grantResourceAccess(session, 'conversation', 'conv_1', { subjectUserId: 'user_member', role: 'viewer' }),
    )

    expect(upsertGrant).not.toHaveBeenCalled()
  })

  it('refuses a project admin taking ownership on the mark alone', async () => {
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: null,
      reason: null,
      visibility: 'private',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: true,
    })

    await refusal(escalateToOwner(session, 'conversation', 'conv_1'))

    expect(upsertGrant).not.toHaveBeenCalled()
  })
})

describe('a share racing the thread\'s first restricted turn is undone (ADR-0078)', () => {
  // The check before the write passed; the turn's admission marked the thread
  // between that check and the write. The re-check after the write sees it.
  beforeEach(() => {
    vi.mocked(hasRestrictedTurn).mockResolvedValueOnce(false).mockResolvedValue(true)
  })

  it('puts the visibility back and announces nothing', async () => {
    stubCallerAccess('owner', 'private')

    const error = await setResourceVisibility(session, 'conversation', 'conv_1', 'project').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(vi.mocked(updateConversationVisibilityInOrg).mock.calls).toEqual([
      ['conv_1', 'org_1', 'project'],
      ['conv_1', 'org_1', 'private'],
    ])
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('removes the grant it just wrote and announces nothing', async () => {
    const error = await grantResourceAccess(session, 'conversation', 'conv_1', {
      subjectUserId: 'user_member',
      role: 'viewer',
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(upsertGrant).toHaveBeenCalledTimes(1)
    expect(deleteGrant).toHaveBeenCalledWith('org_1', 'conversation', 'conv_1', 'user_member')
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it("removes a project admin's escalation it just wrote", async () => {
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: null,
      reason: null,
      visibility: 'private',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: true,
    })

    const error = await escalateToOwner(session, 'conversation', 'conv_1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(deleteGrant).toHaveBeenCalledWith('org_1', 'conversation', 'conv_1', 'user_me')
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})
