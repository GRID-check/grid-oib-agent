/**
 * `platform_pricing_versions` table access — the only module that queries it
 * (ADR-0017). Global (no org scoping): at most one active row.
 */

import 'server-only'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { platformPricingVersions, type PlatformPricingVersion } from '@/lib/db/schema'

const ACCESS_REASON = 'the platform price list is fleet-wide configuration, owned by no tenant'

/** Bound for the history read: the version picker shows the last few changes. */
const MAX_HISTORY_ROWS = 50

export async function findActivePricingVersion(): Promise<PlatformPricingVersion | null> {
  const db = getDb()
  const [row] = await withPlatformAccess(ACCESS_REASON, () =>
    db
      .select()
      .from(platformPricingVersions)
      .where(eq(platformPricingVersions.status, 'active'))
      .limit(1),
  )
  return row ?? null
}

export async function listPricingHistory(limit = MAX_HISTORY_ROWS): Promise<PlatformPricingVersion[]> {
  const db = getDb()
  return withPlatformAccess(ACCESS_REASON, () =>
    db
      .select()
      .from(platformPricingVersions)
      .orderBy(desc(platformPricingVersions.createdAt))
      .limit(Math.min(limit, MAX_HISTORY_ROWS)),
  )
}

export interface PricingVersionWriteInput {
  marginMultiplier: string
  usdPerCredit: string
  defaultOrgDailyCredits: string | null
  defaultOrgMonthlyCredits: string | null
  note: string | null
  createdBy: string
  createdByEmail: string | null
}

/**
 * Supersede idiom: mark the active row superseded and insert the replacement
 * in one transaction, so there is never a moment without a price list and
 * every change keeps its lineage.
 */
export async function insertPricingVersionSuperseding(
  values: PricingVersionWriteInput,
): Promise<PlatformPricingVersion> {
  const db = getDb()
  return withPlatformAccess(ACCESS_REASON, () =>
    db.transaction(async (tx) => {
      const [previous] = await tx
        .select({ id: platformPricingVersions.id })
        .from(platformPricingVersions)
        .where(eq(platformPricingVersions.status, 'active'))
        .limit(1)
      if (previous) {
        await tx
          .update(platformPricingVersions)
          .set({ status: 'superseded' })
          .where(eq(platformPricingVersions.id, previous.id))
      }
      const [inserted] = await tx
        .insert(platformPricingVersions)
        .values({ ...values, status: 'active', supersedesId: previous?.id ?? null })
        .returning()
      return inserted
    }),
  )
}
