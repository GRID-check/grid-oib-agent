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
import { STORAGE_QUOTA_SETTING, effectiveQuotaFromSettings } from './service'
import { findOrganizations, ORGANIZATION_PAGE_MAX } from '@/lib/organizations/repository'

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
  /**
   * True when more organizations exist than were returned.
   *
   * Surfaced rather than swallowed: a truncated list that does not say so reads
   * as "this is every tenant", which is the one thing an operator uses this page
   * to conclude.
   */
  truncated: boolean
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
  // Exactly two queries, both grouped or bounded, regardless of fleet size.
  // This used to be two queries plus one `getStorageQuotaBytes` per row — a
  // settings read per tenant for a value `findOrganizations` had already
  // returned. The quota rule is a pure function of the settings bag
  // (`effectiveQuotaFromSettings`), so it is applied in memory here.
  const [usageByOrg, page] = await Promise.all([
    aggregateStorageUsageByOrganization(),
    findOrganizations(ORGANIZATION_PAGE_MAX),
  ])

  const settingsById = new Map(
    page.organizations.map((org) => [
      org.workosOrganizationId,
      (org.settings as Record<string, unknown> | null) ?? {},
    ]),
  )
  const names = new Map(
    page.organizations.map((org) => [org.workosOrganizationId, org.displayName ?? null]),
  )

  const ids = new Set<string>([...usageByOrg.keys(), ...settingsById.keys()])

  const rows = [...ids].map((organizationId): OrganizationStorageRow => {
    const usage = usageByOrg.get(organizationId)
    const settings = settingsById.get(organizationId) ?? {}

    return {
      organizationId,
      displayName: names.get(organizationId) ?? null,
      usedBytes: usage?.bytes ?? 0,
      documents: usage?.documents ?? 0,
      quotaBytes: effectiveQuotaFromSettings(settings),
      inherited: !(STORAGE_QUOTA_SETTING in settings),
    }
  })

  rows.sort((a, b) => b.usedBytes - a.usedBytes)

  return {
    organizations: rows,
    totals: {
      usedBytes: rows.reduce((sum, row) => sum + row.usedBytes, 0),
      documents: rows.reduce((sum, row) => sum + row.documents, 0),
      organizations: rows.length,
    },
    truncated: page.truncated,
  }
}
