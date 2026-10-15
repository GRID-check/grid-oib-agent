/**
 * @vitest-environment node
 *
 * The project lifecycle (ADR-0098, ADR-0090): which moves exist, who may make
 * them, that each is audited under its own name, that closing names its outcome
 * and an Abschluss that is neither in the future nor before the Beginn, and
 * that a second click writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const requireProjectAccess = vi.fn()
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccess(...args),
}))

const setProjectStatusInOrg = vi.fn()
const findProjectInOrg = vi.fn()
vi.mock('./repository', () => ({
  setProjectStatusInOrg: (...args: unknown[]) => setProjectStatusInOrg(...args),
  findProjectInOrg: (...args: unknown[]) => findProjectInOrg(...args),
}))

const rearmOneShotsSkippedWhileParked = vi.fn(async () => 0)
vi.mock('@/lib/tasks/repository', () => ({
  rearmOneShotsSkippedWhileParked: (...args: unknown[]) => rearmOneShotsSkippedWhileParked(...(args as [])),
}))

const syncProjectFacts = vi.fn(async () => 'pushed')
vi.mock('@/lib/cross-project/project-facts-mirror', () => ({
  syncProjectFacts: (...args: unknown[]) => syncProjectFacts(...(args as [])),
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

const NOW = new Date('2026-10-06T18:00:00Z')

describe('setProjectStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireProjectAccess.mockResolvedValue({ role: 'project-admin', closed: false, readsBecauseClosed: false })
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', name: 'Seestadt D12', startedOn: '2023-04-01' }))
  })

  it('closes: project:manage asked even though closing makes it read-only, with who, when, how and the Abschluss, audited', async () => {
    setProjectStatusInOrg.mockResolvedValue(
      makeProject({ id: 'p1', name: 'Seestadt D12', status: 'closed', closedAt: NOW, closedBy: 'user_pl', closedOutcome: 'completed' })
    )

    const project = await setProjectStatus(session, 'p1', { status: 'closed', outcome: 'completed', endedOn: '2026-09' }, undefined, NOW)

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'p1', 'project:manage', { evenWhenClosed: true })
    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', 'active', {
      status: 'closed',
      at: NOW,
      closedBy: 'user_pl',
      outcome: 'completed',
      endedOn: '2026-09-01',
    })
    expect(project.status).toBe('closed')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.closed',
        targetId: 'p1',
        metadata: { name: 'Seestadt D12', from: 'active', outcome: 'completed', endedOn: '2026-09' },
      })
    )
  })

  it('closes a paused project too, and a project that was not realized says so', async () => {
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'paused', pausedAt: NOW }))
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'closed' }))

    await setProjectStatus(session, 'p1', { status: 'closed', outcome: 'cancelled', endedOn: '2026-10' }, undefined, NOW)

    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', 'paused', expect.objectContaining({ outcome: 'cancelled' }))
  })

  it.each([
    ['in the future', '2026-11', 'abschluss-in-future'],
    ['before the Beginn', '2023-03', 'abschluss-before-beginn'],
  ])('refuses an Abschluss %s, and writes nothing', async (_, endedOn, reason) => {
    await expect(
      setProjectStatus(session, 'p1', { status: 'closed', outcome: 'completed', endedOn: endedOn as '2026-11' }, undefined, NOW)
    ).rejects.toMatchObject({ status: 400, details: { reason } })
    expect(setProjectStatusInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('closes a project whose Beginn lies ahead in the Beginn\'s month: nothing earlier fits', async () => {
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', startedOn: '2027-03-01' }))
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'closed' }))

    await setProjectStatus(session, 'p1', { status: 'closed', outcome: 'cancelled', endedOn: '2027-03' }, undefined, NOW)
    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', 'active', expect.objectContaining({ endedOn: '2027-03-01' }))

    await expect(
      setProjectStatus(session, 'p1', { status: 'closed', outcome: 'cancelled', endedOn: '2027-04' }, undefined, NOW)
    ).rejects.toMatchObject({ status: 400, details: { reason: 'abschluss-in-future' } })
  })

  it('pauses with the moment, and resumes; each under its own name', async () => {
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', name: 'Seestadt D12', status: 'paused', pausedAt: NOW }))
    await setProjectStatus(session, 'p1', { status: 'paused' }, undefined, NOW)
    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', 'active', { status: 'paused', at: NOW })
    expect(recordAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'project.paused', metadata: { name: 'Seestadt D12', from: 'active' } })
    )

    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'paused', pausedAt: NOW }))
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1' }))
    await setProjectStatus(session, 'p1', { status: 'active' })
    expect(setProjectStatusInOrg).toHaveBeenLastCalledWith('p1', 'org_1', 'paused', { status: 'active' })
    expect(recordAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'project.resumed' }))
    // Pausing re-armed nothing; resuming brings back the one-shots the pause retired.
    expect(rearmOneShotsSkippedWhileParked).toHaveBeenCalledTimes(1)
    expect(rearmOneShotsSkippedWhileParked).toHaveBeenCalledWith('p1', 'org_1')
  })

  it('reopens a closed project, audited as such', async () => {
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'closed', closedOutcome: 'completed' }))
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', name: 'Seestadt D12' }))

    await setProjectStatus(session, 'p1', { status: 'active' })

    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', 'closed', { status: 'active' })
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.reopened' }))
    expect(rearmOneShotsSkippedWhileParked).toHaveBeenCalledWith('p1', 'org_1')
  })

  it('a failure re-arming one-shots does not undo or fail a move that happened', async () => {
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'paused', pausedAt: NOW }))
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1' }))
    rearmOneShotsSkippedWhileParked.mockRejectedValueOnce(new Error('db down'))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(setProjectStatus(session, 'p1', { status: 'active' })).resolves.toMatchObject({ id: 'p1' })
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.resumed' }))
    quiet.mockRestore()
  })

  it.each([
    ['closed', { status: 'paused' as const }],
    ['closed', { status: 'closed' as const, outcome: 'completed' as const, endedOn: '2026-10' as const }],
    ['active', { status: 'active' as const }],
    ['paused', { status: 'paused' as const }],
  ])('a move the lifecycle does not have, from %s, is a conflict and writes nothing', async (from, change) => {
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', status: from as 'active' }))

    await expect(setProjectStatus(session, 'p1', change, undefined, NOW)).rejects.toMatchObject({
      status: 409,
      details: { reason: 'invalid-transition', from, to: change.status },
    })
    expect(setProjectStatusInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('a move that lost a race (the row moved meanwhile) is a conflict, and writes no audit event', async () => {
    setProjectStatusInOrg.mockResolvedValue(null)

    await expect(setProjectStatus(session, 'p1', { status: 'paused' }, undefined, NOW)).rejects.toMatchObject({
      status: 409,
      details: { reason: 'invalid-transition' },
    })
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('copies the new status onto the project’s chunks after the move, for the cross-project filters', async () => {
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'paused' }))

    await setProjectStatus(session, 'p1', { status: 'paused' }, undefined, NOW)

    expect(syncProjectFacts).toHaveBeenCalledWith('org_1', 'p1')
  })

  it('copies nothing when the move lost its race', async () => {
    setProjectStatusInOrg.mockResolvedValue(null)

    await expect(setProjectStatus(session, 'p1', { status: 'paused' }, undefined, NOW)).rejects.toMatchObject({ status: 409 })
    expect(syncProjectFacts).not.toHaveBeenCalled()
  })

  it('someone without project:manage changes nothing', async () => {
    requireProjectAccess.mockRejectedValue(new NotFoundError())

    await expect(setProjectStatus(session, 'p1', { status: 'paused' })).rejects.toBeInstanceOf(NotFoundError)
    expect(setProjectStatusInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })
})
