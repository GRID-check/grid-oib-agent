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

import {
  type FC,
  memo,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Layers,
  Loader2,
  Paperclip,
  RotateCw,
  Sparkles,
  Square,
  X,
  XCircle,
  ZoomIn,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion, easeQuiet, springSnappy } from '@/components/motion'
import { useAuth } from '@/adapters/auth'
import { useWebSocketChat, useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import { useLayoutStore } from '../store'
import { computePresetSourceIds } from '../lib/source-presets'
import type { SourcePresetId } from '../types'
import type { DataSource } from '../data-sources'
import { SourceSignalChip, SourceSignalChipToggle } from './SourceSignalChip'
import { DataConnectionCard } from './DataConnectionCard'
import { FileSourcesTab } from './FileSourcesTab'
import { useAppConfig } from '@/shared/context'
import { useTranslations } from '@/i18n'
import { useFileUpload, useFileDragDrop } from '@/features/documents'
import type { TrackedFile } from '@/features/documents'

/** Preset chip order + their provenance signals (spec §4 --source-* family). */
const SOURCE_PRESETS: Array<{ id: SourcePresetId; signal: SourcePresetId }> = [
  { id: 'law', signal: 'law' },
  { id: 'project', signal: 'project' },
  { id: 'office', signal: 'office' },
]

/** Connection mode for the chat */
export type ConnectionMode = 'sse' | 'websocket'

/** Maximum height of the auto-sizing textarea in pixels */
const TEXTAREA_MAX_HEIGHT_PX = 200

/**
 * Connection toggle list rendered inside the "Datengrundlage" popover.
 * Lifted from the old DataSourcesPanel connections tab — same store actions,
 * same DataConnectionCard, plus a single enable/disable-all control. Kept as a
 * child so its store subscriptions only mount while the popover is open.
 */
const SourcesPopoverContent: FC = () => {
  const t = useTranslations('research')
  const tc = useTranslations('common')
  const { idToken } = useAuth()
  const hasValidToken = !!idToken

  const enabledDataSourceIds = useLayoutStore((s) => s.enabledDataSourceIds)
  const availableDataSources = useLayoutStore((s) => s.availableDataSources)
  const dataSourcesLoading = useLayoutStore((s) => s.dataSourcesLoading)
  const dataSourcesError = useLayoutStore((s) => s.dataSourcesError)
  const toggleDataSource = useLayoutStore((s) => s.toggleDataSource)
  const setEnabledDataSources = useLayoutStore((s) => s.setEnabledDataSources)
  const fetchDataSources = useLayoutStore((s) => s.fetchDataSources)
  const saveDataSourcesToConversation = useChatStore((s) => s.saveDataSourcesToConversation)
  const isBusy = useIsCurrentSessionBusy()

  const enabledSourcesSet = useMemo(() => new Set(enabledDataSourceIds), [enabledDataSourceIds])

  const displaySources: DataSource[] = useMemo(() => {
    if (!availableDataSources || availableDataSources.length === 0) return []
    return availableDataSources.map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description ?? '',
      category: source.category ?? 'enterprise',
      defaultEnabled: true,
      requiresAuth: source.requires_auth ?? false,
    }))
  }, [availableDataSources])

  const availableSources = useMemo(
    () => displaySources.filter((source) => !source.requiresAuth || hasValidToken),
    [displaySources, hasValidToken]
  )

  const enabledAvailableCount = enabledDataSourceIds.filter((id) =>
    availableSources.some((s) => s.id === id)
  ).length
  const allAvailableEnabled =
    enabledAvailableCount === availableSources.length && availableSources.length > 0

  const handleToggle = useCallback(
    (sourceId: string, enabled: boolean) => {
      const updatedIds = enabled
        ? [...enabledDataSourceIds, sourceId]
        : enabledDataSourceIds.filter((id) => id !== sourceId)
      toggleDataSource(sourceId)
      saveDataSourcesToConversation?.(updatedIds)
    },
    [toggleDataSource, enabledDataSourceIds, saveDataSourcesToConversation]
  )

  const handleToggleAll = useCallback(() => {
    const updatedIds = allAvailableEnabled ? [] : availableSources.map((s) => s.id)
    setEnabledDataSources(updatedIds)
    saveDataSourcesToConversation?.(updatedIds)
  }, [allAvailableEnabled, setEnabledDataSources, availableSources, saveDataSourcesToConversation])

  return (
    <div className="flex max-h-[min(60vh,420px)] flex-col">
      <div className="mb-2 flex items-center gap-2">
        <Layers className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <span className="text-sm font-semibold">{t('dataSourcesPanel.title')}</span>
      </div>

      {/* Enable/disable all */}
      <div
        role="button"
        tabIndex={isBusy ? -1 : 0}
        onClick={isBusy ? undefined : handleToggleAll}
        onKeyDown={(e) => {
          if (!isBusy && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            handleToggleAll()
          }
        }}
        className={cn(
          'bg-card shadow-xs focus-visible:ring-ring/50 mb-2 flex items-center justify-between rounded-xl p-2.5 outline-none transition-colors focus-visible:ring-2',
          isBusy ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent cursor-pointer'
        )}
        aria-pressed={allAvailableEnabled}
        aria-disabled={isBusy}
        aria-label={
          isBusy
            ? t('dataSourcesPanel.allAvailableDisabledOps')
            : t('dataSourcesPanel.allAvailableState', {
                state: allAvailableEnabled
                  ? t('dataConnectionCard.enabled')
                  : t('dataConnectionCard.disabled'),
              })
        }
        title={isBusy ? t('dataSources.changesDisabledBusy') : undefined}
      >
        <span className="text-sm font-medium">{t('dataSourcesPanel.disableEnableAll')}</span>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={allAvailableEnabled}
            onCheckedChange={handleToggleAll}
            disabled={isBusy}
            aria-label={
              isBusy
                ? t('dataSourcesPanel.toggleAllDisabled')
                : allAvailableEnabled
                  ? t('dataSourcesPanel.disableAll')
                  : t('dataSourcesPanel.enableAll')
            }
          />
        </div>
      </div>

      {/* Individual connections */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {dataSourcesLoading ? (
          <div className="flex items-center justify-center py-6">
            <Spinner label={t('dataSources.loading')} />
          </div>
        ) : dataSourcesError ? (
          <div className="flex flex-col items-center py-4">
            <span className="text-destructive mb-2 text-sm">{t('dataSources.unableToLoad')}</span>
            <span className="text-muted-foreground mb-3 text-xs">{dataSourcesError}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchDataSources()}
              aria-label={t('dataSources.retryAria')}
            >
              {tc('actions.retry')}
            </Button>
          </div>
        ) : displaySources.length === 0 ? (
          <div className="flex flex-col items-center py-4">
            <span className="text-muted-foreground text-sm">{t('dataSources.none')}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {displaySources.map((source) => {
              const isSourceAvailable = !source.requiresAuth || hasValidToken
              return (
                <DataConnectionCard
                  key={source.id}
                  source={source}
                  isEnabled={enabledSourcesSet.has(source.id)}
                  isAvailable={isSourceAvailable}
                  isBusy={isBusy}
                  unavailableReason={
                    !isSourceAvailable ? t('dataSourcesPanel.signInRequiredSource') : undefined
                  }
                  onToggle={handleToggle}
                />
              )
            })}
          </div>
        )}
      </div>

      <p className="text-muted-foreground mt-2 text-xs">{t('inputArea.sourcesPopoverAllHint')}</p>
    </div>
  )
}

/**
 * Inline removable file chip shown above the composer textarea. Live status:
 * spinner while uploading/ingesting, green check on success, red on failure
 * (failed chips also offer a retry). The ✕ deletes the file.
 */
const FileChip: FC<{
  file: TrackedFile
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}> = ({ file, onRemove, onRetry }) => {
  const t = useTranslations('research')
  const isPending = file.status === 'uploading' || file.status === 'ingesting'
  const isFailed = file.status === 'failed'
  const statusTitle = isPending
    ? t('inputArea.fileUploadingStatus')
    : isFailed
      ? file.errorMessage || t('inputArea.fileFailedStatus')
      : t('inputArea.fileReadyStatus')

  return (
    <span
      className={cn(
        'bg-card inline-flex h-7 max-w-[200px] items-center gap-1.5 rounded-md border px-2 text-[12px]',
        isFailed && 'border-error/50'
      )}
      title={`${file.fileName} — ${statusTitle}`}
    >
      {isPending ? (
        <Loader2 className="text-muted-foreground size-3 shrink-0 animate-spin" aria-hidden="true" />
      ) : isFailed ? (
        <span className="bg-error size-2 shrink-0 rounded-full" aria-hidden="true" />
      ) : (
        <Check className="text-status-active size-3 shrink-0" aria-hidden="true" />
      )}
      <span className="text-foreground/85 min-w-0 truncate">{file.fileName}</span>
      {isFailed && (
        <button
          type="button"
          onClick={() => onRetry(file.id)}
          aria-label={t('inputArea.retryUpload')}
          title={t('inputArea.retryUpload')}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2"
        >
          <RotateCw className="size-3" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        onClick={() => onRemove(file.id)}
        aria-label={t('inputArea.removeFile', { name: file.fileName })}
        title={t('inputArea.removeFile', { name: file.fileName })}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </span>
  )
}

interface InputAreaProps {
  /** Placeholder text */
  placeholder?: string
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Connection mode: 'websocket' auto-connects, 'sse' disables auto-connect (default: 'websocket') */
  connectionMode?: ConnectionMode
  /** Name of the active project, shown in the composer scope chip */
  projectName?: string
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
  projectName,
}) {
  const t = useTranslations('research')
  const tChat = useTranslations('chat')
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
        (m.deepResearchJobStatus === 'failure' || m.deepResearchJobStatus === 'interrupted')
    )
  })

  // The composer is locked ONLY after a SUCCESSFUL research run: the finished
  // report defines the session's context, so follow-up questions belong in a
  // fresh session (this is the product rationale behind the lock). A failed or
  // interrupted run produced no report to protect, so the user must be able to
  // retry or follow up in place — do NOT lock those (UX-12).
  const isResearchSessionSuccessful =
    (!isDeepResearchStreaming && deepResearchStatus === 'success') || hasSuccessfulDeepResearch

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
    deleteFile,
    retryFile,
    isUploading,
    error: uploadError,
    clearError,
  } = useFileUpload({
    collectionName: currentConversation?.id,
  })

  // Count of files still uploading/ingesting for the current session. Drives
  // the "still processing" hint on the send button (send is never blocked).
  const pendingCount = sessionFiles.filter(
    (f) => f.status === 'uploading' || f.status === 'ingesting'
  ).length

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
  const deepResearchIntent = useLayoutStore((s) => s.deepResearchIntent)
  const setDeepResearchIntent = useLayoutStore((s) => s.setDeepResearchIntent)
  const activeSourcePreset = useLayoutStore((s) => s.activeSourcePreset)
  const applySourcePreset = useLayoutStore((s) => s.applySourcePreset)

  // Persist source selection per conversation, exactly like the panel does.
  const saveDataSourcesToConversation = useChatStore((s) => s.saveDataSourcesToConversation)

  // Streaming state + cancel action for the composer stop button (C1).
  // stopStreaming is added by the STREAMING agent in messages-store; selecting
  // it defensively means the button no-ops until that half of the contract lands.
  const isStreaming = useChatStore((s) => s.isStreaming)
  const stopStreaming = useChatStore((s) => s.stopStreaming)

  /**
   * Shortcut preset chips: apply the subset of REAL sources the preset stands
   * for (see lib/source-presets.ts). Clicking the active preset again restores
   * the default all-enabled state.
   */
  const handlePresetClick = useCallback(
    (preset: SourcePresetId) => {
      const { availableDataSources: sources, activeSourcePreset: current } =
        useLayoutStore.getState()
      const nextIds =
        current === preset
          ? (sources ?? []).map((s) => s.id)
          : computePresetSourceIds(preset, sources ?? [])
      applySourcePreset(current === preset ? null : preset, nextIds)
      saveDataSourcesToConversation?.(nextIds)
    },
    [applySourcePreset, saveDataSourcesToConversation]
  )

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
    return placeholder ?? tChat('composer.placeholder')
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

    // Files may still be uploading/ingesting — we no longer gate the send behind
    // a double-submit banner. The send button surfaces a subtle inline hint
    // (see title below) but the user is always free to send.
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

      // Attached files now surface as inline chips above the composer, so there
      // is no panel to auto-open — the chips give instant feedback in place.
      // Pass the (possibly just-created) session explicitly: the hook's
      // memoized collectionName still reflects the previous render, so the
      // first upload in a fresh session would otherwise abort.
      await uploadFiles(files, sessionId)
    },
    [ensureSession, uploadFiles, isDisabledByAuth, isUploading, isBusy]
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

  // Paste-to-attach: route any files on the clipboard (e.g. a pasted image or
  // a copied document) through the same upload path. Text pastes are left to
  // the textarea's native handling — we only intervene when files are present.
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length === 0) return
      e.preventDefault()
      handleFilesSelected(files)
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

  // Empty thread → the shortcut preset chips render under the composer.
  const isEmptyThread = !currentConversation || currentConversation.messages.length === 0

  // Scope chip label: the active project (display-only scope; cross-project
  // search does not exist yet — spec §2.3, honest disabled option).
  const scopeLabel = projectName || tChat('composer.scopeFallback')

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 sm:pb-4">
      <div
        className={cn(
          // Composer card per the click dummy: white card, hairline border,
          // soft CARD-tier shadow (not the modal shadow-lg, which detached it
          // as a floating object over the chat plane); textarea on top,
          // hairline-separated control row below. On-scale radius.
          'bg-card focus-within:ring-ring/30 relative flex flex-col rounded-xl border px-4 py-[14px] shadow-sm transition-[box-shadow,border-color] duration-200 ease-out focus-within:ring-2',
          isDisabledByAuth && 'opacity-60',
          isDragging && isUnsupportedDrag
            ? 'border-error border-dashed'
            : isDragging
              ? 'border-brand border-dashed'
              : ''
        )}
        {...dragHandlers}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="bg-background/90 absolute inset-0 z-10 flex items-center justify-center rounded-xl">
            <div className="flex flex-col items-center gap-2">
              {isUnsupportedDrag ? (
                <XCircle className="text-error h-8 w-8" aria-hidden="true" />
              ) : (
                <Paperclip className="text-brand h-8 w-8" aria-hidden="true" />
              )}
              <span
                className={cn(
                  'text-sm font-semibold',
                  isUnsupportedDrag ? 'text-error' : 'text-brand'
                )}
              >
                {isUnsupportedDrag
                  ? t('inputArea.unsupportedFileType')
                  : t('inputArea.dropToUpload')}
              </span>
              {isUnsupportedDrag && (
                <span className="text-muted-foreground text-xs">
                  {t('inputArea.accepts', { types: fileUploadConfig.acceptedTypes })}
                </span>
              )}
            </div>
          </div>
        )}
        {/* Inline file chips — one per attached file, above the textarea.
            Live status dot/spinner, retry on failure, ✕ to remove. */}
        {sessionFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5" aria-label={t('inputArea.manageFiles')}>
            {sessionFiles.map((file) => (
              <FileChip
                key={file.id}
                file={file}
                onRemove={deleteFile}
                onRetry={retryFile}
              />
            ))}
          </div>
        )}

        {/* Text Input */}
        <Textarea
          ref={textareaRef}
          // text-base (16px) below md keeps iOS Safari from zooming the page
          // when the composer gains focus; desktop keeps the tighter 14.5px.
          className="max-h-52 min-h-[52px] resize-none border-0 bg-transparent px-1.5 py-1 text-base leading-[1.55] shadow-none focus-visible:ring-0 md:text-[14.5px]"
          value={message}
          onChange={(e) => handleValueChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={getPlaceholder()}
          disabled={disabled}
          rows={1}
          aria-label={
            isResponseMode ? t('inputArea.responseInput') : t('inputArea.chatMessageInput')
          }
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
                    className="focus-visible:ring-ring/60 shrink-0 rounded-md p-1 opacity-70 transition-opacity duration-200 ease-out hover:opacity-100 focus-visible:outline-none focus-visible:ring-2"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </AlertDescription>
              </Alert>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bottom control row — hairline-separated from the textarea.
            Order per the click dummy: scope · Datengrundlage · Deep-Research,
            then attach + send pushed right. */}
        <div className="mt-[14px] flex flex-wrap items-center gap-1.5 border-t pt-[14px]">
          {/* Scope chip — current project; cross-project is honestly disabled.
              Dashed status-active dot + label + chevron (dummy composer). */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={isDisabledByAuth}
                aria-label={tChat('composer.scopeAria', { project: scopeLabel })}
                title={tChat('composer.scopeAria', { project: scopeLabel })}
                className="bg-card shadow-xs hover:bg-accent focus-visible:ring-ring/50 inline-flex h-8 min-w-0 items-center gap-[7px] rounded-md border px-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="border-status-active flex size-[14px] shrink-0 items-center justify-center rounded-full border border-dashed">
                  <span className="bg-status-active size-[5px] rounded-full" />
                </span>
                <span className="text-foreground/85 max-w-44 truncate text-[12.5px] font-medium">
                  {scopeLabel}
                </span>
                <ChevronDown className="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-64 p-1.5">
              <div
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm"
                aria-current="true"
              >
                <Check className="text-foreground size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium">{scopeLabel}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {tChat('composer.scopeCurrent')}
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span wrapper: disabled elements don't emit hover events */}
                  <span className="block" tabIndex={0}>
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="text-muted-foreground flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-2 text-sm opacity-60"
                    >
                      <span className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{tChat('composer.scopeAll')}</span>
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-60">
                  {tChat('composer.scopeAllSoon')}
                </TooltipContent>
              </Tooltip>
            </PopoverContent>
          </Popover>

          {/* Datengrundlage chip — opens a Popover hosting the connection
              toggle list + enable/disable-all (C3/C4). Enabled-count badge
              stays live on the trigger. */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={isDisabledByAuth}
                aria-label={tChat('composer.sourcesAria', {
                  enabled: enabledSourcesCount,
                  total: totalSourcesCount,
                })}
                title={t('inputArea.selectedConnections')}
                className="bg-card text-muted-foreground shadow-xs hover:bg-accent focus-visible:ring-ring/50 inline-flex h-8 shrink-0 items-center gap-[7px] rounded-md border px-[11px] text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Layers className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{tChat('composer.sources')}</span>
                <span className="bg-muted text-foreground/80 inline-flex h-4 min-w-4 items-center justify-center rounded-md px-1 text-[10.5px] font-semibold tabular-nums">
                  {enabledSourcesCount}
                </span>
                <ChevronDown
                  className="text-muted-foreground size-3 shrink-0"
                  aria-hidden="true"
                />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-80 p-3">
              <SourcesPopoverContent />
            </PopoverContent>
          </Popover>

          {/* Active source preset — colored provenance chip (icon+label+color) */}
          {activeSourcePreset && (
            <SourceSignalChip
              signal={activeSourcePreset}
              className="max-w-40"
              title={tChat(`shortcuts.presets.${activeSourcePreset}`)}
            >
              {tChat(`shortcuts.presets.${activeSourcePreset}`)}
            </SourceSignalChip>
          )}

          {/* Deep-Research intent pill — preference, NOT a hard trigger:
              the agent auto-escalates on its own (spec §2.2(6)) */}
          <button
            type="button"
            aria-pressed={deepResearchIntent}
            aria-label={tChat('composer.deepResearchAria')}
            title={tChat('composer.deepResearchHint')}
            disabled={isDisabledByAuth}
            onClick={() => setDeepResearchIntent(!deepResearchIntent)}
            className={cn(
              'inline-flex h-8 shrink-0 cursor-pointer items-center gap-[7px] rounded-md border px-3 text-[12.5px] font-medium transition-[color,background-color,box-shadow] duration-200 ease-out',
              'focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
              deepResearchIntent
                ? 'border-primary bg-primary text-primary-foreground shadow-xs'
                : 'border-border bg-card text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground'
            )}
          >
            <ZoomIn className="size-3.5" aria-hidden="true" />
            <span>{tChat('composer.deepResearch')}</span>
          </button>

          {/* Right Actions: manage-files, attach, submit — pushed right */}
          <div className="ml-auto flex items-center gap-1">
            {/* Manage files — opens a Dialog hosting the full FileSourcesTab
                (browse, upload zone, per-file delete). Replaces the old
                right-panel toggle. Shown only when files exist. */}
            {attachedFilesCount > 0 && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground h-8 rounded-lg px-2.5"
                    disabled={isDisabledByAuth || !knowledgeLayerAvailable}
                    aria-label={t('inputArea.manageFilesCount', { count: attachedFilesCount })}
                    title={
                      knowledgeLayerAvailable
                        ? t('inputArea.manageFiles')
                        : t('inputArea.uploadNotAvailable')
                    }
                  >
                    <FileText className="size-3" aria-hidden="true" />
                    <span className="text-xs font-semibold">{attachedFilesCount}</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>{t('inputArea.manageFiles')}</DialogTitle>
                  </DialogHeader>
                  <div className="flex max-h-[60vh] flex-col overflow-y-auto">
                    <FileSourcesTab />
                  </div>
                </DialogContent>
              </Dialog>
            )}

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
              className="text-subtle size-[34px] rounded-[10px]"
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
                    size="icon"
                    className="size-9 rounded-lg shadow-md"
                    aria-label={t('inputArea.researchCompletedAria')}
                    title={t('inputArea.researchCompleted')}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-auto max-w-xs p-3">
                  <p className="text-sm">{t('inputArea.researchCompletedPopover')}</p>
                </PopoverContent>
              </Popover>
            ) : isResearchSessionInProgress && !isResponseMode ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    size="icon"
                    className="size-9 rounded-lg shadow-md"
                    aria-label={t('inputArea.researchInProgressAria')}
                    title={t('inputArea.researchInProgress')}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-auto max-w-xs p-3">
                  <p className="text-sm">{t('inputArea.researchInProgressPopover')}</p>
                </PopoverContent>
              </Popover>
            ) : isStreaming && !isResponseMode ? (
              // Stop button (C1): while a shallow-thinking turn streams, replace
              // the disabled send button with a stop control that cancels the
              // in-flight turn via the chat store's stopStreaming action.
              <motion.div
                className="inline-flex"
                whileTap={{ scale: 0.94 }}
                transition={springSnappy}
                tabIndex={-1}
              >
                <Button
                  size="icon"
                  className="size-9 rounded-lg shadow-md"
                  onClick={() => stopStreaming?.()}
                  aria-label={t('inputArea.stopStreaming')}
                  title={t('inputArea.stopStreaming')}
                >
                  <Square className="size-3.5 fill-current" aria-hidden="true" />
                </Button>
              </motion.div>
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
                  size="icon"
                  className="size-9 rounded-lg shadow-md"
                  onClick={handleSubmit}
                  disabled={!message.trim() || disabled}
                  aria-label={
                    isResponseMode ? t('inputArea.sendResponse') : t('inputArea.sendMessage')
                  }
                  title={
                    pendingCount > 0 ? t('inputArea.sendWhilePending') : t('inputArea.sendQuery')
                  }
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
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Button>
              </motion.div>
            )}
          </div>
        </div>

        {/* Honest Deep-Research hint: the pill records intent; escalation
            stays automatic. Never promises a forced deep-research run. */}
        {deepResearchIntent && (
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed" role="note">
            {tChat('composer.deepResearchHint')}
          </p>
        )}
      </div>

      {/* Shortcut preset chips (empty thread only): map onto the REAL data
          sources in the store — see lib/source-presets.ts. */}
      {isEmptyThread && !isDisabledByAuth && (
        <div
          className="mt-[18px] flex flex-wrap items-center justify-center gap-2"
          role="group"
          aria-label={tChat('shortcuts.label')}
        >
          <span className="text-muted-foreground mr-1.5 text-[12.5px]">
            {tChat('shortcuts.label')}
          </span>
          {SOURCE_PRESETS.map(({ id, signal }) => (
            <SourceSignalChipToggle
              key={id}
              signal={signal}
              active={activeSourcePreset === id}
              onClick={() => handlePresetClick(id)}
              className="h-8 gap-[7px] rounded-[10px] px-[13px] text-[12.5px]"
              aria-label={tChat('shortcuts.presetAria', {
                label: tChat(`shortcuts.presets.${id}`),
              })}
            >
              {tChat(`shortcuts.presets.${id}`)}
            </SourceSignalChipToggle>
          ))}
        </div>
      )}
      {/* AI-transparency disclosure (EU AI Act Art. 50): users must know they
          interact with an AI system and that answers can be wrong. Kept to a
          single compact line so it costs minimal vertical space on both mobile
          and desktop, while staying persistently visible, legible, and clearly
          identifiable as a separate AI notice (leading spark glyph) — not
          hidden behind a click, per the Art. 50(5) "clear and distinguishable"
          standard. The composer floats over the scrolling chat, so a light
          blurred pill keeps it readable over messages behind it. */}
      <div className="mt-1.5 flex justify-center">
        <p className="text-muted-foreground bg-muted/70 supports-[backdrop-filter]:bg-muted/45 inline-flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg px-2.5 py-1 text-center text-[11px] leading-snug backdrop-blur-sm">
          <Sparkles className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>{t('inputArea.aiDisclosure')}</span>
        </p>
      </div>
    </div>
  )
})
