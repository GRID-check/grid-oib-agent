/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({ resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/authz/org-role-permissions', () => ({ tenantRolePermissions: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ enabledFlagsForOrganization: vi.fn() }))
vi.mock('./person', () => ({ resolvePerson: vi.fn() }))

import { TransientAuthzError } from '@/lib/authz/errors'
import { tenantRolePermissions } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership } from '@/lib/authz/project-membership'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { resolvePerson } from './person'
import { resolvePinnedRequesterSession, resolvePinnedRequesterSessionStrict } from './pinned-session'

const requester = { userId: 'user_owner', email: 'owner@grid.test', organizationId: 'org_1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member', roles: ['member'] })
  vi.mocked(tenantRolePermissions).mockResolvedValue(new Set(['project:view', 'custom:perm']))
  vi.mocked(enabledFlagsForOrganization).mockResolvedValue([])
  vi.mocked(resolvePerson).mockResolvedValue({ name: null, email: null, organizationName: null })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolvePinnedRequesterSession', () => {
  it('builds the session the requester would have now, from their stored id alone', async () => {
    const session = await resolvePinnedRequesterSession(requester)

    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner')
    expect(session).toMatchObject({
      userId: 'user_owner',
      email: 'owner@grid.test',
      organizationId: 'org_1',
      organizationMembershipId: 'om_1',
      role: 'member',
      // No token: nothing on the filing path forwards one, and none is minted.
      accessToken: '',
      featureFlags: [],
    })
  })

  it('takes its permissions from what WorkOS says the role holds, with the catalog', async () => {
    const session = await resolvePinnedRequesterSession(requester)

    // Never from the caller, and not from the catalog alone, which knows no
    // custom role. Organization first, role second.
    expect(tenantRolePermissions).toHaveBeenCalledWith('org_1', 'member', {})
    expect(session?.permissions).toEqual(['project:view', 'custom:perm'])
  })

  it('knows the person by name, as a live session does, so an unattended turn is not addressed as nobody', async () => {
    vi.mocked(resolvePerson).mockResolvedValueOnce({
      name: 'Anna Weber', email: 'anna@grid.test', organizationName: 'Atelier Nord',
    })

    const session = await resolvePinnedRequesterSession({ ...requester, email: null })

    expect(resolvePerson).toHaveBeenCalledWith('org_1', 'user_owner')
    // The stored email stands where the row has one; WorkOS fills it where it does not.
    expect(session).toMatchObject({ name: 'Anna Weber', email: 'anna@grid.test', organizationName: 'Atelier Nord' })
    expect((await resolvePinnedRequesterSession(requester))?.email).toBe('owner@grid.test')
  })

  it('is nobody when the requester left the organization', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce(null)

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it('is nobody when the membership carries no role to derive permissions from', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({ organizationMembershipId: 'om_1', role: null, roles: [] })

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it("carries every flag of the requester's organization, asked by that organization", async () => {
    vi.mocked(enabledFlagsForOrganization).mockResolvedValueOnce(['agent-authored-documents', 'image-upload'])

    const session = await resolvePinnedRequesterSession(requester)
    expect(session?.featureFlags).toEqual(['agent-authored-documents', 'image-upload'])
    // The lookup that used to pass the slug as the organization.
    expect(enabledFlagsForOrganization).toHaveBeenCalledWith(requester.organizationId)
  })

  it('lets a failed flag lookup throw, so the background work retries instead of acting with none', async () => {
    vi.mocked(enabledFlagsForOrganization).mockRejectedValueOnce(new Error('workos down'))

    await expect(resolvePinnedRequesterSession(requester)).rejects.toThrow('workos down')
  })
})

describe('permissions across several roles', () => {
  it('holds what every role of the membership holds, as a signed-in claim does', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({
      organizationMembershipId: 'om_1',
      role: 'member',
      roles: ['member', 'project-lead'],
    })
    vi.mocked(tenantRolePermissions).mockImplementation(async (_org, role) =>
      new Set(role === 'member' ? ['project:view'] : ['org:projects:administer'])
    )

    const session = await resolvePinnedRequesterSession(requester)

    expect(session?.role).toBe('member')
    expect(new Set(session?.permissions)).toEqual(new Set(['project:view', 'org:projects:administer']))
  })
})

describe('resolvePinnedRequesterSessionStrict', () => {
  it('asks for every role strictly too, so a role lookup that broke is a retry, not the catalog', async () => {
    vi.mocked(tenantRolePermissions).mockRejectedValueOnce(new TransientAuthzError('role-permissions'))

    await expect(resolvePinnedRequesterSessionStrict(requester)).rejects.toBeInstanceOf(TransientAuthzError)
    expect(tenantRolePermissions).toHaveBeenCalledWith('org_1', 'member', { onError: 'throw' })
  })

  it('builds the same session for a member', async () => {
    expect(await resolvePinnedRequesterSessionStrict(requester)).toMatchObject({ userId: 'user_owner', role: 'member' })
    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner', { onError: 'throw' })
  })

  it('answers null only when WorkOS said the person is not a member', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce(null)
    expect(await resolvePinnedRequesterSessionStrict(requester)).toBeNull()
  })

  it('throws when WorkOS could not be asked, so a caller does not act on "they left"', async () => {
    // The lookup raises a TransientAuthzError in this mode: a 503 to a webhook,
    // a retry to a job.
    vi.mocked(resolveSubjectMembership).mockRejectedValueOnce(new TransientAuthzError('membership'))
    await expect(resolvePinnedRequesterSessionStrict(requester)).rejects.toBeInstanceOf(TransientAuthzError)
    expect(enabledFlagsForOrganization).not.toHaveBeenCalled()
  })
})
