/**
 * Project profile patches API — apply agent-proposed patch operations to the
 * stored profile. Thin handler; normalization, unknown-pruning, and the
 * optimistic-concurrency rules live in `@/lib/project-profile/profile-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { patchProjectProfile } from '@/lib/project-profile/profile-service'
import { ProjectProfilePatchOperationSchema } from '@/lib/project-profile/types'
import { getLocale } from '@/i18n/server'

type Params = { id: string }

const patchProfileSchema = z.object({
  patch: z.array(ProjectProfilePatchOperationSchema),
  /**
   * The conversation a `project_profile_patch` card was proposed in. A thread
   * that drew on a restricted folder may not write the project-wide profile
   * (ADR-0080). Absent for the brief's own editor.
   */
  conversationId: z.string().min(1).max(128).optional(),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { patch, conversationId } = await parseJsonBody(request, patchProfileSchema)
    const origin = conversationId ? { conversationId, locale: await getLocale() } : undefined
    return patchProjectProfile(session, params.id, patch, origin)
  },
  {
    authz: {
      enforcedBy:
        'patchProjectProfile (requireProjectAccess project:edit; with a conversationId, requireResourceAccess conversation viewer and the restricted-folder refusal)',
    },
  }
)
