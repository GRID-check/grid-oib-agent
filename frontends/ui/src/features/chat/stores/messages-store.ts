import { v4 as uuidv4 } from 'uuid'
import type { StateCreator } from 'zustand'
import type {
  ChatStore,
  ChatMessage,
  ThinkingStep,
  StatusType,
  PromptType,
  FileCardData,
  ErrorCode,
  DeepResearchBannerType,
  Conversation,
  CitationSource,
  AnswerTransparency,
  HumanPromptInputType,
} from '../types'
import type { GridCard } from '@/shared/cards/schemas'
import type { CardDecision, CardInteractions } from '@/features/grid-cards/card-decision'
import { reconcileCardInteractions } from '@/features/grid-cards/card-decision'
import { getErrorMeta } from '../lib/error-registry'
import { mergeTraceLaneCards, parseTraceLanesBlock } from '../lib/trace-lanes'
import { useLayoutStore } from '@/features/layout/store'
import { ensureStorageCapacity, checkStorageHealth } from '../lib/storage-manager'

export type MessagesSlice = {
  isStreaming: boolean
  isLoading: boolean
  currentUserMessageId: string | null
  thinkingSteps: ThinkingStep[]
  activeThinkingStepId: string | null
  streamingAssistantMessageId: string | null
  reportContent: string
  reportContentCategory: 'research_notes' | 'final_report' | null
  currentStatus: StatusType | null
  projectId: string | null
  /**
   * One-shot draft text destined for the chat composer (InputArea). Set by
   * deep links (`?ask=`) and welcome-screen suggestion chips; consumed exactly
   * once by the composer, which populates + focuses the textarea and clears
   * this flag. Store-backed because the composer draft itself lives in
   * component-local state with no cross-component setter.
   */
  composerPrefill: string | null
  /**
   * Per-session composer drafts keyed by conversation id: the user's own
   * in-progress, unsent text. Unlike `composerPrefill` (one-shot, external),
   * a draft is long-lived — it survives session switches and reloads because
   * it is persisted to the `aiq-chat-store` localStorage namespace alongside
   * the conversations. It is a plain serialisable map (SSR-safe) and is cleared
   * only on successful send or when its session is deleted. Keyed by
   * conversation id, so it is inherently project/user-scoped (a session id is
   * already scoped to one project + user) and cannot leak across contexts.
   */
  composerDrafts: Record<string, string>
  /**
   * Transient send callback registered by InputArea's WebSocket chat hook
   * (mirrors `respondToInteractionFn`). Lets sibling components that do not own
   * the socket — e.g. the "Erneut versuchen" retry action on an errored answer,
   * rendered in ChatArea — resend a message through the live send path. Not
   * persisted (see `partialize` in store.ts).
   */
  chatSendFn: ((content: string) => void) | null

  startAssistantMessage: () => ChatMessage
  appendToAssistantMessage: (content: string) => void
  completeAssistantMessage: () => void
  setLoading: (isLoading: boolean) => void
  setStreaming: (isStreaming: boolean) => void
  /**
   * User-initiated cancel of the in-flight turn [C1]: flush any batched delta
   * text, finalize/close the current streaming bubble (isStreaming -> false),
   * clear isStreaming/isLoading/currentStatus, and trigger the websocket
   * teardown registered by use-websocket-chat.
   */
  stopStreaming: () => void
  addThinkingStep: (step: Omit<ThinkingStep, 'id' | 'timestamp' | 'userMessageId'>) => string
  getThinkingStepsForMessage: (userMessageId: string) => ThinkingStep[]
  appendToThinkingStep: (stepId: string, content: string) => void
  completeThinkingStep: (stepId: string) => void
  updateThinkingStepByFunctionName: (functionName: string, content: string, isComplete: boolean) => void
  findThinkingStepByFunctionName: (functionName: string) => ThinkingStep | undefined
  setReportContent: (content: string, category?: 'research_notes' | 'final_report') => void
  clearThinkingSteps: () => void
  clearReportContent: () => void
  setCurrentStatus: (status: StatusType | null) => void
  addAgentPrompt: (
    type: PromptType,
    content: string,
    options?: string[],
    placeholder?: string,
    promptId?: string,
    parentId?: string,
    inputType?: HumanPromptInputType
  ) => void
  respondToPrompt: (messageId: string, response: string) => void
  addUserMessage: (
    content: string,
    metadata?: {
      enabledDataSources?: string[]
      messageFiles?: Array<{ id: string; fileName: string }>
    }
  ) => ChatMessage
  addAgentResponse: (
    content: string,
    showViewReport?: boolean,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    transparency?: AnswerTransparency
  ) => void
  appendAgentResponseDelta: (
    content: string,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[]
  ) => void
  finalizeAgentResponse: (
    content: string,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    transparency?: AnswerTransparency
  ) => void
  /**
   * Drop the in-progress streaming assistant bubble of the current turn (the
   * one referenced by `streamingAssistantMessageId`) entirely — message removed,
   * not merely finalized — and clear `streamingAssistantMessageId`. Used when a
   * turn resolves in a surface OTHER than an answer bubble (e.g. a job-admission
   * rejection rendered as a banner), so any orphaned bubble opened by earlier
   * deltas leaves no lingering caret. No-op when no streaming bubble is open.
   */
  discardStreamingAssistantMessage: () => void
  addAgentResponseWithMeta: (
    content: string,
    showViewReport: boolean,
    meta: Partial<ChatMessage>,
    cards?: GridCard[]
  ) => string
  patchConversationMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<ChatMessage>
  ) => void
  setCardDecision: (messageId: string, cardKey: string, decision: CardDecision) => void
  addFileCard: (data: FileCardData) => void
  updateFileCard: (messageId: string, data: Partial<FileCardData>) => void
  addErrorCard: (code: ErrorCode, message?: string, details?: string) => void
  dismissErrorCard: (messageId: string) => void
  dismissConnectionErrors: () => void
  addDeepResearchBanner: (
    bannerType: DeepResearchBannerType,
    jobId: string,
    conversationId?: string,
    stats?: { totalTokens?: number; toolCallCount?: number },
    escalationReason?: string
  ) => void
  setProjectId: (projectId: string | null) => void
  /** Queue text for the composer to pick up (does NOT auto-send). */
  setComposerPrefill: (text: string) => void
  /** Read and clear the queued composer prefill; returns null when empty. */
  consumeComposerPrefill: () => string | null
  /** Register the live chat send callback (called by InputArea on mount). */
  setChatSendFn: (fn: ((content: string) => void) | null) => void
  /**
   * Resend the last user message of the current conversation — the retry
   * affordance on an errored answer. Sends through the registered `chatSendFn`
   * when present; otherwise falls back to prefilling the composer with that
   * text so the user can send it manually. No-op when there is no user message.
   */
  retryLastUserMessage: () => void

  /**
   * Splice messages that originated on the SERVER into a conversation — the
   * write half of the ADR-0033 seam, used only for shared conversations.
   *
   * Everything else in this slice writes messages the local client just
   * produced; this is the one action for messages a *colleague* (or this user on
   * another device) produced. Three properties are load-bearing:
   *
   *   1. **Deduplicated by message id.** The push channel echoes your own write
   *      back to you, and without this the optimistic bubble would render twice
   *      (ADR-0033 §5). Where both copies exist the LOCAL object wins, because it
   *      carries streaming/thinking state the server never stored — only the
   *      server's facts (position, author, mentions) are folded in.
   *   2. **No turn state is touched.** `isStreaming`, `isLoading`,
   *      `thinkingSteps`, `streamingAssistantMessageId` and
   *      `currentUserMessageId` all belong to THIS client's turn. A colleague's
   *      message arriving must not disturb them.
   *   3. **No persist POST.** These messages came FROM the server; mirroring them
   *      back would be a write loop.
   *
   * With `replace` the server list is treated as authoritative for the thread
   * (the load-on-open path): known ids keep their local object but take the
   * server's ordering facts, and local-only messages ride at the tail because by
   * definition they are not yet persisted — dropping an in-flight turn is the
   * risk ADR-0033 explicitly warns about.
   */
  insertRemoteMessages: (
    conversationId: string,
    messages: ChatMessage[],
    options?: { replace?: boolean }
  ) => void

  /** Save (or update) the in-progress composer draft for a session. Passing an empty string drops the entry. */
  setComposerDraft: (conversationId: string, text: string) => void
  /** Read the persisted composer draft for a session ('' when none). */
  getComposerDraft: (conversationId: string) => string
  /** Drop a session's composer draft (on successful send or session removal). */
  clearComposerDraft: (conversationId: string) => void
}

/**
 * Transient cancel handler for the in-flight streaming turn. Registered by
 * `use-websocket-chat` (which owns the socket ref) so the store's
 * `stopStreaming` action can tear the socket down without importing the hook.
 * Module-scoped rather than store state so it stays out of persistence and does
 * not need a `types.ts` declaration.
 */
let stopStreamingHandler: (() => void) | null = null

/** Register (or clear, with `null`) the websocket teardown for `stopStreaming`. */
export const registerStopStreamingHandler = (fn: (() => void) | null): void => {
  stopStreamingHandler = fn
}

const generateTitle = (content: string): string => {
  const maxLength = 50
  const trimmed = content.trim()
  if (trimmed.length <= maxLength) {
    return trimmed
  }
  return trimmed.substring(0, maxLength) + '...'
}

const updateConversationInList = (
  conversations: Conversation[],
  updatedConversation: Conversation
): Conversation[] => {
  return conversations.map((c) => (c.id === updatedConversation.id ? updatedConversation : c))
}

// ── Remote (server-originated) message merging — the ADR-0033 seam ────────────

/** Milliseconds of a message's timestamp, which may be a Date or an ISO string. */
const messageTime = (message: ChatMessage): number => {
  const value = message.timestamp
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

/**
 * Thread order, identical for every participant (spec CC-11): server timestamp
 * first, message id as the tiebreak. Ordering on the id rather than on arrival
 * is what stops two clients showing the same two messages in different orders
 * when they were written in the same millisecond.
 */
const compareThreadOrder = (a: ChatMessage, b: ChatMessage): number => {
  const byTime = messageTime(a) - messageTime(b)
  if (byTime !== 0) return byTime
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Fold the server's facts about a message we already hold locally into the local
 * object: its authoritative timestamp (so ordering is the server's, not this
 * browser's clock) and the authorship/mention metadata the optimistic copy never
 * had. Returns the SAME object when nothing differs, because message-object
 * identity is what lets the message list skip re-rendering (see ChatArea's memo).
 */
const withServerFacts = (local: ChatMessage, remote: ChatMessage): ChatMessage => {
  const patch: Partial<ChatMessage> = {}

  if (messageTime(remote) !== messageTime(local)) patch.timestamp = remote.timestamp
  if (remote.authorUserId && remote.authorUserId !== local.authorUserId) {
    patch.authorUserId = remote.authorUserId
  }
  if (remote.authorName && remote.authorName !== local.authorName) patch.authorName = remote.authorName
  if (remote.authorAvatarUrl && remote.authorAvatarUrl !== local.authorAvatarUrl) {
    patch.authorAvatarUrl = remote.authorAvatarUrl
  }
  if (remote.mentions && !local.mentions) patch.mentions = remote.mentions
  if (remote.addressees && !local.addressees) patch.addressees = remote.addressees

  return Object.keys(patch).length === 0 ? local : { ...local, ...patch }
}

/**
 * Merge server-originated messages into a conversation's list.
 *
 * Returns the ORIGINAL array when nothing changed, so a poll or focus refresh
 * that learns nothing new costs no re-render, no conversation rebuild and no
 * re-sort. `added` distinguishes "a message arrived" (new activity in the thread)
 * from "an existing message was corrected" (resolved author names, the server's
 * timestamp) — only the former is activity that may reorder the session list.
 */
const mergeRemoteMessages = (
  local: ChatMessage[],
  remote: ChatMessage[],
  replace: boolean
): { messages: ChatMessage[]; added: boolean } => {
  const localById = new Map(local.map((message) => [message.id, message]))

  // Known ids keep their local object (plus the server's facts); unknown ids are
  // genuinely new — a colleague's message, or one of ours from another device.
  let changed = false
  let added = false
  const reconciled = remote.map((message) => {
    const existing = localById.get(message.id)
    if (!existing) {
      changed = true
      added = true
      return message
    }
    const merged = withServerFacts(existing, message)
    if (merged !== existing) changed = true
    return merged
  })

  const remoteIds = new Set(remote.map((message) => message.id))
  const localOnly = local.filter((message) => !remoteIds.has(message.id))

  // A local-only message is either (a) part of the turn happening right now, which
  // the server has not been told about yet, or (b) a stale leftover of the
  // local-first era. Incremental merges keep both — they are not claiming to know
  // the whole thread. A `replace` load IS claiming that, so it keeps only what is
  // demonstrably in flight: an open streaming bubble, or a message no older than
  // the newest row the server returned. An empty server list never wipes a
  // thread — a thread the server has no rows for is a thread we know nothing
  // about, not an empty one.
  const newestRemoteTime = remote.reduce((newest, message) => Math.max(newest, messageTime(message)), 0)
  const keptLocalOnly =
    replace && remote.length > 0
      ? localOnly.filter((message) => message.isStreaming || messageTime(message) >= newestRemoteTime)
      : localOnly
  if (keptLocalOnly.length !== localOnly.length) changed = true

  if (!changed) return { messages: local, added: false }

  return { messages: [...reconciled, ...keptLocalOnly].sort(compareThreadOrder), added }
}

/**
 * Apply a "Function Complete: X" payload to a step, carrying its retrieval over.
 *
 * The step is keyed by function name alone, so every call a ReAct-style agent
 * makes to the SAME tool within one turn lands on the same step and replaces its
 * `content` wholesale — which is correct for the visible step text (it shows the
 * latest output) but silently threw away what the earlier calls had retrieved:
 * the `## Trace-Lanes` block of call #1 was gone the moment call #2 completed,
 * and with it the source card the Herleitung had already rendered for it. So
 * before the overwrite we lift the lanes out of BOTH the outgoing and the
 * incoming payload and fold them into `traceLanes`, the step's cumulative record
 * of what the turn has read. `content` is still replaced exactly as before, and
 * lanes are only attached once there is something to attach, so a step whose
 * tool ships no structured block (web/RIS) keeps falling through to the URL scan
 * in `deriveTraceLanes`.
 */
const withCompletedPayload = (step: ThinkingStep, content: string, isComplete: boolean): ThinkingStep => {
  const carried = mergeTraceLaneCards(step.traceLanes, parseTraceLanesBlock(step.content))
  const merged = mergeTraceLaneCards(carried, parseTraceLanesBlock(content))
  return merged.length > 0
    ? { ...step, content, isComplete, traceLanes: merged }
    : { ...step, content, isComplete }
}

const createNewConversation = (userId: string): Conversation => ({
  id: `s_${uuidv4().replace(/-/g, '_')}`,
  userId,
  title: '',
  messages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
})

const createDeepResearchBannerMessage = (
  bannerType: DeepResearchBannerType,
  jobId: string,
  stats?: { totalTokens?: number; toolCallCount?: number },
  escalationReason?: string
): ChatMessage => ({
  id: uuidv4(),
  role: 'assistant',
  content: '',
  timestamp: new Date(),
  messageType: 'deep_research_banner',
  deepResearchBannerData: {
    bannerType,
    jobId,
    totalTokens: stats?.totalTokens,
    toolCallCount: stats?.toolCallCount,
    ...(escalationReason ? { escalationReason } : {}),
  },
  ...(bannerType === 'starting' && {
    deepResearchJobId: jobId,
    deepResearchJobStatus: 'submitted' as const,
    isDeepResearchActive: true,
  }),
})

const withDeepResearchBanner = (
  conversation: Conversation,
  bannerType: DeepResearchBannerType,
  jobId: string,
  stats?: { totalTokens?: number; toolCallCount?: number },
  escalationReason?: string
): Conversation => {
  const isTerminalBanner = bannerType !== 'starting'
  const filteredMessages = isTerminalBanner
    ? conversation.messages.filter(
        (message) =>
          !(
            message.messageType === 'deep_research_banner' &&
            message.deepResearchBannerData?.jobId === jobId
          )
      )
    : conversation.messages

  return {
    ...conversation,
    messages: [
      ...filteredMessages,
      createDeepResearchBannerMessage(bannerType, jobId, stats, escalationReason),
    ],
    updatedAt: new Date(),
  }
}

export const initialMessagesState = {
  isStreaming: false,
  isLoading: false,
  currentUserMessageId: null as string | null,
  thinkingSteps: [] as ThinkingStep[],
  activeThinkingStepId: null as string | null,
  streamingAssistantMessageId: null as string | null,
  reportContent: '',
  reportContentCategory: null as 'research_notes' | 'final_report' | null,
  currentStatus: null as StatusType | null,
  projectId: null as string | null,
  composerPrefill: null as string | null,
  composerDrafts: {} as Record<string, string>,
  chatSendFn: null as ((content: string) => void) | null,
}

/**
 * Build an `agent_response` ChatMessage, folding in the deep-research /
 * plan / citation context carried on the store at emit time. Shared by
 * `addAgentResponse` (one-shot bubble) and `appendAgentResponseDelta` (first
 * delta of a streamed answer) so a finalized streamed bubble is byte-identical
 * to today's single-shot response for the same store state — this is what
 * preserves backward compatibility.
 */
const buildAgentResponseMessage = (
  state: ChatStore,
  id: string,
  content: string,
  opts: {
    showViewReport?: boolean
    cards?: GridCard[]
    answerConfidence?: 'low' | 'medium' | 'high'
    citations?: CitationSource[]
    isStreaming?: boolean
    transparency?: AnswerTransparency
  }
): ChatMessage => {
  const {
    reportContent,
    deepResearchCitations,
    planMessages,
    deepResearchTodos,
    deepResearchLLMSteps,
    deepResearchAgents,
    deepResearchToolCalls,
    deepResearchFiles,
    deepResearchJobId,
    deepResearchLastEventId,
    deepResearchStatus,
  } = state

  return {
    id,
    role: 'assistant',
    content,
    timestamp: new Date(),
    messageType: 'agent_response',
    showViewReport: opts.showViewReport,
    cards: opts.cards,
    answerConfidence: opts.answerConfidence,
    reportContent: reportContent || undefined,
    citations:
      opts.citations && opts.citations.length > 0
        ? opts.citations
        : deepResearchCitations.length > 0
          ? [...deepResearchCitations]
          : undefined,
    planMessages: planMessages.length > 0 ? [...planMessages] : undefined,
    deepResearchTodos: deepResearchTodos.length > 0 ? [...deepResearchTodos] : undefined,
    deepResearchLLMSteps:
      deepResearchLLMSteps.length > 0 ? [...deepResearchLLMSteps] : undefined,
    deepResearchAgents: deepResearchAgents.length > 0 ? [...deepResearchAgents] : undefined,
    deepResearchToolCalls:
      deepResearchToolCalls.length > 0 ? [...deepResearchToolCalls] : undefined,
    deepResearchFiles: deepResearchFiles.length > 0 ? [...deepResearchFiles] : undefined,
    deepResearchJobId: deepResearchJobId || undefined,
    deepResearchLastEventId: deepResearchLastEventId || undefined,
    deepResearchJobStatus: deepResearchStatus || undefined,
    ...(opts.isStreaming ? { isStreaming: true } : {}),
    // Transparency extras (WP-A). Spread only the fields that are present so a
    // turn without them stays byte-identical to the pre-transparency message.
    ...(opts.transparency?.routingDecision
      ? { routingDecision: opts.transparency.routingDecision }
      : {}),
    ...(opts.transparency?.routingReason
      ? { routingReason: opts.transparency.routingReason }
      : {}),
    ...(opts.transparency?.escalationReason
      ? { escalationReason: opts.transparency.escalationReason }
      : {}),
    ...(opts.transparency?.answerConfidenceCappedReason
      ? { answerConfidenceCappedReason: opts.transparency.answerConfidenceCappedReason }
      : {}),
    ...(opts.transparency?.answerConfidenceReason
      ? { answerConfidenceReason: opts.transparency.answerConfidenceReason }
      : {}),
    ...(opts.transparency?.citationsRemoved
      ? { citationsRemoved: opts.transparency.citationsRemoved }
      : {}),
  }
}

export const createMessagesSlice: StateCreator<ChatStore, [["zustand/devtools", never]], [], MessagesSlice> = (set, get) => {
  // --- Streamed-delta batching ------------------------------------------------
  // Rather than rebuilding the whole conversation object on every token (one
  // set() per delta), subsequent answer deltas accumulate in this buffer and
  // flush to the store once per animation frame. In the browser this collapses
  // N per-token writes into ~1 per frame; in non-DOM / test envs we flush
  // synchronously so `append` then a synchronous read still observes the text.
  let pendingDeltaText = ''
  let pendingDeltaMeta: {
    cards?: GridCard[]
    answerConfidence?: 'low' | 'medium' | 'high'
    citations?: CitationSource[]
  } = {}
  let deltaRafHandle: number | null = null

  const canBatchDeltas = (): boolean =>
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function' &&
    // Keep tests deterministic: they append then read synchronously, so never
    // defer under vitest (NODE_ENV is statically 'production'/'development' in
    // the browser bundle, so this branch tree-shakes out there).
    process.env.NODE_ENV !== 'test'

  const cancelScheduledFlush = (): void => {
    if (deltaRafHandle !== null) {
      window.cancelAnimationFrame(deltaRafHandle)
      deltaRafHandle = null
    }
  }

  const resetDeltaBuffer = (): void => {
    cancelScheduledFlush()
    pendingDeltaText = ''
    pendingDeltaMeta = {}
  }

  /** Apply any buffered delta text/meta to the open streaming bubble. */
  const flushDeltaBuffer = (): void => {
    cancelScheduledFlush()

    const text = pendingDeltaText
    const meta = pendingDeltaMeta
    // Clear the buffer up front so stale text can never leak onto a later
    // (different) bubble if the tracked id has since been released.
    pendingDeltaText = ''
    pendingDeltaMeta = {}

    const hasMeta =
      (meta.cards && meta.cards.length > 0) ||
      !!meta.answerConfidence ||
      (meta.citations && meta.citations.length > 0)
    if (text === '' && !hasMeta) return

    const { currentConversation, conversations, streamingAssistantMessageId } = get()
    if (!currentConversation || !streamingAssistantMessageId) return

    const updatedMessages = currentConversation.messages.map((msg) =>
      msg.id === streamingAssistantMessageId
        ? {
            ...msg,
            content: msg.content + text,
            // Replacing the card set can invalidate positional decision keys —
            // re-anchor them (or drop them) rather than let one point at a
            // different card. No-op in the common case (no cards, or the same
            // set arriving again).
            ...(meta.cards && meta.cards.length > 0
              ? {
                  cards: meta.cards,
                  cardInteractions: reconcileCardInteractions(
                    msg.cardInteractions,
                    msg.cards,
                    meta.cards
                  ),
                }
              : {}),
            ...(meta.answerConfidence ? { answerConfidence: meta.answerConfidence } : {}),
            ...(meta.citations && meta.citations.length > 0 ? { citations: meta.citations } : {}),
          }
        : msg
    )

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    set(
      {
        currentConversation: updatedConversation,
        conversations: updateConversationInList(conversations, updatedConversation),
      },
      false,
      'appendAgentResponseDelta:flush'
    )
  }

  const scheduleDeltaFlush = (): void => {
    if (deltaRafHandle !== null) return
    deltaRafHandle = window.requestAnimationFrame(() => {
      deltaRafHandle = null
      flushDeltaBuffer()
    })
  }

  return {
  ...initialMessagesState,

  startAssistantMessage: () => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) {
      throw new Error('No active conversation')
    }

    const newMessage: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      messageType: 'assistant',
      isStreaming: true,
    }

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: [...currentConversation.messages, newMessage],
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
        isStreaming: true,
        isLoading: false,
      },
      false,
      'startAssistantMessage'
    )

    return newMessage
  },

  appendToAssistantMessage: (content: string) => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const messages = currentConversation.messages
    const lastMessage = messages[messages.length - 1]

    if (!lastMessage || lastMessage.role !== 'assistant' || !lastMessage.isStreaming) {
      return
    }

    const updatedMessage: ChatMessage = {
      ...lastMessage,
      content: lastMessage.content + content,
    }

    const updatedMessages = [...messages.slice(0, -1), updatedMessage]

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'appendToAssistantMessage'
    )
  },

  completeAssistantMessage: () => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const messages = currentConversation.messages
    const lastMessage = messages[messages.length - 1]

    if (!lastMessage || lastMessage.role !== 'assistant') {
      set({ isStreaming: false }, false, 'completeAssistantMessage')
      return
    }

    const updatedMessage: ChatMessage = {
      ...lastMessage,
      isStreaming: false,
    }

    const updatedMessages = [...messages.slice(0, -1), updatedMessage]

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
        isStreaming: false,
      },
      false,
      'completeAssistantMessage'
    )

    get()._appendMessage(updatedMessage)
    // The turn has settled, so its provenance exists now and can be mirrored
    // (ADR-0037). Fire-and-forget: the asker already sees the Herleitung from the
    // store, and a failed mirror must not fail the turn.
    void get()._persistTurnProvenance()
  },

  setLoading: (isLoading: boolean) => {
    set({ isLoading }, false, 'setLoading')
  },

  setStreaming: (isStreaming: boolean) => {
    set({ isStreaming }, false, 'setStreaming')
  },

  stopStreaming: () => {
    // Flush any batched delta text first so the finalized bubble keeps
    // everything received before the cancel.
    flushDeltaBuffer()
    resetDeltaBuffer()

    const { currentConversation, conversations, streamingAssistantMessageId } = get()

    // Close the open streaming bubble (mark it non-streaming) so the caret
    // stops and it reads as a finished — if truncated — answer [C6].
    if (currentConversation && streamingAssistantMessageId) {
      const updatedMessages = currentConversation.messages.map((msg) =>
        msg.id === streamingAssistantMessageId ? { ...msg, isStreaming: false } : msg
      )
      const updatedConversation: Conversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: new Date(),
      }
      set(
        {
          currentConversation: updatedConversation,
          conversations: updateConversationInList(conversations, updatedConversation),
          streamingAssistantMessageId: null,
          isStreaming: false,
          isLoading: false,
          currentStatus: null,
        },
        false,
        'stopStreaming'
      )
    } else {
      set(
        {
          streamingAssistantMessageId: null,
          isStreaming: false,
          isLoading: false,
          currentStatus: null,
        },
        false,
        'stopStreaming'
      )
    }

    // Tear down the in-flight socket (registered by use-websocket-chat).
    stopStreamingHandler?.()
  },

  addThinkingStep: (step: Omit<ThinkingStep, 'id' | 'timestamp' | 'userMessageId'>) => {
    const { currentUserMessageId, currentConversation, conversations } = get()
    if (!currentUserMessageId) {
      console.warn('addThinkingStep called without currentUserMessageId')
      return ''
    }

    const stepId = uuidv4()
    const newStep: ThinkingStep = {
      ...step,
      id: stepId,
      userMessageId: currentUserMessageId,
      timestamp: new Date(),
    }

    let updatedConversation = currentConversation
    let updatedConversations = conversations

    if (currentConversation) {
      const updatedMessages = currentConversation.messages.map((msg) => {
        if (msg.id === currentUserMessageId) {
          return {
            ...msg,
            thinkingSteps: [...(msg.thinkingSteps || []), newStep],
          }
        }
        return msg
      })

      updatedConversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: new Date(),
      }

      updatedConversations = updateConversationInList(conversations, updatedConversation)
    }

    set(
      {
        thinkingSteps: [...get().thinkingSteps, newStep],
        activeThinkingStepId: stepId,
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'addThinkingStep'
    )

    return stepId
  },

  getThinkingStepsForMessage: (userMessageId: string) => {
    const { thinkingSteps } = get()
    return thinkingSteps.filter(
      (step) => step.userMessageId === userMessageId && !step.isDeepResearch
    )
  },

  appendToThinkingStep: (stepId: string, content: string) => {
    const { currentConversation, conversations, thinkingSteps } = get()

    const updatedThinkingSteps = thinkingSteps.map((step) =>
      step.id === stepId ? { ...step, content: step.content + content } : step
    )

    const step = thinkingSteps.find((s) => s.id === stepId)
    let updatedConversation = currentConversation
    let updatedConversations = conversations

    if (step && currentConversation) {
      const updatedMessages = currentConversation.messages.map((msg) => {
        if (msg.id === step.userMessageId && msg.thinkingSteps) {
          return {
            ...msg,
            thinkingSteps: msg.thinkingSteps.map((s) =>
              s.id === stepId ? { ...s, content: s.content + content } : s
            ),
          }
        }
        return msg
      })

      updatedConversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: new Date(),
      }

      updatedConversations = updateConversationInList(conversations, updatedConversation)
    }

    set(
      {
        thinkingSteps: updatedThinkingSteps,
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'appendToThinkingStep'
    )
  },

  completeThinkingStep: (stepId: string) => {
    const { currentConversation, conversations, thinkingSteps, activeThinkingStepId } = get()

    const updatedThinkingSteps = thinkingSteps.map((step) =>
      step.id === stepId ? { ...step, isComplete: true } : step
    )

    const step = thinkingSteps.find((s) => s.id === stepId)
    let updatedConversation = currentConversation
    let updatedConversations = conversations

    if (step && currentConversation) {
      const updatedMessages = currentConversation.messages.map((msg) => {
        if (msg.id === step.userMessageId && msg.thinkingSteps) {
          return {
            ...msg,
            thinkingSteps: msg.thinkingSteps.map((s) =>
              s.id === stepId ? { ...s, isComplete: true } : s
            ),
          }
        }
        return msg
      })

      updatedConversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: new Date(),
      }

      updatedConversations = updateConversationInList(conversations, updatedConversation)
    }

    set(
      {
        thinkingSteps: updatedThinkingSteps,
        activeThinkingStepId: activeThinkingStepId === stepId ? null : activeThinkingStepId,
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'completeThinkingStep'
    )
  },

  updateThinkingStepByFunctionName: (
    functionName: string,
    content: string,
    isComplete: boolean
  ) => {
    const { currentConversation, conversations, thinkingSteps, currentUserMessageId } = get()

    const updatedThinkingSteps = thinkingSteps.map((step) =>
      step.functionName === functionName && step.userMessageId === currentUserMessageId
        ? withCompletedPayload(step, content, isComplete)
        : step
    )

    const step = thinkingSteps.find(
      (s) => s.functionName === functionName && s.userMessageId === currentUserMessageId
    )
    let updatedConversation = currentConversation
    let updatedConversations = conversations

    if (step && currentConversation) {
      const updatedMessages = currentConversation.messages.map((msg) => {
        if (msg.id === step.userMessageId && msg.thinkingSteps) {
          return {
            ...msg,
            thinkingSteps: msg.thinkingSteps.map((s) =>
              s.functionName === functionName ? withCompletedPayload(s, content, isComplete) : s
            ),
          }
        }
        return msg
      })

      updatedConversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: new Date(),
      }

      updatedConversations = updateConversationInList(conversations, updatedConversation)
    }

    set(
      {
        thinkingSteps: updatedThinkingSteps,
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'updateThinkingStepByFunctionName'
    )
  },

  findThinkingStepByFunctionName: (functionName: string) => {
    const { thinkingSteps, currentUserMessageId } = get()
    if (!currentUserMessageId) return undefined
    return thinkingSteps.find(
      (step) =>
        step.functionName === functionName && step.userMessageId === currentUserMessageId
    )
  },

  setReportContent: (content: string, category?: 'research_notes' | 'final_report') => {
    set(
      { reportContent: content, reportContentCategory: category ?? null },
      false,
      'setReportContent'
    )
  },

  clearThinkingSteps: () => {
    set({ thinkingSteps: [], activeThinkingStepId: null }, false, 'clearThinkingSteps')
  },

  clearReportContent: () => {
    set({ reportContent: '', reportContentCategory: null }, false, 'clearReportContent')
  },

  setCurrentStatus: (status: StatusType | null) => {
    set({ currentStatus: status }, false, 'setCurrentStatus')
  },

  addAgentPrompt: (
    type: PromptType,
    content: string,
    options?: string[],
    placeholder?: string,
    promptId?: string,
    parentId?: string,
    inputType?: HumanPromptInputType
  ) => {
    const { currentConversation, conversations, planMessages } = get()
    if (!currentConversation) return

    const promptMessage: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content,
      timestamp: new Date(),
      messageType: 'prompt',
      promptType: type,
      promptId,
      promptParentId: parentId,
      promptInputType: inputType,
      promptOptions: options,
      promptPlaceholder: placeholder,
      isPromptResponded: false,
      planMessages: planMessages.length > 0 ? [...planMessages] : undefined,
    }

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: [...currentConversation.messages, promptMessage],
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
        isLoading: false,
        isStreaming: false,
      },
      false,
      'addAgentPrompt'
    )
  },

  respondToPrompt: (messageId: string, response: string) => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const updatedMessages = currentConversation.messages.map((msg) =>
      msg.id === messageId
        ? { ...msg, promptResponse: response, isPromptResponded: true }
        : msg
    )

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
        isLoading: true,
        pendingInteraction: null,
      },
      false,
      'respondToPrompt'
    )
  },

  addUserMessage: (
    content: string,
    metadata?: {
      enabledDataSources?: string[]
      messageFiles?: Array<{ id: string; fileName: string }>
    }
  ) => {
    const { currentConversation, conversations, currentUserId } = get()

    let conversation = currentConversation
    if (!conversation) {
      if (!currentUserId) {
        throw new Error('Cannot create conversation without authenticated user')
      }
      const layoutState = useLayoutStore.getState()
      conversation = {
        ...createNewConversation(currentUserId),
        // Stamp the active project (UX-8): an unstamped session created inside
        // a project would appear in every project's list and dodge the
        // cross-project clear guard in setProjectId.
        projectId: get().projectId ?? null,
        enabledDataSourceIds: [...layoutState.enabledDataSourceIds],
      }
    }

    const newMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content,
      timestamp: new Date(),
      messageType: 'user',
      enabledDataSources: metadata?.enabledDataSources,
      messageFiles: metadata?.messageFiles,
    }

    const hasUserMessage = conversation.messages.some((m) => m.messageType === 'user')
    const shouldUpdateTitle = !hasUserMessage

    const updatedConversation: Conversation = {
      ...conversation,
      title: shouldUpdateTitle ? generateTitle(content) : conversation.title,
      messages: [...conversation.messages, newMessage],
      updatedAt: new Date(),
    }

    const existingIndex = conversations.findIndex((c) => c.id === updatedConversation.id)
    let updatedConversations: Conversation[]

    if (existingIndex >= 0) {
      updatedConversations = updateConversationInList(conversations, updatedConversation)
    } else {
      updatedConversations = [updatedConversation, ...conversations]
    }

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
        isLoading: true,
        currentUserMessageId: newMessage.id,
        activeThinkingStepId: null,
        // A new turn starts a fresh answer bubble — never accumulate onto the
        // previous turn's (already finalized) streaming bubble.
        streamingAssistantMessageId: null,
      },
      false,
      'addUserMessage'
    )

    get()._appendMessage(newMessage)
    return newMessage
  },

  addAgentResponse: (
    content: string,
    showViewReport?: boolean,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    transparency?: AnswerTransparency
  ) => {
    const state = get()
    const { currentConversation, conversations } = state
    if (!currentConversation) return

    const responseMessage = buildAgentResponseMessage(state, uuidv4(), content, {
      showViewReport,
      cards,
      answerConfidence,
      citations,
      transparency,
    })

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: [...currentConversation.messages, responseMessage],
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'addAgentResponse'
    )

    if (!checkStorageHealth().isHealthy) {
      const { currentUserId } = get()
      const cleanedUpIds = ensureStorageCapacity(currentConversation.id, currentUserId)
      if (cleanedUpIds.length > 0) {
        // Cleanup only edits localStorage; prune in-memory state too or the
        // next persist write resurrects every deleted session.
        const deleted = new Set(cleanedUpIds)
        set(
          (state) => ({ conversations: state.conversations.filter((c) => !deleted.has(c.id)) }),
          false,
          'storageCleanupPrune'
        )
      }
    }

    get()._appendMessage(responseMessage)
  },

  appendAgentResponseDelta: (
    content: string,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[]
  ) => {
    const state = get()
    const { currentConversation, conversations, streamingAssistantMessageId } = state
    if (!currentConversation) return

    // First delta of the turn: open a single streaming bubble synchronously so
    // the caret appears immediately. Any meta present (the legacy backend
    // attaches cards to its one and only in_progress frame) is captured here so
    // it survives to the finalize step. Reset the batch buffer so no stale text
    // from a prior turn can bleed into this fresh bubble.
    if (!streamingAssistantMessageId) {
      resetDeltaBuffer()

      const id = uuidv4()
      const message = buildAgentResponseMessage(state, id, content, {
        showViewReport: false,
        cards: cards && cards.length > 0 ? cards : undefined,
        answerConfidence,
        citations,
        isStreaming: true,
      })

      const updatedConversation: Conversation = {
        ...currentConversation,
        messages: [...currentConversation.messages, message],
        updatedAt: new Date(),
      }

      set(
        {
          currentConversation: updatedConversation,
          conversations: updateConversationInList(conversations, updatedConversation),
          streamingAssistantMessageId: id,
        },
        false,
        'appendAgentResponseDelta:create'
      )
      return
    }

    // Subsequent delta: buffer the text (and merge any meta — deltas normally
    // carry none) and flush to the store once per frame. In non-DOM / test
    // envs we flush synchronously so a synchronous read after append still
    // observes the accumulated text.
    pendingDeltaText += content
    if (cards && cards.length > 0) pendingDeltaMeta.cards = cards
    if (answerConfidence) pendingDeltaMeta.answerConfidence = answerConfidence
    if (citations && citations.length > 0) pendingDeltaMeta.citations = citations

    if (canBatchDeltas()) {
      scheduleDeltaFlush()
    } else {
      flushDeltaBuffer()
    }
  },

  finalizeAgentResponse: (
    content: string,
    cards?: GridCard[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    transparency?: AnswerTransparency
  ) => {
    // Flush any batched delta text onto the open bubble first so the terminal
    // frame finalizes over the complete accumulation, then read fresh state.
    flushDeltaBuffer()

    const { currentConversation, conversations, streamingAssistantMessageId } = get()
    if (!currentConversation) return

    // No bubble was ever opened (no delta arrived) — e.g. a complete-only frame
    // that carries the whole answer. Fall back to a one-shot response so there
    // is still exactly one bubble, and skip entirely on the legacy empty
    // synthetic complete when nothing preceded it.
    if (!streamingAssistantMessageId) {
      if ((content && content.trim()) || (cards && cards.length > 0)) {
        get().addAgentResponse(content, false, cards, answerConfidence, citations, transparency)
      }
      return
    }

    const updatedMessages = currentConversation.messages.map((msg) => {
      if (msg.id !== streamingAssistantMessageId) return msg
      return {
        ...msg,
        // Authoritative full text on the terminal frame equals the accumulation
        // (idempotent replace). An EMPTY terminal — the legacy synthetic
        // `complete` frame — must NOT wipe the accumulated bubble.
        content: content && content.length > 0 ? content : msg.content,
        // Cards/sources/confidence ride the terminal frame when streaming; keep
        // whatever the delta already attached when the terminal omits them (the
        // legacy path attaches cards on the in_progress frame).
        ...(cards && cards.length > 0
          ? {
              cards,
              cardInteractions: reconcileCardInteractions(msg.cardInteractions, msg.cards, cards),
            }
          : {}),
        ...(answerConfidence ? { answerConfidence } : {}),
        ...(citations && citations.length > 0 ? { citations } : {}),
        // Transparency extras ride the terminal frame; attach only what's present.
        ...(transparency?.routingDecision ? { routingDecision: transparency.routingDecision } : {}),
        ...(transparency?.routingReason ? { routingReason: transparency.routingReason } : {}),
        ...(transparency?.escalationReason ? { escalationReason: transparency.escalationReason } : {}),
        ...(transparency?.answerConfidenceCappedReason
          ? { answerConfidenceCappedReason: transparency.answerConfidenceCappedReason }
          : {}),
        ...(transparency?.answerConfidenceReason
          ? { answerConfidenceReason: transparency.answerConfidenceReason }
          : {}),
        ...(transparency?.citationsRemoved ? { citationsRemoved: transparency.citationsRemoved } : {}),
        isStreaming: false,
      }
    })

    const finalizedMessage = updatedMessages.find((m) => m.id === streamingAssistantMessageId)

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    set(
      {
        currentConversation: updatedConversation,
        conversations: updateConversationInList(conversations, updatedConversation),
        streamingAssistantMessageId: null,
      },
      false,
      'finalizeAgentResponse'
    )

    // Mirror addAgentResponse's storage-health guard and server persistence,
    // but run them ONCE at finalize rather than per delta.
    if (!checkStorageHealth().isHealthy) {
      const { currentUserId } = get()
      const cleanedUpIds = ensureStorageCapacity(currentConversation.id, currentUserId)
      if (cleanedUpIds.length > 0) {
        const deleted = new Set(cleanedUpIds)
        set(
          (state) => ({ conversations: state.conversations.filter((c) => !deleted.has(c.id)) }),
          false,
          'storageCleanupPrune'
        )
      }
    }

    if (finalizedMessage) {
      get()._appendMessage(finalizedMessage)
      void get()._persistTurnProvenance()
    }
  },

  discardStreamingAssistantMessage: () => {
    // Any batched delta text is destined for the bubble we're about to drop —
    // discard it so a later flush can't resurrect a stray bubble.
    resetDeltaBuffer()

    const { currentConversation, conversations, streamingAssistantMessageId } = get()
    if (!streamingAssistantMessageId) return
    if (!currentConversation) {
      set({ streamingAssistantMessageId: null }, false, 'discardStreamingAssistantMessage')
      return
    }

    const updatedMessages = currentConversation.messages.filter(
      (msg) => msg.id !== streamingAssistantMessageId
    )
    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    set(
      {
        currentConversation: updatedConversation,
        conversations: updateConversationInList(conversations, updatedConversation),
        streamingAssistantMessageId: null,
      },
      false,
      'discardStreamingAssistantMessage'
    )
  },

  addAgentResponseWithMeta: (
    content: string,
    showViewReport: boolean,
    meta: Partial<ChatMessage>,
    cards?: GridCard[]
  ): string => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return ''

    const messageId = uuidv4()
    const responseMessage: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content,
      timestamp: new Date(),
      messageType: 'agent_response',
      showViewReport,
      cards,
      ...meta,
    }

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: [...currentConversation.messages, responseMessage],
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'addAgentResponseWithMeta'
    )

    return messageId
  },

  patchConversationMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<ChatMessage>
  ) => {
    const { currentConversation, conversations } = get()

    const targetConversation = conversations.find((c) => c.id === conversationId)
    if (!targetConversation) return

    const updatedMessages = targetConversation.messages.map((msg) =>
      msg.id === messageId ? { ...msg, ...patch } : msg
    )

    const updatedConversation: Conversation = {
      ...targetConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    const updatedCurrent =
      currentConversation?.id === conversationId ? updatedConversation : currentConversation

    set(
      {
        currentConversation: updatedCurrent,
        conversations: updatedConversations,
      },
      false,
      'patchConversationMessage'
    )
  },

  setCardDecision: (messageId: string, cardKey: string, decision: CardDecision) => {
    const { currentConversation, conversations } = get()

    // A card is rendered from whichever conversation owns its message — usually
    // the current one, but the deep-research report panel can outlive a session
    // switch, so locate the owner rather than assuming.
    const targetConversation =
      currentConversation?.messages.some((m) => m.id === messageId)
        ? currentConversation
        : conversations.find((c) => c.messages.some((m) => m.id === messageId))
    if (!targetConversation) return

    let cardInteractions: CardInteractions | undefined
    const updatedMessages = targetConversation.messages.map((msg) => {
      if (msg.id !== messageId) return msg
      cardInteractions = {
        ...msg.cardInteractions,
        [cardKey]: { decision, decidedAt: new Date().toISOString() },
      }
      return { ...msg, cardInteractions }
    })
    if (!cardInteractions) return

    const updatedConversation: Conversation = {
      ...targetConversation,
      messages: updatedMessages,
      // Deliberately NOT bumping `updatedAt`: answering a card is not new
      // conversation activity and must not reshuffle the session list.
    }

    set(
      {
        conversations: updateConversationInList(conversations, updatedConversation),
        ...(currentConversation?.id === targetConversation.id && {
          currentConversation: updatedConversation,
        }),
      },
      false,
      'setCardDecision'
    )

    void get()._persistCardInteractions(targetConversation.id, messageId, cardInteractions)
  },

  addFileCard: (data: FileCardData) => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const fileMessage: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: data.fileName,
      timestamp: new Date(),
      messageType: 'file',
      fileData: data,
    }

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: [...currentConversation.messages, fileMessage],
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'addFileCard'
    )
  },

  updateFileCard: (messageId: string, data: Partial<FileCardData>) => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const updatedMessages = currentConversation.messages.map((msg) =>
      msg.id === messageId && msg.fileData
        ? {
            ...msg,
            fileData: { ...msg.fileData, ...data },
            content: data.fileName || msg.content,
          }
        : msg
    )

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'updateFileCard'
    )
  },

  addErrorCard: (code: ErrorCode, message?: string, details?: string) => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const errorMeta = getErrorMeta(code)

    const errorMessage: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: message || errorMeta.defaultMessage,
      timestamp: new Date(),
      messageType: 'error',
      errorData: {
        errorCode: code,
        errorMessage: message,
        errorDetails: details,
      },
    }

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: [...currentConversation.messages, errorMessage],
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'addErrorCard'
    )
  },

  dismissErrorCard: (messageId: string) => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const updatedMessages = currentConversation.messages.filter((msg) => msg.id !== messageId)

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'dismissErrorCard'
    )
  },

  dismissConnectionErrors: () => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const updatedMessages = currentConversation.messages.filter(
      (msg) =>
        !(msg.messageType === 'error' && msg.errorData?.errorCode?.startsWith('connection.'))
    )

    if (updatedMessages.length === currentConversation.messages.length) return

    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
      updatedAt: new Date(),
    }

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    set(
      {
        currentConversation: updatedConversation,
        conversations: updatedConversations,
      },
      false,
      'dismissConnectionErrors'
    )
  },

  addDeepResearchBanner: (
    bannerType: DeepResearchBannerType,
    jobId: string,
    conversationId?: string,
    stats?: { totalTokens?: number; toolCallCount?: number },
    escalationReason?: string
  ) => {
    const { currentConversation, conversations } = get()

    const targetConversation = conversationId
      ? conversations.find((c) => c.id === conversationId)
      : currentConversation

    if (!targetConversation) return

    const updatedConversation = withDeepResearchBanner(
      targetConversation,
      bannerType,
      jobId,
      stats,
      escalationReason
    )

    const updatedConversations = updateConversationInList(conversations, updatedConversation)

    const updatedCurrent =
      currentConversation?.id === targetConversation.id
        ? updatedConversation
        : currentConversation

    set(
      {
        currentConversation: updatedCurrent,
        conversations: updatedConversations,
      },
      false,
      'addDeepResearchBanner'
    )
  },

  setProjectId: (projectId: string | null) => {
    const { currentConversation } = get()

    // Cross-project bleed guard (UX-8): entering a project must never keep
    // another project's conversation active — a persisted currentConversation
    // or stale URL would otherwise continue that chat under this project's
    // WebSocket projectId and retrieve against the wrong corpus. Sessions
    // without a projectId are unscoped legacy sessions and stay selectable
    // everywhere (fail-open, see ../lib/project-scope).
    if (
      projectId &&
      currentConversation?.projectId &&
      currentConversation.projectId !== projectId
    ) {
      set(
        {
          projectId,
          currentConversation: null,
          isStreaming: false,
          isLoading: false,
          currentUserMessageId: null,
          thinkingSteps: [],
          activeThinkingStepId: null,
          streamingAssistantMessageId: null,
          reportContent: '',
          reportContentCategory: null,
          currentStatus: null,
          planMessages: [],
          deepResearchCitations: [],
          deepResearchTodos: [],
          deepResearchLLMSteps: [],
          deepResearchAgents: [],
          deepResearchToolCalls: [],
          deepResearchFiles: [],
          deepResearchStreamLoaded: false,
          deepResearchJobId: null,
          deepResearchLastEventId: null,
          isDeepResearchStreaming: false,
          deepResearchStatus: null,
          deepResearchOwnerConversationId: null,
          activeDeepResearchMessageId: null,
          pendingInteraction: null,
        },
        false,
        'setProjectId:clearCrossProjectConversation'
      )
      return
    }

    set({ projectId }, false, 'setProjectId')
  },

  setComposerPrefill: (text: string) => {
    set({ composerPrefill: text }, false, 'setComposerPrefill')
  },

  consumeComposerPrefill: () => {
    const { composerPrefill } = get()
    if (composerPrefill === null) return null
    set({ composerPrefill: null }, false, 'consumeComposerPrefill')
    return composerPrefill
  },

  setChatSendFn: (fn) => {
    set({ chatSendFn: fn }, false, 'setChatSendFn')
  },

  retryLastUserMessage: () => {
    const { currentConversation, chatSendFn, setComposerPrefill } = get()
    const messages = currentConversation?.messages
    if (!messages || messages.length === 0) return
    // The errored answer is the last message; the question to resend is the
    // most recent user turn preceding it.
    const lastUser = [...messages]
      .reverse()
      .find((msg) => msg.messageType === 'user' || msg.role === 'user')
    const text = lastUser?.content?.trim()
    if (!text) return
    // Prefer the live send path (a real resend, new user turn); degrade to
    // prefilling the composer so the question is never silently lost.
    if (chatSendFn) {
      chatSendFn(text)
    } else {
      setComposerPrefill(text)
    }
  },

  insertRemoteMessages: (
    conversationId: string,
    messages: ChatMessage[],
    options?: { replace?: boolean }
  ) => {
    const { conversations, currentConversation } = get()

    // The conversation may live only as `currentConversation` (a fresh session
    // not yet in the list), so look in both places.
    const target =
      conversations.find((c) => c.id === conversationId) ??
      (currentConversation?.id === conversationId ? currentConversation : undefined)
    if (!target) return

    const { messages: merged, added } = mergeRemoteMessages(
      target.messages,
      messages,
      options?.replace ?? false
    )
    // Identity is the signal that nothing arrived: skip the write entirely rather
    // than rebuild the conversation and re-render the whole thread.
    if (merged === target.messages) return

    const updatedConversation: Conversation = {
      ...target,
      messages: merged,
      // A colleague's message IS new activity, so the session list may reorder —
      // but merely resolving an author name on a message already on screen is not,
      // and must not shuffle the sidebar every time a thread is opened.
      ...(added ? { updatedAt: new Date() } : {}),
    }

    set(
      {
        conversations: updateConversationInList(conversations, updatedConversation),
        ...(currentConversation?.id === conversationId && {
          currentConversation: updatedConversation,
        }),
      },
      false,
      'insertRemoteMessages'
    )

    // Deliberately no `_appendMessage` and no turn-state writes: these messages
    // came FROM the server, and the in-flight turn belongs to this client.
  },

  setComposerDraft: (conversationId: string, text: string) => {
    const { composerDrafts } = get()
    const current = composerDrafts[conversationId]

    // An emptied composer should not linger as an empty draft — drop the key so
    // the persisted map stays lean and a blank session reads as "no draft".
    if (text === '') {
      if (current === undefined) return
      const next = { ...composerDrafts }
      delete next[conversationId]
      set({ composerDrafts: next }, false, 'setComposerDraft:clear')
      return
    }

    if (current === text) return
    set(
      { composerDrafts: { ...composerDrafts, [conversationId]: text } },
      false,
      'setComposerDraft'
    )
  },

  getComposerDraft: (conversationId: string) => {
    return get().composerDrafts[conversationId] ?? ''
  },

  clearComposerDraft: (conversationId: string) => {
    const { composerDrafts } = get()
    if (!(conversationId in composerDrafts)) return
    const next = { ...composerDrafts }
    delete next[conversationId]
    set({ composerDrafts: next }, false, 'clearComposerDraft')
  },
  }
}
