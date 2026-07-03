// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
import { CheckCircle2, CircleEllipsis, FileText, Folder, Lock, MessageSquare } from 'lucide-react'
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
import { StarfieldAnimation } from '@/shared/components/StarfieldAnimation'

interface ChatAreaProps {
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Callback when sign in is clicked */
  onSignIn?: () => void
}

/**
 * Main chat area container with scrollable message list.
 * Shows welcome state when no messages exist.
 */
export const ChatArea: FC<ChatAreaProps> = memo(function ChatArea({
  isAuthenticated = false,
  onSignIn,
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
    <div className="scrollbar-hide flex flex-1 flex-col overflow-y-auto" aria-label="Chat messages">
      {isEmpty ? (
        <WelcomeState isAuthenticated={isAuthenticated} onSignIn={onSignIn} />
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-24 pt-4">
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
              <div key={message.id} className="flex flex-col gap-4">
                {/* Render the message */}
                <MessageRenderer
                  message={message}
                  onPromptRespond={handlePromptRespond}
                  onFileRetry={handleFileRetry}
                  onErrorDismiss={dismissErrorCard}
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
              </div>
            )
          })}

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
  onPromptRespond: (promptId: string, response: string) => void
  onFileRetry?: (messageId: string) => void
  onFileCancel?: (messageId: string) => void
  onFileDelete?: (messageId: string) => void
  onErrorDismiss?: (messageId: string) => void
}

const MessageRenderer: FC<MessageRendererProps> = ({
  message,
  onPromptRespond,
  onFileRetry: _onFileRetry,
  onFileCancel: _onFileCancel,
  onFileDelete: _onFileDelete,
  onErrorDismiss,
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
          className="flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-2"
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
 * Welcome state shown when no messages exist
 * Shows different content based on authentication state
 */
interface WelcomeStateProps {
  isAuthenticated?: boolean
  onSignIn?: () => void
}

const WelcomeState: FC<WelcomeStateProps> = ({ isAuthenticated = false, onSignIn }) => {
  const prompts = [
    'Compare OIB 2 fire resistance duties across building classes.',
    'Summarize accessibility requirements for a public retrofit.',
    'Find contradictions between uploaded plans and OIB guidance.',
  ]

  if (!isAuthenticated) {
    return (
      <div className="relative flex flex-1 items-center overflow-hidden p-8">
        <div className="pointer-events-none absolute right-[-8rem] top-1/2 h-[560px] w-[560px] -translate-y-1/2 opacity-30">
          <StarfieldAnimation particleCount={260} maxRadius={245} rotationSpeed={0.0005} />
        </div>
        <div className="relative mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[2rem] border bg-muted/30 p-8 shadow-[0_35px_100px_-75px_rgba(15,23,42,0.8)]">
            <div className="flex flex-col items-start gap-6">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted text-brand">
                <Lock className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                  secure workspace
                </span>
                <h1 className="max-w-2xl text-4xl font-semibold tracking-[-0.04em] md:text-5xl md:leading-none">
                  Grid opens after your organization is verified.
                </h1>
                <p className="max-w-xl text-sm text-muted-foreground">
                  Sign in to unlock project-scoped OIB research, document ingestion, and member
                  access controls.
                </p>
              </div>
              <Button
                size="lg"
                onClick={onSignIn}
                aria-label="Sign in with SSO"
                className="transition active:scale-[0.98]"
              >
                Sign in with SSO
              </Button>
            </div>
          </div>

          <div className="grid content-end gap-4">
            {['WorkOS authentication', 'Project-scoped retrieval', 'Role-based access'].map(
              (item, index) => (
                <div
                  key={item}
                  className="rounded-[1.5rem] border bg-muted/30 p-5"
                  style={{ animationDelay: `${index * 80}ms` }}
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-brand" aria-hidden="true" />
                    <span className="text-sm font-semibold">{item}</span>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex flex-1 items-center overflow-hidden p-8">
      <div className="pointer-events-none absolute -right-24 top-10 h-[520px] w-[520px] opacity-25">
        <StarfieldAnimation particleCount={300} maxRadius={230} rotationSpeed={0.001} />
      </div>
      <div className="relative mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[1.25fr_0.75fr]">
        <section className="rounded-[2rem] border bg-muted/30 p-8 shadow-[0_35px_100px_-75px_rgba(15,23,42,0.8)]">
          <div className="flex flex-col gap-7">
            <div className="flex max-w-3xl flex-col gap-4">
              <span className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                OIB research cockpit
              </span>
              <h1 className="text-4xl font-semibold tracking-[-0.04em] md:text-5xl md:leading-none">
                Start with a project, then ask for cited building-code reasoning.
              </h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Grid keeps retrieval scoped to the selected workspace and turns long guideline
                documents into traceable decisions.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.1fr_0.9fr]">
              <a
                href="/projects"
                className="group rounded-[1.5rem] border bg-muted p-5 transition hover:-translate-y-[2px] hover:bg-accent"
              >
                <div className="flex flex-col gap-4">
                  <Folder className="h-6 w-6 text-brand" aria-hidden="true" />
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-semibold">Open projects</span>
                    <span className="text-sm text-muted-foreground">
                      Create workspaces, manage documents, and invite roles.
                    </span>
                  </div>
                </div>
              </a>
              <div className="rounded-[1.5rem] border p-5">
                <div className="flex flex-col gap-4">
                  <CircleEllipsis className="h-6 w-6 text-brand" aria-hidden="true" />
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-semibold">Select context</span>
                    <span className="text-sm text-muted-foreground">
                      Use the workspace selector before running analysis.
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className="grid content-center gap-3">
          {prompts.map((prompt, index) => (
            <div
              key={prompt}
              className="rounded-[1.5rem] border bg-muted/30 p-5 transition hover:-translate-y-[1px]"
              style={{ animationDelay: `${index * 90}ms` }}
            >
              <div className="flex items-start gap-3">
                <MessageSquare className="mt-1 h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
                <span className="text-sm">{prompt}</span>
              </div>
            </div>
          ))}
        </aside>
      </div>
    </div>
  )
}
