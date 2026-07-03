// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
import {
  CircleEllipsis,
  FileCheck2,
  MessageSquare,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
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
}) {
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
    if (!searchQuery.trim()) return sessions.filter((s) => s.title.trim() !== '')
    const query = searchQuery.toLowerCase()
    return sessions.filter((s) => s.title.toLowerCase().includes(query) && s.title.trim() !== '')
  }, [sessions, searchQuery])

  const groupedSessions = useMemo(() => groupSessionsByDate(filteredSessions), [filteredSessions])
  const isEmptyState = filteredSessions.length === 0
  return (
    <DockedPanel
      open={isSessionsPanelOpen}
      side="left"
      onClose={handleClose}
      forceMount
      aria-label="Sessions"
      className="w-[406px]"
      heading={
        <>
          <MessageSquareText className="h-4 w-4" aria-hidden="true" />
          <span>Sessions</span>
        </>
      }
      footer={
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            Using {storagePercent}% of browser storage quota
          </p>
          <p className="text-xs text-muted-foreground">
            Note: Chat sessions are saved in this browser. Research reports may expire on the
            server.
          </p>
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
            aria-label={anySessionBusy ? 'Delete all sessions (disabled)' : 'Delete all sessions'}
            title={
              anySessionBusy
                ? 'Cannot delete while operations are in progress'
                : 'Delete all sessions'
            }
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm">Delete All</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleNewSession}
            disabled={isNavigationBlocked}
            aria-label={
              isNavigationBlocked
                ? 'Start new session (disabled during active operations)'
                : 'Start new session'
            }
            title={
              isNavigationBlocked
                ? 'Cannot create new session while current session is active'
                : 'Start new session'
            }
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-semibold">New Session</span>
          </Button>
        </div>
      )}
      {/* Search */}
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search sessions..."
          className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label="Search sessions"
        />
      </div>

      {/* Session List */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {Object.entries(groupedSessions).map(([dateLabel, dateSessions]) => (
          <div key={dateLabel} className="mb-4 flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              {dateLabel}
            </span>
            {dateSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isSelected={selectedSessionId === session.id}
                isBusy={isNavigationBlocked}
                isSessionActive={isSessionBusy(session.id)}
                onSelect={handleSessionClick}
                onDelete={handleDeleteClick}
                onRename={onRenameSession}
              />
            ))}
          </div>
        ))}

        {isEmptyState && (
          <div className="flex flex-1 flex-col items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">
              {searchQuery.trim() ? 'No matching sessions' : 'No sessions yet'}
            </span>
            {!searchQuery.trim() && (
              <Button variant="outline" size="sm" onClick={handleNewSession} className="mt-4">
                Start a new session
              </Button>
            )}
          </div>
        )}
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
        count={sessions.filter((s) => s.title.trim() !== '').length}
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
  onSelect?: (sessionId: string) => void
  onDelete?: (sessionId: string) => void
  onRename?: (sessionId: string, newTitle: string) => void
}

const SessionItem: FC<SessionItemProps> = ({
  session,
  isSelected,
  isBusy = false,
  isSessionActive = false,
  onSelect,
  onDelete,
  onRename,
}) => {
  const [isHovered, setIsHovered] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(session.title)
  const inputRef = useRef<HTMLInputElement>(null)

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
      className={cn(
        'group flex h-10 w-full items-center gap-2 rounded-md border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
        isBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        isSelected ? 'border-accent-primary bg-muted' : 'bg-transparent hover:bg-accent'
      )}
      aria-label={
        isBusy ? `Session: ${session.title} (processing in progress)` : `Session: ${session.title}`
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
          className="h-8 min-w-0 flex-1 rounded border border-accent-primary bg-background px-2 py-1 text-sm outline-none"
          aria-label="Edit session title"
        />
      ) : (
        <>
          <SessionStatusIcon session={session} isSessionActive={isSessionActive} />

          <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>

          {/* Action icons - shown on hover */}
          {isHovered && (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={handleEditClick}
                disabled={isBusy || isSessionActive}
                aria-label={
                  isBusy || isSessionActive ? 'Rename session (disabled)' : 'Rename session'
                }
                title={
                  isBusy || isSessionActive
                    ? 'Cannot rename while operations are in progress'
                    : 'Rename session'
                }
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                onClick={handleDeleteClick}
                disabled={isBusy || isSessionActive}
                aria-label={
                  isBusy || isSessionActive ? 'Delete session (disabled)' : 'Delete session'
                }
                title={
                  isBusy || isSessionActive
                    ? 'Cannot delete while operations are in progress'
                    : 'Delete session'
                }
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const SessionStatusIcon: FC<{ session: Session; isSessionActive: boolean }> = ({
  session,
  isSessionActive,
}) => {
  const isActive = isSessionActive || session.hasActiveDeepResearch

  if (isActive) {
    return <Spinner size="sm" label="Session active" className="shrink-0 text-accent-primary" />
  }

  if (session.hasExpiredReport) {
    return (
      <CircleEllipsis
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-label="Report expired"
      />
    )
  }

  if (session.hasCompletedReport) {
    return <FileCheck2 className="h-4 w-4 shrink-0 text-success" aria-label="Report completed" />
  }

  return (
    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Chat session" />
  )
}

/**
 * Groups sessions by relative date labels (Today, Yesterday, or date string)
 */
const groupSessionsByDate = (sessions: Session[]): Record<string, Session[]> => {
  const groups: Record<string, Session[]> = {}
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  for (const session of sessions) {
    const sessionDate = new Date(session.date)
    let label: string

    if (isSameDay(sessionDate, today) && session.title.trim()) {
      label = 'Today'
    } else if (isSameDay(sessionDate, yesterday)) {
      label = 'Yesterday'
    } else {
      label = sessionDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    }

    if (!groups[label]) {
      groups[label] = []
    }
    groups[label].push(session)
  }

  return groups
}

const isSameDay = (d1: Date, d2: Date): boolean => {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  )
}
