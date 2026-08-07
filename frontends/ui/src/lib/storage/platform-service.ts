/**
 * Platform-owner view of storage across every tenant (ADR-0042).
 *
 * Separate module from `./service` on purpose. That one is tenant-scoped and is
 * imported by the upload hot path; this one crosses the RLS boundary and is
 * reachable only through `platformApiRoute`. Keeping them apart means a
 * tenant-facing route cannot reach a cross-org query by autocomplete, and the
 * import graph shows which is which.
 */

import 'server-only'
import { aggregateStorageUsageByOrganization } from './repository'
import { getStorageQuotaBytes } from './service'
import { findOrganizations } from '@/lib/organizations/repository'

export interface OrganizationStorageRow {
  organizationId: string
  /** Display name when Grid knows one; the caller falls back to the id. */
  displayName: string | null
  usedBytes: number
  documents: number
  /** Effective quota — the org's own value, else the platform default. */
  quotaBytes: number | null
  /** True when the quota comes from the platform default rather than this org. */
  inherited: boolean
}

export interface PlatformStorageOverview {
  organizations: OrganizationStorageRow[]
  totals: {
    usedBytes: number
    documents: number
    organizations: number
  }
}

/**
 * Every organization with storage, biggest consumer first.
 *
 * Ordered by usage rather than name because the reason to open this page is
 * "who is about to cause a problem", and an alphabetical list buries that.
 *
 * Organizations with a quota but no documents yet still appear: a quota set in
 * advance is a decision someone made, and hiding it until the first upload would
 * make it look unset.
 */
export async function getPlatformStorageOverview(): Promise<PlatformStorageOverview> {
  const [usageByOrg, organizations] = await Promise.all([
    aggregateStorageUsageByOrganization(),
    findOrganizations(),
  ])

  const ids = new Set<string>([
    ...usageByOrg.keys(),
    ...organizations.map((org) => org.workosOrganizationId),
  ])

  const names = new Map(
    organizations.map((org) => [org.workosOrganizationId, org.displayName ?? null]),
  )

  const rows = await Promise.all(
    [...ids].map(async (organizationId): Promise<OrganizationStorageRow> => {
      const usage = usageByOrg.get(organizationId)
      const quotaBytes = await getStorageQuotaBytes(organizationId)
      const own = organizations.find((org) => org.workosOrganizationId === organizationId)
      const settings = (own?.settings as Record<string, unknown> | undefined) ?? {}
      const hasOwnQuota = 'storageQuotaBytes' in settings

      return {
        organizationId,
        displayName: names.get(organizationId) ?? null,
        usedBytes: usage?.bytes ?? 0,
        documents: usage?.documents ?? 0,
        quotaBytes,
        inherited: !hasOwnQuota,
      }
    }),
  )

  rows.sort((a, b) => b.usedBytes - a.usedBytes)

  return {
    organizations: rows,
    totals: {
      usedBytes: rows.reduce((sum, row) => sum + row.usedBytes, 0),
      documents: rows.reduce((sum, row) => sum + row.documents, 0),
      organizations: rows.length,
    },
  }
}
