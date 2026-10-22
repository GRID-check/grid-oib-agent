/**
 * @vitest-environment node
 */
/**
 * The upload trigger (ADR-0111): a completed batch on a project whose intake
 * is open queues one `project_intake_read` job per project, as the uploader,
 * at bulk priority, and only for an uploader who may write the profile. A
 * Büroablage or chat upload, a project without an open intake, and an
 * uploader who left queue nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({ userHoldsProjectPermission: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn(async () => ({ jobId: 'job-1' })) }))
vi.mock('@/lib/db/tenant-context', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn((_scope: unknown, run: () => unknown) => run()),
}))
vi.mock('./repository', () => ({ listOpenIntakeProjectIds: vi.fn() }))

import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { withTenant } from '@/lib/db/tenant-context'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY, projectIntakeReadPayloadSchema } from '@/lib/jobs-queue/types'
import { listOpenIntakeProjectIds } from './repository'
import { queueIntakeReadsAfterUpload } from './trigger'

const P1 = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const P2 = '7f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'

const session = (userId: string) =>
  ({
    userId,
    email: '',
    name: null,
    accessToken: '',
    organizationId: 'org-1',
    organizationMembershipId: `om-${userId}`,
    role: 'member',
    permissions: ['org:projects:view'],
    featureFlags: null,
  }) satisfies AuthorizedSession

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolvePinnedRequesterSession).mockImplementation(async ({ userId }) => session(userId))
  vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
  vi.mocked(listOpenIntakeProjectIds).mockImplementation(async (_org, ids) => [...ids])
})

describe('queueIntakeReadsAfterUpload', () => {
  it('queues one reading per project with an open intake, as the first batch’s uploader, at bulk priority', async () => {
    const queued = await queueIntakeReadsAfterUpload('org-1', [
      { scope: 'project', startsIntake: true, projectId: P1, createdBy: 'anna' },
      { scope: 'project', startsIntake: true, projectId: P1, createdBy: 'ben' },
      { scope: 'office_shelf', startsIntake: true, projectId: null, createdBy: 'anna' },
    ])

    expect(queued).toEqual([P1])
    expect(listOpenIntakeProjectIds).toHaveBeenCalledWith('org-1', [P1])
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    const job = vi.mocked(enqueueJob).mock.calls[0][0]
    expect(job).toMatchObject({ kind: 'project_intake_read', organizationId: 'org-1', priority: BFF_JOB_PRIORITY.bulk })
    expect(projectIntakeReadPayloadSchema.parse(job.payload)).toMatchObject({
      projectId: P1,
      requester: { userId: 'anna' },
    })
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org-1' }, expect.any(Function))
  })

  it('queues nothing for a project whose intake is finished or that has none', async () => {
    vi.mocked(listOpenIntakeProjectIds).mockResolvedValue([P2])
    const queued = await queueIntakeReadsAfterUpload('org-1', [
      { scope: 'project', startsIntake: true, projectId: P1, createdBy: 'anna' },
      { scope: 'project', startsIntake: true, projectId: P2, createdBy: 'ben' },
    ])
    expect(queued).toEqual([P2])
    expect(enqueueJob).toHaveBeenCalledTimes(1)
  })

  it('queues nothing for an uploader who may not write the profile, or who left', async () => {
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(false)
    expect(await queueIntakeReadsAfterUpload('org-1', [{ scope: 'project', startsIntake: true, projectId: P1, createdBy: 'anna' }])).toEqual([])
    expect(userHoldsProjectPermission).toHaveBeenCalledWith({ organizationId: 'org-1' }, P1, 'anna', 'project:memory:write')
    expect(userHoldsProjectPermission).toHaveBeenCalledWith({ organizationId: 'org-1' }, P1, 'anna', 'project:edit')

    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    expect(await queueIntakeReadsAfterUpload('org-1', [{ scope: 'project', startsIntake: true, projectId: P1, createdBy: 'anna' }])).toEqual([])
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  // Migration 0185: a batch opened with `startsIntake` off starts no reading,
  // and does not take the project's reading from another batch that does.
  it('starts no reading for a batch opened without one, and lets a later batch of the project start it', async () => {
    expect(
      await queueIntakeReadsAfterUpload('org-1', [{ scope: 'project', startsIntake: false, projectId: P1, createdBy: 'anna' }])
    ).toEqual([])
    expect(listOpenIntakeProjectIds).not.toHaveBeenCalled()

    const queued = await queueIntakeReadsAfterUpload('org-1', [
      { scope: 'project', startsIntake: false, projectId: P1, createdBy: 'anna' },
      { scope: 'project', startsIntake: true, projectId: P1, createdBy: 'ben' },
    ])
    expect(queued).toEqual([P1])
    expect(projectIntakeReadPayloadSchema.parse(vi.mocked(enqueueJob).mock.calls[0][0].payload)).toMatchObject({
      requester: { userId: 'ben' },
    })
  })

  it('asks no database when no project batch completed', async () => {
    expect(await queueIntakeReadsAfterUpload('org-1', [{ scope: 'session', startsIntake: true, projectId: null, createdBy: 'anna' }])).toEqual([])
    expect(listOpenIntakeProjectIds).not.toHaveBeenCalled()
  })
})
