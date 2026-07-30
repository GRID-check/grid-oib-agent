import { v4 as uuidv4 } from 'uuid'
import { toast } from 'sonner'
import { getStoreTranslator, getActiveLocale } from '@/i18n'
import { createJSONStorage, type StorageValue, type PersistStorage } from 'zustand/middleware'
import type { StateCreator } from 'zustand'
import type {
  ChatStore,
  ChatState,
  Conversation,
  ChatMessage,
  PendingInteraction,
} from '../types'
import { useLayoutStore } from '@/features/layout/store'
import { useDocumentsStore } from '@/features/documents/store'
import { discardSessionDocumentsResources } from '@/features/documents/discard-session-resources'
import {
  pruneMessageForStorage,
  stripThinkingStepsForStorage,
} from '../lib/prune-message-for-storage'
import {
  logStorageWrite,
  logQuotaExceededPruning,
  logCriticalSessionsClear,
  logStorageAvailability,
} from '../lib/storage-logger'
import { ensureStorageCapacity } from '../lib/storage-manager'
import {
  clearAllDeepResearchSessions,
  clearDeepResearchSession,
} from '../lib/deep-research-session-storage'
import { hasActiveDeepResearchJob, hasNoUserChatMessages } from '../lib/session-activity'
import { conversationMatchesProject } from '../lib/project-scope'
import { mapServerMessagesToChatMessages } from '../lib/server-message-mapper'
import { encodeCitations } from '../lib/citations'
import type { CardInteractions } from '@/features/grid-cards/card-decision'

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
    afterUserMessageId: string
  ) => Promise<boolean>
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
}

// Persistence helpers

const isQuotaExceededError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if (error.name === 'QuotaExceededError') return true
  return /quota|exceeded|storage/i.test(error.message)
}

type PersistedChatState = {
  currentUserId: ChatState['currentUserId']
  conversations: ChatState['conversations']
  currentConversation: ChatState['currentConversation']
  pendingInteraction: ChatState['pendingInteraction']
  composerDrafts: ChatState['composerDrafts']
}

type PersistedChatStorageValue = StorageValue<PersistedChatState>

const prunePersistedChatState = (value: PersistedChatStorageValue): PersistedChatStorageValue => {
  const state = value.state

  const conversations: Conversation[] = (state.conversations ?? []).map((conv) => ({
    ...conv,
    messages: (conv.messages ?? []).map(pruneMessageForStorage),
  }))

  const currentConversationId = state.currentConversation?.id ?? null

  return {
    ...value,
    state: {
      currentUserId: state.currentUserId ?? null,
      conversations,
      currentConversation: currentConversationId as unknown as Conversation | null,
      pendingInteraction: state.pendingInteraction ?? null,
      composerDrafts: state.composerDrafts ?? {},
    },
  }
}

export const createResilientStorage = (): PersistStorage<PersistedChatState> | undefined => {
  const base = createJSONStorage<PersistedChatState>(() => localStorage)
  if (!base) {
    logStorageAvailability(false)
    return undefined
  }

  return {
    getItem: async (name: string): Promise<PersistedChatStorageValue | null> => {
      const raw = await base.getItem(name)
      if (!raw) return null

      const stripConnectionErrors = (conversations: Conversation[]) =>
        conversations.map((c) => ({
          ...c,
          messages: c.messages.filter(
            (m) => !(m.messageType === 'error' && m.errorData?.errorCode?.startsWith('connection.'))
          ),
        }))

      if (raw.state.conversations) {
        raw.state.conversations = stripConnectionErrors(raw.state.conversations)
      }

      const storedId = raw.state.currentConversation as unknown as string | null
      if (storedId) {
        const conversations = raw.state.conversations ?? []
        raw.state.currentConversation = conversations.find((c) => c.id === storedId) ?? null
      }

      return raw
    },
    removeItem: base.removeItem,
    setItem: (name: string, value: PersistedChatStorageValue) => {
      const prunedValue = prunePersistedChatState(value)
      const serializedValue = JSON.stringify(prunedValue)

      try {
        if (localStorage.getItem(name) === serializedValue) return

        localStorage.setItem(name, serializedValue)
        logStorageWrite(
          prunedValue.state.conversations ?? [],
          prunedValue.state.currentUserId ?? null
        )
      } catch (error) {
        if (!isQuotaExceededError(error)) {
          throw error
        }

        const beforeConversations = prunedValue.state.conversations ?? []
        const beforeCount = beforeConversations.length
        const beforeSizeKB = Math.round((JSON.stringify(beforeConversations).length * 2) / 1024)

        logQuotaExceededPruning(beforeCount, beforeCount, beforeSizeKB, beforeSizeKB)

        try {
          const lostSessionIds = beforeConversations.map((c) => c.id)

          base.removeItem(name)
          base.setItem(name, {
            ...value,
            state: {
              currentUserId: value.state.currentUserId ?? null,
              conversations: [],
              currentConversation: null,
              pendingInteraction: null,
              // Sessions were just wiped to recover from quota — drop their
              // drafts too so no orphaned draft outlives its conversation.
              composerDrafts: {},
            },
          })

          logCriticalSessionsClear(value.state.currentUserId ?? null, lostSessionIds, error)
        } catch (finalError) {
          console.error('[SessionsStore] ❌ CATASTROPHIC: Failed to clear sessions', {
            error: finalError instanceof Error ? finalError.message : String(finalError),
          })
        }
      }
    },
  }
}

// Helper functions

const createNewConversation = (userId: string, projectId: string | null): Conversation => ({
  id: `s_${uuidv4().replace(/-/g, '_')}`,
  userId,
  // Stamp the active project so the session stays scoped to it (UX-8);
  // null = created outside a project context (visible everywhere).
  projectId,
  title: '',
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
let conversationsClientModule: Promise<typeof import('@/adapters/api/conversations-client')> | null = null
const getConversationsClient = () => {
  conversationsClientModule ??= import('@/adapters/api/conversations-client')
  return conversationsClientModule.then((m) => m.conversationsClient)
}

// Conversation ids whose server message history is currently being fetched;
// prevents duplicate GETs when selection and boot-time hydration overlap.
const hydratingConversationIds = new Set<string>()

// Conversation ids already ensured (or being ensured) on the server. Two
// rapid appends used to race list()+create and lose the second message when
// the duplicate create rejected; sharing one in-flight promise serializes
// the check per conversation.
const ensuredServerConversations = new Map<string, Promise<void>>()

const ensureServerConversation = (conversation: Conversation, fallbackProjectId: string | null): Promise<void> => {
  const inFlight = ensuredServerConversations.get(conversation.id)
  if (inFlight) return inFlight

  const promise = (async () => {
    const conversationsClient = await getConversationsClient()
    const existing = await conversationsClient.list()
    if (existing.some((c) => c.id === conversation.id)) return
    // Stamp the server row with the session's project so future
    // project-scoped lists stay accurate.
    await conversationsClient.create(
      conversation.id,
      conversation.title || undefined,
      conversation.projectId ?? fallbackProjectId,
    )
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

const maybeDiscardAbandonedUploadOnlySession = (
  get: () => ChatStore,
  sessionId: string | null | undefined
): void => {
  if (!sessionId) return

  const { conversations, currentUserId, pendingInteraction, currentConversation } = get()
  if (pendingInteraction && currentConversation?.id === sessionId) return

  const conv = conversations.find((c) => c.id === sessionId && c.userId === currentUserId)
  if (!conv) return
  if (!hasNoUserChatMessages(conv.messages)) return
  if (hasActiveDeepResearchJob(conv.messages)) return

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
  serverConversationsLoaded: false,
}

export const createSessionsSlice: StateCreator<ChatStore, [["zustand/devtools", never]], [], SessionsSlice> = (set, get) => ({
  ...initialSessionsState,

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
        }
        if (idx >= 0) {
          merged[idx] = local
        } else {
          merged.push(local)
        }
      }

      set({ conversations: merged }, false, 'loadServerConversations')

      // If the restored current session lost its messages locally (storage
      // cleanup, new device), repopulate them from the server right away.
      const { currentConversation } = get()
      if (currentConversation && currentConversation.messages.length === 0) {
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
    if (!conversation || conversation.messages.length > 0) return
    if (hydratingConversationIds.has(conversationId)) return
    hydratingConversationIds.add(conversationId)

    try {
      const conversationsClient = await getConversationsClient()
      const serverMessages = await conversationsClient.listMessages(conversationId)
      const messages = mapServerMessagesToChatMessages(serverMessages)
      if (messages.length === 0) return

      const { conversations, currentConversation, isStreaming, isLoading } = get()
      const target = conversations.find((c) => c.id === conversationId)
      // The session may have been deleted or received live messages while the
      // fetch was in flight — never overwrite newer local state.
      if (!target || target.messages.length > 0) return

      const hydrated: Conversation = { ...target, messages }
      const isCurrent = currentConversation?.id === conversationId

      set(
        {
          conversations: updateConversationInList(conversations, hydrated),
          ...(isCurrent && { currentConversation: hydrated }),
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
          (c) => c.userId === userId && conversationMatchesProject(c, projectId)
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
          thinkingSteps: [],
          activeThinkingStepId: null,
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
        'setCurrentUser:clearState'
      )
    }
  },

  getUserConversations: () => {
    const { conversations, currentUserId, projectId } = get()
    if (!currentUserId) return []
    // Scoped to the active project context; legacy sessions without a
    // projectId fail open (see lib/project-scope.ts).
    return conversations.filter(
      (c) => c.userId === currentUserId && conversationMatchesProject(c, projectId)
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
      ...createNewConversation(currentUserId, projectId ?? null),
      enabledDataSourceIds: defaultEnabledDataSourceIds,
    }
    set(
      (state) => ({
        conversations: [newConversation, ...state.conversations],
        currentConversation: newConversation,
        thinkingSteps: [],
        activeThinkingStepId: null,
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
        isStreaming: false,
        isLoading: false,
        currentUserMessageId: null,
        thinkingSteps: [],
        activeThinkingStepId: null,
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

    const cleanedUpIds = ensureStorageCapacity(currentConversation?.id ?? null, currentUserId)
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

    const layoutState = useLayoutStore.getState()
    const defaultEnabledDataSourceIds = getDefaultEnabledDataSourceIds()
    layoutState.setEnabledDataSources(defaultEnabledDataSourceIds)
    const newConversation: Conversation = {
      ...createNewConversation(currentUserId, projectId ?? null),
      enabledDataSourceIds: defaultEnabledDataSourceIds,
    }
    set(
      (state) => ({
        conversations: [newConversation, ...state.conversations],
        currentConversation: newConversation,
        thinkingSteps: [],
        activeThinkingStepId: null,
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
      }),
      false,
      'ensureSession'
    )
    return newConversation.id
  },

  selectConversation: (conversationId: string) => {
    const beforeLeave = get()
    const leavingId =
      beforeLeave.currentConversation?.id &&
      beforeLeave.currentConversation.id !== conversationId
        ? beforeLeave.currentConversation.id
        : undefined

    if (leavingId) {
      maybeDiscardAbandonedUploadOnlySession(get, leavingId)
    }

    const {
      conversations,
      currentUserId,
      currentConversation,
      projectId,
      isDeepResearchStreaming,
      deepResearchOwnerConversationId,
      activeDeepResearchMessageId,
      deepResearchLastEventId,
    } = get()

    if (currentConversation?.id !== conversationId) {
      const cleanedUpIds = ensureStorageCapacity(conversationId, currentUserId)
      if (cleanedUpIds.length > 0) {
        // Keep in-memory state in sync or persist resurrects the sessions.
        const deleted = new Set(cleanedUpIds)
        set(
          (state) => ({ conversations: state.conversations.filter((c) => !deleted.has(c.id)) }),
          false,
          'storageCleanupPrune'
        )
      }
    }

    const conversation = conversations.find((c) => c.id === conversationId)

    // Ownership AND project-context guard: a stale URL or persisted state
    // must never activate another project's session under this project's
    // WebSocket projectId (cross-project retrieval bleed, UX-8).
    if (
      conversation &&
      conversation.userId === currentUserId &&
      conversationMatchesProject(conversation, projectId)
    ) {
      if (
        currentConversation &&
        currentConversation.id !== conversationId &&
        isDeepResearchStreaming &&
        deepResearchOwnerConversationId === currentConversation.id &&
        activeDeepResearchMessageId
      ) {
        get().patchConversationMessage(
          deepResearchOwnerConversationId,
          activeDeepResearchMessageId,
          { deepResearchLastEventId: deepResearchLastEventId || undefined }
        )
        get().persistDeepResearchToSession()
      }

      useLayoutStore.getState().closeRightPanel()

      set(
        {
          currentConversation: conversation,
          deepResearchJobId: null,
          deepResearchLastEventId: null,
          isDeepResearchStreaming: false,
          deepResearchStatus: null,
          deepResearchOwnerConversationId: null,
          activeDeepResearchMessageId: null,
          deepResearchCitations: [],
          deepResearchTodos: [],
          deepResearchLLMSteps: [],
          deepResearchAgents: [],
          deepResearchToolCalls: [],
          deepResearchFiles: [],
          deepResearchStreamLoaded: false,
          reportContent: '',
          reportContentCategory: null,
        },
        false,
        'selectConversation'
      )

      get().restoreSessionState(conversation)
      restoreConversationDataSources(conversation)

      // Past chats whose messages were pruned from localStorage (or that came
      // from another device) repopulate from the server-persisted history.
      if (conversation.messages.length === 0) {
        void get().hydrateConversationMessages(conversation.id)
      }
    }
  },

  deleteConversation: (conversationId: string) => {
    const {
      currentConversation,
      conversations,
      deepResearchJobId,
      isDeepResearchStreaming,
      composerDrafts,
    } = get()

    const conversationToDelete = conversations.find((c) => c.id === conversationId)

    let jobIdToCancel: string | null = null

    if (
      currentConversation?.id === conversationId &&
      isDeepResearchStreaming &&
      deepResearchJobId
    ) {
      jobIdToCancel = deepResearchJobId
    } else if (conversationToDelete) {
      const lastAgentResponse = [...conversationToDelete.messages]
        .reverse()
        .find((m) => m.messageType === 'agent_response' && m.deepResearchJobId)

      if (
        lastAgentResponse?.deepResearchJobId &&
        lastAgentResponse.deepResearchJobStatus !== 'success' &&
        lastAgentResponse.deepResearchJobStatus !== 'failure' &&
        lastAgentResponse.deepResearchJobStatus !== 'interrupted'
      ) {
        jobIdToCancel = lastAgentResponse.deepResearchJobId
      }
    }

    if (jobIdToCancel) {
      import('@/adapters/api/deep-research-client').then(({ cancelJob }) => {
        cancelJob(jobIdToCancel!).catch((err) => {
          console.warn('Failed to cancel deep research job on session delete:', err)
          const t = getStoreTranslator('chat')
          toast.error(t('sessionActions.researchMayStillRunTitle'), {
            description: t('sessionActions.researchMayStillRunDescription'),
          })
        })
      })
    }

    const updatedConversations = conversations.filter((c) => c.id !== conversationId)

    // Drop the removed session's draft so it can't orphan (or resurface if the
    // id is ever reused).
    let nextComposerDrafts = composerDrafts
    if (conversationId in composerDrafts) {
      nextComposerDrafts = { ...composerDrafts }
      delete nextComposerDrafts[conversationId]
    }

    const isCurrentWithActiveResearch =
      currentConversation?.id === conversationId && isDeepResearchStreaming

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
        ...(isCurrentWithActiveResearch && {
          deepResearchJobId: null,
          deepResearchLastEventId: null,
          isDeepResearchStreaming: false,
          deepResearchStatus: null,
          deepResearchOwnerConversationId: null,
          activeDeepResearchMessageId: null,
          deepResearchCitations: [],
          deepResearchTodos: [],
          deepResearchLLMSteps: [],
          deepResearchAgents: [],
          deepResearchToolCalls: [],
          deepResearchFiles: [],
          deepResearchStreamLoaded: false,
          reportContent: '',
          reportContentCategory: null,
        }),
      },
      false,
      'deleteConversation'
    )
  },

  deleteAllConversations: () => {
    const {
      conversations,
      currentUserId,
      currentConversation,
      projectId,
      isDeepResearchStreaming,
      deepResearchJobId,
      composerDrafts,
    } = get()

    if (!currentUserId) return

    // Scope: delete exactly what the sessions panel shows in the current
    // context — the active project's sessions plus unscoped legacy sessions
    // (fail-open display rule, see lib/project-scope.ts). Sessions stamped
    // with a DIFFERENT project are never touched, so "delete all" cannot
    // silently wipe another project's history (UX-8).
    const isInScope = (c: Conversation): boolean =>
      c.userId === currentUserId && conversationMatchesProject(c, projectId)

    const userConversations = conversations.filter(isInScope)

    const jobIdsToCancel: string[] = []

    if (isDeepResearchStreaming && deepResearchJobId) {
      jobIdsToCancel.push(deepResearchJobId)
    }

    for (const conv of userConversations) {
      const lastAgentResponse = [...conv.messages]
        .reverse()
        .find((m) => m.messageType === 'agent_response' && m.deepResearchJobId)

      if (
        lastAgentResponse?.deepResearchJobId &&
        lastAgentResponse.deepResearchJobStatus !== 'success' &&
        lastAgentResponse.deepResearchJobStatus !== 'failure' &&
        lastAgentResponse.deepResearchJobStatus !== 'interrupted' &&
        !jobIdsToCancel.includes(lastAgentResponse.deepResearchJobId)
      ) {
        jobIdsToCancel.push(lastAgentResponse.deepResearchJobId)
      }
    }

    if (jobIdsToCancel.length > 0) {
      import('@/adapters/api/deep-research-client').then(async ({ cancelJob }) => {
        const results = await Promise.allSettled(
          jobIdsToCancel.map((jobId) => cancelJob(jobId))
        )

        const failedCount = results.filter((result) => result.status === 'rejected').length
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') return
          console.warn(
            'Failed to cancel deep research job on delete all sessions:',
            jobIdsToCancel[index],
            result.reason
          )
        })
        if (failedCount > 0) {
          const t = getStoreTranslator('chat')
          toast.error(
            t('sessionActions.researchRunsMayStillRunTitle', {
              count: failedCount,
              runLabel:
                failedCount === 1
                  ? t('sessionActions.runSingular')
                  : t('sessionActions.runPlural'),
            }),
            {
              description: t('sessionActions.researchRunsMayStillRunDescription'),
            }
          )
        }
      })
    }

    if (projectId) {
      // Project-scoped delete: only clear cached deep-research streams that
      // belong to the sessions being deleted; other projects' cached
      // streams stay intact.
      const jobIdsToClear = new Set<string>()
      for (const conv of userConversations) {
        for (const message of conv.messages) {
          if (message.deepResearchJobId) jobIdsToClear.add(message.deepResearchJobId)
        }
      }
      jobIdsToClear.forEach((jobId) => clearDeepResearchSession(jobId))
    } else {
      clearAllDeepResearchSessions()
    }

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
        deepResearchJobId: null,
        deepResearchLastEventId: null,
        isDeepResearchStreaming: false,
        deepResearchStatus: null,
        deepResearchOwnerConversationId: null,
        activeDeepResearchMessageId: null,
        deepResearchCitations: [],
        deepResearchTodos: [],
        deepResearchLLMSteps: [],
        deepResearchAgents: [],
        deepResearchToolCalls: [],
        deepResearchFiles: [],
        deepResearchStreamLoaded: false,
        thinkingSteps: [],
        activeThinkingStepId: null,
        reportContent: '',
        reportContentCategory: null,
        currentStatus: null,
        planMessages: [],
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

    // Deep-research conversations already derive a report title from their
    // plan (see use-websocket-chat onPlan); don't override it with a chat name.
    const isDeepResearch = conversation.messages.some(
      (m) => m.messageType === 'deep_research_banner' || Boolean(m.deepResearchJobId),
    )
    if (isDeepResearch) return

    const userMessages = conversation.messages.filter((m) => m.messageType === 'user')
    // Only name the opening exchange — one user question, now answered.
    if (userMessages.length !== 1) return

    const firstQuestion = messagePlainText(userMessages[0])
    if (!firstQuestion) return

    const firstAnswer = conversation.messages.find(
      (m) => m.messageType === 'agent_response' && messagePlainText(m).length > 0,
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
        conversationsClient.generateTitle(conversationId, payload, getActiveLocale()),
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
    const allSteps = conversation.messages
      .filter((m) => m.thinkingSteps && m.thinkingSteps.length > 0)
      .flatMap((m) => m.thinkingSteps!)

    const lastAgentResponse = [...conversation.messages]
      .reverse()
      .find((m) => m.messageType === 'agent_response')

    const unrespondedPrompt = [...conversation.messages]
      .reverse()
      .find((m) => m.messageType === 'prompt' && !m.isPromptResponded)

    let restoredPendingInteraction: PendingInteraction | null = null
    if (
      unrespondedPrompt?.promptId &&
      unrespondedPrompt?.promptParentId &&
      unrespondedPrompt?.promptInputType
    ) {
      restoredPendingInteraction = {
        id: unrespondedPrompt.promptId,
        parentId: unrespondedPrompt.promptParentId,
        inputType: unrespondedPrompt.promptInputType,
        text: unrespondedPrompt.content,
        options: unrespondedPrompt.promptOptions,
      }
    }

    const restoredPlanMessages =
      unrespondedPrompt?.planMessages || lastAgentResponse?.planMessages || []

    const restoredDeepResearchTodos = lastAgentResponse?.deepResearchTodos || []

    set(
      {
        thinkingSteps: allSteps,
        activeThinkingStepId: null,
        reportContent: '',
        reportContentCategory: null,
        deepResearchCitations: [],
        deepResearchTodos: restoredDeepResearchTodos,
        deepResearchLLMSteps: [],
        deepResearchAgents: [],
        deepResearchToolCalls: [],
        deepResearchFiles: [],
        planMessages: restoredPlanMessages,
        isStreaming: false,
        isLoading: false,
        currentStatus: null,
        pendingInteraction: restoredPendingInteraction,
        deepResearchJobId: lastAgentResponse?.deepResearchJobId || null,
        deepResearchLastEventId: null,
        isDeepResearchStreaming: false,
        deepResearchStatus: null,
        activeDeepResearchMessageId: lastAgentResponse?.id || null,
        deepResearchOwnerConversationId: conversation.id,
        deepResearchStreamLoaded: false,
      },
      false,
      'restoreSessionState'
    )

    if (!restoredPendingInteraction) {
      const meaningfulTypes = new Set([
        'user',
        'assistant',
        'agent_response',
        'error',
        'prompt',
      ])
      const lastMeaningful = [...conversation.messages]
        .reverse()
        .find((m) => meaningfulTypes.has(m.messageType ?? ''))

      if (lastMeaningful?.messageType === 'user' && lastMeaningful.thinkingSteps?.length) {
        // The turn LOOKS interrupted (last meaningful local message is the user
        // turn, with thinking steps but no assistant reply). But the client may
        // simply have been disconnected when the terminal frame was sent — the
        // backend finishes the turn and persists the response server-side in
        // that case. Refetch server history first: if the finished assistant
        // message is there, render it and skip the banner. Only when the
        // refetch yields nothing do we fall back to today's interrupted banner.
        const interruptedUserId = lastMeaningful.id
        void (async () => {
          const recovered = await get()._recoverInterruptedAssistantMessage(
            conversation.id,
            interruptedUserId
          )
          if (!recovered) {
            // No explicit message: ErrorBanner localizes the registry default
            // via `agent.response_interrupted`'s messageKey.
            get().addErrorCard('agent.response_interrupted')
          }
        })()
      }
    }
  },

  _recoverInterruptedAssistantMessage: async (
    conversationId: string,
    afterUserMessageId: string
  ): Promise<boolean> => {
    // Signal the "checking for a finished answer" UI (FIX 3) for the duration
    // of the fetch. Both callers (restoreSessionState on mount, and the
    // reconnect handler in use-websocket-chat) go through here, so the calmer
    // recovery-pending copy shows on every recovery attempt and the
    // lost/interrupted UI only appears after this settles to false.
    set({ isRecoveryPending: true }, false, 'recoveryPending:start')
    try {
      const conversationsClient = await getConversationsClient()
      const serverMessages = await conversationsClient.listMessages(conversationId)
      const mapped = mapServerMessagesToChatMessages(serverMessages)

      const { conversations, currentConversation, isStreaming } = get()
      const target = conversations.find((c) => c.id === conversationId)
      // A live stream (or a deleted session) supersedes recovery: never fold
      // stale server history over newer local state.
      if (!target || isStreaming) return false

      const localIds = new Set(target.messages.map((m) => m.id))

      // The recovered response is the assistant message the server persisted
      // for THIS turn: it comes after the interrupted user message and is not
      // already in local history.
      const userIdx = mapped.findIndex((m) => m.id === afterUserMessageId)
      const searchSpace = userIdx >= 0 ? mapped.slice(userIdx + 1) : mapped
      const recovered = searchSpace.find(
        (m) => m.role === 'assistant' && !localIds.has(m.id)
      )
      if (!recovered) return false

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
      return true
    } catch (err) {
      console.warn('[recoverInterruptedAssistantMessage] Failed:', err)
      return false
    } finally {
      set({ isRecoveryPending: false }, false, 'recoveryPending:end')
    }
  },

  isSessionBusy: (conversationId: string) => {
    const state = get()

    if (state.currentConversation?.id === conversationId && state.isStreaming) {
      return true
    }

    if (
      state.deepResearchOwnerConversationId === conversationId &&
      state.isDeepResearchStreaming
    ) {
      return true
    }

    const conversation = state.conversations.find((c) => c.id === conversationId)
    if (conversation && hasActiveDeepResearchJob(conversation.messages)) {
      return true
    }

    return false
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
                  ...(message.promptType && { promptType: message.promptType }),
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
        },
        createdAt: message.timestamp instanceof Date
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
        respondedAt: new Date().toISOString(),
      })
    } catch (err) {
      // Best-effort, like the other mirrors: the answer already reached the agent
      // over the socket and is rendered from the store. Losing this costs the
      // transcript, not the turn.
      console.warn('[persistPromptState] Failed:', err)
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
    const assistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant')

    const targets: Array<[string, Record<string, unknown>]> = []

    if (userMessage?.thinkingSteps?.length) {
      // The COMPACT form — the same one localStorage keeps, so a thread restored
      // from the server and one restored from the browser look identical rather
      // than differing in ways nobody would predict.
      targets.push([
        userMessage.id,
        { thinkingSteps: stripThinkingStepsForStorage(userMessage.thinkingSteps) },
      ])
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
      if (assistantMessage.routingReason) provenance.routingReason = assistantMessage.routingReason
      if (assistantMessage.escalationReason) {
        provenance.escalationReason = assistantMessage.escalationReason
      }
      if (assistantMessage.citationsRemoved) {
        provenance.citationsRemoved = assistantMessage.citationsRemoved
      }
      // The POINTER, not the report: a colleague fetches the document through the
      // path that already serves it rather than being handed a copy in a message
      // row.
      if (assistantMessage.deepResearchJobId) {
        provenance.deepResearchJobId = assistantMessage.deepResearchJobId
      }
      if (assistantMessage.showViewReport) provenance.showViewReport = true

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
