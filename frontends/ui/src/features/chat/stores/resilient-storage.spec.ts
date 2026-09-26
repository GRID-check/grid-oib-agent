/**
 * The persisted chat store never writes a live turn's growth (the streaming
 * answer, the question's reasoning steps), writes a composer draft a moment
 * after the last keystroke, and writes everything else at once.
 *
 * Every delta flush is a store update, and each update used to prune,
 * serialize and write the whole history to localStorage on the main thread:
 * 74 writes of 1.3 MB for one twelve-second answer, measured on
 * `/dev/stream-chat`. Coalesced to one write per two seconds, it was still a
 * regular hitch on a phone, for bytes a reload drops on read.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { StorageValue } from 'zustand/middleware'
import type { ChatMessage, Conversation } from '../types'
import { createResilientStorage } from './sessions-store'

const KEY = 'aiq-chat-store-spec'

const message = (content: string, isStreaming: boolean): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  content,
  timestamp: new Date(2026, 8, 25),
  messageType: 'assistant',
  isStreaming,
})

// The store keeps a field it did not change as the same object; so must the fixtures.
const NO_DRAFTS: Record<string, string> = {}

const OTHER: Conversation = {
  id: 'c2',
  userId: 'u1',
  title: 'Eine andere Sitzung',
  messages: [],
  createdAt: new Date(2026, 8, 24),
  updatedAt: new Date(2026, 8, 24),
}

const OPEN: Conversation = {
  id: 'c1',
  userId: 'u1',
  title: 'T',
  messages: [],
  createdAt: new Date(2026, 8, 25),
  updatedAt: new Date(2026, 8, 25),
}

const value = (
  content: string,
  isStreaming: boolean,
  { others = [] as Conversation[], drafts = NO_DRAFTS } = {}
) => {
  // Every field but the messages is the same object from call to call, as
  // the store keeps what a flush does not touch.
  const conversation: Conversation = { ...OPEN, messages: [message(content, isStreaming)] }
  const state = {
    currentUserId: 'u1',
    conversations: [conversation, ...others],
    currentConversation: conversation,
    pendingInteraction: null,
    composerDrafts: drafts,
  }
  return { state, version: 0 } as StorageValue<typeof state>
}

const storedIds = (): string[] =>
  JSON.parse(localStorage.getItem(KEY)!).state.conversations.map((c: Conversation) => c.id)

const storedContent = (): string | undefined => {
  const raw = localStorage.getItem(KEY)
  return raw ? JSON.parse(raw).state.conversations[0].messages[0].content : undefined
}

describe('createResilientStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a streaming answer is not written while it grows, however long it streams', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    const setItem = vi.spyOn(localStorage, 'setItem')

    storage.setItem(KEY, value('ab', true))
    storage.setItem(KEY, value('abc', true))
    vi.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event('pagehide'))

    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  test('a rename while the answer streams is written at once', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    const renamed = value('ab', true)
    const conversation = { ...renamed.state.currentConversation!, title: 'Neuer Titel' }
    storage.setItem(KEY, {
      ...renamed,
      state: { ...renamed.state, currentConversation: conversation, conversations: [conversation] },
    })
    expect(JSON.parse(localStorage.getItem(KEY)!).state.conversations[0].title).toBe('Neuer Titel')
  })

  test('the settled answer is written at once', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    storage.setItem(KEY, value('ab', true))
    storage.setItem(KEY, value('abc final', false))
    expect(storedContent()).toBe('abc final')
  })

  test('what a reload reads is the same whether or not the growth was written', async () => {
    // `getItem` drops an answer still marked streaming; that is why skipping
    // its growth loses nothing a reload could use.
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    const restored = await storage.getItem(KEY)
    expect(restored?.state.conversations?.[0]?.messages).toEqual([])
  })

  test('a call whose persisted fields are the same objects does no work at all', () => {
    const storage = createResilientStorage()!
    const first = value('a', false)
    storage.setItem(KEY, first)
    const getItem = vi.spyOn(localStorage, 'getItem')
    const setItem = vi.spyOn(localStorage, 'setItem')

    // What `persist` hands over for a loading flag or a thinking step: a new
    // wrapper around the very same persisted fields.
    storage.setItem(KEY, { ...first, state: { ...first.state } })
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    getItem.mockRestore()
    setItem.mockRestore()
  })

  test('any persisted field that is a new object is written, a field partialize gains later too', () => {
    const storage = createResilientStorage()!
    const first = value('a', false)
    storage.setItem(KEY, first)

    storage.setItem(KEY, { ...first, state: { ...first.state, composerDrafts: { c1: 'Entwurf' } } })
    vi.advanceTimersByTime(1_000)
    expect(JSON.parse(localStorage.getItem(KEY)!).state.composerDrafts).toEqual({ c1: 'Entwurf' })

    // The skip lets it through to the write path, which reads what is stored
    // to compare. (Whether the field is serialized is the pruner's business.)
    const current = JSON.parse(localStorage.getItem(KEY)!).state
    const getItem = vi.spyOn(localStorage, 'getItem')
    const withNewField = { ...first.state, composerDrafts: current.composerDrafts, later: 1 }
    storage.setItem(KEY, { ...first, state: withNewField as typeof first.state })
    expect(getItem).toHaveBeenCalledTimes(1)
    getItem.mockRestore()
  })

  test('a conversation deleted while an answer streams leaves storage at once', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true, { others: [OTHER] }))
    storage.setItem(KEY, value('ab', true, { others: [OTHER] }))
    expect(storedIds()).toEqual(['c1', 'c2'])

    storage.setItem(KEY, value('abc', true))
    // Not skipped: a browser that dies now must not bring it back.
    expect(storedIds()).toEqual(['c1'])
    expect(storedContent()).toBe('abc')
  })

  test('a draft is written once, a moment after the last keystroke, not with every key', () => {
    const storage = createResilientStorage()!
    const first = value('a', false)
    storage.setItem(KEY, first)
    const setItem = vi.spyOn(localStorage, 'setItem')
    for (const typed of ['N', 'Na', 'Nac', 'Nach']) {
      // A keystroke changes the drafts and nothing else.
      storage.setItem(KEY, { ...first, state: { ...first.state, composerDrafts: { c1: typed } } })
      vi.advanceTimersByTime(100)
    }
    expect(setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(KEY)!).state.composerDrafts).toEqual({ c1: 'Nach' })
    setItem.mockRestore()
  })

  test('a draft typed while an answer streams is written a moment later, and when the page hides', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    storage.setItem(KEY, value('ab', true, { drafts: { c1: 'Nachfrage' } }))
    window.dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(localStorage.getItem(KEY)!).state.composerDrafts).toEqual({ c1: 'Nachfrage' })
  })

  test('the reasoning steps of the question being answered are not written as they arrive', () => {
    const storage = createResilientStorage()!
    const question: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Frage',
      timestamp: new Date(2026, 8, 25),
      messageType: 'user',
    }
    const withSteps = (count: number) => {
      const conversation: Conversation = {
        ...OPEN,
        messages: [
          count === 0
            ? question
            : {
                ...question,
                thinkingSteps: Array.from({ length: count }, (_, i) => ({
                  id: `s${i}`,
                  userMessageId: 'u1',
                  category: 'tools' as const,
                  functionName: 'knowledge_search',
                  displayName: 'Suche',
                  content: '',
                  timestamp: new Date(2026, 8, 25),
                  isComplete: false,
                })),
              },
        ],
      }
      const state = {
        currentUserId: 'u1',
        conversations: [conversation],
        currentConversation: conversation,
        pendingInteraction: null,
        composerDrafts: NO_DRAFTS,
      }
      return { state, version: 0 } as StorageValue<typeof state>
    }
    storage.setItem(KEY, withSteps(0))
    const setItem = vi.spyOn(localStorage, 'setItem')
    storage.setItem(KEY, withSteps(1))
    storage.setItem(KEY, withSteps(2))
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })
})
