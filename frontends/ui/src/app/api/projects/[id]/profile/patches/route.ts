/**
 * Project profile patches API — apply agent-proposed patch operations to the
 * stored profile. Thin handler; normalization, unknown-pruning, and the
 * optimistic-concurrency rules live in `@/lib/project-profile/profile-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { patchProjectProfile } from '@/lib/project-profile/profile-service'
import { ProjectProfilePatchOperationSchema } from '@/lib/project-profile/types'

type Params = { id: string }

const patchProfileSchema = z.object({
  patch: z.array(ProjectProfilePatchOperationSchema),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { patch } = await parseJsonBody(request, patchProfileSchema)
    return patchProjectProfile(session, params.id, patch)
  },
  { authz: { enforcedBy: 'patchProjectProfile (requireProjectAccess project:edit)' } }
)
