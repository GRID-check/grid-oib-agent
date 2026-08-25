/**
 * Agent profiler — one conversation's turn/span timeline for the platform
 * owner's dashboard. Platform owners only; tenant admins get 403.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getConversationTimeline } from '@/lib/profiler/service'

export const GET = platformApiRoute<{ conversationId: string }>(
  async ({ params }) => {
    const { conversationId } = params
    const timeline = await getConversationTimeline(conversationId)
    return NextResponse.json(timeline)
  },
  { permission: PLATFORM_PERMISSIONS.organizationsView }
)
