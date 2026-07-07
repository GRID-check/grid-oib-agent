/**
 * WorkOS widget authorization token.
 *
 * Mints a short-lived (≈1h) widget session token scoped to the signed-in user
 * and their active organization. The token is consumed client-side by the
 * WorkOS widgets (e.g. the User Sessions / User Security widgets on the profile
 * page). The user-scoped widgets require no additional widget scopes — they act
 * on the authenticated user themselves — so we mint the token without any.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getWorkOS } from '@/lib/workos/client'

export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()

    const { token } = await getWorkOS().widgets.createToken({
      organizationId: session.organizationId,
      userId: session.userId,
    })

    return NextResponse.json(
      { token },
      // The token is user-specific and short-lived — never cache it.
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
