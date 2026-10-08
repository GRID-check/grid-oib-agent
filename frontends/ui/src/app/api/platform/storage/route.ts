/**
 * Platform storage overview — stored bytes, quota and per-file upload limit for
 * every tenant, plus the deployment's upload-limit default and ceiling.
 *
 * Read-only. The per-organization WRITES live at
 * `/api/platform/organizations/[organizationId]/storage` (quota) and
 * `.../upload-limit`, so the list endpoint and the mutation endpoints cannot be
 * confused for one another.
 */

import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getPlatformStorageOverview } from '@/lib/storage/platform-service'

export const GET = platformApiRoute(async () => getPlatformStorageOverview(), {
  permission: PLATFORM_PERMISSIONS.organizationsView,
})
