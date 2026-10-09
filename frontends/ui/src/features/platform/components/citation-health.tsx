'use client'

/**
 * Citation health (platform staff): how often citation verification had to
 * intervene, what it caught, why, on which retrieval lanes, for which
 * organizations. Backed by the `citation_events` ledger
 * (src/aiq_agent/common/citation_events.py, the quality sibling of the timing
 * ledger behind `agent-profiler.tsx`).
 *
 * One tab of Platform → Answer quality. The page owns the title and the scope
 * (date range, organizations, projects) and passes `scope` in; this organism
 * fetches in it, refetches when it changes, and owns everything below, top to
 * bottom in reading order:
 *
 * 1. the four headline tiles, clean rate first;
 * 2. "What to do": the findings as compact rows, the remedy one click away;
 * 3. the stacked daily trend;
 * 4. "Sources to add": the specific sources answers cited and could not prove;
 * 5. why citations were dropped, and the retrieval lanes in play;
 * 6. per-organization rates, sortable;
 * 7. the newest flagged turns, each linking into the timing view.
 *
 * Every section is its own card on the page, never a card inside a card: the
 * previous version stacked six of them inside one giant card and read as a
 * wall of text.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CircleSlash,
  Download,
  FileSearch,
  FileWarning,
  Info,
  Plus,
  Quote,
  RefreshCw,
  SearchX,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Timer,
  type LucideIcon,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  StatCard,
  StatCardIcon,
  StatCardSkeleton,
  type StatCardIconTone,
} from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CitationDefectChart } from '@/components/charts/citation-defect-chart'
import { SeriesPaletteStyle } from '@/components/charts/palette'
import { usePlatformCan } from '@/features/platform/platform-access'
import { useLocale, useTranslations } from '@/i18n'
import { qualityScopeQuery, readQualityScope, type QualityScope } from '@/lib/quality/scope'
import { useQualityScopeLabel } from './quality-scope-label'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CopyableId } from './copyable-id'

/**
 * Defect kinds in FIXED order. This drives the chart's palette slots, so a
 * kind keeps its identity when another disappears from the window. Keep in
 * sync with `CITATION_DEFECT_KINDS` (lib/citations/service).
 */
const DEFECT_KINDS = [
  'answer_ungrounded',
  'citations_removed',
  'quote_unverified',
  'registry_empty',
  'citation_fallback',
  'confidence_capped',
] as const
type DefectKind = (typeof DEFECT_KINDS)[number]

type Severity = 'ok' | 'info' | 'warn' | 'error'

interface KindTotalDto {
  kind: DefectKind
  turns: number
  items: number
  share: number
}

interface DailyPointDto {
  day: string
  turns: number
  defectTurns: number
  byKind: Record<string, number>
}

interface ReasonDto {
  kind: DefectKind
  reason: string
  occurrences: number
  share: number
}

interface SourceMixDto {
  dimension: 'origin' | 'lane' | 'tool'
  label: string
  turns: number
}

interface OrganizationDto {
  organizationId: string | null
  name: string | null
  turns: number
  defectTurns: number
  errorTurns: number
  defectRate: number
}

interface DefectSampleDto {
  id: string
  createdAt: string
  kind: DefectKind
  severity: Severity
  agent: 'shallow' | 'deep'
  count: number
  reasons: Record<string, number> | null
  organizationId: string | null
  conversationId: string | null
  turnId: string
}

type FindingId =
  | 'retrieval_unavailable'
  | 'answers_ungrounded'
  | 'citations_invented'
  | 'quotes_fabricated'
  | 'citation_format_unparsed'
  | 'duplicates_only'
  | 'organization_outlier'
  | 'sources_missing'
  | 'sources_unretrievable'
  | 'all_clear'

type FindingSeverity = 'error' | 'warn' | 'info'

interface FindingDto {
  id: FindingId
  severity: FindingSeverity
  subject: { type: 'organization' | 'tool'; label: string } | null
  metrics: Record<string, number>
}

type MissingSourceAction =
  | 'add_to_norm_catalog'
  | 'upload_to_base_knowledge'
  | 'investigate_retrieval'
  | 'inventory_unknown'
  | 'none'

interface MissingSourceDto {
  target: string
  kind: 'document' | 'ris' | 'web'
  reason: string
  turns: number
  organizations: number
  lastSeenAt: string
  /** Null when the inventory this source depends on could not be read. */
  present: boolean | null
  action: MissingSourceAction
  fileName: string | null
  documentNumber: string | null
}

interface SnapshotDto {
  /** The scope the server read; absent on servers that predate it. */
  scope?: QualityScope
  windowDays: number
  totals: {
    turns: number
    defectTurns: number
    cleanTurns: number
    cleanRate: number
    citationsRemoved: number
    unverifiedQuotes: number
    ungroundedAnswers: number
    emptyRegistries: number
  }
  findings: FindingDto[]
  byKind: KindTotalDto[]
  dailyTrend: DailyPointDto[]
  reasons: ReasonDto[]
  sourceMix: SourceMixDto[]
  unavailableTools: { tool: string; turns: number }[]
  missingSources: MissingSourceDto[]
  /**
   * False when the platform inventory (base corpus + norm catalog) could not be
   * read, so "held / not held" is unknown. Absent on older servers: treated as
   * known.
   */
  inventoryKnown?: boolean
  /** Distinct rejected sources in the window; `missingSources` lists the first few. */
  missingSourcesTotal?: number
  organizations: OrganizationDto[]
  /** Organizations with any turn in the window; `organizations` lists the first few. */
  organizationsTotal?: number
  recent: DefectSampleDto[]
}

/**
 * Where each remedy lives. The managers own their add flows (upload
 * validation, RIS verification, audit trail); linking to them with the
 * candidate copied beats duplicating, or bypassing, those checks.
 */
const ACTION_ANCHOR: Partial<Record<MissingSourceAction, string>> = {
  upload_to_base_knowledge: '/app/platform/knowledge',
  add_to_norm_catalog: '/app/platform/norms',
}

/** The timing tab of Platform → Answer quality, preselecting one conversation. */
/** The runtime view of one conversation, in the same scope, so the tab switch keeps the filter. */
const timingHref = (conversationId: string, scopeQuery: string): string =>
  `/app/platform/quality?view=timing&${scopeQuery}&conversation=${encodeURIComponent(conversationId)}`

/** Finding metrics the server sends as fractions (0–1), rendered as percentages. */
const FRACTION_METRICS = new Set(['share', 'platformShare'])

/** How many findings show before "Show N more". */
const FINDINGS_VISIBLE = 3

/** Findings whose remedy names an entity, and so need a subject-less variant. */
const FINDINGS_WITH_SUBJECT_FALLBACK = new Set<FindingId>([
  'retrieval_unavailable',
  'answers_ungrounded',
])

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 }

/** Severity → icon + well tone. The icon shape differs per step, so severity is never color-alone. */
const FINDING_STYLE: Record<FindingSeverity, { icon: LucideIcon; tone: StatCardIconTone }> = {
  error: { icon: AlertTriangle, tone: 'destructive' },
  warn: { icon: AlertCircle, tone: 'warning' },
  info: { icon: Info, tone: 'muted' },
}

/** A recent finding's badge: icon + label, the tint only repeating them. */
const SEVERITY_BADGE: Record<
  Severity,
  { icon: LucideIcon; variant: 'outline' | 'warning' | 'success'; className?: string }
> = {
  error: {
    icon: AlertTriangle,
    variant: 'outline',
    className: 'border-danger bg-danger-subtle text-error',
  },
  warn: { icon: AlertCircle, variant: 'warning' },
  info: { icon: Info, variant: 'outline', className: 'text-muted-foreground' },
  ok: { icon: CheckCircle2, variant: 'success' },
}

/** The clean rate is the one number to read first: tone and icon say how bad it is. */
function cleanRateTone(rate: number): { className: string; icon: LucideIcon } {
  if (rate >= 0.95) return { className: 'text-success', icon: ShieldCheck }
  if (rate >= 0.8) return { className: 'text-warning', icon: ShieldAlert }
  return { className: 'text-error', icon: ShieldX }
}

function useNumberFormats(locale: string): {
  count: (value: number) => string
  percent: (value: number) => string
  decimal: (value: number) => string
} {
  return useMemo(() => {
    const count = new Intl.NumberFormat(locale)
    const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
    const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
    return {
      count: (value) => count.format(value),
      percent: (value) => percent.format(value),
      decimal: (value) => decimal.format(value),
    }
  }, [locale])
}

/**
 * Relative time, with the absolute UTC moment on hover. The trend buckets by
 * UTC day, so the exact timestamp is stated in UTC too rather than in the
 * viewer's zone, where a late-evening finding would land on another day.
 */
function UtcTime({ iso, locale }: { iso: string; locale: string }): JSX.Element {
  const date = new Date(iso)
  const absolute = Number.isNaN(date.getTime())
    ? iso
    : `${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`
  return (
    <time dateTime={iso} title={absolute} className="whitespace-nowrap tabular-nums">
      {formatRelativeTime(iso, locale)}
    </time>
  )
}

/** Ranked horizontal bars: magnitude by category, recessive track, value at the end. */
function RankedBars({
  rows,
  format,
}: {
  rows: { key: string; label: string; sublabel?: string; value: number }[]
  format: (value: number) => string
}): JSX.Element {
  const max = Math.max(...rows.map((row) => row.value), 1)
  return (
    <ul className="grid-usage-viz flex flex-col gap-3">
      <SeriesPaletteStyle />
      {rows.map((row) => (
        <li key={row.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate" title={row.label}>
              {row.label}
              {row.sublabel ? (
                <span className="text-muted-foreground text-xs"> · {row.sublabel}</span>
              ) : null}
            </span>
            <span className="text-muted-foreground shrink-0 tabular-nums">{format(row.value)}</span>
          </div>
          <div className="bg-muted h-1.5 w-full rounded-full">
            <div
              className="h-1.5 rounded-full"
              style={{
                backgroundColor: 'var(--grid-series-1)',
                width: `${Math.max((row.value / max) * 100, 2)}%`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function SectionHeader({
  title,
  description,
}: {
  title: string
  description?: string
}): JSX.Element {
  return (
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
  )
}

interface FindingCopy {
  title: string
  meaning: string
  action: string
}

function FindingRow({
  finding,
  copy,
  nextStepLabel,
  severityLabel,
}: {
  finding: FindingDto
  copy: FindingCopy
  nextStepLabel: string
  severityLabel: string
}): JSX.Element {
  const style = FINDING_STYLE[finding.severity]
  return (
    <Collapsible asChild>
      <li className="group/finding">
        <CollapsibleTrigger
          className={cn(
            'duration-snap hover:bg-muted/40 flex w-full items-start gap-3 px-6 py-3 text-left transition-colors motion-reduce:transition-none',
            'outline-none',
            FOCUS_RING_INSET
          )}
        >
          <StatCardIcon icon={style.icon} tone={style.tone} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="sr-only">{severityLabel}: </span>
            <span className="block text-sm font-medium">{copy.title}</span>
            <span className="text-muted-foreground mt-0.5 block text-sm group-data-[state=closed]/finding:line-clamp-1">
              {copy.meaning}
            </span>
          </span>
          <ChevronDown
            className="text-muted-foreground duration-base mt-1.5 size-4 shrink-0 transition-transform group-data-[state=open]/finding:rotate-180 motion-reduce:transition-none"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="pb-4 pl-16 pr-6">
          <SectionLabel as="p">{nextStepLabel}</SectionLabel>
          <p className="mt-1 text-pretty text-sm leading-relaxed">{copy.action}</p>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

function FindingsCard({
  findings,
  copyFor,
}: {
  findings: FindingDto[]
  copyFor: (finding: FindingDto) => FindingCopy
}): JSX.Element | null {
  const t = useTranslations('platform')
  const [expanded, setExpanded] = useState(false)
  const sorted = useMemo(
    () =>
      findings
        .filter((finding) => finding.id !== 'all_clear')
        .map((finding, index) => ({ finding, index }))
        .sort(
          (a, b) =>
            SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
            a.index - b.index
        )
        .map(({ finding }) => finding),
    [findings]
  )
  const allClear = findings.find((finding) => finding.id === 'all_clear')

  if (sorted.length === 0 && !allClear) return null

  const visible = expanded ? sorted : sorted.slice(0, FINDINGS_VISIBLE)
  const hidden = sorted.length - FINDINGS_VISIBLE

  return (
    <Card data-testid="citation-findings">
      <SectionHeader
        title={t('citations.findingsTitle')}
        description={t('citations.findingsDescription')}
      />
      <CardContent className="px-0">
        {sorted.length === 0 && allClear ? (
          <div className="flex items-start gap-3 border-t px-6 pt-4" role="status">
            <StatCardIcon icon={CheckCircle2} tone="success" size="sm" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{copyFor(allClear).title}</p>
              <p className="text-muted-foreground mt-0.5 text-sm">{copyFor(allClear).meaning}</p>
            </div>
          </div>
        ) : (
          <>
            <ul className="divide-y border-y">
              {visible.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  copy={copyFor(finding)}
                  nextStepLabel={t('citations.findingsNextStep')}
                  severityLabel={t(`citations.severity.${finding.severity}`)}
                />
              ))}
            </ul>
            {hidden > 0 ? (
              <div className="px-6 pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpanded((value) => !value)}
                  aria-expanded={expanded}
                >
                  <ChevronDown
                    className={cn(
                      'duration-base size-3.5 transition-transform motion-reduce:transition-none',
                      expanded && 'rotate-180'
                    )}
                    aria-hidden
                  />
                  {expanded
                    ? t('citations.findingsLess')
                    : t('citations.findingsMore', { count: hidden })}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}

const MISSING_STATUS_ICON: Record<'absent' | 'present' | 'unknown', LucideIcon> = {
  absent: CircleSlash,
  present: FileSearch,
  unknown: CircleHelp,
}

function MissingSourcesCard({
  sources,
  total,
  inventoryKnown,
  locale,
}: {
  sources: MissingSourceDto[]
  total: number
  inventoryKnown: boolean
  locale: string
}): JSX.Element {
  const t = useTranslations('platform')
  const canManage = usePlatformCan(PLATFORM_PERMISSIONS.settingsManage)
  const { count } = useNumberFormats(locale)

  return (
    <Card data-testid="citation-missing-sources">
      <SectionHeader
        title={t('citations.missingTitle')}
        description={t('citations.missingDescription')}
      />
      <CardContent className="flex flex-col gap-3">
        {inventoryKnown ? null : (
          <Alert variant="warning" role="status">
            <CircleHelp aria-hidden />
            <AlertDescription className="text-current">
              {t('citations.missingInventoryUnknown')}
            </AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-full pl-0">{t('citations.missingColSource')}</TableHead>
              <TableHead className="hidden sm:table-cell">
                {t('citations.missingColKind')}
              </TableHead>
              <TableHead className="hidden text-right md:table-cell">
                {t('citations.missingColCited')}
              </TableHead>
              <TableHead className="hidden lg:table-cell">
                {t('citations.missingColStatus')}
              </TableHead>
              <TableHead className="hidden whitespace-nowrap xl:table-cell">
                {t('citations.missingColLastSeen')}
              </TableHead>
              <TableHead className="pr-0 text-right">
                <span className="sr-only sm:not-sr-only">{t('citations.missingColAction')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((candidate) => {
              const status =
                candidate.present === null ? 'unknown' : candidate.present ? 'present' : 'absent'
              const StatusIcon = MISSING_STATUS_ICON[status]
              const name = candidate.fileName ?? candidate.documentNumber ?? candidate.target
              // Only a source known NOT to be held gets an add: without the
              // inventory, "add" may duplicate one the platform already has.
              const anchor =
                candidate.present === false ? ACTION_ANCHOR[candidate.action] : undefined
              const actionLabel = t(`citations.missingActions.${candidate.action}`)
              const cited = t('citations.missingCited', {
                turns: count(candidate.turns),
                organizations: count(candidate.organizations),
              })
              return (
                <TableRow key={candidate.target}>
                  <TableCell className="max-w-0 pl-0">
                    <p className="truncate font-medium" title={candidate.target}>
                      {name}
                    </p>
                    <p className="text-muted-foreground truncate text-xs" title={candidate.target}>
                      {/* On a phone the hidden columns collapse into this line. */}
                      <span className="sm:hidden">
                        {t(`citations.missingKinds.${candidate.kind}`)} ·{' '}
                      </span>
                      <span className="md:hidden">{cited} · </span>
                      <span className="lg:hidden">{t(`citations.missingStatus.${status}`)}</span>
                      <span className="hidden lg:inline">
                        {name === candidate.target ? '' : candidate.target}
                      </span>
                    </p>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="outline">{t(`citations.missingKinds.${candidate.kind}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden whitespace-nowrap text-right tabular-nums md:table-cell">
                    {cited}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className="text-muted-foreground inline-flex items-center gap-1.5 whitespace-nowrap">
                      <StatusIcon className="size-3.5 shrink-0" aria-hidden />
                      {t(`citations.missingStatus.${status}`)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden xl:table-cell">
                    <UtcTime iso={candidate.lastSeenAt} locale={locale} />
                  </TableCell>
                  <TableCell className="pr-0 text-right">
                    {anchor && canManage ? (
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          // The identifier on the clipboard fills the target
                          // manager's form without retyping a document number.
                          void navigator.clipboard
                            ?.writeText(
                              candidate.documentNumber ?? candidate.fileName ?? candidate.target
                            )
                            .catch(() => undefined)
                        }}
                      >
                        <Link href={anchor} aria-label={actionLabel}>
                          <Plus className="size-3.5" aria-hidden />
                          <span className="hidden sm:inline">{actionLabel}</span>
                        </Link>
                      </Button>
                    ) : anchor ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled
                        aria-label={actionLabel}
                        title={t('citations.missingReadOnly')}
                      >
                        <Plus className="size-3.5" aria-hidden />
                        <span className="hidden sm:inline">{actionLabel}</span>
                      </Button>
                    ) : (
                      <span className="text-muted-foreground whitespace-nowrap text-xs">
                        {actionLabel}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <p className="text-muted-foreground text-pretty text-xs leading-relaxed">
          {total > sources.length
            ? `${t('citations.shownOfTotal', { shown: count(sources.length), total: count(total) })} `
            : null}
          {canManage ? t('citations.missingCaveat') : t('citations.missingReadOnly')}
        </p>
      </CardContent>
    </Card>
  )
}

type OrgSortKey = 'turns' | 'defectTurns' | 'errorTurns' | 'defectRate'

function OrganizationsCard({
  organizations,
  total,
  locale,
}: {
  organizations: OrganizationDto[]
  total: number
  locale: string
}): JSX.Element {
  const t = useTranslations('platform')
  const { count, percent } = useNumberFormats(locale)
  // The server already orders by flagged turns; that is the default view.
  const [sort, setSort] = useState<{ key: OrgSortKey; desc: boolean }>({
    key: 'defectTurns',
    desc: true,
  })

  const rows = useMemo(() => {
    const direction = sort.desc ? -1 : 1
    return [...organizations].sort((a, b) => direction * (a[sort.key] - b[sort.key]))
  }, [organizations, sort])

  const columns: { key: OrgSortKey; label: string; className?: string }[] = [
    { key: 'turns', label: t('citations.colTurns'), className: 'hidden sm:table-cell' },
    { key: 'defectTurns', label: t('citations.colDefects') },
    { key: 'errorTurns', label: t('citations.colErrors'), className: 'hidden sm:table-cell' },
    { key: 'defectRate', label: t('citations.colDefectRate') },
  ]

  const cell = (org: OrganizationDto, key: OrgSortKey): string =>
    key === 'defectRate' ? percent(org.defectRate) : count(org[key])

  return (
    <Card data-testid="citation-organizations">
      <SectionHeader
        title={t('citations.orgsTitle')}
        description={t('citations.orgsDescription')}
      />
      <CardContent>
        {organizations.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('citations.orgsEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-full pl-0">{t('citations.colOrganization')}</TableHead>
                {columns.map((column) => {
                  const active = sort.key === column.key
                  const SortIcon = active && !sort.desc ? ArrowUp : ArrowDown
                  return (
                    <TableHead
                      key={column.key}
                      className={cn('text-right last:pr-0', column.className)}
                      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                    >
                      <button
                        type="button"
                        className={cn(
                          'hover:text-foreground inline-flex items-center gap-1 rounded-sm uppercase tracking-wider outline-none',
                          FOCUS_RING_INSET,
                          active && 'text-foreground'
                        )}
                        onClick={() =>
                          setSort((current) => ({
                            key: column.key,
                            desc: current.key === column.key ? !current.desc : true,
                          }))
                        }
                        aria-label={t('citations.sortBy', { column: column.label })}
                      >
                        {/* Leading, so the label's right edge lines up with the
                            right-aligned figures below it. */}
                        <SortIcon className={cn('size-3', !active && 'opacity-0')} aria-hidden />
                        {column.label}
                      </button>
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((org) => (
                <TableRow key={org.organizationId ?? 'unattributed'}>
                  <TableCell className="max-w-0 truncate pl-0 font-medium">
                    {org.name ?? org.organizationId ?? (
                      <span className="text-muted-foreground font-normal">
                        {t('citations.unattributed')}
                      </span>
                    )}
                  </TableCell>
                  {columns.map((column) => (
                    <TableCell
                      key={column.key}
                      className={cn(
                        'w-20 whitespace-nowrap text-right tabular-nums last:pr-0 sm:w-24',
                        column.className
                      )}
                    >
                      {cell(org, column.key)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {total > organizations.length ? (
          <p className="text-muted-foreground mt-3 text-xs">
            {t('citations.shownOfTotal', {
              shown: count(organizations.length),
              total: count(total),
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function RecentCard({
  recent,
  locale,
  kindLabel,
  reasonLabel,
  scopeQuery,
}: {
  recent: DefectSampleDto[]
  locale: string
  kindLabel: (kind: string) => string
  reasonLabel: (reason: string) => string
  /** The scope as a query string, carried into the runtime view's links. */
  scopeQuery: string
}): JSX.Element {
  const t = useTranslations('platform')
  const { count } = useNumberFormats(locale)

  return (
    <Card data-testid="citation-recent">
      <SectionHeader
        title={t('citations.recentTitle')}
        description={t('citations.recentDescription')}
      />
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('citations.recentEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-0">{t('citations.colFinding')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('citations.colAgent')}</TableHead>
                <TableHead className="hidden text-right md:table-cell">
                  {t('citations.colAffected')}
                </TableHead>
                <TableHead className="hidden lg:table-cell">{t('citations.colReasons')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('citations.colTime')}</TableHead>
                <TableHead className="pr-0">{t('citations.colTurn')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((event) => {
                const badge = SEVERITY_BADGE[event.severity]
                const BadgeIcon = badge.icon
                const reasons = event.reasons
                  ? Object.keys(event.reasons).map(reasonLabel).join(', ')
                  : ''
                return (
                  <TableRow key={event.id}>
                    <TableCell className="pl-0">
                      <Badge variant={badge.variant} className={badge.className}>
                        <BadgeIcon aria-hidden />
                        {kindLabel(event.kind)}
                      </Badge>
                      <p className="text-muted-foreground mt-1 text-xs md:hidden">
                        {t(`citations.agents.${event.agent}`)} ·{' '}
                        {t('citations.itemCount', { count: count(event.count) })}
                        <span className="sm:hidden">
                          {' · '}
                          <UtcTime iso={event.createdAt} locale={locale} />
                        </span>
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden whitespace-nowrap md:table-cell">
                      {t(`citations.agents.${event.agent}`)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">
                      {count(event.count)}
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground hidden max-w-64 truncate lg:table-cell"
                      title={reasons}
                    >
                      {reasons || '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden sm:table-cell">
                      <UtcTime iso={event.createdAt} locale={locale} />
                    </TableCell>
                    <TableCell className="pr-0">
                      <span className="inline-flex items-center">
                        <CopyableId
                          id={event.turnId}
                          copyLabel={t('citations.copyTurnId', { id: event.turnId })}
                          copiedLabel={t('citations.turnIdCopied')}
                          failedLabel={t('citations.copyFailed')}
                          idClassName="hidden sm:inline"
                        />
                        {event.conversationId ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                asChild
                                variant="ghost"
                                size="icon"
                                className="text-muted-foreground pointer-coarse:size-9 size-7"
                              >
                                <Link
                                  href={timingHref(event.conversationId, scopeQuery)}
                                  aria-label={t('citations.openTiming')}
                                >
                                  <Timer className="size-3.5" aria-hidden />
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t('citations.openTiming')}</TooltipContent>
                          </Tooltip>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function LoadingState(): JSX.Element {
  return (
    <div className="flex flex-col gap-4" data-testid="citation-health-loading" aria-busy>
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-2/3" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex items-start gap-3">
              <Skeleton className="size-7 shrink-0 rounded-lg" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-28" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-28 w-full" />
        </CardContent>
      </Card>
    </div>
  )
}

export function CitationHealth({ scope }: { scope: QualityScope }): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const { count, percent, decimal } = useNumberFormats(locale)
  const scopeLabel = useQualityScopeLabel()

  // The query string is the scope's identity: the page may rebuild the object
  // on every render, and refetching on identity would loop.
  const scopeQuery = qualityScopeQuery(scope)
  const [snapshot, setSnapshot] = useState<SnapshotDto | null>(null)
  /** The scope the shown snapshot belongs to; differs from `scope` after a failed switch. */
  const [shownScope, setShownScope] = useState<{ query: string; scope: QualityScope } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // Only the newest request may land: a slow 90-day response must not
  // overwrite the 7-day one the user switched to after it.
  const requestRef = useRef<AbortController | null>(null)
  const load = useCallback((query: string) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const requested = readQualityScope(new URLSearchParams(query))
    setLoading(true)
    setError(false)
    fetch(`/api/platform/citation-health?${query}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as SnapshotDto
        if (controller.signal.aborted) return
        setSnapshot(data)
        setShownScope({ query, scope: data.scope ?? requested })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setError(true)
      })
      .finally(() => {
        if (requestRef.current === controller) setLoading(false)
      })
  }, [])

  useEffect(() => {
    load(scopeQuery)
    return () => requestRef.current?.abort()
  }, [scopeQuery, load])

  const kindLabel = useCallback((kind: string) => t(`citations.kinds.${kind}`), [t])
  const reasonLabel = useCallback(
    (reason: string) => {
      const key = `citations.reasons.${reason}`
      const translated = t(key)
      // A missing key resolves to the dotted path; show the bare reason key
      // instead: the backend may emit a new one before the dictionary catches up.
      return translated.endsWith(key) ? reason : translated
    },
    [t]
  )

  const copyFor = useCallback(
    (finding: FindingDto): FindingCopy => {
      const vars: Record<string, string> = { subject: finding.subject?.label ?? '' }
      // `share` and `platformShare` are fractions (0–1); the copy carries no
      // "%" of its own, so the locale decides "12.5%" vs "12,5 %".
      for (const [name, value] of Object.entries(finding.metrics)) {
        vars[name] = FRACTION_METRICS.has(name) ? percent(value) : decimal(value)
      }
      // Several findings have no entity to point at: fall back to the generic
      // wording rather than interpolating an empty name into the sentence.
      const actionKey =
        finding.subject === null && FINDINGS_WITH_SUBJECT_FALLBACK.has(finding.id)
          ? `citations.findings.${finding.id}.actionNoSubject`
          : `citations.findings.${finding.id}.action`
      return {
        title: t(`citations.findings.${finding.id}.title`),
        meaning: t(`citations.findings.${finding.id}.meaning`, vars),
        action: t(actionKey, vars),
      }
    },
    [t, decimal, percent]
  )

  const reasonRows = useMemo(
    () =>
      (snapshot?.reasons ?? []).map((row) => ({
        key: `${row.kind}:${row.reason}`,
        label: reasonLabel(row.reason),
        sublabel: kindLabel(row.kind),
        value: row.occurrences,
      })),
    [snapshot, reasonLabel, kindLabel]
  )

  const sourceRows = useMemo(
    () =>
      (snapshot?.sourceMix ?? []).map((row) => ({
        key: `${row.dimension}:${row.label}`,
        label: row.label,
        sublabel: t(`citations.dimensions.${row.dimension}`),
        value: row.turns,
      })),
    [snapshot, t]
  )

  const refreshing = loading && snapshot !== null

  const toolbar = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="outline" size="sm" onClick={() => load(scopeQuery)} disabled={loading}>
        <RefreshCw
          className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')}
          aria-hidden
        />
        {t('citations.refresh')}
      </Button>
      {/* A plain link, not a fetch: the route sets Content-Disposition, so the
          browser downloads without buffering the bundle in JS. */}
      <Button asChild variant="outline" size="sm">
        <a href={`/api/platform/citation-health/export?${scopeQuery}`} download>
          <Download className="size-3.5" aria-hidden />
          {t('citations.export')}
        </a>
      </Button>
    </div>
  )

  const retryButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => load(scopeQuery)}
      disabled={loading}
      className="mt-2 w-fit"
    >
      <RefreshCw
        className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')}
        aria-hidden
      />
      {t('retry')}
    </Button>
  )

  if (!snapshot) {
    return (
      <div data-testid="citation-health" className="flex flex-col gap-4">
        {toolbar}
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden />
            <AlertTitle>{t('citations.loadError')}</AlertTitle>
            <AlertDescription>
              <p>{t('loadErrorHint')}</p>
              {retryButton}
            </AlertDescription>
          </Alert>
        ) : (
          <LoadingState />
        )}
      </div>
    )
  }

  const tone = cleanRateTone(snapshot.totals.cleanRate)
  const staleWindow = shownScope !== null && shownScope.query !== scopeQuery
  // Label what is SHOWN: after a failed switch that is still the old scope.
  const shownLabel = scopeLabel(shownScope?.scope ?? scope)

  return (
    <div data-testid="citation-health" className="flex flex-col gap-4" aria-busy={refreshing}>
      {toolbar}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle className="line-clamp-none">
            {staleWindow
              ? t('citations.windowStale', {
                  requested: scopeLabel(scope),
                  shown: shownLabel,
                })
              : t('citations.loadError')}
          </AlertTitle>
          <AlertDescription>{retryButton}</AlertDescription>
        </Alert>
      ) : null}

      {(shownScope?.scope ?? scope).projectIds.length > 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="citation-health-project-caveat">
          {t('citations.projectCaveat')}
        </p>
      ) : null}

      {snapshot.totals.turns === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={t('citations.empty.title')}
          description={t('citations.empty.description', { scope: shownLabel })}
          className={cn(
            'duration-base transition-opacity motion-reduce:transition-none',
            refreshing && 'opacity-60'
          )}
        />
      ) : (
        <div
          className={cn(
            'duration-base flex flex-col gap-4 transition-opacity motion-reduce:transition-none',
            refreshing && 'opacity-60'
          )}
        >
          <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={<tone.icon className={tone.className} aria-hidden />}
              label={t('citations.stats.cleanRate')}
              value={<span className={tone.className}>{percent(snapshot.totals.cleanRate)}</span>}
              hint={t('citations.stats.cleanRateHint', {
                clean: count(snapshot.totals.cleanTurns),
                turns: count(snapshot.totals.turns),
              })}
            />
            <StatCard
              icon={<SearchX aria-hidden />}
              label={t('citations.stats.ungrounded')}
              value={count(snapshot.totals.ungroundedAnswers)}
              hint={t('citations.stats.ungroundedHint')}
            />
            <StatCard
              icon={<FileWarning aria-hidden />}
              label={t('citations.stats.removed')}
              value={count(snapshot.totals.citationsRemoved)}
              hint={t('citations.stats.removedHint')}
            />
            <StatCard
              icon={<Quote aria-hidden />}
              label={t('citations.stats.quotes')}
              value={count(snapshot.totals.unverifiedQuotes)}
              hint={t('citations.stats.quotesHint')}
            />
          </div>

          <FindingsCard findings={snapshot.findings} copyFor={copyFor} />

          <Card>
            <SectionHeader
              title={t('citations.trend.title')}
              description={t('citations.trend.description', { scope: shownLabel })}
            />
            <CardContent>
              <CitationDefectChart
                points={snapshot.dailyTrend}
                kinds={DEFECT_KINDS}
                kindLabel={kindLabel}
                turnsLabel={(value) => t('citations.trend.turns', { count: value })}
                findingsLabel={(value) => t('citations.trend.findings', { count: value })}
                flaggedLabel={(value) => t('citations.trend.flagged', { count: value })}
                emptyLabel={t('citations.trend.empty')}
                ariaLabel={t('citations.trend.title')}
              />
            </CardContent>
          </Card>

          {snapshot.missingSources.length > 0 ? (
            <MissingSourcesCard
              sources={snapshot.missingSources}
              total={snapshot.missingSourcesTotal ?? snapshot.missingSources.length}
              inventoryKnown={snapshot.inventoryKnown !== false}
              locale={locale}
            />
          ) : null}

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
            <Card>
              <SectionHeader
                title={t('citations.reasonsTitle')}
                description={t('citations.reasonsDescription')}
              />
              <CardContent>
                {reasonRows.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('citations.reasonsEmpty')}</p>
                ) : (
                  <RankedBars rows={reasonRows} format={count} />
                )}
              </CardContent>
            </Card>
            <Card>
              <SectionHeader
                title={t('citations.sourcesTitle')}
                description={t('citations.sourcesDescription')}
              />
              <CardContent>
                {sourceRows.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('citations.sourcesEmpty')}</p>
                ) : (
                  <RankedBars rows={sourceRows} format={count} />
                )}
              </CardContent>
            </Card>
          </div>

          <OrganizationsCard
            organizations={snapshot.organizations}
            total={snapshot.organizationsTotal ?? snapshot.organizations.length}
            locale={locale}
          />

          <RecentCard
            recent={snapshot.recent}
            locale={locale}
            kindLabel={kindLabel}
            reasonLabel={reasonLabel}
            scopeQuery={shownScope?.query ?? scopeQuery}
          />
        </div>
      )}
    </div>
  )
}
