/**
 * MainLayout Component
 *
 * The main application layout container that orchestrates:
 * - ChatToolbar (top)
 * - SessionsPanel (left, overlay)
 * - ChatArea + InputArea (center)
 *
 * Handles auth state to show different UI for logged-in vs logged-out users.
 *
 * A run is one message in the thread that commissioned it (ADR-0062): its
 * progress, its report and its findings are read there, and any deeper look
 * (a document, the sources) opens as a dialog over the thread. There is no
 * side panel.
 */

'use client'

import { type FC, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { ChatToolbar } from './ChatToolbar'
import { SessionsPanel } from './SessionsPanel'
import { ChatArea } from './ChatArea'
import { ComposerScrim } from './ComposerScrim'
import { InputArea } from './InputArea'
import { RightsLostPanel } from './RightsLostPanel'
import { useChatStore, NoSourcesBanner } from '@/features/chat'
import { useSessionUrl } from '@/hooks/use-session-url'
import { documentDisplayName } from '@/lib/documents/display-name'
import { useTranslations } from '@/i18n'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import { useComposerMetrics } from '../hooks/use-composer-metrics'
import { useSessionRows } from '../hooks/use-session-rows'
import { motion } from '@/components/motion'
import { selectThreadPhase } from '../lib/thread-phase'

interface MainLayoutProps {
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Callback when sign in is clicked */
  onSignIn?: () => void
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
  /** Whether the reader may chat in this project (`project:chat`). */
  canChatInProject?: boolean
}

/**
 * Main application layout with all panels and regions.
 * Manages the overall structure and panel states.
 * Chat state is managed via the useChatStore.
 */
export const MainLayout: FC<MainLayoutProps> = ({
  isAuthenticated = false,
  onSignIn,
  showConfidenceChip = true,
  showAnswerFeedback = true,
  showResearchInHistory = false,
  canCollaborate = false,
  canChatInProject = true,
  projectName = null,
}) => {
  // Only what the layout shows, never the conversation objects themselves:
  // a streamed answer replaces the open conversation on every delta, and the
  // whole shell would re-render with each one. How many messages the thread
  // holds decides whether the toolbar calls the chat started; whether the
  // composer is lifted off the floor into the empty canvas is the thread's
  // PHASE, the same selector `ChatArea` draws the greeting from, so a thread
  // whose messages are still loading keeps the composer down.
  const {
    currentConversationId,
    currentConversationTitle,
    currentConversationLocked,
    messageCount,
    isStreaming,
    pendingInteraction,
    currentUserId,
    projectId,
  } = useChatStore(
    useShallow((s) => ({
      currentConversationId: s.currentConversation?.id,
      currentConversationTitle: s.currentConversation?.title,
      currentConversationLocked: s.currentConversation?.contentLocked === true,
      messageCount: s.currentConversation?.messages?.length ?? 0,
      isStreaming: s.isStreaming,
      pendingInteraction: s.pendingInteraction,
      currentUserId: s.currentUserId,
      projectId: s.projectId,
    }))
  )
  const isThreadEmpty = useChatStore((s) => selectThreadPhase(s) === 'empty')
  const sessions = useSessionRows()

  const selectConversation = useChatStore((s) => s.selectConversation)
  const startNewSessionDraft = useChatStore((s) => s.startNewSessionDraft)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const deleteAllConversations = useChatStore((s) => s.deleteAllConversations)
  const updateConversationTitle = useChatStore((s) => s.updateConversationTitle)

  const isMobile = useIsMobile()
  const peekedFile = useFilePreviewStore((s) => s.file)
  const previewHidden = useFilePreviewStore((s) => s.hidden)
  const previewMode = useFilePreviewStore((s) => s.mode)
  const expandFile = useFilePreviewStore((s) => s.expand)
  const tFiles = useTranslations('files')

  // Composer geometry (--composer-h, --welcome-offset, and the lift the stack
  // travels on) — see useComposerMetrics.
  // Shared with the /dev preview route so the two cannot drift.
  const { composerRef, columnVars, composerStyle, composerMotion } =
    useComposerMetrics(isThreadEmpty)

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
      const wasCurrentSession = currentConversationId === sessionId
      deleteConversation(sessionId)
      if (wasCurrentSession) {
        clearSessionUrl()
      }
    },
    [deleteConversation, currentConversationId, clearSessionUrl]
  )

  // Delete all sessions for the current user in the active project context
  // (the store scopes the delete to what the panel shows here — see
  // deleteAllConversations).
  const handleDeleteAllSessions = useCallback(() => {
    deleteAllConversations()
    clearSessionUrl()
  }, [deleteAllConversations, clearSessionUrl])

  const isNavigationBlocked = isStreaming || pendingInteraction !== null

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
            // Research shares the row 50/50, and this column yields half.
            //
            // The FILE PEEK IS NOT LISTED HERE, deliberately. It used to be:
            // when the peek was a floating pane, this column subtracted the
            // pane's width to clear a lane for it. `FilePreviewSplit` replaced
            // that pane with a real resizable panel BESIDE this whole subtree,
            // so the room is already made one level up — and subtracting it
            // again here took it out a second time, out of a panel that had
            // already shrunk. At 1440px that left the chat 539px wide inside an
            // 883px panel: a 344px dead band between the conversation and the
            // file it is about, with the resize handle stranded on the far side
            // of it. `/dev/file-ask-split/chat` is the regression evidence.
            width: '100%',
            // Published by useComposerMetrics; inherits into ChatArea (a
            // descendant), which reads both via calc().
            ...columnVars,
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
            className="from-background pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-[3.25rem] to-transparent"
          />

          {/* Floating toolbar — overlays the top of the chat plane as pills
              (no band). Sits inside the center column so it spans only the
              chat, not the research panel (which has its own header). */}
          <ChatToolbar
            sessionTitle={currentConversationTitle}
            projectName={projectName ?? undefined}
            onNewSession={handleNewSession}
            isNewSessionDisabled={isNavigationBlocked}
            isChatStarted={messageCount > 0}
            // Collaboration affordances in the thread header: the participant
            // strip, the access chip and the share dialog. All three are gated on
            // the dark-launch flag AND on there being a conversation to share, so
            // an unshared or brand-new thread shows no extra chrome at all.
            conversationId={currentConversationId ?? null}
            isCollaborationEnabled={canCollaborate}
            currentUserId={currentUserId}
          />

          {isMobile && peekedFile && previewMode !== 'modal' && previewMode !== 'expanded' && (
            <button
              type="button"
              onClick={expandFile}
              // Floating over the transcript: the alpha is what `backdrop-blur`
              // blurs, and the `supports-` step is the no-blur fallback.
              className="border-base bg-card/70 shadow-xs supports-[backdrop-filter]:bg-card/60 absolute left-3 right-3 top-14 z-20 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left backdrop-blur"
            >
              <span className="min-w-0 flex-1 truncate text-xs font-medium tracking-[-0.01em]">
                {documentDisplayName(peekedFile)}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {previewHidden ? tFiles('assignment.showFile') : tFiles('assignment.expandFile')}
              </span>
            </button>
          )}

          {/* A chat the reader may no longer read has no transcript and no
              composer here (ADR-0088): nothing of it is mounted, so nothing of
              it is fetched or drawn. */}
          {currentConversationLocked ? (
            <RightsLostPanel />
          ) : (
            <>
              {/* Chat Area - Scrollable, extends behind the floating composer AND
              the floating toolbar */}
              <ChatArea
                isAuthenticated={isAuthenticated}
                onSignIn={onSignIn}
                showConfidenceChip={showConfidenceChip}
                showAnswerFeedback={showAnswerFeedback}
                canCollaborate={canCollaborate}
              />

              {/* The scrims under and above the floating composer (`ComposerScrim`). */}
              <ComposerScrim threadEmpty={isThreadEmpty} />

              {/* Floating composer stack: overlays the bottom of the chat scroll
              area instead of docking below it, so messages scroll behind the
              translucent input. ChatArea pads its bottom to keep the last
              message readable above it. Narrower than the message column
              (max-w-4xl inside — see InputArea) and given its own glass
              surface, so it reads as a distinct floating object rather than
              a same-width continuation of the transcript above it. */}
              <motion.div
                ref={composerRef}
                className="absolute inset-x-0 z-10 flex flex-col"
                style={composerStyle}
                // The composer TRAVELS between the two places it lives. On an empty
                // canvas it sits with the greeting in the middle of the column; the
                // first message sends it to the floor, and before this it got there
                // between two frames — the input the reader had just been typing in
                // vanished and an identical one appeared somewhere else. A move is
                // what says those are the same object. The rules for when that move
                // is real, and why it is a transform, are in `useComposerMetrics`.
                {...composerMotion}
              >
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
                  canChatInProject={canChatInProject}
                />
              </motion.div>
            </>
          )}
        </div>
      </div>

      {/* Overlay Panels - These slide over the content */}

      {/* Sessions Panel (Left) - Only functional when authenticated */}
      <SessionsPanel
        sessions={sessions}
        selectedSessionId={currentConversationId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
        onDeleteAllSessions={handleDeleteAllSessions}
        onRenameSession={updateConversationTitle}
        showDeepResearchSection={showResearchInHistory}
        projectId={projectId ?? undefined}
      />
    </div>
  )

  return content
}
