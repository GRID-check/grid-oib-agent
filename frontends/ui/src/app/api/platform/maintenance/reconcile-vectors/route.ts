/**
 * Platform maintenance — reconcile orphaned vectors: delete vector-store chunks
 * whose owning document row is gone (the residue of past deletes where the
 * chunk cleanup was skipped or missed). Platform owners only.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { reconcileOrphanedVectors } from '@/lib/platform/vector-reconcile'

export async function POST(): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const result = await reconcileOrphanedVectors()
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
