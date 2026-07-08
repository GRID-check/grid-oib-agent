/**
 * Project profile API — read and replace the structured profile.
 * Thin handlers; the optimistic-concurrency rules (409 on version conflict)
 * live in `@/lib/project-profile/profile-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { getProjectProfile, saveProjectProfile } from '@/lib/project-profile/profile-service'
import { ProjectProfileSchema } from '@/lib/project-profile/types'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getProjectProfile(session, params.id))

export const PUT = apiRoute<Params>(async ({ session, params, request }) => {
  const profile = await parseJsonBody(request, ProjectProfileSchema)
  return saveProjectProfile(session, params.id, profile)
})
