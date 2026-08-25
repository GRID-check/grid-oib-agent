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
import { getDailySpendTrend, getSpendAcrossOrganizations, type DailySpendPoint } from '@/lib/budgets/service'
import { getPlatformOrganizationId } from '@/lib/authz/platform'

export interface PlatformOrganization {
  id: string
  name: string
  createdAt: string
  isPlatformOrg: boolean
  projectCount: number
  dayUsd: number
  monthUsd: number
  monthEvents: number
}

export interface PlatformOverview {
  organizations: PlatformOrganization[]
  /** True when more than one page of organizations exists (list shows the first 100). */
  organizationsCapped: boolean
  /** Platform-wide daily spend, last 30 UTC days (zero-filled). */
  dailyTrend: DailySpendPoint[]
  totals: {
    organizations: number
    projects: number
    dayUsd: number
    monthUsd: number
    monthEvents: number
  }
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
  const [orgList, projectCounts, spend, platformOrgId, dailyTrend] = await Promise.all([
    workos.organizations.listOrganizations({ limit: 100 }),
    projectCountsByOrganization(),
    getSpendAcrossOrganizations(),
    getPlatformOrganizationId(),
    getDailySpendTrend({ days: 30 }),
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
        dayUsd: orgSpend?.dayUsd ?? 0,
        monthUsd: orgSpend?.monthUsd ?? 0,
        monthEvents: orgSpend?.monthEvents ?? 0,
      }
    })
    .sort((a, b) => b.monthUsd - a.monthUsd || a.name.localeCompare(b.name))

  return {
    organizations,
    organizationsCapped: Boolean(orgList.listMetadata?.after),
    dailyTrend,
    totals: {
      organizations: organizations.length,
      projects: organizations.reduce((total, org) => total + org.projectCount, 0),
      dayUsd: organizations.reduce((total, org) => total + org.dayUsd, 0),
      monthUsd: organizations.reduce((total, org) => total + org.monthUsd, 0),
      monthEvents: organizations.reduce((total, org) => total + org.monthEvents, 0),
    },
  }
}
