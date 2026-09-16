/**
 * One run, as a person reads it: where its message is, and what its ledger says
 * (ADR-0062).
 *
 * The read side of the run primitive. `runId` is the PUBLIC key of a run — the
 * backend job id is an implementation detail of the job store, and it expires
 * with it — so every surface that follows a run (the thread, a deep link, the
 * Tasks list) resolves it here and gets the conversation and message to open.
 *
 * Thin adapter: `getRunView` authorizes (`project:view`) and reads, and the
 * query is project- and organization-scoped, so RLS backs the check rather than
 * standing in for it.
 */

import { apiRoute } from '@/lib/api/handler'
import { getRunView } from '@/lib/runs/service'

type Params = { id: string; runId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getRunView(session, params.id, params.runId),
  {
    authz: {
      enforcedBy: 'getRunView (requireProjectAccess project:view)',
    },
  },
)
