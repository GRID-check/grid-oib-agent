/**
 * Platform storage overview — stored bytes and quota for every tenant.
 *
 * Read-only. The per-organization quota WRITE lives at
 * `/api/platform/organizations/[organizationId]/storage`, so the list endpoint
 * and the mutation endpoint cannot be confused for one another.
 */

import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getPlatformStorageOverview } from '@/lib/storage/platform-service'

export const GET = platformApiRoute(async () => getPlatformStorageOverview(), {
  permission: PLATFORM_PERMISSIONS.organizationsView,
})
