import { v4 as uuidv4 } from 'uuid'
import { getActiveLocale } from '@/i18n'
import type { StateCreator } from 'zustand'
import type {
  ChatStore,
  Conversation,
  ChatMessage,
  RecoveryOutcome,
  ResumableTurn,
} from '../types'
import { useLayoutStore } from '@/features/layout/store'
import { useDocumentsStore } from '@/features/documents/store'
import { discardSessionDocumentsResources } from '@/features/documents/discard-session-resources'
import {
  clearAwaitingServerMessages,
  isAwaitingServerMessages,
  markAwaitingServerMessages,
} from './chat-storage'
import { hasLiveRun, hasNoUserChatMessages, liveRunMessages } from '../lib/session-activity'
import { cancelRun } from '@/lib/runs/run-view-client'
import {
  conversationMatchesProject,
  isHiddenJobConversation,
  isJobConversation,
} from '../lib/project-scope'
import { mapServerMessagesToChatMessages } from '../lib/server-message-mapper'
import { mergeRemoteMessages, turnStateFor } from './messages-store'
import { encodeCitations } from '../lib/citations'
import { markConversationMinted, markConversationOnServer } from '../lib/conversation-on-server'
import type { CardInteractions } from '@/features/grid-cards/card-decision'
import type { MessageStages } from '@/lib/conversations/message-stages'

export type SessionsSlice = {
  currentUserId: string | null
  currentConversation: Conversation | null
  conversations: Conversation[]
  /**
   * True while an interrupted-answer recovery fetch is in flight (FIX 3). A
   * turn that LOOKS interrupted locally (user message, thinking steps, no
   * reply) may simply have had its terminal frame persisted server-side during
   * a drop. While we re-fetch to check, the UI shows a calm "reconnecting —
   * checking for a finished answer" line instead of racing straight to the
   * "answer lost" notice; the lost/interrupted UI only appears once this
   * settles back to false with nothing recovered.
   */
  isRecoveryPending: boolean
  /**
   * A turn a reload (or a dead page) left open in this conversation, waiting
   * for a socket to `attach` it from its first event. Taken by the socket hook
   * once it is connected (`beginTurn`); never persisted.
   */
  resumableTurn: ResumableTurn | null

  /**
   * Whether the server conversation list has been ASKED for at least once
   * (regardless of what it returned, or whether it failed).
   *
   * The one fact a `?session=<id>` deep link needs and could not get: an id that
   * is unknown locally is either stale or simply not fetched yet. Without this,
   * "unknown → strip it from the URL" fires before the fetch lands and destroys
   * every link into a conversation this browser has never seen — which is
   * exactly what an inbox notification is (ADR-0035).
   */
  serverConversationsLoaded: boolean

  /**
   * The thread being opened whose messages are not here yet: a fetch of its
   * server history is in flight, or a `?session=` deep link names it and the
   * server list that resolves it has not landed. Reactive, unlike the awaiting
   * set in `chat-storage.ts`, because the thread draws from it: an open thread
   * with no messages shows the loading skeleton while this names it, and the
   * empty canvas only once it does not. Read through `selectThreadPhase`.
   */
  pendingMessagesFor: string | null

  /** Name (or, with null, clear) the thread a deep link is about to open. */
  setPendingMessagesFor: (conversationId: string | null) => void

  loadServerConversations: (projectId?: string) => Promise<void>
  hydrateConversationMessages: (conversationId: string) => Promise<void>
  setCurrentUser: (userId: string | null) => void
  getUserConversations: () => Conversation[]
  createConversation: () => Conversation
  startNewSessionDraft: () => void
  ensureSession: () => string | undefined
  selectConversation: (conversationId: string) => void
  deleteConversation: (conversationId: string) => void
  deleteAllConversations: () => void
  updateConversationTitle: (conversationId: string, title: string) => void
  maybeGenerateConversationName: (conversationId: string) => void
  saveDataSourcesToConversation: (ids: string[]) => void
  restoreSessionState: (conversation: Conversation) => void
  _recoverInterruptedAssistantMessage: (
    conversationId: string,
    afterUserMessageId: string,
    options?: { quiet?: boolean }
  ) => Promise<RecoveryOutcome>
  /**
   * Wait for the server's finished answer to a turn this page lost track of,
   * for as long as the turn is still producing frames (its heartbeat), then
   * look once more. `nothing` only when the turn has ended without one.
   */
  _awaitServerAnswer: (conversationId: string, afterUserMessageId: string) => Promise<RecoveryOutcome>
  isSessionBusy: (conversationId: string) => boolean
  hasAnyBusySession: () => boolean
  _ensureConversationExists: () => Promise<void>
  _appendMessage: (message: ChatMessage) => Promise<void>
  _persistCardInteractions: (
    conversationId: string,
    messageId: string,
    cardInteractions: CardInteractions
  ) => Promise<void>
  /**
   * Mirror an answer's provenance to the server once the turn has settled
   * (ADR-0037) — the Herleitung, the confidence self-assessment, the routing
   * transparency, the deep-research job pointer.
   *
   * Separate from `_appendMessage` because none of it exists when the message is
   * posted: it accumulates from the intermediate frames while the answer streams.
   */
  _persistTurnProvenance: () => Promise<void>
  /** Mirror the answer to a HITL prompt onto its message row (ADR-0037). */
  _persistPromptState: (messageId: string, response: string) => Promise<void>
  /**
   * Mirror a post-answer stage's output onto its message row
   * (`docs/architecture/post-answer-stages.md` §4.3).
   *
   * Fired the moment a frame is accepted rather than at turn end, because there
   * is no turn end left to hang it on: the answer settled seconds ago and this
   * is the last thing that will ever happen to it.
   */
  _persistStageOutput: (messageId: string, stages: MessageStages) => Promise<void>
  /**
   * Ask the BFF to cut a stopped answer's stored row to what was on screen
   * (`shown`). For a Stop that crossed the server's finished answer: the
   * server stored all of it, and a reload must show what the reader saw. The
   * BFF only ever cuts the row it holds (`cutStoppedAnswer`), and does nothing
   * to a row already stored as stopped.
   */
  _cutStoppedAnswer: (conversationId: string, messageId: string, turnId: string, shown: string) => Promise<void>
}

// Helper functions

/** An id minted here names nothing on the server until its first message is stored. */
const mintConversationId = (): string => {
  const id = `s_${uuidv4().replace(/-/g, '_')}`
  markConversationMinted(id)
  return id
}

const createNewConversation = (
  userId: string,
  projectId: string | null,
  subject?: { resourceType: 'document'; resourceId: string; title?: string | null } | null
): Conversation => ({
  id: mintConversationId(),
  userId,
  // Stamp the active project so the session stays scoped to it (UX-8);
  // null = created outside a project context (visible everywhere).
  projectId,
  title: subject?.title ?? '',
  subjectResourceType: subject?.resourceType ?? null,
  subjectResourceId: subject?.resourceId ?? null,
  messages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
})

const updateConversationInList = (
  conversations: Conversation[],
  updatedConversation: Conversation
): Conversation[] => {
  return conversations.map((c) => (c.id === updatedConversation.id ? updatedConversation : c))
}

export const patchConversationMessageById = (
  conversation: Conversation,
  messageId: string,
  patch: Partial<ChatMessage>
): Conversation => {
  let didPatch = false
  const messages = conversation.messages.map((message) => {
    if (message.id !== messageId) return message
    didPatch = true
    return { ...message, ...patch }
  })

  return didPatch ? { ...conversation, messages, updatedAt: new Date() } : conversation
}

const getDefaultEnabledDataSourceIds = (): string[] => {
  const layoutStore = useLayoutStore.getState()
  return layoutStore.availableDataSources?.map((source) => source.id) ?? []
}

const restoreConversationDataSources = (conversation: Conversation): void => {
  const layoutStore = useLayoutStore.getState()

  if (conversation.enabledDataSourceIds) {
    const availableIds = new Set(layoutStore.availableDataSources?.map((source) => source.id) ?? [])
    const validIds = conversation.enabledDataSourceIds.filter((id) => availableIds.has(id))
    layoutStore.setEnabledDataSources(validIds)
    return
  }

  const defaultIds = getDefaultEnabledDataSourceIds()
  layoutStore.setEnabledDataSources(defaultIds)
}

// Single memoized dynamic import: the conversations client is loaded lazily
// (it is browser-only), but exactly once — concurrent first loads must share
// one promise.
let conversationsClientModule: Promise<
  typeof import('@/adapters/api/conversations-client')
> | null = null
/**
 * How long a turn may go without a frame before it counts as ended: the
 * backend beats every 20 s for as long as a turn runs, socket or not
 * (`TURN_HEARTBEAT_SECONDS`), so three missed beats and a margin.
 */
const TURN_SILENCE_MS = 70_000
/** How often a reader waiting on the server's answer asks again. */
const AWAIT_ANSWER_POLL_MS = 4_000
/** With no replay stream to tell a live turn from a dead one, how long to keep asking. */
const AWAIT_ANSWER_BLIND_MS = 120_000
/** The longest any wait lasts, whatever the stream says: the run budget of a turn. */
const AWAIT_ANSWER_CEILING_MS = 40 * 60_000

/**
 * The server-answer waits in flight, one per conversation. Mount, reconnect
 * and the silence timer can each start one for the same turn; a second caller
 * gets `superseded`, so exactly one of them may accuse.
 */
const serverAnswerWaits = new Map<string, Promise<RecoveryOutcome>>()

/**
 * How many recoveries hold `isRecoveryPending`. A flag set and cleared by each
 * one would let the first to finish clear it under another still waiting.
 */
let recoveryHolds = 0

const getConversationsClient = () => {
  conversationsClientModule ??= import('@/adapters/api/conversations-client')
  return conversationsClientModule.then((m) => m.conversationsClient)
}

// Conversation ids whose server message history is currently being fetched;
// prevents duplicate GETs when selection and boot-time hydration overlap.
const hydratingConversationIds = new Set<string>()

// Conversation ids already ensured (or being ensured) on the server, one
// in-flight promise per conversation so two rapid appends share one create.
const ensuredServerConversations = new Map<string, Promise<void>>()

/**
 * Make sure the server has this conversation before a message is stored in it.
 *
 * The create IS the check: `POST /api/conversations` answers an id that already
 * exists with the existing row when the caller may contribute to it
 * (`createConversation` in `lib/conversations/service.ts`). It used to look the
 * id up in `list()` first, which added a failure that was not about this
 * conversation at all — a 429 on the list and the message was never stored —
 * and was capped at `CONVERSATION_LIST_LIMIT`, so past 200 conversations it
 * answered "missing" for rows that were there.
 */
const ensureServerConversation = (
  conversation: Conversation,
  fallbackProjectId: string | null
): Promise<void> => {
  const inFlight = ensuredServerConversations.get(conversation.id)
  if (inFlight) return inFlight

  const promise = (async () => {
    const conversationsClient = await getConversationsClient()
    // Stamp the server row with the session's project so future
    // project-scoped lists stay accurate.
    await conversationsClient.create(
      conversation.id,
      conversation.title || undefined,
      conversation.projectId ?? fallbackProjectId,
      conversation.subjectResourceId
        ? { resourceType: 'document', resourceId: conversation.subjectResourceId }
        : null
    )
    // The readers that were waiting for the row may ask about it now.
    markConversationOnServer(conversation.id)
  })()

  // Drop the cached promise on failure so the next append retries the check.
  const tracked = promise.catch((err) => {
    ensuredServerConversations.delete(conversation.id)
    throw err
  })
  ensuredServerConversations.set(conversation.id, tracked)
  return tracked
}

const forgetServerConversation = (conversationId: string): void => {
  ensuredServerConversations.delete(conversationId)
}

// Conversation ids whose ChatGPT-style name+tags have been requested. Naming
// fires once, after the first answer completes; this guard keeps a re-render
// or a second completion frame from firing duplicate generation calls.
const namedConversations = new Set<string>()

/** Extract the plain text of a chat message, ignoring cards/markup. */
const messagePlainText = (message: ChatMessage): string => (message.content ?? '').trim()

/**
 * Stop the runs still going in threads that are about to be deleted, best
 * effort: the worker would otherwise keep researching for a message nobody
 * can read any more. A refused cancel is logged and the delete goes ahead —
 * the run ends on its own terms and files its report against the project.
 * A run belongs to the project its thread is stamped with; the active project
 * is the fallback for a legacy thread that carries none.
 */
const cancelLiveRuns = (
  conversations: Conversation[],
  activeProjectId: string | null
): void => {
  for (const conversation of conversations) {
    const projectId = conversation.projectId ?? activeProjectId
    if (!projectId) continue
    for (const message of liveRunMessages(conversation.messages)) {
      const runId = message.runLedger?.runId
      if (!runId) continue
      cancelRun(projectId, runId).catch((err) => {
        console.warn('[deleteConversation] Failed to stop a live run:', runId, err)
      })
    }
  }
}

const maybeDiscardAbandonedUploadOnlySession = (
  get: () => ChatStore,
  sessionId: string | null | undefined
): void => {
  if (!sessionId) return

  const { conversations, currentUserId, pendingInteraction, currentConversation } = get()
  if (pendingInteraction && currentConversation?.id === sessionId) return

  const conv = conversations.find((c) => c.id === sessionId && c.userId === currentUserId)
  if (!conv) return
  // No messages HERE is not no messages: the server holds a conversation whose
  // messages storage evicted or this page never fetched, and discarding it
  // deleted it on the server.
  // A fetch in flight is not an answer yet either.
  if (isAwaitingServerMessages(conv.id) || hydratingConversationIds.has(conv.id)) return
  if (!hasNoUserChatMessages(conv.messages)) return
  if (hasLiveRun(conv.messages)) return

  const docsInFlight = useDocumentsStore
    .getState()
    .trackedFiles.some(
      (f) =>
        f.collectionName === sessionId && (f.status === 'uploading' || f.status === 'ingesting')
    )
  if (docsInFlight) return

  discardSessionDocumentsResources(sessionId)
  get().deleteConversation(sessionId)
}

export const initialSessionsState = {
  currentUserId: null as string | null,
  currentConversation: null as Conversation | null,
  conversations: [] as Conversation[],
  isRecoveryPending: false,
  resumableTurn: null as ResumableTurn | null,
  serverConversationsLoaded: false,
  pendingMessagesFor: null as string | null,
}

export const createSessionsSlice: StateCreator<
  ChatStore,
  [['zustand/devtools', never]],
  [],
  SessionsSlice
> = (set, get) => ({
  ...initialSessionsState,

  setPendingMessagesFor: (conversationId: string | null) => {
    if (get().pendingMessagesFor === conversationId) return
    set({ pendingMessagesFor: conversationId }, false, 'setPendingMessagesFor')
  },

  loadServerConversations: async (projectId?: string) => {
    try {
      const conversationsClient = await getConversationsClient()
      const serverConvs = await conversationsClient.list(projectId)
      if (!serverConvs || serverConvs.length === 0) return

      const { conversations, currentUserId } = get()
      const merged = [...conversations]

      for (const serverConv of serverConvs) {
        const idx = merged.findIndex((c) => c.id === serverConv.id)
        const local: Conversation = {
          id: serverConv.id,
          // The user this row belongs to in THIS browser's store — a membership
          // marker, not authorship. Every consumer treats it that way (the
          // sessions panel, the `selectConversation` guard, storage protection,
          // deep-research scoping), and nothing renders it as an author; who
          // wrote what comes from the shared-thread participants (ADR-0033).
          //
          // So it must be the person who FETCHED the list, not the creator: the
          // server already decided visibility (`listVisibleConversations`), and
          // stamping the creator made every conversation a colleague shared with
          // you invisible in your own sessions panel and refused by
          // `selectConversation` — the whole of ADR-0032 with no way in.
          userId: currentUserId ?? serverConv.createdBy ?? 'unknown',
          // Server is the source of truth for project affiliation; keep the
          // locally stamped projectId for legacy server rows that predate
          // project stamping.
          projectId: serverConv.projectId ?? (idx >= 0 ? merged[idx].projectId : null) ?? null,
          // Titles are generated client-side and may not have reached the
          // server yet — never clobber a local title with an empty one.
          title: serverConv.title ?? (idx >= 0 ? merged[idx].title : '') ?? '',
          messages: idx >= 0 ? merged[idx].messages : [],
          // Client-only field — dropping it here would silently re-enable
          // every data source the user turned off for this session.
          enabledDataSourceIds: idx >= 0 ? merged[idx].enabledDataSourceIds : undefined,
          // Over JSON these arrive as ISO strings; normalize so date math and
          // sidebar sorting behave the same as locally created sessions.
          createdAt: new Date(serverConv.createdAt as unknown as string),
          updatedAt: new Date(serverConv.updatedAt as unknown as string),
          // Provenance, and the ONLY thing that distinguishes a thread a job
          // produced from one a person started. This mapping is explicit
          // field by field, so a column left out here is silently dropped —
          // and dropping this one makes `isJobConversation` permanently false,
          // which quietly re-fills the owner's chat history with 52 job
          // threads a year while every test still passes.
          jobId: serverConv.jobId ?? null,
          subjectResourceType:
            serverConv.subjectResourceType === 'document'
              ? 'document'
              : ((idx >= 0 ? merged[idx].subjectResourceType : null) ?? null),
          subjectResourceId:
            serverConv.subjectResourceId ??
            (idx >= 0 ? merged[idx].subjectResourceId : null) ??
            null,
        }
        if (idx >= 0) {
          merged[idx] = local
        } else {
          markAwaitingServerMessages(local.id)
          merged.push(local)
        }
      }

      set({ conversations: merged }, false, 'loadServerConversations')

      // If the restored current session lost its messages locally (storage
      // cleanup, new device), repopulate them from the server right away.
      const { currentConversation } = get()
      if (
        currentConversation &&
        (currentConversation.messages.length === 0 ||
          isAwaitingServerMessages(currentConversation.id))
      ) {
        void get().hydrateConversationMessages(currentConversation.id)
      }
    } catch (err) {
      console.warn('[loadServerConversations] Failed to load server conversations:', err)
    } finally {
      // "We have asked" — set even when the list was empty or the fetch failed,
      // so a deep link to an id we cannot find stops waiting instead of hanging.
      set({ serverConversationsLoaded: true }, false, 'serverConversationsLoaded')
    }
  },

  hydrateConversationMessages: async (conversationId: string) => {
    const conversation = get().conversations.find((c) => c.id === conversationId)
    if (!conversation) return
    // Messages here are the whole thread unless the server's were never loaded:
    // a follow-up sent before the history arrived is only the tail of it.
    if (conversation.messages.length > 0 && !isAwaitingServerMessages(conversationId)) return
    if (hydratingConversationIds.has(conversationId)) return
    hydratingConversationIds.add(conversationId)
    // Set before the first await, so the commit that opened the thread already
    // shows it loading rather than the empty canvas.
    if (get().currentConversation?.id === conversationId) get().setPendingMessagesFor(conversationId)
    // Cleared in the same `set` that brings the messages: a render with the
    // messages and the thread still "loading" would seed their entrance
    // bookkeeping as empty and play every row's entrance.
    const settledPending = (): Pick<SessionsSlice, 'pendingMessagesFor'> | Record<string, never> =>
      get().pendingMessagesFor === conversationId ? { pendingMessagesFor: null } : {}

    try {
      const conversationsClient = await getConversationsClient()
      const serverMessages = await conversationsClient.listMessages(conversationId)
      const messages = mapServerMessagesToChatMessages(serverMessages)

      const { conversations, currentConversation, isStreaming, isLoading } = get()
      const target = conversations.find((c) => c.id === conversationId)
      if (!target) return
      if (messages.length === 0) {
        // The server confirms the thread is empty: now it is known, not missing.
        if (target.messages.length === 0) clearAwaitingServerMessages(conversationId)
        return
      }

      // Messages that arrived while the fetch was in flight stay, and the
      // server's history goes under them. Replacing either with the other
      // hid the history for good: the awaiting flag was cleared regardless.
      const { messages: merged } = mergeRemoteMessages(target.messages, messages, false)
      const hydrated: Conversation = { ...target, messages: merged }
      const isCurrent = currentConversation?.id === conversationId

      clearAwaitingServerMessages(conversationId)
      set(
        {
          conversations: updateConversationInList(conversations, hydrated),
          ...(isCurrent && { currentConversation: hydrated }),
          ...settledPending(),
        },
        false,
        'hydrateConversationMessages'
      )

      // Re-derive session UI state (thinking steps, pending prompts) from the
      // repopulated history — but never mid-stream.
      if (isCurrent && !isStreaming && !isLoading) {
        get().restoreSessionState(hydrated)
      }
    } catch (err) {
      console.warn('[hydrateConversationMessages] Failed to load messages from server:', err)
    } finally {
      hydratingConversationIds.delete(conversationId)
      // Confirmed empty, failed, or gone: the thread is what it is now. A
      // failed fetch shows the thread as it stands rather than a skeleton
      // that never resolves.
      const pending = settledPending()
      if ('pendingMessagesFor' in pending) set(pending, false, 'hydrateConversationMessages/settled')
    }
  },

  setCurrentUser: (userId: string | null) => {
    const { conversations, currentConversation, projectId } = get()

    const shouldClearCurrent =
      currentConversation && (userId === null || currentConversation.userId !== userId)

    // Fallback selection must respect the active project context, otherwise
    // switching users inside project A could surface project B's session.
    const userConversations = userId
      ? conversations.filter(
          (c) =>
            c.userId === userId &&
            conversationMatchesProject(c, projectId) &&
            !isHiddenJobConversation(c)
        )
      : []
    const newCurrentConversation = shouldClearCurrent
      ? userConversations[0] || null
      : currentConversation

    set(
      {
        currentUserId: userId,
        currentConversation: newCurrentConversation,
      },
      false,
      'setCurrentUser'
    )

    if (newCurrentConversation) {
      get().restoreSessionState(newCurrentConversation)
      restoreConversationDataSources(newCurrentConversation)
    } else {
      set(
        {
          pendingInteraction: null,
        },
        false,
        'setCurrentUser:clearState'
      )
    }
  },

  getUserConversations: () => {
    const { conversations, currentUserId, projectId } = get()
    if (!currentUserId) return []
    // Scoped to the active project context; legacy sessions without a
    // projectId fail open (see lib/project-scope.ts).
    //
    // The old PER-FIRE job conversations are excluded: they are the OUTPUT of a
    // scheduled job, not chats this person started, and a weekly job put 52
    // threads a year into their history. They stay reachable by URL and from
    // the job's run history. A standing task's ONE thread is not one of them and
    // is shown — see `isHiddenJobConversation`.
    return conversations.filter(
      (c) =>
        c.userId === currentUserId &&
        conversationMatchesProject(c, projectId) &&
        !isHiddenJobConversation(c)
    )
  },

  createConversation: () => {
    const { currentUserId, projectId } = get()
    if (!currentUserId) {
      throw new Error('Cannot create conversation without authenticated user')
    }
    const layoutState = useLayoutStore.getState()
    const defaultEnabledDataSourceIds = getDefaultEnabledDataSourceIds()
    layoutState.setEnabledDataSources(defaultEnabledDataSourceIds)
    const newConversation: Conversation = {
      ...createNewConversation(currentUserId, projectId ?? null, get().composerSubject),
      enabledDataSourceIds: defaultEnabledDataSourceIds,
    }
    set(
      (state) => ({
        conversations: [newConversation, ...state.conversations],
        currentConversation: newConversation,
        pendingInteraction: null,
      }),
      false,
      'createConversation'
    )
    return newConversation
  },

  startNewSessionDraft: () => {
    const { currentUserId, currentConversation } = get()
    if (!currentUserId) {
      throw new Error('Cannot start session draft without authenticated user')
    }

    maybeDiscardAbandonedUploadOnlySession(get, currentConversation?.id)

    const layoutState = useLayoutStore.getState()
    const defaultEnabledDataSourceIds = getDefaultEnabledDataSourceIds()
    layoutState.setEnabledDataSources(defaultEnabledDataSourceIds)

    set(
      {
        currentConversation: null,
        composerSubject: null,
        isStreaming: false,
        isLoading: false,
        currentUserMessageId: null,
        pendingInteraction: null,
        pendingMessagesFor: null,
      },
      false,
      'startNewSessionDraft'
    )
  },

  ensureSession: () => {
    const { currentConversation, currentUserId, projectId } = get()

    if (currentConversation?.id) {
      return currentConversation.id
    }
    if (!currentUserId) {
      return undefined
    }

    const layoutState = useLayoutStore.getState()
    const defaultEnabledDataSourceIds = getDefaultEnabledDataSourceIds()
    layoutState.setEnabledDataSources(defaultEnabledDataSourceIds)
    const newConversation: Conversation = {
      ...createNewConversation(currentUserId, projectId ?? null, get().composerSubject),
      enabledDataSourceIds: defaultEnabledDataSourceIds,
    }
    set(
      (state) => ({
        conversations: [newConversation, ...state.conversations],
        currentConversation: newConversation,
        pendingInteraction: null,
      }),
      false,
      'ensureSession'
    )
    return newConversation.id
  },

  selectConversation: (conversationId: string) => {
    const beforeLeave = get()
    const leavingId =
      beforeLeave.currentConversation?.id && beforeLeave.currentConversation.id !== conversationId
        ? beforeLeave.currentConversation.id
        : undefined

    // Ownership AND project-context guard: a stale URL or persisted state
    // must never activate another project's session under this project's
    // WebSocket projectId (cross-project retrieval bleed, UX-8).
    const canOpen = (candidate: Conversation | undefined): candidate is Conversation =>
      candidate !== undefined &&
      candidate.userId === get().currentUserId &&
      conversationMatchesProject(candidate, get().projectId)

    // A turn running in the conversation left keeps its view: its socket goes
    // with the conversation, and coming back attaches from the view's last seq.
    if (leavingId) maybeDiscardAbandonedUploadOnlySession(get, leavingId)

    const conversation = get().conversations.find((c) => c.id === conversationId)
    if (canOpen(conversation)) {
      set(
        {
          currentConversation: conversation,
          // A deep link waiting for this thread has it now; one waiting for
          // another thread was overruled by the reader's choice. A history
          // fetch below names this thread again in the same tick.
          pendingMessagesFor: null,
          // The id ONLY. `conversation.title` was the filename just long enough
          // to be overwritten by the first user message (addUserMessage), so
          // reusing it here restored the subject as "summarize this" and sent
          // that string on the wire as `focus_file_name`, matching no document.
          // ComposerSubjectBar re-reads the real filename and shelf from the
          // document; a null title is what asks it to.
          composerSubject: conversation.subjectResourceId
            ? {
                resourceType: 'document' as const,
                resourceId: conversation.subjectResourceId,
                title: null,
              }
            : null,
        },
        false,
        'selectConversation'
      )

      get().restoreSessionState(conversation)
      restoreConversationDataSources(conversation)

      // Past chats whose messages were pruned from localStorage (or that came
      // from another device) repopulate from the server-persisted history.
      if (conversation.messages.length === 0 || isAwaitingServerMessages(conversation.id)) {
        void get().hydrateConversationMessages(conversation.id)
      }
    }
  },

  deleteConversation: (conversationId: string) => {
    const { currentConversation, conversations, composerDrafts } = get()

    const conversationToDelete = conversations.find((c) => c.id === conversationId)
    if (conversationToDelete) cancelLiveRuns([conversationToDelete], get().projectId)

    const updatedConversations = conversations.filter((c) => c.id !== conversationId)

    // Drop the removed session's draft so it can't orphan (or resurface if the
    // id is ever reused).
    let nextComposerDrafts = composerDrafts
    if (conversationId in composerDrafts) {
      nextComposerDrafts = { ...composerDrafts }
      delete nextComposerDrafts[conversationId]
    }

    // Delete the server-persisted row too — otherwise the next
    // loadServerConversations resurrects the session as an empty ghost.
    forgetServerConversation(conversationId)
    getConversationsClient().then((conversationsClient) => {
      conversationsClient.delete(conversationId).catch((err) => {
        console.warn('[deleteConversation] Failed to delete server conversation:', err)
      })
    })

    set(
      {
        conversations: updatedConversations,
        composerDrafts: nextComposerDrafts,
        currentConversation:
          currentConversation?.id === conversationId ? null : currentConversation,
      },
      false,
      'deleteConversation'
    )
  },

  deleteAllConversations: () => {
    const { conversations, currentUserId, currentConversation, projectId, composerDrafts } = get()

    if (!currentUserId) return

    // Scope: delete exactly what the sessions panel shows in the current
    // context — the active project's sessions plus unscoped legacy sessions
    // (fail-open display rule, see lib/project-scope.ts). Sessions stamped
    // with a DIFFERENT project are never touched, so "delete all" cannot
    // silently wipe another project's history (UX-8).
    // EVERY job conversation is excluded here, including the standing task
    // thread the list above now shows. „Delete all" usually means exactly what
    // the panel showed; this is the one place it deliberately means less. A
    // task's thread is the shared record of work that keeps running — it belongs
    // to the project and to everyone with project:view — and clearing one
    // person's chat history must not take the Wochencheck's whole history with
    // it. Deleting it is a deliberate act on that thread, not a side effect.
    const isInScope = (c: Conversation): boolean =>
      c.userId === currentUserId &&
      conversationMatchesProject(c, projectId) &&
      !isJobConversation(c)

    const userConversations = conversations.filter(isInScope)
    cancelLiveRuns(userConversations, projectId)

    // Delete the server-persisted rows too — otherwise the next
    // loadServerConversations resurrects every session as an empty ghost.
    userConversations.forEach((conv) => forgetServerConversation(conv.id))
    getConversationsClient().then(async (conversationsClient) => {
      const results = await Promise.allSettled(
        userConversations.map((conv) => conversationsClient.delete(conv.id))
      )
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(
            '[deleteAllConversations] Failed to delete server conversation:',
            userConversations[index].id,
            result.reason
          )
        }
      })
    })

    const remainingConversations = conversations.filter((c) => !isInScope(c))

    // Drop drafts for exactly the sessions being removed (the in-scope ones);
    // drafts of out-of-scope sessions in other projects stay untouched.
    const removedSessionIds = new Set(userConversations.map((c) => c.id))
    const nextComposerDrafts = Object.fromEntries(
      Object.entries(composerDrafts).filter(([id]) => !removedSessionIds.has(id))
    )

    const shouldClearCurrent = currentConversation && isInScope(currentConversation)

    set(
      {
        conversations: remainingConversations,
        composerDrafts: nextComposerDrafts,
        currentConversation: shouldClearCurrent ? null : currentConversation,
        pendingInteraction: null,
      },
      false,
      'deleteAllConversations'
    )
  },

  updateConversationTitle: (conversationId: string, title: string) => {
    const { currentConversation, conversations } = get()

    const updatedConversations = conversations.map((c) =>
      c.id === conversationId ? { ...c, title, updatedAt: new Date() } : c
    )

    const updatedCurrentConversation =
      currentConversation?.id === conversationId
        ? { ...currentConversation, title, updatedAt: new Date() }
        : currentConversation

    set(
      {
        conversations: updatedConversations,
        currentConversation: updatedCurrentConversation,
      },
      false,
      'updateConversationTitle'
    )

    // Mirror the title to the server row so repopulated history keeps its
    // name. Best-effort: the row may not exist yet (created on first append).
    getConversationsClient().then((conversationsClient) => {
      conversationsClient.updateTitle(conversationId, title).catch((err) => {
        console.warn('[updateConversationTitle] Failed to sync title to server:', err)
      })
    })
  },

  /**
   * ChatGPT-style naming: after the first answer completes, ask the backend to
   * name the conversation and tag it with OIB topics from the opening exchange,
   * then replace the provisional (first-message) title with the generated one.
   *
   * Fires at most once per conversation and only for the FIRST turn (exactly
   * one user message + at least one answer), so later turns never re-name a
   * chat the user may have manually renamed. Fully best-effort: a generation
   * failure (backend down, no LLM key) leaves the provisional title in place.
   */
  maybeGenerateConversationName: (conversationId: string) => {
    if (namedConversations.has(conversationId)) return

    const { conversations } = get()
    const conversation = conversations.find((c) => c.id === conversationId)
    if (!conversation) return

    // A thread that commissioned a run is named by the run's own title
    // (`runTitle`, written by the worker); don't override it with a chat name.
    const hasRun = conversation.messages.some((m) => Boolean(m.runLedger || m.deepResearchJobId))
    if (hasRun) return

    const userMessages = conversation.messages.filter((m) => m.messageType === 'user')
    // Only name the opening exchange — one user question, now answered.
    if (userMessages.length !== 1) return

    const firstQuestion = messagePlainText(userMessages[0])
    if (!firstQuestion) return

    const firstAnswer = conversation.messages.find(
      (m) => m.messageType === 'agent_response' && messagePlainText(m).length > 0
    )
    if (!firstAnswer) return

    // Claim the slot up front so a duplicate completion frame can't double-fire.
    namedConversations.add(conversationId)

    const payload = [
      { role: 'user' as const, content: firstQuestion },
      { role: 'assistant' as const, content: messagePlainText(firstAnswer) },
    ]

    getConversationsClient()
      .then((conversationsClient) =>
        conversationsClient.generateTitle(conversationId, payload, getActiveLocale())
      )
      .then((result) => {
        const title = result.title.trim()
        // Empty means the endpoint failed open — keep the provisional title.
        // Re-check the store: only overwrite if the user has not since renamed
        // this conversation to something else themselves.
        if (!title) {
          namedConversations.delete(conversationId)
          return
        }
        get().updateConversationTitle(conversationId, title)
      })
      .catch((err) => {
        // Allow a later turn to retry naming after a transient failure.
        namedConversations.delete(conversationId)
        console.warn('[maybeGenerateConversationName] Failed to generate name:', err)
      })
  },

  saveDataSourcesToConversation: (ids: string[]) => {
    let { currentConversation, conversations } = get()

    if (!currentConversation) {
      const sessionId = get().ensureSession()
      if (!sessionId) return
      currentConversation = get().currentConversation
      conversations = get().conversations
      if (!currentConversation) return
    }

    const updatedConversation: Conversation = {
      ...currentConversation,
      enabledDataSourceIds: ids,
    }

    set(
      {
        currentConversation: updatedConversation,
        conversations: updateConversationInList(conversations, updatedConversation),
      },
      false,
      'saveDataSourcesToConversation'
    )
  },

  restoreSessionState: (conversation: Conversation) => {
    // Turn state is the views' (a turn still running here, left and come back
    // to, carries on from its view), never the messages'.
    const turnState = turnStateFor(get().turns, conversation.id)
    set(turnState, false, 'restoreSessionState')
    if (turnState.isStreaming || turnState.pendingInteraction) return

    // The newest thing in the thread is an open turn of mine: my question with
    // no answer after it, or a prompt of my turn. A reload cut it off, or the
    // page died before its answer. Its turn id is the question's own id, so
    // the socket re-attaches it from its first event (`resumableTurn`); a
    // stream that no longer holds it sends the reader to the server's copy.
    const meaningfulTypes = new Set(['user', 'assistant', 'agent_response', 'error', 'prompt'])
    const last = conversation.messages.findLast((m) => meaningfulTypes.has(m.messageType ?? ''))
    const mine = !last?.authorUserId || last.authorUserId === get().currentUserId
    const turnId =
      last?.messageType === 'user' && mine
        ? last.id
        : last?.messageType === 'prompt'
          ? last.promptParentId
          : undefined
    if (turnId) set({ resumableTurn: { conversationId: conversation.id, turnId } }, false, 'restoreSessionState:resumable')
  },

  _awaitServerAnswer: (conversationId: string, afterUserMessageId: string): Promise<RecoveryOutcome> => {
    if (serverAnswerWaits.has(conversationId)) return Promise.resolve('superseded')
    const wait = (async (): Promise<RecoveryOutcome> => {
      // The calm "checking for a finished answer" line for the whole wait, not
      // per fetch: the reader is told the answer is lost only when it is.
      recoveryHolds += 1
      set({ isRecoveryPending: true }, false, 'awaitServerAnswer:start')
      try {
        const conversationsClient = await getConversationsClient()
        const started = Date.now()
        for (;;) {
          const outcome = await get()._recoverInterruptedAssistantMessage(
            conversationId,
            afterUserMessageId,
            { quiet: true }
          )
          if (outcome !== 'nothing') return outcome
          const elapsed = Date.now() - started
          if (elapsed >= AWAIT_ANSWER_CEILING_MS) return 'nothing'
          // Is the turn still producing frames (a heartbeat every 20 s)? With no
          // stream to ask, wait a short while for the server's write instead.
          const age = await conversationsClient.newestFrameAge(conversationId)
          const alive =
            age === undefined ? elapsed < AWAIT_ANSWER_BLIND_MS : age !== null && age < TURN_SILENCE_MS
          if (!alive) {
            // One last look: the answer may have been written just as the turn
            // went quiet.
            return get()._recoverInterruptedAssistantMessage(conversationId, afterUserMessageId, {
              quiet: true,
            })
          }
          await new Promise((resolve) => setTimeout(resolve, AWAIT_ANSWER_POLL_MS))
        }
      } finally {
        recoveryHolds -= 1
        if (recoveryHolds === 0) set({ isRecoveryPending: false }, false, 'awaitServerAnswer:end')
      }
    })().finally(() => {
      serverAnswerWaits.delete(conversationId)
    })
    serverAnswerWaits.set(conversationId, wait)
    return wait
  },

  _recoverInterruptedAssistantMessage: async (
    conversationId: string,
    afterUserMessageId: string,
    { quiet = false }: { quiet?: boolean } = {}
  ): Promise<RecoveryOutcome> => {
    // Signal the "checking for a finished answer" UI (FIX 3) for the duration
    // of the fetch, so the calmer recovery-pending copy shows on every
    // recovery attempt and the lost/interrupted UI only appears after this
    // settles to false. `quiet` when a caller holds the flag for longer
    // (`_awaitServerAnswer`).
    if (!quiet) {
      recoveryHolds += 1
      set({ isRecoveryPending: true }, false, 'recoveryPending:start')
    }
    try {
      const conversationsClient = await getConversationsClient()
      const serverMessages = await conversationsClient.listMessages(conversationId)
      const mapped = mapServerMessagesToChatMessages(serverMessages)

      const { conversations, currentConversation, isStreaming } = get()
      const target = conversations.find((c) => c.id === conversationId)
      // A live stream (or a deleted session) supersedes recovery: never fold
      // stale server history over newer local state.
      if (!target || isStreaming) return 'superseded'

      const localIds = new Set(target.messages.map((m) => m.id))

      // The recovered response is the assistant message the server persisted
      // for THIS turn: it comes after the interrupted user message and is not
      // already in local history.
      const userIdx = mapped.findIndex((m) => m.id === afterUserMessageId)
      const searchSpace = userIdx >= 0 ? mapped.slice(userIdx + 1) : mapped
      const answers = searchSpace.filter((m) => m.role === 'assistant')
      const recovered = answers.find((m) => !localIds.has(m.id))
      // The server HAS an answer for this turn and it is already on screen —
      // a concurrent recovery got there first (mount and reconnect can both run
      // this within a second of each other). That is not "nothing to show", and
      // reporting it as one puts „bitte erneut senden" directly under the
      // answer the other call had just recovered.
      if (!recovered) return answers.length > 0 ? 'superseded' : 'nothing'

      const merged: Conversation = {
        ...target,
        messages: [...target.messages, recovered],
      }
      set(
        {
          conversations: updateConversationInList(conversations, merged),
          ...(currentConversation?.id === conversationId && { currentConversation: merged }),
        },
        false,
        'recoverInterruptedAssistantMessage'
      )
      return 'recovered'
    } catch (err) {
      console.warn('[recoverInterruptedAssistantMessage] Failed:', err)
      // Could not establish that an answer exists. The turn really did stall on
      // this side, so the banner stands — but say `nothing` rather than invent
      // a fourth outcome nobody would branch on.
      return 'nothing'
    } finally {
      if (!quiet) {
        recoveryHolds -= 1
        if (recoveryHolds === 0) set({ isRecoveryPending: false }, false, 'recoveryPending:end')
      }
    }
  },

  // A live run does not make its thread busy: the run is a message that
  // carries its own stop control, and the person keeps chatting beside it
  // (ADR-0062). Busy is the socket mid-turn, and nothing else.
  isSessionBusy: (conversationId: string) => {
    const state = get()
    return state.currentConversation?.id === conversationId && state.isStreaming
  },

  hasAnyBusySession: () => {
    const state = get()
    if (state.pendingInteraction !== null) return true
    return state.conversations.some((conv) => state.isSessionBusy(conv.id))
  },

  _ensureConversationExists: async () => {
    const { currentConversation, projectId } = get()
    if (!currentConversation) return

    try {
      await ensureServerConversation(currentConversation, projectId ?? null)
    } catch (err) {
      console.warn('[ensureConversationExists] Failed:', err)
    }
  },

  _appendMessage: async (message: ChatMessage) => {
    const { currentConversation, projectId } = get()
    if (!currentConversation) return

    try {
      const conversationsClient = await getConversationsClient()

      await ensureServerConversation(currentConversation, projectId ?? null)

      await conversationsClient.createMessage(currentConversation.id, {
        id: message.id,
        role: message.role,
        content: message.content,
        messageType: message.messageType,
        metadata: {
          ...(message.errorData && { errorData: message.errorData }),
          ...(message.fileData && { fileData: message.fileData }),
          ...(message.cards && { cards: message.cards }),
          // The answer's structured anatomy — sanitized at the wire boundary
          // on write and re-sanitized by the mapper on read, like `cards`.
          ...(message.answerMeta && { answerMeta: message.answerMeta }),
          // Marked at insert, not only by the provenance mirror after it: a
          // stored stopped row is what tells the BFF's cut it has nothing to do
          // (`cutStoppedAnswer`), and a reload says it was stopped.
          ...(message.stopped && { provenance: { stopped: true } }),
          ...(message.cardInteractions && { cardInteractions: message.cardInteractions }),
          ...(message.enabledDataSources && { enabledDataSources: message.enabledDataSources }),
          ...(message.messageFiles && { messageFiles: message.messageFiles }),
          // A human-in-the-loop prompt (ADR-0037). Without this an observer's
          // server-authoritative load showed NO card at all and the thread simply
          // stopped mid-question; `promptFor` names the person the agent asked, so
          // everybody else can be shown it read-only — the agent tier refuses an
          // answer from anyone else anyway.
          ...(message.messageType === 'prompt'
            ? {
                prompt: {
                  ...(message.promptId && { promptId: message.promptId }),
                  ...(message.promptParentId && { promptParentId: message.promptParentId }),
                  ...(message.promptInputType && { promptInputType: message.promptInputType }),
                  ...(message.promptOptions && { promptOptions: message.promptOptions }),
                  ...(message.promptPlaceholder && {
                    promptPlaceholder: message.promptPlaceholder,
                  }),
                  ...(get().currentUserId ? { promptFor: get().currentUserId } : {}),
                },
              }
            : {}),
          // An answer's grounding has to outlive the tab that produced it: a
          // chat restored from the server used to come back with the answer
          // intact and its whole provenance row missing.
          ...(() => {
            const citations = encodeCitations(message.citations)
            return citations ? { citations } : {}
          })(),
          // Retrieved-but-uncited documents, same envelope as the citations:
          // they have to outlive the tab for the reloaded thread to say what
          // else the turn read.
          ...(() => {
            const readSources = encodeCitations(message.readSources)
            return readSources ? { readSources } : {}
          })(),
        },
        createdAt:
          message.timestamp instanceof Date
            ? message.timestamp.toISOString()
            : String(message.timestamp),
      })
    } catch (err) {
      console.warn('[appendMessage] Failed:', err)
    }
  },

  _persistPromptState: async (messageId: string, response: string) => {
    const { currentConversation } = get()
    if (!currentConversation) return
    try {
      const conversationsClient = await getConversationsClient()
      await conversationsClient.updateMessagePromptState(currentConversation.id, messageId, {
        response,
      })
    } catch (err) {
      // Best-effort, like the other mirrors: the answer already reached the agent
      // over the socket and is rendered from the store. Losing this costs the
      // transcript, not the turn.
      console.warn('[persistPromptState] Failed:', err)
    }
  },

  _persistStageOutput: async (messageId: string, stages: MessageStages) => {
    const { currentConversation } = get()
    if (!currentConversation) return
    try {
      const conversationsClient = await getConversationsClient()
      await conversationsClient.updateMessageStages(currentConversation.id, messageId, {
        ...stages,
      })
    } catch (err) {
      // Never surfaced, like the other mirrors: the chips are already on screen,
      // rendered from the store. Losing this costs a colleague's view and the
      // cross-device replay, not the turn — and the reader loses nothing they
      // were promised, which is the whole licence a post-answer stage runs on.
      console.warn('[persistStageOutput] Failed:', err)
    }
  },

  _persistTurnProvenance: async () => {
    const { currentConversation, currentUserMessageId } = get()
    if (!currentConversation) return

    // Two messages carry provenance and they carry different halves of it: the
    // USER message owns the Herleitung (that is where `ChatThinking` hangs it),
    // and the ASSISTANT message owns the confidence and routing transparency.
    const messages = currentConversation.messages
    const userMessage = currentUserMessageId
      ? messages.find((message) => message.id === currentUserMessageId)
      : undefined
    const assistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')

    const targets: Array<[string, Record<string, unknown>]> = []

    if (userMessage?.thinkingSteps?.length) {
      // The stored shape is what the fold writes, so the server row, the
      // browser's copy and the live turn cannot disagree.
      targets.push([userMessage.id, { thinkingSteps: userMessage.thinkingSteps }])
    }

    if (assistantMessage) {
      const provenance: Record<string, unknown> = {}
      if (assistantMessage.answerConfidence) {
        provenance.answerConfidence = assistantMessage.answerConfidence
      }
      if (assistantMessage.answerConfidenceCappedReason) {
        provenance.answerConfidenceCappedReason = assistantMessage.answerConfidenceCappedReason
      }
      if (assistantMessage.answerConfidenceReason) {
        provenance.answerConfidenceReason = assistantMessage.answerConfidenceReason
      }
      if (assistantMessage.routingDecision) {
        provenance.routingDecision = assistantMessage.routingDecision
      }
      if (assistantMessage.escalationReason) {
        provenance.escalationReason = assistantMessage.escalationReason
      }
      if (assistantMessage.answerDurationMs) {
        provenance.answerDurationMs = assistantMessage.answerDurationMs
      }
      if (assistantMessage.reasoningEffort) {
        provenance.reasoningEffort = assistantMessage.reasoningEffort
      }
      if (assistantMessage.citationsRemoved) {
        provenance.citationsRemoved = assistantMessage.citationsRemoved
      }
      if (assistantMessage.skillsActivated?.length) {
        provenance.skillsActivated = assistantMessage.skillsActivated
      }
      if (assistantMessage.skillsHidden?.length) {
        provenance.skillsHidden = assistantMessage.skillsHidden
      }
      if (assistantMessage.researchTruncated) provenance.researchTruncated = true
      // The PATCH replaces the row's provenance whole, so a stopped answer
      // must say so here too, or the mirror unmarks the row the server
      // stored as stopped and a reload renders a fragment as a finished answer.
      if (assistantMessage.stopped) provenance.stopped = true
      // Mirrored so a reload of a LIVE turn shows what the turn showed. The
      // sanitizer in message-provenance already accepts both; nothing was
      // calling it with them.
      if (assistantMessage.truncationReason)
        provenance.truncationReason = assistantMessage.truncationReason
      if (assistantMessage.degradedReasons?.length)
        provenance.degradedReasons = assistantMessage.degradedReasons
      // The POINTER, not the report: a colleague fetches the document through the
      // path that already serves it rather than being handed a copy in a message
      // row.
      if (assistantMessage.deepResearchJobId) {
        provenance.deepResearchJobId = assistantMessage.deepResearchJobId
      }
      // The backend's account of the turn's rounds, already bounded at the
      // wire boundary; the sanitizer re-bounds it on write.
      if (assistantMessage.retrievalLedger && assistantMessage.retrievalLedger.length > 0) {
        provenance.retrievalLedger = assistantMessage.retrievalLedger
      }
      if (assistantMessage.quoteStamps && assistantMessage.quoteStamps.length > 0) {
        provenance.quoteStamps = assistantMessage.quoteStamps
      }

      if (Object.keys(provenance).length > 0) targets.push([assistantMessage.id, provenance])
    }

    if (targets.length === 0) return

    try {
      const conversationsClient = await getConversationsClient()
      // Sequential: both PATCHes take a row lock on the same conversation's
      // messages, and there is no deadline here worth racing them for.
      for (const [messageId, provenance] of targets) {
        await conversationsClient.updateMessageProvenance(
          currentConversation.id,
          messageId,
          provenance
        )
      }
    } catch (err) {
      // Never surfaced. The asker is already looking at the Herleitung, rendered
      // from the store; losing the mirror costs a colleague's view and the
      // cross-device replay, not this turn.
      console.warn('[persistTurnProvenance] Failed:', err)
    }
  },

  _cutStoppedAnswer: async (conversationId: string, messageId: string, turnId: string, shown: string) => {
    try {
      const conversationsClient = await getConversationsClient()
      await conversationsClient.cutStoppedAnswer(conversationId, messageId, { turnId, shown })
    } catch (err) {
      // Never surfaced: the reader has the answer they stopped on screen. A
      // failed cut costs a reload that shows the rest of it, marked as a
      // whole answer, which is what it was before this existed.
      console.warn('[cutStoppedAnswer] Failed:', err)
    }
  },

  _persistCardInteractions: async (
    conversationId: string,
    messageId: string,
    cardInteractions: CardInteractions
  ) => {
    try {
      const conversationsClient = await getConversationsClient()
      await conversationsClient.updateMessageCardInteractions(
        conversationId,
        messageId,
        cardInteractions
      )
    } catch (err) {
      // Never surfaced: the decision is already recorded locally (and rendered
      // from there). Losing the mirror only costs the cross-device replay —
      // e.g. the row was never appended because the client was offline.
      console.warn('[persistCardInteractions] Failed:', err)
    }
  },
})
