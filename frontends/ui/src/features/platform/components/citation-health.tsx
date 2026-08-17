'use client'

/**
 * Citation health (platform owner only): how often citation verification had
 * to intervene, what it caught, why, on which retrieval lanes, for which
 * organizations — backed by the `citation_events` ledger
 * (src/aiq_agent/common/citation_events.py, the quality sibling of the timing
 * ledger behind `agent-profiler.tsx` and the cost ledger on
 * `platform-overview.tsx`).
 *
 * Layout, top to bottom: the headline clean rate + defect tiles, the stacked
 * daily trend, the "why" breakdown (removal reasons + the retrieval lanes in
 * play on bad turns), the per-organization table, and a recent-defects list
 * whose turn ids match the agent profiler's, so a flagged turn can be opened
 * in the timeline above.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Download,
  FileWarning,
  Info,
  Plus,
  Quote,
  RefreshCw,
  SearchX,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard } from '@/components/ui/stat-card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CitationDefectChart } from '@/components/charts/citation-defect-chart'
import { SeriesPaletteStyle } from '@/components/charts/palette'
import { useLocale, useTranslations } from '@/i18n'

/**
 * Defect kinds in FIXED order. This drives both the chart's palette slots and
 * the tile order, so a kind keeps its identity when another disappears from
 * the window. Keep in sync with `CITATION_DEFECT_KINDS` (lib/citations/service).
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
  dimension: 'origin' | 'tool'
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

interface FindingDto {
  id: FindingId
  severity: 'error' | 'warn' | 'info'
  subject: { type: 'organization' | 'tool'; label: string } | null
  metrics: Record<string, number>
}

type MissingSourceAction =
  | 'add_to_norm_catalog'
  | 'upload_to_base_knowledge'
  | 'investigate_retrieval'
  | 'none'

interface MissingSourceDto {
  target: string
  kind: 'document' | 'ris' | 'web'
  reason: string
  turns: number
  organizations: number
  lastSeenAt: string
  present: boolean
  action: MissingSourceAction
  fileName: string | null
  documentNumber: string | null
}

/**
 * Where each remedy lives. The managers own their own add flows (upload
 * validation, RIS verification, audit trail); linking to them with the
 * candidate copied beats duplicating — or worse, bypassing — those checks.
 */
const ACTION_ANCHOR: Partial<Record<MissingSourceAction, string>> = {
  upload_to_base_knowledge: '/app/platform/knowledge',
  add_to_norm_catalog: '/app/platform/norms',
}

interface SnapshotDto {
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
  organizations: OrganizationDto[]
  recent: DefectSampleDto[]
}

const WINDOW_OPTIONS = [7, 30, 90] as const

/** Findings whose remedy names an entity, and so need a subject-less variant. */
const FINDINGS_WITH_SUBJECT_FALLBACK = new Set<FindingId>(['retrieval_unavailable', 'answers_ungrounded'])

/**
 * Status color by severity — reserved tokens, always paired with an icon and
 * a label, never carrying meaning alone.
 */
const SEVERITY_BADGE: Record<Severity, string> = {
  ok: 'border-success text-success',
  info: 'text-muted-foreground',
  warn: 'border-warning text-warning',
  error: 'border-danger text-danger',
}

/** The clean rate is the one number to read first — color it by how bad it is. */
function cleanRateTone(rate: number): string {
  if (rate >= 0.95) return 'text-success'
  if (rate >= 0.8) return 'text-warning'
  return 'text-danger'
}

const percent = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value)

/**
 * One diagnosis + remedy. The severity icon and the left rule carry the same
 * information as the reserved status color, so severity is never color-alone.
 */
const FINDING_STYLE: Record<
  FindingDto['severity'],
  { icon: typeof AlertTriangle; rule: string; text: string }
> = {
  error: { icon: AlertTriangle, rule: 'border-l-danger', text: 'text-danger' },
  warn: { icon: AlertCircle, rule: 'border-l-warning', text: 'text-warning' },
  info: { icon: Info, rule: 'border-l-border', text: 'text-muted-foreground' },
}

function FindingRow({
  finding,
  title,
  meaning,
  action,
}: {
  finding: FindingDto
  title: string
  meaning: string
  action: string
}): JSX.Element {
  const style = FINDING_STYLE[finding.severity]
  const Icon = style.icon
  return (
    <li className={`flex gap-3 border-l-2 py-2 pl-3 ${style.rule}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${style.text}`} aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{meaning}</p>
        <p className="text-xs">{action}</p>
      </div>
    </li>
  )
}

/** Ranked horizontal bars — magnitude by category, recessive track, value at the end. */
function RankedBars({ rows }: { rows: { key: string; label: string; sublabel?: string; value: number }[] }): JSX.Element {
  const max = Math.max(...rows.map((row) => row.value), 1)
  return (
    <ul className="grid-usage-viz flex flex-col gap-2">
      <SeriesPaletteStyle />
      {rows.map((row) => (
        <li key={row.key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-xs">
              {row.label}
              {row.sublabel ? <span className="text-muted-foreground"> · {row.sublabel}</span> : null}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{row.value}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full"
              style={{ backgroundColor: 'var(--grid-series-1)', width: `${Math.max((row.value / max) * 100, 2)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function CitationHealth(): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const [days, setDays] = useState<number>(30)
  const [snapshot, setSnapshot] = useState<SnapshotDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(
    (windowDays: number) => {
      setLoading(true)
      setError(false)
      fetch(`/api/platform/citation-health?days=${windowDays}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          setSnapshot((await res.json()) as SnapshotDto)
        })
        .catch(() => {
          setError(true)
          toast.error(t('citations.loadError'))
        })
        .finally(() => setLoading(false))
    },
    [t],
  )

  useEffect(() => {
    load(days)
  }, [days, load])

  const kindLabel = useCallback((kind: string) => t(`citations.kinds.${kind}`), [t])
  const reasonLabel = useCallback(
    (reason: string) => {
      const key = `citations.reasons.${reason}`
      const translated = t(key)
      // A missing key resolves to the dotted path itself; show the bare reason
      // key instead — the backend may emit a new one before the dictionary
      // catches up, and `platform.citations.reasons.foo` helps nobody.
      return translated.endsWith(key) ? reason : translated
    },
    [t],
  )

  const reasonRows = useMemo(
    () =>
      (snapshot?.reasons ?? []).map((row) => ({
        key: `${row.kind}:${row.reason}`,
        label: reasonLabel(row.reason),
        sublabel: kindLabel(row.kind),
        value: row.occurrences,
      })),
    [snapshot, reasonLabel, kindLabel],
  )

  const sourceRows = useMemo(
    () =>
      (snapshot?.sourceMix ?? []).map((row) => ({
        key: `${row.dimension}:${row.label}`,
        label: row.label,
        sublabel: t(`citations.dimensions.${row.dimension}`),
        value: row.turns,
      })),
    [snapshot, t],
  )

  const windowSwitch = (
    <div className="flex flex-wrap items-center gap-1">
      <ToggleGroup
        type="single"
        size="sm"
        value={String(days)}
        onValueChange={(value) => {
          if (value) setDays(Number(value))
        }}
        aria-label={t('citations.windowAria')}
      >
        {WINDOW_OPTIONS.map((option) => (
          <ToggleGroupItem key={option} value={String(option)}>
            {t('citations.windowDays', { count: option })}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/* A plain link, not a fetch: the route already sets Content-Disposition,
          so the browser downloads it without buffering the bundle in JS. */}
      <Button asChild variant="outline" size="sm">
        <a href={`/api/platform/citation-health/export?days=${days}`} download>
          <Download className="size-3.5" aria-hidden />
          {t('citations.export')}
        </a>
      </Button>
    </div>
  )

  if (error && !snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('citations.title')}</CardTitle>
          <CardDescription>{t('citations.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            variant="bare"
            icon={AlertTriangle}
            title={t('citations.loadError')}
            action={
              <Button variant="outline" size="sm" onClick={() => load(days)} disabled={loading}>
                <RefreshCw className={`size-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
                {t('retry')}
              </Button>
            }
          />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-testid="citation-health">
      <CardHeader>
        <CardTitle>{t('citations.title')}</CardTitle>
        <CardDescription>{t('citations.description')}</CardDescription>
        {/* CardAction is pinned to the header's second column, which squeezes
            the title/description to a sliver on narrow viewports. Drop the
            switch onto its own full-width row below the text under `sm`. */}
        <CardAction className="col-start-1 row-span-1 row-start-3 justify-self-start pt-1 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end sm:pt-0">
          {windowSwitch}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {loading || !snapshot ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-[7.25rem] w-full" />
              ))}
            </div>
            <Skeleton className="h-32 w-full" />
          </>
        ) : snapshot.totals.turns === 0 ? (
          <EmptyState
            variant="bare"
            icon={ShieldCheck}
            title={t('citations.empty.title')}
            description={t('citations.empty.description')}
          />
        ) : (
          <div className="animate-in fade-in-0 flex flex-col gap-6 duration-200 ease-out motion-reduce:animate-none">
            {/* Headline: the clean rate first, then what went wrong. */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                className="min-h-[7.25rem]"
                icon={<ShieldCheck className="size-4" aria-hidden />}
                label={t('citations.stats.cleanRate')}
                value={
                  <span className={cleanRateTone(snapshot.totals.cleanRate)}>
                    {percent(snapshot.totals.cleanRate, locale)}
                  </span>
                }
                hint={t('citations.stats.cleanRateHint', {
                  clean: snapshot.totals.cleanTurns,
                  turns: snapshot.totals.turns,
                })}
              />
              <StatCard
                className="min-h-[7.25rem]"
                icon={<SearchX className="size-4" aria-hidden />}
                label={t('citations.stats.ungrounded')}
                value={snapshot.totals.ungroundedAnswers}
                hint={t('citations.stats.ungroundedHint')}
              />
              <StatCard
                className="min-h-[7.25rem]"
                icon={<FileWarning className="size-4" aria-hidden />}
                label={t('citations.stats.removed')}
                value={snapshot.totals.citationsRemoved}
                hint={t('citations.stats.removedHint')}
              />
              <StatCard
                className="min-h-[7.25rem]"
                icon={<Quote className="size-4" aria-hidden />}
                label={t('citations.stats.quotes')}
                value={snapshot.totals.unverifiedQuotes}
                hint={t('citations.stats.quotesHint')}
              />
            </div>

            {/* The answer to "so what do I do?" — before any chart. */}
            <section className="flex flex-col gap-2" data-testid="citation-findings">
              <h3 className="text-sm font-medium">{t('citations.findingsTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('citations.findingsDescription')}</p>
              <ul className="flex flex-col gap-1">
                {snapshot.findings.map((finding) => {
                  const vars = { ...finding.metrics, subject: finding.subject?.label ?? '' }
                  // A subject-specific remedy reads better, but several findings
                  // have no entity to point at — fall back to the generic wording
                  // rather than interpolating an empty name into the sentence.
                  const actionKey =
                    finding.subject === null && FINDINGS_WITH_SUBJECT_FALLBACK.has(finding.id)
                      ? `citations.findings.${finding.id}.actionNoSubject`
                      : `citations.findings.${finding.id}.action`
                  return (
                    <FindingRow
                      key={finding.id}
                      finding={finding}
                      title={t(`citations.findings.${finding.id}.title`)}
                      meaning={t(`citations.findings.${finding.id}.meaning`, vars)}
                      action={t(actionKey, vars)}
                    />
                  )
                })}
              </ul>
            </section>

            {/* Trend */}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('citations.trend.title')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('citations.trend.description', { days: snapshot.windowDays })}
              </p>
              <CitationDefectChart
                points={snapshot.dailyTrend}
                kinds={DEFECT_KINDS}
                kindLabel={kindLabel}
                turnsLabel={(count) => t('citations.trend.turns', { count })}
                findingsLabel={(count) => t('citations.trend.findings', { count })}
                flaggedLabel={(count) => t('citations.trend.flagged', { count })}
                emptyLabel={t('citations.trend.empty')}
                ariaLabel={t('citations.trend.title')}
              />
            </section>

            {/* The addable half of "what to do": specific sources to supply. */}
            {snapshot.missingSources.length > 0 ? (
              <section className="flex flex-col gap-2" data-testid="citation-missing-sources">
                <h3 className="text-sm font-medium">{t('citations.missingTitle')}</h3>
                <p className="text-xs text-muted-foreground">{t('citations.missingDescription')}</p>
                <ul className="flex flex-col divide-y rounded-lg border">
                  {snapshot.missingSources.map((candidate) => {
                    const anchor = ACTION_ANCHOR[candidate.action]
                    return (
                      <li
                        key={candidate.target}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1 basis-full sm:basis-0">
                          <p className="truncate text-sm" title={candidate.target}>
                            {candidate.fileName ?? candidate.target}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t('citations.missingCited', {
                              turns: candidate.turns,
                              organizations: candidate.organizations,
                            })}
                            {' · '}
                            {t(`citations.missingStatus.${candidate.present ? 'present' : 'absent'}`)}
                          </p>
                        </div>
                        <Badge variant="outline" className="shrink-0">
                          {t(`citations.missingKinds.${candidate.kind}`)}
                        </Badge>
                        {anchor ? (
                          <Button
                            asChild
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={() => {
                              // Put the identifier on the clipboard so the target
                              // manager's own form can be filled without retyping
                              // a document number by hand.
                              void navigator.clipboard
                                ?.writeText(candidate.documentNumber ?? candidate.fileName ?? candidate.target)
                                .catch(() => undefined)
                            }}
                          >
                            <a href={anchor}>
                              <Plus className="size-3.5" aria-hidden />
                              {t(`citations.missingActions.${candidate.action}`)}
                            </a>
                          </Button>
                        ) : (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t(`citations.missingActions.${candidate.action}`)}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
                <p className="text-xs text-muted-foreground">{t('citations.missingCaveat')}</p>
              </section>
            ) : null}

            {/* Why it happened + where it happened */}
            <div className="grid gap-6 md:grid-cols-2">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t('citations.reasonsTitle')}</h3>
                <p className="text-xs text-muted-foreground">{t('citations.reasonsDescription')}</p>
                {reasonRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('citations.reasonsEmpty')}</p>
                ) : (
                  <RankedBars rows={reasonRows} />
                )}
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t('citations.sourcesTitle')}</h3>
                <p className="text-xs text-muted-foreground">{t('citations.sourcesDescription')}</p>
                {sourceRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('citations.sourcesEmpty')}</p>
                ) : (
                  <RankedBars rows={sourceRows} />
                )}
              </section>
            </div>

            {/* Per-organization */}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('citations.orgsTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('citations.orgsDescription')}</p>
              {snapshot.organizations.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('citations.orgsEmpty')}</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-lg border">
                  {snapshot.organizations.map((org) => (
                    <li
                      key={org.organizationId ?? 'unattributed'}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap"
                    >
                      <p className="min-w-0 flex-1 basis-full truncate text-sm sm:basis-0">
                        {org.name ?? org.organizationId ?? t('citations.unattributed')}
                      </p>
                      <div className="flex flex-1 items-center justify-between gap-4 sm:flex-none sm:justify-end">
                        {(
                          [
                            [t('citations.colTurns'), String(org.turns)],
                            [t('citations.colDefects'), String(org.defectTurns)],
                            [t('citations.colDefectRate'), percent(org.defectRate, locale)],
                          ] as const
                        ).map(([label, value]) => (
                          <div key={label} className="flex min-w-14 flex-col items-end">
                            <SectionLabel>{label}</SectionLabel>
                            <span className="text-sm tabular-nums">{value}</span>
                          </div>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Drill-down */}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('citations.recentTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('citations.recentDescription')}</p>
              {snapshot.recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('citations.recentEmpty')}</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-lg border">
                  {snapshot.recent.map((event) => (
                    <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <Badge variant="outline" className={SEVERITY_BADGE[event.severity]}>
                        {kindLabel(event.kind)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {t(`citations.agents.${event.agent}`)} · {t('citations.itemCount', { count: event.count })}
                      </span>
                      {event.reasons ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {Object.keys(event.reasons).map(reasonLabel).join(', ')}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                        {new Date(event.createdAt).toLocaleString(locale)}
                      </span>
                      <code className="w-full truncate text-[10px] text-muted-foreground">
                        {t('citations.turnId')}: {event.turnId}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
