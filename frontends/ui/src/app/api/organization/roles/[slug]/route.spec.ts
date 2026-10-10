/**
 * @vitest-environment node
 */
/**
 * Deleting a custom role: the route hands the slug to the service and answers
 * its refusal as it is. The rule itself is `custom-roles.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireAuthorizedSession = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: () => requireAuthorizedSession(),
}))
vi.mock('server-only', () => ({}))

const roles = vi.hoisted(() => ({
  deleteCustomRole: vi.fn(),
  updateCustomRole: vi.fn(),
}))
vi.mock('@/lib/authz/custom-roles', () => roles)

import { ConflictError } from '@/lib/api/errors'
import { DELETE } from './route'

const context = { params: Promise.resolve({ slug: 'org-geschaeftsfuehrung' }) }
const url = 'https://grid.test/api/organization/roles/org-geschaeftsfuehrung'

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthorizedSession.mockResolvedValue({
    userId: 'user_ua',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'org-user-admin',
    permissions: ['org:members:manage'],
  })
  roles.deleteCustomRole.mockResolvedValue(undefined)
})

describe('DELETE /api/organization/roles/[slug]', () => {
  it('deletes the role named in the path, with nothing to confirm', async () => {
    const response = await DELETE(new Request(url, { method: 'DELETE' }), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ slug: 'org-geschaeftsfuehrung' })
    expect(roles.deleteCustomRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_ua' }),
      'org-geschaeftsfuehrung',
      expect.any(Request)
    )
  })

  it('answers a role somebody still holds with 409 and its reason', async () => {
    roles.deleteCustomRole.mockRejectedValue(
      new ConflictError('This role is still assigned.', { slug: 'org-geschaeftsfuehrung', reason: 'role-assigned' })
    )

    const response = await DELETE(new Request(url, { method: 'DELETE' }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ details: { reason: 'role-assigned' } })
  })
})
