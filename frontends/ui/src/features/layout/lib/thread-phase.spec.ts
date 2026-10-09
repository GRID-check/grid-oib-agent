/**
 * One answer to "is the thread empty?", for the greeting and the composer's
 * lift alike: a thread whose messages are on their way is not empty.
 */
import { afterEach, describe, expect, test } from 'vitest'
import type { ChatMessage } from '@/features/chat/types'
import {
  clearAwaitingServerMessages,
  markAwaitingServerMessages,
} from '@/features/chat/stores/chat-storage'
import { selectThreadPhase } from './thread-phase'

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  role: 'user',
  content: 'Frage',
  timestamp: new Date(0),
  messageType: 'user',
  ...overrides,
})

afterEach(() => clearAwaitingServerMessages('c1'))

describe('selectThreadPhase', () => {
  test('before the store is read, nothing is decided', () => {
    expect(selectThreadPhase({ hasHydrated: false })).toBe('hydrating')
  })

  test('a draft, and a thread with nothing to draw, are the empty canvas', () => {
    expect(selectThreadPhase({ hasHydrated: true, currentConversation: null })).toBe('empty')
    const reportOnly = message({ role: 'assistant', messageType: 'assistant' })
    expect(
      selectThreadPhase({
        hasHydrated: true,
        currentConversation: { id: 'c1', messages: [reportOnly] },
      })
    ).toBe('empty')
  })

  test('a dropped connection alone does not make a thread', () => {
    const lost = message({
      role: 'assistant',
      messageType: 'error',
      errorData: { errorCode: 'connection.failed' },
    })
    expect(
      selectThreadPhase({ hasHydrated: true, currentConversation: { id: 'c1', messages: [lost] } })
    ).toBe('empty')
  })

  test('a thread whose history is being fetched is loading', () => {
    expect(
      selectThreadPhase({
        hasHydrated: true,
        currentConversation: { id: 'c1', messages: [] },
        pendingMessagesFor: 'c1',
      })
    ).toBe('loading')
  })

  test('a deep link to another thread is loading, whatever is open', () => {
    expect(
      selectThreadPhase({
        hasHydrated: true,
        currentConversation: { id: 'c1', messages: [message({})] },
        pendingMessagesFor: 'c2',
      })
    ).toBe('loading')
  })

  test('restored without its messages, before the server list lands: loading, then empty once asked', () => {
    markAwaitingServerMessages('c1')
    const state = { hasHydrated: true, currentConversation: { id: 'c1', messages: [] } }
    expect(selectThreadPhase({ ...state, serverConversationsLoaded: false })).toBe('loading')
    expect(selectThreadPhase({ ...state, serverConversationsLoaded: true })).toBe('empty')
  })

  test('messages on screen are a thread, even while more of its history loads', () => {
    expect(
      selectThreadPhase({
        hasHydrated: true,
        currentConversation: { id: 'c1', messages: [message({})] },
        pendingMessagesFor: 'c1',
      })
    ).toBe('thread')
  })
})
