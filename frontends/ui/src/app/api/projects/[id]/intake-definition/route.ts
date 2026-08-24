/**
 * Project intake definition API — the static intake questionnaire.
 * Thin handler; authz lives in `@/lib/project-profile/profile-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getProjectIntakeDefinition } from '@/lib/project-profile/profile-service'

export const GET = apiRoute<{ id: string }>(
  async ({ session, params }) => getProjectIntakeDefinition(session, params.id),
  { authz: { enforcedBy: 'getProjectIntakeDefinition (requireProjectAccess project:view)' } }
)
