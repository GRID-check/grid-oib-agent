'use client'

/**
 * Agent profiler (platform owner only): cross-organization conversation
 * directory + per-turn execution timeline, backed by the
 * `agent_profiler_spans` ledger (src/aiq_agent/common/profiler.py — the
 * timing sibling of the LLM cost ledger on `platform-overview.tsx`).
 *
 * Left: searchable conversation list, most recently active first. Right: the
 * selected conversation's turns, each rendered as a lightweight waterfall —
 * absolutely positioned bars scaled to the turn's total duration, nested by
 * indentation (node -> llm/tool), colored by span kind. No chart dependency.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Clock, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemContent, ItemDescription, ItemList, ItemTitle } from '@/components/ui/item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchField } from '@/components/ui/search-field'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'

type SpanKind = 'turn' | 'node' | 'llm' | 'tool'
type SpanStatus = 'ok' | 'error'

interface ConversationSummaryDto {
  conversationId: string
  organizationId: string | null
  title: string | null
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
  turns: TurnDto[]
}

const KIND_BAR_CLASS: Record<SpanKind, string> = {
  turn: 'bg-muted-foreground/50',
  node: 'bg-primary/70',
  llm: 'bg-info',
  tool: 'bg-warning',
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

function flattenWithOffset(root: SpanNodeDto): { node: SpanNodeDto; depth: number; offsetMs: number }[] {
  const turnStart = Date.parse(root.startedAt)
  const rows: { node: SpanNodeDto; depth: number; offsetMs: number }[] = []
  const walk = (node: SpanNodeDto, depth: number): void => {
    rows.push({ node, depth, offsetMs: Date.parse(node.startedAt) - turnStart })
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return rows
}

function TurnWaterfall({ turn, noSpansLabel }: { turn: TurnDto; noSpansLabel: string }): JSX.Element {
  if (!turn.root) {
    return <p className="text-xs text-muted-foreground">{noSpansLabel}</p>
  }
  const totalMs = Math.max(turn.durationMs, 1)
  const rows = flattenWithOffset(turn.root)
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(({ node, depth, offsetMs }) => (
        <div key={node.spanId} className="flex items-center gap-2 text-xs">
          <span
            className="w-36 shrink-0 truncate text-foreground/80 sm:w-48"
            style={{ paddingLeft: depth * 12 }}
            title={node.name}
          >
            {node.name}
          </span>
          <div className="relative h-4 min-w-16 flex-1 rounded bg-muted">
            <div
              className={`absolute inset-y-0 rounded ${KIND_BAR_CLASS[node.kind]} ${
                node.status === 'error' ? 'ring-2 ring-destructive' : ''
              }`}
              style={{
                left: `${Math.min((offsetMs / totalMs) * 100, 100)}%`,
                width: `${Math.max((node.durationMs / totalMs) * 100, 1.5)}%`,
              }}
              title={`${node.name} — ${formatMs(node.durationMs)}${
                node.status === 'error' ? ` (${node.errorMessage ?? 'error'})` : ''
              }`}
            />
          </div>
          <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
            {formatMs(node.durationMs)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function AgentProfiler(): JSX.Element {
  const t = useTranslations('platform')

  const [conversations, setConversations] = useState<ConversationSummaryDto[]>([])
  const [capped, setCapped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState('')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<TimelineDto | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState(false)

  const load = useCallback(
    (query: string) => {
      setLoading(true)
      setError(false)
      const qs = query ? `?q=${encodeURIComponent(query)}` : ''
      fetch(`/api/platform/profiler/conversations${qs}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          const data = (await res.json()) as { conversations: ConversationSummaryDto[]; capped: boolean }
          setConversations(data.conversations)
          setCapped(data.capped)
        })
        .catch(() => {
          setError(true)
          toast.error(t('profiler.loadError'))
        })
        .finally(() => setLoading(false))
    },
    [t],
  )

  useEffect(() => {
    const handle = setTimeout(() => load(search), search ? 300 : 0)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const selectConversation = useCallback(
    (conversationId: string) => {
      setSelectedId(conversationId)
      setTimeline(null)
      setTimelineLoading(true)
      setTimelineError(false)
      fetch(`/api/platform/profiler/conversations/${encodeURIComponent(conversationId)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          setTimeline((await res.json()) as TimelineDto)
        })
        .catch(() => {
          setTimelineError(true)
          toast.error(t('profiler.detailLoadError'))
        })
        .finally(() => setTimelineLoading(false))
    },
    [t],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="size-4 text-muted-foreground" aria-hidden />
          {t('profiler.title')}
        </CardTitle>
        <CardDescription>{t('profiler.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <EmptyState
            variant="bare"
            icon={AlertTriangle}
            title={t('profiler.loadError')}
            action={
              <Button variant="outline" size="sm" onClick={() => load(search)} disabled={loading}>
                <RefreshCw className={`size-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
                {t('profiler.retry')}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="flex flex-col gap-2 lg:col-span-2">
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={t('profiler.search')}
                label={t('profiler.search')}
                type="text"
              />

              {loading ? (
                <div className="flex min-h-[18.5rem] flex-col gap-2">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : conversations.length === 0 ? (
                <EmptyState variant="bare" icon={Clock} title={t('profiler.empty')} />
              ) : (
                <div className="animate-in fade-in-0 min-h-[18.5rem] duration-base ease-out motion-reduce:animate-none">
                  <ScrollArea className="max-h-[28rem]">
                    <ItemList>
                      {conversations.map((conversation) => (
                        <Item
                          key={conversation.conversationId}
                          role="button"
                          tabIndex={0}
                          className={selectedId === conversation.conversationId ? 'bg-accent' : undefined}
                          onClick={() => selectConversation(conversation.conversationId)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              selectConversation(conversation.conversationId)
                            }
                          }}
                        >
                          <ItemContent>
                            <ItemTitle>{conversation.title || conversation.conversationId}</ItemTitle>
                            <ItemDescription>
                              {conversation.organizationId ?? '—'} · {conversation.turnCount} ·{' '}
                              {formatMs(conversation.totalDurationMs)}
                            </ItemDescription>
                          </ItemContent>
                        </Item>
                      ))}
                    </ItemList>
                  </ScrollArea>
                  {capped && (
                    <p className="text-xs text-muted-foreground">
                      {t('profiler.capped', { count: conversations.length })}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 lg:col-span-3">
              {!selectedId ? (
                <EmptyState variant="bare" icon={Clock} title={t('profiler.detailEmpty')} />
              ) : timelineLoading ? (
                <div className="flex min-h-[8.5rem] flex-col gap-2">
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : timelineError ? (
                <EmptyState
                  variant="bare"
                  icon={AlertTriangle}
                  title={t('profiler.detailLoadError')}
                  action={
                    <Button variant="outline" size="sm" onClick={() => selectConversation(selectedId)}>
                      <RefreshCw className="size-3.5" aria-hidden />
                      {t('profiler.retry')}
                    </Button>
                  }
                />
              ) : timeline && timeline.turns.length > 0 ? (
                <div className="animate-in fade-in-0 flex min-h-[8.5rem] flex-col gap-4 duration-base ease-out motion-reduce:animate-none">
                  {timeline.turns.map((turn, index) => (
                    <div key={turn.turnId} className="rounded-lg border p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {t('profiler.turn')} {index + 1}
                          {turn.status === 'error' && (
                            <Badge variant="destructive">{t('profiler.turnFailed')}</Badge>
                          )}
                          {turn.jobId && <Badge variant="outline">{turn.jobId}</Badge>}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatMs(turn.durationMs)} · {t('profiler.spanCount', { count: turn.spanCount })}
                        </span>
                      </div>
                      <TurnWaterfall turn={turn} noSpansLabel={t('profiler.noSpans')} />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState variant="bare" icon={Clock} title={t('profiler.noSpans')} />
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
