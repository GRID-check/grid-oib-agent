/**
 * Agent profiler — cross-organization conversation directory for the
 * platform owner's dashboard. Platform owners only; tenant admins get 403.
 * Same gate shape as `api/platform/overview/route.ts`.
 *
 * Read in the Answer-quality scope (`lib/quality/scope.ts`: `from`, `to`,
 * repeatable `org` and `project`; a bad range is a 400). `q` searches within
 * it. `conversation` asks whether that one conversation is in the scope; the
 * answer comes back as `selected`, whatever the search or the list's cap.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { listProfiledConversations } from '@/lib/profiler/service'
import { parseQualityScopeStrict } from '@/lib/quality/scope'

export const GET = platformApiRoute(
  async ({ request }) => {
    const params = new URL(request.url).searchParams
    const parsed = parseQualityScopeStrict(params)
    if (!parsed.ok) {
      return NextResponse.json(
        { error: 'Invalid scope', code: 'BAD_REQUEST', details: { scope: parsed.error } },
        { status: 400 }
      )
    }
    const result = await listProfiledConversations(parsed.scope, {
      query: params.get('q')?.trim() || undefined,
      conversationId: params.get('conversation')?.trim() || undefined,
    })
    return NextResponse.json(result)
  },
  { permission: PLATFORM_PERMISSIONS.organizationsView }
)
