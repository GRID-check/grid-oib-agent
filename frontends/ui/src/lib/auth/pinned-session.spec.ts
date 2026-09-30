/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({ resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/authz/org-role-permissions', () => ({ tenantRolePermissions: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ enabledSlugsForOrg: vi.fn() }))

import { TransientAuthzError } from '@/lib/authz/errors'
import { tenantRolePermissions } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership } from '@/lib/authz/project-membership'
import { enabledSlugsForOrg } from '@/lib/workos/feature-flags'
import { resolvePinnedRequesterSession } from './pinned-session'

const requester = { userId: 'user_owner', email: 'owner@grid.test', organizationId: 'org_1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member' })
  vi.mocked(tenantRolePermissions).mockResolvedValue(new Set(['project:view', 'custom:perm']))
  vi.mocked(enabledSlugsForOrg).mockResolvedValue(new Set(['agent-authored-documents', 'project-mail-inbox']))
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

  describe('under flag enforcement', () => {
    beforeEach(() => vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true'))

    it('asks for the ORGANIZATION’s flags, by its id (the #787 swap)', async () => {
      await resolvePinnedRequesterSession(requester)

      // Before the fix the call was isOrgFeatureEnabled('org_1', 'agent-authored-documents'):
      // the org id read as the slug, the slug as the org, and filing never ran.
      expect(enabledSlugsForOrg).toHaveBeenCalledTimes(1)
      expect(enabledSlugsForOrg).toHaveBeenCalledWith('org_1')
    })

    it('carries every flag the organization has, not only the first one a caller needed', async () => {
      const session = await resolvePinnedRequesterSession(requester)

      expect(session?.featureFlags).toEqual(['agent-authored-documents', 'project-mail-inbox'])
    })

    it('fails closed by default: a flag read that broke is every flag off', async () => {
      vi.mocked(enabledSlugsForOrg).mockRejectedValueOnce(new Error('workos down'))

      expect((await resolvePinnedRequesterSession(requester))?.featureFlags).toEqual([])
    })

    it('raises a transient error instead when the caller can retry', async () => {
      vi.mocked(enabledSlugsForOrg).mockRejectedValueOnce(new Error('workos down'))

      await expect(resolvePinnedRequesterSession(requester, { onError: 'throw' })).rejects.toBeInstanceOf(
        TransientAuthzError,
      )
    })
  })

  it('hands the error mode to the membership lookup', async () => {
    vi.mocked(resolveSubjectMembership).mockRejectedValueOnce(new TransientAuthzError('membership'))

    await expect(resolvePinnedRequesterSession(requester, { onError: 'throw' })).rejects.toBeInstanceOf(
      TransientAuthzError,
    )
    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner', { onError: 'throw' })
  })

  it('reads no flags without enforcement: the gates read the environment instead', async () => {
    await resolvePinnedRequesterSession(requester)

    expect(enabledSlugsForOrg).not.toHaveBeenCalled()
  })
})
