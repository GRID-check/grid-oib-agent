/**
 * MainLayout Component
 *
 * The main application layout container that orchestrates:
 * - ChatToolbar (top)
 * - SessionsPanel (left, overlay)
 * - ChatArea + InputArea (center, responsive width)
 * - ResearchPanel (right, pushes content when open)
 *
 * Handles auth state to show different UI for logged-in vs logged-out users.
 */

'use client'

import { type FC, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { ChatToolbar } from './ChatToolbar'
import { SessionsPanel } from './SessionsPanel'
import { ChatArea } from './ChatArea'
import { InputArea } from './InputArea'
import { ResearchPanel } from './ResearchPanel'
import { useChatStore, useDeepResearch, NoSourcesBanner } from '@/features/chat'
import {
  hasActiveDeepResearchJob,
  hasCompletedDeepResearchReport,
  hasExpiredDeepResearchReport,
} from '@/features/chat/lib/session-activity'
import { conversationMatchesProject } from '@/features/chat/lib/project-scope'
import { useLayoutStore } from '../store'
import { useSessionUrl } from '@/hooks/use-session-url'
import { documentDisplayName } from '@/lib/documents/display-name'
import { useTranslations } from '@/i18n'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'

interface MainLayoutProps {
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Callback when sign in is clicked */
  onSignIn?: () => void
  /**
   * Whether report source lines show origin badges (WorkOS
   * `source-origin-badges` flag, FB-2). Threaded to ResearchPanel → ReportTab.
   * Defaults to true (fail-open) so existing callers/specs are unaffected.
   */
  showSourceBadges?: boolean
  /**
   * Whether shallow answers show the confidence chip (WorkOS
   * `chat-confidence-chip` flag, FB-6). Threaded to ChatArea → AgentResponse.
   * Defaults to true (fail-open) so existing callers/specs are unaffected.
   */
  showConfidenceChip?: boolean
  /**
   * Whether answers show the per-answer thumbs feedback row (WorkOS
   * `answer-feedback` flag, WS-7). Threaded to ChatArea → AgentResponse.
   * Defaults to true (fail-open) so existing callers/specs are unaffected.
   */
  showAnswerFeedback?: boolean
  /**
   * Whether the sessions panel shows the Deep Research section and per-session
   * research labels (WorkOS `research-in-chat-history` flag, FB-10). Threaded to
   * SessionsPanel. Defaults to false so existing callers/specs are unaffected.
   */
  showResearchInHistory?: boolean
  /** Qdrant collection scoping the Deep Research section's job fetch (FB-10). */
  projectCollection?: string | null
  /** Active project name — thread-header breadcrumb + composer scope chip. */
  projectName?: string | null
  /**
   * Whether the collaboration surfaces are available (ADR-0032…0035): message
   * authorship, the unread divider, the turn-in-flight banner. Threaded to
   * ChatArea. Defaults to false — this feature is dark-launched, and unlike the
   * fail-open flags above it changes who can see a conversation, so it must not
   * switch itself on for callers that have not opted in (spec NF-7/NF-8).
   */
  canCollaborate?: boolean
}

/**
 * Main application layout with all panels and regions.
 * Manages the overall structure and panel states.
 * Chat state is managed via the useChatStore.
 */
export const MainLayout: FC<MainLayoutProps> = ({
  isAuthenticated = false,
  onSignIn,
  showSourceBadges = true,
  showConfidenceChip = true,
  showAnswerFeedback = true,
  showResearchInHistory = false,
  canCollaborate = false,
  projectCollection = null,
  projectName = null,
}) => {
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
  const prefersReducedMotion = useReducedMotion()
  const isMobile = useIsMobile()
  const filePeeking = useFilePreviewStore(
    (s) => s.mode === 'peek' && s.file !== null && !s.hidden,
  )
  const peekWidth = useFilePreviewStore((s) => s.peekWidth)
  const peekedFile = useFilePreviewStore((s) => s.file)
  const previewHidden = useFilePreviewStore((s) => s.hidden)
  const previewMode = useFilePreviewStore((s) => s.mode)
  const expandFile = useFilePreviewStore((s) => s.expand)
  const tFiles = useTranslations('files')

  // Measure the floating composer stack (NoSourcesBanner + InputArea — variable
  // height: multi-line textarea, wrapped chips, hint, banners) and publish it as
  // --composer-h so ChatArea reserves EXACTLY that much bottom padding instead
  // of a fixed guess. useLayoutEffect avoids a first-paint flash; ChatArea's
  // 11rem fallback covers the pre-measure frame and jsdom (offsetHeight 0).
  const composerRef = useRef<HTMLDivElement>(null)
  const [composerHeight, setComposerHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = composerRef.current
    if (!el) return
    const update = () => setComposerHeight(el.offsetHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
  const handleNewSession = useCallback(() => {
    startNewSessionDraft()
    useFilePreviewStore.getState().close()
    clearSessionUrl()
  }, [startNewSessionDraft, clearSessionUrl])

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
        ? conversations
            .filter(
              (c) => c.userId === currentUserId && conversationMatchesProject(c, projectId)
            )
            // The store keeps creation order; sort newest-first so date groups
            // and rows in the sessions panel come out most-recently-updated first.
            .slice()
            .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
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
    // h-full pins the chat surface to the viewport: the composer floats at the
    // bottom and only the message list scrolls. The toolbar is no longer a top
    // band — it floats over the chat plane (see below).
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* Main Content Area - using explicit widths instead of flex for smoother animation */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Center Content: Chat + Input - Responsive to research panel */}
        <div
          className="relative flex min-w-0 flex-col overflow-hidden"
          style={{
            // Chat stays the home column. A peeked file sits to the right
            // as a companion (~22rem), not a 50/50 split. Research still
            // shares the row 50/50 and the peek yields to it.
            width: isResearchPanelOpen
              ? isMobile
                ? '0%'
                : '50%'
              : filePeeking && !isMobile
                ? `calc(100% - ${peekWidth + 24}px)`
                : '100%',
            transition: prefersReducedMotion ? 'none' : 'width 300ms ease-in-out',
            // Published from the ResizeObserver above; inherits into ChatArea
            // (a descendant), which reads it via calc(). undefined pre-measure.
            ...(composerHeight != null
              ? { ['--composer-h' as string]: `${composerHeight}px` }
              : {}),
          }}
        >
          {/* Top fade scrim — a full-width gradient behind the floating pills
              (below them, above the messages). It dissolves message content as
              it scrolls up under the pills instead of letting it collide as
              sharp, readable text — critical on mobile where the message column
              is full-width and runs right under the pills. Keeps the pills
              "floating" (no solid band). pointer-events-none so scroll/taps
              still reach the messages beneath. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-background from-[3.25rem] to-transparent"
          />

          {/* Floating toolbar — overlays the top of the chat plane as pills
              (no band). Sits inside the center column so it spans only the
              chat, not the research panel (which has its own header). */}
          <ChatToolbar
            sessionTitle={currentConversation?.title}
            projectName={projectName ?? undefined}
            onNewSession={handleNewSession}
            isNewSessionDisabled={isNavigationBlocked}
            isChatStarted={(currentConversation?.messages?.length ?? 0) > 0}
            // Collaboration affordances in the thread header: the participant
            // strip, the access chip and the share dialog. All three are gated on
            // the dark-launch flag AND on there being a conversation to share, so
            // an unshared or brand-new thread shows no extra chrome at all.
            conversationId={currentConversation?.id ?? null}
            isCollaborationEnabled={canCollaborate}
            currentUserId={currentUserId}
          />

          {isMobile &&
            peekedFile &&
            previewMode !== 'modal' &&
            previewMode !== 'expanded' && (
              <button
                type="button"
                onClick={expandFile}
                className="border-base bg-card/70 absolute left-3 right-3 top-14 z-20 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/60"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium tracking-[-0.01em]">
                  {documentDisplayName(peekedFile)}
                </span>
                <span className="text-muted-foreground shrink-0 text-[11px]">
                  {previewHidden ? tFiles('assignment.showFile') : tFiles('assignment.expandFile')}
                </span>
              </button>
            )}

          {/* Chat Area - Scrollable, extends behind the floating composer AND
              the floating toolbar */}
          <ChatArea
            isAuthenticated={isAuthenticated}
            onSignIn={onSignIn}
            showConfidenceChip={showConfidenceChip}
            showAnswerFeedback={showAnswerFeedback}
            canCollaborate={canCollaborate}
          />

          {/* Floating composer stack: overlays the bottom of the chat scroll
              area instead of docking below it, so messages scroll behind the
              translucent input. ChatArea pads its bottom to keep the last
              message readable above it. */}
          <div ref={composerRef} className="absolute inset-x-0 bottom-0 z-10 flex flex-col">
            {/* No sources warning - shown when no data sources or files available */}
            <NoSourcesBanner isAuthenticated={isAuthenticated} />

            {/* Input Area - Using WebSocket mode for full HITL (human-in-the-loop) support */}
            <InputArea
              isAuthenticated={isAuthenticated}
              connectionMode="websocket"
              projectName={projectName ?? undefined}
              // Gates the composer's addressee statement (and the hand-off read
              // behind it). False — the default — is byte-for-byte today's
              // composer (spec NF-8).
              canCollaborate={canCollaborate}
            />
          </div>
        </div>

        {/* Research Panel (Right) - Pushes content, shares the width 50/50 */}
        <ResearchPanel showSourceBadges={showSourceBadges} />
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
        showDeepResearchSection={showResearchInHistory}
        projectId={projectId ?? undefined}
        projectCollection={projectCollection ?? undefined}
      />
    </div>
  )

  return content
}
