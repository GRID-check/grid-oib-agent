/**
 * INTERNAL job slice — what the `bff-jobs` runner asks of the BFF in its own
 * pod, once per slice of a claimed job (ADR-0078).
 *
 * The runner is plain Node with no build step, so it cannot import the
 * services a job calls; it claims from `bff_job_queue`, then POSTs here with
 * the job id and its own worker name. This reads the row (only a row that
 * worker holds), runs ONE bounded step of the work as the person who asked, and
 * answers `{ done, payload }`: the runner saves `payload` as the job's progress
 * and asks again until `done`. 409 means the claim is no longer that worker's.
 *
 * Token-guarded (`internalApiRoute`); the pod serves no other traffic and has
 * no Service or HTTPRoute, so the token is a second wall, not the first.
 * Slices are safe to run twice: a worker that dies between a slice's effects
 * and the save repeats the slice, and every effect (a re-dispatch of a document
 * to the idempotent `/v1/ingest`, a retry of a failed one) tolerates that.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { runJobSlice } from '@/lib/jobs-queue/run'

const runSchema = z.object({
  jobId: z.string().uuid(),
  worker: z.string().min(1).max(200),
})

export const POST = internalApiRoute(
  'Internal Job Run',
  async ({ request }) => {
    const { jobId, worker } = await parseJsonBody(request, runSchema)
    return runJobSlice(jobId, worker)
  },
  {
    tenancy: {
      fromPayload:
        'the claimed queue row: its lane is the organization, and runJobSlice opens withTenant for it ' +
        '(the one read of the row itself runs under the platform scope)',
    },
  }
)
