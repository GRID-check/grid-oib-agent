import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError } from '@/lib/api/errors'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./repository', () => ({
  findProjectWorkosResourceId: vi.fn().mockResolvedValue('res_project_1'),
}))

const listRoleAssignmentsForResource = vi.fn()
const removeRoleAssignment = vi.fn().mockResolvedValue(undefined)
const assignRole = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    authorization: {
      listRoleAssignmentsForResource,
      removeRoleAssignment,
      assignRole,
    },
  }),
}))

import { setProjectMemberRole, removeProjectRoleAssignment } from './members-service'

type Assignment = { id: string; organizationMembershipId: string; role: { slug: string } }

const session = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'admin@grid.com',
} as never

const request = new Request('https://grid.test/api/projects/p1/members', { method: 'POST' })

/** Stub the FGA assignment list the service reads to count admins. */
function stubAssignments(assignments: Assignment[]): void {
  listRoleAssignmentsForResource.mockResolvedValue({
    autoPagination: () => Promise.resolve(assignments),
  })
}

const admin = (id: string, membershipId: string): Assignment => ({
  id,
  organizationMembershipId: membershipId,
  role: { slug: 'project-admin' },
})
const editor = (id: string, membershipId: string): Assignment => ({
  id,
  organizationMembershipId: membershipId,
  role: { slug: 'project-editor' },
})

beforeEach(() => {
  listRoleAssignmentsForResource.mockReset()
  removeRoleAssignment.mockClear()
  assignRole.mockClear()
})

describe('setProjectMemberRole — last-admin guard', () => {
  it('rejects demoting the only admin (self-demotion)', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), editor('ra_2', 'om_editor')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_admin', roleSlug: 'project-editor' },
        request,
      ),
    ).rejects.toBeInstanceOf(ConflictError)

    // The guard runs before any mutation.
    expect(removeRoleAssignment).not.toHaveBeenCalled()
    expect(assignRole).not.toHaveBeenCalled()
  })

  it('rejects removing (no access) the only admin', async () => {
    stubAssignments([admin('ra_1', 'om_admin')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_admin', roleSlug: '' },
        request,
      ),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(removeRoleAssignment).not.toHaveBeenCalled()
  })

  it('carries the last-admin marker so the client can localize it', async () => {
    stubAssignments([admin('ra_1', 'om_admin')])

    await setProjectMemberRole(
      session,
      'p1',
      { organizationMembershipId: 'om_admin', roleSlug: '' },
      request,
    ).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).details).toEqual({ reason: 'last-admin' })
    })
    expect.assertions(2)
  })

  it('allows demoting an admin when another admin remains', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), admin('ra_2', 'om_admin2')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_admin', roleSlug: 'project-editor' },
        request,
      ),
    ).resolves.toBeUndefined()

    expect(removeRoleAssignment).toHaveBeenCalledTimes(1)
    expect(assignRole).toHaveBeenCalledTimes(1)
  })

  it('allows re-granting admin to the same sole admin', async () => {
    stubAssignments([admin('ra_1', 'om_admin')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_admin', roleSlug: 'project-admin' },
        request,
      ),
    ).resolves.toBeUndefined()
    expect(assignRole).toHaveBeenCalledTimes(1)
  })

  it('does not block changing a non-admin member', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), editor('ra_2', 'om_editor')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_editor', roleSlug: 'project-viewer' },
        request,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('removeProjectRoleAssignment — last-admin guard', () => {
  it('rejects removing the only admin assignment', async () => {
    stubAssignments([admin('ra_1', 'om_admin')])

    await expect(
      removeProjectRoleAssignment(session, 'p1', 'ra_1', request),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(removeRoleAssignment).not.toHaveBeenCalled()
  })

  it('allows removing an admin assignment when another admin remains', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), admin('ra_2', 'om_admin2')])

    await expect(
      removeProjectRoleAssignment(session, 'p1', 'ra_1', request),
    ).resolves.toBeUndefined()
    expect(removeRoleAssignment).toHaveBeenCalledTimes(1)
  })
})
