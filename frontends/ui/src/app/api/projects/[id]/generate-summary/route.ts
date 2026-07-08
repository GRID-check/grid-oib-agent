/**
 * Project summary generation API — generate and persist an AI profile summary.
 * Thin handler; the backend call and persistence live in
 * `@/lib/project-profile/profile-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { generateProjectSummary } from '@/lib/project-profile/profile-service'

export const POST = apiRoute<{ id: string }>(async ({ session, params }) =>
  generateProjectSummary(session, params.id),
)
