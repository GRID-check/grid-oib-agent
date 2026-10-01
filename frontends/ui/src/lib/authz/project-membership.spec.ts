/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationMemberships = vi.fn()
const check = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ userManagement: { listOrganizationMemberships }, authorization: { check } }),
}))
vi.mock('./org-role-permissions', () => ({ orgRoleHoldsPermission: vi.fn(async () => false) }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { TransientAuthzError } from './errors'
import { resolveSubjectMembership, userHoldsProjectPermission } from './project-membership'
import { setCacheStore } from '@/lib/cache'
import { MapCacheStore } from '@/test-utils/cache-store'

const MEMBERSHIP = { id: 'om_anna', role: { slug: 'member' } }

describe('resolveSubjectMembership', () => {
  let store: MapCacheStore

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store = new MapCacheStore()
    setCacheStore(store)
  })

  it('does not cache a failed lookup as "not a member"', async () => {
    // Stored as `null`, one failed lookup hid the colleague from every picker
    // for the negative TTL.
    listOrganizationMemberships.mockRejectedValueOnce(new Error('workos 429'))
    listOrganizationMemberships.mockResolvedValueOnce({ data: [MEMBERSHIP] })

    await expect(resolveSubjectMembership('org_1', 'u-anna')).resolves.toBeNull()
    expect(store.map.size).toBe(0)

    await expect(resolveSubjectMembership('org_1', 'u-anna')).resolves.toEqual({
      organizationMembershipId: 'om_anna',
      role: 'member',
    })
  })

  it('caches an answered "not a member"', async () => {
    listOrganizationMemberships.mockResolvedValue({ data: [] })

    await resolveSubjectMembership('org_1', 'u-stranger')
    await resolveSubjectMembership('org_1', 'u-stranger')

    expect(listOrganizationMemberships).toHaveBeenCalledTimes(1)
  })
})

describe('the opt-in throw for a caller that can retry (C2)', () => {
  const session = { organizationId: 'org_1' } as AuthorizedSession

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setCacheStore(new MapCacheStore())
  })

  it('keeps the fail-closed default: a lookup that broke reads as not a member', async () => {
    listOrganizationMemberships.mockRejectedValueOnce(new Error('workos 503'))

    await expect(resolveSubjectMembership('org_1', 'u-anna')).resolves.toBeNull()
  })

  it('raises TransientAuthzError instead of "not a member" when asked to', async () => {
    listOrganizationMemberships.mockRejectedValueOnce(new Error('workos 503'))

    await expect(resolveSubjectMembership('org_1', 'u-anna', { onError: 'throw' })).rejects.toBeInstanceOf(
      TransientAuthzError
    )
  })

  it('still answers a definite "not a member" as null, not an error', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({ data: [] })

    await expect(resolveSubjectMembership('org_1', 'u-gone', { onError: 'throw' })).resolves.toBeNull()
  })

  it('keeps the fail-closed default for a broken FGA check', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({ data: [MEMBERSHIP] })
    check.mockRejectedValueOnce(new Error('fga 500'))

    await expect(
      userHoldsProjectPermission(session, 'proj_1', 'u-anna', 'project:documents:write')
    ).resolves.toBe(false)
  })

  it('raises TransientAuthzError for a broken FGA check when asked to', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({ data: [MEMBERSHIP] })
    check.mockRejectedValueOnce(new Error('fga 500'))

    await expect(
      userHoldsProjectPermission(session, 'proj_1', 'u-anna', 'project:documents:write', { onError: 'throw' })
    ).rejects.toBeInstanceOf(TransientAuthzError)
  })

  it('raises for a broken membership lookup underneath the permission check too', async () => {
    listOrganizationMemberships.mockRejectedValueOnce(new Error('workos 503'))

    await expect(
      userHoldsProjectPermission(session, 'proj_1', 'u-anna', 'project:edit', { onError: 'throw' })
    ).rejects.toBeInstanceOf(TransientAuthzError)
    expect(check).not.toHaveBeenCalled()
  })

  it('is a 503 through the ordinary error envelope', () => {
    const error = new TransientAuthzError('fga-check', { cause: new Error('x') })
    expect(error.status).toBe(503)
    expect(error.code).toBe('AUTHZ_UNAVAILABLE')
    expect(error.message).not.toMatch(/x$/)
  })
})
