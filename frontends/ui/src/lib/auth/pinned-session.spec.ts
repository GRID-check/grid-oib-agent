/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({ resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))

import { resolveSubjectMembership } from '@/lib/authz/project-membership'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { resolvePinnedRequesterSession } from './pinned-session'

const requester = { userId: 'user_owner', email: 'owner@grid.test', organizationId: 'org_1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member' })
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
      featureFlags: null,
    })
    // Permissions come from the catalog for the role, never from the caller.
    expect(Array.isArray(session?.permissions)).toBe(true)
  })

  it('is nobody when the requester left the organization', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce(null)

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it('is nobody when the membership carries no role to derive permissions from', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({ organizationMembershipId: 'om_1', role: null })

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it('resolves the filing flag per organization under enforcement, and fails closed', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    vi.mocked(isOrgFeatureEnabled).mockResolvedValueOnce(true)
    expect((await resolvePinnedRequesterSession(requester))?.featureFlags).toEqual(['agent-authored-documents'])

    vi.mocked(isOrgFeatureEnabled).mockRejectedValueOnce(new Error('workos down'))
    expect((await resolvePinnedRequesterSession(requester))?.featureFlags).toEqual([])
  })
})
