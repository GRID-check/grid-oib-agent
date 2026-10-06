/**
 * @vitest-environment node
 */
/**
 * Deleting a custom role that folders name (ADR-0079): the route passes the
 * caller's confirmation on to the service and nothing else, and the usage route
 * is the service's answer verbatim. The rule itself is `custom-roles.spec.ts`.
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
  getCustomRoleUsage: vi.fn(),
}))
vi.mock('@/lib/authz/custom-roles', () => roles)

import { ConflictError } from '@/lib/api/errors'
import { DELETE } from './route'
import { GET as getUsage } from './usage/route'

const context = { params: Promise.resolve({ slug: 'org-geschaeftsfuehrung' }) }
const url = (query = ''): string => `https://grid.test/api/organization/roles/org-geschaeftsfuehrung${query}`

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
  it('does not confirm by default: a role folders name is refused until the caller says it saw them', async () => {
    await DELETE(new Request(url(), { method: 'DELETE' }), context)

    expect(roles.deleteCustomRole).toHaveBeenCalledWith(expect.anything(), 'org-geschaeftsfuehrung', expect.any(Request), {
      confirmFolders: false,
    })
  })

  it('passes the confirmation on with ?confirmFolders=1', async () => {
    const response = await DELETE(new Request(url('?confirmFolders=1'), { method: 'DELETE' }), context)

    expect(response.status).toBe(200)
    expect(roles.deleteCustomRole).toHaveBeenCalledWith(expect.anything(), 'org-geschaeftsfuehrung', expect.any(Request), {
      confirmFolders: true,
    })
  })

  it('refuses any other value for it: a typo is not a confirmation', async () => {
    const response = await DELETE(new Request(url('?confirmFolders=yes'), { method: 'DELETE' }), context)

    expect(response.status).toBe(400)
    expect(roles.deleteCustomRole).not.toHaveBeenCalled()
  })

  it('answers the 409 with its reason and the count', async () => {
    roles.deleteCustomRole.mockRejectedValue(
      new ConflictError('Folders still name this role.', { slug: 'org-geschaeftsfuehrung', reason: 'role-used-by-folders', total: 3 })
    )

    const response = await DELETE(new Request(url(), { method: 'DELETE' }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ details: { reason: 'role-used-by-folders', total: 3 } })
  })
})

describe('GET /api/organization/roles/[slug]/usage', () => {
  it('returns the folders that name the role, as the service says', async () => {
    roles.getCustomRoleUsage.mockResolvedValue({ total: 1, folders: [{ folderId: 'f1', folderName: 'Honorare', projectId: 'p1', projectName: 'Schule Süd' }] })

    const response = await getUsage(new Request(`${url()}/usage`), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      total: 1,
      folders: [{ folderId: 'f1', folderName: 'Honorare', projectId: 'p1', projectName: 'Schule Süd' }],
    })
    expect(roles.getCustomRoleUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_ua' }), 'org-geschaeftsfuehrung')
  })
})
