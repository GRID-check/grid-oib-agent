'use client'

import {
  type FC,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { MessageSquareText, Sparkles, SquarePen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/adapters/auth'
import { useChatStore, useLoadJobData } from '@/features/chat'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '../store'

interface ChatToolbarProps {
  sessionTitle?: string
  /** Active project name — first breadcrumb segment when present. */
  projectName?: string
  onNewSession?: () => void
  isNewSessionDisabled?: boolean
}

export const ChatToolbar: FC<ChatToolbarProps> = memo(function ChatToolbar({
  sessionTitle = '',
  projectName,
  onNewSession,
  isNewSessionDisabled = false,
}) {
  const { isAuthenticated } = useAuth()
  const t = useTranslations('research')
  const tChat = useTranslations('chat')
  const toggleSessionsPanel = useLayoutStore((s) => s.toggleSessionsPanel)
  const isResearchPanelOpen = useLayoutStore((s) => s.rightPanel === 'research')
  const isDeepResearchStreaming = useChatStore((s) => s.isDeepResearchStreaming)
  const deepResearchJobId = useChatStore((s) => s.deepResearchJobId)
  // Inline rename reuses the SAME store action the sessions panel uses.
  const currentSessionId = useChatStore((s) => s.currentConversation?.id)
  const updateConversationTitle = useChatStore((s) => s.updateConversationTitle)
  const { loadResearchPanelTab, isLoading: isStreamLoading } = useLoadJobData()

  // Inline title editing state (Enter commits / Escape cancels / blur commits).
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState(sessionTitle)
  const titleInputRef = useRef<HTMLInputElement>(null)
  // Blur fires after Escape/Enter too — this ref suppresses the double-commit.
  const editResolvedRef = useRef(false)

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [isEditingTitle])

  const canRename = isAuthenticated && !!currentSessionId && !!updateConversationTitle

  const startEditingTitle = useCallback(() => {
    if (!canRename) return
    setEditedTitle(sessionTitle)
    editResolvedRef.current = false
    setIsEditingTitle(true)
  }, [canRename, sessionTitle])

  const commitTitle = useCallback(() => {
    if (editResolvedRef.current) return
    editResolvedRef.current = true
    setIsEditingTitle(false)
    const trimmed = editedTitle.trim()
    if (trimmed && trimmed !== sessionTitle && currentSessionId && updateConversationTitle) {
      updateConversationTitle(currentSessionId, trimmed)
    }
  }, [editedTitle, sessionTitle, currentSessionId, updateConversationTitle])

  const cancelTitleEdit = useCallback(() => {
    editResolvedRef.current = true
    setIsEditingTitle(false)
    setEditedTitle(sessionTitle)
  }, [sessionTitle])

  const handleTitleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitTitle()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelTitleEdit()
      }
    },
    [commitTitle, cancelTitleEdit]
  )

  const handleMenuClick = useCallback(() => {
    if (isAuthenticated) toggleSessionsPanel()
  }, [toggleSessionsPanel, isAuthenticated])

  const handleResearchClick = useCallback(() => {
    if (!isAuthenticated) return
    const { rightPanel, closeRightPanel, openRightPanel, researchPanelTab } =
      useLayoutStore.getState()
    if (rightPanel === 'research') {
      closeRightPanel()
      return
    }
    openRightPanel('research')
    // Re-hydrate the active tab from the job when one exists (same behavior
    // the panel's own toggle tag had before it moved into the toolbar).
    if (deepResearchJobId && !isStreamLoading) {
      void loadResearchPanelTab(deepResearchJobId, researchPanelTab)
    }
  }, [isAuthenticated, deepResearchJobId, isStreamLoading, loadResearchPanelTab])

  const handleNewSessionClick = useCallback(() => {
    if (!isAuthenticated || isNewSessionDisabled) return
    onNewSession?.()
  }, [isAuthenticated, isNewSessionDisabled, onNewSession])

  return (
    // Floating controls: no band, no background strip. The chat plane runs to
    // the very top edge and scrolls behind these; the controls ride above it as
    // two self-contained pills (left = history + thread identity, right =
    // primary actions). `pointer-events-none` on the frame lets clicks fall
    // through the gaps to the messages; each pill re-enables them.
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 px-3 py-2.5">
      {/* LEFT pill: the single history door + the current session title/rename,
          always visible (mobile included). */}
      <div className="pointer-events-auto flex min-w-0 items-center gap-0.5 rounded-full border border-base bg-card/80 p-0.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/70">
        {/* Sessions / history overlay — the one clear door to past sessions
            (the rail keeps its routed History; this doesn't duplicate it). */}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          onClick={handleMenuClick}
          disabled={!isAuthenticated}
          aria-label={t('chatToolbar.toggleSessions')}
          title={!isAuthenticated ? t('chatToolbar.signInToView') : t('chatToolbar.toggleSessions')}
        >
          <MessageSquareText className="h-4 w-4" aria-hidden="true" />
        </Button>

        {/* Breadcrumb: {project} / {session title (click-to-rename)} — always
            visible so the current thread is identifiable on every viewport. */}
        {(sessionTitle || projectName) && (
          <nav
            className="flex min-w-0 items-center gap-1.5 pl-1 pr-1.5 text-sm"
            aria-label={tChat('breadcrumb.ariaLabel')}
          >
              {projectName ? (
                <>
                  <span className="max-w-44 truncate text-muted-foreground">{projectName}</span>
                  {sessionTitle ? (
                    <span className="text-muted-foreground/60" aria-hidden="true">
                      /
                    </span>
                  ) : null}
                </>
              ) : null}
              {sessionTitle ? (
                isEditingTitle ? (
                  <input
                    ref={titleInputRef}
                    value={editedTitle}
                    onChange={(e) => setEditedTitle(e.target.value)}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={commitTitle}
                    aria-label={tChat('breadcrumb.renameInputAria')}
                    className="h-7 w-56 max-w-full rounded-md border bg-card px-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={startEditingTitle}
                    disabled={!canRename}
                    aria-label={tChat('breadcrumb.renameAria')}
                    title={canRename ? tChat('breadcrumb.renameAria') : undefined}
                    className="max-w-[420px] truncate rounded-md px-1 py-0.5 text-left text-sm font-medium text-foreground transition-colors duration-200 ease-out enabled:cursor-text enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {sessionTitle}
                  </button>
                )
              ) : null}
          </nav>
        )}
      </div>

      {/* RIGHT pill: primary actions. New chat is the highest-value action and
          carries a persistent label from >=sm; Research reopens the report. */}
      <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-full border border-base bg-card/80 p-0.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/70">
        {/* New chat */}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={handleNewSessionClick}
          disabled={!isAuthenticated || isNewSessionDisabled}
          aria-label={t('chatToolbar.createNewSession')}
          title={
            !isAuthenticated
              ? t('chatToolbar.signInToCreate')
              : isNewSessionDisabled
                ? t('chatToolbar.cannotCreateActive')
                : t('chatToolbar.createNewSession')
          }
        >
          <SquarePen className="h-4 w-4" aria-hidden="true" />
          <span className="hidden text-sm font-medium sm:inline">{t('chatToolbar.newChat')}</span>
        </Button>

        {/* Research report panel toggle — the one right-side control the
            composer doesn't already cover (its deep-research pill is intent,
            this reopens the finished report). */}
        <Button
          variant={isResearchPanelOpen ? 'secondary' : 'ghost'}
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={handleResearchClick}
          disabled={!isAuthenticated}
          aria-label={
            isResearchPanelOpen ? t('researchPanel.closePanel') : t('researchPanel.openPanel')
          }
          aria-expanded={isResearchPanelOpen}
          title={
            !isAuthenticated
              ? t('researchPanel.signInToAccess')
              : isResearchPanelOpen
                ? t('researchPanel.closePanel')
                : t('researchPanel.openPanel')
          }
          data-testid="research-panel-toggle"
        >
          {isDeepResearchStreaming ? (
            <Spinner size="sm" label={t('researchPanel.researching')} />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="hidden text-sm sm:inline">{t('chatToolbar.research')}</span>
        </Button>
      </div>
    </header>
  )
})
