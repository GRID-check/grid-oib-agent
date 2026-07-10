/**
 * MainLayout Component
 *
 * The main application layout container that orchestrates:
 * - ChatToolbar (top)
 * - SessionsPanel (left, overlay)
 * - ChatArea + InputArea (center, responsive width)
 * - ResearchPanel (right, pushes content when open)
 * - DataSourcesPanel (right, overlay)
 *
 * Handles auth state to show different UI for logged-in vs logged-out users.
 */

'use client'

import { type FC, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { ChatToolbar } from './ChatToolbar'
import { SessionsPanel } from './SessionsPanel'
import { ChatArea } from './ChatArea'
import { InputArea } from './InputArea'
import { ResearchPanel } from './ResearchPanel'
import { DataSourcesPanel } from './DataSourcesPanel'
import { useChatStore, useDeepResearch, NoSourcesBanner } from '@/features/chat'
import {
  hasActiveDeepResearchJob,
  hasCompletedDeepResearchReport,
  hasExpiredDeepResearchReport,
} from '@/features/chat/lib/session-activity'
import { conversationMatchesProject } from '@/features/chat/lib/project-scope'
import { useLayoutStore } from '../store'
import { useSessionUrl } from '@/hooks/use-session-url'

interface MainLayoutProps {
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Callback when sign in is clicked */
  onSignIn?: () => void
}

/**
 * Main application layout with all panels and regions.
 * Manages the overall structure and panel states.
 * Chat state is managed via the useChatStore.
 */
export const MainLayout: FC<MainLayoutProps> = ({ isAuthenticated = false, onSignIn }) => {
  const {
    currentConversation,
    conversations,
    isStreaming,
    pendingInteraction,
    isDeepResearchStreaming,
    deepResearchOwnerConversationId,
    currentUserId,
    projectId,
  } = useChatStore(
    useShallow((s) => ({
      currentConversation: s.currentConversation,
      conversations: s.conversations,
      isStreaming: s.isStreaming,
      pendingInteraction: s.pendingInteraction,
      isDeepResearchStreaming: s.isDeepResearchStreaming,
      deepResearchOwnerConversationId: s.deepResearchOwnerConversationId,
      currentUserId: s.currentUserId,
      projectId: s.projectId,
    }))
  )

  const selectConversation = useChatStore((s) => s.selectConversation)
  const startNewSessionDraft = useChatStore((s) => s.startNewSessionDraft)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const deleteAllConversations = useChatStore((s) => s.deleteAllConversations)
  const updateConversationTitle = useChatStore((s) => s.updateConversationTitle)

  const isResearchPanelOpen = useLayoutStore((s) => s.rightPanel === 'research')
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const prefersReducedMotion = useReducedMotion()
  const isMobile = useIsMobile()

  // Deep research SSE hook - manages connection when deep research starts
  useDeepResearch()

  // Sync session state with URL query parameters
  const { updateSessionUrl, clearSessionUrl } = useSessionUrl({ isAuthenticated })

  // Wrap selectConversation to also update URL
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      selectConversation(sessionId)
      updateSessionUrl(sessionId)
    },
    [selectConversation, updateSessionUrl]
  )

  // Start a new unsaved draft session and clear URL until first interaction.
  // Open Data Sources panel so it stays visible (default panel for new sessions).
  const handleNewSession = useCallback(() => {
    startNewSessionDraft()
    clearSessionUrl()
    if (isAuthenticated) {
      openRightPanel('data-sources')
    }
  }, [startNewSessionDraft, clearSessionUrl, openRightPanel, isAuthenticated])

  // Wrap deleteConversation to clear URL if deleting current session
  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      const wasCurrentSession = currentConversation?.id === sessionId
      deleteConversation(sessionId)
      if (wasCurrentSession) {
        clearSessionUrl()
      }
    },
    [deleteConversation, currentConversation?.id, clearSessionUrl]
  )

  // Delete all sessions for the current user in the active project context
  // (the store scopes the delete to what the panel shows here — see
  // deleteAllConversations).
  const handleDeleteAllSessions = useCallback(() => {
    deleteAllConversations()
    clearSessionUrl()
  }, [deleteAllConversations, clearSessionUrl])

  const isNavigationBlocked = isStreaming || pendingInteraction !== null

  // Sessions shown in the panel: the current user's sessions in the active
  // project context. Legacy sessions without a projectId fail open (always
  // visible) so users never lose sight of pre-scoping history.
  const userConversations = useMemo(
    () =>
      currentUserId
        ? conversations.filter(
            (c) => c.userId === currentUserId && conversationMatchesProject(c, projectId)
          )
        : [],
    [conversations, currentUserId, projectId]
  )

  const sessions = useMemo(
    () =>
      userConversations.map((conv) => ({
        id: conv.id,
        title: conv.title,
        date: conv.updatedAt,
        hasActiveDeepResearch:
          hasActiveDeepResearchJob(conv.messages) ||
          (isDeepResearchStreaming && deepResearchOwnerConversationId === conv.id),
        hasCompletedReport: hasCompletedDeepResearchReport(conv.messages),
        hasExpiredReport: hasExpiredDeepResearchReport(conv.messages),
      })),
    [userConversations, isDeepResearchStreaming, deepResearchOwnerConversationId]
  )

  const content = (
    // h-full pins the chat surface to the viewport: the toolbar stays at the
    // top, the composer at the bottom, and only the message list scrolls.
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <ChatToolbar
        sessionTitle={currentConversation?.title}
        onNewSession={handleNewSession}
        isNewSessionDisabled={isNavigationBlocked}
      />

      {/* Main Content Area - using explicit widths instead of flex for smoother animation */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Center Content: Chat + Input - Responsive to research panel */}
        <div
          className="flex min-w-0 flex-col overflow-hidden"
          style={{
            // Balanced split: the research panel informs alongside chat rather
            // than squeezing it into a cramped column. On mobile the panel
            // takes the full viewport instead, so chat collapses away.
            width: isResearchPanelOpen ? (isMobile ? '0%' : '50%') : '100%',
            transition: prefersReducedMotion ? 'none' : 'width 300ms ease-in-out',
          }}
        >
          {/* Chat Area - Scrollable */}
          <ChatArea isAuthenticated={isAuthenticated} onSignIn={onSignIn} />

          {/* No sources warning - shown when no data sources or files available */}
          <NoSourcesBanner isAuthenticated={isAuthenticated} />

          {/* Input Area - Fixed at bottom of chat */}
          {/* Using WebSocket mode for full HITL (human-in-the-loop) support */}
          <InputArea isAuthenticated={isAuthenticated} connectionMode="websocket" />
        </div>

        {/* Research Panel (Right) - Pushes content, shares the width 50/50 */}
        <ResearchPanel />
      </div>

      {/* Overlay Panels - These slide over the content */}

      {/* Sessions Panel (Left) - Only functional when authenticated */}
      <SessionsPanel
        sessions={sessions}
        selectedSessionId={currentConversation?.id}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        onDeleteAllSessions={handleDeleteAllSessions}
        onRenameSession={updateConversationTitle}
      />

      {/* Data Sources Panel (Right) - Overlay */}
      {isAuthenticated && <DataSourcesPanel />}
    </div>
  )

  return content
}
