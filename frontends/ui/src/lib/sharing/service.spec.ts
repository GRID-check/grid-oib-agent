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
}))

// The per-person rule itself is `restricted-use.spec.ts` and, against Postgres,
// `restricted-use.integration.spec.ts`. Here: that every widening asks it, with
// the right widening, before any write or rate-limit spend, and writes through it.
const widenings = vi.hoisted(() => ({ executor: { tx: true } }))
vi.mock('@/lib/conversations/restricted-use', () => ({
  assertMayWidenConversation: vi.fn(),
  peopleWhoMayRead: vi.fn(),
  widenConversationAudience: vi.fn(
    async (_session: unknown, _id: string, _widening: unknown, write: (executor: unknown) => Promise<unknown>) =>
      write(widenings.executor),
  ),
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
  requireResourceWriteAccess: vi.fn(),
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

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canUserAccessProject, isUserInOrganization } from '@/lib/authz/project-membership'
import { findConversationTenancy, updateConversationVisibilityInOrg } from '@/lib/conversations/repository'
import { findDocumentTenancy, updateDocumentVisibilityInOrg } from '@/lib/documents/repository'
import {
  assertMayWidenConversation,
  peopleWhoMayRead,
  widenConversationAudience,
} from '@/lib/conversations/restricted-use'
import type { ResourceRole, ResourceVisibility } from '@/lib/db/schema'
import { publishToUsers } from '@/lib/events/bus'
import { requireResourceAccess, requireResourceWriteAccess, resolveResourceAccess } from './access'
import { loadOrganizationDirectory } from './directory'
import { SHARE_LIMIT, consumeLimit } from '@/lib/limits'
import { allowedDecision } from '@/test-utils/limit-fixtures'
import { countGrantsForResource, deleteGrant, listGrantsForResource, upsertGrant } from './repository'
import {
  changeResourceRole,
  escalateToOwner,
  getSharingState,
  grantResourceAccess,
  revokeResourceAccess,
  setResourceVisibility,
} from './service'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
  role: 'member',
  roles: ['member'],
  permissions: [],
} as unknown as AuthorizedSession

/** The caller's own access, as `./access` would have resolved it. */
function stubCallerAccess(role: ResourceRole, visibility: ResourceVisibility = 'private'): void {
  vi.mocked(requireResourceAccess).mockResolvedValue({
    role,
    reason: 'grant',
    visibility,
    container: { organizationId: 'org_1', projectId: 'proj_1' },
    canEscalate: false,
    contentLocked: false,
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
  vi.mocked(assertMayWidenConversation).mockResolvedValue(undefined)
  vi.mocked(peopleWhoMayRead).mockImplementation(async (_org, _id, userIds) => new Set(userIds))
  vi.mocked(requireResourceWriteAccess).mockResolvedValue(undefined)
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
      widenings.executor,
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
      widenings.executor,
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

    expect(updateConversationVisibilityInOrg).toHaveBeenCalledWith('conv_1', 'org_1', 'project', widenings.executor)
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

describe('a document cannot be made private (nothing would enforce it)', () => {
  beforeEach(() => {
    vi.mocked(findDocumentTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: 'proj_1',
      visibility: 'project',
      createdBy: 'user_me',
      folderId: null,
    } as never)
  })

  it('refuses private with 400 and the permitted list, writing and auditing nothing', async () => {
    stubCallerAccess('owner', 'project')

    const error = await setResourceVisibility(session, 'document', 'doc_1', 'private').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BadRequestError)
    expect(error).toMatchObject({ details: { allowed: ['project'] } })
    expect(updateDocumentVisibilityInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('offers only project in the sharing state, so the dialog cannot show the switch', async () => {
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: 'owner',
      reason: 'creator',
      visibility: 'project',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: false,
      contentLocked: false,
    })

    const state = await getSharingState(session, 'document', 'doc_1')

    expect(state.allowedVisibilities).toEqual(['project'])
  })

  it('still lets a document that already says private be set back to project', async () => {
    stubCallerAccess('owner', 'private')
    vi.mocked(updateDocumentVisibilityInOrg).mockResolvedValue({} as never)

    await setResourceVisibility(session, 'document', 'doc_1', 'project')

    expect(updateDocumentVisibilityInOrg).toHaveBeenCalledWith('doc_1', 'org_1', 'project', undefined)
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
      contentLocked: false,
    })
    stubConversation('user_creator')
    // The roster as it reads once the admin's own owner grant has landed.
    stubGrants([{ subjectUserId: 'user_me', role: 'owner' }])
  })

  it('announces the new owner to everyone party to the resource', async () => {
    await escalateToOwner(session, 'conversation', 'conv_1')

    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: 'user_me', role: 'owner' }),
      widenings.executor,
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

describe('a conversation that drew on a restricted folder reaches only people cleared for it (ADR-0084)', () => {
  const notCleared = () =>
    new ConflictError('not cleared', { reason: 'restricted-content', person: 'Ina Praktikantin' })

  async function refusal(promise: Promise<unknown>): Promise<ConflictError> {
    const error = await promise.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConflictError)
    return error as ConflictError
  }

  it('asks about the person before a grant — and so a mention that would invite — and before the rate limit', async () => {
    vi.mocked(assertMayWidenConversation).mockRejectedValue(notCleared())

    const error = await refusal(
      grantResourceAccess(session, 'conversation', 'conv_1', { subjectUserId: 'user_member', role: 'viewer' }),
    )

    expect(error.details).toMatchObject({ reason: 'restricted-content', person: 'Ina Praktikantin' })
    expect(assertMayWidenConversation).toHaveBeenCalledWith(session, 'conv_1', {
      kind: 'person',
      userId: 'user_member',
      self: false,
    })
    expect(consumeLimit).not.toHaveBeenCalled()
    expect(upsertGrant).not.toHaveBeenCalled()
  })

  it('writes a grant to a cleared person through the guard, on its transaction', async () => {
    await grantResourceAccess(session, 'conversation', 'conv_1', { subjectUserId: 'user_member', role: 'viewer' })

    expect(widenConversationAudience).toHaveBeenCalledWith(
      session,
      'conv_1',
      { kind: 'person', userId: 'user_member', self: false },
      expect.any(Function),
    )
    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: 'user_member', role: 'viewer' }),
      widenings.executor,
    )
  })

  it('announces nothing when the guard refuses under its lock', async () => {
    vi.mocked(widenConversationAudience).mockRejectedValueOnce(notCleared())

    await refusal(
      grantResourceAccess(session, 'conversation', 'conv_1', { subjectUserId: 'user_member', role: 'viewer' }),
    )

    expect(upsertGrant).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('asks before widening the visibility, and writes it through the guard', async () => {
    stubCallerAccess('owner', 'private')
    vi.mocked(assertMayWidenConversation).mockRejectedValueOnce(
      new ConflictError('project', { reason: 'restricted-content-project' }),
    )

    const error = await refusal(setResourceVisibility(session, 'conversation', 'conv_1', 'project'))

    expect(error.details).toMatchObject({ reason: 'restricted-content-project' })
    expect(assertMayWidenConversation).toHaveBeenCalledWith(session, 'conv_1', { kind: 'visibility' })
    expect(updateConversationVisibilityInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()

    await setResourceVisibility(session, 'conversation', 'conv_1', 'project')
    expect(updateConversationVisibilityInOrg).toHaveBeenCalledWith('conv_1', 'org_1', 'project', widenings.executor)
  })

  it('lets it narrow back to private without asking', async () => {
    stubCallerAccess('owner', 'project')

    await setResourceVisibility(session, 'conversation', 'conv_1', 'private')

    expect(assertMayWidenConversation).not.toHaveBeenCalled()
    expect(widenConversationAudience).not.toHaveBeenCalled()
    expect(updateConversationVisibilityInOrg).toHaveBeenCalledWith('conv_1', 'org_1', 'private', undefined)
  })

  it('asks about the project admin themself when they take ownership', async () => {
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: null,
      reason: null,
      visibility: 'private',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: true,
      contentLocked: false,
    })
    vi.mocked(assertMayWidenConversation).mockRejectedValueOnce(
      new ConflictError('self', { reason: 'restricted-content-self' }),
    )

    await refusal(escalateToOwner(session, 'conversation', 'conv_1'))

    expect(assertMayWidenConversation).toHaveBeenCalledWith(session, 'conv_1', {
      kind: 'person',
      userId: 'user_me',
      self: true,
    })
    expect(upsertGrant).not.toHaveBeenCalled()
  })

  it('asks nothing for a document, which has no such content', async () => {
    vi.mocked(findDocumentTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: 'proj_1',
      visibility: 'private',
      createdBy: 'user_owner',
      folderId: null,
    } as never)

    await grantResourceAccess(session, 'document', 'doc_1', { subjectUserId: 'user_member', role: 'viewer' })

    expect(assertMayWidenConversation).not.toHaveBeenCalled()
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'doc_1' }), undefined)
  })
})

describe('the roster says who can no longer read what the chat drew on (ADR-0085)', () => {
  const person = (userId: string) => ({ userId, email: null, name: userId, profilePictureUrl: null })

  it('flags a grantee and the creator whose roles no longer reach a recorded folder, and nobody else', async () => {
    stubConversation('user_owner')
    stubGrants([
      { subjectUserId: 'user_ina', role: 'viewer' },
      { subjectUserId: 'user_bob', role: 'collaborator' },
    ])
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([person('user_owner'), person('user_ina'), person('user_bob')].map((p) => [p.userId, p])),
    )
    vi.mocked(peopleWhoMayRead).mockResolvedValue(new Set(['user_bob']))

    const state = await getSharingState(session, 'conversation', 'conv_1')

    expect(Object.fromEntries(state.entries.map((entry) => [entry.person.userId, entry.lostAccess]))).toEqual({
      user_owner: true,
      user_ina: true,
      user_bob: false,
    })
    // One question for the whole roster, asked of the caller's own clearance too.
    expect(peopleWhoMayRead).toHaveBeenCalledTimes(1)
    expect(peopleWhoMayRead).toHaveBeenCalledWith('org_1', 'conv_1', ['user_owner', 'user_ina', 'user_bob'], undefined, expect.anything())
  })

  it('reads the roster for a caller who is locked out of the content themselves, and offers them no management', async () => {
    vi.mocked(requireResourceAccess).mockResolvedValue({
      role: 'owner',
      reason: 'creator',
      visibility: 'private',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: false,
      contentLocked: true,
    })

    const state = await getSharingState(session, 'conversation', 'conv_1')

    expect(requireResourceAccess).toHaveBeenCalledWith(session, 'conversation', 'conv_1', 'viewer', { allowLocked: true })
    expect(state.canManage).toBe(false)
  })

  it('flags nobody for a document, whose content no record judges', async () => {
    vi.mocked(findDocumentTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: 'proj_1',
      visibility: 'private',
      createdBy: 'user_owner',
      folderId: null,
    } as never)

    const state = await getSharingState(session, 'document', 'doc_1')

    expect(state.entries.every((entry) => entry.lostAccess === undefined)).toBe(true)
    expect(peopleWhoMayRead).not.toHaveBeenCalled()
  })

  it('lets a locked caller leave without any right to write', async () => {
    await revokeResourceAccess(session, 'conversation', 'conv_1', session.userId)
    expect(requireResourceAccess).toHaveBeenLastCalledWith(session, 'conversation', 'conv_1', 'viewer', {
      allowLocked: true,
    })
    expect(requireResourceWriteAccess).not.toHaveBeenCalled()
  })
})

describe('sharing a document is a write in its folder (ADR-0085)', () => {
  const readOnly = () => new ForbiddenError('You can read this folder but not change it.', { reason: 'folder-read-only' })

  beforeEach(() => {
    vi.mocked(findDocumentTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: 'proj_1',
      visibility: 'private',
      createdBy: 'user_owner',
      folderId: 'folder_vertraege',
    } as never)
    vi.mocked(requireResourceWriteAccess).mockRejectedValue(readOnly())
  })

  it.each([
    ['a grant', () => grantResourceAccess(session, 'document', 'doc_1', { subjectUserId: 'user_member', role: 'viewer' })],
    ['a visibility change', () => setResourceVisibility(session, 'document', 'doc_1', 'project')],
    ['a role change', () => changeResourceRole(session, 'document', 'doc_1', { subjectUserId: 'user_member', role: 'viewer' })],
    ['removing someone else', () => revokeResourceAccess(session, 'document', 'doc_1', 'user_member')],
    ['taking ownership', () => escalateToOwner(session, 'document', 'doc_1')],
  ])('refuses %s from a reader of a read-only folder, before anything is written or limited', async (_name, act) => {
    stubCallerAccess('owner')
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: null,
      reason: null,
      visibility: 'private',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: true,
      contentLocked: false,
    })

    await expect(act()).rejects.toMatchObject({ status: 403, details: { reason: 'folder-read-only' } })

    expect(requireResourceWriteAccess).toHaveBeenCalledWith(session, 'document', 'doc_1')
    expect(consumeLimit).not.toHaveBeenCalled()
    expect(upsertGrant).not.toHaveBeenCalled()
    expect(deleteGrant).not.toHaveBeenCalled()
  })
})
