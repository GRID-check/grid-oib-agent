/**
 * SessionsPanel Component
 *
 * The chat-history panel: a docked aside listing this project's chats, newest
 * first, grouped by day. Opened from the chat toolbar's history door.
 *
 * Anatomy, top to bottom — the order is the panel's argument about what it is
 * for:
 *
 *   heading      "Chat history · N chats" — the panel names itself and its size.
 *   pinned block New chat, then the search field. Both stay put while the list
 *                scrolls: a search field that scrolls away is unusable exactly
 *                when the list is long enough to need it.
 *   list         the ONLY scrolling region, with sticky day headings.
 *   footer       what "saved" means here, a storage warning when one is due,
 *                and delete-all — the destructive bulk action, parked at the
 *                far end of the panel rather than one row above the list it
 *                destroys.
 */

'use client'

import {
  type FC,
  type KeyboardEvent,
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
  ChevronRight,
  CircleEllipsis,
  FileCheck2,
  FlaskConical,
  Loader2,
  MessageSquare,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Item, ItemList } from '@/components/ui/item'
import { SearchField } from '@/components/ui/search-field'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { formatAbsoluteTime, formatRelativeTime, formatTimeOfDay } from '@/lib/format'
import { motion } from '@/components/motion'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useLocale, useTranslations } from '@/i18n'
import { listResearchRuns, type ResearchRun } from '@/adapters/api/research-runs-client'
import { useLayoutStore } from '../store'
import { useChatStore } from '@/features/chat'
import { checkStorageHealth } from '@/features/chat/lib/storage-manager'
import { DeleteSessionConfirmationModal } from './DeleteSessionConfirmationModal'
import { DeleteAllSessionsConfirmationModal } from './DeleteAllSessionsConfirmationModal'
import { DockedPanel } from './DockedPanel'

/**
 * Percentage of the browser storage quota above which the panel says so. Below
 * this the line is pure noise — "Using 0% of browser storage quota" on every
 * open told nobody anything they could act on.
 */
const STORAGE_WARNING_PERCENT = 60

interface Session {
  id: string
  title: string
  date: Date
  hasActiveDeepResearch?: boolean
  hasCompletedReport?: boolean
  hasExpiredReport?: boolean
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
   * FB-10: render the server-backed "Deep Research" section and per-session
   * research label chips (gated by the `research-in-chat-history` flag,
   * threaded from MainLayout). Default off so existing callers are unaffected.
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
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteAllModalOpen, setDeleteAllModalOpen] = useState(false)
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null)
  const refreshStatusesInFlightRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // FB-10: server-truth deep-research runs for the collapsed "Deep Research"
  // section. Fetched on panel open (like the status refresh above) so the list
  // includes headless/CLI jobs that never touched local storage. Null = not yet
  // loaded; [] = loaded, empty.
  const [deepResearchRuns, setDeepResearchRuns] = useState<ResearchRun[] | null>(null)
  const [isDeepResearchOpen, setIsDeepResearchOpen] = useState(false)
  const deepResearchFetchInFlightRef = useRef(false)
  // Tracks the projectCollection the current fetch belongs to. Only an identity
  // change (a different collection) invalidates an in-flight result — closing the
  // panel must NOT, because the component stays mounted and the data is still
  // valid on reopen.
  const deepResearchCollectionRef = useRef<string | null>(null)

  // Storage usage percentage — refreshes only when the panel opens
  const [storagePercent, setStoragePercent] = useState<number>(0)
  useEffect(() => {
    if (isSessionsPanelOpen) {
      const { percentUsed } = checkStorageHealth()
      setStoragePercent(Math.round(percentUsed))
      if (!refreshStatusesInFlightRef.current) {
        refreshStatusesInFlightRef.current = true
        void Promise.resolve(refreshDeepResearchSessionStatuses()).finally(() => {
          refreshStatusesInFlightRef.current = false
        })
      }
    }
  }, [isSessionsPanelOpen, refreshDeepResearchSessionStatuses])

  // A query left behind from last time is a filtered list the user did not ask
  // for — and one that can hide the chat they came back for. Reset on close.
  useEffect(() => {
    if (!isSessionsPanelOpen) setSearchQuery('')
  }, [isSessionsPanelOpen])

  // FB-10: load the project's research runs when the panel opens (flag on).
  // Fail-soft: any error yields an empty section rather than a broken panel.
  //
  // The in-flight ref is purely a concurrent-dedup guard; it does NOT discard
  // resolved data. Crucially, a quick close→reopen while the fetch is pending
  // must still populate the section once it resolves — the component stays
  // mounted, so the result is never stale. We therefore always set state on
  // settle and only ignore a result whose projectCollection has since changed.
  useEffect(() => {
    if (!isSessionsPanelOpen || !showDeepResearchSection || !projectCollection) return
    if (deepResearchFetchInFlightRef.current) return
    deepResearchFetchInFlightRef.current = true
    const requestedCollection = projectCollection
    deepResearchCollectionRef.current = requestedCollection
    listResearchRuns({ projectCollection, limit: 50 })
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
        if (deepResearchCollectionRef.current === requestedCollection) setDeepResearchRuns([])
      })
      .finally(() => {
        deepResearchFetchInFlightRef.current = false
      })
  }, [isSessionsPanelOpen, showDeepResearchSection, projectCollection])

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

  const hasDeepResearchRuns = (deepResearchRuns?.length ?? 0) > 0
  const showDeepResearch = showDeepResearchSection && Boolean(projectId) && hasDeepResearchRuns

  return (
    <DockedPanel
      open={isSessionsPanelOpen}
      side="left"
      onClose={handleClose}
      forceMount
      aria-label={t('sessionsPanel.title')}
      // Finding a past chat is why this panel gets opened, so the search field
      // is where focus belongs — except on mobile, where it would throw up the
      // on-screen keyboard over the very list the user came to read.
      initialFocusRef={isMobile ? undefined : searchInputRef}
      heading={
        <>
          <MessageSquareText className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{t('sessionsPanel.title')}</span>
          {/* The panel states its own size, so "is this all of them?" is
              answered before it is asked. */}
          {hasSessions && (
            <span className="text-muted-foreground shrink-0 font-normal">
              {sessions.length === 1
                ? t('sessionsPanel.countLabelOne')
                : t('sessionsPanel.countLabel', { count: sessions.length })}
            </span>
          )}
        </>
      }
      footer={
        <div className="flex flex-col gap-2">
          {/* Only shown once the quota is close enough to act on, and then it
              says what to do about it. */}
          {storagePercent >= STORAGE_WARNING_PERCENT && (
            <p className="text-warning text-xs font-medium">
              {t('sessionsPanel.storageQuota', { percent: storagePercent })}
            </p>
          )}
          <p className="text-muted-foreground text-xs">{t('sessionsPanel.storageNote')}</p>
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
      }
    >
      {/* ---- Pinned block: the two controls that must never scroll away ---- */}
      <div className="flex shrink-0 flex-col gap-3 px-4 pb-3 pt-4">
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
                `inputRef` keeps DockedPanel's autofocus on this field. */}
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
      </div>

      {/* ---- The one scrolling region ----
          It used to be nested inside a second scroller (the panel body), and
          being `flex-1` without `min-h-0` it could not shrink — so a full list
          overflowed the panel and painted straight through the footer.

          The list fades in as ONE surface, driven by the open state rather than
          by mounting (forceMount keeps the panel in the DOM). It used to stagger
          every row through `fadeRise` (`opacity: 0, y: 8`) with an uncapped
          `staggerChildren: 0.05`, so row N only began animating after
          0.05 + N×0.05s — with a couple of dozen sessions the lower rows sat
          invisible AND pushed 8px down for over a second. A history panel is
          also the wrong place for a cascade: the user opened it to reach a
          specific row, and staggering delays precisely the row they are
          reaching for. */}
      <motion.div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-4"
        initial={false}
        animate={{ opacity: isSessionsPanelOpen ? 1 : 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        {/* Deep Research (FB-10) — server-truth runs for this project, collapsed
            by default with a count badge. Includes headless/CLI jobs that have
            no local session. Hidden entirely when there are no runs. */}
        {showDeepResearch && (
          <div className="border-border mb-3 shrink-0 border-b pb-3">
            <button
              type="button"
              onClick={() => setIsDeepResearchOpen((open) => !open)}
              aria-expanded={isDeepResearchOpen}
              data-testid="deep-research-toggle"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-2 rounded-md py-1.5 text-left text-sm font-semibold outline-none transition-colors duration-quick ease-out motion-reduce:transition-none focus-visible:ring-2 pointer-coarse:min-h-11"
            >
              <ChevronRight
                className={cn(
                  'size-4 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                  isDeepResearchOpen && 'rotate-90'
                )}
                aria-hidden="true"
              />
              <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
              <span>
                {t('sessionsPanel.deepResearchHeading', { count: deepResearchRuns?.length ?? 0 })}
              </span>
            </button>

            {isDeepResearchOpen && (
              <ItemList className="mt-1 flex flex-col gap-1 overflow-visible rounded-none border-0 divide-y-0 animate-in fade-in-0 duration-snap ease-out motion-reduce:animate-none">
                {(deepResearchRuns ?? []).map((run) => (
                  <Item
                    key={run.job_id}
                    asChild
                    // Same geometry and hover weight as a chat row (including the
                    // transparent border), so the two lists share one left edge.
                    className="hover:bg-muted focus-visible:ring-ring/50 min-h-11 items-start gap-2.5 rounded-lg border border-transparent py-2.5 pl-2.5 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:bg-transparent"
                  >
                    <Link
                      href={runHref(run)}
                      onClick={handleClose}
                      aria-label={t('sessionsPanel.deepResearchRunLabel', {
                        label: runLabel(run),
                        status: t(runStatusKey(run.status)),
                      })}
                    >
                      <RunStatusIcon status={run.status} className="mt-0.5" />
                      {/* Same two-line anatomy as a chat row, for the same reason:
                          the state goes on its own line instead of competing with
                          the title for width. Stating it in WORDS is the point —
                          a failed run and a finished one differed only by icon. */}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm" title={runLabel(run)}>
                            {runLabel(run)}
                          </span>
                          <span
                            className="text-muted-foreground shrink-0 text-xs"
                            title={formatAbsoluteTime(run.created_at, locale)}
                          >
                            {formatRelativeTime(run.created_at, locale)}
                          </span>
                        </span>
                        <Chip
                          size="sm"
                          variant={run.status === 'failed' ? 'destructive' : 'muted'}
                        >
                          {t(runStatusKey(run.status))}
                        </Chip>
                      </span>
                    </Link>
                  </Item>
                ))}
              </ItemList>
            )}
          </div>
        )}

        {groupedSessions.map(([dateLabel, dateSessions]) => (
          // `last:mb-0` — the trailing group used to add 16px of dead scroll
          // below the final row.
          <div key={dateLabel} className="mb-4 flex flex-col gap-1 last:mb-0">
            {/* Sticky so the day you are scrolling through stays named. This
                element is the scroll container, hence `top-0`; `-mx-4 px-4`
                widens the opaque backing to the panel's full width so rows
                pass UNDER it rather than beside it. */}
            <SectionLabel className="bg-background sticky top-0 z-10 -mx-4 px-4 pb-1.5 pt-1">
              {dateLabel}
            </SectionLabel>
            <ItemList className="flex flex-col gap-1 overflow-visible rounded-none border-0 divide-y-0">
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
            </ItemList>
          </div>
        ))}

        {isEmptyState && (
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
      </motion.div>

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
    </DockedPanel>
  )
})

/**
 * SessionItem Component
 *
 * One chat row: status icon, title, timestamp, and hover/focus-revealed
 * rename + delete actions.
 *
 * The row IS the button, and the two actions are its SIBLINGS overlaid on top —
 * not children. They used to be nested inside a `role="button"` div, which is
 * invalid (interactive content inside a widget role) and left assistive tech to
 * guess at a control containing two other controls.
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

const SessionItem: FC<SessionItemProps> = ({
  session,
  isSelected,
  isBusy = false,
  isSessionActive = false,
  showResearchLabel = false,
  showRelativeTime = false,
  onSelect,
  onDelete,
  onRename,
}) => {
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
    <div
      className="relative"
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
        <div className="flex min-h-11 w-full items-center py-2 pl-2.5 pr-2">
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
        <Item
          asChild
          className={cn(
            'focus-visible:ring-ring/50 min-h-11 w-full gap-2.5 rounded-lg border py-2 pl-2.5 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:bg-transparent',
            // A one-line row centres; a row with the research chip must align
            // its icon to the TITLE, not float to the middle of two lines.
            showResearchChip ? 'items-start py-2.5' : 'items-center',
            isBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            // Selected reads as a raised card (border + fill + subtle shadow); hover
            // sits one step BELOW it on the surface ladder (`muted` < `accent`), which
            // is what keeps the two distinguishable now that neither is an alpha of
            // the other.
            isSelected
              ? 'border-border bg-accent text-foreground shadow-sm hover:bg-accent'
              : 'hover:bg-muted border-transparent'
          )}
        >
          <button
            type="button"
            onClick={handleClick}
            disabled={isBusy}
            aria-current={isSelected ? 'true' : undefined}
            aria-label={rowLabel}
          >
            <SessionStatusIcon
              session={session}
              isSessionActive={isSessionActive}
              className={showResearchChip ? 'mt-0.5' : undefined}
            />

            {/* Two-line content block: title + persistent time on line 1, the
                calm Deep Research chip on line 2. */}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
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

              {/* FB-10: a calm "Deep Research" chip marks sessions that carry a
                  research run. It lives on its own line so it never swaps with
                  the trailing actions. */}
              {showResearchChip && (
                <Chip size="sm" variant="muted">
                  {t('sessionsPanel.deepResearchChip')}
                </Chip>
              )}
            </span>
          </button>
        </Item>
      )}

      {/* The actions OVERLAY the row on hover/focus instead of holding a
          permanent 64px column. Reserving that column did buy a reflow-free
          hover, but it charged every row a quarter of its width for controls
          that are almost never on screen — and the title, the only thing a user
          scans this list by, paid for it by truncating. Overlaying is still
          reflow-free (the row never resizes) and the resting row now spends its
          full width on the title. */}
      {showActions && (
        <div
          // Fade the row out beneath the buttons so a long title slides under
          // them instead of colliding with them. Both the hovered and the
          // selected row sit on --accent, so one ramp covers both.
          className="absolute inset-y-0 right-2 flex items-center gap-1 rounded-r-lg pl-6 [background:linear-gradient(to_right,transparent,var(--accent)_1.5rem)] animate-in fade-in-0 duration-snap ease-out motion-reduce:animate-none"
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
    </div>
  )
}

/**
 * Status icon for a research run row (FB-10). Mirrors SessionStatusIcon's
 * iconography: completed = document check, failed/cancelled = alert, everything
 * still in flight = a quiet spinner. The row's Link carries the accessible name,
 * so the icon itself is decorative.
 */
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

const RunStatusIcon: FC<{ status: string; className?: string }> = ({ status, className }) => {
  const base = cn('size-4 shrink-0', className)
  if (status === 'completed') {
    return <FileCheck2 className={cn(base, 'text-success')} aria-hidden="true" />
  }
  if (status === 'failed') {
    return <AlertCircle className={cn(base, 'text-destructive')} aria-hidden="true" />
  }
  if (status === 'cancelled') {
    return <AlertCircle className={cn(base, 'text-muted-foreground')} aria-hidden="true" />
  }
  return <Loader2 className={cn(base, 'text-accent-primary animate-spin')} aria-hidden="true" />
}

/**
 * The row's leading icon. Purely DECORATIVE: the row is a single button whose
 * `aria-label` already carries the same state in words (see `statusKeyFor`), so
 * labelling the icon too would either be ignored (the button's explicit label
 * wins) or announced twice. It also may not nest a live region inside a button.
 */
const SessionStatusIcon: FC<{
  session: Session
  isSessionActive: boolean
  className?: string
}> = ({ session, isSessionActive, className }) => {
  const base = cn('size-4 shrink-0', className)
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
