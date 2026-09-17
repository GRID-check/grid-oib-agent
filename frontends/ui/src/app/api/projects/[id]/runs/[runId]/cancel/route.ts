/**
 * Stop one run on a person's request (ADR-0062).
 *
 * The write side of the run primitive that the block's „Abbrechen" presses.
 * `runId` is the run's PUBLIC key; the backend job it maps to is the service's
 * business, and so is the cancel itself — this is the browser's existing job
 * cancel (`POST /api/jobs/async/job/{jobId}/cancel`) reached by run id, not a
 * second one.
 *
 * Thin adapter: `cancelRun` authorizes (`project:view` plus `CHAT_PERMISSIONS`,
 * the proxy's gate), resolves the run inside the project, refuses what cannot
 * be stopped (409) and asks the backend. Answers the run view as it stands;
 * the ledger turns `abgebrochen` through the run's own stream, never here.
 */

import { apiRoute } from '@/lib/api/handler'
import { cancelRun } from '@/lib/runs/service'

type Params = { id: string; runId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => cancelRun(session, params.id, params.runId),
  {
    authz: {
      enforcedBy: 'cancelRun (requireProjectAccess project:view + CHAT_PERMISSIONS)',
    },
  },
)
