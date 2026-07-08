'use client'

/**
 * Platform owner's cross-organization overview (ADR-0016): stat tiles, the
 * organization directory with per-org spend from the usage ledger, and the
 * WorkOS Users Management widget scoped to the GRID Platform organization
 * (platform team). Mobile-first: tiles wrap 2-up, org rows stack with
 * micro-labeled stats under the `sm` breakpoint.
 */

import { type FC, type ReactNode, useEffect, useState } from 'react'
import { WorkOsWidgets, UsersManagement } from '@workos-inc/widgets'
import '@radix-ui/themes/styles.css'
import { Building2, FolderKanban, Gauge, ReceiptEuro } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { makeWidgetTokenFetcher } from '@/lib/workos/widget-token'
import { useResolvedAppearance } from '@/lib/workos/use-widget-appearance'
import { useLocale, useTranslations } from '@/i18n'
import { formatEur as eur } from '@/lib/format'

interface PlatformOrganizationDto {
  id: string
  name: string
  createdAt: string
  isPlatformOrg: boolean
  projectCount: number
  dayUsd: number
  monthUsd: number
  monthEvents: number
}

interface OverviewDto {
  organizations: PlatformOrganizationDto[]
  organizationsCapped: boolean
  totals: { organizations: number; projects: number; dayUsd: number; monthUsd: number; monthEvents: number }
  eurPerUsd: number
}

const StatTile: FC<{ icon: ReactNode; label: string; value: ReactNode }> = ({ icon, label, value }) => (
  <div className="flex items-center gap-3 rounded-lg border p-4">
    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      {icon}
    </div>
    <div className="min-w-0">
      <p className="truncate text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums tracking-tight">{value}</p>
    </div>
  </div>
)

export const PlatformOverview: FC = () => {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const appearance = useResolvedAppearance()
  const [overview, setOverview] = useState<OverviewDto | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/platform/overview')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        setOverview((await res.json()) as OverviewDto)
      })
      .catch(() => toast.error(t('loadError')))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading || !overview) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[74px] w-full" />
          ))}
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  const { totals } = overview

  return (
    <TooltipProvider delayDuration={100}>
      <div className="flex flex-col gap-6">
        {/* Headline stats */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            icon={<Building2 className="size-4" aria-hidden />}
            label={t('stats.organizations')}
            value={overview.organizationsCapped ? `${totals.organizations}+` : totals.organizations}
          />
          <StatTile
            icon={<FolderKanban className="size-4" aria-hidden />}
            label={t('stats.projects')}
            value={totals.projects}
          />
          <StatTile
            icon={<Gauge className="size-4" aria-hidden />}
            label={t('stats.spendToday')}
            value={eur(totals.dayUsd * overview.eurPerUsd)}
          />
          <StatTile
            icon={<ReceiptEuro className="size-4" aria-hidden />}
            label={t('stats.spendMonth')}
            value={
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default">{eur(totals.monthUsd * overview.eurPerUsd)}</span>
                </TooltipTrigger>
                <TooltipContent>{t('stats.requestsMonth', { count: totals.monthEvents })}</TooltipContent>
              </Tooltip>
            }
          />
        </div>

        {/* Organization directory */}
        <Card>
          <CardHeader>
            <CardTitle>{t('orgs.title')}</CardTitle>
            <CardDescription>{t('orgs.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            {overview.organizations.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('orgs.empty')}</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-lg border">
                {overview.organizations.map((org) => (
                  <li
                    key={org.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap"
                  >
                    <div className="min-w-0 flex-1 basis-full sm:basis-0">
                      <p className="flex items-center gap-2 truncate text-sm">
                        {org.name}
                        {org.isPlatformOrg && (
                          <Badge variant="secondary" className="shrink-0">
                            {t('orgs.platformBadge')}
                          </Badge>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {t('orgs.colCreated')}: {new Date(org.createdAt).toLocaleDateString(locale)}
                      </p>
                    </div>
                    <div className="flex flex-1 items-center justify-between gap-4 sm:flex-none sm:justify-end">
                      {(
                        [
                          [t('orgs.colProjects'), String(org.projectCount)],
                          [t('orgs.colToday'), eur(org.dayUsd * overview.eurPerUsd)],
                          [t('orgs.colMonth'), eur(org.monthUsd * overview.eurPerUsd)],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label} className="flex min-w-14 flex-col items-end">
                          <span className="text-[10px] font-medium uppercase leading-4 text-muted-foreground">
                            {label}
                          </span>
                          <span className="text-sm tabular-nums">{value}</span>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Platform team — WorkOS widget scoped to the GRID Platform org */}
        <WorkOsWidgets theme={{ appearance, radius: 'medium', scaling: '100%' }}>
          <Card>
            <CardHeader>
              <CardTitle>{t('team.title')}</CardTitle>
              <CardDescription>{t('team.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <UsersManagement authToken={makeWidgetTokenFetcher(['widgets:users-table:manage'], 'platform')} />
            </CardContent>
          </Card>
        </WorkOsWidgets>
      </div>
    </TooltipProvider>
  )
}
