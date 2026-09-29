'use client'

/**
 * Platform → Feedback: every report members sent, across organizations, and
 * the one control that matters for each — where it is in triage.
 *
 * The status is the work queue. `new` is what nobody has looked at, and the
 * page opens on it, because that is the question an owner arrives with ("what
 * came in?"). An inbox row lands here with `?report=<id>`; that report is
 * pinned to the top and marked, whatever the filter says, so the link always
 * shows what it promised.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { ChevronDown, Mail, MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Chip, ChipCount } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { RaisedCard } from '@/components/ui/raised-card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TimeAgo } from '@/components/ui/time-ago'
import { SectionCard } from '@/features/platform/components/section-card'
import { useLocale, useTranslations } from '@/i18n'
import {
  fetchPlatformFeedback,
  fetchPlatformFeedbackReport,
  triagePlatformFeedback,
  type ListFeedbackFilters,
} from '@/lib/product-feedback/client'
import {
  PRODUCT_FEEDBACK_KINDS,
  PRODUCT_FEEDBACK_STATUSES,
  type ProductFeedbackKind,
  type ProductFeedbackListResponse,
  type ProductFeedbackReportView,
  type ProductFeedbackStatus,
} from '@/lib/product-feedback/types'
import { cn } from '@/lib/utils'
import { FEEDBACK_KIND_ICONS } from './feedback-dialog'

export interface FeedbackTriageClient {
  list: (filters: ListFeedbackFilters) => Promise<ProductFeedbackListResponse>
  get: (id: string) => Promise<ProductFeedbackReportView | null>
  triage: (id: string, status: ProductFeedbackStatus) => Promise<ProductFeedbackReportView>
}

const defaultClient: FeedbackTriageClient = {
  list: fetchPlatformFeedback,
  get: fetchPlatformFeedbackReport,
  triage: triagePlatformFeedback,
}

const STATUS_CHIP: Record<ProductFeedbackStatus, 'info' | 'warning' | 'success' | 'muted'> = {
  new: 'info',
  in_progress: 'warning',
  resolved: 'success',
  dismissed: 'muted',
}

const KIND_CHIP: Record<ProductFeedbackKind, 'destructive' | 'default' | 'success' | 'secondary'> = {
  bug: 'destructive',
  idea: 'default',
  praise: 'success',
  question: 'secondary',
}

type StatusFilter = ProductFeedbackStatus | 'all'
type KindFilter = ProductFeedbackKind | 'all'

export interface FeedbackTriageProps {
  /** Whether the reader holds the manage permission; view-only otherwise. */
  canTriage: boolean
  /** The report an inbox row linked to, pinned and marked. */
  focusReportId?: string | null
  client?: FeedbackTriageClient
}

export function FeedbackTriage({
  canTriage,
  focusReportId = null,
  client = defaultClient,
}: FeedbackTriageProps): JSX.Element {
  const t = useTranslations('feedback')
  const tPlatform = useTranslations('platform')
  const [status, setStatus] = React.useState<StatusFilter>('new')
  const [kind, setKind] = React.useState<KindFilter>('all')
  const [data, setData] = React.useState<ProductFeedbackListResponse | null>(null)
  const [focused, setFocused] = React.useState<ProductFeedbackReportView | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const filters = React.useMemo<ListFeedbackFilters>(
    () => ({
      status: status === 'all' ? undefined : status,
      kind: kind === 'all' ? undefined : kind,
    }),
    [status, kind],
  )

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      setData(await client.list(filters))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [client, filters])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!focusReportId) return
    let cancelled = false
    client
      .get(focusReportId)
      .then((report) => {
        if (!cancelled) setFocused(report)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client, focusReportId])

  async function loadMore(): Promise<void> {
    if (!data?.nextCursor) return
    setLoadingMore(true)
    try {
      const next = await client.list({ ...filters, cursor: data.nextCursor })
      setData({ ...next, reports: [...data.reports, ...next.reports] })
    } catch {
      toast.error(t('platform.loadError'))
    } finally {
      setLoadingMore(false)
    }
  }

  async function changeStatus(report: ProductFeedbackReportView, next: ProductFeedbackStatus): Promise<void> {
    if (next === report.status) return
    setBusyId(report.id)
    try {
      const updated = await client.triage(report.id, next)
      setFocused((current) => (current?.id === updated.id ? updated : current))
      setData((current) =>
        current
          ? {
              ...current,
              reports: current.reports.map((row) => (row.id === updated.id ? updated : row)),
              counts: {
                ...current.counts,
                [report.status]: Math.max(0, current.counts[report.status] - 1),
                [next]: current.counts[next] + 1,
              },
            }
          : current,
      )
      toast.success(t('platform.triaged', { status: t(`statuses.${next}`) }))
    } catch {
      toast.error(t('platform.triageError'))
    } finally {
      setBusyId(null)
    }
  }

  const reports = (data?.reports ?? []).filter((report) => report.id !== focused?.id)
  const total = data ? Object.values(data.counts).reduce((sum, value) => sum + value, 0) : 0

  return (
    <SectionCard
      title={tPlatform('sections.feedback.title')}
      description={tPlatform('sections.feedback.subtitle')}
      loading={loading && !data}
      error={error}
      errorMessage={t('platform.loadError')}
      onRetry={() => void load()}
      empty={!focused && reports.length === 0}
      emptyIcon={MessageSquarePlus}
      emptyTitle={t('platform.empty.title')}
      emptyDescription={t('platform.empty.description')}
      testId="feedback-triage"
      action={
        <Select value={kind} onValueChange={(value) => setKind(value as KindFilter)}>
          <SelectTrigger size="sm" aria-label={t('platform.filters.kindLabel')} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('platform.filters.allKinds')}</SelectItem>
            {PRODUCT_FEEDBACK_KINDS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`kinds.${option}.label`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <div className="flex flex-col gap-4">
        <div role="group" aria-label={t('platform.filters.label')} className="flex flex-wrap gap-1.5">
          <StatusFilterChip active={status === 'all'} onClick={() => setStatus('all')} count={total}>
            {t('platform.filters.all')}
          </StatusFilterChip>
          {PRODUCT_FEEDBACK_STATUSES.map((option) => (
            <StatusFilterChip
              key={option}
              active={status === option}
              onClick={() => setStatus(option)}
              count={data?.counts[option] ?? 0}
            >
              {t(`statuses.${option}`)}
            </StatusFilterChip>
          ))}
        </div>

        <ul className="flex flex-col gap-3">
          {focused && (
            <ReportCard
              report={focused}
              focused
              canTriage={canTriage}
              busy={busyId === focused.id}
              onStatusChange={(next) => void changeStatus(focused, next)}
            />
          )}
          {reports.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              canTriage={canTriage}
              busy={busyId === report.id}
              onStatusChange={(next) => void changeStatus(report, next)}
            />
          ))}
        </ul>

        {data?.nextCursor && (
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore} className="self-center">
            {t('platform.loadMore')}
          </Button>
        )}
      </div>
    </SectionCard>
  )
}

function StatusFilterChip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean
  onClick: () => void
  count: number
  children: React.ReactNode
}): JSX.Element {
  return (
    <Chip asChild interactive variant={active ? 'default' : 'outline'}>
      <button type="button" aria-pressed={active} onClick={onClick}>
        {children}
        <ChipCount>{count}</ChipCount>
      </button>
    </Chip>
  )
}

function ReportCard({
  report,
  focused = false,
  canTriage,
  busy,
  onStatusChange,
}: {
  report: ProductFeedbackReportView
  focused?: boolean
  canTriage: boolean
  busy: boolean
  onStatusChange: (status: ProductFeedbackStatus) => void
}): JSX.Element {
  const t = useTranslations('feedback')
  const { locale } = useLocale()
  const ref = React.useRef<HTMLLIElement>(null)
  const KindIcon = FEEDBACK_KIND_ICONS[report.kind]

  React.useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const reporter = report.reporter.name ?? report.reporter.email ?? t('platform.unknownReporter')
  const organization = report.organizationName ?? t('platform.unknownOrganization')

  return (
    <li ref={ref} data-testid="feedback-report" data-report-id={report.id}>
      <RaisedCard className={cn('bg-card gap-3 p-4', focused && 'ring-primary ring-2')}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip variant={KIND_CHIP[report.kind]} size="sm">
            <KindIcon aria-hidden />
            {t(`kinds.${report.kind}.label`)}
          </Chip>
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            {t('platform.from', { name: reporter, organization })}
          </span>
          <TimeAgo date={report.createdAt} locale={locale} className="text-muted-foreground text-xs" />
          <div className="ml-auto">
            {canTriage ? (
              <Select
                value={report.status}
                onValueChange={(value) => onStatusChange(value as ProductFeedbackStatus)}
                disabled={busy}
              >
                <SelectTrigger size="sm" aria-label={t('platform.statusLabel')} className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_FEEDBACK_STATUSES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`statuses.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Chip variant={STATUS_CHIP[report.status]} size="sm">
                {t(`statuses.${report.status}`)}
              </Chip>
            )}
          </div>
        </div>

        <p className="text-foreground text-sm leading-relaxed whitespace-pre-wrap break-words">{report.message}</p>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {report.pagePath && (
            <span className="font-mono">{t('platform.onPage', { page: report.pagePath })}</span>
          )}
          {report.reporter.email ? (
            <a
              href={`mailto:${report.reporter.email}`}
              className="text-primary inline-flex items-center gap-1 hover:underline"
            >
              <Mail className="size-3.5" aria-hidden />
              {t('platform.contact')}
            </a>
          ) : (
            <span>{t('platform.noContact')}</span>
          )}
          {report.triagedBy && report.status !== 'new' && (
            <span>{t('platform.triagedBy', { name: report.triagedBy })}</span>
          )}
        </div>

        {(report.context.userAgent || report.context.viewport) && (
          <Collapsible>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group inline-flex items-center gap-1 text-xs">
              {t('platform.details')}
              <ChevronDown
                aria-hidden
                className="size-3.5 transition-transform duration-quick group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {(
                  [
                    [t('dialog.context.browser'), report.context.userAgent],
                    [t('dialog.context.screen'), report.context.viewport],
                    [t('dialog.context.locale'), report.context.locale],
                    [t('dialog.context.timeZone'), report.context.timeZone],
                  ] as const
                )
                  .filter(([, value]) => Boolean(value))
                  .map(([label, value]) => (
                    <React.Fragment key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="min-w-0 break-words">{value}</dd>
                    </React.Fragment>
                  ))}
              </dl>
            </CollapsibleContent>
          </Collapsible>
        )}
      </RaisedCard>
    </li>
  )
}
