/**
 * Project summary generation API — generate and persist an AI profile summary.
 * Thin handler; the backend call and persistence live in
 * `@/lib/project-profile/profile-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { generateProjectSummary } from '@/lib/project-profile/profile-service'

export const POST = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    // Optional body: { locale } — the UI language the summary should be written
    // in. Tolerate an absent/invalid body (legacy callers sent none).
    const body = (await request.json().catch(() => null)) as { locale?: unknown } | null
    const locale = typeof body?.locale === 'string' ? body.locale : undefined
    return generateProjectSummary(session, params.id, { locale })
  },
  { authz: { enforcedBy: 'generateProjectSummary (requireProjectAccess project:edit)' } }
)
