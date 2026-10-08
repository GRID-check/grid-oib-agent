'use client'

/**
 * Agent profiler (platform staff): cross-organization conversation directory
 * plus a per-turn execution timeline, backed by the `agent_profiler_spans`
 * ledger (src/aiq_agent/common/profiler.py, the timing sibling of the LLM cost
 * ledger).
 *
 * One tab of Platform → Answer quality ("timing"). Two cards side by side on a
 * wide screen, stacked on a phone with the list first: the searchable list of
 * conversations, most recently active first, and the selected conversation's
 * turns, each drawn as a waterfall: bars positioned on the turn's own time
 * axis, nested by indentation (turn → step → model/tool call), the kind told
 * apart by icon, label and colour together. No chart dependency.
 *
 * A conversation can be preselected (`initialConversationId`, or
 * `?conversation=` on the URL), which is how citation health's recent findings
 * link into this view.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  Bot,
  Clock,
  MessageSquare,
  RefreshCw,
  SearchX,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemList,
  ItemTitle,
} from '@/components/ui/item'
import { SearchField } from '@/components/ui/search-field'
import { Skeleton } from '@/components/ui/skeleton'
import { SeriesPaletteStyle } from '@/components/charts/palette'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CopyableId, shortId } from './copyable-id'

type SpanKind = 'turn' | 'node' | 'llm' | 'tool'
type SpanStatus = 'ok' | 'error'

interface ConversationSummaryDto {
  conversationId: string
  organizationId: string | null
  /** Resolved display name; absent on servers that predate it. */
  organizationName?: string | null
  title: string | null
  /** The conversation drew on a restricted folder; the server sends no title (ADR-0092). */
  titleWithheld?: boolean
  turnCount: number
  totalDurationMs: number
  lastActiveAt: string
}

interface SpanNodeDto {
  spanId: string
  kind: SpanKind
  name: string
  startedAt: string
  endedAt: string
  durationMs: number
  status: SpanStatus
  errorMessage: string | null
  /** `{ synthetic: true }` on a stand-in root for a turn whose root span was lost. */
  metadata?: Record<string, unknown> | null
  children: SpanNodeDto[]
}

interface TurnDto {
  turnId: string
  jobId: string | null
  startedAt: string
  durationMs: number
  status: SpanStatus
  spanCount: number
  root: SpanNodeDto | null
}

interface TimelineDto {
  conversationId: string
  /** The newest turns, oldest first. */
  turns: TurnDto[]
  /** Turns the conversation has in all; more than `turns.length` when capped. */
  totalTurns?: number
  capped?: boolean
}

/** Debounce for the search box; the first, empty query goes out at once. */
const SEARCH_DEBOUNCE_MS = 300

/** Indentation per nesting level, capped so a deep tree keeps a readable name. */
const INDENT_PX = 12
const MAX_INDENT_DEPTH = 4

/**
 * Span kind → icon + palette slot. The icon and the legend label carry the
 * kind; the colour repeats them, never alone. Slots come from the validated
 * categorical palette; the turn itself is the recessive ink.
 */
const KIND_STYLE: Record<SpanKind, { icon: LucideIcon; color: string }> = {
  turn: {
    icon: MessageSquare,
    color: 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)',
  },
  node: { icon: Workflow, color: 'var(--grid-series-1)' },
  llm: { icon: Bot, color: 'var(--grid-series-3)' },
  tool: { icon: Wrench, color: 'var(--grid-series-2)' },
}
const KIND_ORDER: SpanKind[] = ['turn', 'node', 'llm', 'tool']

/** A locale-formatted duration: "850 ms", "2,45 s", "12,3 s", "1,5 min". */
export function formatSpanDuration(ms: number, locale: string): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const format = (
    value: number,
    unit: 'millisecond' | 'second' | 'minute',
    digits: number
  ): string =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(value)
  if (safe < 1000) return format(Math.round(safe), 'millisecond', 0)
  if (safe < 60_000) return format(safe / 1000, 'second', safe < 10_000 ? 2 : 1)
  return format(safe / 60_000, 'minute', 1)
}

interface WaterfallRow {
  node: SpanNodeDto
  depth: number
  offsetMs: number
}

function flattenWithOffset(root: SpanNodeDto): WaterfallRow[] {
  const turnStart = Date.parse(root.startedAt)
  const rows: WaterfallRow[] = []
  const walk = (node: SpanNodeDto, depth: number): void => {
    rows.push({ node, depth, offsetMs: Date.parse(node.startedAt) - turnStart })
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return rows
}

/**
 * Bar geometry as percentages of the turn. Clamped so a bar never leaves its
 * track: a child that started late and ran long (clock skew, a span that
 * outlived its parent) used to draw past the right edge of the row.
 */
export function barGeometry(
  offsetMs: number,
  durationMs: number,
  totalMs: number
): { left: number; width: number } {
  const total = Math.max(totalMs, 1)
  const left = Math.min(Math.max((offsetMs / total) * 100, 0), 98.5)
  const width = Math.min(Math.max((durationMs / total) * 100, 1.5), 100 - left)
  return { left, width }
}

function KindLegend(): JSX.Element {
  const t = useTranslations('platform')
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label={t('profiler.legendAria')}>
      {KIND_ORDER.map((kind) => {
        const { icon: Icon, color } = KIND_STYLE[kind]
        return (
          <li key={kind} className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: color }}
              aria-hidden
            />
            <Icon className="size-3.5 shrink-0" aria-hidden />
            {t(`profiler.kinds.${kind}`)}
          </li>
        )
      })}
    </ul>
  )
}

function TurnWaterfall({ turn, locale }: { turn: TurnDto; locale: string }): JSX.Element {
  const t = useTranslations('platform')
  // The server always sends a root now; a null one only comes from a server
  // that predates the synthetic root.
  if (!turn.root) return <p className="text-muted-foreground text-sm">{t('profiler.noSpans')}</p>
  // A root that never reached the ledger (a dropped flush batch) is stood in
  // for by a synthetic one spanning the recorded spans: say so, and name it so.
  const synthetic = turn.root.metadata?.synthetic === true
  const rows = flattenWithOffset(turn.root)
  const nameOf = (node: SpanNodeDto): string =>
    synthetic && node === turn.root ? t('profiler.syntheticRoot') : node.name
  return (
    <div className="flex flex-col gap-2">
      {synthetic ? (
        <p className="text-muted-foreground text-xs">
          {t('profiler.noRoot', { count: turn.spanCount })}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2 sm:gap-1.5">
        {rows.map(({ node, depth, offsetMs }) => {
          const { icon: Icon, color } = KIND_STYLE[node.kind]
          const { left, width } = barGeometry(offsetMs, node.durationMs, turn.durationMs)
          const failed = node.status === 'error'
          const failure = failed
            ? node.errorMessage
              ? t('profiler.spanFailed', { message: node.errorMessage })
              : t('profiler.spanFailedUnknown')
            : null
          const duration = formatSpanDuration(node.durationMs, locale)
          const label = `${t(`profiler.kinds.${node.kind}`)}: ${nameOf(node)}, ${duration}${failure ? `. ${failure}` : ''}`
          return (
            <li
              key={node.spanId}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_4.5rem]"
              title={label}
            >
              <span
                className="flex min-w-0 items-center gap-1.5"
                style={{ paddingLeft: Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX }}
              >
                <Icon className="size-3.5 shrink-0" style={{ color }} aria-hidden />
                <span className="sr-only">{t(`profiler.kinds.${node.kind}`)}: </span>
                <span className={cn('truncate', failed ? 'text-error' : 'text-foreground/80')}>
                  {nameOf(node)}
                </span>
                {failed ? (
                  <>
                    <AlertTriangle className="text-error size-3.5 shrink-0" aria-hidden />
                    <span className="sr-only">{failure}</span>
                  </>
                ) : null}
              </span>
              <span className="text-muted-foreground text-right tabular-nums sm:order-last">
                {duration}
              </span>
              <span
                className="bg-muted relative col-span-2 h-3 rounded-sm sm:col-span-1 sm:h-4"
                aria-hidden
              >
                <span
                  className={cn(
                    'absolute inset-y-0 rounded-sm',
                    failed && 'ring-destructive ring-offset-card ring-2 ring-offset-1'
                  )}
                  style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color }}
                />
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ListSkeleton(): JSX.Element {
  return (
    <ItemList aria-hidden>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </ItemList>
  )
}

function TimelineSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-4 w-48" />
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  )
}

function ErrorAlert({
  title,
  onRetry,
  busy,
}: {
  title: string
  onRetry: () => void
  busy: boolean
}): JSX.Element {
  const t = useTranslations('platform')
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden />
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      <AlertDescription>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={busy}
          className="mt-2 w-fit"
        >
          <RefreshCw
            className={cn('size-3.5', busy && 'animate-spin motion-reduce:animate-none')}
            aria-hidden
          />
          {t('profiler.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function AgentProfiler({
  initialConversationId,
}: { initialConversationId?: string } = {}): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const searchParams = useSearchParams()
  const preselected = initialConversationId ?? searchParams?.get('conversation') ?? null

  const [conversations, setConversations] = useState<ConversationSummaryDto[] | null>(null)
  const [capped, setCapped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState('')
  /** The query the shown list answers, for the no-match copy. */
  const [shownQuery, setShownQuery] = useState('')

  const [selectedId, setSelectedId] = useState<string | null>(preselected)
  const [timeline, setTimeline] = useState<TimelineDto | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState(false)

  // Only the newest request of each kind may land: typing "ab" after "a", or
  // clicking B while A's timeline is still in flight, used to let the slower
  // response overwrite the newer one.
  const listRequest = useRef<AbortController | null>(null)
  const timelineRequest = useRef<AbortController | null>(null)
  const timelineCardRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback((query: string) => {
    listRequest.current?.abort()
    const controller = new AbortController()
    listRequest.current = controller
    setLoading(true)
    setError(false)
    const qs = query ? `?q=${encodeURIComponent(query)}` : ''
    fetch(`/api/platform/profiler/conversations${qs}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as {
          conversations: ConversationSummaryDto[]
          capped: boolean
        }
        if (controller.signal.aborted) return
        setConversations(data.conversations)
        setCapped(data.capped)
        setShownQuery(query)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (listRequest.current === controller) setLoading(false)
      })
  }, [])

  useEffect(() => {
    const query = search.trim()
    const handle = setTimeout(() => load(query), query ? SEARCH_DEBOUNCE_MS : 0)
    return () => clearTimeout(handle)
  }, [search, load])

  useEffect(() => () => listRequest.current?.abort(), [])

  const loadTimeline = useCallback((conversationId: string) => {
    timelineRequest.current?.abort()
    const controller = new AbortController()
    timelineRequest.current = controller
    setTimeline(null)
    setTimelineLoading(true)
    setTimelineError(false)
    fetch(`/api/platform/profiler/conversations/${encodeURIComponent(conversationId)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as TimelineDto
        if (!controller.signal.aborted) setTimeline(data)
      })
      .catch(() => {
        if (!controller.signal.aborted) setTimelineError(true)
      })
      .finally(() => {
        if (timelineRequest.current === controller) setTimelineLoading(false)
      })
  }, [])

  useEffect(() => {
    if (selectedId) loadTimeline(selectedId)
    return () => timelineRequest.current?.abort()
  }, [selectedId, loadTimeline])

  const selectConversation = (conversationId: string): void => {
    if (conversationId === selectedId) return
    setSelectedId(conversationId)
    // Stacked layout: the timeline sits under a long list, so bring it into
    // view, or the click appears to do nothing.
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches) {
      timelineCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const selected = useMemo(
    () => conversations?.find((conversation) => conversation.conversationId === selectedId) ?? null,
    [conversations, selectedId]
  )

  const organizationLabel = (conversation: ConversationSummaryDto): string =>
    conversation.organizationName ?? conversation.organizationId ?? t('profiler.noOrganization')

  const summaryLine = (conversation: ConversationSummaryDto): string =>
    [
      organizationLabel(conversation),
      t('profiler.turnCount', { count: conversation.turnCount }),
      t('profiler.totalTime', {
        duration: formatSpanDuration(conversation.totalDurationMs, locale),
      }),
    ].join(' · ')

  const listBody = (): JSX.Element => {
    if (conversations === null) {
      return error ? (
        <ErrorAlert
          title={t('profiler.loadError')}
          onRetry={() => load(search.trim())}
          busy={loading}
        />
      ) : (
        <ListSkeleton />
      )
    }
    return (
      <>
        {error ? (
          <ErrorAlert
            title={t('profiler.loadError')}
            onRetry={() => load(search.trim())}
            busy={loading}
          />
        ) : null}
        {conversations.length === 0 ? (
          shownQuery ? (
            <EmptyState
              variant="bare"
              icon={SearchX}
              title={t('profiler.noMatch', { query: shownQuery })}
            />
          ) : (
            <EmptyState variant="bare" icon={Clock} title={t('profiler.empty')} />
          )
        ) : (
          <div
            className={cn(
              'scroll-fade-bottom duration-base max-h-80 overflow-y-auto rounded-lg transition-opacity motion-reduce:transition-none lg:max-h-[32rem]',
              loading && 'opacity-60'
            )}
          >
            <ItemList as="ul">
              {conversations.map((conversation) => {
                const active = conversation.conversationId === selectedId
                return (
                  <li key={conversation.conversationId}>
                    <Item asChild className={cn('w-full', active && 'bg-accent hover:bg-accent')}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => selectConversation(conversation.conversationId)}
                      >
                        <ItemContent>
                          <ItemTitle>
                            {conversation.title || shortId(conversation.conversationId)}
                          </ItemTitle>
                          {conversation.titleWithheld ? (
                            <ItemDescription>{t('profiler.titleWithheld')}</ItemDescription>
                          ) : null}
                          <ItemDescription className="tabular-nums">
                            {summaryLine(conversation)}
                          </ItemDescription>
                          {/* A phone has no width for a time column beside the title. */}
                          <ItemDescription className="tabular-nums sm:hidden">
                            {formatRelativeTime(conversation.lastActiveAt, locale)}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions className="text-muted-foreground hidden self-start pt-0.5 text-xs tabular-nums sm:flex">
                          <time
                            dateTime={conversation.lastActiveAt}
                            title={formatAbsoluteTime(conversation.lastActiveAt, locale)}
                          >
                            {formatRelativeTime(conversation.lastActiveAt, locale)}
                          </time>
                        </ItemActions>
                      </button>
                    </Item>
                  </li>
                )
              })}
            </ItemList>
          </div>
        )}
        {capped && conversations.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t('profiler.capped', { count: conversations.length })}
          </p>
        ) : null}
      </>
    )
  }

  const timelineBody = (): JSX.Element => {
    if (!selectedId)
      return <EmptyState variant="bare" icon={Clock} title={t('profiler.detailEmpty')} />
    if (timelineError) {
      return (
        <ErrorAlert
          title={t('profiler.detailLoadError')}
          onRetry={() => loadTimeline(selectedId)}
          busy={timelineLoading}
        />
      )
    }
    if (timelineLoading || !timeline) return <TimelineSkeleton />
    if (timeline.turns.length === 0)
      return <EmptyState variant="bare" icon={Clock} title={t('profiler.noSpans')} />
    const totalTurns = Math.max(timeline.totalTurns ?? 0, timeline.turns.length)
    // A capped timeline holds the NEWEST turns: number them by their place in
    // the whole conversation, not from one.
    const firstTurnNumber = totalTurns - timeline.turns.length + 1
    return (
      <div className="grid-usage-viz animate-in fade-in-0 duration-base flex flex-col gap-5 ease-out motion-reduce:animate-none">
        <SeriesPaletteStyle />
        <KindLegend />
        {timeline.capped || totalTurns > timeline.turns.length ? (
          <p className="text-muted-foreground -mt-2 text-xs">
            {t('profiler.turnsCapped', { shown: timeline.turns.length, total: totalTurns })}
          </p>
        ) : null}
        <ol className="flex flex-col">
          {timeline.turns.map((turn, index) => (
            <li
              key={turn.turnId}
              className="flex flex-col gap-3 border-t py-4 first:border-t-0 first:pt-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t('profiler.turn')} {firstTurnNumber + index}
                  {turn.status === 'error' ? (
                    <Badge variant="outline" className="border-danger bg-danger-subtle text-error">
                      <AlertTriangle aria-hidden />
                      {t('profiler.turnFailed')}
                    </Badge>
                  ) : null}
                </span>
                <span className="text-muted-foreground flex items-center gap-2 text-xs tabular-nums">
                  {formatSpanDuration(turn.durationMs, locale)} ·{' '}
                  {t('profiler.spanCount', { count: turn.spanCount })}
                  {turn.jobId ? (
                    <CopyableId
                      id={turn.jobId}
                      copyLabel={t('profiler.copyId', { id: turn.jobId })}
                      copiedLabel={t('profiler.copied')}
                      failedLabel={t('profiler.copyFailed')}
                    />
                  ) : null}
                </span>
              </div>
              <TurnWaterfall turn={turn} locale={locale} />
            </li>
          ))}
        </ol>
      </div>
    )
  }

  return (
    <div
      data-testid="agent-profiler"
      className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <Card>
        <CardHeader>
          <CardTitle>{t('profiler.listTitle')}</CardTitle>
          <CardDescription>{t('profiler.listDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('profiler.search')}
            label={t('profiler.search')}
            type="text"
          />
          {listBody()}
        </CardContent>
      </Card>

      <Card ref={timelineCardRef} className="scroll-mt-4" data-testid="agent-profiler-timeline">
        <CardHeader>
          <CardTitle className="truncate leading-normal">
            {selected?.title || (selectedId ? shortId(selectedId) : t('profiler.timelineTitle'))}
          </CardTitle>
          <CardDescription className="tabular-nums">
            {selected ? summaryLine(selected) : t('profiler.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>{timelineBody()}</CardContent>
      </Card>
    </div>
  )
}
