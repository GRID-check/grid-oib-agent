/**
 * INTERNAL service endpoint — the worker reports how a background run ended.
 *
 * The scheduler fires a job through `/api/internal/skills/fire`; the run then
 * lives entirely in the Python job store, and until this route existed the BFF
 * never learned that it finished. The worker calls here from its terminal
 * arms (success, failure, interrupted) with the one id it holds — the backend
 * job id — and the BFF turns that into an inbox item for the person who
 * created the job (`recordJobOutcome`).
 *
 * Same posture as `skills/fire`: the lookup by backend id genuinely has no
 * tenant yet, so it runs under platform access, narrowly; everything after is
 * one organization's work and is done as that organization, so row-level
 * security still applies to it. A backend id the BFF has no run for (an
 * interactive deep-research job) is a 404, which the worker treats as "nothing
 * to notify", not as an error.
 */

import { z } from 'zod'
import { NotFoundError } from '@/lib/api/errors'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { loadJobRunForOutcome, recordJobOutcome } from '@/lib/jobs/service'

type Params = { jobId: string }

const REPORT_MAX_CHARS = 400_000

const outcomeSchema = z.object({
  // The run's tenant as the worker knows it (from the job's usage context).
  // Cross-checked against the run row: the token grants no cross-org bypass.
  organizationId: z.string().min(1),
  status: z.enum(['success', 'failure', 'interrupted']),
  // The sanitized, user-safe error the worker persisted. Capped: it is
  // caller-controlled text on its way into a jsonb payload.
  error: z.string().max(2000).nullish(),
  // The finished report and its cards, so a scheduled run's report can be
  // filed here as the requester instead of expiring with the job store. The
  // cap is generous — the PDF renderer applies its own, and refuses past it
  // with a recorded filing failure rather than a 400 here that would also
  // lose the outcome notification.
  report: z.string().max(REPORT_MAX_CHARS).nullish(),
  cards: z.array(z.unknown()).max(200).nullish(),
})


export const POST = internalApiRoute<Params>(
  'Job Outcome',
  async ({ request, params }) => {
    const { organizationId, status, error, report, cards } = await parseJsonBody(request, outcomeSchema)

    const run = await withPlatformAccess(
      'job outcome: the worker identifies a run by backend job id, before any organization is known',
      () => loadJobRunForOutcome(params.jobId)
    )
    if (!run || run.organizationId !== organizationId) throw new NotFoundError('Unknown job run')

    return withTenant({ organizationId: run.organizationId }, () =>
      recordJobOutcome(run, { status, error: error ?? null, report: report ?? null, cards: cards ?? null })
    )
  },
  { tenancy: { fromPayload: 'the job run named by params.jobId, cross-checked against body.organizationId' } }
)
