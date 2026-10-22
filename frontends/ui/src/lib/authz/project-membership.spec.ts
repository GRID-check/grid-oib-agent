/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationMemberships = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ userManagement: { listOrganizationMemberships } }),
}))

import { lookupSubjectMembership, resolveSubjectMembership } from './project-membership'
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
      roles: ['member'],
    })
  })

  it('caches an answered "not a member"', async () => {
    listOrganizationMemberships.mockResolvedValue({ data: [] })

    await resolveSubjectMembership('org_1', 'u-stranger')
    await resolveSubjectMembership('org_1', 'u-stranger')

    expect(listOrganizationMemberships).toHaveBeenCalledTimes(1)
  })

  // The push job removes every device of a person who left; "could not ask"
  // must reach it as a failure, not as "not a member".
  it('lets a caller that cannot undo "not a member" tell a failed lookup from an answered one', async () => {
    listOrganizationMemberships.mockRejectedValueOnce(new Error('workos 503'))
    await expect(lookupSubjectMembership('org_1', 'u-anna')).rejects.toThrow('workos 503')
    expect(store.map.size).toBe(0)

    listOrganizationMemberships.mockResolvedValueOnce({ data: [] })
    await expect(lookupSubjectMembership('org_1', 'u-gone')).resolves.toBeNull()
  })
})

describe('lookupSubjectMembership', () => {
  let store: MapCacheStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new MapCacheStore()
    setCacheStore(store)
  })

  it('reads every role of the membership, so a pinned session can carry them all', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({
      data: [{ id: 'om_anna', role: { slug: 'member' }, roles: [{ slug: 'member' }, { slug: 'org-site-lead' }] }],
    })
    await expect(lookupSubjectMembership('org_1', 'u-anna')).resolves.toEqual({
      organizationMembershipId: 'om_anna',
      role: 'member',
      roles: ['member', 'org-site-lead'],
    })
  })

  it('asks for an active membership only, not on the strength of a WorkOS default', async () => {
    listOrganizationMemberships.mockResolvedValueOnce({ data: [MEMBERSHIP] })
    await lookupSubjectMembership('org_1', 'u-anna')
    expect(listOrganizationMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-anna', organizationId: 'org_1', statuses: ['active'] })
    )
  })

  it('caches under a key the shape without roles was never stored under', async () => {
    // An entry `membership-role:` cached before `roles` existed would read as
    // a member with no roles; the new key leaves it unread until it expires.
    await store.set('membership-role:org_1:u-anna', JSON.stringify({ organizationMembershipId: 'om_old', role: 'member' }))
    listOrganizationMemberships.mockResolvedValueOnce({ data: [MEMBERSHIP] })

    await expect(lookupSubjectMembership('org_1', 'u-anna')).resolves.toMatchObject({ roles: ['member'] })
    expect([...store.map.keys()]).toContain('subject-membership:org_1:u-anna')
  })

  it('keeps a fresher membership age under its own key (the agent door)', async () => {
    listOrganizationMemberships.mockResolvedValue({ data: [MEMBERSHIP] })
    await lookupSubjectMembership('org_1', 'u-anna')
    await lookupSubjectMembership('org_1', 'u-anna', 60_000)
    expect(listOrganizationMemberships).toHaveBeenCalledTimes(2)
    expect([...store.map.keys()].sort()).toEqual([
      'subject-membership-60000:org_1:u-anna',
      'subject-membership:org_1:u-anna',
    ])
  })
})
