/**
 * Platform norm-registry API — read the curated catalog and persist edits.
 * Platform owners only. The whole registry is written at once under the held
 * optimistic-concurrency version; backend 409/422/400 statuses are relayed
 * faithfully so the client can react (reload prompt / validation message).
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { getNormRegistry, putNormRegistry } from '@/lib/norms/service'
import { putNormRegistryBodySchema } from '@/lib/norms/schemas'

export async function GET(): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)
    const registry = await getNormRegistry()
    return NextResponse.json(registry)
  } catch (error) {
    return handleError(error)
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const json = await request.json().catch(() => null)
    const parsed = putNormRegistryBodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Ungültige Registry', code: 'BAD_REQUEST', details: parsed.error.flatten() },
        { status: 400 },
      )
    }

    const result = await putNormRegistry(session, parsed.data, request)
    return NextResponse.json(result)
  } catch (error) {
    return handleError(error)
  }
}

function handleError(error: unknown): Response {
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
