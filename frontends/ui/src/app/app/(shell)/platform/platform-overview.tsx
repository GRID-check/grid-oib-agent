'use client'

/**
 * Platform owner's cross-organization overview (ADR-0016), in reading order:
 * the headline figures, the 30-day cost trend, the organization directory with
 * per-org cost and revenue from the usage ledger, the price list (ADR-0053),
 * and the WorkOS Users Management widget scoped to the GRID Platform
 * organization.
 *
 * Money here is USD as OpenRouter charges it — cost — and what the tenants are
 * charged for it at the price list — revenue. No currency conversion anywhere:
 * a hand-set rate is nobody's actual charge. The tenants themselves never see
 * either figure; their surfaces are in credits.
 *
 * Loading has two shapes. The FIRST load has nothing to show and draws
 * skeletons shaped like the page. Every later load (a retry, or the reload the
 * price list asks for after a save) keeps the figures on screen: swapping the
 * tree for skeletons unmounted the price-list card in the middle of its own
 * save. A reload that fails says so above the figures, because silently keeping
 * them would present stale numbers as current.
 *
 * The headline row and the directory size themselves by their CONTAINER, not the
 * viewport: inside the platform shell the content column sits beside a rail and
 * is far narrower than the window, so a viewport breakpoint put five tiles into
 * 720px and a seven-column table into a card that could hold five.
 */

import type { JSX, ReactNode } from 'react'
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorkOsWidgets, UsersManagement } from '@workos-inc/widgets'
// The WorkOS widgets are Radix Themes components and render unstyled without
// this sheet. It is not a global restyle: every rule in it is scoped to
// `.radix-themes` / `.rt-*` / `[data-radius]`, and what it puts on `:root` is
// Radix's own `--gray-1`…`--yellow-12` scales, which no token or class of ours
// reads. Checked against the installed sheet before keeping the import here.
import '@radix-ui/themes/styles.css'
import { AlertTriangle, Building2, RefreshCw, SearchX } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataToolbar } from '@/components/ui/data-toolbar'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard, StatCardSkeleton } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SectionCard } from '@/features/platform/components/section-card'
import { usePlatformCan } from '@/features/platform/platform-access'
import { makeWidgetTokenFetcher } from '@/lib/workos/widget-token'
import { useResolvedAppearance, widgetTheme } from '@/lib/workos/use-widget-appearance'
import { useLocale, useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { formatCount, formatDate, formatUsd as usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AuditLogButton } from '@/components/audit/audit-log-button'
import { SpendTrendChart } from '@/components/charts/spend-trend-chart'
import { PlatformPricingCard } from './platform-pricing-card'
import { PlatformOrgBudgetDialog } from './platform-org-budget-dialog'
import { SortableHead, type SortDirection } from './sortable-head'

interface SpendWindowDto {
  /** USD as OpenRouter charged it, whoever's key it was. */
  costUsd: number
  /** The share billed to a tenant's own key — not the platform's cost. */
  ownKeyCostUsd: number
  priceUsd: number
  credits: number
  tokens: number
  events: number
  /** Of the platform's cost, what document ingestion spent: VLM, OCR, embeddings. */
  ingestCostUsd?: number
  /** Of the platform's cost, what voice dictation spent. Never billed to anyone. */
  dictationCostUsd?: number
}

/** What OpenRouter charged the PLATFORM: everything that was not a tenant's own key. */
const platformCost = (spend: SpendWindowDto): number => spend.costUsd - spend.ownKeyCostUsd

interface PlatformOrganizationDto {
  id: string
  name: string
  createdAt: string
  isPlatformOrg: boolean
  projectCount: number
  day: SpendWindowDto
  month: SpendWindowDto
}

interface OverviewDto {
  organizations: PlatformOrganizationDto[]
  organizationsCapped: boolean
  dailyTrend: Array<{ day: string } & SpendWindowDto>
  totals: { organizations: number; projects: number; day: SpendWindowDto; month: SpendWindowDto }
  pricing: { marginMultiplier: number; usdPerCredit: number; explicit: boolean }
}

const PAGE_SIZE = 10

type SortKey = 'name' | 'projects' | 'day' | 'month' | 'revenue' | 'created'

/**
 * Where each column starts when it is first clicked. Money and counts are
 * interesting at the top end, names and dates at the natural reading end.
 */
const INITIAL_DIRECTION: Record<SortKey, SortDirection> = {
  name: 'asc',
  projects: 'desc',
  day: 'desc',
  month: 'desc',
  revenue: 'desc',
  created: 'desc',
}

const compareBy = (
  a: PlatformOrganizationDto,
  b: PlatformOrganizationDto,
  key: SortKey,
  locale: string
): number => {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, locale)
    case 'projects':
      return a.projectCount - b.projectCount
    case 'day':
      return platformCost(a.day) - platformCost(b.day)
    case 'month':
      return platformCost(a.month) - platformCost(b.month)
    case 'revenue':
      return a.month.priceUsd - b.month.priceUsd
    case 'created':
      return Date.parse(a.createdAt) - Date.parse(b.createdAt)
  }
}

/** Joins the optional parts of a hint, or nothing at all when none apply. */
const joinHint = (parts: Array<string | undefined>): string | undefined =>
  parts.filter(Boolean).join(' · ') || undefined

/**
 * Columns the directory drops as its container narrows, widest first, so the
 * comparison a reader came for (cost and revenue this month) survives to the
 * phone: below `@lg` revenue moves under the month's cost and the allowance
 * action under the name, so the table fits without scrolling.
 */
const COLUMN_VISIBILITY = {
  day: 'hidden @lg:table-cell',
  revenue: 'hidden @lg:table-cell',
  allowance: 'hidden @lg:table-cell',
  projects: 'hidden @3xl:table-cell',
  created: 'hidden @4xl:table-cell',
} as const

export const PlatformOverview: FC = () => {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const appearance = useResolvedAppearance()
  const [overview, setOverview] = useState<OverviewDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const request = useRef(0)

  const load = useCallback(async () => {
    // Only the newest request may write: a slow first load must not land on
    // top of the reload a save asked for after it.
    const id = ++request.current
    setLoading(true)
    try {
      const res = await fetch('/api/platform/overview')
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as OverviewDto
      if (id !== request.current) return
      setOverview(body)
      setError(false)
    } catch {
      if (id === request.current) setError(true)
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const retry = (): void => void load()

  // Failed with nothing to show: one retryable error, never a skeleton that
  // spins forever, and never titled with the page's own name.
  if (!overview && error) {
    return (
      <LoadErrorAlert
        title={t('loadError')}
        hint={t('loadErrorHint')}
        onRetry={retry}
        retrying={loading}
      />
    )
  }

  if (!overview) {
    return <OverviewSkeleton />
  }

  const refreshing = loading

  return (
    <TooltipProvider delayDuration={100}>
      <div
        className="flex flex-col gap-6"
        data-testid="platform-overview"
        aria-busy={refreshing || undefined}
      >
        {error ? (
          <LoadErrorAlert
            title={t('overview.refreshError')}
            onRetry={retry}
            retrying={loading}
            testId="platform-overview-stale"
          />
        ) : null}

        <HeadlineFigures overview={overview} refreshing={refreshing} />

        <SectionCard
          title={t('trend.title')}
          description={t('trend.description')}
          testId="platform-trend"
        >
          <SpendTrendChart
            points={(overview.dailyTrend ?? []).map((point) => ({
              day: point.day,
              value: platformCost(point),
              events: point.events,
            }))}
            formatValue={(value) => usd(value, locale)}
            requestsLabel={(count) => t('trend.requests', { count })}
            emptyLabel={t('trend.empty')}
          />
        </SectionCard>

        <OrganizationDirectory overview={overview} />

        {/* The price list. A save changes what the revenue figures above mean
            from the next request on, so the overview reloads them, in place. */}
        <PlatformPricingCard onSaved={retry} />

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
            <UsersManagement
              authToken={makeWidgetTokenFetcher(['widgets:users-table:manage'], 'platform')}
            />
          </WorkOsWidgets>
        </SectionCard>
      </div>
    </TooltipProvider>
  )
}

const LoadErrorAlert: FC<{
  title: string
  hint?: string
  onRetry: () => void
  retrying: boolean
  testId?: string
}> = ({ title, hint, onRetry, retrying, testId }) => {
  const t = useTranslations('platform')
  return (
    <Alert variant="destructive" data-testid={testId}>
      <AlertTriangle aria-hidden />
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      <AlertDescription>
        {hint ? <p>{hint}</p> : null}
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry} disabled={retrying}>
          <RefreshCw
            className={cn('size-3.5', retrying && 'animate-spin motion-reduce:animate-none')}
            aria-hidden
          />
          {t('retry')}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/**
 * Six tracks so the row divides cleanly at every width: two counts and three
 * amounts read as 2 + 2 + 1 (the last spanning) on a phone, 2 + 3 in a
 * mid-width column, and one row of five once the container has room.
 */
const KPI_GRID = 'grid grid-cols-2 gap-3 @lg:grid-cols-6 @4xl:grid-cols-5'
const KPI_COUNT = '@lg:col-span-3 @4xl:col-span-1'
const KPI_AMOUNT = '@lg:col-span-2 @4xl:col-span-1'

const OverviewSkeleton: FC = () => (
  <div className="flex flex-col gap-6" data-testid="platform-overview-loading" aria-busy>
    <div className="@container">
      <div className={KPI_GRID}>
        <StatCardSkeleton className={KPI_COUNT} />
        <StatCardSkeleton className={KPI_COUNT} />
        <StatCardSkeleton className={KPI_AMOUNT} />
        <StatCardSkeleton className={KPI_AMOUNT} />
        <StatCardSkeleton className={cn(KPI_AMOUNT, 'col-span-2')} />
      </div>
    </div>
    <Skeleton className="h-56 w-full rounded-lg" />
    <Skeleton className="h-96 w-full rounded-lg" />
  </div>
)

/** A figure never wraps: a tile that cannot hold it truncates, it does not break. */
const Figure: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="block truncate whitespace-nowrap">{children}</span>
)

const HeadlineFigures: FC<{ overview: OverviewDto; refreshing: boolean }> = ({
  overview,
  refreshing,
}) => {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const { totals } = overview
  const monthMargin = totals.month.priceUsd - platformCost(totals.month)

  // Ingestion and voice dictation are part of the cost, not on top of it: say
  // how much of it each was.
  const shareHint = (spend: SpendWindowDto): string | undefined =>
    joinHint([
      (spend.ingestCostUsd ?? 0) > 0
        ? t('stats.ingestShare', { amount: usd(spend.ingestCostUsd ?? 0, locale) })
        : undefined,
      (spend.dictationCostUsd ?? 0) > 0
        ? t('stats.dictationShare', { amount: usd(spend.dictationCostUsd ?? 0, locale) })
        : undefined,
    ])

  return (
    <div className="@container">
      <div
        className={cn(KPI_GRID, refreshing && 'duration-base opacity-70 transition-opacity')}
        data-testid="platform-kpis"
      >
        <StatCard
          className={KPI_COUNT}
          label={t('stats.organizations')}
          value={<Figure>{formatCount(totals.organizations, locale)}</Figure>}
          // A bare "100+" reads as a typo. Say what actually happened: the
          // directory stopped at a page boundary and more organizations exist.
          hint={
            overview.organizationsCapped
              ? t('overview.cappedTile', { count: totals.organizations })
              : undefined
          }
        />
        <StatCard
          className={KPI_COUNT}
          label={t('stats.projects')}
          value={<Figure>{formatCount(totals.projects, locale)}</Figure>}
        />
        <StatCard
          className={KPI_AMOUNT}
          label={t('stats.costToday')}
          value={<Figure>{usd(platformCost(totals.day), locale)}</Figure>}
          hint={shareHint(totals.day)}
        />
        <StatCard
          className={KPI_AMOUNT}
          label={t('stats.costMonth')}
          value={<Figure>{usd(platformCost(totals.month), locale)}</Figure>}
          // The request count is in the hint, not a tooltip: a tooltip cannot be
          // reached on touch. Cost on tenants' own keys is theirs; say it was left out.
          hint={joinHint([
            t('stats.requestsMonth', {
              count: totals.month.events,
              formatted: formatCount(totals.month.events, locale),
            }),
            shareHint(totals.month),
            totals.month.ownKeyCostUsd > 0
              ? t('stats.ownKeyExcluded', { amount: usd(totals.month.ownKeyCostUsd, locale) })
              : undefined,
          ])}
        />
        <StatCard
          className={cn(KPI_AMOUNT, 'col-span-2')}
          label={t('stats.revenueMonth')}
          value={<Figure>{usd(totals.month.priceUsd, locale)}</Figure>}
          // Revenue minus cost, in the same unit, is the number a price list
          // exists for. Under revenue rather than its own tile: it is derived.
          hint={t('stats.marginHint', { margin: usd(monthMargin, locale) })}
        />
      </div>
    </div>
  )
}

const OrganizationDirectory: FC<{ overview: OverviewDto }> = ({ overview }) => {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const canManageOrganizations = usePlatformCan(PLATFORM_PERMISSIONS.organizationsManage)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [budgetOrganization, setBudgetOrganization] = useState<PlatformOrganizationDto | null>(null)
  // Mirrors the backend's own ordering, so the first render matches what the
  // service already sorted for us.
  const [sortKey, setSortKey] = useState<SortKey>('revenue')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const { organizations } = overview
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = organizations.filter((org) => org.name.toLowerCase().includes(needle))
    return rows.sort((a, b) => {
      const ordered = compareBy(a, b, sortKey, locale) * (sortDirection === 'asc' ? 1 : -1)
      // Equal spend is common (zero), so fall back to a stable, readable order.
      return ordered || a.name.localeCompare(b.name, locale)
    })
  }, [organizations, query, sortKey, sortDirection, locale])

  const sortOn = (key: SortKey): void => {
    setSortDirection(
      key === sortKey ? (sortDirection === 'asc' ? 'desc' : 'asc') : INITIAL_DIRECTION[key]
    )
    setSortKey(key)
    // Re-ordering under a reader parked on page three would show them rows they
    // never asked for; start the new order at its top.
    setOffset(0)
  }

  // Search and sort reset the offset, but a reload does not: clamp on read so a
  // reload that returns fewer rows falls back to page one instead of nothing.
  const safeOffset = offset < visible.length ? offset : 0
  const page = visible.slice(safeOffset, safeOffset + PAGE_SIZE)

  const column = (key: SortKey, label: string, className?: string): JSX.Element => (
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
    <SectionCard
      title={t('orgs.title')}
      description={t('orgs.description')}
      testId="platform-organizations"
      empty={organizations.length === 0}
      emptyIcon={Building2}
      emptyTitle={t('orgs.empty')}
      emptyDescription={t('overview.emptyHint')}
    >
      {budgetOrganization ? (
        <PlatformOrgBudgetDialog
          key={budgetOrganization.id}
          organization={budgetOrganization}
          onClose={() => setBudgetOrganization(null)}
        />
      ) : null}
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
            description={
              overview.organizationsCapped
                ? t('overview.cappedNoMatchHint', { count: overview.totals.organizations })
                : t('overview.noMatchesHint')
            }
          />
        ) : (
          <div className="@container rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {column('name', t('orgs.colOrganization'), 'w-full')}
                  {column(
                    'projects',
                    t('orgs.colProjects'),
                    cn('text-right', COLUMN_VISIBILITY.projects)
                  )}
                  {column('day', t('orgs.colToday'), cn('text-right', COLUMN_VISIBILITY.day))}
                  {column('month', t('orgs.colMonth'), 'text-right')}
                  {column(
                    'revenue',
                    t('orgs.colRevenue'),
                    cn('text-right', COLUMN_VISIBILITY.revenue)
                  )}
                  {column(
                    'created',
                    t('orgs.colCreated'),
                    cn('text-right', COLUMN_VISIBILITY.created)
                  )}
                  <TableHead className={cn('text-right', COLUMN_VISIBILITY.allowance)}>
                    {t('orgBudgets.column')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.map((org) => (
                  <OrganizationRow
                    key={org.id}
                    org={org}
                    canManage={canManageOrganizations}
                    onOpenBudget={() => setBudgetOrganization(org)}
                  />
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
      </div>
    </SectionCard>
  )
}

const OrganizationRow: FC<{
  org: PlatformOrganizationDto
  canManage: boolean
  onOpenBudget: () => void
}> = ({ org, canManage, onOpenBudget }) => {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const ingest = org.month.ingestCostUsd ?? 0

  return (
    <TableRow>
      {/* `w-full max-w-0` gives the name whatever the numbers leave and
          truncates it there, instead of letting it push them off the card. */}
      <TableCell className="w-full max-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{org.name}</span>
          {org.isPlatformOrg ? (
            <Badge variant="secondary" className="shrink-0">
              {t('orgs.platformBadge')}
            </Badge>
          ) : null}
          {/* Usage on the organization's own key this month: its cost column
              is what it paid its provider, and it is billed nothing here. */}
          {org.month.ownKeyCostUsd > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="shrink-0 cursor-default" tabIndex={0}>
                  {t('orgs.ownKeyBadge')}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {t('orgs.ownKeyHint', { amount: usd(org.month.ownKeyCostUsd, locale) })}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
        {/* Narrow: the allowance action sits under the name instead of in a
            column of its own. */}
        <Button
          variant="link"
          size="sm"
          className="touch-target text-muted-foreground @lg:hidden h-auto p-0 text-xs underline decoration-dotted"
          onClick={onOpenBudget}
          aria-label={t(canManage ? 'orgBudgets.openEdit' : 'orgBudgets.open', { name: org.name })}
        >
          {t('orgBudgets.column')}
        </Button>
      </TableCell>
      <TableCell
        className={cn(
          'text-muted-foreground text-right text-sm tabular-nums',
          COLUMN_VISIBILITY.projects
        )}
      >
        {formatCount(org.projectCount, locale)}
      </TableCell>
      <TableCell
        className={cn('whitespace-nowrap text-right text-sm tabular-nums', COLUMN_VISIBILITY.day)}
      >
        {usd(platformCost(org.day), locale)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right text-sm tabular-nums">
        {usd(platformCost(org.month), locale)}
        {/* Ingestion is part of the month's cost; shown under it rather than
            as a column of its own, where it was mostly zeros. */}
        {ingest > 0 ? (
          <span className="text-muted-foreground @lg:block hidden text-xs">
            {t('stats.ingestShare', { amount: usd(ingest, locale) })}
          </span>
        ) : null}
        <span className="text-muted-foreground @lg:hidden block text-xs">
          {t('orgs.revenueShort', { amount: usd(org.month.priceUsd, locale) })}
        </span>
      </TableCell>
      <TableCell
        className={cn(
          'whitespace-nowrap text-right text-sm tabular-nums',
          COLUMN_VISIBILITY.revenue
        )}
      >
        {usd(org.month.priceUsd, locale)}
      </TableCell>
      <TableCell
        className={cn(
          'text-muted-foreground whitespace-nowrap text-right text-sm tabular-nums',
          COLUMN_VISIBILITY.created
        )}
      >
        {formatDate(org.createdAt, locale)}
      </TableCell>
      <TableCell className={cn('text-right', COLUMN_VISIBILITY.allowance)}>
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenBudget}
          aria-label={t(canManage ? 'orgBudgets.openEdit' : 'orgBudgets.open', { name: org.name })}
        >
          {t(canManage ? 'orgBudgets.edit' : 'orgBudgets.view')}
        </Button>
      </TableCell>
    </TableRow>
  )
}
