/**
 * @vitest-environment node
 */
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
  featureFlags: null,
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

/** WorkOS list calls resolve to an AutoPaginatable; the route drains it via autoPagination(). */
function paginated<T>(data: T[]): { autoPagination: () => Promise<T[]> } {
  return { autoPagination: () => Promise.resolve(data) }
}

describe('/api/projects/[id]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuthorizedSession.mockResolvedValue(session)
    mockRequireProjectAccess.mockResolvedValue({ role: 'project-admin' })
  })

  it('lists project-resource memberships by effective project permissions and merges user details', async () => {
    const listUsers = vi.fn().mockResolvedValue(
      paginated([
        {
          id: 'user_viewer',
          email: 'viewer@example.com',
          firstName: 'View',
          lastName: 'Only',
          name: null,
          profilePictureUrl: 'https://cdn.example.com/viewer.png',
        },
        {
          id: 'user_editor',
          email: 'editor@example.com',
          firstName: null,
          lastName: null,
          name: 'Editor Person',
          profilePictureUrl: null,
        },
        {
          id: 'user_admin',
          email: 'admin@example.com',
          firstName: 'Admin',
          lastName: 'Person',
          name: null,
          profilePictureUrl: 'https://cdn.example.com/admin.png',
        },
        {
          id: 'user_contributor',
          email: 'contributor@example.com',
          firstName: 'Con',
          lastName: 'Tributor',
          name: null,
          profilePictureUrl: null,
        },
        {
          id: 'user_narrow',
          email: 'narrow@example.com',
          firstName: null,
          lastName: null,
          name: 'Narrow Writer',
          profilePictureUrl: null,
        },
      ])
    )
    const listOrganizationMemberships = vi.fn().mockResolvedValue(
      paginated([
        { id: 'om_viewer', userId: 'user_viewer' },
        { id: 'om_editor', userId: 'user_editor' },
        { id: 'om_admin', userId: 'user_admin' },
        { id: 'om_contributor', userId: 'user_contributor' },
        { id: 'om_narrow', userId: 'user_narrow' },
      ])
    )
    // One list per rung of PROJECT_ROLE_BY_PERMISSION, in its order:
    // view, chat, edit, documents:write, memory:write, manage. A later rung
    // overwrites an earlier one, so each member reads as the strongest they hold.
    const everyone = [
      { id: 'om_viewer', userId: 'user_viewer' },
      { id: 'om_editor', userId: 'user_editor' },
      { id: 'om_admin', userId: 'user_admin' },
      { id: 'om_contributor', userId: 'user_contributor' },
      { id: 'om_narrow', userId: 'user_narrow' },
    ]
    const listMembershipsForResourceByExternalId = vi
      .fn()
      // project:view — everybody with any access at all
      .mockResolvedValueOnce(paginated(everyone))
      // project:chat — contributor, editor, admin
      .mockResolvedValueOnce(
        paginated([
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
          { id: 'om_contributor', userId: 'user_contributor' },
        ])
      )
      // project:edit (the pre-split umbrella) — editor, admin
      .mockResolvedValueOnce(
        paginated([
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
        ])
      )
      // project:documents:write — plus the custom narrow-write role, which the
      // old three-rung ladder reported as a plain Viewer
      .mockResolvedValueOnce(
        paginated([
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
          { id: 'om_narrow', userId: 'user_narrow' },
        ])
      )
      // project:memory:write
      .mockResolvedValueOnce(
        paginated([
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
        ])
      )
      // project:manage
      .mockResolvedValueOnce(paginated([{ id: 'om_admin', userId: 'user_admin' }]))

    mockGetWorkOS.mockReturnValue({
      userManagement: { listUsers, listOrganizationMemberships },
      authorization: { listMembershipsForResourceByExternalId },
    } as never)

    const res = await GET(
      new Request('http://localhost/api/projects/proj_1/members'),
      makeParams('proj_1')
    )

    expect(res.status).toBe(200)
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(session, 'proj_1', [
      'project:members:manage',
      'project:manage',
    ])
    expect(listUsers).toHaveBeenCalledWith({ organizationId: 'org_1' })
    expect(listOrganizationMemberships).toHaveBeenCalledWith({ organizationId: 'org_1' })
    expect(listMembershipsForResourceByExternalId).toHaveBeenNthCalledWith(1, {
      organizationId: 'org_1',
      resourceTypeSlug: 'project',
      externalId: 'proj_1',
      permissionSlug: 'project:view',
      assignment: 'indirect',
    })
    const probed = listMembershipsForResourceByExternalId.mock.calls.map(
      (call) => (call[0] as { permissionSlug: string }).permissionSlug
    )
    // Every rung the catalog defines is probed. It used to be three, so a
    // Contributor read as "Viewer" and so did a role holding only the narrow
    // writes — on the one screen whose job is to report access accurately.
    expect(probed).toEqual([
      'project:view',
      'project:chat',
      'project:edit',
      'project:documents:write',
      'project:memory:write',
      'project:manage',
    ])

    await expect(res.json()).resolves.toEqual({
      members: [
        {
          organizationMembershipId: 'om_viewer',
          userId: 'user_viewer',
          email: 'viewer@example.com',
          name: 'View Only',
          profilePictureUrl: 'https://cdn.example.com/viewer.png',
          role: 'project-viewer',
        },
        {
          organizationMembershipId: 'om_editor',
          userId: 'user_editor',
          email: 'editor@example.com',
          name: 'Editor Person',
          profilePictureUrl: null,
          role: 'project-editor',
        },
        {
          organizationMembershipId: 'om_admin',
          userId: 'user_admin',
          email: 'admin@example.com',
          name: 'Admin Person',
          profilePictureUrl: 'https://cdn.example.com/admin.png',
          role: 'project-admin',
        },
        {
          organizationMembershipId: 'om_contributor',
          userId: 'user_contributor',
          email: 'contributor@example.com',
          name: 'Con Tributor',
          profilePictureUrl: null,
          role: 'project-contributor',
        },
        {
          organizationMembershipId: 'om_narrow',
          userId: 'user_narrow',
          email: 'narrow@example.com',
          name: 'Narrow Writer',
          profilePictureUrl: null,
          role: 'project-editor',
        },
      ],
    })
  })
})
