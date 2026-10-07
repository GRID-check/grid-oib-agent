/**
 * Run one slice of a claimed job (ADR-0079): what `POST /api/internal/jobs/run`
 * does for the `bff-jobs` runner.
 *
 * The runner names a job and itself, and nothing else. Everything the work
 * needs is read from the queue row here, and only a row that worker holds is
 * read at all, so the route cannot be made to run what the queue never handed
 * out, whoever holds the internal token.
 */

import 'server-only'
import { ConflictError } from '@/lib/api/errors'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { JOB_HANDLERS } from './handlers'
import { findClaimedJob } from './repository'
import { isBffJobKind } from './types'

export interface JobSliceOutcome {
  /** True when the job has nothing left to do; the runner then deletes the row. */
  done: boolean
  /** The state to save when it has not, which is what the next slice (on any worker) resumes from. */
  payload: object
}

export async function runJobSlice(jobId: string, worker: string): Promise<JobSliceOutcome> {
  const job = await withPlatformAccess('bff-jobs: read the row a worker was handed', () =>
    findClaimedJob(jobId, worker)
  )
  // 409, which the runner reads as "this claim is no longer yours".
  if (!job) throw new ConflictError('The job is not claimed by this worker')
  const kind = job.kind
  if (!isBffJobKind(kind)) throw new Error(`No handler for job kind "${kind}"`)

  // The lane is the organization, so the work runs inside it and row-level
  // security applies to everything the handler reads and writes.
  const result = await withTenant({ organizationId: job.lane }, () =>
    JOB_HANDLERS[kind]({ organizationId: job.lane, payload: job.payload, attempts: job.attempts })
  )
  return { done: result.done, payload: result.payload }
}
