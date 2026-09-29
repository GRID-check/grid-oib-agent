/**
 * `GET /api/platform/feedback` — Platform → Feedback: every product-feedback
 * report across organizations, newest first, filtered by status and kind.
 * Thin adapter (ADR-0017); the service re-asks the permission.
 */

import { parseQuery } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { listProductFeedbackForPlatform } from '@/lib/product-feedback/service'
import { listProductFeedbackQuerySchema } from '@/lib/product-feedback/types'

export const GET = platformApiRoute(
  async ({ session, request }) => {
    return listProductFeedbackForPlatform(session, parseQuery(request, listProductFeedbackQuerySchema))
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)
