/**
 * SessionsPanel Component
 *
 * The history sheet: this project's chats AND its deep-research runs, newest
 * first, grouped by day. Opened from the chat toolbar's history door, it rises
 * as a page sheet over the chat — the History page it replaced is gone, and
 * this one surface is the whole record of the project's past.
 *
 * It reads as a sibling of the Inbox and Archiv sheets: the same wide sheet,
 * the same centred `max-w-3xl` reading column, the same `bg-card` divided
 * lists. Anatomy, top to bottom — the order is the sheet's argument about what
 * it is for:
 *
 *   header       "Chat history · N chats" — the sheet names itself and its size.
 *   pinned block New chat, the search field, and (flag on) the All / Chats /
 *                Deep Research scope filter. All stay put while the list
 *                scrolls: a search field that scrolls away is unusable exactly
 *                when the list is long enough to need it. The search covers
 *                runs as well as chats — one query over the whole past — and
 *                the filter composes with it rather than replacing it.
 *   list         the ONLY scrolling region, with sticky day headings and a
 *                bottom scroll fade; the Deep-research block leads, always
 *                open, with honest loading and error states of its own.
 *   footer       what "saved" means here (chats live in the workspace, not
 *                this browser), and delete-all — the destructive bulk action,
 *                parked at the far end of the sheet rather than one row above
 *                the list it destroys.
 */

'use client'

import {
  type FC,
  type KeyboardEvent,
  forwardRef,
  memo,
  useCallback,
  useMemo,
  useState,
  useRef,
  useEffect,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import Link from 'next/link'
import {
  AlertCircle,
  CircleEllipsis,
  FileCheck2,
  FlaskConical,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Item, ItemContent, ItemList, ItemMedia } from '@/components/ui/item'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PageSheet } from '@/components/ui/page-sheet'
import { AnimatePresence, motion, motionQuick } from '@/components/motion'
import { cn } from '@/lib/utils'
import { formatAbsoluteTime, formatRelativeTime, formatTimeOfDay } from '@/lib/format'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useLocale, useTranslations } from '@/i18n'
import { listResearchRuns, type ResearchRun } from '@/adapters/api/research-runs-client'
import { useLayoutStore } from '../store'
import { useChatStore } from '@/features/chat'
import { DeleteSessionConfirmationModal } from './DeleteSessionConfirmationModal'
import { DeleteAllSessionsConfirmationModal } from './DeleteAllSessionsConfirmationModal'

interface Session {
  id: string
  title: string
  date: Date
  hasActiveDeepResearch?: boolean
  hasCompletedReport?: boolean
  hasExpiredReport?: boolean
}

/**
 * Which half of the record the list shows. Only rendered (and only meaningful)
 * when the deep-research section is enabled — without it the panel is chats
 * only and needs no filter.
 */
type HistoryScope = 'all' | 'chats' | 'research'

const HISTORY_SCOPES: readonly HistoryScope[] = ['all', 'chats', 'research']

const isHistoryScope = (value: string): value is HistoryScope =>
  (HISTORY_SCOPES as readonly string[]).includes(value)

const SCOPE_LABEL_KEY: Record<HistoryScope, string> = {
  all: 'sessionsPanel.filterAll',
  chats: 'sessionsPanel.filterChats',
  research: 'sessionsPanel.filterResearch',
}

interface SessionsPanelProps {
  /** List of sessions to display */
  sessions?: Session[]
  /** Currently selected session ID */
  selectedSessionId?: string
  /** Callback when a session is selected */
  onSelectSession?: (sessionId: string) => void
  /** Callback when new session is clicked */
  onNewSession?: () => void
  /** Callback when a session is deleted */
  onDeleteSession?: (sessionId: string) => void
  /** Callback when all sessions are deleted */
  onDeleteAllSessions?: () => void
  /** Callback when a session is renamed */
  onRenameSession?: (sessionId: string, newTitle: string) => void
  /**
   * FB-10: render the server-backed "Deep Research" section, the scope filter
   * and per-session research label chips (gated by the
   * `research-in-chat-history` flag, threaded from MainLayout). Default off so
   * existing callers are unaffected.
   */
  showDeepResearchSection?: boolean
  /** Active project id — builds the `?job=` deep links for research runs. */
  projectId?: string
  /** Qdrant collection scoping the research-runs fetch (FB-10). */
  projectCollection?: string
}

/**
 * Chat-history panel with the project's chats grouped by day.
 * Opens from the left side of the screen.
 */
export const SessionsPanel: FC<SessionsPanelProps> = memo(function SessionsPanel({
  sessions = [],
  selectedSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onDeleteAllSessions,
  onRenameSession,
  showDeepResearchSection = false,
  projectId,
  projectCollection,
}) {
  const t = useTranslations('research')
  const tCommon = useTranslations('common')
  const { locale } = useLocale()
  const isMobile = useIsMobile()
  const isSessionsPanelOpen = useLayoutStore((s) => s.isSessionsPanelOpen)
  const setSessionsPanelOpen = useLayoutStore((s) => s.setSessionsPanelOpen)

  const isSessionBusy = useChatStore((s) => s.isSessionBusy)
  const anySessionBusy = useChatStore((s) => s.hasAnyBusySession())
  const refreshDeepResearchSessionStatuses = useChatStore(
    (s) => s.refreshDeepResearchSessionStatuses
  )
  // Navigation-specific busy check: only shallow thinking (WebSocket) and HITL prompts
  // block session switching. Deep research runs server-side and can be reconnected,
  // so it should NOT prevent navigation.
  const { isStreaming, hasPendingInteraction } = useChatStore(
    useShallow((s) => ({
      isStreaming: s.isStreaming,
      hasPendingInteraction: s.pendingInteraction !== null,
    }))
  )
  const isNavigationBlocked = isStreaming || hasPendingInteraction
  const [searchQuery, setSearchQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState<HistoryScope>('all')
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteAllModalOpen, setDeleteAllModalOpen] = useState(false)
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null)
  const refreshStatusesInFlightRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // FB-10: server-truth deep-research runs for the "Deep Research" section.
  // Fetched on panel open (like the status refresh above) so the list includes
  // headless/CLI jobs that never touched local storage. Null = not yet loaded;
  // [] = loaded, empty.
  const [deepResearchRuns, setDeepResearchRuns] = useState<ResearchRun[] | null>(null)
  // A failed fetch must not masquerade as "no runs": the flag switches the
  // section to an inline error line with a retry, instead of silence.
  const [deepResearchError, setDeepResearchError] = useState(false)
  const deepResearchFetchInFlightRef = useRef(false)
  // Tracks the projectCollection the current fetch belongs to. Only an identity
  // change (a different collection) invalidates an in-flight result — closing the
  // panel must NOT, because the component stays mounted and the data is still
  // valid on reopen.
  const deepResearchCollectionRef = useRef<string | null>(null)

  useEffect(() => {
    if (isSessionsPanelOpen && !refreshStatusesInFlightRef.current) {
      refreshStatusesInFlightRef.current = true
      void Promise.resolve(refreshDeepResearchSessionStatuses()).finally(() => {
        refreshStatusesInFlightRef.current = false
      })
    }
  }, [isSessionsPanelOpen, refreshDeepResearchSessionStatuses])

  // A query — or a scope filter — left behind from last time is a filtered list
  // the user did not ask for, and one that can hide the chat they came back
  // for. Reset both on close.
  useEffect(() => {
    if (!isSessionsPanelOpen) {
      setSearchQuery('')
      setScopeFilter('all')
    }
  }, [isSessionsPanelOpen])

  // FB-10: load the project's research runs.
  //
  // The in-flight ref is purely a concurrent-dedup guard; it does NOT discard
  // resolved data. Crucially, a quick close→reopen while the fetch is pending
  // must still populate the section once it resolves — the component stays
  // mounted, so the result is never stale. We therefore always set state on
  // settle and only ignore a result whose projectCollection has since changed.
  const fetchDeepResearchRuns = useCallback(() => {
    if (!projectCollection) return
    if (deepResearchFetchInFlightRef.current) return
    deepResearchFetchInFlightRef.current = true
    const requestedCollection = projectCollection
    deepResearchCollectionRef.current = requestedCollection
    setDeepResearchError(false)
    listResearchRuns({ projectCollection: requestedCollection, limit: 50 })
      .then((response) => {
        // Only a projectCollection (identity) change invalidates this result;
        // panel visibility does not.
        if (deepResearchCollectionRef.current !== requestedCollection) return
        // Newest-first: the panel surfaces the most recent runs at the top.
        const sorted = [...response.jobs].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
        setDeepResearchRuns(sorted)
      })
      .catch(() => {
        if (deepResearchCollectionRef.current === requestedCollection) setDeepResearchError(true)
      })
      .finally(() => {
        deepResearchFetchInFlightRef.current = false
      })
  }, [projectCollection])

  // Fetch on panel open (flag on) — and again from the retry button below.
  useEffect(() => {
    if (!isSessionsPanelOpen || !showDeepResearchSection || !projectCollection) return
    fetchDeepResearchRuns()
  }, [isSessionsPanelOpen, showDeepResearchSection, projectCollection, fetchDeepResearchRuns])

  const handleDeleteClick = useCallback((sessionId: string) => {
    setSessionToDelete(sessionId)
    setDeleteModalOpen(true)
  }, [])

  const handleConfirmDelete = useCallback(() => {
    if (sessionToDelete) {
      onDeleteSession?.(sessionToDelete)
      setSessionToDelete(null)
    }
  }, [sessionToDelete, onDeleteSession])

  const handleDeleteAllClick = useCallback(() => {
    setDeleteAllModalOpen(true)
  }, [])

  const handleConfirmDeleteAll = useCallback(() => {
    onDeleteAllSessions?.()
  }, [onDeleteAllSessions])

  const handleClose = useCallback(() => {
    setSessionsPanelOpen(false)
  }, [setSessionsPanelOpen])

  const handleNewSession = useCallback(() => {
    onNewSession?.()
    handleClose()
  }, [onNewSession, handleClose])

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      onSelectSession?.(sessionId)
      handleClose()
    },
    [onSelectSession, handleClose]
  )

  const handleClearSearch = useCallback(() => {
    setSearchQuery('')
    searchInputRef.current?.focus()
  }, [])

  const untitledLabel = t('sessionsPanel.untitledSession')
  const trimmedQuery = searchQuery.trim()
  const isSearching = trimmedQuery !== ''

  const filteredSessions = useMemo(() => {
    // Show ALL sessions, including brand-new ones with an empty title — they
    // render with the "untitled" placeholder in the row so they stay findable.
    // A query matches the stored title, and for untitled chats the placeholder
    // the user actually SEES, so what is on screen is what is searchable.
    if (!trimmedQuery) return sessions
    const query = trimmedQuery.toLowerCase()
    return sessions.filter((s) => {
      const title = s.title.trim() || untitledLabel
      return title.toLowerCase().includes(query)
    })
  }, [sessions, trimmedQuery, untitledLabel])

  const todayLabel = t('sessionsPanel.today')
  const groupedSessions = useMemo(
    () =>
      groupSessionsByDate(
        filteredSessions,
        {
          today: todayLabel,
          yesterday: t('sessionsPanel.yesterday'),
        },
        locale
      ),
    [filteredSessions, t, todayLabel, locale]
  )
  const hasSessions = sessions.length > 0
  const isEmptyState = filteredSessions.length === 0

  // FB-10: map a run's originating conversation to the local session title so a
  // run reads as its chat rather than an opaque job hash. Falls back to the
  // shared "untitled run" label when the job is headless/CLI or its session
  // isn't in local storage.
  const sessionTitleById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of sessions) {
      const title = s.title.trim()
      if (title) map[s.id] = title
    }
    return map
  }, [sessions])

  const runLabel = useCallback(
    (run: ResearchRun): string => {
      const title = run.conversation_id ? sessionTitleById[run.conversation_id] : undefined
      return title ?? t('runsList.untitledRun')
    },
    [sessionTitleById, t]
  )

  // The chat page's ?job= loader resolves any job id; failed runs deep-link to
  // the thinking tab (no report to show) so the run can still be diagnosed.
  const runHref = useCallback(
    (run: ResearchRun): string => {
      const base = `/app/projects/${projectId}/chat?job=${run.job_id}`
      return run.status === 'failed' ? `${base}&tab=thinking` : base
    },
    [projectId]
  )

  // The search covers runs as well as chats: one query over the whole past.
  const filteredRuns = useMemo(() => {
    const runs = deepResearchRuns ?? []
    if (!trimmedQuery) return runs
    const query = trimmedQuery.toLowerCase()
    return runs.filter((run) => runLabel(run).toLowerCase().includes(query))
  }, [deepResearchRuns, trimmedQuery, runLabel])

  const deepResearchEnabled = showDeepResearchSection && Boolean(projectId)
  const researchScopeSelected = deepResearchEnabled && scopeFilter === 'research'
  const showChats = !deepResearchEnabled || scopeFilter !== 'research'
  const isResearchLoading = deepResearchRuns === null && !deepResearchError

  // The section stays quiet when there is nothing to say (zero runs under the
  // "All" scope) but never lies: a pending fetch shows skeletons and a failed
  // one shows the error line — and under the Deep Research scope the section is
  // the whole list, so it always renders, empty state included.
  const showResearchSection =
    deepResearchEnabled &&
    scopeFilter !== 'chats' &&
    (researchScopeSelected || isResearchLoading || deepResearchError || filteredRuns.length > 0)

  return (
    <PageSheet
      open={isSessionsPanelOpen}
      onOpenChange={(next) => {
        if (!next) handleClose()
      }}
      title={t('sessionsPanel.title')}
      // The sheet states its own size, so "is this all of them?" is answered
      // before it is asked.
      subtitle={
        hasSessions
          ? sessions.length === 1
            ? t('sessionsPanel.countLabelOne')
            : t('sessionsPanel.countLabel', { count: sessions.length })
          : undefined
      }
      closeLabel={t('sessionsPanel.close')}
      // Finding a past chat is why this sheet gets opened, so the search field
      // is where focus belongs — except on mobile, where it would throw up the
      // on-screen keyboard over the very list the user came to read.
      initialFocusRef={isMobile ? undefined : searchInputRef}
      bodyClassName="flex min-h-0 flex-col"
    >
      {/* ---- Pinned block: the controls that must never scroll away ----
          The sheet's width is the place; the centred `max-w-3xl` column is the
          measure — the same geometry as the Inbox sheet, applied per band so
          the footer's border can still run edge to edge. */}
      <div className="shrink-0 px-4 pb-3 pt-4 md:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {/* New chat is disabled and every row is dimmed while a turn is in
              flight. Say why, ABOVE the controls it explains, rather than leaving
              the user to test them one by one. The spinner carries "temporary"
              without spending a word on it. */}
          {isNavigationBlocked && (
            <p
              className="border-border bg-muted text-muted-foreground flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-xs"
              role="status"
            >
              {/* Spinner injects its own role=status; hide it so this region
                  announces the message once rather than "Loading" + the copy. */}
              <span aria-hidden="true">
                <Spinner size="sm" className="mt-0.5 shrink-0" />
              </span>
              <span>{t('sessionsPanel.navigationBlocked')}</span>
            </p>
          )}

          <Button
            variant="outline"
            className="h-9 w-full justify-start gap-2"
            onClick={handleNewSession}
            disabled={isNavigationBlocked}
            aria-label={
              isNavigationBlocked
                ? t('sessionsPanel.newSessionDisabled')
                : t('sessionsPanel.startNewSession')
            }
            title={
              isNavigationBlocked
                ? t('sessionsPanel.cannotCreateActive')
                : t('sessionsPanel.startNewSession')
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            <span className="text-sm font-medium">{t('sessionsPanel.newSessionButton')}</span>
          </Button>

          {/* No list, nothing to search — the field would be a control that can
              only ever return nothing. */}
          {hasSessions && (
            <div className="flex flex-col gap-1.5">
              {/* Same molecule as every other search in the product (`DataToolbar`,
                  file search). `type="text"` so specs still query a textbox;
                  `inputRef` receives the sheet's initial focus (desktop). */}
              <SearchField
                type="text"
                inputRef={searchInputRef}
                value={searchQuery}
                onChange={setSearchQuery}
                onClear={handleClearSearch}
                placeholder={t('sessionsPanel.searchPlaceholder')}
                label={t('sessionsPanel.searchAria')}
                clearLabel={t('sessionsPanel.clearSearch')}
              />
              {/* Says how much of the list the query is hiding — announced, so a
                  screen-reader user learns it without scanning the list. */}
              {isSearching && (
                <p className="text-muted-foreground px-0.5 text-xs" aria-live="polite">
                  {t('sessionsPanel.searchResults', {
                    count: filteredSessions.length,
                    total: sessions.length,
                  })}
                </p>
              )}
            </div>
          )}

          {/* Scope filter (FB-10) — the inbox toolbar pattern. It composes with
              the search: the query still covers whichever list is showing. */}
          {deepResearchEnabled && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={scopeFilter}
              onValueChange={(value) => {
                // type=single can emit "" when the pressed item is clicked
                // again; the list always has a scope, so ignore a clear.
                if (isHistoryScope(value)) setScopeFilter(value)
              }}
              aria-label={t('sessionsPanel.filterAria')}
            >
              {HISTORY_SCOPES.map((scope) => (
                <ToggleGroupItem key={scope} value={scope}>
                  {t(SCOPE_LABEL_KEY[scope])}
                  {scope === 'research' && (
                    // Always mounted: appearing only when there are runs would
                    // grow the segment and shove its neighbours sideways.
                    // Invisible at zero keeps the slot; `aria-hidden` so the
                    // radio does not read "Deep Research 0".
                    <CountPill
                      className={cn((deepResearchRuns?.length ?? 0) === 0 && 'invisible')}
                      aria-hidden={(deepResearchRuns?.length ?? 0) === 0 || undefined}
                    >
                      {deepResearchRuns?.length ?? 0}
                    </CountPill>
                  )}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </div>
      </div>

      {/* ---- The one scrolling region ----
          `scroll-fade-bottom` dissolves the last row at the edge instead of
          guillotining it (design language, "Scroll boundaries"). No row
          stagger, deliberately: the user opened this to reach a specific row,
          and a cascade delays precisely the row they are reaching for — the
          sheet's own rise is the arrival. */}
      <div className="scroll-fade-bottom flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-6 md:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
          {/* Deep Research (FB-10) — server-truth runs for this project, always
              open, with a count. Includes headless/CLI jobs that have no local
              session. Quiet under "All" when there is nothing to show; the
              whole list under the Deep Research scope. */}
          {showResearchSection && (
            <section data-testid="deep-research-section" className="mb-4 flex flex-col gap-1.5">
              <SectionLabel
                as="h3"
                icon={FlaskConical}
                className="flex items-center gap-1.5 pt-1"
              >
                {t('sessionsPanel.deepResearchHeading')}
                <CountPill
                  className={cn(filteredRuns.length === 0 && 'invisible')}
                  aria-hidden={filteredRuns.length === 0 || undefined}
                >
                  {filteredRuns.length}
                </CountPill>
              </SectionLabel>

              {isResearchLoading ? (
                // Skeletons shaped like the real rows (media disc + title +
                // badge), never a spinner — the inbox's loading treatment.
                <ItemList
                  as="ul"
                  aria-busy="true"
                  data-testid="deep-research-skeleton"
                  className="bg-card shadow-xs"
                >
                  {Array.from({ length: 2 }).map((_, index) => (
                    <Item as="li" key={index} className="items-start py-3.5">
                      <ItemMedia>
                        <Skeleton className="size-8 shrink-0 rounded-full" />
                      </ItemMedia>
                      <ItemContent className="flex flex-col gap-2">
                        <Skeleton className="h-3.5 w-3/5" />
                        <Skeleton className="h-4 w-24" />
                      </ItemContent>
                    </Item>
                  ))}
                </ItemList>
              ) : deepResearchError ? (
                // A failed fetch must never read as "no runs": one quiet line
                // with the way to try again, beside the lists that still work.
                <div className="border-border bg-card flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 shadow-xs">
                  <p className="text-muted-foreground text-xs">
                    {t('sessionsPanel.researchLoadFailed')}
                  </p>
                  <Button variant="outline" size="sm" onClick={fetchDeepResearchRuns}>
                    {tCommon('actions.retry')}
                  </Button>
                </div>
              ) : filteredRuns.length === 0 ? (
                // Only reachable under the Deep Research scope (the section is
                // hidden when "All" has nothing to show).
                isSearching ? (
                  <EmptyState
                    variant="bare"
                    icon={Search}
                    title={t('sessionsPanel.noMatching')}
                    description={t('sessionsPanel.noMatchingDescription', { query: trimmedQuery })}
                    action={
                      <Button variant="outline" size="sm" onClick={handleClearSearch}>
                        {t('sessionsPanel.clearSearch')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    variant="bare"
                    icon={FlaskConical}
                    title={t('sessionsPanel.noRuns')}
                    description={t('sessionsPanel.noRunsDescription')}
                  />
                )
              ) : (
                <ItemList as="ul" className="bg-card shadow-xs">
                  {filteredRuns.map((run) => (
                    <Item key={run.job_id} as="li" className="relative items-start py-3.5">
                      {/* The media disc mirrors the inbox anatomy; a failed run
                          is the one tinted case, and its Badge below says the
                          same in words — colour never travels alone. */}
                      <ItemMedia
                        aria-hidden
                        className={cn(
                          'mt-0.5 rounded-full border',
                          run.status === 'failed'
                            ? 'border-transparent bg-destructive/10 text-destructive'
                            : 'border-border bg-card text-muted-foreground'
                        )}
                      >
                        <RunStatusIcon status={run.status} />
                      </ItemMedia>
                      <ItemContent>
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          {/* Stretched link: the whole row is the target. The
                              truncation lives on an inner span so the overlay
                              pseudo-element cannot be clipped by it. */}
                          <Link
                            href={runHref(run)}
                            onClick={handleClose}
                            aria-label={t('sessionsPanel.deepResearchRunLabel', {
                              label: runLabel(run),
                              status: t(runStatusKey(run.status)),
                            })}
                            className="min-w-0 flex-1 rounded-sm text-sm font-medium leading-snug outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                          >
                            <span className="block truncate" title={runLabel(run)}>
                              {runLabel(run)}
                            </span>
                          </Link>
                          <time
                            className="text-muted-foreground shrink-0 text-xs"
                            dateTime={run.created_at}
                            title={formatAbsoluteTime(run.created_at, locale)}
                          >
                            {formatRelativeTime(run.created_at, locale)}
                          </time>
                        </div>
                        {/* The state in WORDS, on its own line — a failed run
                            and a finished one used to differ only by icon. */}
                        <div className="mt-1.5 flex">
                          <Badge variant={runBadgeVariant(run.status)}>
                            {t(runStatusKey(run.status))}
                          </Badge>
                        </div>
                      </ItemContent>
                    </Item>
                  ))}
                </ItemList>
              )}
            </section>
          )}

          {showChats &&
            groupedSessions.map(([dateLabel, dateSessions]) => (
              // `last:mb-0` — the trailing group used to add 16px of dead scroll
              // below the final row.
              <div key={dateLabel} className="mb-4 flex flex-col gap-1.5 last:mb-0">
                {/* Sticky so the day you are scrolling through stays named. The
                    scroller is the offset parent, hence `top-0`; `-mx-2 px-2`
                    widens the opaque backing past the card's shadow so rows pass
                    UNDER it rather than beside it. */}
                <SectionLabel className="bg-background sticky top-0 z-10 -mx-2 px-2 pb-1.5 pt-1">
                  {dateLabel}
                </SectionLabel>
                <ItemList as="ul" className="bg-card shadow-xs">
                  {/* Deleting a row removes it, so the list needs an exit —
                      which CSS cannot give it — and `layout` so the rows below
                      close the gap instead of jumping. The inbox's pattern,
                      for the same reason. */}
                  <AnimatePresence initial={false} mode="popLayout">
                    {dateSessions.map((session) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        isSelected={selectedSessionId === session.id}
                        isBusy={isNavigationBlocked}
                        isSessionActive={isSessionBusy(session.id)}
                        showResearchLabel={showDeepResearchSection}
                        // The day is already on the group heading, so the row carries
                        // the part it does not: the time. Except under "Today", where
                        // "12 minutes ago" is the more useful reading of recency.
                        showRelativeTime={dateLabel === todayLabel}
                        onSelect={handleSessionClick}
                        onDelete={handleDeleteClick}
                        onRename={onRenameSession}
                      />
                    ))}
                  </AnimatePresence>
                </ItemList>
              </div>
            ))}

          {showChats && isEmptyState && (
            <div className="flex flex-1 flex-col items-center justify-center py-8">
              {isSearching ? (
                <EmptyState
                  variant="bare"
                  icon={Search}
                  title={t('sessionsPanel.noMatching')}
                  description={t('sessionsPanel.noMatchingDescription', { query: trimmedQuery })}
                  action={
                    <Button variant="outline" size="sm" onClick={handleClearSearch}>
                      {t('sessionsPanel.clearSearch')}
                    </Button>
                  }
                />
              ) : (
                // No CTA here: "New chat" is pinned two rows above and never
                // scrolls away, so a second identical button would only make the
                // reader decide which of the two to press.
                <EmptyState
                  variant="bare"
                  icon={MessageSquare}
                  title={t('sessionsPanel.noSessions')}
                  description={t('sessionsPanel.noSessionsDescription')}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---- Footer: what "saved" means, and the bulk destroyer at the far end ---- */}
      <div className="bg-background shrink-0 border-t px-4 py-3 md:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <p className="text-muted-foreground text-xs">{t('sessionsPanel.syncedNote')}</p>
          {/* Delete-all lives HERE, not above the list. It used to sit in the
              top row with equal weight to New chat — the loudest thing in the
              panel was the one action that destroys everything in it, one row
              above the rows it deletes. */}
          {hasSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive -ml-2 h-8 w-fit justify-start px-2"
              onClick={handleDeleteAllClick}
              disabled={anySessionBusy}
              aria-label={
                anySessionBusy ? t('sessionsPanel.deleteAllDisabled') : t('sessionsPanel.deleteAll')
              }
              title={
                anySessionBusy ? t('sessionsPanel.cannotDeleteBusy') : t('sessionsPanel.deleteAll')
              }
            >
              <Trash2 className="size-4" aria-hidden="true" />
              <span>{t('sessionsPanel.deleteAllButton')}</span>
            </Button>
          )}
        </div>
      </div>

      <DeleteSessionConfirmationModal
        open={deleteModalOpen}
        onOpenChange={setDeleteModalOpen}
        onConfirm={handleConfirmDelete}
        sessionTitle={sessions.find((s) => s.id === sessionToDelete)?.title}
      />

      <DeleteAllSessionsConfirmationModal
        open={deleteAllModalOpen}
        onOpenChange={setDeleteAllModalOpen}
        onConfirm={handleConfirmDeleteAll}
        count={sessions.length}
      />
    </PageSheet>
  )
})

/**
 * SessionItem Component
 *
 * One chat row inside the day group's card: status icon in a media disc, title,
 * timestamp, and hover/focus-revealed rename + delete actions.
 *
 * The row's one control is a BUTTON stretched over the whole row (the inbox's
 * stretched-link pattern), and the two actions are its SIBLINGS overlaid on
 * top — never children, which would be interactive content inside a widget.
 * The row owns its own <li> so it is the element that animates: exit + layout
 * under the list's `AnimatePresence`, so deleting a chat slides it out and the
 * rows below close the gap.
 */
interface SessionItemProps {
  session: Session
  isSelected: boolean
  /** Navigation block: true when shallow thinking (WS) or HITL prompt is pending.
   *  Deep research does NOT block navigation since it runs server-side. */
  isBusy?: boolean
  /** Per-session block: true when this specific session has active deep research */
  isSessionActive?: boolean
  /** FB-10: show a "Deep Research" chip when this session carries research status. */
  showResearchLabel?: boolean
  /** Relative ("3 hours ago") vs. clock time ("14:32") — see the call site. */
  showRelativeTime?: boolean
  onSelect?: (sessionId: string) => void
  onDelete?: (sessionId: string) => void
  onRename?: (sessionId: string, newTitle: string) => void
}

const SessionItem = forwardRef<HTMLLIElement, SessionItemProps>(function SessionItem(
  {
    session,
    isSelected,
    isBusy = false,
    isSessionActive = false,
    showResearchLabel = false,
    showRelativeTime = false,
    onSelect,
    onDelete,
    onRename,
  },
  ref
) {
  const t = useTranslations('research')
  const { locale } = useLocale()
  const [isHovered, setIsHovered] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(session.title)
  const inputRef = useRef<HTMLInputElement>(null)

  // Brand-new chats persist with an empty title — show a placeholder so the row
  // stays legible and the session remains findable in the history.
  const displayTitle = session.title.trim() || t('sessionsPanel.untitledSession')

  // Persistent timestamp from the session's date. Guard against unparseable
  // dates so a bad value never throws.
  const sessionDate = session.date instanceof Date ? session.date : new Date(session.date)
  const sessionIso = Number.isNaN(sessionDate.getTime()) ? '' : sessionDate.toISOString()
  const showResearchChip =
    showResearchLabel &&
    (isSessionActive ||
      session.hasActiveDeepResearch ||
      session.hasCompletedReport ||
      session.hasExpiredReport)

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleClick = useCallback(() => {
    if (!isEditing && !isBusy) {
      onSelect?.(session.id)
    }
  }, [isEditing, isBusy, onSelect, session.id])

  const handleEditClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setEditValue(session.title)
      setIsEditing(true)
    },
    [session.title]
  )

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onDelete?.(session.id)
    },
    [onDelete, session.id]
  )

  const handleSaveRename = useCallback(() => {
    const trimmedValue = editValue.trim()
    if (!trimmedValue) {
      setEditValue(session.title)
      setIsEditing(false)
      return
    }
    if (trimmedValue !== session.title) {
      onRename?.(session.id, trimmedValue)
    }
    setIsEditing(false)
  }, [editValue, session.id, session.title, onRename])

  const handleCancelRename = useCallback(() => {
    setEditValue(session.title)
    setIsEditing(false)
  }, [session.title])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSaveRename()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleCancelRename()
      }
    },
    [handleSaveRename, handleCancelRename]
  )

  const handleInputBlur = useCallback(() => {
    handleSaveRename()
  }, [handleSaveRename])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value)
  }, [])

  const showActions = (isHovered || isFocused) && !isEditing

  // One control, one name — the row's label carries the title AND the state its
  // icon depicts, so nothing on the row is visual-only.
  const statusKey = statusKeyFor(session, isSessionActive)
  const rowLabel = isBusy
    ? t('sessionsPanel.sessionLabelBusy', { title: displayTitle })
    : statusKey
      ? t('sessionsPanel.sessionLabelWithStatus', { title: displayTitle, status: t(statusKey) })
      : t('sessionsPanel.sessionLabel', { title: displayTitle })

  return (
    <Item
      asChild
      className={cn(
        'relative min-h-11 gap-3',
        showResearchChip ? 'items-start' : 'items-center',
        isBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        // Selected reads one surface step ABOVE hover (`accent` > `muted`), plus
        // an inset hairline ring — so the row the reader is IN stays
        // distinguishable from the row they are merely over. `focus-within`
        // mirrors hover so the revealed actions always sit on the same surface
        // their fade-out gradient names.
        isSelected
          ? 'bg-accent ring-border ring-1 ring-inset hover:bg-accent'
          : 'hover:bg-muted focus-within:bg-muted'
      )}
    >
      <motion.li
        ref={ref}
        layout
        exit={{ opacity: 0, x: 12 }}
        transition={motionQuick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        // Keyboard parity with hover: reveal the rename/delete actions while
        // focus is anywhere inside the row (focus/blur bubble in React).
        onFocus={() => setIsFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsFocused(false)
          }
        }}
      >
        {isEditing ? (
          <div className="flex min-h-8 w-full items-center">
            <Input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onBlur={handleInputBlur}
              className="h-8 min-w-0 flex-1 px-2.5"
              aria-label={t('sessionsPanel.editTitle')}
            />
          </div>
        ) : (
          <>
            {/* Decorative — the button's label already carries this state in
                words (see `statusKeyFor`). Sibling of the button: a <div> may
                not live inside one, and the stretched overlay keeps the disc
                clickable anyway. */}
            <ItemMedia
              aria-hidden
              className={cn(
                'border-border bg-card rounded-full border',
                showResearchChip && 'mt-0.5'
              )}
            >
              <SessionStatusIcon session={session} isSessionActive={isSessionActive} />
            </ItemMedia>

            <button
              type="button"
              onClick={handleClick}
              disabled={isBusy}
              aria-current={isSelected ? 'true' : undefined}
              aria-label={rowLabel}
              // Stretched over the whole row via the ::after overlay, the
              // inbox's pattern — so the row stays ONE control without nesting
              // the icon disc inside it.
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
            >
              {/* Two-line content block: title + persistent time on line 1, the
                  calm Deep Research badge on line 2. */}
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm" title={displayTitle}>
                  {displayTitle}
                </span>
                {sessionIso && (
                  <span
                    className="text-muted-foreground shrink-0 text-xs tabular-nums"
                    title={formatAbsoluteTime(sessionIso, locale)}
                  >
                    {showRelativeTime
                      ? formatRelativeTime(sessionIso, locale)
                      : formatTimeOfDay(sessionIso, locale)}
                  </span>
                )}
              </span>

              {/* FB-10: a calm "Deep Research" badge marks sessions that carry a
                  research run. It lives on its own line so it never swaps with
                  the trailing actions. */}
              {showResearchChip && (
                <Badge variant="secondary" className="mt-0.5">
                  {t('sessionsPanel.deepResearchChip')}
                </Badge>
              )}
            </button>
          </>
        )}

        {/* The actions OVERLAY the row on hover/focus instead of holding a
            permanent column that taxes every title's width. Overlaying is
            reflow-free (the row never resizes) and the resting row spends its
            full width on the title. The gradient fades the row out beneath the
            buttons so a long title slides under them instead of colliding —
            its colour names the surface the row is actually on: `accent` for
            the selected row, `muted` for the hovered/focused one. */}
        {showActions && (
          <div
            className={cn(
              'absolute inset-y-0 right-2 z-10 flex items-center gap-1 pl-6 animate-in fade-in-0 duration-snap ease-out motion-reduce:animate-none',
              isSelected
                ? '[background:linear-gradient(to_right,transparent,var(--accent)_1.5rem)]'
                : '[background:linear-gradient(to_right,transparent,var(--muted)_1.5rem)]'
            )}
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={handleEditClick}
              disabled={isBusy || isSessionActive}
              aria-label={
                isBusy || isSessionActive
                  ? t('sessionsPanel.renameDisabled')
                  : t('sessionsPanel.rename')
              }
              title={
                isBusy || isSessionActive
                  ? t('sessionsPanel.cannotRenameBusy')
                  : t('sessionsPanel.rename')
              }
            >
              <Pencil className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive size-7"
              onClick={handleDeleteClick}
              disabled={isBusy || isSessionActive}
              aria-label={
                isBusy || isSessionActive
                  ? t('sessionsPanel.deleteDisabled')
                  : t('sessionsPanel.deleteSession')
              }
              title={
                isBusy || isSessionActive
                  ? t('sessionsPanel.cannotDeleteBusy')
                  : t('sessionsPanel.deleteSession')
              }
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        )}
      </motion.li>
    </Item>
  )
})

/**
 * A run's status as a translation key. The backend's `submitted`/`running` (and
 * anything unrecognised) are all "still working" from the reader's side.
 */
const runStatusKey = (status: string): string => {
  if (status === 'completed') return 'sessionsPanel.runStatus.completed'
  if (status === 'failed') return 'sessionsPanel.runStatus.failed'
  if (status === 'cancelled') return 'sessionsPanel.runStatus.cancelled'
  return 'sessionsPanel.runStatus.running'
}

/**
 * The design language's status-badge mapping: completed = success,
 * running/submitted = info, failed = destructive, cancelled = neutral.
 */
const runBadgeVariant = (status: string): 'success' | 'info' | 'destructive' | 'secondary' => {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'destructive'
  if (status === 'cancelled') return 'secondary'
  return 'info'
}

/**
 * Status icon for a research run row (FB-10), drawn inside the row's media
 * disc. The disc supplies the colour (neutral ink; destructive tint for failed
 * runs), so the icon only carries shape — plus the spinner's motion for a run
 * still in flight. The row's Link carries the accessible name, so the icon
 * itself is decorative.
 */
const RunStatusIcon: FC<{ status: string }> = ({ status }) => {
  if (status === 'completed') {
    return <FileCheck2 className="size-4 shrink-0" aria-hidden="true" />
  }
  if (status === 'failed' || status === 'cancelled') {
    return <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
  }
  return <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
}

/**
 * The chat row's leading icon, inside the media disc. Purely DECORATIVE: the
 * row is a single button whose `aria-label` already carries the same state in
 * words (see `statusKeyFor`), so labelling the icon too would either be ignored
 * (the button's explicit label wins) or announced twice. It also may not nest a
 * live region inside a button.
 */
const SessionStatusIcon: FC<{
  session: Session
  isSessionActive: boolean
}> = ({ session, isSessionActive }) => {
  const base = 'size-4 shrink-0'
  const isActive = isSessionActive || session.hasActiveDeepResearch

  if (isActive) {
    return <Loader2 className={cn(base, 'text-accent-primary animate-spin')} aria-hidden="true" />
  }

  if (session.hasExpiredReport) {
    return <CircleEllipsis className={cn(base, 'text-muted-foreground')} aria-hidden="true" />
  }

  if (session.hasCompletedReport) {
    return <FileCheck2 className={cn(base, 'text-success')} aria-hidden="true" />
  }

  return <MessageSquare className={cn(base, 'text-muted-foreground')} aria-hidden="true" />
}

/**
 * The one piece of row state the icon conveys, as a translation key — so the
 * row's accessible name says in words what the icon says in colour and shape.
 * Null for an ordinary chat, which needs no qualifier.
 */
const statusKeyFor = (session: Session, isSessionActive: boolean): string | null => {
  if (isSessionActive || session.hasActiveDeepResearch) return 'sessionsPanel.sessionActive'
  if (session.hasExpiredReport) return 'sessionsPanel.reportExpired'
  if (session.hasCompletedReport) return 'sessionsPanel.reportCompleted'
  return null
}

/**
 * Groups sessions by relative date labels (Today, Yesterday, or date string).
 *
 * Returns an ORDERED list of [label, sessions] tuples sorted newest-first
 * (Today → Yesterday → older), so the panel always emits date groups
 * chronologically regardless of the incoming session order.
 */
const groupSessionsByDate = (
  sessions: Session[],
  labels: { today: string; yesterday: string },
  locale: string
): Array<[string, Session[]]> => {
  const groups = new Map<string, { sessions: Session[]; sortKey: number }>()
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  for (const session of sessions) {
    const sessionDate = new Date(session.date)
    let label: string

    if (isSameDay(sessionDate, today)) {
      label = labels.today
    } else if (isSameDay(sessionDate, yesterday)) {
      label = labels.yesterday
    } else {
      label = sessionDate.toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    }

    const time = sessionDate.getTime()
    const existing = groups.get(label)
    if (existing) {
      existing.sessions.push(session)
      existing.sortKey = Math.max(existing.sortKey, time)
    } else {
      groups.set(label, { sessions: [session], sortKey: time })
    }
  }

  return Array.from(groups.entries())
    .sort((a, b) => b[1].sortKey - a[1].sortKey)
    .map(([label, group]) => [label, group.sessions] as [string, Session[]])
}

const isSameDay = (d1: Date, d2: Date): boolean => {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  )
}
