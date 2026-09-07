/**
 * Platform-tier data service (ADR-0016): the cross-organization overview for
 * the platform owner's dashboard. Combines the WorkOS organization directory
 * with Grid-side per-org stats (projects, LLM spend from the usage ledger).
 *
 * Caller authorization (requirePlatformPermission) happens in the routes — this
 * module is data-only and must never be exposed to tenant sessions.
 */

import 'server-only'
import { count, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { projects } from '@/lib/db/schema'
import { getWorkOS } from '@/lib/workos/client'
import {
  getDailySpendTrend,
  getSpendAcrossOrganizations,
  type DailySpendPoint,
  type SpendWindow,
} from '@/lib/budgets/service'
import { getEffectivePricing } from '@/lib/pricing/service'
import { getPlatformOrganizationId } from '@/lib/authz/platform'

/**
 * Every money figure here is USD as OpenRouter charges it (`costUsd`), what the
 * tenant is charged for it (`priceUsd`) and the tenant's unit (`credits`) —
 * no currency conversion anywhere (ADR-0053). The difference between price
 * and cost is the platform's gross margin.
 */
export interface PlatformOrganization {
  id: string
  name: string
  createdAt: string
  isPlatformOrg: boolean
  projectCount: number
  day: SpendWindow
  month: SpendWindow
}

const EMPTY_WINDOW: SpendWindow = { costUsd: 0, priceUsd: 0, credits: 0, events: 0 }

const addWindows = (a: SpendWindow, b: SpendWindow): SpendWindow => ({
  costUsd: a.costUsd + b.costUsd,
  priceUsd: a.priceUsd + b.priceUsd,
  credits: a.credits + b.credits,
  events: a.events + b.events,
})

export interface PlatformOverview {
  organizations: PlatformOrganization[]
  /** True when more than one page of organizations exists (list shows the first 100). */
  organizationsCapped: boolean
  /** Platform-wide daily spend, last 30 UTC days (zero-filled). */
  dailyTrend: DailySpendPoint[]
  totals: {
    organizations: number
    projects: number
    day: SpendWindow
    month: SpendWindow
  }
  /** The price list in force right now — the numbers behind every credit above. */
  pricing: { marginMultiplier: number; usdPerCredit: number; explicit: boolean }
}

async function projectCountsByOrganization(): Promise<Map<string, number>> {
  const db = getDb()
  const rows = await withPlatformAccess('platform overview: project counts for every organization', () =>
    db
      .select({ organizationId: projects.organizationId, projectCount: count() })
      .from(projects)
      .where(isNull(projects.deletedAt))
      .groupBy(projects.organizationId),
  )
  return new Map(rows.map((row) => [row.organizationId, Number(row.projectCount)]))
}

/** The full platform overview: every org, biggest month spender first. */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  const workos = getWorkOS()
  const [orgList, projectCounts, spend, platformOrgId, dailyTrend, pricing] = await Promise.all([
    workos.organizations.listOrganizations({ limit: 100 }),
    projectCountsByOrganization(),
    getSpendAcrossOrganizations(),
    getPlatformOrganizationId(),
    getDailySpendTrend({ days: 30 }),
    getEffectivePricing(),
  ])
  const spendByOrg = new Map(spend.map((entry) => [entry.organizationId, entry]))

  const organizations: PlatformOrganization[] = orgList.data
    .map((org) => {
      const orgSpend = spendByOrg.get(org.id)
      return {
        id: org.id,
        name: org.name,
        createdAt: org.createdAt,
        isPlatformOrg: org.id === platformOrgId,
        projectCount: projectCounts.get(org.id) ?? 0,
        day: orgSpend?.day ?? EMPTY_WINDOW,
        month: orgSpend?.month ?? EMPTY_WINDOW,
      }
    })
    .sort((a, b) => b.month.priceUsd - a.month.priceUsd || a.name.localeCompare(b.name))

  return {
    organizations,
    organizationsCapped: Boolean(orgList.listMetadata?.after),
    dailyTrend,
    totals: {
      organizations: organizations.length,
      projects: organizations.reduce((total, org) => total + org.projectCount, 0),
      day: organizations.reduce((total, org) => addWindows(total, org.day), EMPTY_WINDOW),
      month: organizations.reduce((total, org) => addWindows(total, org.month), EMPTY_WINDOW),
    },
    pricing: {
      marginMultiplier: pricing.marginMultiplier,
      usdPerCredit: pricing.usdPerCredit,
      explicit: pricing.explicit,
    },
  }
}
