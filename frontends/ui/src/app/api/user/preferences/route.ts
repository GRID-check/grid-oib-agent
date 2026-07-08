/**
 * User preferences API — opaque per-user preferences such as the active
 * project id. Thin handlers; all logic lives in
 * `@/lib/user-preferences/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { getUserPreferences, mergeUserPreferences } from '@/lib/user-preferences/service'

const updatePreferencesSchema = z.object({
  prefs: z.record(z.unknown()),
})

export const GET = apiRoute(async ({ session }) => ({ prefs: await getUserPreferences(session) }))

export const POST = apiRoute(async ({ session, request }) => {
  const { prefs } = await parseJsonBody(request, updatePreferencesSchema)
  return { prefs: await mergeUserPreferences(session, prefs) }
})
