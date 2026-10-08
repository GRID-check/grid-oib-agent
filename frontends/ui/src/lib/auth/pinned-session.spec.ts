/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({ resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/authz/org-role-permissions', () => ({ tenantRolePermissions: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ enabledFlagsForOrganization: vi.fn() }))

import { TransientAuthzError } from '@/lib/authz/errors'
import { tenantRolePermissions } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership } from '@/lib/authz/project-membership'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { resolvePinnedRequesterSession } from './pinned-session'

const requester = { userId: 'user_owner', email: 'owner@grid.test', organizationId: 'org_1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member' })
  vi.mocked(tenantRolePermissions).mockResolvedValue(new Set(['project:view', 'custom:perm']))
  vi.mocked(enabledFlagsForOrganization).mockResolvedValue(['agent-authored-documents', 'project-mail-inbox'])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolvePinnedRequesterSession', () => {
  it('builds the session the requester would have now, from their stored id alone', async () => {
    const session = await resolvePinnedRequesterSession(requester)

    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner', {})
    expect(session).toMatchObject({
      userId: 'user_owner',
      email: 'owner@grid.test',
      organizationId: 'org_1',
      organizationMembershipId: 'om_1',
      role: 'member',
      // No token: nothing on the filing path forwards one, and none is minted.
      accessToken: '',
      featureFlags: null,
    })
  })

  it('takes its permissions from what WorkOS says the role holds, with the catalog', async () => {
    const session = await resolvePinnedRequesterSession(requester)

    // Organization first, role second: the twin of organizationRolePermissions.
    expect(tenantRolePermissions).toHaveBeenCalledWith('org_1', 'member')
    expect(session?.permissions).toEqual(['project:view', 'custom:perm'])
  })

  it('is nobody when the requester left the organization', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce(null)

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it('is nobody when the membership carries no role to derive permissions from', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({ organizationMembershipId: 'om_1', role: null })

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it("carries every flag of the requester's organization under enforcement, asked by that organization", async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')

    const session = await resolvePinnedRequesterSession(requester)
    expect(session?.featureFlags).toEqual(['agent-authored-documents', 'project-mail-inbox'])
    // The lookup that used to pass the slug as the organization (#787).
    expect(enabledFlagsForOrganization).toHaveBeenCalledTimes(1)
    expect(enabledFlagsForOrganization).toHaveBeenCalledWith(requester.organizationId)
  })

  it('lets a failed flag lookup throw, so the background work retries instead of acting with none', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    vi.mocked(enabledFlagsForOrganization).mockRejectedValueOnce(new Error('workos down'))

    await expect(resolvePinnedRequesterSession(requester)).rejects.toThrow('workos down')
  })

  it('hands the error mode to the membership lookup', async () => {
    vi.mocked(resolveSubjectMembership).mockRejectedValueOnce(new TransientAuthzError('membership'))

    await expect(resolvePinnedRequesterSession(requester, { onError: 'throw' })).rejects.toBeInstanceOf(
      TransientAuthzError,
    )
    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner', { onError: 'throw' })
  })

  it('carries no flags at all without enforcement, as a live session without the claim does', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'false')

    expect((await resolvePinnedRequesterSession(requester))?.featureFlags).toBeNull()
    expect(enabledFlagsForOrganization).not.toHaveBeenCalled()
  })
})
