/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'admin@grid.com',
  role: 'admin',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/organizations/service', () => ({
  listOrganizationMembers: vi.fn().mockResolvedValue([
    { id: 'user_abc', email: 'a@grid.com', name: 'Anna Architekt' },
    { id: 'user_def', email: 'b@grid.com', name: null },
  ]),
}))

import { GET } from './route'
import { listOrganizationMembers } from '@/lib/organizations/service'

const request = (): Request => new Request('http://localhost/api/organization/members')

describe('GET /api/organization/members', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.role = 'admin'
  })

  it('rejects non-admins', async () => {
    session.role = 'member'
    expect((await GET(request())).status).toBe(403)
    expect(listOrganizationMembers).not.toHaveBeenCalled()
  })

  it('returns the member directory for admins', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.members).toHaveLength(2)
    expect(body.members[0]).toEqual({ id: 'user_abc', email: 'a@grid.com', name: 'Anna Architekt' })
    expect(listOrganizationMembers).toHaveBeenCalledWith('org-1')
  })
})
