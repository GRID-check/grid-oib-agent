import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { useChatStore } from './store'
import {
  clearAwaitingServerMessages,
  markAwaitingServerMessages,
  readStoredChat,
} from './stores/chat-storage'
import type { Conversation } from './types'

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
  // No frames in the replay stream: no turn still working to wait for.
  newestFrameAge: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: mockConversationsClient,
}))

describe('useChatStore', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    useChatStore.persist.clearStorage()
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
      pendingInteraction: null,
      composerPrefill: null,
      composerSubject: null,
      composerDrafts: {},
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    // Clean up localStorage after each test
    useChatStore.persist.clearStorage()
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
      expect(state.pendingInteraction).toBeNull()
    })
  })

  describe('setCurrentUser', () => {
    test('sets user ID', () => {
      useChatStore.getState().setCurrentUser('user-1')

      expect(useChatStore.getState().currentUserId).toBe('user-1')
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
      })

      useChatStore.getState().startNewSessionDraft()

      expect(useChatStore.getState().isStreaming).toBe(false)
      expect(useChatStore.getState().isLoading).toBe(false)
      expect(useChatStore.getState().currentUserMessageId).toBeNull()
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

    test('selectConversation keeps a conversation whose messages are still on the server', () => {
      // Storage evicted its messages (or the server list brought it without
      // them): opened and left before they arrived, it looks upload-only and
      // would be deleted, on the server too.
      markAwaitingServerMessages('evicted')
      const evicted: Conversation = {
        id: 'evicted',
        userId: 'user-1',
        title: 'Ältere Sitzung',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const other: Conversation = { ...evicted, id: 'other-3', title: 'Andere' }
      useChatStore.setState({
        currentUserId: 'user-1',
        currentConversation: evicted,
        conversations: [evicted, other],
      })

      useChatStore.getState().selectConversation('other-3')

      expect(useChatStore.getState().conversations.some((c) => c.id === 'evicted')).toBe(true)
      expect(mockConversationsClient.delete).not.toHaveBeenCalledWith('evicted')
      expect(mockDiscardSessionResources).not.toHaveBeenCalledWith('evicted')
      clearAwaitingServerMessages('evicted')
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
      // overwrites it with the first thing the user typed. Reusing it here would
      // restore the subject as "fass das dokument zusammen" and send that string on
      // the wire as `focus_file_name`, matching no document — and the bar's own
      // repair lookup would skip, because a title was present.
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
      })

      const message = useChatStore.getState().addUserMessage('Hello')

      expect(useChatStore.getState().isLoading).toBe(true)
      // currentUserMessageId is updated to the new message
      expect(useChatStore.getState().currentUserMessageId).toBe(message.id)
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
        const parsed = readStoredChat(STORAGE_KEY)!
        expect(parsed).not.toBeNull()
        expect(parsed.state.conversations).toHaveLength(2)
      })

      // Verify initial localStorage state
      const beforeDelete = readStoredChat(STORAGE_KEY)!
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
        const parsed = readStoredChat(STORAGE_KEY)!
        expect(parsed.state.conversations).toHaveLength(1)
      })

      // Verify localStorage was updated correctly
      const afterDelete = readStoredChat(STORAGE_KEY)!

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
        const parsed = readStoredChat(STORAGE_KEY)!
        expect(parsed).not.toBeNull()
        expect(parsed.state.currentConversation).toBe('conv-current')
      })

      // Delete the current conversation
      useChatStore.getState().deleteConversation('conv-current')

      // Wait for persist to sync
      await vi.waitFor(() => {
        const parsed = readStoredChat(STORAGE_KEY)!
        expect(parsed.state.conversations).toHaveLength(0)
      })

      // Verify currentConversation is cleared in localStorage
      const stored = readStoredChat(STORAGE_KEY)!
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
        const parsed = readStoredChat(STORAGE_KEY)!
        expect(parsed).not.toBeNull()
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

  describe('project scoping (cross-project bleed)', () => {
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
      test("inside a project, lists that project's sessions plus unscoped sessions (fail-open)", () => {
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

        const ids = useChatStore
          .getState()
          .getUserConversations()
          .map((c) => c.id)

        expect(ids).toEqual(['a-1', 'legacy-null', 'legacy-undef'])
      })

      test("without a project context, lists all of the user's sessions", () => {
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
      test("refuses to activate another project's session under the current project", () => {
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

      test('allows selecting an unscoped session in any project (fail-open)', () => {
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
      test("deletes only the current project's sessions and unscoped sessions", () => {
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

      test("without a project context, deletes all of the user's sessions (org-wide view)", () => {
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

      test("drops drafts for exactly the removed sessions, keeping other projects' drafts", () => {
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
