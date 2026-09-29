/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listUsers = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ userManagement: { listUsers } }),
}))

import { loadOrganizationDirectory } from './directory'
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
