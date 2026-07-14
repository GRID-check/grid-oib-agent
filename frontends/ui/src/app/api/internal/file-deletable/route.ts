/**
 * Internal file-deletable (legal-hold) gate.
 *
 * Service-to-service (guarded by `GRID_INTERNAL_API_TOKEN` via `internalApiRoute`).
 * The file-gateway calls this synchronously before a mounted-drive `rm` destroys
 * bytes: it answers whether an active legal hold blocks the deletion (ADR-0024
 * §3). Authorization (`project:edit`) is enforced separately by the gateway's
 * Guard; this endpoint answers ONLY the orthogonal compliance question. The
 * gateway fails closed (refuses the delete) on any non-`{deletable:true}` answer.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { checkFileDeletable } from '@/lib/authz/file-access'

const requestSchema = z.object({
  organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/),
  projectId: z.string().uuid(),
  objectKey: z.string().min(1),
})

const responseSchema = z.object({ deletable: z.boolean() })

export const POST = internalApiRoute('file-deletable', async ({ request }) => {
  const input = await parseJsonBody(request, requestSchema)
  return responseSchema.parse(await checkFileDeletable(input))
})
