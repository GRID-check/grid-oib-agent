/**
 * Platform norm-registry verification — check a pointer against RIS and return
 * candidate matches for the admin to pick from. Platform owners only.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { verifyNormPointer } from '@/lib/norms/service'
import { verifyNormRequestSchema } from '@/lib/norms/schemas'

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const json = await request.json().catch(() => null)
    const parsed = verifyNormRequestSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Ungültige Verifizierungsanfrage', code: 'BAD_REQUEST', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const result = await verifyNormPointer(parsed.data)
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.details },
        { status: error.status },
      )
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
