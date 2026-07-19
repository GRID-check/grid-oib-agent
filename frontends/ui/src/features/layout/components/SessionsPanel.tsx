/**
 * SessionsPanel Component
 *
 * Left panel displaying session history with new session and delete all buttons.
 * Docked aside that slides in from the left.
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
import { EmptyState } from '@/components/ui/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { motion, fadeRise, staggerParent, springGentle } from '@/components/motion'
import { useLocale, useTranslations } from '@/i18n'
import { listResearchRuns, type ResearchRun } from '@/adapters/api/research-runs-client'
import { useLayoutStore } from '../store'
import { useChatStore } from '@/features/chat'
import { checkStorageHealth } from '@/features/chat/lib/storage-manager'
import { DeleteSessionConfirmationModal } from './DeleteSessionConfirmationModal'
import { DeleteAllSessionsConfirmationModal } from './DeleteAllSessionsConfirmationModal'
import { DockedPanel } from './DockedPanel'

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
 * Sessions panel with history grouped by date.
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

  const filteredSessions = useMemo(() => {
    // Show ALL sessions, including brand-new ones with an empty title — they
    // render with a "Neuer Chat" placeholder in the row so they stay findable.
    // Search still filters by the stored title (untitled sessions carry no
    // searchable text, so a non-empty query naturally excludes them).
    if (!searchQuery.trim()) return sessions
    const query = searchQuery.toLowerCase()
    return sessions.filter((s) => s.title.toLowerCase().includes(query))
  }, [sessions, searchQuery])

  const groupedSessions = useMemo(
    () =>
      groupSessionsByDate(
        filteredSessions,
        {
          today: t('sessionsPanel.today'),
          yesterday: t('sessionsPanel.yesterday'),
        },
        locale
      ),
    [filteredSessions, t, locale]
  )
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
      className="w-full max-w-[406px]"
      heading={
        <>
          <MessageSquareText className="h-4 w-4" aria-hidden="true" />
          <span>{t('sessionsPanel.title')}</span>
        </>
      }
      footer={
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            {t('sessionsPanel.storageQuota', { percent: storagePercent })}
          </p>
          <p className="text-muted-foreground text-xs">{t('sessionsPanel.storageNote')}</p>
        </div>
      }
    >
      {/* Delete All + New Session */}
      {!isEmptyState && searchQuery.trim() === '' && (
        <div className="mb-4 flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={handleDeleteAllClick}
            disabled={anySessionBusy}
            aria-label={
              anySessionBusy ? t('sessionsPanel.deleteAllDisabled') : t('sessionsPanel.deleteAll')
            }
            title={
              anySessionBusy ? t('sessionsPanel.cannotDeleteBusy') : t('sessionsPanel.deleteAll')
            }
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm">{t('sessionsPanel.deleteAllButton')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
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
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-semibold">{t('sessionsPanel.newSessionButton')}</span>
          </Button>
        </div>
      )}
      {/* Search */}
      <div className="relative mb-4">
        <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('sessionsPanel.searchPlaceholder')}
          className="border-input bg-input-background placeholder:text-muted-foreground focus-visible:ring-ring/50 h-9 w-full rounded-lg border pl-8 pr-3 text-base outline-none focus-visible:ring-2 md:text-sm"
          aria-label={t('sessionsPanel.searchAria')}
        />
      </div>

      {/* Deep Research (FB-10) — server-truth runs for this project, collapsed
          by default with a count badge. Includes headless/CLI jobs that have no
          local session. Hidden entirely when there are no runs. */}
      {showDeepResearch && (
        <div className="mb-4 shrink-0 pb-2">
          <button
            type="button"
            onClick={() => setIsDeepResearchOpen((open) => !open)}
            aria-expanded={isDeepResearchOpen}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm font-semibold outline-none transition-colors focus-visible:ring-2"
          >
            <ChevronRight
              className={cn(
                'h-4 w-4 shrink-0 transition-transform duration-200',
                isDeepResearchOpen && 'rotate-90'
              )}
              aria-hidden="true"
            />
            <FlaskConical className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {t('sessionsPanel.deepResearchHeading', { count: deepResearchRuns?.length ?? 0 })}
            </span>
          </button>

          {isDeepResearchOpen && (
            <div className="mt-2 flex flex-col gap-1">
              {(deepResearchRuns ?? []).map((run) => (
                <Link
                  key={run.job_id}
                  href={runHref(run)}
                  onClick={handleClose}
                  className="hover:bg-accent focus-visible:ring-ring/50 flex items-center gap-2 rounded-lg p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset"
                  aria-label={t('sessionsPanel.deepResearchRunLabel', { label: runLabel(run) })}
                >
                  <RunStatusIcon status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-sm" title={runLabel(run)}>
                    {runLabel(run)}
                  </span>
                  <span
                    className="text-muted-foreground shrink-0 text-xs"
                    title={formatAbsoluteTime(run.created_at, locale)}
                  >
                    {formatRelativeTime(run.created_at, locale)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Session List — items stagger in when the panel opens (forceMount keeps the
          panel in the DOM, so this is driven by the open state, not by mounting) */}
      <motion.div
        className="flex flex-1 flex-col overflow-y-auto"
        variants={staggerParent}
        initial={false}
        animate={isSessionsPanelOpen ? 'visible' : 'hidden'}
      >
        {groupedSessions.map(([dateLabel, dateSessions]) => (
          <div key={dateLabel} className="mb-4 flex flex-col gap-2">
            <span className="text-muted-foreground text-xs font-semibold uppercase">
              {dateLabel}
            </span>
            {dateSessions.map((session) => (
              <motion.div key={session.id} variants={fadeRise} transition={springGentle}>
                <SessionItem
                  session={session}
                  isSelected={selectedSessionId === session.id}
                  isBusy={isNavigationBlocked}
                  isSessionActive={isSessionBusy(session.id)}
                  showResearchLabel={showDeepResearchSection}
                  onSelect={handleSessionClick}
                  onDelete={handleDeleteClick}
                  onRename={onRenameSession}
                />
              </motion.div>
            ))}
          </div>
        ))}

        {isEmptyState && (
          <div className="flex flex-1 flex-col items-center justify-center py-8">
            {searchQuery.trim() ? (
              <EmptyState
                variant="bare"
                icon={MessageSquare}
                title={t('sessionsPanel.noMatching')}
                description={t('sessionsPanel.noMatchingDescription')}
              />
            ) : (
              <EmptyState
                variant="bare"
                icon={MessageSquare}
                title={t('sessionsPanel.noSessions')}
                description={t('sessionsPanel.noSessionsDescription')}
                action={
                  <Button variant="outline" size="sm" onClick={handleNewSession}>
                    {t('sessionsPanel.startNewSessionButton')}
                  </Button>
                }
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
 * Individual session item with hover-reveal edit/delete icons and inline rename.
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

  // Persistent relative timestamp from the session's date (reuses the same
  // formatter the Deep Research runs list uses). Guard against unparseable
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

  return (
    <div
      role="button"
      tabIndex={isBusy ? -1 : 0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === 'Enter' && !isEditing && !isBusy && handleClick()}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      // Keyboard parity with hover: reveal the rename/delete actions while
      // focus is anywhere inside the item (focus/blur bubble in React).
      onFocus={() => setIsFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsFocused(false)
        }
      }}
      className={cn(
        'focus-visible:ring-ring/50 group flex min-h-[3.25rem] w-full items-center gap-2.5 rounded-lg border py-2 pl-2.5 pr-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset',
        isBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        // Selected reads as a raised card (border + fill + subtle shadow) rather
        // than the near-identical bg-accent/60 hover tint used for the rest.
        isSelected
          ? 'border-border bg-accent text-foreground shadow-sm'
          : 'border-transparent hover:bg-accent/60'
      )}
      aria-label={
        isBusy
          ? t('sessionsPanel.sessionLabelBusy', { title: displayTitle })
          : t('sessionsPanel.sessionLabel', { title: displayTitle })
      }
      aria-disabled={isBusy}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={handleInputBlur}
          onClick={(e) => e.stopPropagation()}
          className="border-input bg-input-background h-8 min-w-0 flex-1 rounded-md border px-2 py-1 text-base outline-none md:text-sm"
          aria-label={t('sessionsPanel.editTitle')}
        />
      ) : (
        <>
          <SessionStatusIcon session={session} isSessionActive={isSessionActive} />

          {/* Two-line content block: title + persistent time on line 1, the
              calm Deep Research chip on line 2. */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{displayTitle}</span>
              {sessionIso && (
                <span
                  className="text-muted-foreground shrink-0 text-xs"
                  title={formatAbsoluteTime(sessionIso, locale)}
                >
                  {formatRelativeTime(sessionIso, locale)}
                </span>
              )}
            </div>

            {/* FB-10: a calm "Deep Research" chip marks sessions that carry a
                research run. It lives on its own line so it never swaps with
                the trailing actions. */}
            {showResearchChip && (
              <span className="bg-secondary text-muted-foreground w-fit rounded-full px-2 py-0.5 text-xs font-medium">
                {t('sessionsPanel.deepResearchChip')}
              </span>
            )}
          </div>

          {/* Fixed-width trailing slot — reserved so revealing the rename/delete
              actions on hover/focus never reflows the row. */}
          <div className="flex w-16 shrink-0 items-center justify-end gap-1">
            {(isHovered || isFocused) && (
              <>
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
                  <Pencil className="h-4 w-4" aria-hidden="true" />
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
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </>
            )}
          </div>
        </>
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
const RunStatusIcon: FC<{ status: string }> = ({ status }) => {
  if (status === 'completed') {
    return <FileCheck2 className="text-success h-4 w-4 shrink-0" aria-hidden="true" />
  }
  if (status === 'failed' || status === 'cancelled') {
    return <AlertCircle className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
  }
  return (
    <Loader2 className="text-accent-primary h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
  )
}

const SessionStatusIcon: FC<{ session: Session; isSessionActive: boolean }> = ({
  session,
  isSessionActive,
}) => {
  const t = useTranslations('research')
  const isActive = isSessionActive || session.hasActiveDeepResearch

  if (isActive) {
    return (
      <Spinner
        size="sm"
        label={t('sessionsPanel.sessionActive')}
        className="text-accent-primary shrink-0"
      />
    )
  }

  if (session.hasExpiredReport) {
    return (
      <CircleEllipsis
        className="text-muted-foreground h-4 w-4 shrink-0"
        aria-label={t('sessionsPanel.reportExpired')}
      />
    )
  }

  if (session.hasCompletedReport) {
    return (
      <FileCheck2
        className="text-success h-4 w-4 shrink-0"
        aria-label={t('sessionsPanel.reportCompleted')}
      />
    )
  }

  return (
    <MessageSquare
      className="text-muted-foreground h-4 w-4 shrink-0"
      aria-label={t('sessionsPanel.chatSession')}
    />
  )
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
