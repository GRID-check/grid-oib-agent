/**
 * Drive device credential — revoke (ADR-0025). Owner-scoped in SQL; a missing,
 * cross-tenant, or already-revoked credential is a 404.
 */

import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { revokeDriveCredential } from '@/lib/drive/service'

const paramsSchema = z.object({ id: z.string().uuid() })

export const DELETE = apiRoute<{ id: string }>(async ({ session, params, request }) => {
  const parsed = paramsSchema.safeParse(params)
  if (!parsed.success) throw new BadRequestError('Invalid credential id')
  await revokeDriveCredential(session, parsed.data.id, request)
  return null
})
