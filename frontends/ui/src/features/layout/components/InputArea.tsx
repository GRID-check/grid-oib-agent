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
  AtSign,
  Check,
  ChevronDown,
  Eye,
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
} from '@/components/ui/dialog'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
import { trackedFileToFileItem } from '@/features/documents/types'
import { FilePreviewDialog } from '@/features/documents/components/file-preview-dialog'
import { AddresseeIndicator } from '@/features/collaboration/components/AddresseeIndicator'
import {
  MentionPicker,
  type MentionPickerAria,
  type MentionPickerHandle,
} from '@/features/collaboration/components/MentionPicker'
import { useAwaitingState, useMentionCandidates } from '@/features/collaboration/hooks/use-sharing'
import { useThreadRole, useTurnActorName } from '@/shared/collaboration/thread-sharing'
import {
  findMentionQuery,
  humanMentions,
  insertMention,
  reconcileMentions,
  type DraftMention,
  type MentionQuery,
} from '@/features/collaboration/lib/mention-text'
import { MENTION_ERROR_REASONS, type MentionCandidate } from '@/lib/mentions/types'
import type { SendMessageOutcome } from '@/features/chat/hooks/use-websocket-chat'

/** Preset chip order + their provenance signals (spec §4 --source-* family). */
const SOURCE_PRESETS: Array<{ id: SourcePresetId; signal: SourcePresetId }> = [
  { id: 'law', signal: 'law' },
  { id: 'project', signal: 'project' },
  { id: 'office', signal: 'office' },
]

/** Connection mode for the chat */
export type ConnectionMode = 'sse' | 'websocket'

/**
 * Normalise whatever `sendMessage` returned.
 *
 * The fast path answers synchronously with a boolean (and legacy/mocked callers
 * answer with nothing at all), the mention path with the server's ruling. Only an
 * explicit `false` or `ok: false` counts as "not sent" — exactly the contract the
 * composer had before mentions existed.
 */
function normalizeSendResult(result: unknown): { ok: boolean; outcome?: SendMessageOutcome } {
  if (result === false) return { ok: false }
  if (result && typeof result === 'object' && 'ok' in result) {
    const outcome = result as SendMessageOutcome
    return { ok: outcome.ok, outcome }
  }
  return { ok: true }
}

/**
 * The copy for a refused mention. The server names the reason machine-readably in
 * `details.reason` precisely so the composer can say something useful instead of
 * "something went wrong" — and the user's text is kept either way.
 */
function mentionRefusalMessage(
  outcome: SendMessageOutcome | undefined,
  taggedHumans: readonly DraftMention[],
  tCollab: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  const reason = outcome?.failure?.reason
  if (!reason) return null
  // Name the person the SERVER refused (the refusal carries their targetId) —
  // tagging two people and hearing the first one's name when the second was
  // refused blames the wrong colleague.
  const refused = outcome?.failure?.targetId
  const name =
    (refused ? taggedHumans.find((mention) => mention.targetId === refused)?.display : undefined) ??
    taggedHumans[0]?.display ??
    ''
  switch (reason) {
    case MENTION_ERROR_REASONS.inviteRequiresOwner:
      return tCollab('mentions.errors.inviteRequiresOwner', { name })
    case MENTION_ERROR_REASONS.containerAccessRequired:
      return tCollab('mentions.errors.containerAccessRequired', { name })
    case MENTION_ERROR_REASONS.rateLimited:
      return tCollab('mentions.errors.rateLimited')
    default:
      return null
  }
}

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
 *
 * A successful chip's icon+name form a button that opens the shared read-only
 * FilePreviewDialog — the primary way back to an attached file, and on mobile
 * (where the manage-files button is hidden) the main file-access path. Chips
 * that are still uploading/ingesting or have failed are not openable (there is
 * nothing to preview yet); their body stays inert and only retry/remove act.
 */
const FileChip: FC<{
  file: TrackedFile
  onOpen: (file: TrackedFile) => void
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}> = ({ file, onOpen, onRemove, onRetry }) => {
  const t = useTranslations('research')
  const isPending = file.status === 'uploading' || file.status === 'ingesting'
  const isFailed = file.status === 'failed'
  const isSuccess = file.status === 'success'
  const statusTitle = isPending
    ? t('inputArea.fileUploadingStatus')
    : isFailed
      ? file.errorMessage || t('inputArea.fileFailedStatus')
      : t('inputArea.fileReadyStatus')

  const statusIcon = isPending ? (
    <Loader2 className="text-muted-foreground size-3 shrink-0 animate-spin" aria-hidden="true" />
  ) : isFailed ? (
    // A distinct glyph (not a bare red dot) so the failure carries a shape, not
    // color alone — plus an sr-only label so it isn't inferred only from color.
    <>
      <XCircle className="text-destructive size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('inputArea.fileFailedStatus')}</span>
    </>
  ) : (
    <Check className="text-status-active size-3 shrink-0" aria-hidden="true" />
  )

  return (
    <span
      className={cn(
        'bg-card inline-flex h-7 max-w-[200px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px]',
        isFailed && 'border-error/50'
      )}
      title={`${file.fileName} — ${statusTitle}`}
    >
      {isSuccess ? (
        <button
          type="button"
          onClick={() => onOpen(file)}
          aria-label={t('inputArea.openFile', { name: file.fileName })}
          className="text-foreground/85 focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2"
        >
          {statusIcon}
          <span className="min-w-0 truncate">{file.fileName}</span>
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {statusIcon}
          <span className="text-foreground/85 min-w-0 truncate">{file.fileName}</span>
        </span>
      )}
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
  /**
   * Whether the collaboration surfaces are reachable for this org (ADR-0032…0035,
   * dark-launched behind the per-org `collaboration` flag).
   *
   * **Defaults to false, and false means "exactly today"** (spec NF-8): no
   * addressee statement, no hand-off read, no extra request. The `@` picker is
   * gated differently — by whether the candidates endpoint answers at all — so a
   * gated org cannot notice either of them.
   */
  canCollaborate?: boolean
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
  canCollaborate = false,
}) {
  const t = useTranslations('research')
  const tChat = useTranslations('chat')
  const tCollab = useTranslations('collaboration')
  const [message, setMessage] = useState('')

  // ——— @-mentions (spec MN-3, MN-4) ————————————————————————————————————————
  // The mentions the user actually PICKED, as structured references. Never derived
  // from the text; reconciled against it right before sending.
  const [mentions, setMentions] = useState<DraftMention[]>([])
  // The `@…` fragment under the caret; its presence is what opens the picker.
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  // Esc (or clicking away) closes the picker for THIS fragment; a fresh `@`
  // reopens it, however many times the user types one.
  const [mentionDismissed, setMentionDismissed] = useState(false)
  // Candidates are fetched lazily — a composer that never sees an `@` never asks.
  const [mentionRequested, setMentionRequested] = useState(false)
  const [mentionAria, setMentionAria] = useState<MentionPickerAria>({
    listboxId: null,
    activeOptionId: null,
  })
  const mentionPickerRef = useRef<MentionPickerHandle>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  // Caret to restore after a programmatic text change (mention insertion).
  const pendingCaretRef = useRef<number | null>(null)

  // Attached-file preview (read-only): a successful chip opens the shared
  // FilePreviewDialog for its file. Also the primary file-access path on mobile.
  const [previewFile, setPreviewFile] = useState<TrackedFile | null>(null)
  // Manage-files dialog/sheet open state — driven by BOTH the desktop button and
  // the mobile "N Dateien verwalten" text entry, so it is controlled (not
  // trigger-bound) and one dialog instance serves both breakpoints.
  const [manageFilesOpen, setManageFilesOpen] = useState(false)

  // File input ref for attachment button
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Textarea ref for the autosize effect
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Get file upload configuration from app config
  const { fileUpload: fileUploadConfig } = useAppConfig()

  // Check if current session is busy with operations
  const isBusy = useIsCurrentSessionBusy()

  /*
    WebSocket chat hook for full HITL support.

    `canCollaborate` decides WHEN the agent socket opens, not whether. With the flag
    off (the default) it opens on mount exactly as it always has. With the flag on it
    opens on mount for a private thread too — but in a SHARED thread it waits for the
    user to show they mean to write, because the Python socket registry is keyed by
    conversation id, so a reader who merely opened the thread would take the asker's
    registration away from him. See the socket-gate block in `use-websocket-chat`.
  */
  const wsChat = useWebSocketChat({
    autoConnect: connectionMode === 'websocket',
    canCollaborate,
  })

  // Get current conversation for filtering files and ensureSession for auto-creation
  const currentConversation = useChatStore((state) => state.currentConversation)
  const ensureSession = useChatStore((state) => state.ensureSession)
  // The real "new session" action — the same one the logo / new-session path in
  // MainLayout uses (startNewSessionDraft). Wired to the post-research
  // "Neue Sitzung starten" button so the completed-report dead-end becomes a
  // forward action instead of a no-op explanation popover.
  const startNewSessionDraft = useChatStore((state) => state.startNewSessionDraft)

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

  const { sendMessage, isLoading, respondToInteraction, pendingInteraction, noteSendIntent } =
    wsChat

  /*
    THE CONNECTION TRIGGER: composer focus.

    Three candidates, and this is the trade we picked.

      - **The send itself** is the latest possible moment and the cheapest for a
        reader, but it puts a full WebSocket handshake in front of the first
        message of every shared thread — the user waits for it, and it is the one
        latency this fix must not add.
      - **The first keystroke** is nearly as good and strictly worse: it connects
        no earlier than focus and only saves a socket for the user who focuses the
        composer and then types nothing at all, which is rare and harmless.
      - **Focus** connects on the click or Tab that precedes the typing. By the
        time a sentence has been written the socket is warm, so the send is as fast
        as it is today, while a participant who is only READING never focuses the
        composer and never connects. That is the case the defect is about.

    Focus is not proof of intent to send, so the cost of being wrong matters: a
    reader who idly clicks the composer opens a socket they will not use. That
    costs one connection slot and, in a shared thread, can still displace the
    asker's registration — which is why the frontend fix mitigates rather than
    closes the collision (the registry has to become per-socket to close it).

    `handleSubmit` calls it again as a backstop, for the paths that send without a
    focus event ever reaching the textarea (composer prefill, deep links).
  */

  // Register respondToInteraction in the store so sibling components (e.g. AgentPrompt) can use it
  const setRespondToInteractionFn = useChatStore((state) => state.setRespondToInteractionFn)
  useEffect(() => {
    setRespondToInteractionFn(respondToInteraction)
    return () => setRespondToInteractionFn(null)
  }, [respondToInteraction, setRespondToInteractionFn])

  // Register the live send path so components that do not own the socket (e.g.
  // the "Erneut versuchen" retry on an errored answer in ChatArea) can resend
  // the last user message. Mirrors the respondToInteractionFn registration.
  const setChatSendFn = useChatStore((state) => state.setChatSendFn)
  useEffect(() => {
    setChatSendFn(sendMessage)
    return () => setChatSendFn(null)
  }, [sendMessage, setChatSendFn])

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
  // 4. A colleague's turn is running in this shared thread (the socket registry is
  //    one slot per conversation — a second send collides with it), or the reader
  //    only has the viewer role (the server would reject the send anyway)

  // Whose question Piloti is answering, when it is not this reader's — published by
  // the ADR-0033 seam so the composer does not pay for a second roster read.
  const otherPersonsTurnName = useTurnActorName(canCollaborate ? currentSessionId : null)

  // The reader's own role in a shared thread: a viewer's send is rejected
  // server-side, so the composer is read-only BEFORE the attempt (a ghost bubble
  // only the viewer would see is the alternative).
  const myThreadRole = useThreadRole(canCollaborate ? currentSessionId : null)
  const isViewerInSharedThread = myThreadRole === 'viewer'

  const isDisabledByAuth = !isAuthenticated
  const disabled =
    isDisabledByAuth ||
    (isBusy && !isResponseMode) ||
    isResearchSessionSuccessful ||
    Boolean(otherPersonsTurnName) ||
    isViewerInSharedThread

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
    const prefill = consumeComposerPrefill()
    if (prefill === null) return
    setMessage(prefill.text)
    // A prefill that renders `@…` tokens carries the structured mentions with
    // it (e.g. the hand-off banner's "ask Piloti instead") — without seeding
    // them here the tokens would send as dead plain text and route to the
    // wrong addressee (spec MN-3).
    if (prefill.mentions && prefill.mentions.length > 0) setMentions(prefill.mentions)
    // Persist the prefill as the session's draft too, so it survives a reload
    // just like typed text (only possible once a session exists).
    if (currentSessionId) setComposerDraft(currentSessionId, prefill.text)
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

  // Mention candidates for this conversation — the agent, the participants, and the
  // colleagues who would have to be invited (spec MN-4/MN-5).
  // `canCollaborate` gates the REQUEST, not just the picker. Without it, typing
  // `@` with the feature off still fired this fetch at a route that answers 403,
  // and `mentionsLoading` alone was enough to open the picker (below) — so the
  // panel flashed open and vanished, advertising a feature this deployment does
  // not have (spec NF-8). The gate has to sit on the fetch: any other placement
  // leaves the round-trip, and the flicker is the round-trip.
  const { data: mentionData, loading: mentionsLoading } = useMentionCandidates(
    currentSessionId ?? null,
    canCollaborate && mentionRequested,
  )

  /**
   * Re-evaluate whether the caret sits in an `@…` fragment. Called on every text
   * change and on every caret move, which is what makes the trigger feel native:
   * typing `@` opens the picker, deleting the `@` closes it, and clicking back into
   * an unfinished fragment picks it up again.
   */
  const syncMentionQuery = useCallback((value: string, caret: number | null) => {
    const range = caret === null ? null : findMentionQuery(value, caret)
    setMentionQuery(range)
    if (range) {
      setMentionRequested(true)
      return
    }
    // No fragment → nothing to dismiss; the next `@` starts clean.
    setMentionDismissed(false)
  }, [])

  // Declared here rather than beside the other handlers below: `handleMentionSomeone`
  // lists it as a dependency, so a later `const` would be read in its own TDZ.
  const handleValueChange = useCallback(
    (value: string, caret: number | null = value.length) => {
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
      syncMentionQuery(value, caret)
    },
    [isDisabledByAuth, currentConversation, ensureSession, setComposerDraft, syncMentionQuery]
  )

  /**
   * Start a mention from the composer's addressee line — the only affordance that
   * teaches `@` exists (spec MN-3 had no discovery story at all).
   *
   * Types the character rather than opening the picker directly: `syncMentionQuery`
   * already owns "the caret sits in an `@…` fragment", so going through the text is
   * the one path that cannot drift from what typing `@` by hand does. It also leaves
   * the user somewhere sensible if they change their mind — one backspace.
   */
  const handleMentionSomeone = useCallback(() => {
    const el = textareaRef.current
    const base = message.length > 0 && !message.endsWith(' ') ? `${message} ` : message
    const next = `${base}@`
    // Route through handleValueChange, not a bare setMessage: a fresh thread
    // gets its session (and the draft) here, and `syncMentionQuery` runs inside
    // it — the one path that cannot drift from what typing `@` by hand does.
    handleValueChange(next, next.length)
    setMentionDismissed(false)
    // Focus AFTER the value lands, so the caret is at the end of the fragment the
    // picker is filtering on.
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(next.length, next.length)
    })
  }, [message, handleValueChange])

  const syncMentionQueryFromElement = useCallback(
    (element: HTMLTextAreaElement) => {
      syncMentionQuery(element.value, element.selectionStart)
    },
    [syncMentionQuery],
  )

  // Restore the caret after a mention insertion rewrote the text.
  useEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(caret, caret)
  }, [message])

  // Mentions that survive the current text, in text order — the single source for
  // what gets sent, what the hint says, and whether the agent will stay quiet.
  const activeMentions = useMemo(() => reconcileMentions(message, mentions), [message, mentions])
  const taggedHumans = useMemo(() => humanMentions(activeMentions), [activeMentions])
  // `@Piloti` alongside a person addresses BOTH (spec MN-1), so the "Piloti stays
  // quiet" hint below would be a false statement — the addressee line names them
  // both instead.
  const agentTagged = activeMentions.length > taggedHumans.length

  /*
    The thread's hand-off state, read from the server (never computed here — the
    banner, the inbox and this composer read the same rows, ADR-0034). It is what
    turns the default "Geht an Piloti" into "Geht an den Chat": while a named person
    is awaited, a plain message is a remark and the agent stays out.

    Off entirely without the flag, so a gated org opens no request (spec NF-8).
  */
  const { awaiting } = useAwaitingState(
    canCollaborate ? (currentSessionId ?? null) : null,
    canCollaborate,
  )
  const threadAwaitsHuman = (awaiting?.pending.length ?? 0) > 0

  /**
   * The picker opens only where collaboration is on, and then only once the
   * candidate list is on its way.
   *
   * `canCollaborate` is checked here as well as on the fetch above — not
   * redundantly: the two answer different questions ("may this deployment mention
   * anyone?" vs. "has the list arrived?"), and stating the first one here is what
   * keeps a stale `mentionsLoading` from ever opening a panel the feature gate
   * has closed. With the feature off, typing `@` behaves exactly as it did before
   * this feature existed (spec NF-8).
   */
  const mentionPickerOpen =
    canCollaborate &&
    mentionQuery !== null &&
    !mentionDismissed &&
    !disabled &&
    (mentionsLoading || mentionData !== null)

  const handleSubmit = useCallback(async () => {
    if (!message.trim() || disabled) return
    // Backstop for a send that never saw a focus event (prefill, deep link). A no-op
    // when focus already declared it.
    noteSendIntent()
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

    // Mentions are structured, and reconciled against the text at the last
    // possible moment: whatever token the user deleted while editing is not sent
    // (spec MN-3).
    const sentMentions = reconcileMentions(currentMessage, mentions)
    const sentHumans = humanMentions(sentMentions)

    // Files may still be uploading/ingesting — we no longer gate the send behind
    // a double-submit banner. The send button surfaces a subtle inline hint
    // (see title below) but the user is always free to send.
    setMessage('')
    setMentionQuery(null)
    try {
      // sendMessage reports immediate failures (dead socket, no conversation)
      // via a false return rather than throwing. A message WITH mentions resolves
      // to the server's addressee ruling instead, and may be refused outright.
      const { ok, outcome } = normalizeSendResult(
        // Called with ONE argument when there is nothing to mention AND the thread
        // is in its normal state — the fast path stays exactly the call it always
        // was, free of the feature.
        //
        // `awaitingHuman` is what makes a plain message go through the server's
        // ruling too: while a named person is awaited it is a remark to the thread,
        // not a question for Piloti (ADR-0034 addendum), and the agent must be given
        // it as context rather than as a turn. It reads the SAME hand-off state the
        // addressee line above states to the user, so what they were told and what
        // happens cannot disagree.
        sentMentions.length > 0
          ? await sendMessage(currentMessage, { mentions: sentMentions })
          : threadAwaitsHuman
            ? await sendMessage(currentMessage, { awaitingHuman: true })
            : await sendMessage(currentMessage),
      )
      if (!ok) {
        // Restore the text so nothing the user wrote is lost, and keep the picked
        // mentions with it — the message is meant to be sent again, not retyped.
        setMessage(currentMessage)
        const refusal = mentionRefusalMessage(outcome, sentHumans, tCollab)
        toast.error(refusal ?? t('inputArea.messageNotSent'), {
          description: refusal ? undefined : t('inputArea.messageNotSentDesc'),
        })
        return
      }
      // Sent successfully — drop this session's saved draft so it can't
      // resurface on the next visit. Only on success: a failed send keeps the
      // draft so nothing the user typed is lost.
      if (submittingSessionId) clearComposerDraft(submittingSessionId)
      setMentions([])
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
    mentions,
    disabled,
    isResponseMode,
    respondToInteraction,
    sendMessage,
    noteSendIntent,
    threadAwaitsHuman,
    currentConversation,
    clearComposerDraft,
    t,
    tCollab,
  ])

  // Post-research forward action: start a fresh session draft (the real
  // new-session path) so the user can ask follow-ups after a completed report,
  // instead of being stuck at a locked composer with a no-op explanation.
  const handleStartNewSession = useCallback(() => {
    startNewSessionDraft()
    setMessage('')
  }, [startNewSessionDraft])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // While the picker is open it owns the navigation keys. The single most
      // important detail: Enter must INSERT, never submit — a message sent because
      // the user confirmed a name is the worst possible outcome here.
      if (mentionPickerOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          mentionPickerRef.current?.move(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          mentionPickerRef.current?.move(-1)
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          if (mentionPickerRef.current?.selectActive()) return
          // Nothing to insert (no match for what was typed): close the picker. An
          // Enter then still means what it usually means — send.
          setMentionDismissed(true)
          if (e.key === 'Enter') handleSubmit()
          return
        }
        if (e.key === 'Escape') {
          // Stop here: an Escape that bubbles would close the surrounding surface.
          e.preventDefault()
          e.stopPropagation()
          setMentionDismissed(true)
          textareaRef.current?.focus()
          return
        }
      }

      if (e.key !== 'Enter') return
      // Shift+Enter inserts a newline — let the textarea handle it natively.
      if (e.shiftKey) return
      // Plain Enter sends; Cmd/Ctrl+Enter also sends as a discoverable power
      // binding. Both funnel through a single handleSubmit call (no double-fire),
      // and handleSubmit enforces the disabled/streaming/HITL guards.
      e.preventDefault()
      handleSubmit()
    },
    [handleSubmit, mentionPickerOpen]
  )

  /**
   * Insert the picked candidate: the `@fragment` becomes `@Display `, and the
   * STRUCTURED reference is recorded alongside it. The text is a rendering of the
   * mention, never its definition (spec MN-3).
   */
  const handleMentionSelect = useCallback(
    (candidate: MentionCandidate) => {
      const range = mentionQuery
      if (!range) return
      const display = candidate.isAgent
        ? tCollab('mentions.picker.agentName')
        : candidate.person.name
      const { text, caret } = insertMention(message, range, display)

      pendingCaretRef.current = caret
      handleValueChange(text, caret)
      setMentions((current) => [...current, { targetId: candidate.targetId, display }])
      setMentionQuery(null)
      setMentionDismissed(false)
    },
    [handleValueChange, message, mentionQuery, tCollab]
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
    <div className="mx-auto flex w-full max-w-3xl flex-col p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 sm:pb-4">
      {/* The mention picker is anchored to the composer CARD and opens above it,
          spanning its full width — the Slack/Linear placement. Caret-pixel tracking
          inside a textarea is fragile and buys nothing here. */}
      <Popover
        open={mentionPickerOpen}
        onOpenChange={(open) => {
          if (!open) setMentionDismissed(true)
        }}
      >
      <PopoverAnchor asChild>
      <div
        ref={composerRef}
        className={cn(
          // Composer card: white card grounded by a soft CARD-tier shadow (not
          // the modal shadow-lg, which detached it as a floating object over the
          // chat plane). No hard border — the field reads as a calm surface, and
          // focus is signalled by a subtle focus-within ring instead of an
          // outline. Textarea on top, hairline-separated control row below.
          // NOT `active:scale-95`: the press response belongs on the controls a
          // reader actually presses (the chips and buttons in the row below), and
          // this div is the card that HOLDS them. With it here, putting the caret
          // in the textarea shrank the whole composer — text, chips and all — on
          // every mousedown, which reads as the surface flinching away from the
          // click rather than as a control acknowledging a press.
          'bg-card focus-within:ring-ring/40 relative flex flex-col rounded-xl px-4 py-2.5 shadow-sm transition-[box-shadow,border-color] duration-200 ease-out focus-within:ring-2',
          isDisabledByAuth && 'opacity-60',
          isDragging && isUnsupportedDrag
            ? 'border-2 border-error border-dashed'
            : isDragging
              ? 'border-2 border-brand border-dashed'
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
          <div
            // Horizontal scroll strip with a soft right-edge fade so an
            // overflowing chip dissolves instead of hard-clipping — and the fade
            // quietly signals there is more to scroll. The mask self-hides when
            // the chips don't reach the edge (nothing there to fade).
            className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [mask-image:linear-gradient(to_right,black_calc(100%_-_24px),transparent)] [scrollbar-width:none] [-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_24px),transparent)] [&::-webkit-scrollbar]:hidden"
            aria-label={t('inputArea.manageFiles')}
          >
            {sessionFiles.map((file) => (
              <FileChip
                key={file.id}
                file={file}
                onOpen={setPreviewFile}
                onRemove={deleteFile}
                onRetry={retryFile}
              />
            ))}
          </div>
        )}

        {/* Mobile-only entry to the full manage-files sheet. The desktop
            manage-files button is hidden on phones (the action row stays one
            line), so this compact text link — under the chip strip, only when
            files exist — is the phone user's way to the browse/upload/delete
            list. Not another chip in the action row (keeps it un-bulked). */}
        {attachedFilesCount > 0 && (
          <button
            type="button"
            onClick={() => setManageFilesOpen(true)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mb-2 self-start rounded-sm text-[12px] font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 sm:hidden"
          >
            {t('inputArea.manageFilesMobile', { count: attachedFilesCount })}
          </button>
        )}

        {/* Text Input */}
        <Textarea
          ref={textareaRef}
          // text-base (16px) below md keeps iOS Safari from zooming the page
          // when the composer gains focus; desktop keeps the tighter 14.5px.
          // The composer CARD signals focus with its focus-within ring (see the
          // card class above), so the textarea shows no ring/border/outline of
          // its own. `outline-hidden!` beats the app's global :focus-visible
          // outline (globals.css, unlayered) with an important utility — otherwise
          // focus is drawn twice: a nested box inside the card's ring.
          className="max-h-52 min-h-[40px] resize-none border-0 bg-transparent px-1.5 py-1 text-base leading-[1.5] shadow-none outline-none! focus-visible:ring-0 md:text-[14.5px]"
          value={message}
          onChange={(e) => handleValueChange(e.target.value, e.target.selectionStart)}
          onKeyDown={handleKeyDown}
          // Intent to send. In a shared thread this is what opens the agent socket
          // (see the note next to `noteSendIntent` above); everywhere else the
          // socket is already up and this is a no-op.
          onFocus={noteSendIntent}
          // The caret can move without the text changing (arrows, a click); the
          // trigger has to follow it, or the picker outlives its own fragment.
          onKeyUp={(e) => syncMentionQueryFromElement(e.currentTarget)}
          onClick={(e) => syncMentionQueryFromElement(e.currentTarget)}
          onPaste={handlePaste}
          placeholder={getPlaceholder()}
          disabled={disabled}
          rows={1}
          aria-label={
            isResponseMode ? t('inputArea.responseInput') : t('inputArea.chatMessageInput')
          }
          // Combobox semantics only while the picker is live: the listbox
          // `aria-controls` points at exists only then, and a chat composer that
          // announces itself as a combobox at all times is worse for a screen
          // reader than one that announces the popup when it appears.
          role={mentionPickerOpen ? 'combobox' : undefined}
          aria-expanded={mentionPickerOpen ? true : undefined}
          aria-haspopup={mentionPickerOpen ? 'listbox' : undefined}
          aria-autocomplete={mentionPickerOpen ? 'list' : undefined}
          aria-controls={mentionPickerOpen ? (mentionAria.listboxId ?? undefined) : undefined}
          aria-activedescendant={
            mentionPickerOpen ? (mentionAria.activeOptionId ?? undefined) : undefined
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
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          {/* Scope chip — current project; cross-project is honestly disabled.
              Dashed status-active dot + label + chevron (dummy composer). */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={isDisabledByAuth}
                aria-label={tChat('composer.scopeAria', { project: scopeLabel })}
                title={tChat('composer.scopeAria', { project: scopeLabel })}
                className="bg-card shadow-xs hover:bg-accent focus-visible:ring-ring/50 inline-flex h-8 min-w-0 items-center gap-[7px] rounded-lg border px-[11px] transition-[color,background-color,transform] duration-200 ease-out active:scale-95 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="border-status-active flex size-[14px] shrink-0 items-center justify-center rounded-full border border-dashed">
                  <span className="bg-status-active size-[5px] rounded-full" />
                </span>
                <span className="text-foreground/85 hidden max-w-44 truncate text-[12.5px] font-medium sm:inline">
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
                className="bg-card text-muted-foreground shadow-xs hover:bg-accent focus-visible:ring-ring/50 inline-flex h-8 shrink-0 items-center gap-[7px] rounded-lg border px-[11px] text-[12.5px] transition-[color,background-color,transform] duration-200 ease-out active:scale-95 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Layers className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">{tChat('composer.sources')}</span>
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
              'inline-flex h-8 shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border px-3 text-[12.5px] font-medium transition-[color,background-color,box-shadow] duration-200 ease-out active:scale-95',
              'focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
              deepResearchIntent
                ? 'border-primary bg-primary text-primary-foreground shadow-xs'
                : 'border-border bg-card text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground'
            )}
          >
            <ZoomIn className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{tChat('composer.deepResearch')}</span>
          </button>

          {/* Who this message goes to — ALWAYS, whenever collaboration exists at
              all. The point of it being unconditional: if it only appeared in the
              unusual case, "Piloti is next" would remain something the user has to
              infer from an absence. Borderless on purpose — it is a statement
              standing among buttons, and must not read as one. */}
          {canCollaborate && (
            <AddresseeIndicator
              mentions={activeMentions}
              awaitingHuman={threadAwaitsHuman}
              // Only where there is somebody to mention: a solo thread grows no
              // collaboration furniture (spec NF-8).
              // Offered wherever collaboration is available — including a PRIVATE
              // thread, because mentioning somebody is how a thread starts being
              // shared (the picker offers "Wird eingeladen"). This is the discovery
              // path into the feature, not a reward for already having used it.
              onMentionSomeone={handleMentionSomeone}
            />
          )}

          {/* Right Actions: manage-files, attach, submit — pushed right */}
          <div className="ml-auto flex items-center gap-1">
            {/* Manage files — opens a Dialog hosting the full FileSourcesTab
                (browse, upload zone, per-file delete). Replaces the old
                right-panel toggle. Shown only when files exist. */}
            {attachedFilesCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                // Redundant with the inline file chips (status + retry + remove)
                // on a narrow composer — hidden on mobile so the action row
                // stays one clean line; the FileSourcesTab dialog it opens
                // (browse + upload zone) remains available on wider viewports.
                // Mobile reaches the same dialog via the "manage" text entry
                // under the chip strip.
                className="text-muted-foreground hidden h-8 rounded-lg px-2.5 sm:inline-flex"
                disabled={isDisabledByAuth || !knowledgeLayerAvailable}
                onClick={() => setManageFilesOpen(true)}
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
              className="text-subtle size-[34px] rounded-lg"
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
              // Completed research is a dead-end for the locked composer: replace
              // the old no-op explanation popover with an explicit forward action
              // that starts a fresh session (the real new-session path). A short
              // helper line below the composer carries the "why" the popover used
              // to hide.
              <motion.div
                className="inline-flex"
                whileTap={{ scale: 0.94 }}
                transition={springSnappy}
                tabIndex={-1}
              >
                <Button
                  size="sm"
                  className="h-9 gap-1.5 rounded-lg px-3 shadow-md"
                  onClick={handleStartNewSession}
                  aria-label={t('inputArea.startNewSession')}
                  title={t('inputArea.startNewSession')}
                >
                  <RotateCw className="size-3.5" aria-hidden="true" />
                  <span className="text-[12.5px] font-semibold">
                    {t('inputArea.startNewSession')}
                  </span>
                </Button>
              </motion.div>
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

        {/* The hand-off, said out loud BEFORE sending (spec MN-7/MN-8): once a
            person is tagged the agent will stay quiet, and the user has to know
            that while they can still change their mind. Suppressed when `@Piloti`
            is tagged too — then the agent DOES answer (MN-1) and this sentence
            would be false; the addressee line above names both. */}
        {taggedHumans.length > 0 && !agentTagged && (
          <p
            data-testid="composer-mention-hint"
            className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
            role="note"
          >
            <AtSign className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden="true" />
            <span>
              {/* German inflects the verb, so joining names into the singular
                  string produced "Anna Berger, Tobias Kern WIRD gefragt" — wrong
                  grammar in the primary product language. This i18n layer has no
                  plural rules, hence two keys. */}
              {taggedHumans.length === 1
                ? tCollab('mentions.composerHint', { name: taggedHumans[0]!.display })
                : tCollab('mentions.composerHintMany', {
                    names: taggedHumans.map((mention) => mention.display).join(', '),
                  })}
            </span>
          </p>
        )}

        {/* The way BACK, exactly where it is needed: while the thread waits on a
            person, a plain message is a remark, so the composer says how to reach
            Piloti instead of leaving that to be discovered. */}
        {canCollaborate && threadAwaitsHuman && activeMentions.length === 0 && (
          <p
            data-testid="composer-agent-hint"
            className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
            role="note"
          >
            <Sparkles className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden="true" />
            <span>{tCollab('mentions.addressee.agentHint')}</span>
          </p>
        )}

        {/* Piloti is mid-answer for SOMEBODY ELSE (spec CC-13). The composer is
            locked on the same fact (`otherPersonsTurnName` disables it above), and
            without a line here that lock is unexplained — a colleague sees a dead
            input and no reason for it. Only when the turn belongs to someone else:
            the asker has their own typing indicator and Herleitung, so telling them
            "Piloti is answering your question" would be noise. */}
        {canCollaborate && otherPersonsTurnName && (
          <p
            data-testid="composer-busy-hint"
            className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
            role="note"
          >
            <Sparkles className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden="true" />
            <span>{tCollab('thread.composerBusy', { name: otherPersonsTurnName })}</span>
          </p>
        )}

        {/* Read-only participant: the composer is disabled on the same fact, and
            this line is why. */}
        {canCollaborate && isViewerInSharedThread && (
          <p
            data-testid="composer-viewer-hint"
            className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
            role="note"
          >
            <Eye className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden="true" />
            <span>{tCollab('thread.viewerNotice')}</span>
          </p>
        )}

        {/* Honest Deep-Research hint: the pill records intent; escalation
            stays automatic. Never promises a forced deep-research run. */}
        {deepResearchIntent && (
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed" role="note">
            {tChat('composer.deepResearchHint')}
          </p>
        )}

        {/* Post-research helper line — the explanation that used to live in the
            (no-op) send popover, now always visible next to the "Neue Sitzung
            starten" action so the completed-report lock is understandable. */}
        {isResearchSessionSuccessful && !isResponseMode && (
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed" role="note">
            {t('inputArea.researchCompletedPopover')}
          </p>
        )}
      </div>
      </PopoverAnchor>

        {/* The panel itself supplies the surface, so the popover contributes
            nothing but placement and width. Focus must NOT move here: the user is
            typing, and the textarea forwards the navigation keys. */}
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[var(--radix-popover-trigger-width)] border-0 bg-transparent p-0 shadow-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // Clicking inside the composer (e.g. moving the caret) is not
            // "clicking away" — only a click outside it dismisses the picker.
            const target = event.target as Node | null
            if (target && composerRef.current?.contains(target)) event.preventDefault()
          }}
        >
          <MentionPicker
            ref={mentionPickerRef}
            query={mentionQuery?.query ?? ''}
            candidates={mentionData?.candidates ?? []}
            canInvite={mentionData?.canInvite ?? false}
            loading={mentionsLoading}
            onSelect={handleMentionSelect}
            onAriaChange={setMentionAria}
          />
        </PopoverContent>
      </Popover>

      {/* Mobile scope cue: on phones the scope / Datengrundlage / Deep-Research
          labels collapse to bare icons (to keep the action row one compact
          line), so a mobile user can't tell what sources are active or that
          scoping exists. A tiny, mobile-only line under the composer keeps the
          active source count legible without re-bulking the action row. Shown on
          the empty thread (first-run), where learning the scope matters most. */}
      {isEmptyThread && !isDisabledByAuth && enabledSourcesCount > 0 && (
        <p
          className="text-muted-foreground mt-1.5 flex items-center justify-center gap-1.5 text-[11px] sm:hidden"
          role="note"
        >
          <Layers className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>{tChat('composer.sourcesActiveMobile', { count: enabledSourcesCount })}</span>
        </p>
      )}

      {/* Shortcut preset chips (empty thread only): map onto the REAL data
          sources in the store — see lib/source-presets.ts. */}
      {isEmptyThread && !isDisabledByAuth && (
        <div
          // Shortcuts are a desktop affordance — hidden on mobile, where they
          // only add vertical bulk under an already space-constrained composer.
          className="mt-[18px] hidden flex-wrap items-center justify-center gap-2 sm:flex"
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

      {/* Manage-files dialog — one controlled instance shared by the desktop
          button and the mobile text entry. Mobile: a bottom sheet that slides up
          (85dvh, rounded top, safe-area padding). Desktop (sm+): the standard
          centered dialog. The FileSourcesTab inside is the full browse / upload /
          per-file open+delete surface. */}
      <Dialog open={manageFilesOpen} onOpenChange={setManageFilesOpen}>
        <DialogContent
          className={cn(
            'flex max-w-full flex-col gap-0 rounded-b-none rounded-t-2xl p-0',
            'bottom-0 left-0 top-auto translate-x-0 translate-y-0',
            'h-[85dvh] max-h-[85dvh]',
            'sm:bottom-auto sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-3xl sm:p-6'
          )}
        >
          <DialogHeader className="border-b px-4 py-3 text-left sm:border-0 sm:p-0">
            <DialogTitle>{t('inputArea.manageFiles')}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-0 sm:pb-0 sm:pt-2">
            <FileSourcesTab />
          </div>
        </DialogContent>
      </Dialog>

      {/* Read-only preview of an attached file, opened from a successful chip.
          Read-only (canManage=false): the composer is not a management surface —
          that is what the manage-files dialog above is for. */}
      <FilePreviewDialog
        file={previewFile ? trackedFileToFileItem(previewFile) : null}
        canManage={false}
        onClose={() => setPreviewFile(null)}
      />
    </div>
  )
})
