/**
 * Platform → answer feedback: the cross-organization view of the thumbs users
 * leave on answers. Platform owners only; tenant admins get 403.
 *
 * The gate lives in `getAnswerFeedbackHealth`, not here, so it cannot be lost by
 * a second caller — this route only translates the refusal into a status.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { getAnswerFeedbackHealth } from '@/lib/feedback/service'
import { parseFeedbackFilters } from '@/lib/feedback/query'

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    const filters = parseFeedbackFilters(new URL(request.url).searchParams)
    const health = await getAnswerFeedbackHealth(session, filters)
    return NextResponse.json(health)
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
