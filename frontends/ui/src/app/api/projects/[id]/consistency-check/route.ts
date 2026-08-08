/**
 * Free-text intake consistency-check API (FB-13) — ask the backend LLM whether
 * the wizard's free-text answers contradict the structured answers (passed as
 * read-only context) before the profile is saved. Structured answers are
 * checked deterministically on the client, not here. Thin handler; the backend
 * call lives in `@/lib/project-profile/profile-service`.
 *
 * Best-effort by design: the service never throws, so this route always returns
 * 200 with `{ findings, error? }`. The wizard treats null/errored findings as
 * "proceed with the save" — a check outage must not block saving.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { checkProjectConsistency } from '@/lib/project-profile/profile-service'

const fieldSchema = z.object({ field: z.string(), value: z.string() })

const consistencyCheckSchema = z.object({
  freeText: z.array(fieldSchema).max(50),
  structured: z.array(fieldSchema).max(200).optional(),
  locale: z.string().optional(),
})

export const POST = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, consistencyCheckSchema)
    return checkProjectConsistency(session, params.id, input)
  },
  { authz: { enforcedBy: 'checkProjectConsistency (requireProjectAccess project:edit)' } }
)
