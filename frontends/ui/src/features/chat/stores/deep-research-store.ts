import { v4 as uuidv4 } from 'uuid'
import type { StateCreator } from 'zustand'
import type {
  ChatStore,
  ChatMessage,
  CitationSource,
  DeepResearchJobStatus,
  DeepResearchTodo,
  DeepResearchLLMStep,
  DeepResearchAgent,
  DeepResearchToolCall,
  DeepResearchFile,
  DeepResearchBannerType,
  PendingInteraction,
  PlanMessage,
} from '../types'
import { normalizeDeepResearchTodos } from '../lib/deep-research-todos'
import {
  saveDeepResearchToSession,
  clearDeepResearchSession,
} from '../lib/deep-research-session-storage'
import { isUnavailableDeepResearchJobError } from '../lib/deep-research-errors'
import { patchConversationMessageById } from './sessions-store'
import { validateGridCards, type GridCard } from '@/shared/cards/schemas'

export type DeepResearchSlice = {
  deepResearchJobId: string | null
  deepResearchLastEventId: string | null
  isDeepResearchStreaming: boolean
  deepResearchStatus: DeepResearchJobStatus | null
  deepResearchOwnerConversationId: string | null
  activeDeepResearchMessageId: string | null
  deepResearchCitations: CitationSource[]
  deepResearchTodos: DeepResearchTodo[]
  deepResearchLLMSteps: DeepResearchLLMStep[]
  deepResearchAgents: DeepResearchAgent[]
  deepResearchToolCalls: DeepResearchToolCall[]
  deepResearchFiles: DeepResearchFile[]
  deepResearchCards: GridCard[]
  deepResearchStreamLoaded: boolean
  /** No live SSE events for a while though the stream is still open (UX-11a). */
  isDeepResearchStalled: boolean
  /** SSE retries exhausted: the stream is gone but the job may still run server-side (UX-11b). */
  deepResearchConnectionLost: boolean
  /** Reconnect handler registered by useDeepResearch so panel components can recover. */
  reconnectDeepResearchFn: (() => void) | null
  planMessages: PlanMessage[]
  pendingInteraction: PendingInteraction | null
  respondToInteractionFn: ((response: string) => void) | null

  startDeepResearch: (jobId: string, messageId?: string) => void
  updateDeepResearchStatus: (status: DeepResearchJobStatus) => void
  completeDeepResearch: () => void
  setDeepResearchStalled: (stalled: boolean) => void
  setDeepResearchConnectionLost: (lost: boolean) => void
  setReconnectDeepResearchFn: (fn: (() => void) | null) => void
  addDeepResearchCitation: (url: string, content: string, isCited?: boolean) => void
  setDeepResearchTodos: (todos: Array<{ content: string; status: string }>) => void
  stopDeepResearchTodos: () => void
  stopAllDeepResearchSpinners: (isSuccessfulCompletion?: boolean) => void
  clearDeepResearch: () => void
  setLoadedJobId: (jobId: string) => void
  setStreamLoaded: (loaded: boolean) => void
  setDeepResearchLastEventId: (eventId: string | null) => void
  persistDeepResearchToSession: () => void
  saveDeepResearchProgress: () => void
  reconnectToActiveJob: () => Promise<void>
  cleanupOrphanedStartingBanners: () => Promise<void>
  refreshDeepResearchSessionStatuses: () => Promise<void>
  addDeepResearchLLMStep: (
    step: Omit<DeepResearchLLMStep, 'id' | 'timestamp' | 'isComplete'>
  ) => string
  appendToDeepResearchLLMStep: (stepId: string, content: string) => void
  completeDeepResearchLLMStep: (
    stepId: string,
    thinking?: string,
    usage?: { input_tokens: number; output_tokens: number }
  ) => void
  addDeepResearchAgent: (agent: Omit<DeepResearchAgent, 'id' | 'startedAt' | 'status'>) => string
  addDeepResearchAgentWithId: (
    id: string,
    agent: Omit<DeepResearchAgent, 'id' | 'startedAt' | 'status'>
  ) => string
  completeDeepResearchAgent: (agentId: string, output?: string) => void
  addDeepResearchToolCall: (
    toolCall: Omit<DeepResearchToolCall, 'id' | 'timestamp' | 'status'>
  ) => string
  completeDeepResearchToolCall: (toolCallId: string, output?: string) => void
  getAgentToolCalls: (agentId: string) => DeepResearchToolCall[]
  addDeepResearchFile: (file: Omit<DeepResearchFile, 'id' | 'timestamp'>) => string
  setDeepResearchCards: (cards: unknown) => void
  addPlanMessage: (message: Omit<PlanMessage, 'id' | 'timestamp'>) => string
  updatePlanMessageResponse: (messageId: string, response: string) => void
  clearPlanMessages: () => void
  persistPlanMessages: () => void
  setPendingInteraction: (interaction: PendingInteraction | null) => void
  clearPendingInteraction: () => void
  setRespondToInteractionFn: (fn: ((response: string) => void) | null) => void
}

let deepResearchTodoPersistTimer: ReturnType<typeof setTimeout> | null = null

const clearDeepResearchTodoPersistTimer = (): void => {
  if (deepResearchTodoPersistTimer) {
    clearTimeout(deepResearchTodoPersistTimer)
    deepResearchTodoPersistTimer = null
  }
}

const areDeepResearchTodosEqual = (
  left: DeepResearchTodo[] | undefined,
  right: DeepResearchTodo[] | undefined
): boolean => {
  const leftTodos = left ?? []
  const rightTodos = right ?? []
  if (leftTodos.length !== rightTodos.length) return false

  return leftTodos.every((todo, index) => {
    const other = rightTodos[index]
    return todo.id === other.id && todo.content === other.content && todo.status === other.status
  })
}

const DEEP_RESEARCH_TODO_PERSIST_DEBOUNCE_MS = 1000

const updateConversationInList = (
  conversations: ChatStore['conversations'],
  updatedConversation: (ChatStore['conversations'])[number]
): ChatStore['conversations'] => {
  return conversations.map((c) => (c.id === updatedConversation.id ? updatedConversation : c))
}

const getLatestDeepResearchMessage = (conversation: ChatStore['conversations'][number]): ChatMessage | null => {
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
  conversation: ChatStore['conversations'][number],
  jobId: string,
  patch: Partial<ChatMessage>
): ChatStore['conversations'][number] => {
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

const withDeepResearchBanner = (
  conversation: ChatStore['conversations'][number],
  bannerType: DeepResearchBannerType,
  jobId: string,
  stats?: { totalTokens?: number; toolCallCount?: number }
): ChatStore['conversations'][number] => {
  const createBannerMessage = (): ChatMessage => ({
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
    },
    ...(bannerType === 'starting' && {
      deepResearchJobId: jobId,
      deepResearchJobStatus: 'submitted' as const,
      isDeepResearchActive: true,
    }),
  })

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
    messages: [...filteredMessages, createBannerMessage()],
    updatedAt: new Date(),
  }
}

export const initialDeepResearchState = {
  deepResearchJobId: null as string | null,
  deepResearchLastEventId: null as string | null,
  isDeepResearchStreaming: false,
  deepResearchStatus: null as DeepResearchJobStatus | null,
  deepResearchOwnerConversationId: null as string | null,
  activeDeepResearchMessageId: null as string | null,
  deepResearchCitations: [] as CitationSource[],
  deepResearchTodos: [] as DeepResearchTodo[],
  deepResearchLLMSteps: [] as DeepResearchLLMStep[],
  deepResearchAgents: [] as DeepResearchAgent[],
  deepResearchToolCalls: [] as DeepResearchToolCall[],
  deepResearchFiles: [] as DeepResearchFile[],
  deepResearchCards: [] as GridCard[],
  deepResearchStreamLoaded: false,
  isDeepResearchStalled: false,
  deepResearchConnectionLost: false,
  reconnectDeepResearchFn: null as (() => void) | null,
  planMessages: [] as PlanMessage[],
  pendingInteraction: null as PendingInteraction | null,
  respondToInteractionFn: null as ((response: string) => void) | null,
}

export const createDeepResearchSlice: StateCreator<ChatStore, [["zustand/devtools", never]], [], DeepResearchSlice> = (set, get) => ({
  ...initialDeepResearchState,

  startDeepResearch: (jobId: string, messageId?: string) => {
    const { currentConversation } = get()
    set(
      {
        deepResearchJobId: jobId,
        deepResearchLastEventId: null,
        isDeepResearchStreaming: true,
        deepResearchStatus: 'submitted',
        deepResearchOwnerConversationId: currentConversation?.id || null,
        activeDeepResearchMessageId: messageId || null,
        reportContent: '',
        reportContentCategory: null,
        deepResearchCitations: [],
        deepResearchTodos: [],
        deepResearchLLMSteps: [],
        deepResearchAgents: [],
        deepResearchToolCalls: [],
        deepResearchFiles: [],
        deepResearchCards: [],
        deepResearchStreamLoaded: false,
        isDeepResearchStalled: false,
        deepResearchConnectionLost: false,
      },
      false,
      'startDeepResearch'
    )
  },

  updateDeepResearchStatus: (status: DeepResearchJobStatus) => {
    set({ deepResearchStatus: status }, false, 'updateDeepResearchStatus')
  },

  completeDeepResearch: () => {
    const { deepResearchJobId } = get()
    if (deepResearchJobId) {
      clearDeepResearchSession(deepResearchJobId)
    }
    set(
      {
        isDeepResearchStreaming: false,
        // A terminal outcome supersedes any transient recovery state.
        isDeepResearchStalled: false,
        deepResearchConnectionLost: false,
      },
      false,
      'completeDeepResearch'
    )
  },

  setDeepResearchStalled: (stalled: boolean) => {
    if (get().isDeepResearchStalled === stalled) return
    set({ isDeepResearchStalled: stalled }, false, 'setDeepResearchStalled')
  },

  setDeepResearchConnectionLost: (lost: boolean) => {
    if (get().deepResearchConnectionLost === lost) return
    set({ deepResearchConnectionLost: lost }, false, 'setDeepResearchConnectionLost')
  },

  setReconnectDeepResearchFn: (fn: (() => void) | null) => {
    set({ reconnectDeepResearchFn: fn }, false, 'setReconnectDeepResearchFn')
  },

  addDeepResearchCitation: (url: string, content: string, isCited?: boolean) => {
    const { deepResearchCitations } = get()

    const existingIndex = deepResearchCitations.findIndex((c) => c.url === url)

    if (existingIndex >= 0) {
      const updatedCitations = deepResearchCitations.map((c, i) => {
        if (i === existingIndex) {
          return {
            ...c,
            content: content || c.content,
            isCited: isCited || c.isCited,
          }
        }
        return c
      })

      set(
        { deepResearchCitations: updatedCitations },
        false,
        'addDeepResearchCitation:update'
      )
    } else {
      const newCitation: CitationSource = {
        id: uuidv4(),
        url,
        content,
        timestamp: new Date(),
        isCited,
      }

      set(
        {
          deepResearchCitations: [...deepResearchCitations, newCitation],
        },
        false,
        'addDeepResearchCitation'
      )
    }
  },

  setDeepResearchTodos: (todos: Array<{ content: string; status: string }>) => {
    const typedTodos = normalizeDeepResearchTodos(todos)
    const {
      conversations,
      deepResearchOwnerConversationId,
      activeDeepResearchMessageId,
    } = get()

    if (!deepResearchOwnerConversationId || !activeDeepResearchMessageId) {
      set({ deepResearchTodos: typedTodos }, false, 'setDeepResearchTodos')
      return
    }

    const targetConversation = conversations.find(
      (conversation) => conversation.id === deepResearchOwnerConversationId
    )

    if (!targetConversation) {
      set({ deepResearchTodos: typedTodos }, false, 'setDeepResearchTodos')
      return
    }

    set({ deepResearchTodos: typedTodos }, false, 'setDeepResearchTodos')

    if (deepResearchTodoPersistTimer) {
      clearTimeout(deepResearchTodoPersistTimer)
    }

    const scheduledOwnerConversationId = deepResearchOwnerConversationId
    const scheduledMessageId = activeDeepResearchMessageId

    deepResearchTodoPersistTimer = setTimeout(() => {
      deepResearchTodoPersistTimer = null

      const latestState = get()
      if (
        latestState.deepResearchOwnerConversationId !== scheduledOwnerConversationId ||
        latestState.activeDeepResearchMessageId !== scheduledMessageId
      ) {
        return
      }

      const latestConversation = latestState.conversations.find(
        (conversation) => conversation.id === scheduledOwnerConversationId
      )
      if (!latestConversation) return

      const latestMessage = latestConversation.messages.find(
        (message) => message.id === scheduledMessageId
      )
      if (areDeepResearchTodosEqual(latestMessage?.deepResearchTodos, typedTodos)) return

      const updatedConversation = patchConversationMessageById(
        latestConversation,
        scheduledMessageId,
        { deepResearchTodos: typedTodos }
      )
      const updatedConversations = updateConversationInList(
        latestState.conversations,
        updatedConversation
      )
      const updatedCurrent =
        latestState.currentConversation?.id === updatedConversation.id
          ? updatedConversation
          : latestState.currentConversation

      set(
        {
          conversations: updatedConversations,
          currentConversation: updatedCurrent,
        },
        false,
        'setDeepResearchTodos:persist'
      )
    }, DEEP_RESEARCH_TODO_PERSIST_DEBOUNCE_MS)
  },

  stopDeepResearchTodos: () => {
    clearDeepResearchTodoPersistTimer()

    const {
      currentConversation,
      conversations,
      deepResearchTodos,
      deepResearchOwnerConversationId,
      activeDeepResearchMessageId,
    } = get()
    const stoppedTodos = deepResearchTodos.map((todo) => ({
      ...todo,
      status:
        todo.status === 'in_progress' || todo.status === 'pending'
          ? ('stopped' as const)
          : todo.status,
    }))

    if (!deepResearchOwnerConversationId || !activeDeepResearchMessageId) {
      set({ deepResearchTodos: stoppedTodos }, false, 'stopDeepResearchTodos')
      return
    }

    const targetConversation = conversations.find(
      (conversation) => conversation.id === deepResearchOwnerConversationId
    )

    if (!targetConversation) {
      set({ deepResearchTodos: stoppedTodos }, false, 'stopDeepResearchTodos')
      return
    }

    const updatedConversation = patchConversationMessageById(
      targetConversation,
      activeDeepResearchMessageId,
      { deepResearchTodos: stoppedTodos }
    )
    const updatedConversations = updateConversationInList(conversations, updatedConversation)
    const updatedCurrent =
      currentConversation?.id === updatedConversation.id ? updatedConversation : currentConversation

    set(
      {
        deepResearchTodos: stoppedTodos,
        conversations: updatedConversations,
        currentConversation: updatedCurrent,
      },
      false,
      'stopDeepResearchTodos'
    )
  },

  stopAllDeepResearchSpinners: (isSuccessfulCompletion = false) => {
    const {
      currentConversation,
      conversations,
      deepResearchTodos,
      deepResearchLLMSteps,
      deepResearchAgents,
      deepResearchToolCalls,
      deepResearchOwnerConversationId,
      activeDeepResearchMessageId,
    } = get()

    const stoppedTodos = deepResearchTodos.map((todo) => ({
      ...todo,
      status:
        todo.status === 'in_progress' || todo.status === 'pending'
          ? isSuccessfulCompletion
            ? ('completed' as const)
            : ('stopped' as const)
          : todo.status,
    }))

    const stoppedLLMSteps = deepResearchLLMSteps.map((step) => ({
      ...step,
      isComplete: true,
    }))

    const stoppedAgents = deepResearchAgents.map((agent) => ({
      ...agent,
      status:
        agent.status === 'running'
          ? isSuccessfulCompletion
            ? ('complete' as const)
            : ('error' as const)
          : agent.status,
    }))

    const stoppedToolCalls = deepResearchToolCalls.map((toolCall) => ({
      ...toolCall,
      status:
        toolCall.status === 'running'
          ? isSuccessfulCompletion
            ? ('complete' as const)
            : ('error' as const)
          : toolCall.status,
    }))

    const update = {
      deepResearchTodos: stoppedTodos,
      deepResearchLLMSteps: stoppedLLMSteps,
      deepResearchAgents: stoppedAgents,
      deepResearchToolCalls: stoppedToolCalls,
    }

    if (!deepResearchOwnerConversationId || !activeDeepResearchMessageId) {
      set(update, false, 'stopAllDeepResearchSpinners')
      return
    }

    const targetConversation = conversations.find(
      (conversation) => conversation.id === deepResearchOwnerConversationId
    )

    if (!targetConversation) {
      set(update, false, 'stopAllDeepResearchSpinners')
      return
    }

    const updatedConversation = patchConversationMessageById(
      targetConversation,
      activeDeepResearchMessageId,
      { deepResearchTodos: stoppedTodos }
    )
    const updatedConversations = updateConversationInList(conversations, updatedConversation)
    const updatedCurrent =
      currentConversation?.id === updatedConversation.id ? updatedConversation : currentConversation

    set(
      {
        ...update,
        conversations: updatedConversations,
        currentConversation: updatedCurrent,
      },
      false,
      'stopAllDeepResearchSpinners'
    )
  },

  clearDeepResearch: () => {
    set(
      {
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
        deepResearchCards: [],
        deepResearchStreamLoaded: false,
        isDeepResearchStalled: false,
        deepResearchConnectionLost: false,
      },
      false,
      'clearDeepResearch'
    )
  },

  setLoadedJobId: (jobId: string) => {
    set({ deepResearchJobId: jobId }, false, 'setLoadedJobId')
  },

  setStreamLoaded: (loaded: boolean) => {
    set({ deepResearchStreamLoaded: loaded }, false, 'setStreamLoaded')
  },

  setDeepResearchLastEventId: (eventId: string | null) => {
    set({ deepResearchLastEventId: eventId }, false, 'setDeepResearchLastEventId')
  },

  persistDeepResearchToSession: () => {
    const {
      deepResearchJobId,
      deepResearchLastEventId,
      deepResearchOwnerConversationId,
      activeDeepResearchMessageId,
      deepResearchStatus,
      isDeepResearchStreaming,
    } = get()

    if (!deepResearchJobId || !isDeepResearchStreaming) {
      return
    }

    saveDeepResearchToSession({
      jobId: deepResearchJobId,
      lastEventId: deepResearchLastEventId,
      ownerConversationId: deepResearchOwnerConversationId,
      activeMessageId: activeDeepResearchMessageId,
      status: deepResearchStatus,
    })
  },

  saveDeepResearchProgress: () => {
    const { currentConversation, isDeepResearchStreaming, deepResearchJobId, reportContent } =
      get()

    if (!currentConversation || !isDeepResearchStreaming || !deepResearchJobId) {
      return
    }

    const statusMessage = reportContent
      ? 'Research in progress...'
      : 'Deep research started. Progress will be restored when you return.'
    get().addAgentResponse(statusMessage, !!reportContent)
  },

  reconnectToActiveJob: async () => {
    const { currentConversation, isDeepResearchStreaming } = get()
    if (!currentConversation || isDeepResearchStreaming) return

    const conversationId = currentConversation.id

    const activeJobMessage = [...currentConversation.messages]
      .reverse()
      .find(
        (m) =>
          m.messageType === 'agent_response' &&
          m.deepResearchJobId &&
          m.isDeepResearchActive &&
          (m.deepResearchJobStatus === 'running' || m.deepResearchJobStatus === 'submitted')
      )

    if (!activeJobMessage?.deepResearchJobId) {
      return
    }

    const jobId = activeJobMessage.deepResearchJobId
    const messageId = activeJobMessage.id

    try {
      const { getJobStatus } = await import('@/adapters/api/deep-research-client')

      if (get().currentConversation?.id !== conversationId) return
      if (get().isDeepResearchStreaming) return

      const statusResponse = await getJobStatus(jobId)
      const currentStatus = statusResponse.status

      if (get().currentConversation?.id !== conversationId) return
      if (get().isDeepResearchStreaming) return

      if (currentStatus === 'running' || currentStatus === 'submitted') {
        set(
          {
            deepResearchJobId: jobId,
            deepResearchLastEventId: null,
            isDeepResearchStreaming: true,
            deepResearchStatus: currentStatus,
            deepResearchOwnerConversationId: conversationId,
            activeDeepResearchMessageId: messageId,
            deepResearchCitations: [],
            deepResearchTodos: [],
            deepResearchLLMSteps: [],
            deepResearchAgents: [],
            deepResearchToolCalls: [],
            deepResearchFiles: [],
            deepResearchCards: [],
            deepResearchStreamLoaded: false,
            reportContent: '',
            reportContentCategory: null,
            currentStatus: 'researching',
          },
          false,
          'reconnectToActiveJob'
        )
      } else {
        clearDeepResearchSession(jobId)
        get().stopAllDeepResearchSpinners(currentStatus === 'success')
        get().patchConversationMessage(conversationId, messageId, {
          deepResearchJobStatus: currentStatus,
          isDeepResearchActive: false,
          showViewReport: currentStatus === 'success',
        })
        const terminalBannerType: DeepResearchBannerType =
          currentStatus === 'success' ? 'success' : 'failure'
        get().addDeepResearchBanner(terminalBannerType, jobId, conversationId)
      }
    } catch (error) {
      console.warn('Failed to reconnect to active job:', error)
      if (isUnavailableDeepResearchJobError(error)) {
        clearDeepResearchSession(jobId)
        get().patchConversationMessage(conversationId, activeJobMessage.id, {
          deepResearchJobStatus: 'failure',
          isDeepResearchActive: false,
          showViewReport: Boolean(activeJobMessage.reportContent?.trim()),
        })
        get().addDeepResearchBanner('failure', jobId, conversationId)
      } else {
        get().patchConversationMessage(conversationId, activeJobMessage.id, {
          isDeepResearchActive: false,
        })
      }
    }
  },

  cleanupOrphanedStartingBanners: async () => {
    const { currentConversation } = get()
    if (!currentConversation) return

    const conversationId = currentConversation.id
    const syncTrackingMessageToTerminalState = (
      jobId: string,
      terminalStatus: DeepResearchJobStatus
    ): void => {
      const conversation = get().conversations.find((c) => c.id === conversationId)
      if (!conversation) return

      const trackingMessage = [...conversation.messages]
        .reverse()
        .find((m) => m.messageType === 'agent_response' && m.deepResearchJobId === jobId)

      if (!trackingMessage?.id) return

      const hasPartialReport = Boolean(trackingMessage.reportContent?.trim())
      get().patchConversationMessage(conversationId, trackingMessage.id, {
        deepResearchJobStatus: terminalStatus,
        isDeepResearchActive: false,
        showViewReport: terminalStatus === 'success' || hasPartialReport,
      })
    }
    const bannerTypeToTerminalStatus = (
      bannerType: DeepResearchBannerType | undefined
    ): DeepResearchJobStatus => {
      if (bannerType === 'success') return 'success'
      if (bannerType === 'cancelled') return 'interrupted'
      return 'failure'
    }

    const startingBanners = currentConversation.messages.filter(
      (m) =>
        m.messageType === 'deep_research_banner' &&
        m.deepResearchBannerData?.bannerType === 'starting'
    )

    if (startingBanners.length === 0) return

    const orphanedIds: string[] = []
    const needsCheck: Array<{ bannerId: string; jobId: string }> = []

    for (const banner of startingBanners) {
      const bannerJobId = banner.deepResearchBannerData!.jobId

      const matchingTerminalBanner = currentConversation.messages.find(
        (m) =>
          m.messageType === 'deep_research_banner' &&
          m.deepResearchBannerData?.jobId === bannerJobId &&
          m.id !== banner.id &&
          ['success', 'failure', 'cancelled', 'expired'].includes(
            m.deepResearchBannerData?.bannerType || ''
          )
      )

      if (matchingTerminalBanner) {
        const terminalStatus = bannerTypeToTerminalStatus(
          matchingTerminalBanner.deepResearchBannerData?.bannerType
        )
        syncTrackingMessageToTerminalState(bannerJobId, terminalStatus)
        orphanedIds.push(banner.id)
      } else {
        needsCheck.push({ bannerId: banner.id, jobId: bannerJobId })
      }
    }

    if (orphanedIds.length > 0) {
      const conv = get().currentConversation
      if (conv && conv.id === conversationId) {
        const filtered = conv.messages.filter((m) => !orphanedIds.includes(m.id))
        const updatedConversation: ChatStore['conversations'][number] = {
          ...conv,
          messages: filtered,
          updatedAt: new Date(),
        }
        const updatedConversations = updateConversationInList(
          get().conversations,
          updatedConversation
        )
        set(
          {
            currentConversation: updatedConversation,
            conversations: updatedConversations,
          },
          false,
          'cleanupOrphanedStartingBanners/removeOrphans'
        )
      }
    }

    if (needsCheck.length > 0) {
      try {
        const { getJobStatus } = await import('@/adapters/api/deep-research-client')
        for (const { jobId } of needsCheck) {
          if (get().currentConversation?.id !== conversationId) return
          try {
            const statusResponse = await getJobStatus(jobId)
            const terminalStatuses = ['success', 'failure', 'interrupted']
            if (terminalStatuses.includes(statusResponse.status)) {
              syncTrackingMessageToTerminalState(jobId, statusResponse.status)
              const terminalType: DeepResearchBannerType =
                statusResponse.status === 'success' ? 'success' : 'failure'
              get().addDeepResearchBanner(terminalType, jobId, conversationId)
            }
          } catch (error) {
            if (isUnavailableDeepResearchJobError(error)) {
              clearDeepResearchSession(jobId)
              syncTrackingMessageToTerminalState(jobId, 'failure')
              get().addDeepResearchBanner('failure', jobId, conversationId)
            }
          }
        }
      } catch {
        // Module import failed — skip REST checks
      }
    }
  },

  refreshDeepResearchSessionStatuses: async () => {
    const { currentUserId, conversations } = get()

    if (!currentUserId) return

    const candidates = conversations
      .filter((conversation) => conversation.userId === currentUserId)
      .map((conversation) => ({
        conversation,
        message: getLatestDeepResearchMessage(conversation),
      }))
      .filter(
        (candidate): candidate is { conversation: ChatStore['conversations'][number]; message: ChatMessage } =>
          Boolean(candidate.message?.deepResearchJobId)
      )

    if (candidates.length === 0) return

    let getJobStatus: typeof import('@/adapters/api/deep-research-client').getJobStatus
    try {
      const deepResearchClient = await import('@/adapters/api/deep-research-client')
      getJobStatus = deepResearchClient.getJobStatus
    } catch {
      return
    }

    type JobRefreshResult =
      | { kind: 'reachable'; status: DeepResearchJobStatus }
      | { kind: 'unavailable' }
      | { kind: 'transient_error' }

    const checkedJobs = new Map<string, JobRefreshResult>()

    for (const { message } of candidates) {
      const jobId = message.deepResearchJobId
      if (!jobId) continue
      let result = checkedJobs.get(jobId)

      if (!result) {
        try {
          const response = await getJobStatus(jobId)
          result = { kind: 'reachable', status: response.status }
        } catch (error) {
          if (!isUnavailableDeepResearchJobError(error)) {
            result = { kind: 'transient_error' }
            checkedJobs.set(jobId, result)
            continue
          }
          result = { kind: 'unavailable' }
        }

        checkedJobs.set(jobId, result)
      }
    }

    if ([...checkedJobs.values()].every((result) => result.kind === 'transient_error')) {
      return
    }

    const latestState = get()
    const inactiveJobIds = new Set<string>()

    const updatedConversations = latestState.conversations.map((conversation) => {
      if (conversation.userId !== currentUserId) return conversation

      const message = getLatestDeepResearchMessage(conversation)
      const jobId = message?.deepResearchJobId
      if (!message || !jobId) return conversation

      const result = checkedJobs.get(jobId)
      if (!result || result.kind === 'transient_error') return conversation

      if (result.kind === 'unavailable') {
        clearDeepResearchSession(jobId)
        inactiveJobIds.add(jobId)

        const hadCompletedReport =
          isCompletedDeepResearchReportMessage(message) ||
          Boolean(message.deepResearchReportExpired)

        const patchedConversation = patchLatestDeepResearchJobMessage(conversation, jobId, {
          deepResearchJobStatus: 'failure',
          isDeepResearchActive: false,
          showViewReport: false,
          deepResearchReportExpired: hadCompletedReport,
        })

        return hadCompletedReport
          ? withDeepResearchBanner(patchedConversation, 'expired', jobId)
          : patchedConversation
      }

      if (result.status === 'submitted' || result.status === 'running') {
        return patchLatestDeepResearchJobMessage(conversation, jobId, {
          deepResearchJobStatus: result.status,
          isDeepResearchActive: true,
          deepResearchReportExpired: false,
        })
      }

      inactiveJobIds.add(jobId)
      clearDeepResearchSession(jobId)

      return patchLatestDeepResearchJobMessage(conversation, jobId, {
        deepResearchJobStatus: result.status,
        isDeepResearchActive: false,
        showViewReport: result.status === 'success' || Boolean(message.reportContent?.trim()),
        deepResearchReportExpired: false,
      })
    })

    const updatedCurrentConversation =
      latestState.currentConversation === null
        ? null
        : (updatedConversations.find(
            (conversation) => conversation.id === latestState.currentConversation?.id
          ) ?? latestState.currentConversation)

    const shouldClearActiveJob =
      latestState.deepResearchJobId !== null &&
      inactiveJobIds.has(latestState.deepResearchJobId)

    set(
      {
        conversations: updatedConversations,
        currentConversation: updatedCurrentConversation,
        ...(shouldClearActiveJob && {
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
          deepResearchCards: [],
          deepResearchStreamLoaded: false,
          reportContent: '',
          reportContentCategory: null,
          currentStatus: null,
          pendingInteraction: null,
        }),
      },
      false,
      'refreshDeepResearchSessionStatuses'
    )
  },

  addDeepResearchLLMStep: (
    step: Omit<DeepResearchLLMStep, 'id' | 'timestamp' | 'isComplete'>
  ) => {
    const stepId = uuidv4()
    const newStep: DeepResearchLLMStep = {
      ...step,
      id: stepId,
      timestamp: new Date(),
      isComplete: false,
    }

    set(
      (state) => ({
        deepResearchLLMSteps: [...state.deepResearchLLMSteps, newStep],
      }),
      false,
      'addDeepResearchLLMStep'
    )

    return stepId
  },

  appendToDeepResearchLLMStep: (stepId: string, content: string) => {
    set(
      (state) => ({
        deepResearchLLMSteps: state.deepResearchLLMSteps.map((step) =>
          step.id === stepId ? { ...step, content: step.content + content } : step
        ),
      }),
      false,
      'appendToDeepResearchLLMStep'
    )
  },

  completeDeepResearchLLMStep: (
    stepId: string,
    thinking?: string,
    usage?: { input_tokens: number; output_tokens: number }
  ) => {
    set(
      (state) => ({
        deepResearchLLMSteps: state.deepResearchLLMSteps.map((step) =>
          step.id === stepId ? { ...step, isComplete: true, thinking, usage } : step
        ),
      }),
      false,
      'completeDeepResearchLLMStep'
    )
  },

  addDeepResearchAgent: (agent: Omit<DeepResearchAgent, 'id' | 'startedAt' | 'status'>) => {
    const agentId = uuidv4()
    const newAgent: DeepResearchAgent = {
      ...agent,
      id: agentId,
      startedAt: new Date(),
      status: 'running',
    }

    set(
      (state) => ({
        deepResearchAgents: [...state.deepResearchAgents, newAgent],
      }),
      false,
      'addDeepResearchAgent'
    )

    return agentId
  },

  addDeepResearchAgentWithId: (
    id: string,
    agent: Omit<DeepResearchAgent, 'id' | 'startedAt' | 'status'>
  ) => {
    const { deepResearchAgents } = get()

    if (deepResearchAgents.some((a) => a.id === id)) {
      return id
    }

    const newAgent: DeepResearchAgent = {
      ...agent,
      id,
      startedAt: new Date(),
      status: 'running',
    }

    set(
      (state) => ({
        deepResearchAgents: [...state.deepResearchAgents, newAgent],
      }),
      false,
      'addDeepResearchAgentWithId'
    )

    return id
  },

  completeDeepResearchAgent: (agentId: string, output?: string) => {
    set(
      (state) => ({
        deepResearchAgents: state.deepResearchAgents.map((agent) =>
          agent.id === agentId
            ? { ...agent, status: 'complete' as const, output, completedAt: new Date() }
            : agent
        ),
      }),
      false,
      'completeDeepResearchAgent'
    )
  },

  addDeepResearchToolCall: (
    toolCall: Omit<DeepResearchToolCall, 'id' | 'timestamp' | 'status'>
  ) => {
    const toolCallId = uuidv4()
    const newToolCall: DeepResearchToolCall = {
      ...toolCall,
      id: toolCallId,
      timestamp: new Date(),
      status: 'running',
    }

    set(
      (state) => ({
        deepResearchToolCalls: [...state.deepResearchToolCalls, newToolCall],
      }),
      false,
      'addDeepResearchToolCall'
    )

    return toolCallId
  },

  getAgentToolCalls: (agentId: string) => {
    const { deepResearchToolCalls } = get()
    return deepResearchToolCalls.filter((tc) => tc.agentId === agentId)
  },

  completeDeepResearchToolCall: (toolCallId: string, output?: string) => {
    set(
      (state) => ({
        deepResearchToolCalls: state.deepResearchToolCalls.map((toolCall) =>
          toolCall.id === toolCallId
            ? { ...toolCall, status: 'complete' as const, output }
            : toolCall
        ),
      }),
      false,
      'completeDeepResearchToolCall'
    )
  },

  addDeepResearchFile: (file: Omit<DeepResearchFile, 'id' | 'timestamp'>) => {
    const { deepResearchFiles } = get()
    const existingIndex = deepResearchFiles.findIndex((f) => f.filename === file.filename)

    if (existingIndex >= 0) {
      const updatedFiles = deepResearchFiles.map((f, i) =>
        i === existingIndex ? { ...f, content: file.content, timestamp: new Date() } : f
      )
      set({ deepResearchFiles: updatedFiles }, false, 'addDeepResearchFile:update')
      return deepResearchFiles[existingIndex].id
    }

    const fileId = uuidv4()
    const newFile: DeepResearchFile = {
      ...file,
      id: fileId,
      timestamp: new Date(),
    }

    set(
      (state) => ({
        deepResearchFiles: [...state.deepResearchFiles, newFile],
      }),
      false,
      'addDeepResearchFile'
    )

    return fileId
  },

  setDeepResearchCards: (cards: unknown) => {
    const validated = validateGridCards(cards)
    set({ deepResearchCards: validated }, false, 'setDeepResearchCards')
  },

  addPlanMessage: (message: Omit<PlanMessage, 'id' | 'timestamp'>) => {
    const messageId = uuidv4()
    const newMessage: PlanMessage = {
      ...message,
      id: messageId,
      timestamp: new Date(),
    }

    set(
      (state) => ({
        planMessages: [...state.planMessages, newMessage],
      }),
      false,
      'addPlanMessage'
    )

    get().persistPlanMessages()

    return messageId
  },

  updatePlanMessageResponse: (messageId: string, response: string) => {
    set(
      (state) => ({
        planMessages: state.planMessages.map((msg) =>
          msg.id === messageId ? { ...msg, userResponse: response } : msg
        ),
      }),
      false,
      'updatePlanMessageResponse'
    )

    get().persistPlanMessages()
  },

  clearPlanMessages: () => {
    set({ planMessages: [] }, false, 'clearPlanMessages')
  },

  persistPlanMessages: () => {
    const { currentConversation, conversations, planMessages } = get()
    if (!currentConversation || planMessages.length === 0) return

    const messages = currentConversation.messages
    const lastPromptIndex = [...messages]
      .reverse()
      .findIndex((m) => m.messageType === 'prompt' && !m.isPromptResponded)

    if (lastPromptIndex >= 0) {
      const actualIndex = messages.length - 1 - lastPromptIndex
      const updatedMessages = messages.map((msg, idx) =>
        idx === actualIndex ? { ...msg, planMessages: [...planMessages] } : msg
      )

      const updatedConversation = {
        ...currentConversation,
        messages: updatedMessages,
        updatedAt: new Date(),
      }

      const updatedConversations = updateConversationInList(
        conversations,
        updatedConversation
      )

      set(
        {
          currentConversation: updatedConversation,
          conversations: updatedConversations,
        },
        false,
        'persistPlanMessages'
      )
    }
  },

  setPendingInteraction: (interaction: PendingInteraction | null) => {
    set({ pendingInteraction: interaction }, false, 'setPendingInteraction')
  },

  clearPendingInteraction: () => {
    set({ pendingInteraction: null }, false, 'clearPendingInteraction')
  },

  setRespondToInteractionFn: (fn) => {
    set({ respondToInteractionFn: fn }, false, 'setRespondToInteractionFn')
  },
})
