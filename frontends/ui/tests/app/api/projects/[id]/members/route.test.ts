import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: vi.fn(),
}))

import { GET } from '@/app/api/projects/[id]/members/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getWorkOS } from '@/lib/workos/client'

const mockRequireAuthorizedSession = vi.mocked(requireAuthorizedSession)
const mockRequireProjectAccess = vi.mocked(requireProjectAccess)
const mockGetWorkOS = vi.mocked(getWorkOS)

const session = {
  userId: 'user_1',
  email: 'admin@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_admin',
  role: 'member',
  permissions: [] as string[],
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

describe('/api/projects/[id]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuthorizedSession.mockResolvedValue(session)
    mockRequireProjectAccess.mockResolvedValue({ role: 'project-admin' })
  })

  it('lists project-resource memberships by effective project permissions and merges user details', async () => {
    const listUsers = vi.fn().mockResolvedValue({
      data: [
        { id: 'user_viewer', email: 'viewer@example.com', firstName: 'View', lastName: 'Only', name: null },
        { id: 'user_editor', email: 'editor@example.com', firstName: null, lastName: null, name: 'Editor Person' },
        { id: 'user_admin', email: 'admin@example.com', firstName: 'Admin', lastName: 'Person', name: null },
      ],
    })
    const listOrganizationMemberships = vi.fn().mockResolvedValue({
      data: [
        { id: 'om_viewer', userId: 'user_viewer' },
        { id: 'om_editor', userId: 'user_editor' },
        { id: 'om_admin', userId: 'user_admin' },
      ],
    })
    const listMembershipsForResourceByExternalId = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { id: 'om_viewer', userId: 'user_viewer' },
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
        ],
      })
      .mockResolvedValueOnce({
        data: [{ id: 'om_admin', userId: 'user_admin' }],
      })

    mockGetWorkOS.mockReturnValue({
      userManagement: { listUsers, listOrganizationMemberships },
      authorization: { listMembershipsForResourceByExternalId },
    } as never)

    const res = await GET(new Request('http://localhost/api/projects/proj_1/members'), makeParams('proj_1'))

    expect(res.status).toBe(200)
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(session, 'proj_1', 'project:manage')
    expect(listUsers).toHaveBeenCalledWith({ organizationId: 'org_1' })
    expect(listOrganizationMemberships).toHaveBeenCalledWith({ organizationId: 'org_1' })
    expect(listMembershipsForResourceByExternalId).toHaveBeenNthCalledWith(1, {
      organizationId: 'org_1',
      resourceTypeSlug: 'project',
      externalId: 'proj_1',
      permissionSlug: 'project:view',
      assignment: 'indirect',
    })
    expect(listMembershipsForResourceByExternalId).toHaveBeenNthCalledWith(2, {
      organizationId: 'org_1',
      resourceTypeSlug: 'project',
      externalId: 'proj_1',
      permissionSlug: 'project:edit',
      assignment: 'indirect',
    })
    expect(listMembershipsForResourceByExternalId).toHaveBeenNthCalledWith(3, {
      organizationId: 'org_1',
      resourceTypeSlug: 'project',
      externalId: 'proj_1',
      permissionSlug: 'project:manage',
      assignment: 'indirect',
    })

    await expect(res.json()).resolves.toEqual({
      members: [
        {
          organizationMembershipId: 'om_viewer',
          userId: 'user_viewer',
          email: 'viewer@example.com',
          name: 'View Only',
          role: 'project-viewer',
        },
        {
          organizationMembershipId: 'om_editor',
          userId: 'user_editor',
          email: 'editor@example.com',
          name: 'Editor Person',
          role: 'project-editor',
        },
        {
          organizationMembershipId: 'om_admin',
          userId: 'user_admin',
          email: 'admin@example.com',
          name: 'Admin Person',
          role: 'project-admin',
        },
      ],
    })
  })
})
