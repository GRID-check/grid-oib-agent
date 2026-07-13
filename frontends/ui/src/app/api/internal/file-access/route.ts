/**
 * Internal file-access authorization endpoint.
 *
 * Service-to-service (guarded by `GRID_INTERNAL_API_TOKEN`). The file-gateway
 * (mounted-drive) service calls this on every file access so drive access and web
 * access are authorized by the same brain. Returns `{ allow }` for a resolved
 * user + org + project + permission. See `@/lib/authz/file-access`.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { checkFileAccess } from '@/lib/authz/file-access'

const schema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  permission: z.enum(['project:view', 'project:edit', 'project:manage', 'project:chat']),
})

export const POST = internalApiRoute('file-access', async ({ request }) => {
  const input = await parseJsonBody(request, schema)
  return checkFileAccess(input)
})
