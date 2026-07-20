/**
 * Agent profiler — one conversation's turn/span timeline for the platform
 * owner's dashboard. Platform owners only; tenant admins get 403.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { getConversationTimeline } from '@/lib/profiler/service'

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const { conversationId } = await context.params
    const timeline = await getConversationTimeline(conversationId)
    return NextResponse.json(timeline)
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
