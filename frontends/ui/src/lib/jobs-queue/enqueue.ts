/**
 * Hand work to the `bff-jobs` pool (ADR-0079).
 *
 * The door a service uses to turn a long request into a job: it does its own
 * authorization first, then enqueues and answers 202 with the job id. What runs
 * is `./handlers.ts`; this file knows nothing of it, so a service can enqueue
 * without importing the code the job will call back into.
 */

import 'server-only'
import type { DbExecutor } from '@/lib/db/executor'
import { BFF_JOB_PRIORITY, type BffJobKind, type BffJobPriority } from './types'
import { insertJob } from './repository'

export interface EnqueuedJob {
  jobId: string
}

/**
 * Store a job in the lane of `organizationId`, which must be the active tenant.
 *
 * Bulk by default: this queue exists for the work that used to run inside one
 * long request (a reindex, a rescan), which must yield to a person's upload.
 * A job a person is waiting on says `interactive`.
 */
export async function enqueueJob(
  input: {
    kind: BffJobKind
    organizationId: string
    payload: Record<string, unknown>
    priority?: BffJobPriority
    /** The id to give the job, when the caller stamps it on rows in the same transaction. */
    jobId?: string
  },
  /** The caller's transaction, when the job must commit or roll back with its other writes. */
  executor?: DbExecutor
): Promise<EnqueuedJob> {
  const jobId = await insertJob(
    {
      kind: input.kind,
      organizationId: input.organizationId,
      priority: input.priority ?? BFF_JOB_PRIORITY.bulk,
      payload: input.payload,
      jobId: input.jobId,
    },
    executor
  )
  return { jobId }
}
