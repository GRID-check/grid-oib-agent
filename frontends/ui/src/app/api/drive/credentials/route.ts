/**
 * Drive device credentials — create + list (ADR-0025).
 *
 * Session-authenticated: this is WHERE the SSO happens for the mounted drive.
 * Native mount dialogs can't run an OIDC flow, so the user mints a device
 * credential here (inside their WorkOS-SSO'd session) and types it once into
 * the macOS/Windows dialog. POST returns the secret exactly once.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { createDriveCredential, listDriveCredentials } from '@/lib/drive/service'

const createSchema = z.object({
  label: z.string().trim().min(1).max(64),
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createSchema)
    return createDriveCredential(session, input, request)
  },
  { status: 201 },
)

export const GET = apiRoute(async ({ session }) => ({
  credentials: await listDriveCredentials(session),
}))
