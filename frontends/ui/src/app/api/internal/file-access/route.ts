/**
 * Internal file-access authorization endpoint.
 *
 * Service-to-service (guarded by `GRID_INTERNAL_API_TOKEN` via `internalApiRoute`,
 * i.e. the `x-grid-internal-token` header). The file-gateway (mounted-drive)
 * service calls this on every file access so drive access and web access are
 * authorized by the same brain. Returns `{ allow }` for a resolved
 * user + org + project + permission. See `@/lib/authz/file-access`.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { checkFileAccess } from '@/lib/authz/file-access'
import { PROJECT_PERMISSIONS } from '@/lib/authz/projects'

// Ids are format-checked at the edge so malformed input 400s here instead of
// reaching the DB / WorkOS. Permissions derive from the single source of truth.
const requestSchema = z.object({
  userId: z.string().regex(/^user_[A-Za-z0-9]+$/),
  organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/),
  projectId: z.string().uuid(),
  permission: z.enum(PROJECT_PERMISSIONS),
})

// Explicit output contract — this is the artifact the Go gateway is pinned to
// (see services/file-gateway/testdata/file-access-contract.json).
const responseSchema = z.object({ allow: z.boolean() })

export const POST = internalApiRoute('file-access', async ({ request }) => {
  const input = await parseJsonBody(request, requestSchema)
  return responseSchema.parse(await checkFileAccess(input))
})
