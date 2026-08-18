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
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion, easeQuiet, springSnappy } from '@/components/motion'
import { useWebSocketChat, useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import { composerCapabilities } from '@/features/collaboration/lib/composer-capabilities'
import { resolveAddressee, sendMessageOptions } from '@/features/collaboration/lib/composer-routing'
import { latestDeepResearchJobStatus } from '@/features/chat/lib/session-activity'
import { useLayoutStore } from '../store'
import { computePresetSourceIds } from '../lib/source-presets'
import { researchSessionState } from '../lib/research-session-state'
import { SourceBasisPicker, SourceBasisTrigger } from './source-basis'
import { FileSourcesTab } from './FileSourcesTab'
import { UploadDestinationNote } from './UploadDestination'
import { useAppConfig } from '@/shared/context'
import { useTranslations } from '@/i18n'
import { useFileUpload, useFileDragDrop } from '@/features/documents'
import type { TrackedFile } from '@/features/documents'
import { trackedFileToFileItem } from '@/features/documents/types'
import { FilePreviewDialog } from '@/features/documents/components/file-preview-dialog'
import { ComposerSubjectBar } from '@/features/documents/components/composer-subject-bar'
import { useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import { AddresseeIndicator } from '@/features/collaboration/components/AddresseeIndicator'
import {
  MentionPicker,
  type MentionPickerAria,
  type MentionPickerHandle,
} from '@/features/collaboration/components/MentionPicker'
import { useAwaitingState, useMentionCandidates } from '@/features/collaboration/hooks/use-sharing'
import {
  bumpThreadRevision,
  useThreadRole,
  useThreadSharing,
  useTurnActorName,
} from '@/shared/collaboration/thread-sharing'
import { useTypingBroadcast } from '@/features/collaboration/hooks/use-typing-broadcast'
import {
  findMentionQuery,
  insertMention,
  type DraftMention,
  type MentionQuery,
} from '@/features/collaboration/lib/mention-text'
import { MENTION_ERROR_REASONS, type MentionCandidate } from '@/lib/mentions/types'
import { InvokedSkillChip } from '@/features/skills/components/InvokedSkillChip'
import { SlashCommandPicker } from '@/features/skills/components/SlashCommandPicker'
import { useSlashCommand } from '@/features/skills/hooks/use-slash-command'
import type { SendMessageOutcome } from '@/features/chat/hooks/use-websocket-chat'

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
  /**
   * A reader who may not change this conversation (a viewer in a shared thread).
   * Opening a file stays available — that is reading — but retry and remove are
   * writes onto somebody else's thread and are not rendered at all. Disabled
   * buttons would be the wrong shape here: there is no state in which this
   * person could press them, so offering them greyed out is a promise.
   */
  readOnly?: boolean
}> = ({ file, onOpen, onRemove, onRetry, readOnly = false }) => {
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
    <Spinner size="xs" className="text-muted-foreground" />
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
        // A finger has to be able to hit the remove-x, and that button can only
        // grow inside a taller chip — the strip scrolls horizontally, so the
        // extra height costs nothing but a slightly shorter filename.
        'pointer-coarse:h-11',
        // `border-error` is a static `@utility` in globals.css with no
        // `--modifier()`, so the slash form (`border-error/50`) matched nothing
        // and this chip kept the neutral default border — a failed upload was
        // signalled by the glyph alone. The token itself already carries ~55%
        // alpha, so the solid class is the soft edge the author was after.
        isFailed && 'border-error'
      )}
      title={`${file.fileName} — ${statusTitle}`}
    >
      {isSuccess ? (
        <button
          type="button"
          onClick={() => onOpen(file)}
          aria-label={t('inputArea.openFile', { name: file.fileName })}
          className="text-foreground/85 focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
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
      {isFailed && !readOnly && (
        <button
          type="button"
          onClick={() => onRetry(file.id)}
          aria-label={t('inputArea.retryUpload')}
          title={t('inputArea.retryUpload')}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 pointer-coarse:size-9"
        >
          <RotateCw className="size-3" aria-hidden="true" />
        </button>
      )}
      {!readOnly && (
        <button
          type="button"
          onClick={() => onRemove(file.id)}
          aria-label={t('inputArea.removeFile', { name: file.fileName })}
          title={t('inputArea.removeFile', { name: file.fileName })}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 pointer-coarse:size-9"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
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
  const tFiles = useTranslations('files')
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
  // Datenbasis popover. Controlled so the trigger knows whether a change the
  // reader just made is visible to them in the open picker, or needs its own
  // one-shot receipt on the closed trigger.
  const [sourcesOpen, setSourcesOpen] = useState(false)
  /** Last session upload this composer auto-bound, so clearing the bar does not re-bind. */
  const boundSessionUploadRef = useRef<string | null>(null)
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
  const composerSubject = useChatStore((state) => state.composerSubject)
  const setComposerSubject = useChatStore((state) => state.setComposerSubject)
  const previewFileId = useFilePreviewStore((state) => state.file?.id ?? null)
  const previewBesideChat = useFilePreviewStore(
    (state) => (state.mode === 'peek' || state.mode === 'expanded') && !state.hidden,
  )
  const fileDockVisible =
    previewBesideChat && previewFileId !== null && previewFileId === composerSubject?.resourceId

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

  /*
    The persisted half of the research state, so the lock survives a reload or a
    session switch that clears the ephemeral fields above.

    This is the LATEST research job's status, via the same scan the session
    store, the busy hook and `MainLayout` use — not "did any message ever report
    X". The composer used to run three of its own `.some()` scans here, which
    disagreed with the rest of the codebase precisely when a session ran
    research twice: a failure after an earlier success still matched the
    "successful" scan and locked the composer over a session with no report.
    See `lib/research-session-state`, which owns the rule and tests it.

    Selecting a primitive rather than the message array also means the composer
    re-renders when the outcome changes, not on every streamed token.
  */
  const latestResearchJobStatus = useChatStore((state) =>
    latestDeepResearchJobStatus(state.currentConversation?.messages ?? [])
  )

  const {
    isSuccessful: isResearchSessionSuccessful,
    isFailed: isResearchSessionFailed,
    isInProgress: isResearchSessionInProgress,
  } = researchSessionState({
    latestJobStatus: latestResearchJobStatus,
    ephemeralStatus: deepResearchStatus,
    isStreaming: isDeepResearchStreaming,
    streamOwnerConversationId: deepResearchOwnerConversationId,
    conversationId: currentConversation?.id,
  })

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

  // An upload into this chat IS the thing the next send is about. Without a
  // subject the agent never receives focus_file_name and walks project +
  // Archiv instead (#429). Bind the latest ready file; do not re-bind after
  // the user clears the bar.
  useEffect(() => {
    const ready = sessionFiles.filter((file) => file.status === 'success' || file.status === 'ingesting')
    if (ready.length === 0) {
      boundSessionUploadRef.current = null
      return
    }
    const latest = ready[ready.length - 1]
    const id = latest.serverFileId ?? latest.id
    if (boundSessionUploadRef.current === id) return
    const current = useChatStore.getState().composerSubject
    if (current && current.resourceId !== boundSessionUploadRef.current) return
    boundSessionUploadRef.current = id
    setComposerSubject({
      resourceType: 'document',
      resourceId: id,
      title: latest.fileName,
      filename: latest.fileName,
      shelf: 'session',
    })
  }, [sessionFiles, setComposerSubject])

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
  const knowledgeLayerAvailable = useLayoutStore((s) => s.knowledgeLayerAvailable)
  const deepResearchIntent = useLayoutStore((s) => s.deepResearchIntent)
  const setDeepResearchIntent = useLayoutStore((s) => s.setDeepResearchIntent)
  const applySourcePreset = useLayoutStore((s) => s.applySourcePreset)
  const projectId = useChatStore((s) => s.projectId)

  useEffect(() => {
    if (!composerSubject) return
    // A session/Archiv subject is not "Projektunterlagen" — applying that
    // preset only switched RIS off and still mixed every knowledge shelf.
    if (composerSubject.shelf && composerSubject.shelf !== 'project') return
    const sources = useLayoutStore.getState().availableDataSources ?? []
    applySourcePreset('project', computePresetSourceIds('project', sources))
  }, [composerSubject?.resourceId, composerSubject?.shelf, applySourcePreset])

  // Streaming state + cancel action for the composer stop button (C1).
  // stopStreaming is added by the STREAMING agent in messages-store; selecting
  // it defensively means the button no-ops until that half of the contract lands.
  const isStreaming = useChatStore((s) => s.isStreaming)
  const stopStreaming = useChatStore((s) => s.stopStreaming)

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
  const threadSharing = useThreadSharing(canCollaborate ? currentSessionId : null)

  /*
    One gate for "may this person change anything about this conversation", and
    one for "may they type right now".

    `disabled` used to reach only the textarea and the send button, so a viewer
    in a shared thread — whose whole point is that they may read and not write —
    still had a live paperclip, a live drop zone, and a live *Datengrundlage*
    popover whose toggles persist onto the conversation. They could not send a
    message but they could rewrite which sources the next person's turn would
    use, and upload files into the thread. Hence two capabilities, not one flag.

    The decision moved to `collaboration/lib/composer-capabilities` because it
    was a role-NAME comparison (`myThreadRole === 'viewer'`) where the rest of
    the codebase ranks a ladder, and because every denial was anonymous. Both
    are ADR-0038 requirements. Behaviour is unchanged, including the
    allow-while-the-role-is-unknown window, which is now a named field with a
    test on it instead of a consequence of `null !== 'viewer'`.
  */
  const capabilities = composerCapabilities({
    isAuthenticated,
    canCollaborate,
    sharing: threadSharing,
    myRole: myThreadRole,
    isBusy,
    isResponseMode,
    researchLocked: isResearchSessionSuccessful,
    otherPersonsTurn: Boolean(otherPersonsTurnName),
  })

  // Composing presence. Only where somebody could actually see it: a shared
  // thread, collaboration on, and a role that may contribute — a viewer's draft
  // will never become a message, so announcing it would be a claim about
  // something that cannot happen. The server enforces all three regardless; this
  // is what keeps a private thread from issuing the request at all (spec NF-8).
  const { onTyping, onStoppedTyping } = useTypingBroadcast({
    conversationId: currentSessionId ?? null,
    enabled: capabilities.canBroadcastTyping,
  })

  const isDisabledByAuth = !isAuthenticated
  /** Read-only because of the role specifically — drives the viewer notice. */
  const isViewerInSharedThread = capabilities.deniedBy === 'read-only-role'
  const cannotContribute = !capabilities.canContribute
  const disabled = !capabilities.canCompose

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
    if (composerSubject) {
      return tFiles('assignment.askingAbout', {
        name: composerSubject.title?.trim() || tFiles('assignment.thisFile'),
      })
    }
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
      syncSlashQueryRef.current?.(value, caret ?? value.length)
      // Tell the thread. Throttled inside the hook, so this is a comparison on
      // most keystrokes; emptying the box withdraws the claim rather than letting
      // it expire, because "cleared the draft" is exactly when a colleague should
      // stop expecting a message.
      if (value.trim()) onTyping()
      else onStoppedTyping()
    },
    [
      isDisabledByAuth,
      currentConversation,
      ensureSession,
      setComposerDraft,
      syncMentionQuery,
      onTyping,
      onStoppedTyping,
    ]
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
    // Belt and braces with the `undefined` handler at the call site: this one is
    // reachable by anything holding a stale reference, and it writes to the
    // conversation's draft.
    if (cannotContribute) return
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
  }, [message, handleValueChange, cannotContribute])

  const syncMentionQueryFromElement = useCallback(
    (element: HTMLTextAreaElement) => {
      syncMentionQuery(element.value, element.selectionStart)
      syncSlashQueryRef.current?.(element.value, element.selectionStart)
    },
    [syncMentionQuery],
  )

  /*
    `/skill` invocation. All of its behaviour lives in `useSlashCommand`; the
    composer supplies the text, a way to replace it, and the picker.

    The ref indirection exists because `handleValueChange` (defined above, and a
    dependency of half this component) has to feed the hook, while the hook needs
    `handleValueChange` to write text back. Rather than reorder a 2000-line
    component around a new feature, the sync function is published into a ref the
    earlier callbacks read — the one edge where this feature touches existing
    code paths, and it is inert until the user types a slash.
  */
  const syncSlashQueryRef = useRef<((text: string, caret: number) => void) | null>(null)
  const replaceComposerText = useCallback(
    (text: string, caret: number) => {
      pendingCaretRef.current = caret
      handleValueChange(text, caret)
    },
    [handleValueChange],
  )
  const slash = useSlashCommand({
    text: message,
    // A message the agent is not being asked to answer cannot invoke a skill:
    // `contextOnly` sends are remarks to the thread (ADR-0034 addendum), and a
    // skill that force-activates on a turn nobody asked for would be a silent
    // cost. `cannotContribute` covers the read-only cases.
    enabled: !cannotContribute && !isResponseMode,
    onReplaceText: replaceComposerText,
  })
  syncSlashQueryRef.current = slash.syncQuery

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

  /*
    The thread's hand-off state, read from the server (never computed here — the
    banner, the inbox and this composer read the same rows, ADR-0034). It is what
    turns the default "Geht an Piloti" into "Geht an den Chat": while a named person
    is awaited, a plain message is a remark and the agent stays out.

    Off entirely without the flag, so a gated org opens no request (spec NF-8) —
    and off on a PRIVATE thread too. Gating on the flag alone was not enough:
    `useAwaitingState` subscribes to the shared event channel, so a solo user in a
    flag-on org opened a permanent `/api/stream` connection and polled
    `/awaiting` for a conversation that can never be waiting on anybody. NF-8 is
    the stricter promise — a user who never shares must not notice this exists —
    and `ChatArea` already reads the same state under exactly this predicate.
  */
  const { awaiting } = useAwaitingState(
    canCollaborate && threadSharing === 'shared' ? (currentSessionId ?? null) : null,
    canCollaborate && threadSharing === 'shared',
  )
  const threadAwaitsHuman = (awaiting?.pending.length ?? 0) > 0

  // ONE resolution, shared with the send below: `resolveAddressee` is the only
  // place the three-way decision is written. `@Piloti` alongside a person
  // addresses BOTH (spec MN-1), so the "Piloti stays quiet" hint would be a false
  // statement there; the addressee line names them both instead.
  //
  // Memoised so `activeMentions` keeps a stable identity across keystrokes —
  // AddresseeIndicator takes it by reference.
  const addressee = useMemo(
    () =>
      resolveAddressee({
        text: message,
        mentions,
        awaitingHuman: threadAwaitsHuman,
        canCollaborate,
      }),
    [message, mentions, threadAwaitsHuman, canCollaborate],
  )
  const activeMentions = addressee.mentions
  const taggedHumans = addressee.humans
  const agentTagged = addressee.agentTagged

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
      onStoppedTyping()
      if (submittingSessionId) clearComposerDraft(submittingSessionId)
      respondToInteraction(currentMessage)
      return
    }

    // Mentions are structured, and reconciled against the text at the last
    // possible moment: whatever token the user deleted while editing is not sent
    // (spec MN-3).
    // The SAME function the addressee line used, over the same inputs — so what
    // the user was told and what happens cannot disagree by construction, rather
    // than by two expressions being kept in step by tests.
    const sent = resolveAddressee({
      text: currentMessage,
      mentions,
      awaitingHuman: threadAwaitsHuman,
      canCollaborate,
    })
    const sentHumans = sent.humans

    // Files may still be uploading/ingesting — we no longer gate the send behind
    // a double-submit banner. The send button surfaces a subtle inline hint
    // (see title below) but the user is always free to send.
    setMessage('')
    setMentionQuery(null)
    // The draft became a message; the claim has served its purpose and the
    // message itself is the better signal from here on.
    onStoppedTyping()
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
        // it as context rather than as a turn.
        //
        // The shape comes from `sendMessageArgs`, so the fast path stays the
        // literal one-argument call it always was — an explicit `undefined` would
        // push plain messages down the server's ruling path.
        await (() => {
          // One ternary, not a re-derivation: `sendMessageOptions` already chose
          // the case. Omitting the argument entirely is what keeps the fast path
          // the literal single-argument call it has always been.
          const routed = sendMessageOptions(sent.routing)
          // Resolved from the TEXT BEING SENT, not from state: the `/name` token
          // can be edited away after it was picked, and what reaches the agent
          // has to be what the message still says — the same discipline the
          // mentions above follow.
          const invoked = slash.skillsForSend(currentMessage)
          const options = invoked ? { ...(routed ?? {}), skills: invoked } : routed
          return options
            ? sendMessage(currentMessage, options)
            : sendMessage(currentMessage)
        })(),
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
      /*
        A mention can make a PRIVATE thread shared — the server writes the grant
        and opens the request as part of storing the message. The seam that reads
        sharedness only reads it when the conversation changes, and every live
        subscription that would carry the news is gated on the very flag that is
        now stale, so without this the asker sent their first `@` and the product
        did nothing at all: no waiting banner, no explanation for Piloti's
        silence, no way back short of reloading the page.
      */
      if (sent.mentions.length > 0 && submittingSessionId) {
        bumpThreadRevision(submittingSessionId)
      }
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
    // handleSubmit resolves the addressee, which reads the flag — a stale value
    // would route a send against a state the user is no longer in.
    canCollaborate,
    currentConversation,
    clearComposerDraft,
    onStoppedTyping,
    slash,
    t,
    tCollab,
  ])

  // Post-research forward action: start a fresh session draft (the real
  // new-session path) so the user can ask follow-ups after a completed report,
  // instead of being stuck at a locked composer with a no-op explanation.
  const handleStartNewSession = useCallback(() => {
    startNewSessionDraft()
    useFilePreviewStore.getState().close()
    setMessage('')
  }, [startNewSessionDraft])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // The `/` picker gets first refusal on the navigation keys. It and the
      // mention picker are mutually exclusive by caret position (a slash query
      // only exists while the caret is inside the message's opening token), so
      // the order here is a formality rather than a precedence rule.
      if (slash.handleKeyDown(e, handleSubmit)) return

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
    [handleSubmit, mentionPickerOpen, slash]
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
      if (files.length === 0 || cannotContribute || isUploading || isBusy) return

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
    [ensureSession, uploadFiles, cannotContribute, isUploading, isBusy]
  )

  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: handleFilesSelected,
    disabled: cannotContribute || isUploading || isBusy,
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

  // Scope chip label: the active project (display-only scope; cross-project
  // search does not exist yet — spec §2.3, honest disabled option).
  const scopeLabel = projectName || tChat('composer.scopeFallback')

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 sm:pb-4">
      {/* The mention picker is anchored to the composer CARD and opens above it,
          spanning its full width — the Slack/Linear placement. Caret-pixel tracking
          inside a textarea is fragile and buys nothing here. */}
      <Popover
        open={mentionPickerOpen || slash.open}
        onOpenChange={(open) => {
          if (open) return
          // Dismiss whichever panel was showing. Both can be told to close: only
          // one of them is open, and the other's flag is already false.
          setMentionDismissed(true)
          slash.dismiss()
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
              {isUnsupportedDrag ? (
                <span className="text-muted-foreground text-xs">
                  {t('inputArea.accepts', { types: fileUploadConfig.acceptedTypes })}
                </span>
              ) : (
                /* WHERE the drop lands, in the sources panel's own words. The
                   overlay used to state the accepted types and nothing else, so
                   the one moment the user is deciding to hand over a file was
                   also the one moment the app said nothing about which shelf it
                   would go on — while the panel, one click away, both asked and
                   answered that question. */
                <UploadDestinationNote target="session" />
              )}
            </div>
          </div>
        )}
        <ComposerSubjectBar
          subject={composerSubject}
          projectId={projectId}
          onClear={() => {
            setComposerSubject(null)
            useFilePreviewStore.getState().close()
          }}
          onShowFile={
            !fileDockVisible && composerSubject
              ? () => useFilePreviewStore.getState().peek()
              : undefined
          }
          onTitle={(title) => {
            if (!composerSubject) return
            setComposerSubject({ ...composerSubject, title })
          }}
        />

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
                onOpen={(opened) => {
                  setPreviewFile(opened)
                  const id = opened.serverFileId ?? opened.id
                  boundSessionUploadRef.current = id
                  setComposerSubject({
                    resourceType: 'document',
                    resourceId: id,
                    title: opened.fileName,
                    filename: opened.fileName,
                    shelf: 'session',
                  })
                }}
                onRemove={deleteFile}
                onRetry={retryFile}
                readOnly={cannotContribute}
              />
            ))}
          </div>
        )}

        {/* The destination of the chips above — the composer attaches to the
            PRIVATE SESSION and cannot be told otherwise, unlike the sources
            panel, which offers the project corpus as well. Stated in the same
            words the panel uses (shared primitive), so a user who has seen both
            surfaces reads one vocabulary rather than two. */}
        {sessionFiles.length > 0 && <UploadDestinationNote target="session" className="mb-2" />}

        {/* Mobile-only entry to the full manage-files sheet. The desktop
            manage-files button is hidden on phones (the action row stays one
            line), so this compact text link — under the chip strip, only when
            files exist — is the phone user's way to the browse/upload/delete
            list. Not another chip in the action row (keeps it un-bulked). */}
        {/* Not for a viewer, for the same reason the desktop button beside the
            paperclip is disabled for them: what it opens is the browse / upload /
            per-file delete surface. This entry is `sm:hidden`, so leaving it out
            of the gate left the whole write surface reachable on a phone while
            the user guide said it was closed. */}
        {attachedFilesCount > 0 && !cannotContribute && (
          <button
            type="button"
            onClick={() => setManageFilesOpen(true)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mb-2 self-start rounded-sm text-[12px] font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 touch-target sm:hidden"
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
          className="max-h-52 min-h-[40px] resize-none border-0 bg-transparent px-1.5 py-1 text-base leading-[1.5] shadow-none outline-none! focus-visible:ring-0 pointer-coarse:min-h-11 md:text-[14.5px]"
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
          role={mentionPickerOpen || slash.open ? 'combobox' : undefined}
          aria-expanded={mentionPickerOpen || slash.open ? true : undefined}
          aria-haspopup={mentionPickerOpen || slash.open ? 'listbox' : undefined}
          aria-autocomplete={mentionPickerOpen || slash.open ? 'list' : undefined}
          aria-controls={
            slash.open
              ? (slash.aria.listboxId ?? undefined)
              : mentionPickerOpen
                ? (mentionAria.listboxId ?? undefined)
                : undefined
          }
          aria-activedescendant={
            slash.open
              ? (slash.aria.activeOptionId ?? undefined)
              : mentionPickerOpen
                ? (mentionAria.activeOptionId ?? undefined)
                : undefined
          }
        />

        {/* The skill this message invokes, if any. Under the textarea and above
            the control row, where the file chips sit: both answer "what is
            attached to what I am about to send?". */}
        <AnimatePresence initial={false}>
          {slash.invokedSkill && (
            <motion.div
              key={`invoked-skill-${slash.invokedSkill.name}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 2 }}
              transition={easeQuiet}
            >
              <InvokedSkillChip
                name={slash.invokedSkill.name}
                description={slash.invokedSkill.description}
                onRemove={cannotContribute ? undefined : slash.clearInvocation}
              />
            </motion.div>
          )}
        </AnimatePresence>

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
                disabled={cannotContribute}
                aria-label={tChat('composer.scopeAria', { project: scopeLabel })}
                title={tChat('composer.scopeAria', { project: scopeLabel })}
                className="bg-card shadow-xs hover:bg-accent focus-visible:ring-ring/50 inline-flex h-8 min-w-0 items-center gap-[7px] rounded-lg border px-[11px] pointer-coarse:h-11 transition-[color,background-color,transform] duration-200 ease-out active:scale-95 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
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

          {/* Datenbasis — the one control for WHERE Piloti may look. The
              trigger names the mix (a preset, a set of strata, "Alle Quellen");
              it never renders a bare count, because the count it used to render
              was wrong in both directions — see components/source-basis. Open
              state is lifted so the trigger can tell "the reader is watching
              the picker" from "a preset click landed off-screen". */}
          <Popover open={sourcesOpen} onOpenChange={setSourcesOpen}>
            <PopoverTrigger asChild>
              <SourceBasisTrigger disabled={cannotContribute} pickerOpen={sourcesOpen} />
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-88 max-w-[calc(100vw-2rem)] p-3">
              <SourceBasisPicker />
            </PopoverContent>
          </Popover>

          {/* Deep-Research intent pill — preference, NOT a hard trigger:
              the agent auto-escalates on its own (spec §2.2(6)) */}
          <button
            type="button"
            aria-pressed={deepResearchIntent}
            aria-label={tChat('composer.deepResearchAria')}
            title={tChat('composer.deepResearchHint')}
            disabled={cannotContribute}
            onClick={() => setDeepResearchIntent(!deepResearchIntent)}
            className={cn(
              'inline-flex h-8 shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border px-3 text-[12.5px] font-medium pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center transition-[color,background-color,box-shadow] duration-200 ease-out active:scale-95',
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
              //
              // But NOT to someone who may not write here. A screenshot of the
              // read-only composer caught this: the whole control row was dimmed
              // and this one link sat above "Sie können hier mitlesen", live and
              // underlined, offering to type an `@` into a disabled textarea.
              // Same class as the paperclip and the Datengrundlage popover.
              onMentionSomeone={cannotContribute ? undefined : handleMentionSomeone}
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
                className="text-muted-foreground hidden h-8 rounded-lg px-2.5 pointer-coarse:h-11 sm:inline-flex"
                disabled={cannotContribute || !knowledgeLayerAvailable}
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
              disabled={cannotContribute || isUploading || isBusy || !knowledgeLayerAvailable}
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
                  // `isStreaming` is the LOCAL store's turn flag and a viewer
                  // never starts a local turn, so this is belt and braces rather
                  // than a demonstrated hole — but cancelling somebody else's
                  // turn is the most consequential thing on this row, and it was
                  // the one control here with no gate at all.
                  disabled={cannotContribute}
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
          {slash.open ? (
            <SlashCommandPicker
              ref={slash.pickerRef}
              query={slash.query}
              skills={slash.skills}
              loading={slash.loading}
              onSelect={slash.select}
              onAriaChange={slash.onAriaChange}
            />
          ) : (
            <MentionPicker
              ref={mentionPickerRef}
              query={mentionQuery?.query ?? ''}
              candidates={mentionData?.candidates ?? []}
              canInvite={mentionData?.canInvite ?? false}
              loading={mentionsLoading}
              onSelect={handleMentionSelect}
              onAriaChange={setMentionAria}
            />
          )}
        </PopoverContent>
      </Popover>

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
