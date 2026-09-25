/**
 * The persisted chat store writes a streaming answer at most once per
 * `STREAMING_PERSIST_INTERVAL_MS`, and everything else at once.
 *
 * Every delta flush is a store update, and each update used to prune,
 * serialize and write the whole history to localStorage on the main thread:
 * 74 writes of 1.3 MB for one twelve-second answer, measured on
 * `/dev/stream-chat`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { StorageValue } from 'zustand/middleware'
import type { ChatMessage, Conversation } from '../types'
import { STREAMING_PERSIST_INTERVAL_MS, createResilientStorage } from './sessions-store'

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

const value = (
  content: string,
  isStreaming: boolean,
  { others = [] as Conversation[], drafts = NO_DRAFTS } = {}
) => {
  const conversation: Conversation = {
    id: 'c1',
    userId: 'u1',
    title: 'T',
    messages: [message(content, isStreaming)],
    createdAt: new Date(2026, 8, 25),
    updatedAt: new Date(2026, 8, 25),
  }
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
    // Every storage listens for pagehide for good; let each test's leftovers
    // land now, before the next test clears storage, not inside a later test.
    window.dispatchEvent(new Event('pagehide'))
    vi.useRealTimers()
  })

  test('a streaming answer is written once per window, with its newest text', () => {
    const storage = createResilientStorage()!
    const setItem = vi.spyOn(localStorage, 'setItem')

    storage.setItem(KEY, value('a', true))
    storage.setItem(KEY, value('ab', true))
    storage.setItem(KEY, value('abc', true))
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(storedContent()).toBe('a')

    vi.advanceTimersByTime(STREAMING_PERSIST_INTERVAL_MS)
    expect(setItem).toHaveBeenCalledTimes(2)
    expect(storedContent()).toBe('abc')
    setItem.mockRestore()
  })

  test('the settled answer is written at once and replaces the held one', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    storage.setItem(KEY, value('ab', true))
    storage.setItem(KEY, value('abc final', false))
    expect(storedContent()).toBe('abc final')

    // The held streaming value must not land afterwards over the settled one.
    vi.advanceTimersByTime(STREAMING_PERSIST_INTERVAL_MS * 2)
    expect(storedContent()).toBe('abc final')
  })

  test('leaving the page writes what a streaming answer still holds', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    storage.setItem(KEY, value('ab', true))
    window.dispatchEvent(new Event('pagehide'))
    expect(storedContent()).toBe('ab')
  })

  test('removing the item drops what a streaming answer still holds', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    storage.setItem(KEY, value('ab', true))
    storage.removeItem(KEY)
    vi.advanceTimersByTime(STREAMING_PERSIST_INTERVAL_MS * 2)
    expect(localStorage.getItem(KEY)).toBeNull()
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
    // Not held for the window: a browser that dies now must not bring it back.
    expect(storedIds()).toEqual(['c1'])
    expect(storedContent()).toBe('abc')
  })

  test('a draft typed while an answer streams is written at once', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    storage.setItem(KEY, value('ab', true, { drafts: { c1: 'Nachfrage' } }))
    expect(JSON.parse(localStorage.getItem(KEY)!).state.composerDrafts).toEqual({ c1: 'Nachfrage' })
  })

  test('a deferred write that fails is held again, and the next flush writes it', () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value('a', true))
    storage.setItem(KEY, value('ab', true))
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('SecurityError')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.advanceTimersByTime(STREAMING_PERSIST_INTERVAL_MS)
    expect(storedContent()).toBe('a')

    window.dispatchEvent(new Event('pagehide'))
    expect(storedContent()).toBe('ab')
    setItem.mockRestore()
    error.mockRestore()
  })
})
