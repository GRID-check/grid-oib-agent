import { v4 as uuidv4 } from 'uuid'
import type { StateCreator } from 'zustand'
import type {
  ChatStore,
  ChatMessage,
  ComposerPrefill,
  ComposerSubject,
  ThinkingStep,
  StatusType,
  PromptType,
  FileCardData,
  ErrorCode,
  Conversation,
  CitationSource,
  AnswerTransparency,
  HumanPromptInputType,
  ResumableTurn,
} from '../types'
import type { DraftMention } from '@/features/collaboration/lib/mention-text'
import { turnAnswerId } from '@/lib/conversations/turn-answer-id'
import type { GridCard } from '@/shared/cards/schemas'
import type { CardDecision, CardInteractions } from '@/features/grid-cards/card-decision'
import { reconcileCardInteractions } from '@/features/grid-cards/card-decision'
import { errorConcernsTheThread, getErrorMeta } from '../lib/error-registry'
import { mergeTraceLaneCards, parseTraceLanesBlock } from '../lib/trace-lanes'
import { useLayoutStore } from '@/features/layout/store'
import { ensureStorageCapacity, checkStorageHealth } from '../lib/storage-manager'
import {
  sanitizeFollowUpsStage,
  sanitizeMemoryReflectionStage,
  type MessageStages,
} from '@/lib/conversations/message-stages'
import type { StageId } from '@/adapters/api/schemas'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'

/**
 * One post-answer stage frame, narrowed to what the store acts on
 * (`docs/architecture/post-answer-stages.md` §4.1). The wire envelope's own
 * naming stops at the adapter; the store speaks the store's language.
 */
export interface StageFrame {
  conversationId: string
  /** The WS turn id — the only correlation key both halves share. */
  parentId: string
  stage: StageId
  status: 'ready' | 'empty' | 'failed'
  payload?: unknown
}

/**
 * Stages whose output is appended BELOW the answer, as its own block in the
 * thread column — and which therefore may only land where they cannot push
 * something the reader has already read (§8).
 *
 * `memory_reflection` is deliberately not one of them. Its chip goes INSIDE the
 * answer's footer meta row, which is rendered and reserved at `min-h-6` before
 * the stage even starts, so nothing below the answer moves when it arrives.
 * Holding it to §8's conditions would also make it lose to its own schedule:
 * reflection is scheduled BEFORE the answer's deltas are yielded, so on a long
 * answer its frame genuinely can arrive mid-stream, and „the reader started
 * typing" would suppress the only notice that something was written to their
 * project's durable memory. A suggestion may be withheld; a record of a write
 * may not.
 */
const STAGES_THAT_GROW_THE_THREAD: ReadonlySet<StageId> = new Set(['follow_ups'])

/**
 * The payload of one stage, reduced to what may be stored, or null when nothing
 * survives.
 *
 * One entry per stage this client renders, exhaustive over `StageId` so a stage
 * added to the wire schema without a renderer fails `tsc` here rather than
 * arriving at runtime and being silently ignored.
 */
const STAGE_SANITISERS: {
  [K in StageId]: (payload: unknown) => MessageStages[keyof MessageStages] | null
} = {
  follow_ups: sanitizeFollowUpsStage,
  memory_reflection: sanitizeMemoryReflectionStage,
}

/** Which `MessageStages` key each stage's payload is stored under. */
const STAGE_KEYS: { [K in StageId]: keyof MessageStages } = {
  follow_ups: 'followUps',
  memory_reflection: 'memoryReflection',
}

export type MessagesSlice = {
  isStreaming: boolean
  isLoading: boolean
  currentUserMessageId: string | null
  /**
   * The WS turn id (`parent_id`) of the turn in flight
   * (`docs/architecture/post-answer-stages.md` §1.6).
   *
   * The twin of `currentUserMessageId` in the OTHER id space: that one names
   * the row the browser owns, this one names the turn the agent tier owns. The
   * answer bubble is stamped with it as it is built, so a post-answer stage
   * frame — which knows only the turn — can find the message it belongs to.
   *
   * Set from the turn's own frames rather than at send time, so it can only
   * ever hold an id the backend has actually used.
   */
  currentTurnWsParentId: string | null
  thinkingSteps: ThinkingStep[]
  activeThinkingStepId: string | null
  streamingAssistantMessageId: string | null
  currentStatus: StatusType | null
  projectId: string | null
  /**
   * One-shot draft text destined for the chat composer (InputArea). Set by
   * deep links (`?ask=`) and welcome-screen suggestion chips; consumed exactly
   * once by the composer, which populates + focuses the textarea and clears
   * this flag. Store-backed because the composer draft itself lives in
   * component-local state with no cross-component setter.
   */
  composerPrefill: ComposerPrefill | null
  /**
   * What this draft is asking about. The composer bar is the commitment:
   * hide() of the peek keeps this so the user can still see (and dismiss)
   * the file they are asking about. close() or the bar's X clears it.
   */
  composerSubject: ComposerSubject | null
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
  updateThinkingStepByFunctionName: (
    functionName: string,
    content: string,
    isComplete: boolean
  ) => void
  findThinkingStepByFunctionName: (functionName: string) => ThinkingStep | undefined
  clearThinkingSteps: () => void
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
    cards?: (GridCard | undefined)[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    transparency?: AnswerTransparency
  ) => void
  appendAgentResponseDelta: (
    content: string,
    cards?: (GridCard | undefined)[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    answerMeta?: AnswerMeta
  ) => void
  /**
   * Replace the streaming bubble's text with a settled snapshot (ADR-0066):
   * the prose so far with its `[N]` markers verified and renumbered, the
   * sources they now point at, and the masthead re-gated against the prose.
   * The bubble keeps streaming; the terminal frame still finalizes it.
   */
  replaceStreamingAgentResponse: (
    content: string,
    citations?: CitationSource[],
    answerMeta?: AnswerMeta
  ) => void
  finalizeAgentResponse: (
    content: string,
    cards?: (GridCard | undefined)[],
    answerConfidence?: 'low' | 'medium' | 'high',
    citations?: CitationSource[],
    transparency?: AnswerTransparency
  ) => void
  /**
   * Record which WS turn the answer being built belongs to. Idempotent within a
   * turn — every frame of a turn carries the same `parent_id`.
   */
  setTurnWsParentId: (wsParentId: string) => void
  /** See `ChatActions.markTurnWsParentId`. */
  markTurnWsParentId: (userMessageId: string, wsParentId: string) => void
  /** See `ChatActions.resumeTurn`. */
  resumeTurn: (conversationId: string) => ResumableTurn | null
  /**
   * Apply a post-answer stage frame to the turn it addresses
   * (`docs/architecture/post-answer-stages.md` §4.3, §8).
   *
   * Returns the id of the message it landed on when something was stored, so
   * the caller can mirror it to the server; null when the frame was declined —
   * which is the common case and never an error.
   */
  applyStageFrame: (frame: StageFrame) => string | null
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
    meta: Partial<ChatMessage>,
    cards?: (GridCard | undefined)[]
  ) => string
  /**
   * Put a run's own message into the open thread, exactly as the server wrote
   * it (ADR-0062).
   *
   * Its id is the SERVER's, not a fresh one: the run's message already exists —
   * the BFF minted it when the run was commissioned — so this adopts a row
   * rather than creating one, and a second copy with a local id would be a
   * second block for one run. Idempotent by that id: a reload that raced this
   * changes nothing.
   */
  adoptRunMessage: (message: ChatMessage) => void
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
  setProjectId: (projectId: string | null) => void
  /** Queue text for the composer to pick up (does NOT auto-send). */
  setComposerPrefill: (text: string, mentions?: DraftMention[], subject?: ComposerSubject) => void
  setComposerSubject: (subject: ComposerSubject | null) => void
  /** Read and clear the queued composer prefill; returns null when empty. */
  consumeComposerPrefill: () => ComposerPrefill | null
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
  if (remote.authorName && remote.authorName !== local.authorName)
    patch.authorName = remote.authorName
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
  const newestRemoteTime = remote.reduce(
    (newest, message) => Math.max(newest, messageTime(message)),
    0
  )
  const keptLocalOnly =
    replace && remote.length > 0
      ? localOnly.filter(
          (message) => message.isStreaming || messageTime(message) >= newestRemoteTime
        )
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
const withCompletedPayload = (
  step: ThinkingStep,
  content: string,
  isComplete: boolean
): ThinkingStep => {
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

/**
 * How often buffered answer deltas reach the store while an answer streams.
 * Each flush re-renders everything subscribed to the open conversation; once
 * per animation frame, that was a 50–70 ms task every few frames on a 4×
 * throttled CPU. What the reader sees is paced separately (`usePacedText`),
 * so the flush can be this coarse without the text arriving in steps.
 */
export const DELTA_FLUSH_MS = 100

export const initialMessagesState = {
  isStreaming: false,
  isLoading: false,
  currentUserMessageId: null as string | null,
  currentTurnWsParentId: null as string | null,
  thinkingSteps: [] as ThinkingStep[],
  activeThinkingStepId: null as string | null,
  streamingAssistantMessageId: null as string | null,
  currentStatus: null as StatusType | null,
  projectId: null as string | null,
  composerPrefill: null as ComposerPrefill | null,
  composerSubject: null,
  composerDrafts: {} as Record<string, string>,
  chatSendFn: null as ((content: string) => void) | null,
}

/**
 * Build an `agent_response` ChatMessage from what the store carries at emit
 * time. Shared by
 * `addAgentResponse` (one-shot bubble) and `appendAgentResponseDelta` (first
 * delta of a streamed answer) so a finalized streamed bubble is byte-identical
 * to today's single-shot response for the same store state — this is what
 * preserves backward compatibility.
 */
/**
 * The id this turn's answer is created under: the one the backend would persist
 * it under, once the turn's WS id is known (see `turnAnswerId`), so an answer
 * written by both tiers is one row. A fresh uuid before that.
 */
const answerIdFor = (state: ChatStore): string =>
  state.currentConversation && state.currentTurnWsParentId
    ? turnAnswerId(state.currentConversation.id, state.currentTurnWsParentId)
    : uuidv4()

const buildAgentResponseMessage = (
  state: ChatStore,
  id: string,
  content: string,
  opts: {
    cards?: (GridCard | undefined)[]
    answerConfidence?: 'low' | 'medium' | 'high'
    citations?: CitationSource[]
    isStreaming?: boolean
    transparency?: AnswerTransparency
  }
): ChatMessage => {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: new Date(),
    messageType: 'agent_response',
    cards: opts.cards,
    answerConfidence: opts.answerConfidence,
    citations: opts.citations && opts.citations.length > 0 ? opts.citations : undefined,
    ...(opts.isStreaming ? { isStreaming: true } : {}),
    // Which WS turn this answer belongs to, so a stage frame that arrives
    // seconds later can find it. Stamped as the bubble is built rather than
    // patched on afterwards: the turn key is known before the first delta, and
    // a message that exists for even one frame without it is a message a frame
    // could miss.
    ...(state.currentTurnWsParentId ? { wsParentId: state.currentTurnWsParentId } : {}),

    // Transparency extras (WP-A). Spread only the fields that are present so a
    // turn without them stays byte-identical to the pre-transparency message.
    ...(opts.transparency?.routingDecision
      ? { routingDecision: opts.transparency.routingDecision }
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
    // Retrieved-but-uncited documents for the "Gelesen, nicht zitiert"
    // disclosure. Absent when everything retrieved was cited.
    ...(opts.transparency?.readSources && opts.transparency.readSources.length > 0
      ? { readSources: opts.transparency.readSources }
      : {}),
    ...(opts.transparency?.researchTruncated ? { researchTruncated: true as const } : {}),
    // The answer's structured anatomy — already sanitized at the wire boundary.
    ...(opts.transparency?.answerMeta ? { answerMeta: opts.transparency.answerMeta } : {}),
    // The backend's account of this turn's retrieval rounds — already
    // sanitized at the wire boundary (which guarantees a non-empty array or
    // nothing). Spread like every other extra so a turn without one stays
    // byte-identical to a pre-ledger message.
    ...(opts.transparency?.retrievalLedger
      ? { retrievalLedger: opts.transparency.retrievalLedger }
      : {}),
    // The CAUSE and the degradations ride alongside the flag, and are copied
    // independently of it: a run can be degraded without being truncated, and
    // gating them on the flag drops exactly the case the reader most needs.
    // Without these two lines the props ChatArea passes are always undefined,
    // so the live turn says THAT research stopped and never why.
    ...(opts.transparency?.truncationReason
      ? { truncationReason: opts.transparency.truncationReason }
      : {}),
    ...(opts.transparency?.degradedReasons?.length
      ? { degradedReasons: opts.transparency.degradedReasons }
      : {}),
    ...(opts.transparency?.skillsHidden && opts.transparency.skillsHidden.length > 0
      ? { skillsHidden: opts.transparency.skillsHidden }
      : {}),
    ...(opts.transparency?.skillsActivated && opts.transparency.skillsActivated.length > 0
      ? { skillsActivated: opts.transparency.skillsActivated }
      : {}),
  }
}

export const createMessagesSlice: StateCreator<
  ChatStore,
  [['zustand/devtools', never]],
  [],
  MessagesSlice
> = (set, get) => {
  // --- Streamed-delta batching ------------------------------------------------
  // Rather than rebuilding the whole conversation object on every token (one
  // set() per delta), subsequent answer deltas accumulate in this buffer and
  // flush to the store every `DELTA_FLUSH_MS`. Every flush re-renders what
  // subscribes to the conversation, so it is coarse on purpose: the reader
  // does not see the flush cadence, because the answer paces its own reveal
  // (`usePacedText`). In non-DOM / test envs we flush synchronously so
  // `append` then a synchronous read still observes the text.
  let pendingDeltaText = ''
  let pendingDeltaMeta: {
    cards?: (GridCard | undefined)[]
    answerConfidence?: 'low' | 'medium' | 'high'
    citations?: CitationSource[]
    answerMeta?: AnswerMeta
  } = {}
  // Whether the open bubble's cards or masthead came from a LIVE frame
  // (ADR-0066) rather than the legacy single in_progress frame. Live ones are
  // provisional: a terminal that carries none (the cards were suppressed, the
  // masthead gated out) takes them away again.
  let liveMetaShown = false
  /**
   * Is this in_progress frame one of the live frames that carry only what sits
   * around the prose (the masthead ahead of it, the cards after it)? Those are
   * written with no text of their own (`live_chunk("", …)` in
   * `aiq_agent/turn/streaming.py`). A frame that carries text as well is the
   * legacy shape, whose cards are final and must survive a terminal that omits
   * them.
   */
  const isLiveExtrasFrame = (
    content: string,
    cards: (GridCard | undefined)[] | undefined,
    answerMeta: AnswerMeta | undefined
  ): boolean => !content && (Boolean(answerMeta) || (cards?.length ?? 0) > 0)
  let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null

  const canBatchDeltas = (): boolean =>
    typeof window !== 'undefined' &&
    // Keep tests deterministic: they append then read synchronously, so never
    // defer under vitest (NODE_ENV is statically 'production'/'development' in
    // the browser bundle, so this branch tree-shakes out there).
    process.env.NODE_ENV !== 'test'

  const cancelScheduledFlush = (): void => {
    if (deltaFlushTimer !== null) {
      clearTimeout(deltaFlushTimer)
      deltaFlushTimer = null
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
      !!meta.answerMeta ||
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
            ...(meta.answerMeta ? { answerMeta: meta.answerMeta } : {}),
          }
        : msg
    )

    // No `updatedAt` bump: the turn's start already set it and its settle sets
    // it again. Stamping every flush made the conversation's sidebar row a new
    // row ten times a second, re-sorting and re-rendering the whole list with it.
    const updatedConversation: Conversation = {
      ...currentConversation,
      messages: updatedMessages,
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
    if (deltaFlushTimer !== null) return
    deltaFlushTimer = setTimeout(() => {
      deltaFlushTimer = null
      flushDeltaBuffer()
    }, DELTA_FLUSH_MS)
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
        (step) => step.functionName === functionName && step.userMessageId === currentUserMessageId
      )
    },

    clearThinkingSteps: () => {
      set({ thinkingSteps: [], activeThinkingStepId: null }, false, 'clearThinkingSteps')
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
      const { currentConversation, conversations } = get()
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

      // Persist it (ADR-0037). Without this the card lived only in the browser whose
      // socket received the frame: an observer's server-authoritative load showed no
      // card at all and the thread appeared to stop mid-question, and the asker's own
      // reload lost it too.
      void get()._appendMessage(promptMessage)
    },

    respondToPrompt: (messageId: string, response: string) => {
      const { currentConversation, conversations } = get()
      if (!currentConversation) return

      const updatedMessages = currentConversation.messages.map((msg) =>
        msg.id === messageId ? { ...msg, promptResponse: response, isPromptResponded: true } : msg
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

      // The transcript should say what was DECIDED, not only that something was asked.
      void get()._persistPromptState(messageId, response)
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
          // A new turn is a new WS turn id; the old one must not leak onto the
          // next answer, or a late stage frame from the previous turn would find
          // two messages claiming to be its target.
          currentTurnWsParentId: null,
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
      cards?: (GridCard | undefined)[],
      answerConfidence?: 'low' | 'medium' | 'high',
      citations?: CitationSource[],
      transparency?: AnswerTransparency
    ) => {
      const state = get()
      const { currentConversation, conversations } = state
      if (!currentConversation) return

      const responseMessage = buildAgentResponseMessage(state, answerIdFor(state), content, {
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
      cards?: (GridCard | undefined)[],
      answerConfidence?: 'low' | 'medium' | 'high',
      citations?: CitationSource[],
      answerMeta?: AnswerMeta
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
        // Whitespace is text only BETWEEN words: a paragraph break the relay
        // batched into a frame of its own keeps two paragraphs apart once the
        // bubble is open, but as the turn's first frame it would open a bubble
        // with nothing to draw, which takes the typing placeholder down and
        // leaves the reader a blank until the first word. Mirrored by the
        // observer's fold (spectator-frames.ts).
        const nothingToDraw =
          !content.trim() &&
          !(cards && cards.length > 0) &&
          !(citations && citations.length > 0) &&
          !answerMeta
        if (nothingToDraw) return
        resetDeltaBuffer()
        liveMetaShown = isLiveExtrasFrame(content, cards, answerMeta)

        const id = answerIdFor(state)
        const message = buildAgentResponseMessage(state, id, content, {
          cards: cards && cards.length > 0 ? cards : undefined,
          answerConfidence,
          citations,
          isStreaming: true,
          // The masthead can open the bubble: it is written before the prose.
          transparency: answerMeta ? { answerMeta } : undefined,
        })

        // No `updatedAt` bump: the send set it and the settle sets it again.
        // A bump here made the opening a full write of the persisted history
        // (1.97 MB and a 330 ms freeze with 40 conversations on a 4× throttled
        // phone, the moment the first words appeared); the snapshot, the
        // steps and the deltas leave it alone for the same reason.
        const updatedConversation: Conversation = {
          ...currentConversation,
          messages: [...currentConversation.messages, message],
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
      if (answerMeta) pendingDeltaMeta.answerMeta = answerMeta
      if (isLiveExtrasFrame(content, cards, answerMeta)) liveMetaShown = true

      if (canBatchDeltas()) {
        scheduleDeltaFlush()
      } else {
        flushDeltaBuffer()
      }
    },

    // Mirrored by the observer's fold (collaboration/lib/spectator-frames.ts): change both.
    replaceStreamingAgentResponse: (
      content: string,
      citations?: CitationSource[],
      answerMeta?: AnswerMeta
    ) => {
      if (!get().currentConversation) return
      // An empty snapshot naming no sources is the backend retracting a
      // streamed round (AnswerStreamSink.retract).
      const retraction = content === '' && !(citations && citations.length > 0)
      // No bubble yet (a turn whose first live frame is the snapshot): open it,
      // unless it is a retraction, which has nothing on screen to take back.
      if (!get().streamingAssistantMessageId) {
        if (retraction) return
        get().appendAgentResponseDelta(content, undefined, undefined, citations, answerMeta)
        // A snapshot is a live frame whatever text it carries: its masthead is
        // as provisional as one that came ahead of the prose.
        if (answerMeta) liveMetaShown = true
        return
      }
      // Buffered delta text is part of what the snapshot replaces: the backend
      // sends it only after every delta it settles. Buffered meta is not: live
      // cards or confidence that arrived in the same frame land first.
      pendingDeltaText = ''
      flushDeltaBuffer()
      const { currentConversation, conversations, streamingAssistantMessageId } = get()
      if (!currentConversation || !streamingAssistantMessageId) return
      if (answerMeta) liveMetaShown = true
      // A retraction's cards go with its text, and the decisions keyed by
      // their positions with them: otherwise the next round's [[card:0]]
      // draws the dead round's card.
      const updatedConversation: Conversation = {
        ...currentConversation,
        messages: currentConversation.messages.map((msg) =>
          msg.id === streamingAssistantMessageId
            ? {
                ...msg,
                ...(retraction ? { cards: undefined, cardInteractions: undefined } : {}),
                content,
                // A snapshot names the sources its text cites, all of them: an
                // empty one (a streamed round retracted) cites nothing.
                citations: citations && citations.length > 0 ? citations : undefined,
                // The backend re-gates the masthead against the snapshot's
                // prose, so a snapshot without one has gated it out: the
                // masthead on screen goes, as the spectator's does.
                answerMeta,
              }
            : msg
        ),
      }
      set(
        {
          currentConversation: updatedConversation,
          conversations: updateConversationInList(conversations, updatedConversation),
        },
        false,
        'replaceStreamingAgentResponse'
      )
    },

    finalizeAgentResponse: (
      content: string,
      cards?: (GridCard | undefined)[],
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
          get().addAgentResponse(content, cards, answerConfidence, citations, transparency)
        }
        return
      }

      // A terminal with the full text is authoritative for what the live
      // frames showed ahead of it, absence included.
      // Blank is not text: the spectator's fold uses the same test.
      const authoritative = Boolean(content && content.trim())
      const retractLive = liveMetaShown && authoritative
      liveMetaShown = false
      const updatedMessages = currentConversation.messages.map((msg) => {
        if (msg.id !== streamingAssistantMessageId) return msg
        return {
          ...msg,
          // The decisions are keyed by card position: they go with the cards
          // (a terminal that re-sends cards reconciles them below instead).
          ...(retractLive
            ? { cards: undefined, cardInteractions: undefined, answerMeta: undefined }
            : {}),
          // Authoritative full text on the terminal frame equals the accumulation
          // (idempotent replace). An EMPTY terminal — the legacy synthetic
          // `complete` frame — must NOT wipe the accumulated bubble.
          content: authoritative ? content : msg.content,
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
          // The citations are numbered against the text, so they go with it:
          // a terminal with text and no sources cites nothing verified, and
          // the snapshot's chips must not outlive the prose they belonged to.
          // An empty terminal keeps them with the text it keeps.
          ...(citations && citations.length > 0
            ? { citations }
            : authoritative
              ? { citations: undefined }
              : {}),
          // Transparency extras ride the terminal frame; attach only what's present.
          ...(transparency?.routingDecision
            ? { routingDecision: transparency.routingDecision }
            : {}),
          ...(transparency?.escalationReason
            ? { escalationReason: transparency.escalationReason }
            : {}),
          ...(transparency?.answerConfidenceCappedReason
            ? { answerConfidenceCappedReason: transparency.answerConfidenceCappedReason }
            : {}),
          ...(transparency?.answerConfidenceReason
            ? { answerConfidenceReason: transparency.answerConfidenceReason }
            : {}),
          ...(transparency?.citationsRemoved
            ? { citationsRemoved: transparency.citationsRemoved }
            : {}),
          ...(transparency?.readSources && transparency.readSources.length > 0
            ? { readSources: transparency.readSources }
            : {}),
          ...(transparency?.researchTruncated ? { researchTruncated: true as const } : {}),
          ...(transparency?.answerMeta ? { answerMeta: transparency.answerMeta } : {}),
          ...(transparency?.truncationReason
            ? { truncationReason: transparency.truncationReason }
            : {}),
          ...(transparency?.degradedReasons?.length
            ? { degradedReasons: transparency.degradedReasons }
            : {}),
          ...(transparency?.skillsHidden && transparency.skillsHidden.length > 0
            ? { skillsHidden: transparency.skillsHidden }
            : {}),
          ...(transparency?.skillsActivated && transparency.skillsActivated.length > 0
            ? { skillsActivated: transparency.skillsActivated }
            : {}),
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

    setTurnWsParentId: (wsParentId: string) => {
      if (!wsParentId) return
      if (get().currentTurnWsParentId === wsParentId) return
      set({ currentTurnWsParentId: wsParentId }, false, 'setTurnWsParentId')
    },

    markTurnWsParentId: (userMessageId: string, wsParentId: string) => {
      const { currentConversation, conversations } = get()
      if (!currentConversation || !wsParentId) return
      const index = currentConversation.messages.findIndex((m) => m.id === userMessageId)
      if (index < 0 || currentConversation.messages[index]?.wsParentId === wsParentId) return
      const messages = [...currentConversation.messages]
      messages[index] = { ...messages[index]!, wsParentId }
      // No `updatedAt` bump: a local handle on the turn, not something said.
      const updatedConversation: Conversation = { ...currentConversation, messages }
      set(
        {
          currentConversation: updatedConversation,
          conversations: updateConversationInList(conversations, updatedConversation),
        },
        false,
        'markTurnWsParentId'
      )
    },

    resumeTurn: (conversationId: string) => {
      const {
        resumableTurn: turn,
        currentConversation,
        conversations,
        thinkingSteps,
        isStreaming,
      } = get()
      if (!turn || turn.conversationId !== conversationId) return null
      // Something newer owns the conversation: a question sent since, or a
      // turn already streaming. The reload's turn is not the current one.
      const last = currentConversation?.messages.findLast((m) => m.messageType === 'user')
      if (isStreaming || !currentConversation || last?.id !== turn.userMessageId) {
        set({ resumableTurn: null }, false, 'resumeTurn:stale')
        return null
      }
      const messages = currentConversation.messages.map((m) =>
        m.id === turn.userMessageId && m.thinkingSteps ? { ...m, thinkingSteps: undefined } : m
      )
      const updatedConversation: Conversation = { ...currentConversation, messages }
      set(
        {
          resumableTurn: null,
          currentUserMessageId: turn.userMessageId,
          currentTurnWsParentId: turn.wsParentId,
          streamingAssistantMessageId: null,
          thinkingSteps: thinkingSteps.filter((s) => s.userMessageId !== turn.userMessageId),
          activeThinkingStepId: null,
          isStreaming: true,
          isLoading: true,
          currentConversation: updatedConversation,
          conversations: updateConversationInList(conversations, updatedConversation),
        },
        false,
        'resumeTurn'
      )
      return turn
    },

    applyStageFrame: (frame: StageFrame): string | null => {
      const { currentConversation, conversations, composerDrafts } = get()
      // A frame for a conversation this tab is not looking at is not this tab's
      // business: the answer it addresses is not on screen and the store that
      // owns it is not this one.
      if (!currentConversation || currentConversation.id !== frame.conversationId) return null

      // `empty` and `failed` are rendered identically — as nothing. There is no
      // space to release, because none was ever reserved (§8), and nothing to
      // persist, because "the stage produced nothing" is not a fact about the
      // answer worth storing.
      if (frame.status !== 'ready') return null

      // Each stage's payload is validated by its OWN contract before anything is
      // rendered or stored; the envelope schema deliberately keeps `payload`
      // unknown, because one schema that knew every stage's shape would have to
      // be edited by every future stage.
      const payload = STAGE_SANITISERS[frame.stage](frame.payload)
      // A payload its own contract rejects is dropped whole rather than rendered
      // in part: half a set of chips is a worse offer than none.
      if (!payload) return null

      const messages = currentConversation.messages
      const index = messages.findIndex(
        (message) => message.role === 'assistant' && message.wsParentId === frame.parentId
      )
      // §4.1: a frame whose `parent_id` matches no message is dropped SILENTLY.
      // It is the expected outcome for a tab that reloaded, or one that never
      // asked this turn.
      if (index === -1) return null

      const target = messages[index]
      const key = STAGE_KEYS[frame.stage]

      // Mirrored to the server row BEFORE the render gate below, so what the
      // stage produced survives a reload, a colleague's view and another device
      // even when this tab refuses to show it: the refusals guard the reader's
      // scroll position, not the record. Same best-effort mirror the provenance
      // and the card decisions already use.
      //
      // For `memory_reflection` this mirror is what makes the frame safe to be
      // the ONLY notice: the row it describes exists in `project_memory` either
      // way, but the fact that THIS turn wrote it lives nowhere else, so a reload
      // before this PATCH lands is the one case where the chip does not come back.
      void get()._persistStageOutput(target.id, { [key]: payload })

      if (STAGES_THAT_GROW_THE_THREAD.has(frame.stage)) {
        // The three conditions that make "reserve nothing, append below, never
        // reflow" safe (§8). Each is checked HERE, at arrival, rather than at
        // render: a rail that is admitted and then hidden is a rail that pops in
        // later, which is the defect being avoided.
        //
        // 1. Nothing may sit below the answer. The claim that a late rail moves
        //    nothing already read holds only while the rail is the LAST thing in
        //    the thread — a rail growing under message five pushes six, seven and
        //    the reader's own question down the page.
        if (index !== messages.length - 1) return null
        // 2. The answer must be finished. Growing the column under text that is
        //    still being written moves it mid-read.
        if (target.isStreaming) return null
        // 3. The reader must not have started typing. Offering four questions to
        //    someone who is writing their own replaces their intention with a
        //    suggestion.
        if ((composerDrafts[currentConversation.id] ?? '').trim().length > 0) return null
      }

      const updatedMessages = messages.map((message) =>
        message.id === target.id
          ? { ...message, stages: { ...message.stages, [key]: payload } }
          : message
      )

      // No `updatedAt` bump, unlike every other message mutation: a stage
      // arriving is not the thread being worked on, and re-sorting the session
      // list under the reader for a set of suggestion chips would be a bigger
      // movement than the one §8 goes to such lengths to avoid.
      const updatedConversation: Conversation = {
        ...currentConversation,
        messages: updatedMessages,
      }

      set(
        {
          currentConversation: updatedConversation,
          conversations: updateConversationInList(conversations, updatedConversation),
        },
        false,
        'applyStageFrame'
      )

      return target.id
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
      meta: Partial<ChatMessage>,
      cards?: (GridCard | undefined)[]
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

    adoptRunMessage: (message: ChatMessage) => {
      const { currentConversation, conversations } = get()
      if (!currentConversation) return
      if (currentConversation.messages.some((existing) => existing.id === message.id)) return

      const updatedConversation: Conversation = {
        ...currentConversation,
        messages: [...currentConversation.messages, message],
        updatedAt: new Date(),
      }

      set(
        {
          currentConversation: updatedConversation,
          conversations: updateConversationInList(conversations, updatedConversation),
        },
        false,
        'adoptRunMessage'
      )
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
      const targetConversation = currentConversation?.messages.some((m) => m.id === messageId)
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

      // A failed turn is part of the thread's history (ADR-0037). Without this an
      // observer in a shared conversation sees a thread that simply stops, with no way
      // to tell "still working" from "gave up" once the turn banner ages out.
      //
      // Only errors that concern the CONVERSATION: a dropped socket or an expired
      // token describes this browser's session, and publishing it would tell a
      // colleague their connection failed when it did not.
      if (errorConcernsTheThread(code)) {
        void get()._appendMessage(errorMessage)
      }
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
            currentStatus: null,
            pendingInteraction: null,
          },
          false,
          'setProjectId:clearCrossProjectConversation'
        )
        return
      }

      set({ projectId }, false, 'setProjectId')
    },

    setComposerPrefill: (text: string, mentions?: DraftMention[], subject?: ComposerSubject) => {
      const prefill: ComposerPrefill =
        mentions && mentions.length > 0 ? { text, mentions, subject } : { text, subject }
      set(
        {
          composerPrefill: prefill,
          ...(subject !== undefined ? { composerSubject: subject ?? null } : {}),
        },
        false,
        'setComposerPrefill'
      )
    },

    setComposerSubject: (subject: ComposerSubject | null) => {
      // Peek-bound callers (openFilePeek) pair this with hide/close of the
      // preview: if you set a subject because a peek is showing, hide/close
      // of that peek must pass null. Ask-Piloti subjects are user intent and
      // are cleared only by the subject bar or a new session.
      set({ composerSubject: subject }, false, 'setComposerSubject')
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
