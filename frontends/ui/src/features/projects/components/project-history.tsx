'use client'

/**
 * Project History body (spec §5, FB-10) — a client list over the existing
 * conversations BFF domain plus the server-truth research-runs list, styled to
 * the click-dummy's Historie screen (title + search pill, provenance-shaped
 * filter chips, one white card of divided rows).
 *
 * Conversations deep-link into chat via `?session=` (the same query param
 * `useSessionUrl` already reads on the chat page); research rows reuse
 * ResearchRunsList wholesale, whose rows deep-link via `?job=`. Search is a
 * plain client-side title filter.
 *
 * The dummy's filter chips signal per-row *provenance* (Baurecht / Büroarchiv /
 * Projektwissen) with source-colored dots. Conversations carry NO provenance
 * today (id/title/projectId/timestamps only — see db/schema/conversations.ts),
 * so we do NOT fake source dots. Instead the chips carry the one honest signal
 * this page really has — the item *type* (conversation vs. deep-research run) —
 * matching the dummy's chip shape without inventing data. Row leading dots are
 * the dummy's dashed provenance ring rendered in the neutral `--source-auto`
 * family, again because there is no real per-row source to color them by.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ChevronRight, MessageSquare, Search } from 'lucide-react'
import type { Conversation } from '@/lib/db/schema'
import {
  CONVERSATION_TAG_KEYS,
  normalizeConversationTags,
  type ConversationTagKey,
} from '@/lib/conversations/tags'
import { conversationsClient } from '@/adapters/api/conversations-client'
import { Stagger, StaggerItem } from '@/components/motion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { useLocale, useTranslations } from '@/i18n'
import { ResearchRunsList } from './research-runs-list'

interface ProjectHistoryProps {
  projectId: string
  /** Qdrant collection scoping the research-runs fetch (FB-10). */
  projectCollection: string
}

/** Conversation as it arrives over the wire (timestamps serialize to strings). */
interface ConversationRow {
  id: string
  title: string
  tags: ConversationTagKey[]
  updatedAt: string
}

/** The one honest cross-store signal this page carries: item type. */
type HistoryFilter = 'all' | 'conversations' | 'research'

const toRows = (conversations: Conversation[]): ConversationRow[] =>
  conversations
    .map((c) => ({
      id: c.id,
      title: (c.title ?? '').trim(),
      // Sanitise: only render known topic keys (an unknown key from a legacy or
      // future row must not produce an unlabelled chip).
      tags: normalizeConversationTags((c.tags ?? []) as string[]),
      updatedAt: String(c.updatedAt),
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

export function ProjectHistory({ projectId, projectCollection }: ProjectHistoryProps): JSX.Element {
  const t = useTranslations('nav')
  const { locale } = useLocale()
  const [conversations, setConversations] = useState<ConversationRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState<HistoryFilter>('all')
  // Topic tags the user has narrowed to (OR-combined). Empty = no tag filter.
  const [selectedTags, setSelectedTags] = useState<ConversationTagKey[]>([])

  /** Localised label for a topic tag key. */
  const tagLabel = useCallback((key: ConversationTagKey): string => t(`history.tags.${key}`), [t])

  const toggleTag = useCallback((key: ConversationTagKey) => {
    setSelectedTags((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    )
  }, [])

  // Tracks the in-flight fetch (initial or retry) so a newer load or unmount
  // cancels it — a stale response must never overwrite a newer list.
  const activeLoadRef = useRef<{ cancelled: boolean } | null>(null)

  const load = useCallback(() => {
    if (activeLoadRef.current) {
      activeLoadRef.current.cancelled = true
    }
    const signal = { cancelled: false }
    activeLoadRef.current = signal

    setConversations(null)
    setError(null)

    conversationsClient
      .list(projectId)
      .then((rows) => {
        if (signal.cancelled) return
        setConversations(toRows(rows))
      })
      .catch((err: unknown) => {
        if (signal.cancelled) return
        setError(err instanceof Error ? err.message : t('history.errorTitle'))
      })
  }, [projectId, t])

  useEffect(() => {
    load()
    return () => {
      if (activeLoadRef.current) {
        activeLoadRef.current.cancelled = true
        activeLoadRef.current = null
      }
    }
  }, [load])

  // Topic tags actually present on this project's conversations, in the fixed
  // vocabulary order — the tag filter only offers chips that match something.
  const availableTags = useMemo(() => {
    const present = new Set<ConversationTagKey>()
    for (const c of conversations ?? []) {
      for (const tag of c.tags) present.add(tag)
    }
    return CONVERSATION_TAG_KEYS.filter((key) => present.has(key))
  }, [conversations])

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return (conversations ?? []).filter((c) => {
      if (query && !c.title.toLowerCase().includes(query)) return false
      // OR semantics: a conversation matches if it carries ANY selected tag.
      if (selectedTags.length > 0 && !selectedTags.some((tag) => c.tags.includes(tag))) {
        return false
      }
      return true
    })
  }, [conversations, searchQuery, selectedTags])

  const chatHref = `/app/projects/${projectId}/chat`

  const chips: Array<{ key: HistoryFilter; label: string }> = [
    { key: 'all', label: t('history.filterAll') },
    { key: 'conversations', label: t('history.conversationsHeading') },
    { key: 'research', label: t('history.researchHeading') },
  ]

  const showConversations = filter === 'all' || filter === 'conversations'
  const showResearch = filter === 'all' || filter === 'research'

  return (
    <div>
      {/* ---- Title + search pill (dummy: one row, justify-between) ---- */}
      <div className="mb-7 flex min-h-9 flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-medium tracking-tight text-foreground">
          {t('sections.history')}
        </h1>
        <div className="relative w-full sm:w-64">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-[15px] -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('history.searchPlaceholder')}
            aria-label={t('history.searchAria')}
            className="h-9 w-full rounded-md border-[0.5px] border-border bg-card pl-9 pr-3 text-[13px] shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
      </div>

      {/* ---- Filter chips (dummy shape; real item-type signal, no faked source dots) ---- */}
      <div className="mb-4 flex flex-wrap gap-[7px]" role="group" aria-label={t('history.filterAria')}>
        {chips.map((chip) => {
          const active = filter === chip.key
          return (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilter(chip.key)}
              aria-pressed={active}
              className={cn(
                'inline-flex h-7 items-center rounded-md border-[0.5px] px-3 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                active
                  ? 'border-border bg-card font-medium text-foreground shadow-xs'
                  : 'border-transparent text-muted-foreground hover:bg-accent',
              )}
            >
              {chip.label}
            </button>
          )
        })}
      </div>

      {/* ---- Topic tag filter (only tags that appear on this project's chats) ---- */}
      {showConversations && availableTags.length > 0 && (
        <div
          className="mb-4 flex flex-wrap items-center gap-[7px]"
          role="group"
          aria-label={t('history.tagFilterAria')}
        >
          <span className="mr-0.5 text-[12px] text-muted-foreground">{t('history.tagFilterLabel')}</span>
          {availableTags.map((key) => {
            const active = selectedTags.includes(key)
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleTag(key)}
                aria-pressed={active}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md border-[0.5px] px-2.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                  active
                    ? 'border-border bg-card font-medium text-foreground shadow-xs'
                    : 'border-transparent text-muted-foreground hover:bg-accent',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-[7px] rounded-full',
                    active ? 'bg-source-auto' : 'bg-muted-foreground/50',
                  )}
                />
                {tagLabel(key)}
              </button>
            )
          })}
          {selectedTags.length > 0 && (
            <button
              type="button"
              onClick={() => setSelectedTags([])}
              className="ml-0.5 inline-flex h-7 items-center rounded-md px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {t('history.tagFilterClear')}
            </button>
          )}
        </div>
      )}

      <div>
        {/* ---- Conversations ---- */}
        {showConversations && (
          <section aria-label={t('history.conversationsHeading')}>
            {error ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>{t('history.errorTitle')}</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-3">
                  <span>{error}</span>
                  <Button variant="outline" size="sm" onClick={() => load()}>
                    {t('history.tryAgain')}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : conversations === null ? (
              <div className="overflow-hidden rounded-lg border-[0.5px] border-border bg-card shadow-xs">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-3 border-b-[0.5px] border-border px-5 py-3.5"
                  >
                    <Skeleton className="size-3.5 rounded-full" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Skeleton className="h-3.5 w-48" />
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                    <Skeleton className="h-3 w-16" />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              searchQuery.trim() || selectedTags.length > 0 ? (
                <EmptyState
                  icon={MessageSquare}
                  title={t('history.noMatchesTitle')}
                  description={t('history.noMatchesDescription')}
                />
              ) : (
                <EmptyState
                  icon={MessageSquare}
                  title={t('history.emptyTitle')}
                  description={t('history.emptyDescription')}
                  action={
                    <Button asChild>
                      <Link href={chatHref}>{t('history.emptyAction')}</Link>
                    </Button>
                  }
                />
              )
            ) : (
              <div className="overflow-hidden rounded-lg border-[0.5px] border-border bg-card shadow-xs">
                <Stagger>
                  {filtered.map((conversation) => {
                    const title = conversation.title || t('history.untitledConversation')
                    return (
                      <StaggerItem key={conversation.id}>
                        <Link
                          href={`${chatHref}?session=${encodeURIComponent(conversation.id)}`}
                          aria-label={t('history.openConversation', { title })}
                          className="flex items-center gap-3 border-b-[0.5px] border-border px-5 py-3.5 outline-none transition-colors duration-200 ease-out hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                        >
                          <span
                            aria-hidden
                            className="box-border inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-dashed border-source-auto"
                          >
                            <span className="size-[5px] rounded-full bg-source-auto" />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-[13px] font-medium text-foreground" title={title}>
                              {title}
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-1.5">
                              <span className="text-[11.5px] text-muted-foreground">
                                {t('history.typeConversation')}
                              </span>
                              {conversation.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="inline-flex h-[18px] items-center rounded-full border-[0.5px] border-border bg-accent/40 px-2 text-[10.5px] font-medium text-muted-foreground"
                                >
                                  {tagLabel(tag)}
                                </span>
                              ))}
                            </span>
                          </span>
                          <span
                            className="shrink-0 text-xs text-muted-foreground"
                            title={formatAbsoluteTime(conversation.updatedAt, locale)}
                          >
                            {formatRelativeTime(conversation.updatedAt, locale)}
                          </span>
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        </Link>
                      </StaggerItem>
                    )
                  })}
                </Stagger>
              </div>
            )}
          </section>
        )}

        {/* ---- Deep research runs (FB-10, server truth) ---- */}
        {showResearch && (
          <section aria-label={t('history.researchHeading')}>
            <ResearchRunsList projectId={projectId} projectCollection={projectCollection} />
          </section>
        )}
      </div>
    </div>
  )
}
