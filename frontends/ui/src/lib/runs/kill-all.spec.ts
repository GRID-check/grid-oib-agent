/**
 * @vitest-environment node
 */
/**
 * The platform kill switch: the job store first, then every run its reports did
 * not close, through the one recorder, and nothing at all when the job store
 * did not confirm the kill.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/tasks/repository', () => ({ claimRunsToReconcile: vi.fn() }))
vi.mock('@/lib/tasks/service', () => ({ recordRunOutcome: vi.fn() }))
vi.mock('@/lib/jobs/backend-client', () => ({ killActiveBackendJobs: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
  withPlatformAccess: vi.fn(async (_why: string, run: () => Promise<unknown>) => run()),
}))

import type { TaskRun } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { killActiveBackendJobs, type BackendKillResult } from '@/lib/jobs/backend-client'
import { claimRunsToReconcile } from '@/lib/tasks/repository'
import { recordRunOutcome } from '@/lib/tasks/service'
import { KILL_RUN_BATCH, KILLED_REASON, killAllActiveRuns } from './kill-all'

const NOW = new Date('2026-09-28T12:00:00.000Z')

const run = (id: string, organizationId = 'org_1') => ({ id, organizationId }) as TaskRun

function backend(overrides: Partial<BackendKillResult> = {}): BackendKillResult {
  return { found: 2, killed: ['job-1', 'job-2'], alreadyFinished: 0, failed: [], truncated: false, ...overrides }
}

beforeEach(() => {
  vi.mocked(killActiveBackendJobs).mockReset().mockResolvedValue(backend())
  vi.mocked(claimRunsToReconcile).mockReset().mockResolvedValue([])
  vi.mocked(recordRunOutcome).mockReset().mockResolvedValue({ notified: true, filed: null, closed: true })
  vi.mocked(withTenant).mockClear()
})

describe('killAllActiveRuns', () => {
  it('kills the jobs, then closes every still-active run as interrupted inside its own organization', async () => {
    vi.mocked(claimRunsToReconcile).mockResolvedValue([run('run-a', 'org_1'), run('run-b', 'org_2')])

    const result = await killAllActiveRuns(NOW)

    expect(claimRunsToReconcile).toHaveBeenCalledTimes(1)
    const [checkedBefore, batch] = vi.mocked(claimRunsToReconcile).mock.calls[0]
    expect(checkedBefore.getTime()).toBeGreaterThan(NOW.getTime())
    expect(batch).toBe(KILL_RUN_BATCH)
    for (const [id, organizationId] of [['run-a', 'org_1'], ['run-b', 'org_2']] as const) {
      expect(recordRunOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        { status: 'interrupted', error: KILLED_REASON },
        { onlyIfActive: true },
      )
      expect(withTenant).toHaveBeenCalledWith({ organizationId }, expect.any(Function))
    }
    expect(result).toEqual({
      jobsFound: 2,
      jobsKilled: 2,
      jobsAlreadyFinished: 0,
      runsClosed: 2,
      failures: [],
      truncated: false,
    })
  })

  it('does not count a run the backend report already closed', async () => {
    vi.mocked(claimRunsToReconcile).mockResolvedValue([run('run-a')])
    vi.mocked(recordRunOutcome).mockResolvedValue({ notified: false, filed: null, closed: false })

    expect((await killAllActiveRuns(NOW)).runsClosed).toBe(0)
  })

  it('closes no run when the job store did not confirm the kill', async () => {
    vi.mocked(killActiveBackendJobs).mockRejectedValue(new Error('backend down'))

    await expect(killAllActiveRuns(NOW)).rejects.toThrow('backend down')
    expect(claimRunsToReconcile).not.toHaveBeenCalled()
    expect(recordRunOutcome).not.toHaveBeenCalled()
  })

  it('names what could not be stopped, and keeps going past it', async () => {
    vi.mocked(killActiveBackendJobs).mockResolvedValue(
      backend({ killed: ['job-1'], failed: [{ jobId: 'job-2', error: 'dask unreachable' }] }),
    )
    vi.mocked(claimRunsToReconcile).mockResolvedValue([run('run-a'), run('run-b')])
    vi.mocked(recordRunOutcome)
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce({ notified: true, filed: null, closed: true })

    const result = await killAllActiveRuns(NOW)

    expect(result.runsClosed).toBe(1)
    expect(result.failures).toEqual([
      { id: 'job-2', error: 'dask unreachable' },
      { id: 'run-a', error: 'db blip' },
    ])
  })

  it('says so when either half hit its bound', async () => {
    vi.mocked(killActiveBackendJobs).mockResolvedValue(backend({ truncated: true }))
    expect((await killAllActiveRuns(NOW)).truncated).toBe(true)

    vi.mocked(killActiveBackendJobs).mockResolvedValue(backend())
    vi.mocked(claimRunsToReconcile).mockResolvedValue(
      Array.from({ length: KILL_RUN_BATCH }, (_, i) => run(`run-${i}`)),
    )
    expect((await killAllActiveRuns(NOW)).truncated).toBe(true)
  })
})
