// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { v4 as uuidv4 } from 'uuid'
import { toast } from 'sonner'
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
import { pruneMessageForStorage } from '../lib/prune-message-for-storage'
import {
  logStorageWrite,
  logQuotaExceededPruning,
  logCriticalSessionsClear,
  logStorageAvailability,
} from '../lib/storage-logger'
import { ensureStorageCapacity, checkStorageHealth } from '../lib/storage-manager'
import { clearAllDeepResearchSessions } from '../lib/deep-research-session-storage'
import { hasActiveDeepResearchJob, hasNoUserChatMessages } from '../lib/session-activity'

export type SessionsSlice = {
  currentUserId: string | null
  currentConversation: Conversation | null
  conversations: Conversation[]

  loadServerConversations: () => Promise<void>
  setCurrentUser: (userId: string | null) => void
  getUserConversations: () => Conversation[]
  createConversation: () => Conversation
  startNewSessionDraft: () => void
  ensureSession: () => string | undefined
  selectConversation: (conversationId: string) => void
  deleteConversation: (conversationId: string) => void
  deleteAllConversations: () => void
  updateConversationTitle: (conversationId: string, title: string) => void
  saveDataSourcesToConversation: (ids: string[]) => void
  restoreSessionState: (conversation: Conversation) => void
  isSessionBusy: (conversationId: string) => boolean
  hasAnyBusySession: () => boolean
  _ensureConversationExists: () => Promise<void>
  _appendMessage: (message: ChatMessage) => Promise<void>
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

const createNewConversation = (userId: string): Conversation => ({
  id: `s_${uuidv4().replace(/-/g, '_')}`,
  userId,
  title: '',
  messages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
})

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

const getLatestDeepResearchMessage = (conversation: Conversation): ChatMessage | null => {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const message = conversation.messages[i]
    if (message.messageType === 'agent_response' && message.deepResearchJobId) {
      return message
    }
  }
  return null
}

const isCompletedDeepResearchReportMessage = (message: ChatMessage): boolean =>
  Boolean(
    !message.deepResearchReportExpired &&
    message.deepResearchJobId &&
    message.deepResearchJobStatus === 'success' &&
    (message.showViewReport || message.reportContent?.trim())
  )

const patchLatestDeepResearchJobMessage = (
  conversation: Conversation,
  jobId: string,
  patch: Partial<ChatMessage>
): Conversation => {
  const messageIndex = [...conversation.messages]
    .reverse()
    .findIndex(
      (message) => message.messageType === 'agent_response' && message.deepResearchJobId === jobId
    )

  if (messageIndex < 0) return conversation

  const actualIndex = conversation.messages.length - 1 - messageIndex
  const messages = conversation.messages.map((message, index) =>
    index === actualIndex ? { ...message, ...patch } : message
  )

  return { ...conversation, messages }
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
}

export const createSessionsSlice: StateCreator<ChatStore, [["zustand/devtools", never]], [], SessionsSlice> = (set, get) => ({
  ...initialSessionsState,

  loadServerConversations: async () => {
    try {
      const { conversationsClient } = await import('@/adapters/api/conversations-client')
      const serverConvs = await conversationsClient.list()
      if (!serverConvs || serverConvs.length === 0) return

      const { conversations, currentUserId } = get()
      const merged = [...conversations]

      for (const serverConv of serverConvs) {
        const idx = merged.findIndex((c) => c.id === serverConv.id)
        const local: Conversation = {
          id: serverConv.id,
          userId: serverConv.createdBy ?? currentUserId ?? 'unknown',
          title: serverConv.title ?? '',
          messages: idx >= 0 ? merged[idx].messages : [],
          createdAt: serverConv.createdAt,
          updatedAt: serverConv.updatedAt,
        }
        if (idx >= 0) {
          merged[idx] = local
        } else {
          merged.push(local)
        }
      }

      set({ conversations: merged }, false, 'loadServerConversations')
    } catch (err) {
      console.warn('[loadServerConversations] Failed to load server conversations:', err)
    }
  },

  setCurrentUser: (userId: string | null) => {
    const { conversations, currentConversation } = get()

    const shouldClearCurrent =
      currentConversation && (userId === null || currentConversation.userId !== userId)

    const userConversations = userId ? conversations.filter((c) => c.userId === userId) : []
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
    const { conversations, currentUserId } = get()
    if (!currentUserId) return []
    return conversations.filter((c) => c.userId === currentUserId)
  },

  createConversation: () => {
    const { currentUserId } = get()
    if (!currentUserId) {
      throw new Error('Cannot create conversation without authenticated user')
    }
    const layoutState = useLayoutStore.getState()
    const defaultEnabledDataSourceIds = getDefaultEnabledDataSourceIds()
    layoutState.setEnabledDataSources(defaultEnabledDataSourceIds)
    const newConversation: Conversation = {
      ...createNewConversation(currentUserId),
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
    const { currentConversation, currentUserId } = get()

    if (currentConversation?.id) {
      return currentConversation.id
    }
    if (!currentUserId) {
      return undefined
    }

    ensureStorageCapacity(currentConversation?.id ?? null, currentUserId)

    const layoutState = useLayoutStore.getState()
    const defaultEnabledDataSourceIds = getDefaultEnabledDataSourceIds()
    layoutState.setEnabledDataSources(defaultEnabledDataSourceIds)
    const newConversation: Conversation = {
      ...createNewConversation(currentUserId),
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
      isDeepResearchStreaming,
      deepResearchOwnerConversationId,
      activeDeepResearchMessageId,
      deepResearchLastEventId,
    } = get()

    if (currentConversation?.id !== conversationId) {
      ensureStorageCapacity(conversationId, currentUserId)
    }

    const conversation = conversations.find((c) => c.id === conversationId)

    if (conversation && conversation.userId === currentUserId) {
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
    }
  },

  deleteConversation: (conversationId: string) => {
    const { currentConversation, conversations, deepResearchJobId, isDeepResearchStreaming } =
      get()

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
          toast.error('Research run may still be running', {
            description:
              'The session was deleted, but its deep-research job could not be stopped on the server.',
          })
        })
      })
    }

    const updatedConversations = conversations.filter((c) => c.id !== conversationId)

    const isCurrentWithActiveResearch =
      currentConversation?.id === conversationId && isDeepResearchStreaming

    set(
      {
        conversations: updatedConversations,
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
      isDeepResearchStreaming,
      deepResearchJobId,
    } = get()

    if (!currentUserId) return

    const userConversations = conversations.filter((c) => c.userId === currentUserId)

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
          toast.error(
            `${failedCount} research ${failedCount === 1 ? 'run' : 'runs'} may still be running`,
            {
              description:
                'Sessions were deleted, but some deep-research jobs could not be stopped on the server.',
            }
          )
        }
      })
    }

    clearAllDeepResearchSessions()

    const remainingConversations = conversations.filter((c) => c.userId !== currentUserId)

    const shouldClearCurrent =
      currentConversation && currentConversation.userId === currentUserId

    set(
      {
        conversations: remainingConversations,
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
        get().addErrorCard(
          'agent.response_interrupted',
          'Your previous request was not completed. Please resend your message.'
        )
      }
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
    const { currentConversation } = get()
    if (!currentConversation) return
    const conv = currentConversation

    try {
      const { conversationsClient } = await import('@/adapters/api/conversations-client')
      const existing = await conversationsClient.list()
      const exists = existing.some((c) => c.id === conv.id)
      if (!exists) {
        await conversationsClient.create(conv.id, conv.title || undefined)
      }
    } catch (err) {
      console.warn('[ensureConversationExists] Failed:', err)
    }
  },

  _appendMessage: async (message: ChatMessage) => {
    const { currentConversation } = get()
    if (!currentConversation) return

    try {
      const { conversationsClient } = await import('@/adapters/api/conversations-client')

      const existing = await conversationsClient.list()
      const exists = existing.some((c) => c.id === currentConversation.id)
      if (!exists) {
        await conversationsClient.create(currentConversation.id, currentConversation.title || undefined)
      }

      await conversationsClient.createMessage(currentConversation.id, {
        id: message.id,
        role: message.role,
        content: message.content,
        messageType: message.messageType,
        metadata: {
          ...(message.errorData && { errorData: message.errorData }),
          ...(message.fileData && { fileData: message.fileData }),
          ...(message.cards && { cards: message.cards }),
        },
        createdAt: message.timestamp instanceof Date
          ? message.timestamp.toISOString()
          : String(message.timestamp),
      })
    } catch (err) {
      console.warn('[appendMessage] Failed:', err)
    }
  },
})
