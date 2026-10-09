/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/session', () => ({ getGridSession: vi.fn().mockResolvedValue({ userId: 'u_1' }) }))
vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error {}
  return {
    PlatformAccessDeniedError,
    requirePlatformPermission: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
  }
})
vi.mock('@/lib/quality/scope-options', () => ({
  getQualityScopeOptions: vi.fn(async () => ({
    organizations: [{ id: 'org_2', name: 'Ziviltechniker Gruber' }],
    organizationsTruncated: false,
    projects: [],
    projectsTruncated: false,
  })),
}))

import { GET } from './route'
import { requirePlatformPermission } from '@/lib/authz/platform'
import { getQualityScopeOptions } from '@/lib/quality/scope-options'

const request = (query = ''): Request => new Request(`http://localhost/api/platform/quality/scope-options${query}`)

describe('GET /api/platform/quality/scope-options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('is gated on the platform view permission, like every quality read', async () => {
    expect((await GET(request())).status).toBe(403)
    expect(requirePlatformPermission).toHaveBeenCalledWith(expect.anything(), 'platform:organizations:view')
    expect(getQualityScopeOptions).not.toHaveBeenCalled()
  })

  it('answers the options for the scope it is given', async () => {
    isOwner.value = true
    const res = await GET(request('?from=2026-10-01&to=2026-10-07&org=org_2&org=org_3'))

    expect(res.status).toBe(200)
    expect(getQualityScopeOptions).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-07',
      organizationIds: ['org_2', 'org_3'],
      projectIds: [],
    })
  })

  it.each(['?from=2026-10-09&to=2026-10-01', '?from=2020-01-01&to=2026-01-01', '?project=not-a-uuid'])(
    'refuses %s with 400',
    async (query) => {
      isOwner.value = true
      expect((await GET(request(query))).status).toBe(400)
      expect(getQualityScopeOptions).not.toHaveBeenCalled()
    }
  )
})
