/**
 * INTERNAL service endpoint — a finished run's answer, written into the run's
 * own message (ADR-0062).
 *
 * ## Why it is keyed on the BACKEND job id
 *
 * The worker holds exactly one id, the job store's, and it is the wrong one to
 * derive anything from: the run's message id comes from the `task_runs` id, and
 * only this tier knows the pair. So the worker names the job it finished and the
 * BFF resolves the rest. That resolution is also what the deep links use
 * (`findRunMessageByBackendJobId`), which is why it is one function and not two.
 *
 * ## A 404 is an answer, not a failure
 *
 * An interactive deep-research job has no `task_runs` row, and a run submitted
 * before this tier minted run messages has no message. Both answer 404, and the
 * worker takes that as „write the turn the old way"
 * (`jobs/conversation_output.py`) rather than as an error — which is what keeps
 * a deploy in either order from losing somebody's report.
 *
 * ## Identity: the row, not the caller
 *
 * Same rule as the ledger route next door. The organization comes off the
 * `task_runs` row, resolved under platform access because the caller genuinely
 * has no tenant yet, and the write happens inside that run's own organization so
 * RLS applies to it as it would to a person's. The body carries the report and
 * names nobody.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { writeRunReport } from '@/lib/runs/service'

type Params = { backendJobId: string }

const runReportSchema = z.object({
  /** The report as the reader sees it. Empty is legal: a notice has no report. */
  content: z.string(),
  /**
   * The answer's own transparency, in the BACKEND's wire spelling — `sources`,
   * `answer_confidence`, `research_truncated`. Translated to the stored contract
   * by the service, at the one point the foreign dialect enters.
   */
  metadata: z.record(z.unknown()).optional(),
})

export const POST = internalApiRoute<Params>(
  'Run Report',
  async ({ request, params }) => {
    const body = await parseJsonBody(request, runReportSchema)
    return writeRunReport(params.backendJobId, body)
  },
  {
    tenancy: {
      fromPayload:
        'the task_runs row named by params.backendJobId — resolved under platform access, then entered as that run’s organization. The body never names one',
    },
  },
)
