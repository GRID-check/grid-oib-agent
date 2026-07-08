/**
 * WorkOS widget authorization token.
 *
 * Thin handler; scope filtering and the `?org=platform` guard live in
 * `@/lib/workos/widget-token-service`. Returns a Response directly so the
 * user-specific, short-lived token is never cached.
 */

import { NextResponse } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { mintWidgetToken } from '@/lib/workos/widget-token-service'

export const GET = apiRoute(async ({ session, request }) => {
  const url = new URL(request.url)
  const { token } = await mintWidgetToken(
    session,
    url.searchParams.getAll('scope'),
    url.searchParams.get('org') === 'platform',
  )

  return NextResponse.json(
    { token },
    // The token is user-specific and short-lived — never cache it.
    { headers: { 'Cache-Control': 'no-store' } },
  )
})
