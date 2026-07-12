/**
 * InputArea Component
 *
 * Chat input area at the bottom of the chat view.
 * Includes text input, tool buttons, and send action.
 * Uses WebSocket (useWebSocketChat) for full HITL support.
 *
 * When there's a pending interaction (HITL prompt), the input switches
 * to response mode and uses respondToInteraction instead of sendMessage.
 *
 * Disabled state when user is not authenticated.
 */

'use client'

import { type FC, memo, useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react'
import { Globe, FileText, Paperclip, SendHorizontal, X, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion, easeQuiet, springSnappy } from '@/components/motion'
import { useWebSocketChat, useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import { useLayoutStore } from '../store'
import { useAppConfig } from '@/shared/context'
import { useTranslations } from '@/i18n'
import { useFileUpload, useFileDragDrop, useFileUploadBanners } from '@/features/documents'

/** Connection mode for the chat */
export type ConnectionMode = 'sse' | 'websocket'

/** Maximum height of the auto-sizing textarea in pixels */
const TEXTAREA_MAX_HEIGHT_PX = 200

interface InputAreaProps {
  /** Placeholder text */
  placeholder?: string
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Connection mode: 'websocket' auto-connects, 'sse' disables auto-connect (default: 'websocket') */
  connectionMode?: ConnectionMode
}

/**
 * Chat input component with text area and action buttons.
 * Positioned at the bottom of the chat area.
 *
 * Uses WebSocket connection for full HITL (human-in-the-loop) support.
 * Set connectionMode='sse' to disable auto-connect (useful for testing).
 *
 * When pendingInteraction exists, input switches to response mode:
 * - Different placeholder text
 * - Uses respondToInteraction instead of sendMessage
 * - Shows visual indicator
 */
export const InputArea: FC<InputAreaProps> = memo(function InputArea({
  placeholder,
  isAuthenticated = false,
  connectionMode = 'websocket',
}) {
  const t = useTranslations('research')
  const [message, setMessage] = useState('')

  // File input ref for attachment button
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Textarea ref for the autosize effect
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Get file upload configuration from app config
  const { fileUpload: fileUploadConfig } = useAppConfig()

  // Check if current session is busy with operations
  const isBusy = useIsCurrentSessionBusy()

  // WebSocket chat hook for full HITL support
  const wsChat = useWebSocketChat({ autoConnect: connectionMode === 'websocket' })

  // Get current conversation for filtering files and ensureSession for auto-creation
  const currentConversation = useChatStore((state) => state.currentConversation)
  const ensureSession = useChatStore((state) => state.ensureSession)

  // One-shot composer prefill from deep links (?ask=) and welcome-screen chips.
  const composerPrefill = useChatStore((state) => state.composerPrefill)
  const consumeComposerPrefill = useChatStore((state) => state.consumeComposerPrefill)

  // Per-session composer drafts: the user's own in-progress text, persisted
  // per conversation id so it survives session switches AND reloads.
  const getComposerDraft = useChatStore((state) => state.getComposerDraft)
  const setComposerDraft = useChatStore((state) => state.setComposerDraft)
  const clearComposerDraft = useChatStore((state) => state.clearComposerDraft)

  // Active session id — the key under which this session's draft is stored.
  const currentSessionId = currentConversation?.id
  // Tracks which session's draft is currently loaded into `message`, so the
  // draft-sync effect only reloads when the ACTIVE session actually changes
  // (never on every keystroke). Pre-set by handleValueChange when a first
  // keystroke lazily creates a session, so that id transition doesn't wipe text.
  const loadedDraftSessionRef = useRef<string | undefined>(undefined)

  // Deep research completion state - disables new submissions after research completes
  const deepResearchStatus = useChatStore((state) => state.deepResearchStatus)
  const isDeepResearchStreaming = useChatStore((state) => state.isDeepResearchStreaming)
  const deepResearchOwnerConversationId = useChatStore(
    (state) => state.deepResearchOwnerConversationId
  )

  // Check for active deep research in conversation messages (persisted state)
  // This handles the case where ephemeral state has been reset (page refresh, session switch)
  const hasActiveDeepResearch = useChatStore((state) => {
    if (!state.currentConversation?.messages) return false
    return state.currentConversation.messages.some(
      (m) =>
        m.messageType === 'agent_response' &&
        m.deepResearchJobId &&
        (m.deepResearchJobStatus === 'submitted' || m.deepResearchJobStatus === 'running')
    )
  })

  // Check for a SUCCESSFUL deep research in conversation messages (persisted state).
  // This handles the case where ephemeral state has been reset (page refresh, session switch).
  const hasSuccessfulDeepResearch = useChatStore((state) => {
    if (!state.currentConversation?.messages) return false
    return state.currentConversation.messages.some(
      (m) =>
        m.messageType === 'agent_response' &&
        m.deepResearchJobId &&
        m.deepResearchJobStatus === 'success'
    )
  })

  // Check for a FAILED/INTERRUPTED deep research in conversation messages (persisted state).
  const hasFailedDeepResearch = useChatStore((state) => {
    if (!state.currentConversation?.messages) return false
    return state.currentConversation.messages.some(
      (m) =>
        m.messageType === 'agent_response' &&
        m.deepResearchJobId &&
        (m.deepResearchJobStatus === 'failure' ||
          m.deepResearchJobStatus === 'interrupted')
    )
  })

  // The composer is locked ONLY after a SUCCESSFUL research run: the finished
  // report defines the session's context, so follow-up questions belong in a
  // fresh session (this is the product rationale behind the lock). A failed or
  // interrupted run produced no report to protect, so the user must be able to
  // retry or follow up in place — do NOT lock those (UX-12).
  const isResearchSessionSuccessful =
    (!isDeepResearchStreaming && deepResearchStatus === 'success') ||
    hasSuccessfulDeepResearch

  // A terminal failure/interruption that is NOT superseded by a later success.
  // Drives contextual placeholder copy while keeping the composer unlocked.
  const isResearchSessionFailed =
    !isResearchSessionSuccessful &&
    ((!isDeepResearchStreaming &&
      (deepResearchStatus === 'failure' || deepResearchStatus === 'interrupted')) ||
      hasFailedDeepResearch)

  // Research session is in progress when:
  // 1. Ephemeral state is streaming, OR
  // 2. Persisted message has an active deep research job status
  const isResearchSessionInProgress =
    (isDeepResearchStreaming && deepResearchOwnerConversationId === currentConversation?.id) ||
    hasActiveDeepResearch

  // File upload hook - provides session files and handles validation internally
  const {
    uploadFiles,
    sessionFiles,
    isUploading,
    error: uploadError,
    clearError,
  } = useFileUpload({
    collectionName: currentConversation?.id,
  })

  // File upload banner hook - monitors file status and triggers banner messages in chat
  useFileUploadBanners()

  // -- Pending files warning state --
  // Tracks whether we've shown the pending-files warning for the current upload batch.
  // When true, the next submit will dismiss the warning and send the message.
  const [pendingFilesWarningActive, setPendingFilesWarningActive] = useState(false)

  // Track the number of uploading/ingesting files so we can detect NEW upload interactions
  // and reset the acknowledged state.
  const prevPendingCountRef = useRef(0)

  // Store actions for the warning banner
  const addFileUploadStatusCard = useChatStore((state) => state.addFileUploadStatusCard)
  const removeFileUploadWarning = useChatStore((state) => state.removeFileUploadWarning)

  // Compute pending files count for the current session
  const pendingSessionFiles = sessionFiles.filter(
    (f) => f.status === 'uploading' || f.status === 'ingesting'
  )
  const pendingCount = pendingSessionFiles.length

  // Detect NEW file upload interactions: when pendingCount increases from 0 (or from a lower value
  // after all files finished) to > 0, it means the user started a new upload batch.
  // Reset the warning state so it can trigger again on the next submit.
  //
  // Also: if the warning is currently displayed and all files finish ingesting,
  // auto-dismiss the warning since the files are now ready.
  useEffect(() => {
    const prev = prevPendingCountRef.current
    // New upload detected: pending count went from 0 → >0
    if (prev === 0 && pendingCount > 0) {
      setPendingFilesWarningActive(false)
    }
    // Files all finished while warning was active → auto-dismiss the warning
    if (prev > 0 && pendingCount === 0 && pendingFilesWarningActive) {
      removeFileUploadWarning()
      setPendingFilesWarningActive(false)
    }
    prevPendingCountRef.current = pendingCount
  }, [pendingCount, pendingFilesWarningActive, removeFileUploadWarning])

  const { sendMessage, isLoading, respondToInteraction, pendingInteraction } = wsChat

  // Register respondToInteraction in the store so sibling components (e.g. AgentPrompt) can use it
  const setRespondToInteractionFn = useChatStore((state) => state.setRespondToInteractionFn)
  useEffect(() => {
    setRespondToInteractionFn(respondToInteraction)
    return () => setRespondToInteractionFn(null)
  }, [respondToInteraction, setRespondToInteractionFn])

  // Layout store — individual selectors for minimal re-render surface
  const enabledDataSourceIds = useLayoutStore((s) => s.enabledDataSourceIds)
  const knowledgeLayerAvailable = useLayoutStore((s) => s.knowledgeLayerAvailable)
  const availableDataSources = useLayoutStore((s) => s.availableDataSources)
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const closeRightPanel = useLayoutStore((s) => s.closeRightPanel)
  const setDataSourcesPanelTab = useLayoutStore((s) => s.setDataSourcesPanelTab)

  // Check if we're in response mode (responding to a HITL prompt)
  const isResponseMode = !!pendingInteraction

  // DISABLE LOGIC
  // Disable input when:
  // 1. Not authenticated
  // 2. Session is busy AND not in HITL response mode (user must be able to type approve/reject)
  // 3. Deep research has completed/failed

  const isDisabledByAuth = !isAuthenticated
  const disabled = isDisabledByAuth || (isBusy && !isResponseMode) || isResearchSessionSuccessful

  // Autosize: grow the textarea with content, capped at TEXTAREA_MAX_HEIGHT_PX
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`
  }, [message])

  // Per-session draft restore: when the ACTIVE session changes (switching
  // sessions, or a session being restored after reload/hydration), load that
  // session's saved draft into the composer. Keyed on the id — typing within a
  // session never re-triggers this (the ref guard also covers the lazy
  // ensureSession id transition, which handleValueChange marks as loaded).
  useEffect(() => {
    if (loadedDraftSessionRef.current === currentSessionId) return
    loadedDraftSessionRef.current = currentSessionId
    setMessage(currentSessionId ? getComposerDraft(currentSessionId) : '')
  }, [currentSessionId, getComposerDraft])

  // Consume a queued composer prefill exactly once: populate the draft, focus
  // the textarea, and move the caret to the end. We never auto-send — the user
  // reviews/edits before submitting. The store clears the flag on read.
  //
  // Precedence vs. an existing draft: a prefill fills an EMPTY composer only.
  // If the session already holds the user's own in-progress text (local or
  // persisted draft), the prefill is dropped — consumed without applying — so
  // a deep link or chip can never silently clobber what the user was writing.
  useEffect(() => {
    if (composerPrefill === null || isDisabledByAuth) return
    const existingDraft = currentSessionId ? getComposerDraft(currentSessionId) : ''
    const composerHasText = message.trim().length > 0 || existingDraft.trim().length > 0
    if (composerHasText) {
      consumeComposerPrefill()
      return
    }
    const text = consumeComposerPrefill()
    if (text === null) return
    setMessage(text)
    // Persist the prefill as the session's draft too, so it survives a reload
    // just like typed text (only possible once a session exists).
    if (currentSessionId) setComposerDraft(currentSessionId, text)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }, [
    composerPrefill,
    consumeComposerPrefill,
    isDisabledByAuth,
    currentSessionId,
    getComposerDraft,
    setComposerDraft,
    message,
  ])

  // Dynamic placeholder based on state
  // Note: isResponseMode is checked before isBusy because the user needs to
  // see the response prompt even when the session is "busy" due to HITL.
  const getPlaceholder = (): string => {
    if (!isAuthenticated) return t('inputArea.signInToStart')
    if (isResearchSessionSuccessful) return t('inputArea.researchCompletedNewSession')
    if (isResponseMode) return t('inputArea.typeResponse')
    if (isBusy) return t('inputArea.pleaseWait')
    if (isResearchSessionFailed) return t('inputArea.researchFailedFollowUp')
    return placeholder ?? t('inputArea.placeholderDefault')
  }

  const handleSubmit = useCallback(async () => {
    if (!message.trim() || disabled) return
    const currentMessage = message.trim()
    // Capture the session up front — the draft is cleared against THIS id on a
    // successful send, even if the session changes underneath us mid-await.
    const submittingSessionId = currentConversation?.id

    // HITL responses always go through immediately — no file-pending check
    if (isResponseMode && respondToInteraction) {
      setMessage('')
      if (submittingSessionId) clearComposerDraft(submittingSessionId)
      respondToInteraction(currentMessage)
      return
    }

    // --- Pending files warning logic ---
    // If files are still uploading/ingesting AND we haven't shown the warning yet:
    // 1. Add a warning banner to the chat feed
    // 2. Keep the message in the input (don't clear or send)
    // 3. Mark warning as active so the next submit will proceed
    if (pendingCount > 0 && !pendingFilesWarningActive) {
      addFileUploadStatusCard('pending_warning', pendingCount, `pending-warning-${Date.now()}`)
      setPendingFilesWarningActive(true)
      return // Don't send — keep message in input
    }

    // If the warning is currently active (user is re-submitting to acknowledge):
    // Dismiss the warning banner first, then send the message
    if (pendingFilesWarningActive) {
      removeFileUploadWarning()
      setPendingFilesWarningActive(false)
    }

    // Proceed with normal send
    setMessage('')
    try {
      // sendMessage reports immediate failures (dead socket, no conversation)
      // via a false return rather than throwing.
      const sent = await sendMessage(currentMessage)
      if (sent === false) throw new Error('Message could not be sent or queued')
      // Sent successfully — drop this session's saved draft so it can't
      // resurface on the next visit. Only on success: a failed send keeps the
      // draft so nothing the user typed is lost.
      if (submittingSessionId) clearComposerDraft(submittingSessionId)
    } catch (error) {
      console.error('Failed to send message:', error)
      // Restore the message so the user doesn't lose what they typed. The
      // persisted draft was never cleared, so it is retained too.
      setMessage(currentMessage)
      toast.error(t('inputArea.messageNotSent'), {
        description: t('inputArea.messageNotSentDesc'),
      })
    }
  }, [
    message,
    disabled,
    isResponseMode,
    respondToInteraction,
    sendMessage,
    pendingCount,
    pendingFilesWarningActive,
    addFileUploadStatusCard,
    removeFileUploadWarning,
    currentConversation,
    clearComposerDraft,
    t,
  ])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Enter') return
      // Shift+Enter inserts a newline — let the textarea handle it natively.
      if (e.shiftKey) return
      // Plain Enter sends; Cmd/Ctrl+Enter also sends as a discoverable power
      // binding. Both funnel through a single handleSubmit call (no double-fire),
      // and handleSubmit enforces the disabled/streaming/HITL guards.
      e.preventDefault()
      handleSubmit()
    },
    [handleSubmit]
  )

  const handleValueChange = useCallback(
    (value: string) => {
      if (isDisabledByAuth) return // Don't allow typing when not authenticated

      // Persist a session as soon as the user starts interacting via typed input.
      // This keeps logo-triggered "new session" drafts out of history until touched.
      let sessionId = currentConversation?.id
      if (!sessionId && value.trim().length > 0) {
        sessionId = ensureSession()
        // ensureSession just activated a brand-new session; mark its id as the
        // loaded draft so the draft-sync effect doesn't reset the text we set here.
        if (sessionId) loadedDraftSessionRef.current = sessionId
      }

      setMessage(value)
      // Persist the draft under the active session (once one exists) so it
      // survives navigating away/back and a reload.
      if (sessionId) setComposerDraft(sessionId, value)
    },
    [isDisabledByAuth, currentConversation, ensureSession, setComposerDraft]
  )

  // Handle attach button click
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || isDisabledByAuth || isUploading || isBusy) return

      const sessionId = ensureSession()
      if (!sessionId) {
        console.error('Failed to create session for upload')
        return
      }

      // Open the files tab immediately so the user sees instant feedback
      setDataSourcesPanelTab('files')
      openRightPanel('data-sources')

      // uploadFiles validates internally and sets error if invalid
      await uploadFiles(files)
    },
    [
      ensureSession,
      uploadFiles,
      openRightPanel,
      setDataSourcesPanelTab,
      isDisabledByAuth,
      isUploading,
      isBusy,
    ]
  )

  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: handleFilesSelected,
    disabled: isDisabledByAuth || isUploading || isBusy,
  })

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      await handleFilesSelected(files)
      // Reset input so same file can be selected again
      e.target.value = ''
    },
    [handleFilesSelected]
  )

  // Count of attached files (successful or in progress) for current session
  const attachedFilesCount = sessionFiles.filter(
    (f) => f.status === 'uploading' || f.status === 'ingesting' || f.status === 'success'
  ).length

  // Data sources counts for indicator
  const enabledSourcesCount = enabledDataSourceIds.length
  const totalSourcesCount = availableDataSources?.length ?? 0

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 sm:pb-4">
      <div
        className={cn(
          'relative flex flex-col rounded-2xl border bg-card p-4 shadow-sm transition-[box-shadow,border-color] duration-200 ease-out focus-within:ring-2 focus-within:ring-ring/30',
          isDisabledByAuth && 'opacity-60',
          isDragging && isUnsupportedDrag
            ? 'border-dashed border-error'
            : isDragging
              ? 'border-dashed border-brand'
              : ''
        )}
        {...dragHandlers}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/90">
            <div className="flex flex-col items-center gap-2">
              {isUnsupportedDrag ? (
                <XCircle className="h-8 w-8 text-error" aria-hidden="true" />
              ) : (
                <Paperclip className="h-8 w-8 text-brand" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'text-sm font-semibold',
                  isUnsupportedDrag ? 'text-error' : 'text-brand'
                )}
              >
                {isUnsupportedDrag ? t('inputArea.unsupportedFileType') : t('inputArea.dropToUpload')}
              </span>
              {isUnsupportedDrag && (
                <span className="text-xs text-muted-foreground">
                  {t('inputArea.accepts', { types: fileUploadConfig.acceptedTypes })}
                </span>
              )}
            </div>
          </div>
        )}
        {/* Text Input */}
        <Textarea
          ref={textareaRef}
          className="max-h-52 min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          value={message}
          onChange={(e) => handleValueChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={getPlaceholder()}
          disabled={disabled}
          rows={1}
          aria-label={isResponseMode ? t('inputArea.responseInput') : t('inputArea.chatMessageInput')}
        />

        {/* Upload Error Display */}
        <AnimatePresence initial={false}>
          {uploadError && (
            <motion.div
              key="upload-error"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={easeQuiet}
            >
              <Alert variant="destructive" className="mt-2">
                <AlertDescription className="flex w-full items-start justify-between gap-2">
                  <span>{uploadError}</span>
                  <button
                    type="button"
                    onClick={clearError}
                    aria-label={t('dismissError')}
                    className="shrink-0 rounded-full p-1 opacity-70 transition-opacity duration-200 ease-out hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </AlertDescription>
              </Alert>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bottom Actions Bar */}
        <div className="mt-3 flex items-center justify-end">
          {/* Right Actions: Counters, Attach, Research, Submit */}
          <div className="flex items-center gap-2">
            {/* Sources indicator - clickable to toggle data connections tab */}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-2.5 text-muted-foreground"
              onClick={() => {
                if (useLayoutStore.getState().rightPanel === 'data-sources') {
                  closeRightPanel()
                } else {
                  setDataSourcesPanelTab('connections')
                  openRightPanel('data-sources')
                }
              }}
              disabled={isDisabledByAuth}
              aria-label={t('inputArea.toggleDataSources')}
              title={t('inputArea.selectedConnections')}
            >
              <Globe className="size-3" aria-hidden="true" />
              <span className="text-xs font-semibold">
                {enabledSourcesCount}/{totalSourcesCount}
              </span>
            </Button>

            {/* Files indicator - clickable to toggle files tab */}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full px-2.5 text-muted-foreground"
              onClick={() => {
                if (useLayoutStore.getState().rightPanel === 'data-sources') {
                  closeRightPanel()
                } else {
                  setDataSourcesPanelTab('files')
                  openRightPanel('data-sources')
                }
              }}
              disabled={isDisabledByAuth || !knowledgeLayerAvailable}
              aria-label={t('inputArea.openFiles')}
              title={knowledgeLayerAvailable ? t('inputArea.availableFiles') : t('inputArea.uploadNotAvailable')}
            >
              <FileText className="size-3" aria-hidden="true" />
              <span className="text-xs font-semibold">{attachedFilesCount}</span>
            </Button>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={fileUploadConfig.acceptedTypes}
              className="hidden"
              tabIndex={-1}
              onChange={handleFileChange}
            />

            {/* Attach files */}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full text-muted-foreground"
              onClick={handleAttachClick}
              disabled={isDisabledByAuth || isUploading || isBusy || !knowledgeLayerAvailable}
              aria-label={t('inputArea.attachFiles')}
              title={
                isBusy
                  ? t('inputArea.uploadDisabledBusy')
                  : !knowledgeLayerAvailable
                    ? t('inputArea.uploadNotAvailable')
                    : t('inputArea.selectFiles')
              }
            >
              <Paperclip className="h-4 w-4" aria-hidden="true" />
            </Button>

            {/* Send button - wrapped in Popover when research session is complete/in-progress.
                Exception: isResponseMode always shows the normal send button so users can
                submit HITL responses (approve/reject) even during active research. */}
            {isResearchSessionSuccessful && !isResponseMode ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    aria-label={t('inputArea.researchCompletedAria')}
                    title={t('inputArea.researchCompleted')}
                  >
                    <SendHorizontal className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-auto max-w-xs p-3">
                  <p className="text-sm">
                    {t('inputArea.researchCompletedPopover')}
                  </p>
                </PopoverContent>
              </Popover>
            ) : isResearchSessionInProgress && !isResponseMode ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    aria-label={t('inputArea.researchInProgressAria')}
                    title={t('inputArea.researchInProgress')}
                  >
                    <SendHorizontal className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-auto max-w-xs p-3">
                  <p className="text-sm">
                    {t('inputArea.researchInProgressPopover')}
                  </p>
                </PopoverContent>
              </Popover>
            ) : (
              <motion.div
                className="inline-flex"
                whileTap={{ scale: 0.94 }}
                transition={springSnappy}
                // whileTap makes framer-motion inject tabindex="0"; the wrapper must
                // not be a tab stop — the Button inside is the real control.
                tabIndex={-1}
              >
                <Button
                  size="sm"
                  onClick={handleSubmit}
                  disabled={!message.trim() || disabled}
                  aria-label={isResponseMode ? t('inputArea.sendResponse') : t('inputArea.sendMessage')}
                  title={t('inputArea.sendQuery')}
                >
                  <AnimatePresence mode="popLayout" initial={false}>
                    {isLoading ? (
                      <motion.span
                        key="loading"
                        className="animate-pulse"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={springSnappy}
                      >
                        ...
                      </motion.span>
                    ) : (
                      <motion.span
                        key="send"
                        className="inline-flex"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={springSnappy}
                      >
                        <SendHorizontal className="h-4 w-4" aria-hidden="true" />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Button>
              </motion.div>
            )}
          </div>
        </div>
      </div>
      {/* AI-transparency disclosure (EU AI Act Art. 50): users must know they
          interact with an AI system and that answers need verification. */}
      <p className="mt-2 text-center text-xs leading-relaxed text-muted-foreground">
        {t('inputArea.aiDisclosure')}
      </p>
    </div>
  )
})
