/**
 * Hand work to the `bff-jobs` pool (ADR-0079).
 *
 * The door a service uses to turn a long request into a job: it does its own
 * authorization first, then enqueues and answers 202 with the job id. What runs
 * is `./handlers.ts`; this file knows nothing of it, so a service can enqueue
 * without importing the code the job will call back into.
 */

import 'server-only'
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
export async function enqueueJob(input: {
  kind: BffJobKind
  organizationId: string
  payload: Record<string, unknown>
  priority?: BffJobPriority
  /** Hold the job until then: a job handing its work on after a failure waits out a backoff. */
  notBefore?: Date
}): Promise<EnqueuedJob> {
  const jobId = await insertJob({
    kind: input.kind,
    organizationId: input.organizationId,
    priority: input.priority ?? BFF_JOB_PRIORITY.bulk,
    payload: input.payload,
    notBefore: input.notBefore,
  })
  return { jobId }
}
