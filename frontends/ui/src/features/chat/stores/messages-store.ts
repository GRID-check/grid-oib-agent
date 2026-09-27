import { v4 as uuidv4 } from 'uuid'
import type { StateCreator } from 'zustand'
import type {
  ChatStore,
  ChatMessage,
  ComposerPrefill,
  ComposerSubject,
  ErrorCode,
  Conversation,
  PendingInteraction,
} from '../types'
import type { DraftMention } from '@/features/collaboration/lib/mention-text'
import type { WireEvent } from '@/adapters/api/wire-v2'
import { deferChatStorageWrites } from './chat-storage'
import type { CardDecision, CardInteractions } from '@/features/grid-cards/card-decision'
import { errorConcernsTheThread, getErrorMeta } from '../lib/error-registry'
import { foldTurnEvents, initialTurnView, type TurnView } from '../lib/turn-fold'
import { projectTurn } from '../lib/turn-projection'
import { useLayoutStore } from '@/features/layout/store'

export type MessagesSlice = {
  isStreaming: boolean
  isLoading: boolean
  currentUserMessageId: string | null
  /**
   * When this browser sent the current turn's question (epoch ms), so the
   * answer can carry how long it took. This browser's clock at both ends:
   * the user message's own timestamp is replaced by the server's, and the
   * difference between two clocks is not a duration.
   */
  currentTurnStartedAt: number | null
  /**
   * Every turn this tab is folding, by turn id (the question's id): the ONE
   * reading of the wire (`foldTurnEvent`, docs/design/chat-wire-v2.md §e.3).
   * The messages are its projection. A finished turn stays while its stages
   * may still arrive; never persisted.
   */
  turns: Record<string, TurnView>
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
   * in-progress, unsent text. It survives session switches and reloads in the
   * chat store's localStorage index (`stores/chat-storage.ts`), the part of
   * storage that is never evicted, and is cleared only on successful send or
   * when its session is deleted.
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

  /**
   * Fold events into their turns and draw each changed turn into its
   * conversation, in one `set()`. The terminal's result settles the answer:
   * its storage write waits a task (`deferChatStorageWrites`), and the answer
   * and the turn's provenance are mirrored to the server.
   */
  applyTurnEvents: (events: readonly WireEvent[]) => void
  /**
   * Start folding a turn: a question just sent, or one a reload interrupted
   * and the socket is about to `attach` from its first event.
   */
  beginTurn: (conversationId: string, turnId: string) => void
  /**
   * Forget a turn this tab cannot continue (the stream no longer holds it),
   * taking its unfinished answer with it: a fragment with a caret is worse
   * than the server's finished answer or the banner that follows.
   */
  dropTurn: (turnId: string) => void
  /**
   * Stop the open conversation's running turn: `cancel_turn` goes to the
   * server (the handler the socket hook registers), and the answer so far
   * stays on screen, marked stopped. The server's `RUN_FINISHED` (outcome
   * `cancelled`) then settles and persists it.
   */
  stopStreaming: () => void
  respondToPrompt: (messageId: string, response: string) => void
  addUserMessage: (
    content: string,
    metadata?: {
      enabledDataSources?: string[]
      messageFiles?: Array<{ id: string; fileName: string }>
    }
  ) => ChatMessage
  /**
   * Put a run's own message into the open thread, exactly as the server wrote
   * it (ADR-0062).
   *
   * Its id is the SERVER's, not a fresh one: the run's message already exists —
   * the BFF minted it when the run was commissioned — so this adopts a row
   * rather than creating one, and a second copy with a local id would be a
   * second block for one run. Idempotent by that id: a reload that raced this
   * changes nothing.
   *
   * Into `conversationId`, the thread that commissioned the run: the fetch is
   * async, and the reader may have opened another thread by the time it lands.
   */
  adoptRunMessage: (conversationId: string, message: ChatMessage) => void
  patchConversationMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<ChatMessage>
  ) => void
  setCardDecision: (messageId: string, cardKey: string, decision: CardDecision) => void
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
   *   2. **No turn state is touched.** `turns`, `isStreaming`, `isLoading` and
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
 * Sends `cancel_turn` for a turn. Registered by `use-websocket-chat`, which
 * owns the socket, so `stopStreaming` reaches it without importing the hook.
 */
let stopTurnHandler: ((turnId: string) => void) | null = null

/** Register (or clear, with `null`) the socket's `cancel_turn` sender. */
export const registerStopStreamingHandler = (fn: ((turnId: string) => void) | null): void => {
  stopTurnHandler = fn
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
export const mergeRemoteMessages = (
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

const createNewConversation = (userId: string): Conversation => ({
  id: `s_${uuidv4().replace(/-/g, '_')}`,
  userId,
  title: '',
  messages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
})

/** The open conversation's running turn: at most one, because a turn locks the composer. */
export const runningTurnIn = (
  turns: Record<string, TurnView>,
  conversationId: string | undefined
): TurnView | undefined =>
  conversationId
    ? Object.values(turns).find((view) => view.conversationId === conversationId && view.phase === 'running')
    : undefined

/**
 * The turn state the composer and the thread read, derived from the views:
 * streaming while the turn runs and asks nothing, loading until the server
 * acknowledged the question (`RUN_STARTED`), and the open question.
 */
export const turnStateFor = (
  turns: Record<string, TurnView>,
  conversationId: string | undefined
): { isStreaming: boolean; isLoading: boolean; pendingInteraction: PendingInteraction | null } => {
  const view = runningTurnIn(turns, conversationId)
  const request = view?.interaction
  return {
    isStreaming: Boolean(view && !request),
    isLoading: view?.lastSeq === 0,
    pendingInteraction: view && request
      ? { turnId: view.turnId, interactionId: request.interaction_id, input: request.input }
      : null,
  }
}

const groupByTurn = (events: readonly WireEvent[]): Map<string, WireEvent[]> => {
  const byTurn = new Map<string, WireEvent[]>()
  for (const event of events) {
    const list = byTurn.get(event.turn_id)
    if (list) list.push(event)
    else byTurn.set(event.turn_id, [event])
  }
  return byTurn
}

export const initialMessagesState = {
  isStreaming: false,
  isLoading: false,
  currentUserMessageId: null as string | null,
  currentTurnStartedAt: null as number | null,
  turns: {} as Record<string, TurnView>,
  projectId: null as string | null,
  composerPrefill: null as ComposerPrefill | null,
  composerSubject: null,
  composerDrafts: {} as Record<string, string>,
  chatSendFn: null as ((content: string) => void) | null,
}

export const createMessagesSlice: StateCreator<
  ChatStore,
  [['zustand/devtools', never]],
  [],
  MessagesSlice
> = (set, get) => {
  /** Put `conversation` in the list, and in `currentConversation` when it is the open one. */
  const withConversation = (conversation: Conversation) => {
    const { conversations, currentConversation } = get()
    return {
      conversations: updateConversationInList(conversations, conversation),
      ...(currentConversation?.id === conversation.id && { currentConversation: conversation }),
    }
  }

  /** The answer the terminal just settled, mirrored to the server with the turn's provenance. */
  const persistSettled = (conversationId: string, answer: ChatMessage): void => {
    if (get().currentConversation?.id !== conversationId) return
    void get()._appendMessage(answer)
    void get()._persistTurnProvenance()
    get().maybeGenerateConversationName(conversationId)
  }

  /** Fold `events` into `turns` and draw every turn that moved; one `set()`. */
  const commit = (turns: Record<string, TurnView>, moved: [TurnView, TurnView | undefined][]): void => {
    const state = get()
    const conversations = new Map(state.conversations.map((c) => [c.id, c]))
    if (state.currentConversation) conversations.set(state.currentConversation.id, state.currentConversation)
    const effects: (() => void)[] = []
    let settled = false
    for (const [view, previous] of moved) {
      const conversation = conversations.get(view.conversationId)
      if (!conversation) continue
      const answerDurationMs =
        state.currentUserMessageId === view.turnId && state.currentTurnStartedAt !== null
          ? Math.max(1, Date.now() - state.currentTurnStartedAt)
          : undefined
      const projection = projectTurn(conversation.messages, view, previous, {
        answerDurationMs,
        draft: state.composerDrafts[conversation.id] ?? '',
      })
      if (projection.messages === conversation.messages) continue
      // No `updatedAt` bump while the turn grows: stamping every flush re-sorted
      // and re-rendered the whole sessions list ten times a second. The
      // settle is the turn's one activity stamp.
      conversations.set(conversation.id, {
        ...conversation,
        messages: projection.messages,
        ...(projection.settled && { updatedAt: new Date() }),
      })
      const { settled: answer, prompt, stageWrites } = projection
      if (answer) {
        settled = true
        effects.push(() => persistSettled(conversation.id, answer))
      }
      if (prompt) effects.push(() => void get()._appendMessage(prompt))
      const answerId = view.messageId
      if (answerId) for (const stages of stageWrites) effects.push(() => void get()._persistStageOutput(answerId, stages))
    }
    const current = state.currentConversation ? conversations.get(state.currentConversation.id) ?? null : null
    const update = () =>
      set(
        {
          turns,
          conversations: state.conversations.map((c) => conversations.get(c.id) ?? c),
          currentConversation: current,
          ...turnStateFor(turns, current?.id),
        },
        false,
        'applyTurnEvents'
      )
    // The settle is the most expensive frame the chat draws; its browser copy
    // is written after it.
    if (settled) deferChatStorageWrites(update)
    else update()
    for (const effect of effects) effect()
  }

  return {
    ...initialMessagesState,

    applyTurnEvents: (events) => {
      let turns = get().turns
      const moved: [TurnView, TurnView | undefined][] = []
      for (const [turnId, list] of groupByTurn(events)) {
        const previous = turns[turnId]
        const view = foldTurnEvents(previous, list)
        if (!view || view === previous) continue
        turns = { ...turns, [turnId]: view }
        moved.push([view, previous])
      }
      if (moved.length > 0) commit(turns, moved)
    },

    beginTurn: (conversationId, turnId) => {
      const turns = { ...get().turns, [turnId]: initialTurnView(turnId, conversationId) }
      set(
        {
          turns,
          currentUserMessageId: turnId,
          // A turn begun is a turn no longer waiting to be resumed.
          ...(get().resumableTurn?.turnId === turnId && { resumableTurn: null }),
          ...turnStateFor(turns, get().currentConversation?.id),
        },
        false,
        'beginTurn'
      )
    },

    dropTurn: (turnId) => {
      const { turns, currentConversation, conversations } = get()
      const view = turns[turnId]
      if (!view) return
      const { [turnId]: _dropped, ...rest } = turns
      const owner =
        currentConversation?.id === view.conversationId
          ? currentConversation
          : conversations.find((c) => c.id === view.conversationId)
      const fragment = owner?.messages.find((m) => m.id === view.messageId && m.isStreaming)
      set(
        {
          turns: rest,
          ...(owner && fragment && withConversation({ ...owner, messages: owner.messages.filter((m) => m !== fragment) })),
          ...turnStateFor(rest, currentConversation?.id),
        },
        false,
        'dropTurn'
      )
    },

    stopStreaming: () => {
      const running = runningTurnIn(get().turns, get().currentConversation?.id)
      if (!running) return
      // The handler folds what the socket still holds before it sends the cancel.
      stopTurnHandler?.(running.turnId)
      const view = get().turns[running.turnId] ?? running
      if (view.phase !== 'running') return
      // Stopped here and now, whatever the socket is doing: the answer so far
      // stays, its caret goes, the composer is free. The server's cancelled
      // terminal settles it when it arrives.
      const stopped: TurnView = { ...view, phase: 'finished', outcome: 'cancelled', streaming: false, interaction: undefined }
      commit({ ...get().turns, [view.turnId]: stopped }, [[stopped, view]])
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
          currentTurnStartedAt: Date.now(),
        },
        false,
        'addUserMessage'
      )

      get()._appendMessage(newMessage)
      return newMessage
    },

    adoptRunMessage: (conversationId: string, message: ChatMessage) => {
      const { currentConversation, conversations } = get()
      const target =
        conversations.find((c) => c.id === conversationId) ??
        (currentConversation?.id === conversationId ? currentConversation : undefined)
      if (!target) return
      if (target.messages.some((existing) => existing.id === message.id)) return

      const updatedConversation: Conversation = {
        ...target,
        messages: [...target.messages, message],
        updatedAt: new Date(),
      }

      set(
        {
          ...(currentConversation?.id === conversationId && {
            currentConversation: updatedConversation,
          }),
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

