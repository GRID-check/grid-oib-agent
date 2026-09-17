/**
 * INTERNAL service endpoint — the run's own account of itself, flushed here.
 *
 * ## What it is for
 *
 * A run's ledger is folded where the events are produced (the Python job
 * runner) and stored where the reader is (`messages.metadata.run_ledger`). This
 * is the one door between the two, and it is an HTTP route with a typed client
 * (`lib/runs/run-ledger-client.ts`) rather than a database call, because the BFF
 * is the single writer of `grid_app` (ADR-0003) and because a workspace
 * primitive has ONE surface every consumer is an equal client of (ADR-0055).
 *
 * ## The op set is closed at two, and the run id is in the path
 *
 * `append` adds steps and phases; `finish` states a result or an error. There is
 * no „set this field" verb, so the shapes a stored ledger can take are the
 * shapes `lib/runs/run-ledger.ts` can produce — which is what makes the
 * sanitiser's bound meaningful rather than advisory.
 *
 * The run id is a path parameter and appears nowhere in the body. It is the only
 * identity this route has, and a body that could name a second run would be a
 * body that could write into another tenant's thread.
 *
 * ## Identity: the row, not the caller
 *
 * The organization, the project and the requester are read off the `task_runs`
 * row (`applyRunLedgerOp`), which resolves it under platform access — the caller
 * genuinely has no tenant yet — and then does the write inside that run's own
 * organization, so RLS applies to it exactly as it would to a person's write.
 * Nothing about the acting identity is taken from the request.
 *
 * That is also why this route carries no request-context envelope, unlike
 * `/api/internal/tasks` and `/api/internal/document-versions`. Those two ACT AS
 * a person — they file a document, they queue work that will run as somebody —
 * so they need the signed statement of who that person is. This one acts as
 * nobody: it patches one jsonb key on a message a run already owns, and the run
 * row says whose it is. A scheduled fire has no human envelope to echo at all
 * („echo, never sign" — `aiq_agent/tools/documents/filing.py`), so requiring one
 * would mean a nightly task could never narrate itself.
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { applyRunLedgerOp } from '@/lib/runs/service'
import { runLedgerRequestSchema } from '@/lib/runs/run-ledger-types'

type Params = { runId: string }

export const POST = internalApiRoute<Params>(
  'Run Ledger',
  async ({ request, params }) => {
    const op = await parseJsonBody(request, runLedgerRequestSchema)
    return applyRunLedgerOp(params.runId, op)
  },
  {
    tenancy: {
      fromPayload:
        'the task_runs row named by params.runId — resolved under platform access, then entered as that run’s organization. The body never names one',
    },
  },
)
