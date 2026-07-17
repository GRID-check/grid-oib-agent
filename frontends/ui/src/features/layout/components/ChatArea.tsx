/**
 * ChatArea Component
 *
 * Main chat display area showing messages between user and assistant.
 * Includes the message list and is positioned in the center of the layout.
 *
 * Shows different welcome states based on authentication:
 * - Logged out: Prompt to sign in with CTA button
 * - Logged in: Ready to start chatting
 */

'use client'

import { type FC, memo, useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { FileText, Lock } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import {
  useChatStore,
  AgentPrompt,
  AgentResponse,
  ErrorBanner,
  FileUploadBanner,
  DeepResearchBanner,
  UserMessage,
  ChatThinking,
} from '@/features/chat'
import type { ChatMessage } from '@/features/chat'
import { AnimatePresence, motion, fadeRise, springGentle } from '@/components/motion'
import { useAuth } from '@/adapters/auth'
import { useTranslations } from '@/i18n'

interface ChatAreaProps {
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Callback when sign in is clicked */
  onSignIn?: () => void
  /**
   * Whether the AgentResponse confidence chip renders (WorkOS
   * `chat-confidence-chip` flag, FB-6). Defaults to true (fail-open) so
   * existing callers/specs are unaffected.
   */
  showConfidenceChip?: boolean
}

/**
 * Main chat area container with scrollable message list.
 * Shows welcome state when no messages exist.
 */
export const ChatArea: FC<ChatAreaProps> = memo(function ChatArea({
  isAuthenticated = false,
  onSignIn,
  showConfidenceChip = true,
}) {
  const { currentConversation, isStreaming, currentUserMessageId } = useChatStore(
    useShallow((s) => ({
      currentConversation: s.currentConversation,
      isStreaming: s.isStreaming,
      currentUserMessageId: s.currentUserMessageId,
    }))
  )

  const respondToPrompt = useChatStore((s) => s.respondToPrompt)
  const getThinkingStepsForMessage = useChatStore((s) => s.getThinkingStepsForMessage)
  const dismissErrorCard = useChatStore((s) => s.dismissErrorCard)
  const t = useTranslations('research')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const messages = currentConversation?.messages

  // Filter to only show displayable message types in the chat area
  // Assistant text messages (full reports) are displayed in the Details Panel instead
  const displayableMessages = useMemo(
    () =>
      (messages ?? []).filter((msg) => {
        const messageType = msg.messageType || (msg.role === 'user' ? 'user' : 'assistant')
        return (
          messageType === 'user' ||
          messageType === 'prompt' ||
          messageType === 'agent_response' ||
          messageType === 'file' ||
          messageType === 'file_upload_status' ||
          messageType === 'error' ||
          messageType === 'deep_research_banner'
        )
      }),
    [messages]
  )

  const isEmpty = displayableMessages.length === 0

  // Track previous message count for scroll detection
  const [prevMessageCount, setPrevMessageCount] = useState(displayableMessages.length)

  // Entrance-animation bookkeeping: messages already present when a conversation
  // renders (hydration / session switch) must NOT animate in — only messages
  // appended afterwards get the fade-rise entrance. Seeded synchronously so the
  // very first render already knows which ids are "old".
  const hydratedIdsRef = useRef<Set<string> | null>(null)
  const hydratedConversationIdRef = useRef<string | undefined>(currentConversation?.id)
  if (
    hydratedIdsRef.current === null ||
    hydratedConversationIdRef.current !== currentConversation?.id
  ) {
    hydratedConversationIdRef.current = currentConversation?.id
    hydratedIdsRef.current = new Set(displayableMessages.map((m) => m.id))
  }
  const hydratedIds = hydratedIdsRef.current

  /**
   * Helper to get thinking steps for a user message.
   * First checks ephemeral store (for active session), then falls back
   * to persisted steps embedded in the message (for restored sessions).
   * Filters out deep research steps - they're displayed in the Research Panel.
   */
  const getStepsForUserMessage = (messageId: string) => {
    // First try ephemeral store (for active session)
    // getThinkingStepsForMessage already filters out deep research steps
    const storeSteps = getThinkingStepsForMessage(messageId)
    if (storeSteps.length > 0) return storeSteps

    // Fall back to persisted steps in message (for restored sessions)
    // Filter out deep research steps here as well
    const message = currentConversation?.messages.find((m) => m.id === messageId)
    return (message?.thinkingSteps || []).filter((step) => !step.isDeepResearch)
  }

  // Auto-scroll to bottom only when a new message is added (not on re-renders or panel toggles)
  useEffect(() => {
    const currentCount = displayableMessages.length
    if (currentCount > prevMessageCount) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    setPrevMessageCount(currentCount)
  }, [displayableMessages.length, prevMessageCount])

  const handlePromptRespond = useCallback(
    (promptId: string, response: string) => {
      respondToPrompt(promptId, response)
    },
    [respondToPrompt]
  )

  // TODO: Implement file retry/cancel/delete handlers when file upload is added
  // For now, these are placeholders
  const handleFileRetry = useCallback((_messageId: string) => {
    // Will be implemented with file upload feature
  }, [])

  return (
    <div className="scrollbar-hide flex flex-1 flex-col overflow-y-auto" aria-label={t('chatArea.ariaMessages')}>
      {isEmpty ? (
        <WelcomeState isAuthenticated={isAuthenticated} onSignIn={onSignIn} />
      ) : (
        // Generous bottom padding keeps the last message clear of the floating
        // composer, which now overlays the bottom of this scroll area.
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-44 pt-4">
          <AnimatePresence initial={false}>
            {displayableMessages.map((message, index) => {
              const isUserMessage = message.messageType === 'user' || message.role === 'user'
              const messageSteps = isUserMessage ? getStepsForUserMessage(message.id) : []
              const hasThinkingSteps = messageSteps.length > 0

              // Derive post-thinking state for user messages with thinking steps.
              // Priority: isThinking (active) > isWaiting (HITL) > isInterrupted > done
              const isCurrentlyStreaming = isStreaming && message.id === currentUserMessageId
              const shouldCheckPostState = isUserMessage && hasThinkingSteps && !isCurrentlyStreaming
              const remaining = shouldCheckPostState ? displayableMessages.slice(index + 1) : []
              const nextUserMessageIndex = remaining.findIndex(
                (m) => m.messageType === 'user' || m.role === 'user'
              )
              // Only evaluate status within this message turn (until next user message).
              // This prevents later turns from overriding interrupted/waiting state.
              const turnMessages =
                nextUserMessageIndex >= 0 ? remaining.slice(0, nextUserMessageIndex) : remaining

              // Waiting: an unresponded HITL prompt follows this user message
              const isWaiting =
                shouldCheckPostState &&
                turnMessages.some((m) => m.messageType === 'prompt' && !m.isPromptResponded)

              // Interrupted: no actual response AND not waiting for HITL
              const hasResponse = turnMessages.some(
                (m) => m.messageType === 'assistant' || m.messageType === 'agent_response'
              )
              const isInterrupted = shouldCheckPostState && !isWaiting && !hasResponse

              return (
                <motion.div
                  key={message.id}
                  className="flex flex-col gap-4"
                  variants={fadeRise}
                  // Animate only genuinely new messages; hydrated ones render in place.
                  initial={hydratedIds.has(message.id) ? false : 'hidden'}
                  animate="visible"
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={springGentle}
                >
                  {/* Render the message */}
                  <MessageRenderer
                    message={message}
                    conversationId={currentConversation?.id}
                    onPromptRespond={handlePromptRespond}
                    onFileRetry={handleFileRetry}
                    onErrorDismiss={dismissErrorCard}
                    showConfidenceChip={showConfidenceChip}
                  />

                  {/* Render thinking steps after user messages — negative margin lets the next message overlap */}
                  {isUserMessage && hasThinkingSteps && (
                    <div className="-mb-8 flex w-[85%] justify-start">
                      <ChatThinking
                        steps={messageSteps}
                        isThinking={isStreaming && message.id === currentUserMessageId}
                        isWaiting={isWaiting}
                        isInterrupted={isInterrupted}
                        enabledDataSources={message.enabledDataSources}
                        messageFiles={message.messageFiles}
                      />
                    </div>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>

          {/* Invisible scroll anchor */}
          <div ref={messagesEndRef} />
        </div>
      )}
    </div>
  )
})

/**
 * Message renderer that dispatches to the correct component based on message type
 */
interface MessageRendererProps {
  message: ChatMessage
  /** Id of the conversation these messages belong to (for the memory chip). */
  conversationId?: string | null
  onPromptRespond: (promptId: string, response: string) => void
  onFileRetry?: (messageId: string) => void
  onFileCancel?: (messageId: string) => void
  onFileDelete?: (messageId: string) => void
  onErrorDismiss?: (messageId: string) => void
  /** Whether the AgentResponse confidence chip renders (feature-flagged). */
  showConfidenceChip?: boolean
}

const MessageRenderer: FC<MessageRendererProps> = ({
  message,
  conversationId,
  onPromptRespond,
  onFileRetry: _onFileRetry,
  onFileCancel: _onFileCancel,
  onFileDelete: _onFileDelete,
  onErrorDismiss,
  showConfidenceChip = true,
}) => {
  const messageType = message.messageType || (message.role === 'user' ? 'user' : 'assistant')

  switch (messageType) {
    case 'user':
      return <UserMessage content={message.content} timestamp={message.timestamp} />

    case 'prompt':
      // Guard against missing promptType
      if (!message.promptType) {
        return null
      }
      return (
        <AgentPrompt
          id={message.id}
          type={message.promptType}
          content={message.content}
          options={message.promptOptions}
          placeholder={message.promptPlaceholder}
          isResponded={message.isPromptResponded}
          response={message.promptResponse}
          onRespond={onPromptRespond}
          timestamp={message.timestamp}
        />
      )

    case 'agent_response':
      // Short answers from the agent displayed in the chat area
      return (
        <AgentResponse
          content={message.content}
          timestamp={message.timestamp}
          showViewReport={message.showViewReport}
          jobId={message.deepResearchJobId}
          isDeepResearchActive={message.isDeepResearchActive}
          deepResearchJobStatus={message.deepResearchJobStatus}
          cards={message.cards}
          citations={message.citations}
          conversationId={conversationId}
          answerConfidence={message.answerConfidence}
          showConfidenceChip={showConfidenceChip}
        />
      )

    case 'file':
      // TODO: FileCard was removed in refactor - file display handled by FileSourceCard in panel
      // File operation messages show upload/ingest status
      if (!message.fileData) {
        return null
      }
      return (
        <div
          className="flex items-center gap-2 rounded-xl bg-muted/50 px-4 py-2 shadow-xs"
          role="status"
        >
          <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm text-muted-foreground">
            {message.fileData.fileName} ({message.fileData.fileStatus})
          </span>
        </div>
      )

    case 'file_upload_status':
      // File upload status banners (uploaded, pending_warning)
      if (!message.fileUploadStatusData) {
        return null
      }
      return (
        <FileUploadBanner
          type={message.fileUploadStatusData.type}
          fileCount={message.fileUploadStatusData.fileCount}
          timestamp={message.timestamp}
          onDismiss={onErrorDismiss ? () => onErrorDismiss(message.id) : undefined}
        />
      )

    case 'error':
      // Error banners (dismissable)
      if (!message.errorData) {
        return null
      }
      return (
        <ErrorBanner
          code={message.errorData.errorCode}
          message={message.errorData.errorMessage}
          details={message.errorData.errorDetails}
          timestamp={message.timestamp}
          onDismiss={onErrorDismiss ? () => onErrorDismiss(message.id) : undefined}
        />
      )

    case 'deep_research_banner':
      // Deep research status banners (success/failure)
      if (!message.deepResearchBannerData) {
        return null
      }
      return (
        <DeepResearchBanner
          bannerType={message.deepResearchBannerData.bannerType}
          jobId={message.deepResearchBannerData.jobId}
          totalTokens={message.deepResearchBannerData.totalTokens}
          toolCallCount={message.deepResearchBannerData.toolCallCount}
          timestamp={message.timestamp}
        />
      )

    case 'assistant':
      // Assistant messages (full reports) are not shown in chat area
      // They are displayed in the Details Panel instead
      return null

    default:
      return null
  }
}

/**
 * Welcome state shown when no messages exist.
 *
 * Signed in: a time-of-day greeting (with the user's first name when known),
 * hero-sized per the click dummy, centered above the floating composer — the
 * source-preset shortcut chips render with the composer itself (InputArea).
 * Signed out: a compact sign-in prompt. Bottom padding keeps the centered
 * content clear of the floating composer.
 */
interface WelcomeStateProps {
  isAuthenticated?: boolean
  onSignIn?: () => void
}

/** Time-of-day bucket for the greeting (morning / afternoon / evening). */
const greetingKeyForHour = (hour: number): 'morning' | 'afternoon' | 'evening' => {
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

const WelcomeState: FC<WelcomeStateProps> = ({ isAuthenticated = false, onSignIn }) => {
  const t = useTranslations('research')
  const tChat = useTranslations('chat')
  const { user } = useAuth()

  if (!isAuthenticated) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 pb-44 pt-6">
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-muted text-brand">
            <Lock className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-display">
            {t('chatArea.loggedOutTitle')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('chatArea.loggedOutBody')}</p>
          <Button
            onClick={onSignIn}
            aria-label={t('chatArea.signInSso')}
            className="transition active:scale-press"
          >
            {t('chatArea.signInSso')}
          </Button>
        </div>
      </div>
    )
  }

  const greeting = tChat(`greeting.${greetingKeyForHour(new Date().getHours())}`)
  const firstName = user?.name?.trim().split(/\s+/)[0]
  const heading = firstName
    ? tChat('greeting.withName', { greeting, name: firstName })
    : greeting

  return (
    <div className="flex flex-1 items-center justify-center px-4 pb-44 pt-6">
      <div className="flex w-full max-w-xl flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-display sm:text-3xl">{heading}</h1>
        <p className="text-sm text-muted-foreground">{tChat('greeting.subtitle')}</p>
      </div>
    </div>
  )
}
