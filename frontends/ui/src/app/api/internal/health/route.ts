/**
 * INTERNAL service health/handshake endpoint. The Python backend GETs this at
 * startup with its service token to verify — before any `remember` call — that
 * the internal API is reachable AND that GRID_INTERNAL_API_TOKEN matches across
 * the aiq-agent and frontend services. Same fail-closed token rules as the
 * memory route (both enforced by `internalApiRoute` via `@/lib/internal-auth`):
 * a bad token returns 403, an unset/dev-default-in-prod token returns 503.
 * Not user-facing.
 */

import { internalApiRoute } from '@/lib/api/handler'

export const GET = internalApiRoute('Internal Health', async () => {
  return { ok: true }
})
