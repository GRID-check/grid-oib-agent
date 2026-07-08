/**
 * Restore a soft-deleted project during its grace period.
 * Thin handler; the pending/claimed rules live in `@/lib/projects/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { restoreProject } from '@/lib/projects/service'

export const POST = apiRoute<{ id: string }>(async ({ session, params, request }) => {
  await restoreProject(session, params.id, request)
  return { status: 'restored' }
})
