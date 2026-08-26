'use client'

/**
 * Project History body (spec §5, FB-10) — a client list over the existing
 * conversations BFF domain plus the server-truth research-runs list, styled to
 * the click-dummy's Historie screen (search in the shared section header,
 * exclusive type ToggleGroup, ItemList rows).
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
import { AlertCircle, ChevronRight, MessageSquare } from 'lucide-react'
import type { Conversation } from '@/lib/db/schema'
import {
  CONVERSATION_TAG_KEYS,
  normalizeConversationTags,
  type ConversationTagKey,
} from '@/lib/conversations/tags'
import { conversationsClient } from '@/adapters/api/conversations-client'
import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemList,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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

const isHistoryFilter = (value: string): value is HistoryFilter =>
  value === 'all' || value === 'conversations' || value === 'research'

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
  const showSectionLabels = filter === 'all'

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
      <ProjectSectionActions>
        <SearchField
          type="text"
          className="w-full sm:w-64"
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t('history.searchPlaceholder')}
          label={t('history.searchAria')}
        />
      </ProjectSectionActions>

      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={filter}
        onValueChange={(value) => {
          // Radix single-select emits '' when the pressed item is toggled off.
          if (isHistoryFilter(value)) setFilter(value)
        }}
        className="mb-4"
        aria-label={t('history.filterAria')}
      >
        {chips.map((chip) => (
          <ToggleGroupItem key={chip.key} value={chip.key}>
            {chip.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {showConversations && availableTags.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SectionLabel>{t('history.tagFilterLabel')}</SectionLabel>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            value={selectedTags}
            onValueChange={(value) => setSelectedTags(normalizeConversationTags(value))}
            aria-label={t('history.tagFilterAria')}
          >
            {availableTags.map((key) => (
              <ToggleGroupItem key={key} value={key}>
                {tagLabel(key)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {selectedTags.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedTags([])}>
              {t('history.tagFilterClear')}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-8">
        {showConversations && (
          <section className="space-y-3" aria-label={t('history.conversationsHeading')}>
            {showSectionLabels ? (
              <SectionLabel as="h2">{t('history.conversationsHeading')}</SectionLabel>
            ) : null}
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
              <ItemList as="ul" className="list-none">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Item as="li" key={index}>
                    <ItemMedia className="size-3.5">
                      <Skeleton className="size-3.5 rounded-full" />
                    </ItemMedia>
                    <ItemContent>
                      <Skeleton className="h-3.5 w-48" />
                      <Skeleton className="mt-1.5 h-2.5 w-24" />
                    </ItemContent>
                    <ItemActions>
                      <Skeleton className="h-3 w-16" />
                    </ItemActions>
                  </Item>
                ))}
              </ItemList>
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
              <ItemList as="ul" className="list-none">
                {filtered.map((conversation) => {
                  const title = conversation.title || t('history.untitledConversation')
                  return (
                    <li key={conversation.id}>
                      <Item asChild className="group w-full">
                        <Link
                          href={`${chatHref}?session=${encodeURIComponent(conversation.id)}`}
                          aria-label={t('history.openConversation', { title })}
                        >
                          <ItemMedia className="size-3.5">
                            <span
                              aria-hidden
                              className="border-source-auto box-border inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-dashed"
                            >
                              <span className="bg-source-auto size-[5px] rounded-full" />
                            </span>
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle title={title}>{title}</ItemTitle>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <ItemDescription className="overflow-visible whitespace-normal">
                                {t('history.typeConversation')}
                              </ItemDescription>
                              {conversation.tags.map((tag) => (
                                <Chip key={tag} size="sm" variant="muted">
                                  {tagLabel(tag)}
                                </Chip>
                              ))}
                            </div>
                          </ItemContent>
                          <ItemActions>
                            <span
                              className="text-muted-foreground text-xs"
                              title={formatAbsoluteTime(conversation.updatedAt, locale)}
                            >
                              {formatRelativeTime(conversation.updatedAt, locale)}
                            </span>
                            <ChevronRight
                              className="text-muted-foreground duration-quick size-3.5 shrink-0 transition-transform ease-out group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                              aria-hidden
                            />
                          </ItemActions>
                        </Link>
                      </Item>
                    </li>
                  )
                })}
              </ItemList>
            )}
          </section>
        )}

        {showResearch && (
          <section className="space-y-3" aria-label={t('history.researchHeading')}>
            {showSectionLabels ? (
              <SectionLabel as="h2">{t('history.researchHeading')}</SectionLabel>
            ) : null}
            <ResearchRunsList projectId={projectId} projectCollection={projectCollection} />
          </section>
        )}
      </div>
    </div>
  )
}
