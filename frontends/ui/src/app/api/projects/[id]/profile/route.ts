/**
 * Project profile API — read and replace the structured profile.
 * Thin handlers; the optimistic-concurrency rules (409 on version conflict)
 * live in `@/lib/project-profile/profile-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { getProjectProfile, saveProjectProfile } from '@/lib/project-profile/profile-service'
import { ProjectProfileSchema } from '@/lib/project-profile/types'

type Params = { id: string }

/**
 * The profileVersion the client loaded, from the If-Match header (optionally
 * ETag-style quoted). Absent header → undefined (legacy callers keep the old
 * in-request check); present but malformed → 400, never silently ignored.
 */
function parseIfMatchVersion(header: string | null): number | undefined {
  if (header === null) return undefined
  const raw = header.trim().replace(/^"(.*)"$/, '$1')
  const version = Number(raw)
  if (!Number.isInteger(version) || version < 0) {
    throw new BadRequestError('Invalid If-Match header: expected a profile version number.')
  }
  return version
}

export const GET = apiRoute<Params>(async ({ session, params }) => getProjectProfile(session, params.id))

export const PUT = apiRoute<Params>(async ({ session, params, request }) => {
  const profile = await parseJsonBody(request, ProjectProfileSchema)
  const expectedVersion = parseIfMatchVersion(request.headers.get('if-match'))
  return saveProjectProfile(session, params.id, profile, expectedVersion)
})
