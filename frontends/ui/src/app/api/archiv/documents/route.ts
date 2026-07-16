/**
 * Archiv API — list the organization's Archiv documents.
 * Thin handler; all logic lives in `@/lib/archiv/service`. Feature-gated by the
 * dark-launch `organization-archiv` flag (ADR-0024).
 */

import { apiRoute } from '@/lib/api/handler'
import { requireOrgArchivEnabled } from '@/lib/authz/feature-flags'
import { listArchiv } from '@/lib/archiv/service'

export const GET = apiRoute(async ({ session }) => {
  const gated = requireOrgArchivEnabled(session)
  if (gated) return gated
  return listArchiv(session)
})
