/**
 * Internal mount-authentication endpoint (ADR-0025).
 *
 * Service-to-service (guarded by `GRID_INTERNAL_API_TOKEN`). The file-gateway's
 * WebDAV Basic resolver calls this to turn the credentials a native macOS/
 * Windows mount dialog presented into an authenticated {userId, organizationId}
 * subject. Verification is fail-closed and uniform: every failure mode is the
 * same `{allow:false}`. Authorization is NOT decided here — every subsequent
 * file op is separately checked via /api/internal/file-access (WorkOS FGA).
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { verifyMountCredential } from '@/lib/drive/service'

const requestSchema = z.object({
  username: z.string().min(1).max(320),
  secret: z.string().min(8).max(512),
})

const responseSchema = z.object({
  allow: z.boolean(),
  userId: z.string().optional(),
  organizationId: z.string().optional(),
})

export const POST = internalApiRoute('mount-auth', async ({ request }) => {
  const input = await parseJsonBody(request, requestSchema)
  return responseSchema.parse(await verifyMountCredential(input))
})
