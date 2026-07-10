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
  FileUploadStatusType,
  DeepResearchBannerType,
  Conversation,
} from '../types'
import type { GridCard } from '@/shared/cards/schemas'
import { getErrorMeta } from '../lib/error-registry'
import { useLayoutStore } from '@/features/layout/store'
import { ensureStorageCapacity, checkStorageHealth } from '../lib/storage-manager'

export type MessagesSlice = {
  isStreaming: boolean
  isLoading: boolean
  currentUserMessageId: string | null
  thinkingSteps: ThinkingStep[]
  activeThinkingStepId: string | null
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

  startAssistantMessage: () => ChatMessage
  appendToAssistantMessage: (content: string) => void
  completeAssistantMessage: () => void
  setLoading: (isLoading: boolean) => void
  setStreaming: (isStreaming: boolean) => void
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
    inputType?: 'text' | 'multiple_choice' | 'binary_choice' | 'approval' | 'notification'
  ) => void
  respondToPrompt: (messageId: string, response: string) => void
  addUserMessage: (
    content: string,
    metadata?: {
      enabledDataSources?: string[]
      messageFiles?: Array<{ id: string; fileName: string }>
    }
  ) => ChatMessage
  addAgentResponse: (content: string, showViewReport?: boolean, cards?: GridCard[]) => void
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
  addFileCard: (data: FileCardData) => void
  updateFileCard: (messageId: string, data: Partial<FileCardData>) => void
  addErrorCard: (code: ErrorCode, message?: string, details?: string) => void
  dismissErrorCard: (messageId: string) => void
  dismissConnectionErrors: () => void
  addFileUploadStatusCard: (
    type: FileUploadStatusType,
    fileCount: number,
    jobId: string,
    sessionId?: string
  ) => void
  removeFileUploadWarning: () => void
  addDeepResearchBanner: (
    bannerType: DeepResearchBannerType,
    jobId: string,
    conversationId?: string,
    stats?: { totalTokens?: number; toolCallCount?: number }
  ) => void
  setProjectId: (projectId: string | null) => void
  /** Queue text for the composer to pick up (does NOT auto-send). */
  setComposerPrefill: (text: string) => void
  /** Read and clear the queued composer prefill; returns null when empty. */
  consumeComposerPrefill: () => string | null
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
  stats?: { totalTokens?: number; toolCallCount?: number }
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
  stats?: { totalTokens?: number; toolCallCount?: number }
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
    messages: [...filteredMessages, createDeepResearchBannerMessage(bannerType, jobId, stats)],
    updatedAt: new Date(),
  }
}

export const initialMessagesState = {
  isStreaming: false,
  isLoading: false,
  currentUserMessageId: null as string | null,
  thinkingSteps: [] as ThinkingStep[],
  activeThinkingStepId: null as string | null,
  reportContent: '',
  reportContentCategory: null as 'research_notes' | 'final_report' | null,
  currentStatus: null as StatusType | null,
  projectId: null as string | null,
  composerPrefill: null as string | null,
}

export const createMessagesSlice: StateCreator<ChatStore, [["zustand/devtools", never]], [], MessagesSlice> = (set, get) => ({
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
  },

  setLoading: (isLoading: boolean) => {
    set({ isLoading }, false, 'setLoading')
  },

  setStreaming: (isStreaming: boolean) => {
    set({ isStreaming }, false, 'setStreaming')
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
        ? { ...step, content, isComplete }
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
              s.functionName === functionName ? { ...s, content, isComplete } : s
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
    inputType?: 'text' | 'multiple_choice' | 'binary_choice' | 'approval' | 'notification'
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
      },
      false,
      'addUserMessage'
    )

    get()._appendMessage(newMessage)
    return newMessage
  },

  addAgentResponse: (content: string, showViewReport?: boolean, cards?: GridCard[]) => {
    const {
      currentConversation,
      conversations,
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
    } = get()
    if (!currentConversation) return

    const responseMessage: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content,
      timestamp: new Date(),
      messageType: 'agent_response',
      showViewReport,
      cards,
      reportContent: reportContent || undefined,
      citations: deepResearchCitations.length > 0 ? [...deepResearchCitations] : undefined,
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
      'addAgentResponse'
    )

    if (!checkStorageHealth().isHealthy) {
      const { currentUserId } = get()
      ensureStorageCapacity(currentConversation.id, currentUserId)
    }

    get()._appendMessage(responseMessage)
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

  addFileUploadStatusCard: (
    type: FileUploadStatusType,
    fileCount: number,
    jobId: string,
    sessionId?: string
  ) => {
    const { currentConversation, conversations } = get()

    const targetConversation = sessionId
      ? conversations.find((c) => c.id === sessionId)
      : currentConversation

    if (!targetConversation) return

    const statusMessage: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      messageType: 'file_upload_status',
      fileUploadStatusData: {
        type,
        fileCount,
        jobId,
      },
    }

    const updatedConversation: Conversation = {
      ...targetConversation,
      messages: [...targetConversation.messages, statusMessage],
      updatedAt: new Date(),
    }

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
      'addFileUploadStatusCard'
    )
  },

  removeFileUploadWarning: () => {
    const { currentConversation, conversations } = get()
    if (!currentConversation) return

    const updatedMessages = currentConversation.messages.filter(
      (msg) =>
        !(
          msg.messageType === 'file_upload_status' &&
          msg.fileUploadStatusData?.type === 'pending_warning'
        )
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
      'removeFileUploadWarning'
    )
  },

  addDeepResearchBanner: (
    bannerType: DeepResearchBannerType,
    jobId: string,
    conversationId?: string,
    stats?: { totalTokens?: number; toolCallCount?: number }
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
      stats
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
})
