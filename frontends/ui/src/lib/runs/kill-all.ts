/**
 * The platform kill switch: stop every running deep research and close its run.
 *
 * Two halves, in this order:
 *
 *  1. The job store (`killActiveBackendJobs`). Every submitted or running job is
 *     written INTERRUPTED, its queue row dropped (db mode) or its Dask task
 *     force-cancelled, and a running worker's `CancellationMonitor` sees the
 *     status and stops. The backend reports each verdict to
 *     `/api/internal/jobs/{id}/outcome`, which closes most `task_runs` rows
 *     before this call returns.
 *  2. The runs the report could not reach: a row with no backend job id, a
 *     report that was lost, a job that had already vanished from the store.
 *     Every row still `queued`/`running` is closed `interrupted` through the one
 *     recorder, with `onlyIfActive`, so a row the report closed a moment ago is
 *     left alone and its requester hears once.
 *
 * If the first half fails, the second does not run: closing the rows of jobs
 * that are still working would show them as stopped while they spend tokens.
 */

import 'server-only'
import type { TaskRun } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { killActiveBackendJobs } from '@/lib/jobs/backend-client'
import * as taskRepository from '@/lib/tasks/repository'
import { recordRunOutcome } from '@/lib/tasks/service'

/** Shown to the requester on the run's block and in the Aufträge list. */
export const KILLED_REASON = 'Der Lauf wurde von der Plattform-Administration abgebrochen.'

/** How many still-active rows one press closes. A larger backlog is closed by pressing again. */
export const KILL_RUN_BATCH = 500
const KILL_CONCURRENCY = 5

export interface KillAllResult {
  /** Jobs the job store held as submitted or running. */
  jobsFound: number
  jobsKilled: number
  /** Jobs that finished on their own while the kill ran; their verdict stands. */
  jobsAlreadyFinished: number
  /** Active run rows this tier closed itself, after the backend's reports. */
  runsClosed: number
  failures: { id: string; error: string }[]
  /** Either half hit its batch bound; press again for the rest. */
  truncated: boolean
}

async function closeRun(run: TaskRun): Promise<'closed' | 'already-closed'> {
  const recorded = await withTenant({ organizationId: run.organizationId }, () =>
    recordRunOutcome(run, { status: 'interrupted', error: KILLED_REASON }, { onlyIfActive: true }),
  )
  return recorded.closed ? 'closed' : 'already-closed'
}

export async function killAllActiveRuns(now: Date = new Date()): Promise<KillAllResult> {
  const backend = await killActiveBackendJobs()

  // The reconciler's claim, with a window every active row is inside: `age` is
  // at most now, so "not checked since a minute from now" is every active row.
  const everyone = new Date(now.getTime() + 60_000)
  const claimed = await withPlatformAccess(
    'platform kill switch: finding the still-active runs of every organization',
    () => taskRepository.claimRunsToReconcile(everyone, KILL_RUN_BATCH),
  )

  const result: KillAllResult = {
    jobsFound: backend.found,
    jobsKilled: backend.killed.length,
    jobsAlreadyFinished: backend.alreadyFinished,
    runsClosed: 0,
    failures: backend.failed.map((f) => ({ id: f.jobId, error: f.error })),
    truncated: backend.truncated || claimed.length >= KILL_RUN_BATCH,
  }
  for (let i = 0; i < claimed.length; i += KILL_CONCURRENCY) {
    const slice = claimed.slice(i, i + KILL_CONCURRENCY)
    await Promise.all(
      slice.map(async (run) => {
        try {
          if ((await closeRun(run)) === 'closed') result.runsClosed += 1
        } catch (error) {
          console.error('[runs] kill switch: run', run.id, 'could not be closed', error)
          result.failures.push({ id: run.id, error: error instanceof Error ? error.message : String(error) })
        }
      }),
    )
  }
  return result
}
