'use client'

/**
 * Platform owner's cross-organization overview (ADR-0016): headline stat tiles,
 * the 30-day spend trend, the organization directory with per-org spend from
 * the usage ledger, and the WorkOS Users Management widget scoped to the GRID
 * Platform organization.
 *
 * The directory is built on the shared admin primitives (SectionCard +
 * DataToolbar + Table + Pagination). It used to be a hand-rolled list of flex
 * rows with micro-labelled stats stacked inside each row: nothing could be
 * compared column-wise, nothing could be sorted, and a cross-organization
 * directory had no search at all. The platform team moved into its own card
 * because inviting staff with platform-wide access is a different job from
 * reading org spend, and sharing a card implied otherwise.
 */

import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { WorkOsWidgets, UsersManagement } from '@workos-inc/widgets'
import '@radix-ui/themes/styles.css'
import {
  Building2,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  FolderKanban,
  Gauge,
  ReceiptEuro,
  SearchX,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { DataToolbar } from '@/components/ui/data-toolbar'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard } from '@/components/ui/stat-card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SectionCard } from '@/features/platform/components/section-card'
import { makeWidgetTokenFetcher } from '@/lib/workos/widget-token'
import { useResolvedAppearance, widgetTheme } from '@/lib/workos/use-widget-appearance'
import { useLocale, useTranslations } from '@/i18n'
import { formatEur as eur } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AuditLogButton } from '@/components/audit/audit-log-button'
import { SpendTrendChart, type SpendTrendPoint } from '@/components/charts/spend-trend-chart'

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
  dailyTrend: SpendTrendPoint[]
  totals: { organizations: number; projects: number; dayUsd: number; monthUsd: number; monthEvents: number }
  eurPerUsd: number
}

const PAGE_SIZE = 10

type SortKey = 'name' | 'projects' | 'day' | 'month' | 'created'
type SortDirection = 'asc' | 'desc'

/**
 * Where each column starts when it is first clicked. Money and counts are
 * interesting at the top end, names and dates at the natural reading end.
 */
const INITIAL_DIRECTION: Record<SortKey, SortDirection> = {
  name: 'asc',
  projects: 'desc',
  day: 'desc',
  month: 'desc',
  created: 'desc',
}

const compareBy = (
  a: PlatformOrganizationDto,
  b: PlatformOrganizationDto,
  key: SortKey,
  locale: string,
): number => {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, locale)
    case 'projects':
      return a.projectCount - b.projectCount
    case 'day':
      return a.dayUsd - b.dayUsd
    case 'month':
      return a.monthUsd - b.monthUsd
    case 'created':
      return Date.parse(a.createdAt) - Date.parse(b.createdAt)
  }
}

const SortableHead: FC<{
  label: string
  ariaLabel: string
  active: boolean
  direction: SortDirection
  onSort: () => void
  className?: string
}> = ({ label, ariaLabel, active, direction, onSort, className }) => {
  const Icon = active ? (direction === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown
  return (
    <TableHead className={className} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={onSort}
        aria-label={ariaLabel}
        className={cn(
          // A column header is text-height by design; `touch-target` makes it
          // tappable without turning the header row into a row of buttons.
          'inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 touch-target',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon className={cn('size-3', !active && 'opacity-50')} aria-hidden />
      </button>
    </TableHead>
  )
}

export const PlatformOverview: FC = () => {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const appearance = useResolvedAppearance()
  const [overview, setOverview] = useState<OverviewDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  // Mirrors the backend's own ordering, so the first render matches what the
  // service already sorted for us.
  const [sortKey, setSortKey] = useState<SortKey>('month')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    fetch('/api/platform/overview')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        setOverview((await res.json()) as OverviewDto)
      })
      .catch(() => {
        setError(true)
        toast.error(t('loadError'))
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const organizations = overview?.organizations
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = (organizations ?? []).filter((org) => org.name.toLowerCase().includes(needle))
    return rows.sort((a, b) => {
      const ordered = compareBy(a, b, sortKey, locale) * (sortDirection === 'asc' ? 1 : -1)
      // Equal spend is common (zero), so fall back to a stable, readable order
      // instead of whatever the array happened to hold.
      return ordered || a.name.localeCompare(b.name, locale)
    })
  }, [organizations, query, sortKey, sortDirection, locale])

  const sortOn = (key: SortKey): void => {
    setSortDirection(key === sortKey ? (sortDirection === 'asc' ? 'desc' : 'asc') : INITIAL_DIRECTION[key])
    setSortKey(key)
    // Re-ordering under a reader parked on page three would show them rows they
    // never asked for; start the new order at its top.
    setOffset(0)
  }

  // Failed and nothing to show — one inline, retryable error instead of a
  // skeleton that would otherwise spin forever.
  if (error && !overview) {
    return (
      <SectionCard
        title={t('sections.overview.title')}
        description={t('loadErrorHint')}
        error
        errorMessage={t('loadError')}
        onRetry={load}
        loading={loading}
        testId="platform-overview-error"
      />
    )
  }

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
  // Search and sort reset the offset, but a reload does not: if a retry returns
  // fewer organizations than the reader's current page starts at, the offset
  // points past the end and the table renders empty instead of falling back to
  // page one. Clamp on read.
  const safeOffset = offset < visible.length ? offset : 0
  const page = visible.slice(safeOffset, safeOffset + PAGE_SIZE)

  const sortableColumn = (key: SortKey, label: string, className?: string): JSX.Element => (
    <SortableHead
      label={label}
      ariaLabel={t('overview.sortBy', { column: label })}
      active={sortKey === key}
      direction={sortDirection}
      onSort={() => sortOn(key)}
      className={className}
    />
  )

  return (
    <TooltipProvider delayDuration={100}>
      <div className="flex flex-col gap-6">
        {/* Headline stats */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={<Building2 className="size-4" aria-hidden />}
            label={t('stats.organizations')}
            value={totals.organizations}
            // A bare "100+" reads as a typo. Say what actually happened: the
            // directory stopped at a page boundary and more organizations exist.
            hint={
              overview.organizationsCapped
                ? t('overview.cappedTile', { count: totals.organizations })
                : undefined
            }
          />
          <StatCard
            icon={<FolderKanban className="size-4" aria-hidden />}
            label={t('stats.projects')}
            value={totals.projects}
          />
          <StatCard
            icon={<Gauge className="size-4" aria-hidden />}
            label={t('stats.spendToday')}
            value={eur(totals.dayUsd * overview.eurPerUsd, locale)}
          />
          <StatCard
            icon={<ReceiptEuro className="size-4" aria-hidden />}
            label={t('stats.spendMonth')}
            value={
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default">{eur(totals.monthUsd * overview.eurPerUsd, locale)}</span>
                </TooltipTrigger>
                <TooltipContent>{t('stats.requestsMonth', { count: totals.monthEvents })}</TooltipContent>
              </Tooltip>
            }
          />
        </div>

        {/* 30-day platform-wide spend trend */}
        <SectionCard title={t('trend.title')} description={t('trend.description')} testId="platform-trend">
          <SpendTrendChart
            points={overview.dailyTrend ?? []}
            eurPerUsd={overview.eurPerUsd}
            requestsLabel={(count) => t('trend.requests', { count })}
            emptyLabel={t('trend.empty')}
          />
        </SectionCard>

        {/* Organization directory */}
        <SectionCard
          title={t('orgs.title')}
          description={t('orgs.description')}
          testId="platform-organizations"
          empty={overview.organizations.length === 0}
          emptyIcon={Building2}
          emptyTitle={t('orgs.empty')}
          emptyDescription={t('overview.emptyHint')}
        >
          <div className="flex flex-col gap-3">
            <DataToolbar
              searchValue={query}
              onSearchChange={(value) => {
                setQuery(value)
                setOffset(0)
              }}
              searchPlaceholder={t('overview.search')}
              searchLabel={t('overview.searchLabel')}
              clearLabel={t('overview.searchClear')}
            />

            {visible.length === 0 ? (
              <EmptyState
                variant="bare"
                icon={SearchX}
                title={t('overview.noMatches')}
                description={t('overview.noMatchesHint')}
              />
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {sortableColumn('name', t('orgs.colOrganization'))}
                      {sortableColumn('projects', t('orgs.colProjects'), 'text-right')}
                      {sortableColumn('day', t('orgs.colToday'), 'text-right')}
                      {sortableColumn('month', t('orgs.colMonth'), 'text-right')}
                      {sortableColumn('created', t('orgs.colCreated'), 'text-right')}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.map((org) => (
                      <TableRow key={org.id}>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{org.name}</span>
                            {org.isPlatformOrg ? (
                              <Badge variant="secondary" className="shrink-0">
                                {t('orgs.platformBadge')}
                              </Badge>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                          {org.projectCount}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          {eur(org.dayUsd * overview.eurPerUsd, locale)}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          {eur(org.monthUsd * overview.eurPerUsd, locale)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
                          {new Date(org.createdAt).toLocaleDateString(locale)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <Pagination
              offset={safeOffset}
              pageSize={PAGE_SIZE}
              total={visible.length}
              onOffsetChange={setOffset}
              rangeLabel={(from, to, total) => t('overview.range', { from, to, total })}
              previousLabel={t('overview.previous')}
              nextLabel={t('overview.next')}
            />

            {overview.organizationsCapped ? (
              <p className="text-xs text-muted-foreground">
                {t('overview.cappedNote', { count: totals.organizations })}
              </p>
            ) : null}
          </div>
        </SectionCard>

        {/* Platform team — WorkOS widget scoped to the GRID Platform org */}
        <SectionCard
          title={t('team.title')}
          description={t('team.description')}
          testId="platform-team"
          action={
            /* Platform trail: break-glass + platform-org admin events. */
            <AuditLogButton
              endpoint="/api/platform/audit-portal"
              label={t('team.auditLogs')}
              errorMessage={t('team.auditError')}
            />
          }
        >
          <WorkOsWidgets theme={widgetTheme(appearance)}>
            <UsersManagement authToken={makeWidgetTokenFetcher(['widgets:users-table:manage'], 'platform')} />
          </WorkOsWidgets>
        </SectionCard>
      </div>
    </TooltipProvider>
  )
}
