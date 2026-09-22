/**
 * @vitest-environment node
 */
/**
 * Tests for chat store session busy selectors
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore, selectHasConnectionError } from './store'
import type { Conversation, ChatMessage } from './types'
import { emptyRunLedger, setRunStatus } from '@/lib/runs/run-ledger'

describe('ChatStore - Session Busy Selectors', () => {
  const conversation = (id: string, messages: ChatMessage[] = []): Conversation => ({
    id,
    userId: 'user-1',
    title: 'Test Session',
    messages,
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  const liveRunMessage: ChatMessage = {
    id: 'run-1',
    role: 'assistant',
    content: '',
    messageType: 'agent_response',
    timestamp: new Date(),
    runLedger: setRunStatus(emptyRunLedger('run-1'), 'laeuft'),
  }

  beforeEach(() => {
    useChatStore.setState({
      conversations: [],
      currentConversation: null,
      isStreaming: false,
      pendingInteraction: null,
    })
  })

  describe('isSessionBusy', () => {
    it('returns false when session has no active operations', () => {
      const conv = conversation('session-1')
      useChatStore.setState({ conversations: [conv], currentConversation: null })
      expect(useChatStore.getState().isSessionBusy('session-1')).toBe(false)
    })

    it('returns true when session is the current session with active shallow thinking', () => {
      const conv = conversation('session-1')
      useChatStore.setState({ conversations: [conv], currentConversation: conv, isStreaming: true })
      expect(useChatStore.getState().isSessionBusy('session-1')).toBe(true)
    })

    it('does not count another session as busy because the current one streams', () => {
      const current = conversation('session-current')
      const other = conversation('session-other')
      useChatStore.setState({
        conversations: [current, other],
        currentConversation: current,
        isStreaming: true,
      })
      expect(useChatStore.getState().isSessionBusy('session-other')).toBe(false)
    })

    it('does not count a live run as busy: the run is a message with its own stop', () => {
      // ADR-0062: the person keeps chatting beside the run, and a run whose
      // terminal event was lost must not hold its thread hostage.
      const conv = conversation('session-1', [liveRunMessage])
      useChatStore.setState({ conversations: [conv], currentConversation: null })
      expect(useChatStore.getState().isSessionBusy('session-1')).toBe(false)
    })

    it('handles a session not found in the conversations list', () => {
      expect(useChatStore.getState().isSessionBusy('missing')).toBe(false)
    })
  })

  describe('hasAnyBusySession', () => {
    it('returns false when no sessions have active operations', () => {
      useChatStore.setState({
        conversations: [conversation('a'), conversation('b', [liveRunMessage])],
      })
      expect(useChatStore.getState().hasAnyBusySession()).toBe(false)
    })

    it('returns true when the current session is streaming (shallow thinking)', () => {
      const conv = conversation('a')
      useChatStore.setState({ conversations: [conv], currentConversation: conv, isStreaming: true })
      expect(useChatStore.getState().hasAnyBusySession()).toBe(true)
    })

    it('returns true when pendingInteraction is set (HITL prompt awaiting response)', () => {
      useChatStore.setState({
        conversations: [conversation('a')],
        pendingInteraction: {
          id: 'interaction-1',
          parentId: 'msg-1',
          inputType: 'binary_choice',
          text: 'Approve?',
        },
      })
      expect(useChatStore.getState().hasAnyBusySession()).toBe(true)
    })
  })
})

describe('selectHasConnectionError', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [],
      currentConversation: null,
    })
  })

  it('returns false when no conversation exists', () => {
    expect(selectHasConnectionError(useChatStore.getState())).toBe(false)
  })

  it('returns false when conversation has no error messages', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { id: 'm1', role: 'user', content: 'Hello', timestamp: new Date(), messageType: 'user' } as ChatMessage,
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    useChatStore.setState({ currentConversation: conversation })
    expect(selectHasConnectionError(useChatStore.getState())).toBe(false)
  })

  it('returns true when conversation has a connection.failed error', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      messages: [
        {
          id: 'err-1',
          role: 'assistant',
          content: 'Connection failed',
          timestamp: new Date(),
          messageType: 'error',
          errorData: { errorCode: 'connection.failed' },
        } as ChatMessage,
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    useChatStore.setState({ currentConversation: conversation })
    expect(selectHasConnectionError(useChatStore.getState())).toBe(true)
  })

  it('returns true for any connection.* error code', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      messages: [
        {
          id: 'err-1',
          role: 'assistant',
          content: 'Connection lost',
          timestamp: new Date(),
          messageType: 'error',
          errorData: { errorCode: 'connection.lost' },
        } as ChatMessage,
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    useChatStore.setState({ currentConversation: conversation })
    expect(selectHasConnectionError(useChatStore.getState())).toBe(true)
  })

  it('returns false for non-connection errors (agent, system)', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      messages: [
        {
          id: 'err-1',
          role: 'assistant',
          content: 'Agent error',
          timestamp: new Date(),
          messageType: 'error',
          errorData: { errorCode: 'agent.response_failed' },
        } as ChatMessage,
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    useChatStore.setState({ currentConversation: conversation })
    expect(selectHasConnectionError(useChatStore.getState())).toBe(false)
  })
})

describe('dismissConnectionErrors', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [],
      currentConversation: null,
    })
  })

  it('removes all connection.* error messages from current conversation', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { id: 'm1', role: 'user', content: 'Hello', timestamp: new Date(), messageType: 'user' } as ChatMessage,
        {
          id: 'err-1',
          role: 'assistant',
          content: 'Connection failed',
          timestamp: new Date(),
          messageType: 'error',
          errorData: { errorCode: 'connection.failed' },
        } as ChatMessage,
        {
          id: 'err-2',
          role: 'assistant',
          content: 'Connection lost',
          timestamp: new Date(),
          messageType: 'error',
          errorData: { errorCode: 'connection.lost' },
        } as ChatMessage,
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    useChatStore.setState({
      conversations: [conversation],
      currentConversation: conversation,
    })

    useChatStore.getState().dismissConnectionErrors()

    const state = useChatStore.getState()
    expect(state.currentConversation!.messages).toHaveLength(1)
    expect(state.currentConversation!.messages[0].id).toBe('m1')
  })

  it('does not remove non-connection error messages', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      messages: [
        {
          id: 'err-1',
          role: 'assistant',
          content: 'Connection failed',
          timestamp: new Date(),
          messageType: 'error',
          errorData: { errorCode: 'connection.failed' },
        } as ChatMessage,
        {
          id: 'err-2',
          role: 'assistant',
          content: 'Agent error',
          timestamp: new Date(),
          messageType: 'error',
          errorData: { errorCode: 'agent.response_failed' },
        } as ChatMessage,
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    useChatStore.setState({
      conversations: [conversation],
      currentConversation: conversation,
    })

    useChatStore.getState().dismissConnectionErrors()

    const state = useChatStore.getState()
    expect(state.currentConversation!.messages).toHaveLength(1)
    expect(state.currentConversation!.messages[0].id).toBe('err-2')
  })

  it('does nothing when no connection errors exist', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { id: 'm1', role: 'user', content: 'Hello', timestamp: new Date(), messageType: 'user' } as ChatMessage,
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    useChatStore.setState({
      conversations: [conversation],
      currentConversation: conversation,
    })

    useChatStore.getState().dismissConnectionErrors()

    const state = useChatStore.getState()
    expect(state.currentConversation!.messages).toHaveLength(1)
  })

  it('does nothing when no current conversation exists', () => {
    useChatStore.setState({ currentConversation: null })
    // Should not throw
    useChatStore.getState().dismissConnectionErrors()
    expect(useChatStore.getState().currentConversation).toBeNull()
  })

  it('also updates the conversations list', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      messages: [
        {
          id: 'err-1',
          role: 'assistant',
          content: 'Connection failed',
          timestamp: new Date(),
          messageType: 'error',
          errorData: { errorCode: 'connection.failed' },
        } as ChatMessage,
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    useChatStore.setState({
      conversations: [conversation],
      currentConversation: conversation,
    })

    useChatStore.getState().dismissConnectionErrors()

    const state = useChatStore.getState()
    const convInList = state.conversations.find((c) => c.id === 'conv-1')
    expect(convInList!.messages).toHaveLength(0)
  })
})
