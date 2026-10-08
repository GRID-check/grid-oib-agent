/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationMemberships = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ userManagement: { listOrganizationMemberships } }),
}))

import { resolveSubjectMembership } from './project-membership'
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
