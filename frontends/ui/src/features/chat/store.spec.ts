import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { useChatStore } from './store'
import type { CitationSource, Conversation, PendingInteraction, FileCardData } from './types'
import type { GridCard } from '@/shared/cards/schemas'

const STORAGE_KEY = 'aiq-chat-store'
const mockLayoutState = vi.hoisted(() => ({
  enabledDataSourceIds: ['web_search'],
  availableDataSources: [{ id: 'web_search' }, { id: 'knowledge_base', requires_auth: true }],
  setEnabledDataSources: vi.fn(),
}))

const mockDiscardSessionResources = vi.hoisted(() => vi.fn())

// Mock the layout store
vi.mock('@/features/layout/store', () => ({
  useLayoutStore: {
    getState: () => mockLayoutState,
  },
}))

vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: mockDiscardSessionResources,
}))

// The interrupted-turn recovery refetches server history before deciding to
// show the banner; default to an empty server history so the banner path runs.
const mockConversationsClient = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
  updateTitle: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn().mockResolvedValue([]),
  createMessage: vi.fn().mockResolvedValue(undefined),
  createMessages: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: mockConversationsClient,
}))

describe('useChatStore', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.removeItem(STORAGE_KEY)
    mockLayoutState.setEnabledDataSources.mockClear()
    mockLayoutState.enabledDataSourceIds = ['web_search']
    mockLayoutState.availableDataSources = [
      { id: 'web_search' },
      { id: 'knowledge_base', requires_auth: true },
    ]
    mockDiscardSessionResources.mockClear()
    // Reset store to initial state before each test
    useChatStore.setState({
      currentUserId: null,
      currentConversation: null,
      conversations: [],
      projectId: null,
      isStreaming: false,
      isLoading: false,
      currentUserMessageId: null,
      thinkingSteps: [],
      activeThinkingStepId: null,
      streamingAssistantMessageId: null,
      currentStatus: null,
      pendingInteraction: null,
      composerPrefill: null,
      composerSubject: null,
      composerDrafts: {},
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    // Clean up localStorage after each test
    localStorage.removeItem(STORAGE_KEY)
  })

  describe('initial state', () => {
    test('has correct default values', () => {
      const state = useChatStore.getState()

      expect(state.currentUserId).toBeNull()
      expect(state.currentConversation).toBeNull()
      expect(state.conversations).toEqual([])
      expect(state.isStreaming).toBe(false)
      expect(state.isLoading).toBe(false)
      expect(state.currentUserMessageId).toBeNull()
      expect(state.thinkingSteps).toEqual([])
      expect(state.activeThinkingStepId).toBeNull()
      expect(state.currentStatus).toBeNull()
      expect(state.pendingInteraction).toBeNull()
    })
  })

  describe('setCurrentUser', () => {
    test('sets user ID', () => {
      useChatStore.getState().setCurrentUser('user-1')

      expect(useChatStore.getState().currentUserId).toBe('user-1')
    })

    test('clears thinking state when user changes', () => {
      useChatStore.setState({
        currentUserId: 'user-1',
        currentUserMessageId: 'msg-1',
        thinkingSteps: [
          {
            id: '1',
            userMessageId: 'msg-1',
            category: 'agents',
            functionName: 'test',
            displayName: 'Test',
            content: '',
            timestamp: new Date(),
            isComplete: false,
          },
        ],
        activeThinkingStepId: '1',
        currentStatus: 'thinking',
      })

      useChatStore.getState().setCurrentUser('user-2')

      const state = useChatStore.getState()
      expect(state.thinkingSteps).toEqual([])
      expect(state.activeThinkingStepId).toBeNull()
      expect(state.currentStatus).toBeNull()
    })

    test('auto-selects first conversation for new user', () => {
      const conv1: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Conv 1',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const conv2: Conversation = {
        id: 'conv-2',
        userId: 'user-2',
        title: 'Conv 2',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv1,
        conversations: [conv1, conv2],
      })

      useChatStore.getState().setCurrentUser('user-2')

      expect(useChatStore.getState().currentConversation).toEqual(conv2)
      expect(mockLayoutState.setEnabledDataSources).toHaveBeenCalledWith([
        'web_search',
        'knowledge_base',
      ])
    })

    test('clears current conversation when logging out', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Conv 1',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })

      useChatStore.getState().setCurrentUser(null)

      expect(useChatStore.getState().currentConversation).toBeNull()
    })
  })

  describe('getUserConversations', () => {
    test('returns empty array when no user', () => {
      useChatStore.setState({
        currentUserId: null,
        conversations: [
          {
            id: 'conv-1',
            userId: 'user-1',
            title: 'Conv',
            messages: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      })

      expect(useChatStore.getState().getUserConversations()).toEqual([])
    })

    test('returns only conversations for current user', () => {
      const conv1: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'User 1 Conv',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const conv2: Conversation = {
        id: 'conv-2',
        userId: 'user-2',
        title: 'User 2 Conv',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      useChatStore.setState({
        currentUserId: 'user-1',
        conversations: [conv1, conv2],
      })

      const result = useChatStore.getState().getUserConversations()

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('conv-1')
    })
  })

  describe('createConversation', () => {
    test('creates new conversation for current user', () => {
      useChatStore.setState({ currentUserId: 'user-1' })

      const conv = useChatStore.getState().createConversation()

      expect(conv.userId).toBe('user-1')
      expect(conv.title).toBe('')
      expect(conv.messages).toEqual([])
      expect(useChatStore.getState().currentConversation).toEqual(conv)
      expect(useChatStore.getState().conversations).toContainEqual(conv)
    })

    test('enables all available data sources for new conversations by default', () => {
      useChatStore.setState({ currentUserId: 'user-1' })

      const conv = useChatStore.getState().createConversation()

      expect(conv.enabledDataSourceIds).toEqual(['web_search', 'knowledge_base'])
      expect(mockLayoutState.setEnabledDataSources).toHaveBeenCalledWith([
        'web_search',
        'knowledge_base',
      ])
    })

    test('throws when no user is authenticated', () => {
      expect(() => useChatStore.getState().createConversation()).toThrow(
        'Cannot create conversation without authenticated user'
      )
    })

    test('clears thinking state on new conversation', () => {
      useChatStore.setState({
        currentUserId: 'user-1',
        thinkingSteps: [
          {
            id: '1',
            userMessageId: 'msg-1',
            category: 'agents',
            functionName: 'test',
            displayName: 'Test',
            content: '',
            timestamp: new Date(),
            isComplete: false,
          },
        ],
      })

      useChatStore.getState().createConversation()

      const state = useChatStore.getState()
      expect(state.thinkingSteps).toEqual([])
    })
  })

  describe('ensureSession', () => {
    test('returns existing conversation ID', () => {
      const conv: Conversation = {
        id: 'existing-conv',
        userId: 'user-1',
        title: 'Existing',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({ currentUserId: 'user-1', currentConversation: conv })

      const result = useChatStore.getState().ensureSession()

      expect(result).toBe('existing-conv')
    })

    test('creates new conversation if none exists', () => {
      useChatStore.setState({ currentUserId: 'user-1', currentConversation: null })

      const result = useChatStore.getState().ensureSession()

      expect(result).toBeDefined()
      expect(useChatStore.getState().currentConversation).not.toBeNull()
    })

    test('returns undefined when no user', () => {
      useChatStore.setState({ currentUserId: null, currentConversation: null })

      const result = useChatStore.getState().ensureSession()

      expect(result).toBeUndefined()
    })
  })

  describe('upload-only session cleanup', () => {
    const uploadOnlyConv = (id: string): Conversation => ({
      id,
      userId: 'user-1',
      title: 'New chat',
      messages: [
        {
          id: 'banner-1',
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          messageType: 'status',
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    test('startNewSessionDraft removes upload-only session and discards documents', () => {
      const conv = uploadOnlyConv('upload-only-1')
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })

      useChatStore.getState().startNewSessionDraft()

      expect(mockDiscardSessionResources).toHaveBeenCalledWith('upload-only-1')
      expect(useChatStore.getState().conversations.some((c) => c.id === 'upload-only-1')).toBe(
        false
      )
      expect(useChatStore.getState().currentConversation).toBeNull()
    })

    test('startNewSessionDraft keeps session after user has chatted', () => {
      const conv: Conversation = {
        ...uploadOnlyConv('with-user'),
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: 'hello',
            timestamp: new Date(),
            messageType: 'user',
          },
        ],
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })

      useChatStore.getState().startNewSessionDraft()

      expect(mockDiscardSessionResources).not.toHaveBeenCalled()
      expect(useChatStore.getState().conversations.some((c) => c.id === 'with-user')).toBe(true)
    })

    test('startNewSessionDraft clears stale shallow streaming state', () => {
      const conv: Conversation = {
        ...uploadOnlyConv('stale-thinking'),
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: 'hello',
            timestamp: new Date(),
            messageType: 'user',
          },
        ],
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
        isStreaming: true,
        isLoading: true,
        currentUserMessageId: 'u1',
        currentStatus: 'thinking',
      })

      useChatStore.getState().startNewSessionDraft()

      expect(useChatStore.getState().isStreaming).toBe(false)
      expect(useChatStore.getState().isLoading).toBe(false)
      expect(useChatStore.getState().currentUserMessageId).toBeNull()
      expect(useChatStore.getState().currentStatus).toBeNull()
    })

    test('startNewSessionDraft clears leftover composerSubject', () => {
      useChatStore.setState({
        currentUserId: 'user-1',
        composerSubject: {
          resourceType: 'document',
          resourceId: 'doc-1',
          filename: 'plan.pdf',
        },
      })

      useChatStore.getState().startNewSessionDraft()

      expect(useChatStore.getState().composerSubject).toBeNull()
    })

    test('selectConversation removes prior upload-only session when switching away', () => {
      const uploadOnly = uploadOnlyConv('u-only')
      const other: Conversation = {
        id: 'other',
        userId: 'user-1',
        title: 'Other',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'hi',
            timestamp: new Date(),
            messageType: 'user',
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: uploadOnly,
        conversations: [uploadOnly, other],
      })

      useChatStore.getState().selectConversation('other')

      expect(mockDiscardSessionResources).toHaveBeenCalledWith('u-only')
      expect(useChatStore.getState().conversations.some((c) => c.id === 'u-only')).toBe(false)
      expect(useChatStore.getState().currentConversation?.id).toBe('other')
    })

    test('selectConversation does not remove upload-only session while files are uploading', async () => {
      const { useDocumentsStore } = await import('@/features/documents/store')
      const uploadOnly = uploadOnlyConv('u-busy')
      const other: Conversation = {
        id: 'other-2',
        userId: 'user-1',
        title: 'Other',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useDocumentsStore.setState({
        trackedFiles: [
          {
            id: 'tf-1',
            file: new File(['x'], 'x.txt'),
            fileName: 'x.txt',
            fileSize: 1,
            status: 'uploading',
            progress: 0,
            collectionName: 'u-busy',
            uploadedAt: new Date().toISOString(),
          },
        ],
      })
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: uploadOnly,
        conversations: [uploadOnly, other],
      })

      useChatStore.getState().selectConversation('other-2')

      expect(mockDiscardSessionResources).not.toHaveBeenCalled()
      expect(useChatStore.getState().conversations.some((c) => c.id === 'u-busy')).toBe(true)

      useDocumentsStore.setState({ trackedFiles: [] })
    })
  })

  describe('selectConversation', () => {
    test('selects conversation owned by current user', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Conv 1',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        conversations: [conv],
        currentConversation: null,
      })

      useChatStore.getState().selectConversation('conv-1')

      expect(useChatStore.getState().currentConversation).toEqual(conv)
    })

    test('does not select conversation owned by different user', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-2',
        title: 'Conv 1',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        conversations: [conv],
        currentConversation: null,
      })

      useChatStore.getState().selectConversation('conv-1')

      expect(useChatStore.getState().currentConversation).toBeNull()
    })

    test('clears thinking state on selection', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Conv',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        conversations: [conv],
        thinkingSteps: [
          {
            id: '1',
            userMessageId: 'msg-1',
            category: 'agents',
            functionName: 'test',
            displayName: 'Test',
            content: '',
            timestamp: new Date(),
            isComplete: false,
          },
        ],
      })

      useChatStore.getState().selectConversation('conv-1')

      expect(useChatStore.getState().thinkingSteps).toEqual([])
    })

    test('selectConversation without a subject file clears leftover composerSubject', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Conv',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        conversations: [conv],
        composerSubject: {
          resourceType: 'document',
          resourceId: 'doc-leftover',
          filename: 'plan.pdf',
        },
      })

      useChatStore.getState().selectConversation('conv-1')

      expect(useChatStore.getState().composerSubject).toBeNull()
    })

    test('restores a subject file without inventing a filename from the title', () => {
      // `conversation.title` is the filename only until addUserMessage
      // overwrites it with the first thing the user typed. Reusing it here
      // restored the subject as "fass das dokument zusammen" and sent that
      // string on the wire as `focus_file_name`, matching no document — and
      // the bar's own repair lookup skipped, because a title was present.
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'fass das dokument zusammen',
        subjectResourceType: 'document',
        subjectResourceId: 'doc-aufsicht',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        conversations: [conv],
        composerSubject: null,
      })

      useChatStore.getState().selectConversation('conv-1')

      const subject = useChatStore.getState().composerSubject
      expect(subject).toEqual({
        resourceType: 'document',
        resourceId: 'doc-aufsicht',
        title: null,
      })
      expect(subject?.title).not.toBe(conv.title)
      expect(subject?.filename).toBeUndefined()
    })
  })

  describe('addUserMessage', () => {
    test('adds user message to current conversation', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: '',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })

      const msg = useChatStore.getState().addUserMessage('Hello')

      expect(msg.role).toBe('user')
      expect(msg.content).toBe('Hello')
      expect(useChatStore.getState().currentConversation?.messages).toHaveLength(1)
    })

    test('updates title on first message', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: '',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })

      useChatStore.getState().addUserMessage('What is the capital of France?')

      expect(useChatStore.getState().currentConversation?.title).toBe(
        'What is the capital of France?'
      )
    })

    test('updates title on first user message when file upload status messages exist', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: '',
        messages: [
          {
            id: 'status-1',
            role: 'assistant',
            content: '',
            timestamp: new Date(),
            messageType: 'status',
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })

      useChatStore.getState().addUserMessage('Summarize my document')

      expect(useChatStore.getState().currentConversation?.title).toBe('Summarize my document')
    })

    test('truncates long titles to 50 characters', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: '',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })

      const longMessage = 'A'.repeat(100)
      useChatStore.getState().addUserMessage(longMessage)

      expect(useChatStore.getState().currentConversation?.title).toBe('A'.repeat(50) + '...')
    })

    test('creates conversation if none exists', () => {
      mockLayoutState.enabledDataSourceIds = ['web_search', 'knowledge_base']
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: null,
        conversations: [],
      })

      useChatStore.getState().addUserMessage('Hello')

      expect(useChatStore.getState().currentConversation).not.toBeNull()
      expect(useChatStore.getState().conversations).toHaveLength(1)
      expect(useChatStore.getState().currentConversation?.enabledDataSourceIds).toEqual([
        'web_search',
        'knowledge_base',
      ])
    })

    test('throws when no user authenticated', () => {
      useChatStore.setState({ currentUserId: null, currentConversation: null })

      expect(() => useChatStore.getState().addUserMessage('Hello')).toThrow(
        'Cannot create conversation without authenticated user'
      )
    })

    test('sets loading state and updates currentUserMessageId', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: '',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
        currentUserMessageId: 'old-msg-id',
        thinkingSteps: [
          {
            id: '1',
            userMessageId: 'old-msg-id',
            category: 'agents',
            functionName: 'test',
            displayName: 'Test',
            content: '',
            timestamp: new Date(),
            isComplete: false,
          },
        ],
      })

      const message = useChatStore.getState().addUserMessage('Hello')

      expect(useChatStore.getState().isLoading).toBe(true)
      // New behavior: thinking steps are preserved (associated with previous message)
      expect(useChatStore.getState().thinkingSteps).toHaveLength(1)
      // currentUserMessageId is updated to the new message
      expect(useChatStore.getState().currentUserMessageId).toBe(message.id)
    })
  })

  describe('assistant message streaming', () => {
    const setupConversation = () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })
      return conv
    }

    test('startAssistantMessage creates streaming message', () => {
      setupConversation()

      const msg = useChatStore.getState().startAssistantMessage()

      expect(msg.role).toBe('assistant')
      expect(msg.content).toBe('')
      expect(msg.isStreaming).toBe(true)
      expect(useChatStore.getState().isStreaming).toBe(true)
      expect(useChatStore.getState().isLoading).toBe(false)
    })

    test('startAssistantMessage throws when no conversation', () => {
      useChatStore.setState({ currentConversation: null })

      expect(() => useChatStore.getState().startAssistantMessage()).toThrow(
        'No active conversation'
      )
    })

    test('appendToAssistantMessage appends to streaming message', () => {
      setupConversation()
      useChatStore.getState().startAssistantMessage()

      useChatStore.getState().appendToAssistantMessage('Hello ')
      useChatStore.getState().appendToAssistantMessage('world!')

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages?.[0].content).toBe('Hello world!')
    })

    test('appendToAssistantMessage does nothing if no streaming message', () => {
      setupConversation()

      useChatStore.getState().appendToAssistantMessage('Hello')

      expect(useChatStore.getState().currentConversation?.messages).toHaveLength(0)
    })

    test('completeAssistantMessage marks message as complete', () => {
      setupConversation()
      useChatStore.getState().startAssistantMessage()
      useChatStore.getState().appendToAssistantMessage('Response')

      useChatStore.getState().completeAssistantMessage()

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages?.[0].isStreaming).toBe(false)
      expect(useChatStore.getState().isStreaming).toBe(false)
    })
  })

  describe('loading state', () => {
    test('setLoading sets loading state', () => {
      useChatStore.getState().setLoading(true)
      expect(useChatStore.getState().isLoading).toBe(true)

      useChatStore.getState().setLoading(false)
      expect(useChatStore.getState().isLoading).toBe(false)
    })

    test('setStreaming sets streaming state', () => {
      useChatStore.getState().setStreaming(true)
      expect(useChatStore.getState().isStreaming).toBe(true)

      useChatStore.getState().setStreaming(false)
      expect(useChatStore.getState().isStreaming).toBe(false)
    })
  })

  describe('conversation management', () => {
    test('deleteConversation removes conversation', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({ currentConversation: conv, conversations: [conv] })

      useChatStore.getState().deleteConversation('conv-1')

      expect(useChatStore.getState().conversations).toHaveLength(0)
      expect(useChatStore.getState().currentConversation).toBeNull()
    })

    test('deleteConversation keeps current if different', () => {
      const conv1: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test 1',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const conv2: Conversation = {
        id: 'conv-2',
        userId: 'user-1',
        title: 'Test 2',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({ currentConversation: conv1, conversations: [conv1, conv2] })

      useChatStore.getState().deleteConversation('conv-2')

      expect(useChatStore.getState().currentConversation).toEqual(conv1)
    })

    test('deleteConversation removes session from localStorage', async () => {
      // Create conversations and wait for persist
      const conv1: Conversation = {
        id: 'conv-persist-1',
        userId: 'user-1',
        title: 'Session to Delete',
        messages: [],
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      }
      const conv2: Conversation = {
        id: 'conv-persist-2',
        userId: 'user-1',
        title: 'Session to Keep',
        messages: [],
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02'),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv1,
        conversations: [conv1, conv2],
      })

      // Wait for Zustand persist to sync to localStorage
      await vi.waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).not.toBeNull()
        const parsed = JSON.parse(stored!)
        expect(parsed.state.conversations).toHaveLength(2)
      })

      // Verify initial localStorage state
      const beforeDelete = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
      expect(beforeDelete.state.conversations.map((c: Conversation) => c.id)).toContain(
        'conv-persist-1'
      )
      expect(beforeDelete.state.conversations.map((c: Conversation) => c.id)).toContain(
        'conv-persist-2'
      )

      // Delete the first conversation
      useChatStore.getState().deleteConversation('conv-persist-1')

      // Wait for Zustand persist to sync the deletion to localStorage
      await vi.waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        const parsed = JSON.parse(stored!)
        expect(parsed.state.conversations).toHaveLength(1)
      })

      // Verify localStorage was updated correctly
      const afterDelete = JSON.parse(localStorage.getItem(STORAGE_KEY)!)

      // The deleted session should NOT be in localStorage
      expect(afterDelete.state.conversations.map((c: Conversation) => c.id)).not.toContain(
        'conv-persist-1'
      )

      // The other session should still be in localStorage
      expect(afterDelete.state.conversations.map((c: Conversation) => c.id)).toContain(
        'conv-persist-2'
      )

      // currentConversation should be cleared since we deleted the current one
      expect(afterDelete.state.currentConversation).toBeNull()
    })

    test('deleteConversation updates currentConversation in localStorage when deleting current', async () => {
      const conv: Conversation = {
        id: 'conv-current',
        userId: 'user-1',
        title: 'Current Session',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })

      // Wait for initial persist (currentConversation stored as ID string)
      await vi.waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).not.toBeNull()
        const parsed = JSON.parse(stored!)
        expect(parsed.state.currentConversation).toBe('conv-current')
      })

      // Delete the current conversation
      useChatStore.getState().deleteConversation('conv-current')

      // Wait for persist to sync
      await vi.waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        const parsed = JSON.parse(stored!)
        expect(parsed.state.conversations).toHaveLength(0)
      })

      // Verify currentConversation is cleared in localStorage
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
      expect(stored.state.currentConversation).toBeNull()
      expect(stored.state.conversations).toHaveLength(0)
    })

    test('updateConversationTitle updates title', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Old Title',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({ currentConversation: conv, conversations: [conv] })

      useChatStore.getState().updateConversationTitle('conv-1', 'New Title')

      expect(useChatStore.getState().currentConversation?.title).toBe('New Title')
      expect(useChatStore.getState().conversations[0].title).toBe('New Title')
    })
  })

  describe('thinking steps', () => {
    // Helper to set up a user message context for thinking steps tests
    const setupUserMessageContext = () => {
      useChatStore.getState().setCurrentUser('test-user')
      const message = useChatStore.getState().addUserMessage('Test message')
      return message.id
    }

    test('addThinkingStep adds step and returns ID', () => {
      const userMessageId = setupUserMessageContext()

      const stepId = useChatStore.getState().addThinkingStep({
        category: 'agents',
        functionName: 'shallow_research_agent',
        displayName: 'Shallow Research Agent',
        content: 'Initial thought',
        isComplete: false,
      })

      expect(stepId).toBeDefined()
      const steps = useChatStore.getState().thinkingSteps
      expect(steps).toHaveLength(1)
      expect(steps[0].category).toBe('agents')
      expect(steps[0].functionName).toBe('shallow_research_agent')
      expect(steps[0].displayName).toBe('Shallow Research Agent')
      expect(steps[0].content).toBe('Initial thought')
      expect(steps[0].isComplete).toBe(false)
      expect(steps[0].userMessageId).toBe(userMessageId)
      expect(useChatStore.getState().activeThinkingStepId).toBe(stepId)
    })

    test('addThinkingStep returns empty string without currentUserMessageId', () => {
      // Don't set up user message context
      const stepId = useChatStore.getState().addThinkingStep({
        category: 'agents',
        functionName: 'test',
        displayName: 'Test',
        content: '',
        isComplete: false,
      })

      expect(stepId).toBe('')
      expect(useChatStore.getState().thinkingSteps).toHaveLength(0)
    })

    test('appendToThinkingStep appends content', () => {
      setupUserMessageContext()

      const stepId = useChatStore.getState().addThinkingStep({
        category: 'agents',
        functionName: 'test_agent',
        displayName: 'Test Agent',
        content: 'Hello ',
        isComplete: false,
      })

      useChatStore.getState().appendToThinkingStep(stepId, 'world!')

      expect(useChatStore.getState().thinkingSteps[0].content).toBe('Hello world!')
    })

    test('completeThinkingStep marks step complete', () => {
      setupUserMessageContext()

      const stepId = useChatStore.getState().addThinkingStep({
        category: 'tasks',
        functionName: '<workflow>',
        displayName: 'Workflow',
        content: '',
        isComplete: false,
      })

      useChatStore.getState().completeThinkingStep(stepId)

      expect(useChatStore.getState().thinkingSteps[0].isComplete).toBe(true)
      expect(useChatStore.getState().activeThinkingStepId).toBeNull()
    })

    test('clearThinkingSteps clears all steps', () => {
      setupUserMessageContext()

      useChatStore.getState().addThinkingStep({
        category: 'agents',
        functionName: 'agent1',
        displayName: 'Agent 1',
        content: '',
        isComplete: false,
      })
      useChatStore.getState().addThinkingStep({
        category: 'tools',
        functionName: 'web_search_tool',
        displayName: 'Web Search Tool',
        content: '',
        isComplete: false,
      })

      useChatStore.getState().clearThinkingSteps()

      expect(useChatStore.getState().thinkingSteps).toEqual([])
      expect(useChatStore.getState().activeThinkingStepId).toBeNull()
    })

    test('updateThinkingStepByFunctionName updates step', () => {
      setupUserMessageContext()

      useChatStore.getState().addThinkingStep({
        category: 'tools',
        functionName: 'web_search_tool',
        displayName: 'Web Search Tool',
        content: 'Searching...',
        isComplete: false,
      })

      useChatStore
        .getState()
        .updateThinkingStepByFunctionName(
          'web_search_tool',
          'Search complete: found 5 results',
          true
        )

      const step = useChatStore.getState().thinkingSteps[0]
      expect(step.content).toBe('Search complete: found 5 results')
      expect(step.isComplete).toBe(true)
    })

    test('findThinkingStepByFunctionName finds existing step', () => {
      setupUserMessageContext()

      useChatStore.getState().addThinkingStep({
        category: 'agents',
        functionName: 'shallow_research_agent',
        displayName: 'Shallow Research Agent',
        content: 'Reading...',
        isComplete: false,
      })

      const found = useChatStore.getState().findThinkingStepByFunctionName('shallow_research_agent')

      expect(found).toBeDefined()
      expect(found?.functionName).toBe('shallow_research_agent')
    })

    test('findThinkingStepByFunctionName returns undefined for non-existent step', () => {
      const found = useChatStore.getState().findThinkingStepByFunctionName('non_existent')

      expect(found).toBeUndefined()
    })

    test('getThinkingStepsForMessage filters by userMessageId', () => {
      useChatStore.getState().setCurrentUser('test-user')

      // Add first user message and its thinking step
      const message1 = useChatStore.getState().addUserMessage('Message 1')
      useChatStore.getState().addThinkingStep({
        category: 'agents',
        functionName: 'agent1',
        displayName: 'Agent 1',
        content: 'Step for message 1',
        isComplete: false,
      })

      // Add second user message and its thinking step
      const message2 = useChatStore.getState().addUserMessage('Message 2')
      useChatStore.getState().addThinkingStep({
        category: 'tools',
        functionName: 'tool1',
        displayName: 'Tool 1',
        content: 'Step for message 2',
        isComplete: false,
      })

      // Get steps for each message
      const stepsForMessage1 = useChatStore.getState().getThinkingStepsForMessage(message1.id)
      const stepsForMessage2 = useChatStore.getState().getThinkingStepsForMessage(message2.id)

      expect(stepsForMessage1).toHaveLength(1)
      expect(stepsForMessage1[0].functionName).toBe('agent1')
      expect(stepsForMessage2).toHaveLength(1)
      expect(stepsForMessage2[0].functionName).toBe('tool1')
    })

    test('getThinkingStepsForMessage filters out deep research steps', () => {
      useChatStore.getState().setCurrentUser('test-user')

      // Add user message
      const message = useChatStore.getState().addUserMessage('Test message')

      // Add WebSocket thinking step (should be included)
      useChatStore.getState().addThinkingStep({
        category: 'agents',
        functionName: 'websocket_agent',
        displayName: 'WebSocket Agent',
        content: 'WebSocket step',
        isComplete: false,
        isDeepResearch: false,
      })

      // Add deep research thinking step (should be filtered out)
      useChatStore.getState().addThinkingStep({
        category: 'agents',
        functionName: 'deep_research_agent',
        displayName: 'Deep Research Agent',
        content: 'Deep research step',
        isComplete: false,
        isDeepResearch: true,
      })

      // Get steps for the message
      const steps = useChatStore.getState().getThinkingStepsForMessage(message.id)

      // Should only include the WebSocket step, not the deep research step
      expect(steps).toHaveLength(1)
      expect(steps[0].functionName).toBe('websocket_agent')
      expect(steps[0].isDeepResearch).toBe(false)
    })
  })

  describe('status and prompts', () => {
    const setupConversation = () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })
      return conv
    }

    test('setCurrentStatus sets status', () => {
      useChatStore.getState().setCurrentStatus('searching')

      expect(useChatStore.getState().currentStatus).toBe('searching')
    })

    test('addAgentPrompt adds prompt message', () => {
      setupConversation()

      useChatStore
        .getState()
        .addAgentPrompt('choice', 'Select an option', ['A', 'B', 'C'], 'Choose one')

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages).toHaveLength(1)
      expect(messages?.[0].messageType).toBe('prompt')
      expect(messages?.[0].promptType).toBe('choice')
      expect(messages?.[0].promptOptions).toEqual(['A', 'B', 'C'])
      expect(messages?.[0].promptPlaceholder).toBe('Choose one')
      expect(messages?.[0].isPromptResponded).toBe(false)
      expect(useChatStore.getState().isStreaming).toBe(false)
    })

    test('respondToPrompt updates prompt message', () => {
      setupConversation()
      useChatStore.getState().addAgentPrompt('choice', 'Pick one', ['A', 'B'])
      const promptId = useChatStore.getState().currentConversation!.messages[0].id!

      useChatStore.getState().respondToPrompt(promptId, 'A')

      const msg = useChatStore.getState().currentConversation?.messages[0]
      expect(msg?.promptResponse).toBe('A')
      expect(msg?.isPromptResponded).toBe(true)
      expect(useChatStore.getState().isLoading).toBe(true)
    })
  })

  describe('agent responses and HITL', () => {
    const setupConversation = () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })
      return conv
    }

    test('addAgentResponse adds response message', () => {
      setupConversation()

      useChatStore.getState().addAgentResponse('Here is your answer')

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages).toHaveLength(1)
      expect(messages?.[0].messageType).toBe('agent_response')
      expect(messages?.[0].content).toBe('Here is your answer')
    })

    test('addAgentResponse threads answerConfidence onto the message', () => {
      setupConversation()

      useChatStore.getState().addAgentResponse('Grounded answer', undefined, 'high')

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages?.[0].answerConfidence).toBe('high')
    })

    test('addAgentResponse carries the cut-off cause, not just the flag', () => {
      // The join an independent check found missing: the store copied
      // `researchTruncated` and stopped, so the props ChatArea passes for the
      // cause and the degradations were `undefined` on every turn. Renderer,
      // schema, sanitizer and dictionaries were all correct and all
      // unreachable — the answer could say THAT research stopped, never why.
      setupConversation()

      useChatStore
        .getState()
        .addAgentResponse('Die Antwort.', undefined, undefined, undefined, {
          researchTruncated: true,
          truncationReason: 'wall_clock',
          degradedReasons: ['no_valid_citations'],
        })

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages?.[0].researchTruncated).toBe(true)
      expect(messages?.[0].truncationReason).toBe('wall_clock')
      expect(messages?.[0].degradedReasons).toEqual(['no_valid_citations'])
    })

    test('addAgentResponse copies a degradation on a run that was NOT truncated', () => {
      // Independent facts. Gating the degradations on the flag would drop the
      // case a reader most needs: a run that finished inside its budget and
      // still produced nothing verifiable.
      setupConversation()

      useChatStore
        .getState()
        .addAgentResponse('Die Antwort.', undefined, undefined, undefined, {
          degradedReasons: ['no_report_file'],
        })

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages?.[0].degradedReasons).toEqual(['no_report_file'])
      expect(messages?.[0].researchTruncated).toBeUndefined()
    })

    test('addAgentResponse leaves answerConfidence undefined when not provided', () => {
      setupConversation()

      useChatStore.getState().addAgentResponse('Plain answer')

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages?.[0].answerConfidence).toBeUndefined()
    })

    describe('streamed answer accumulation', () => {
      // Minimal card stand-in; the store stores the reference verbatim and does
      // not validate schema, so a cast is sufficient for these tests.
      const card = (id: string) => ({ card_type: 'kpi', id }) as unknown as GridCard

      test('multiple in_progress deltas accumulate into ONE bubble whose content is the concatenation', () => {
        setupConversation()

        useChatStore.getState().appendAgentResponseDelta('Hello ')
        useChatStore.getState().appendAgentResponseDelta('streamed ')
        useChatStore.getState().appendAgentResponseDelta('world')

        const messages = useChatStore.getState().currentConversation?.messages
        expect(messages).toHaveLength(1)
        expect(messages?.[0].messageType).toBe('agent_response')
        expect(messages?.[0].content).toBe('Hello streamed world')
        // Still streaming until the terminal frame finalizes it.
        expect(messages?.[0].isStreaming).toBe(true)
        expect(useChatStore.getState().streamingAssistantMessageId).toBe(messages?.[0].id)
      })

      test('complete frame finalizes the bubble, sets full text, and attaches cards + confidence', () => {
        setupConversation()

        useChatStore.getState().appendAgentResponseDelta('Hel')
        useChatStore.getState().appendAgentResponseDelta('lo')

        const cards = [card('c1')]
        // Terminal frame carries the authoritative FULL text + cards/confidence.
        useChatStore.getState().finalizeAgentResponse('Hello', cards, 'high')

        const messages = useChatStore.getState().currentConversation?.messages
        expect(messages).toHaveLength(1)
        expect(messages?.[0].content).toBe('Hello')
        expect(messages?.[0].cards).toBe(cards)
        expect(messages?.[0].answerConfidence).toBe('high')
        expect(messages?.[0].isStreaming).toBe(false)
        // Tracking id is released so the next turn opens a fresh bubble.
        expect(useChatStore.getState().streamingAssistantMessageId).toBeNull()
      })

      test('a settled snapshot replaces the streamed text and names its sources (ADR-0066)', () => {
        setupConversation()

        useChatStore.getState().appendAgentResponseDelta('R 90 [1], erfunden [2')
        useChatStore.getState().appendAgentResponseDelta('].')
        const citations = [{ id: 's1', content: '', timestamp: new Date(), number: 1 }] as CitationSource[]
        useChatStore.getState().replaceStreamingAgentResponse('R 90 [1], erfunden.', citations)

        const messages = useChatStore.getState().currentConversation?.messages
        expect(messages).toHaveLength(1)
        expect(messages?.[0].content).toBe('R 90 [1], erfunden.')
        expect(messages?.[0].citations).toBe(citations)
        expect(messages?.[0].isStreaming).toBe(true)

        // The terminal frame still settles it.
        useChatStore.getState().finalizeAgentResponse('R 90 [1], erfunden.')
        expect(useChatStore.getState().currentConversation?.messages?.[0].isStreaming).toBe(false)
      })

      test('empty complete frame does NOT wipe the accumulated bubble (just finalizes)', () => {
        setupConversation()

        useChatStore.getState().appendAgentResponseDelta('Kept ')
        useChatStore.getState().appendAgentResponseDelta('text')

        // Legacy synthetic complete: empty text, no cards.
        useChatStore.getState().finalizeAgentResponse('')

        const messages = useChatStore.getState().currentConversation?.messages
        expect(messages).toHaveLength(1)
        expect(messages?.[0].content).toBe('Kept text')
        expect(messages?.[0].isStreaming).toBe(false)
        expect(useChatStore.getState().streamingAssistantMessageId).toBeNull()
      })

      test('BACKWARD COMPAT: single in_progress full-text+cards frame then empty complete yields ONE bubble with full text + cards', () => {
        setupConversation()

        const cards = [card('c1'), card('c2')]
        // Today's backend: ONE in_progress frame carrying the whole answer +
        // cards...
        useChatStore.getState().appendAgentResponseDelta('The full answer', cards, 'medium')
        // ...followed by the synthetic empty complete frame.
        useChatStore.getState().finalizeAgentResponse('')

        const messages = useChatStore.getState().currentConversation?.messages
        expect(messages).toHaveLength(1)
        expect(messages?.[0].messageType).toBe('agent_response')
        expect(messages?.[0].content).toBe('The full answer')
        expect(messages?.[0].cards).toBe(cards)
        expect(messages?.[0].answerConfidence).toBe('medium')
        expect(messages?.[0].isStreaming).toBe(false)
        expect(useChatStore.getState().streamingAssistantMessageId).toBeNull()
      })

      test('a new user turn resets accumulation so the next answer opens a fresh bubble', () => {
        setupConversation()

        useChatStore.getState().appendAgentResponseDelta('First answer')
        useChatStore.getState().finalizeAgentResponse('First answer')

        // New turn.
        useChatStore.getState().addUserMessage('second question')
        expect(useChatStore.getState().streamingAssistantMessageId).toBeNull()

        useChatStore.getState().appendAgentResponseDelta('Second ')
        useChatStore.getState().appendAgentResponseDelta('answer')
        useChatStore.getState().finalizeAgentResponse('Second answer')

        const messages = useChatStore.getState().currentConversation?.messages
        const agentResponses = messages?.filter((m) => m.messageType === 'agent_response')
        expect(agentResponses).toHaveLength(2)
        expect(agentResponses?.[0].content).toBe('First answer')
        expect(agentResponses?.[1].content).toBe('Second answer')
      })

      test('finalize with no prior delta falls back to a one-shot response (complete-only frame)', () => {
        setupConversation()

        useChatStore.getState().finalizeAgentResponse('Whole answer in one complete frame', [card('c1')])

        const messages = useChatStore.getState().currentConversation?.messages
        expect(messages).toHaveLength(1)
        expect(messages?.[0].content).toBe('Whole answer in one complete frame')
        expect(messages?.[0].messageType).toBe('agent_response')
        expect(useChatStore.getState().streamingAssistantMessageId).toBeNull()
      })

      test('empty finalize with no prior delta is a no-op (pure synthetic complete, nothing to show)', () => {
        setupConversation()

        useChatStore.getState().finalizeAgentResponse('')

        expect(useChatStore.getState().currentConversation?.messages).toHaveLength(0)
      })

      test('discardStreamingAssistantMessage removes the orphaned bubble entirely and clears the tracking id', () => {
        setupConversation()

        // Deltas of a turn open a streaming bubble...
        useChatStore.getState().appendAgentResponseDelta('Queue full prose ')
        useChatStore.getState().appendAgentResponseDelta('streamed here')
        expect(useChatStore.getState().currentConversation?.messages).toHaveLength(1)
        expect(useChatStore.getState().streamingAssistantMessageId).not.toBeNull()

        // ...then the turn resolves in a non-bubble surface (banner): drop it.
        useChatStore.getState().discardStreamingAssistantMessage()

        // Message is REMOVED (not merely finalized) and the id is cleared.
        expect(useChatStore.getState().currentConversation?.messages).toHaveLength(0)
        expect(useChatStore.getState().streamingAssistantMessageId).toBeNull()
      })

      test('discardStreamingAssistantMessage is a no-op when no streaming bubble is open', () => {
        setupConversation()

        useChatStore.getState().addAgentResponse('A finished answer')
        const before = useChatStore.getState().currentConversation?.messages
        expect(before).toHaveLength(1)

        useChatStore.getState().discardStreamingAssistantMessage()

        // The existing finalized answer is untouched.
        expect(useChatStore.getState().currentConversation?.messages).toHaveLength(1)
        expect(useChatStore.getState().streamingAssistantMessageId).toBeNull()
      })
    })

    test('setPendingInteraction sets interaction', () => {
      const interaction: PendingInteraction = {
        id: 'int-1',
        parentId: 'parent-1',
        inputType: 'text',
        text: 'Enter your name',
      }

      useChatStore.getState().setPendingInteraction(interaction)

      expect(useChatStore.getState().pendingInteraction).toEqual(interaction)
    })

    test('clearPendingInteraction clears interaction', () => {
      useChatStore.setState({
        pendingInteraction: { id: 'int-1', parentId: 'p1', inputType: 'text', text: 'Test' },
      })

      useChatStore.getState().clearPendingInteraction()

      expect(useChatStore.getState().pendingInteraction).toBeNull()
    })
  })

  describe('file cards', () => {
    const setupConversation = () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })
      return conv
    }

    test('addFileCard adds file message', () => {
      setupConversation()

      const fileData: FileCardData = {
        fileName: 'document.pdf',
        fileSize: 1024,
        fileStatus: 'uploading',
        progress: 50,
      }

      useChatStore.getState().addFileCard(fileData)

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages).toHaveLength(1)
      expect(messages?.[0].messageType).toBe('file')
      expect(messages?.[0].fileData).toEqual(fileData)
    })

    test('updateFileCard updates file data', () => {
      setupConversation()
      useChatStore.getState().addFileCard({
        fileName: 'doc.pdf',
        fileSize: 1024,
        fileStatus: 'uploading',
        progress: 0,
      })
      const msgId = useChatStore.getState().currentConversation!.messages[0].id!

      useChatStore.getState().updateFileCard(msgId, { fileStatus: 'success', progress: 100 })

      const msg = useChatStore.getState().currentConversation?.messages[0]
      expect(msg?.fileData?.fileStatus).toBe('success')
      expect(msg?.fileData?.progress).toBe(100)
    })
  })

  describe('error cards', () => {
    const setupConversation = () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })
      return conv
    }

    test('addErrorCard adds error message with defaults from registry', () => {
      setupConversation()

      useChatStore.getState().addErrorCard('connection.lost')

      const messages = useChatStore.getState().currentConversation?.messages
      expect(messages).toHaveLength(1)
      expect(messages?.[0].messageType).toBe('error')
      expect(messages?.[0].errorData?.errorCode).toBe('connection.lost')
    })

    test('addErrorCard uses custom message', () => {
      setupConversation()

      useChatStore
        .getState()
        .addErrorCard('connection.failed', 'Custom error message', 'Details here')

      const msg = useChatStore.getState().currentConversation?.messages[0]
      expect(msg?.content).toBe('Custom error message')
      expect(msg?.errorData?.errorDetails).toBe('Details here')
    })

    test('dismissErrorCard removes error message', () => {
      setupConversation()
      useChatStore.getState().addErrorCard('system.unknown')
      const msgId = useChatStore.getState().currentConversation!.messages[0].id!

      useChatStore.getState().dismissErrorCard(msgId)

      expect(useChatStore.getState().currentConversation?.messages).toHaveLength(0)
    })
  })

  describe('restoreSessionState — interrupted response detection', () => {
    const createConversation = (
      messages: Partial<Conversation['messages'][0]>[]
    ): Conversation => ({
      id: 'conv-restore',
      userId: 'user-1',
      title: 'Restore Test',
      messages: messages.map((m, i) => ({
        id: `msg-${i}`,
        role: (m.role ?? 'user') as 'user' | 'assistant' | 'system',
        content: m.content ?? '',
        timestamp: new Date(),
        ...m,
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    test('adds error card when last meaningful message is user with thinking steps', async () => {
      // Server has no persisted assistant reply → genuinely interrupted.
      mockConversationsClient.listMessages.mockResolvedValueOnce([])
      const conv = createConversation([
        {
          role: 'user',
          messageType: 'user',
          content: 'Tell me about AI',
          thinkingSteps: [
            {
              id: 's1',
              userMessageId: 'msg-0',
              category: 'tasks',
              functionName: 'fn',
              displayName: 'Searching',
              content: '',
              isComplete: true,
              timestamp: new Date(),
            },
          ],
        },
      ])

      // Set currentConversation before calling restoreSessionState
      useChatStore.setState({ currentConversation: conv, conversations: [conv] })
      useChatStore.getState().restoreSessionState(conv)

      // The banner is added after the (empty) server refetch resolves.
      await vi.waitFor(() => {
        const messages = useChatStore.getState().currentConversation?.messages ?? []
        expect(messages).toHaveLength(2)
      })
      const messages = useChatStore.getState().currentConversation?.messages ?? []
      expect(messages[1].messageType).toBe('error')
      expect(messages[1].errorData?.errorCode).toBe('agent.response_interrupted')
    })

    test('sets isRecoveryPending while the recovery fetch is in flight, then clears it (FIX 3)', async () => {
      // Hold the server refetch open so we can observe the in-flight flag.
      let resolveList: (value: unknown[]) => void = () => {}
      mockConversationsClient.listMessages.mockReturnValueOnce(
        new Promise<unknown[]>((resolve) => {
          resolveList = resolve
        }) as never
      )
      const conv = createConversation([{ id: 'msg-0', role: 'user', messageType: 'user', content: 'Q' }])
      useChatStore.setState({ currentConversation: conv, conversations: [conv], isRecoveryPending: false })

      const recovery = useChatStore.getState()._recoverInterruptedAssistantMessage(conv.id, 'msg-0')
      // The checking state is active for the whole round-trip.
      expect(useChatStore.getState().isRecoveryPending).toBe(true)

      resolveList([]) // nothing persisted → genuinely lost
      const outcome = await recovery
      // `nothing` and not a bare false: the caller has to tell "the server has
      // no answer" apart from "someone else already put it on screen", and only
      // this one earns the interrupted banner.
      expect(outcome).toBe('nothing')
      // Only after the fetch settles does the flag clear (so the lost UI shows).
      expect(useChatStore.getState().isRecoveryPending).toBe(false)
    })

    test('recovers the persisted answer and clears isRecoveryPending (FIX 3)', async () => {
      mockConversationsClient.listMessages.mockResolvedValueOnce([
        {
          id: 'msg-0',
          conversationId: 'conv-restore',
          role: 'user',
          content: 'Q',
          metadata: {},
          createdAt: '2026-07-01T10:00:00.000Z',
        },
        {
          id: 'server-assistant-1',
          conversationId: 'conv-restore',
          role: 'assistant',
          content: 'The finished answer.',
          metadata: { messageType: 'agent_response' },
          createdAt: '2026-07-01T10:00:05.000Z',
        },
      ] as never)
      const conv = createConversation([{ id: 'msg-0', role: 'user', messageType: 'user', content: 'Q' }])
      useChatStore.setState({ currentConversation: conv, conversations: [conv], isRecoveryPending: false })

      const outcome = await useChatStore
        .getState()
        ._recoverInterruptedAssistantMessage(conv.id, 'msg-0')

      expect(outcome).toBe('recovered')
      expect(useChatStore.getState().isRecoveryPending).toBe(false)
      const messages = useChatStore.getState().currentConversation?.messages ?? []
      expect(messages.some((m) => m.id === 'server-assistant-1')).toBe(true)
    })

    test('reports `superseded`, not `nothing`, when the answer is already on screen', async () => {
      // Recovery runs on mount, on reconnect and from the streaming watchdog,
      // and any two can be in flight at once. A boolean collapsed "the server
      // has nothing" and "somebody already recovered it" into one `false`, so
      // the second call back printed „bitte erneut senden" directly underneath
      // the answer the first had just put on screen.
      mockConversationsClient.listMessages.mockResolvedValueOnce([
        {
          id: 'msg-0',
          role: 'user',
          content: 'Q',
          metadata: { messageType: 'user' },
          createdAt: '2026-07-01T10:00:00.000Z',
        },
        {
          id: 'server-assistant-1',
          role: 'assistant',
          content: 'The finished answer.',
          metadata: { messageType: 'agent_response' },
          createdAt: '2026-07-01T10:00:05.000Z',
        },
      ] as never)
      const conv = createConversation([
        { id: 'msg-0', role: 'user', messageType: 'user', content: 'Q' },
        {
          id: 'server-assistant-1',
          role: 'assistant',
          messageType: 'agent_response',
          content: 'The finished answer.',
        },
      ])
      useChatStore.setState({ currentConversation: conv, conversations: [conv] })

      const outcome = await useChatStore
        .getState()
        ._recoverInterruptedAssistantMessage(conv.id, 'msg-0')

      expect(outcome).toBe('superseded')
      // And it did not append a second copy of the answer it already had.
      const ids = (useChatStore.getState().currentConversation?.messages ?? []).map((m) => m.id)
      expect(ids.filter((id) => id === 'server-assistant-1')).toHaveLength(1)
    })

    test('does NOT add error card when last message is an assistant response', () => {
      const conv = createConversation([
        {
          role: 'user',
          messageType: 'user',
          content: 'Hello',
          thinkingSteps: [
            {
              id: 's1',
              userMessageId: 'msg-0',
              category: 'tasks',
              functionName: 'fn',
              displayName: 'Thinking',
              content: '',
              isComplete: true,
              timestamp: new Date(),
            },
          ],
        },
        { role: 'assistant', messageType: 'agent_response', content: 'Hi there!' },
      ])

      useChatStore.setState({ currentConversation: conv, conversations: [conv] })
      useChatStore.getState().restoreSessionState(conv)

      // No error card added — response was completed
      const messages = useChatStore.getState().currentConversation?.messages ?? []
      expect(messages).toHaveLength(2)
      expect(messages.every((m) => m.messageType !== 'error')).toBe(true)
    })

    test('does NOT add error card when user message has no thinking steps', () => {
      const conv = createConversation([{ role: 'user', messageType: 'user', content: 'Hello' }])

      useChatStore.setState({ currentConversation: conv, conversations: [conv] })
      useChatStore.getState().restoreSessionState(conv)

      // No error card — no thinking steps means processing never started
      const messages = useChatStore.getState().currentConversation?.messages ?? []
      expect(messages).toHaveLength(1)
    })

    test('does NOT add error card when pending HITL interaction exists', () => {
      const conv = createConversation([
        {
          role: 'user',
          messageType: 'user',
          content: 'Research AI',
          thinkingSteps: [
            {
              id: 's1',
              userMessageId: 'msg-0',
              category: 'tasks',
              functionName: 'fn',
              displayName: 'Planning',
              content: '',
              isComplete: true,
              timestamp: new Date(),
            },
          ],
        },
        {
          role: 'assistant',
          messageType: 'prompt',
          content: 'Approve this plan?',
          promptId: 'p-1',
          promptParentId: 'msg-0',
          promptInputType: 'approval',
          isPromptResponded: false,
        },
      ])

      useChatStore.setState({ currentConversation: conv, conversations: [conv] })
      useChatStore.getState().restoreSessionState(conv)

      // No error card — unresponded prompt restores pendingInteraction, not an interruption
      const messages = useChatStore.getState().currentConversation?.messages ?? []
      expect(messages.every((m) => m.errorData?.errorCode !== 'agent.response_interrupted')).toBe(
        true
      )
    })

    test('does NOT double-add error card on repeated restore calls', async () => {
      mockConversationsClient.listMessages.mockResolvedValue([]) // empty → banner path
      const conv = createConversation([
        {
          role: 'user',
          messageType: 'user',
          content: 'Tell me about AI',
          thinkingSteps: [
            {
              id: 's1',
              userMessageId: 'msg-0',
              category: 'tasks',
              functionName: 'fn',
              displayName: 'Searching',
              content: '',
              isComplete: true,
              timestamp: new Date(),
            },
          ],
        },
      ])

      useChatStore.setState({ currentConversation: conv, conversations: [conv] })

      // First restore — adds error card after the (empty) server refetch.
      useChatStore.getState().restoreSessionState(conv)
      await vi.waitFor(() => {
        const messages = useChatStore.getState().currentConversation?.messages ?? []
        expect(
          messages.filter((m) => m.errorData?.errorCode === 'agent.response_interrupted')
        ).toHaveLength(1)
      })

      // Second restore with updated conversation (now includes error card): the
      // last meaningful message is the error card, so the interrupted branch
      // does not fire again.
      const updatedConv = useChatStore.getState().currentConversation!
      useChatStore.getState().restoreSessionState(updatedConv)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const afterSecond = useChatStore.getState().currentConversation?.messages ?? []
      expect(
        afterSecond.filter((m) => m.errorData?.errorCode === 'agent.response_interrupted')
      ).toHaveLength(1)
    })
  })

  describe('composer prefill', () => {
    test('starts empty', () => {
      expect(useChatStore.getState().composerPrefill).toBeNull()
    })

    test('setComposerPrefill queues text for the composer', () => {
      useChatStore.getState().setComposerPrefill('Ask about OIB 2 fire resistance')

      expect(useChatStore.getState().composerPrefill).toEqual({
        text: 'Ask about OIB 2 fire resistance',
      })
    })

    test('setComposerPrefill carries structured mentions alongside the text', () => {
      // The hand-off banner's prefill renders `@Piloti …`: the mention must
      // travel with the text or the send routes as a plain message (MN-3).
      useChatStore
        .getState()
        .setComposerPrefill('@Piloti ', [{ targetId: 'agent:piloti', display: 'Piloti' }])

      expect(useChatStore.getState().composerPrefill).toEqual({
        text: '@Piloti ',
        mentions: [{ targetId: 'agent:piloti', display: 'Piloti' }],
      })
    })

    test('consumeComposerPrefill returns the queued text and clears it (one-shot)', () => {
      useChatStore.getState().setComposerPrefill('Draft question')

      const first = useChatStore.getState().consumeComposerPrefill()
      const second = useChatStore.getState().consumeComposerPrefill()

      expect(first).toEqual({ text: 'Draft question' })
      expect(second).toBeNull()
      expect(useChatStore.getState().composerPrefill).toBeNull()
    })

    test('consumeComposerPrefill returns null when nothing is queued', () => {
      expect(useChatStore.getState().consumeComposerPrefill()).toBeNull()
    })

    test('consumeComposerPrefill preserves an empty-string prefill as a distinct value', () => {
      // Empty string is a valid (if unusual) prefill and must not be conflated
      // with "nothing queued" -- consume returns it once, then null.
      useChatStore.getState().setComposerPrefill('')

      expect(useChatStore.getState().consumeComposerPrefill()).toEqual({ text: '' })
      expect(useChatStore.getState().consumeComposerPrefill()).toBeNull()
    })
  })

  describe('composer drafts (per-session)', () => {
    test('starts empty', () => {
      expect(useChatStore.getState().composerDrafts).toEqual({})
      expect(useChatStore.getState().getComposerDraft('conv-1')).toBe('')
    })

    test('setComposerDraft saves in-progress text per session id', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'half typed question')

      expect(useChatStore.getState().getComposerDraft('conv-1')).toBe('half typed question')
      expect(useChatStore.getState().composerDrafts).toEqual({ 'conv-1': 'half typed question' })
    })

    test('keeps drafts isolated per session (two sessions keep separate drafts)', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'draft for one')
      useChatStore.getState().setComposerDraft('conv-2', 'draft for two')

      expect(useChatStore.getState().getComposerDraft('conv-1')).toBe('draft for one')
      expect(useChatStore.getState().getComposerDraft('conv-2')).toBe('draft for two')
    })

    test('setComposerDraft with empty string drops the entry (no orphan blank drafts)', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'something')
      useChatStore.getState().setComposerDraft('conv-1', '')

      expect(useChatStore.getState().getComposerDraft('conv-1')).toBe('')
      expect('conv-1' in useChatStore.getState().composerDrafts).toBe(false)
    })

    test('clearComposerDraft removes exactly one session draft', () => {
      useChatStore.getState().setComposerDraft('conv-1', 'draft for one')
      useChatStore.getState().setComposerDraft('conv-2', 'draft for two')

      useChatStore.getState().clearComposerDraft('conv-1')

      expect(useChatStore.getState().getComposerDraft('conv-1')).toBe('')
      expect(useChatStore.getState().getComposerDraft('conv-2')).toBe('draft for two')
    })

    test('persists drafts to localStorage so a reload restores them', async () => {
      useChatStore.setState({ currentUserId: 'user-1' })
      useChatStore.getState().setComposerDraft('conv-1', 'survives reload')

      await vi.waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).not.toBeNull()
        const parsed = JSON.parse(stored!)
        expect(parsed.state.composerDrafts).toEqual({ 'conv-1': 'survives reload' })
      })
    })

    test('deleteConversation drops the deleted session draft', () => {
      const conv: Conversation = {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Test',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: conv,
        conversations: [conv],
      })
      useChatStore.getState().setComposerDraft('conv-1', 'draft to drop')
      useChatStore.getState().setComposerDraft('conv-2', 'keep me')

      useChatStore.getState().deleteConversation('conv-1')

      expect('conv-1' in useChatStore.getState().composerDrafts).toBe(false)
      expect(useChatStore.getState().getComposerDraft('conv-2')).toBe('keep me')
    })
  })

  describe('project scoping (UX-8 cross-project bleed)', () => {
    const makeConv = (id: string, userId: string, projectId?: string | null): Conversation => ({
      id,
      userId,
      // undefined models legacy pre-scoping sessions restored from storage
      ...(projectId !== undefined && { projectId }),
      title: `Conv ${id}`,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    describe('getUserConversations', () => {
      test('inside a project, lists that project\'s sessions plus unscoped legacy sessions (fail-open)', () => {
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: 'proj-a',
          conversations: [
            makeConv('a-1', 'user-1', 'proj-a'),
            makeConv('b-1', 'user-1', 'proj-b'),
            makeConv('legacy-null', 'user-1', null),
            makeConv('legacy-undef', 'user-1'),
            makeConv('other-user', 'user-2', 'proj-a'),
          ],
        })

        const ids = useChatStore.getState().getUserConversations().map((c) => c.id)

        expect(ids).toEqual(['a-1', 'legacy-null', 'legacy-undef'])
      })

      test('without a project context, lists all of the user\'s sessions', () => {
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: null,
          conversations: [
            makeConv('a-1', 'user-1', 'proj-a'),
            makeConv('b-1', 'user-1', 'proj-b'),
            makeConv('legacy', 'user-1', null),
          ],
        })

        expect(useChatStore.getState().getUserConversations()).toHaveLength(3)
      })
    })

    describe('createConversation / ensureSession', () => {
      test('createConversation stamps the active projectId', () => {
        useChatStore.setState({ currentUserId: 'user-1', projectId: 'proj-a' })

        const conv = useChatStore.getState().createConversation()

        expect(conv.projectId).toBe('proj-a')
      })

      test('ensureSession stamps the active projectId on the new session', () => {
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: 'proj-a',
          currentConversation: null,
        })

        const sessionId = useChatStore.getState().ensureSession()

        const created = useChatStore.getState().conversations.find((c) => c.id === sessionId)
        expect(created?.projectId).toBe('proj-a')
      })
    })

    describe('selectConversation guard', () => {
      test('refuses to activate another project\'s session under the current project', () => {
        const foreign = makeConv('b-1', 'user-1', 'proj-b')
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: 'proj-a',
          conversations: [foreign],
          currentConversation: null,
        })

        useChatStore.getState().selectConversation('b-1')

        expect(useChatStore.getState().currentConversation).toBeNull()
      })

      test('allows selecting an unscoped legacy session in any project (fail-open)', () => {
        const legacy = makeConv('legacy', 'user-1', null)
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: 'proj-a',
          conversations: [legacy],
          currentConversation: null,
        })

        useChatStore.getState().selectConversation('legacy')

        expect(useChatStore.getState().currentConversation?.id).toBe('legacy')
      })
    })

    describe('deleteAllConversations scoping', () => {
      test('deletes only the current project\'s sessions and unscoped legacy sessions', () => {
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: 'proj-a',
          conversations: [
            makeConv('a-1', 'user-1', 'proj-a'),
            makeConv('a-2', 'user-1', 'proj-a'),
            makeConv('legacy', 'user-1', null),
            makeConv('b-1', 'user-1', 'proj-b'),
            makeConv('other-user', 'user-2', 'proj-a'),
          ],
          currentConversation: makeConv('a-1', 'user-1', 'proj-a'),
        })

        useChatStore.getState().deleteAllConversations()

        const state = useChatStore.getState()
        // Another project's history must survive a project-scoped delete-all.
        expect(state.conversations.map((c) => c.id).sort()).toEqual(['b-1', 'other-user'])
        expect(state.currentConversation).toBeNull()
      })

      test('keeps a foreign-project current conversation untouched', () => {
        // Defensive: currentConversation should never point at another
        // project after the guards, but delete-all must still not clear it
        // blindly if state is inconsistent.
        const foreignCurrent = makeConv('b-1', 'user-1', 'proj-b')
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: 'proj-a',
          conversations: [makeConv('a-1', 'user-1', 'proj-a'), foreignCurrent],
          currentConversation: foreignCurrent,
        })

        useChatStore.getState().deleteAllConversations()

        const state = useChatStore.getState()
        expect(state.conversations.map((c) => c.id)).toEqual(['b-1'])
        expect(state.currentConversation?.id).toBe('b-1')
      })

      test('without a project context, deletes all of the user\'s sessions (org-wide view)', () => {
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: null,
          conversations: [
            makeConv('a-1', 'user-1', 'proj-a'),
            makeConv('b-1', 'user-1', 'proj-b'),
            makeConv('other-user', 'user-2', 'proj-a'),
          ],
          currentConversation: null,
        })

        useChatStore.getState().deleteAllConversations()

        expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['other-user'])
      })

      test('drops drafts for exactly the removed sessions, keeping other projects\' drafts', () => {
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: 'proj-a',
          conversations: [
            makeConv('a-1', 'user-1', 'proj-a'),
            makeConv('legacy', 'user-1', null),
            makeConv('b-1', 'user-1', 'proj-b'),
          ],
          currentConversation: null,
        })
        useChatStore.getState().setComposerDraft('a-1', 'in scope')
        useChatStore.getState().setComposerDraft('legacy', 'legacy in scope')
        useChatStore.getState().setComposerDraft('b-1', 'other project')

        useChatStore.getState().deleteAllConversations()

        // In-scope sessions (proj-a + unscoped legacy) and their drafts are gone;
        // the other project's session and its draft are untouched.
        expect('a-1' in useChatStore.getState().composerDrafts).toBe(false)
        expect('legacy' in useChatStore.getState().composerDrafts).toBe(false)
        expect(useChatStore.getState().getComposerDraft('b-1')).toBe('other project')
      })
    })

    describe('setProjectId guard (stale state / URL restore)', () => {
      test('clears a persisted current conversation from another project when entering a project', () => {
        const foreign = makeConv('b-1', 'user-1', 'proj-b')
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: null,
          conversations: [foreign],
          currentConversation: foreign,
        })

        useChatStore.getState().setProjectId('proj-a')

        const state = useChatStore.getState()
        expect(state.projectId).toBe('proj-a')
        expect(state.currentConversation).toBeNull()
        // The session itself is NOT deleted — it stays available in its own project.
        expect(state.conversations.map((c) => c.id)).toEqual(['b-1'])
      })

      test('keeps a matching or unscoped current conversation', () => {
        const own = makeConv('a-1', 'user-1', 'proj-a')
        useChatStore.setState({
          currentUserId: 'user-1',
          currentConversation: own,
          conversations: [own],
        })

        useChatStore.getState().setProjectId('proj-a')
        expect(useChatStore.getState().currentConversation?.id).toBe('a-1')

        const legacy = makeConv('legacy', 'user-1', null)
        useChatStore.setState({ currentConversation: legacy, conversations: [legacy] })

        useChatStore.getState().setProjectId('proj-a')
        expect(useChatStore.getState().currentConversation?.id).toBe('legacy')
      })

      test('leaving the project context (null) never clears the current conversation', () => {
        const own = makeConv('a-1', 'user-1', 'proj-a')
        useChatStore.setState({
          currentUserId: 'user-1',
          projectId: 'proj-a',
          currentConversation: own,
          conversations: [own],
        })

        useChatStore.getState().setProjectId(null)

        expect(useChatStore.getState().currentConversation?.id).toBe('a-1')
      })
    })
  })
})
