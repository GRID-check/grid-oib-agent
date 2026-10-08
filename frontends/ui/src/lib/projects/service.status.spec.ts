/**
 * @vitest-environment node
 *
 * Closing and reopening a project (ADR-0088): who may, that it is audited both
 * ways, and that a second click writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const requireProjectAccess = vi.fn()
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccess(...args),
}))

const setProjectStatusInOrg = vi.fn()
vi.mock('./repository', () => ({
  setProjectStatusInOrg: (...args: unknown[]) => setProjectStatusInOrg(...args),
}))

const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args) }))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/collaboration/cleanup', () => ({ neutralizeCollaborationForProject: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({
  lastProjectActivityByUser: vi.fn(),
  listConversationIdsForProject: vi.fn(),
}))
vi.mock('@/lib/documents/repository', () => ({ countDocumentsByProject: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({}))
vi.mock('./overview-query', () => ({ getProjectOverviewData: vi.fn() }))
vi.mock('./memory-service', () => ({}))

import { NotFoundError } from '@/lib/api/errors'
import { makeProject } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'
import { setProjectStatus } from './service'

const session: AuthorizedSession = {
  userId: 'user_pl',
  email: 'pl@buero.at',
  name: 'PL',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

describe('setProjectStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireProjectAccess.mockResolvedValue({ role: 'project-admin', closed: false, readsBecauseClosed: false })
  })

  it('closes: project:manage asked even though closing makes it read-only, stamped with who and when, audited', async () => {
    const closedAt = new Date('2026-10-06T18:00:00Z')
    setProjectStatusInOrg.mockResolvedValue(
      makeProject({ id: 'p1', name: 'Seestadt D12', status: 'closed', closedAt, closedBy: 'user_pl' })
    )

    const project = await setProjectStatus(session, 'p1', 'closed')

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'p1', 'project:manage', { evenWhenClosed: true })
    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', {
      status: 'closed',
      closedBy: 'user_pl',
      at: expect.any(Date),
    })
    expect(project.status).toBe('closed')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.closed', targetId: 'p1', metadata: { name: 'Seestadt D12' } })
    )
  })

  it('reopens, audited as such', async () => {
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', name: 'Seestadt D12' }))

    await setProjectStatus(session, 'p1', 'active')

    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', { status: 'active' })
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.reopened' }))
  })

  it('a project already in that state is a conflict, and writes no audit event', async () => {
    setProjectStatusInOrg.mockResolvedValue(null)

    await expect(setProjectStatus(session, 'p1', 'closed')).rejects.toMatchObject({
      status: 409,
      details: { reason: 'already-closed' },
    })
    await expect(setProjectStatus(session, 'p1', 'active')).rejects.toMatchObject({
      details: { reason: 'not-closed' },
    })
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('someone without project:manage changes nothing', async () => {
    requireProjectAccess.mockRejectedValue(new NotFoundError())

    await expect(setProjectStatus(session, 'p1', 'closed')).rejects.toBeInstanceOf(NotFoundError)
    expect(setProjectStatusInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})
