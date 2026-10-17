/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listUsers = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ userManagement: { listUsers } }),
}))

import { findOrganizationMemberByEmail, loadOrganizationDirectory } from './directory'
import { setCacheStore } from '@/lib/cache'
import { MapCacheStore } from '@/test-utils/cache-store'

const ANNA = { id: 'u-anna', email: 'anna@example.com', firstName: 'Anna', lastName: 'Weber' }

function page(users: unknown[]) {
  return Promise.resolve({ autoPagination: () => Promise.resolve(users) })
}

describe('loadOrganizationDirectory', () => {
  let store: MapCacheStore

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store = new MapCacheStore()
    setCacheStore(store)
  })

  it('does not cache a failed load: the next call reads WorkOS again', async () => {
    // A failed listUsers was stored as the roster, so for the whole TTL every
    // `@` picker in the organization listed nobody.
    listUsers.mockReturnValueOnce(Promise.reject(new Error('workos 429')))
    listUsers.mockReturnValueOnce(page([ANNA]))

    expect((await loadOrganizationDirectory('org_1')).size).toBe(0)
    expect(store.map.size).toBe(0)

    const directory = await loadOrganizationDirectory('org_1')
    expect(directory.get('u-anna')?.name).toBe('Anna Weber')
    expect(listUsers).toHaveBeenCalledTimes(2)
  })

  it('caches a completed load', async () => {
    listUsers.mockReturnValue(page([ANNA]))

    await loadOrganizationDirectory('org_1')
    await loadOrganizationDirectory('org_1')

    expect(listUsers).toHaveBeenCalledTimes(1)
  })
})

describe('findOrganizationMemberByEmail: one address, asked of WorkOS now', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCacheStore(new MapCacheStore())
  })

  it('finds the member by the address, lowercased, and maps them like the roster does', async () => {
    listUsers.mockResolvedValueOnce({ data: [ANNA] })

    await expect(findOrganizationMemberByEmail('org_1', 'Anna@Example.com')).resolves.toEqual({
      userId: 'u-anna',
      email: 'anna@example.com',
      name: 'Anna Weber',
      profilePictureUrl: null,
    })
    expect(listUsers).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1', email: 'anna@example.com' }))
  })

  it('answers null when WorkOS knows nobody by that address in the organization', async () => {
    listUsers.mockResolvedValueOnce({ data: [] })
    await expect(findOrganizationMemberByEmail('org_1', 'nobody@example.com')).resolves.toBeNull()
  })

  it('does not take a user whose address only matches under a Unicode case fold', async () => {
    // U+212A KELVIN SIGN lowercases to `k` under Unicode rules, not ASCII ones.
    listUsers.mockResolvedValueOnce({ data: [{ ...ANNA, email: 'anna@\u212Axample.com' }] })
    await expect(findOrganizationMemberByEmail('org_1', 'anna@kxample.com')).resolves.toBeNull()
  })

  it('throws when WorkOS cannot be asked, and caches nothing', async () => {
    listUsers.mockRejectedValueOnce(new Error('workos 503'))
    await expect(findOrganizationMemberByEmail('org_1', 'anna@example.com')).rejects.toThrow('workos 503')
  })
})
