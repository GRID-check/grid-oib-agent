'use client'

/**
 * Project History body (spec §5, FB-10) — a client list over the existing
 * conversations BFF domain plus the server-truth research-runs list.
 *
 * Conversations deep-link into chat via `?session=` (the same query param
 * `useSessionUrl` already reads on the chat page); research rows reuse
 * ResearchRunsList wholesale, whose rows deep-link via `?job=`. Search is a
 * plain client-side title filter — provenance filter chips need per-row
 * provenance data the conversation model doesn't carry today, so we don't
 * fake them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, MessageSquare, Search } from 'lucide-react'
import type { Conversation } from '@/lib/db/schema'
import { conversationsClient } from '@/adapters/api/conversations-client'
import { Stagger, StaggerItem } from '@/components/motion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
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
  updatedAt: string
}

const toRows = (conversations: Conversation[]): ConversationRow[] =>
  conversations
    .map((c) => ({
      id: c.id,
      title: (c.title ?? '').trim(),
      updatedAt: String(c.updatedAt),
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

export function ProjectHistory({ projectId, projectCollection }: ProjectHistoryProps): JSX.Element {
  const t = useTranslations('nav')
  const { locale } = useLocale()
  const [conversations, setConversations] = useState<ConversationRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

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

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return conversations ?? []
    return (conversations ?? []).filter((c) => c.title.toLowerCase().includes(query))
  }, [conversations, searchQuery])

  const chatHref = `/app/projects/${projectId}/chat`

  return (
    <div className="space-y-10">
      {/* ---- Conversations ---- */}
      <section aria-label={t('history.conversationsHeading')} className="mt-8 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('history.conversationsHeading')}
          </h2>
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
              aria-label={t('history.searchAria')}
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
        </div>

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
          <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
            <div className="divide-y divide-border">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="flex items-center justify-between gap-4 px-6 py-3.5">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-4 rounded" />
                    <Skeleton className="h-4 w-48" />
                  </div>
                  <Skeleton className="h-4 w-20" />
                </div>
              ))}
            </div>
          </div>
        ) : filtered.length === 0 ? (
          searchQuery.trim() ? (
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
          <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
            <Stagger className="divide-y divide-border">
              {filtered.map((conversation) => {
                const title = conversation.title || t('history.untitledConversation')
                return (
                  <StaggerItem key={conversation.id}>
                    <Link
                      href={`${chatHref}?session=${encodeURIComponent(conversation.id)}`}
                      aria-label={t('history.openConversation', { title })}
                      className="flex items-center justify-between gap-3 px-4 py-3.5 outline-none transition-colors duration-200 ease-out hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 sm:gap-4 sm:px-6"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate text-sm font-medium" title={title}>
                          {title}
                        </span>
                      </span>
                      <span
                        className="shrink-0 text-xs text-muted-foreground"
                        title={formatAbsoluteTime(conversation.updatedAt, locale)}
                      >
                        {formatRelativeTime(conversation.updatedAt, locale)}
                      </span>
                    </Link>
                  </StaggerItem>
                )
              })}
            </Stagger>
          </div>
        )}
      </section>

      {/* ---- Deep research runs (FB-10, server truth) ---- */}
      <section aria-label={t('history.researchHeading')} className="space-y-0">
        <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {t('history.researchHeading')}
        </h2>
        <ResearchRunsList projectId={projectId} projectCollection={projectCollection} />
      </section>
    </div>
  )
}
