/**
 * Platform → cards. Every card type the agent can render, with the fields each
 * one shows and a worked example, plus the GitHub link for requesting a card —
 * or a value on an existing card — that Grid cannot render yet.
 *
 * Read-only and derived from the backend's Pydantic card union, so this list
 * cannot drift from what the product actually renders. Platform owners only,
 * like the rest of the tier.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getCardCatalog } from '@/lib/platform/card-catalog'

export const GET = platformApiRoute(
  async () => {
    return NextResponse.json(await getCardCatalog())
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)
