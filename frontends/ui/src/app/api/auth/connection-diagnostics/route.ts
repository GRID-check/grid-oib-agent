/**
 * Connection diagnostics (read-only).
 *
 * The chat WebSocket upgrade is authorized by the gateway (server.js) via the
 * internal websocket-scope endpoint, which returns a helpful 403 reason when a
 * budget scope is exhausted. The browser cannot read that collapsed
 * failed-upgrade body, so once the WS connection ultimately fails the chat
 * client calls this same-origin endpoint to discover whether the cause was
 * budget exhaustion and render a distinct, actionable banner.
 *
 * Thin transport adapter (ADR-0017): session auth + validation come from the
 * factory; the budget check lives in `@/lib/budgets/service` and reuses the
 * same enforcement snapshot the WS upgrade uses. Read-only, no side effects.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { getConnectionDiagnostics } from '@/lib/budgets/service'

const querySchema = z.object({
  projectId: z.string().optional(),
})

export const GET = apiRoute(
  async ({ session, request }) =>
    getConnectionDiagnostics(session, parseQuery(request, querySchema)),
  { authz: { enforcedBy: 'getConnectionDiagnostics (scoped to session.organizationId)' } }
)
