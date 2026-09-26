/**
 * The chat store's storage keeps one key per conversation's messages and a
 * small index for the rest, so a write costs the conversation that changed,
 * and a full quota costs the oldest conversations' messages (which the server
 * holds) instead of the whole history.
 *
 * Regression: the whole history was one key. Forty conversations with real
 * cards and citations are about 5 MB; past the quota `setItem` threw and the
 * recovery wiped every stored session (React performance audit, 2026-09).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { StorageValue } from 'zustand/middleware'
import type { ChatMessage, Conversation } from '../types'
import {
  CHAT_STORAGE_BUDGET_CHARS,
  chatIndexKey,
  chatMessagesKey,
  createResilientStorage,
  isAwaitingServerMessages,
  readStoredChat,
  type PersistedChatState,
} from './chat-storage'

const KEY = 'aiq-chat-store-spec'
const NO_DRAFTS: Record<string, string> = {}

const text = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp: new Date(2026, 8, 25),
  messageType: 'agent_response',
  ...extra,
})

/** A conversation updated `minute` minutes past nine, with one answer of `size` characters. */
const conv = (id: string, minute: number, size = 100): Conversation => ({
  id,
  userId: 'u1',
  title: `Sitzung ${id}`,
  messages: [text(`${id}-a`, 'x'.repeat(size))],
  createdAt: new Date(2026, 8, 25, 9),
  updatedAt: new Date(2026, 8, 25, 9, minute),
})

const value = (
  conversations: Conversation[],
  open: Conversation | null = conversations[0] ?? null,
  drafts = NO_DRAFTS
): StorageValue<PersistedChatState> => ({
  state: {
    currentUserId: 'u1',
    conversations,
    currentConversation: open,
    pendingInteraction: null,
    composerDrafts: drafts,
  },
  version: 0,
})

const quotaError = (): Error => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })

/** Make localStorage refuse any write that would take it past `limit` characters. */
const withQuota = (limit: number) => {
  const original = localStorage.setItem.bind(localStorage)
  return vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, next: string) => {
    let total = 0
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      if (k !== key) total += k.length + localStorage.getItem(k)!.length
    }
    if (total + key.length + next.length > limit) throw quotaError()
    original(key, next)
  })
}

const messageKeys = (): string[] => {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    if (k.startsWith(`${KEY}:messages:`)) keys.push(k.slice(`${KEY}:messages:`.length))
  }
  return keys.sort()
}

describe('chat storage, one key per conversation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  test('a change in one conversation writes that conversation and the index, nothing else', () => {
    const storage = createResilientStorage()!
    const a = conv('a', 3)
    const b = conv('b', 2)
    const c = conv('c', 1)
    storage.setItem(KEY, value([a, b, c]))
    expect(messageKeys()).toEqual(['a', 'b', 'c'])

    const setItem = vi.spyOn(localStorage, 'setItem')
    const b2: Conversation = {
      ...b,
      messages: [...b.messages, text('b-2', 'Nachtrag')],
      updatedAt: new Date(2026, 8, 25, 9, 4),
    }
    storage.setItem(KEY, value([b2, a, c], a))
    expect(setItem.mock.calls.map(([key]) => key).sort()).toEqual(
      [chatIndexKey(KEY), chatMessagesKey(KEY, 'b')].sort()
    )
    expect(readStoredChat(KEY)?.state.conversations.find((x) => x.id === 'b')?.messages).toHaveLength(2)
  })

  test('opening another conversation writes the index alone', () => {
    const storage = createResilientStorage()!
    const a = conv('a', 2)
    const b = conv('b', 1)
    storage.setItem(KEY, value([a, b], a))
    const setItem = vi.spyOn(localStorage, 'setItem')
    storage.setItem(KEY, value([a, b], b))
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([chatIndexKey(KEY)])
    expect(readStoredChat(KEY)?.state.currentConversation).toBe('b')
  })

  test('a full quota evicts the oldest conversations’ messages and keeps the list, never wipes', () => {
    const storage = createResilientStorage()!
    const open = conv('open', 1, 2_000)
    const old = conv('old', 2, 2_000)
    const mid = conv('mid', 3, 2_000)
    const drafts = { mid: 'Entwurf, nur hier' }
    storage.setItem(KEY, value([open, mid, old], open, drafts))
    expect(messageKeys()).toEqual(['mid', 'old', 'open'])

    const used = Array.from({ length: localStorage.length }, (_, i) => {
      const k = localStorage.key(i)!
      return k.length + localStorage.getItem(k)!.length
    }).reduce((sum, n) => sum + n, 0)
    withQuota(used + 1_000)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A newer conversation arrives that does not fit beside the rest.
    const fresh = conv('fresh', 9, 2_000)
    storage.setItem(KEY, value([fresh, open, mid, old], open, drafts))

    // The oldest went; the open one, however old, stays; the new one is in.
    expect(messageKeys()).toEqual(['fresh', 'mid', 'open'])
    const stored = readStoredChat(KEY)!.state
    // The list, the titles and the drafts: all still there.
    expect(stored.conversations.map((c) => c.id)).toEqual(['fresh', 'open', 'mid', 'old'])
    expect(stored.composerDrafts).toEqual(drafts)
    expect(stored.conversations.find((c) => c.id === 'old')?.title).toBe('Sitzung old')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Evicted'), expect.anything())
    expect(error).not.toHaveBeenCalled()
  })

  test('a reload reads an evicted conversation as waiting for the server, not as empty', async () => {
    const storage = createResilientStorage()!
    const open = conv('open', 2)
    const old = conv('old', 1)
    storage.setItem(KEY, value([open, old], open))
    localStorage.removeItem(chatMessagesKey(KEY, 'old'))

    const restored = await createResilientStorage()!.getItem(KEY)
    const oldRestored = restored?.state.conversations.find((c) => c.id === 'old')
    expect(oldRestored?.messages).toEqual([])
    expect(isAwaitingServerMessages('old')).toBe(true)
    expect(isAwaitingServerMessages('open')).toBe(false)
    expect(restored?.state.currentConversation?.id).toBe('open')
  })

  test('a conversation too large to store alone is left to the server, and nothing else is lost', () => {
    const storage = createResilientStorage()!
    const small = conv('small', 1, 100)
    storage.setItem(KEY, value([small], small))
    withQuota(5_000)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const huge = conv('huge', 2, 10_000)
    storage.setItem(KEY, value([huge, small], small))
    expect(messageKeys()).toEqual(['small'])
    expect(readStoredChat(KEY)?.state.conversations.map((c) => c.id)).toEqual(['huge', 'small'])
  })

  test('past the budget the oldest conversation is left to the server, before the quota says so', () => {
    const storage = createResilientStorage()!
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const half = Math.ceil(CHAT_STORAGE_BUDGET_CHARS / 2)
    const open = conv('open', 1, 100)
    storage.setItem(KEY, value([open, conv('newer', 3, half), conv('older', 2, half)], open))
    expect(messageKeys()).toEqual(['newer', 'open'])
    expect(readStoredChat(KEY)?.state.conversations.map((c) => c.id)).toEqual(['open', 'newer', 'older'])
  })

  test('a conversation with a run still going is never evicted for another', () => {
    const storage = createResilientStorage()!
    const open = conv('open', 3, 2_000)
    const running: Conversation = {
      ...conv('running', 1, 2_000),
      messages: [
        text('r-a', 'Recherche läuft', {
          runLedger: { runId: 'run-1', status: 'laeuft', phases: [] } as unknown as ChatMessage['runLedger'],
        }),
      ],
    }
    const idle = conv('idle', 2, 2_000)
    storage.setItem(KEY, value([open, idle, running], open))
    const used = Array.from({ length: localStorage.length }, (_, i) => {
      const k = localStorage.key(i)!
      return k.length + localStorage.getItem(k)!.length
    }).reduce((sum, n) => sum + n, 0)
    withQuota(used + 500)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    storage.setItem(KEY, value([conv('fresh', 9, 2_000), open, idle, running], open))
    expect(messageKeys()).toEqual(['fresh', 'open', 'running'])
  })

  test('removeItem clears the index and every conversation, and a stray key is dropped on read', async () => {
    const storage = createResilientStorage()!
    storage.setItem(KEY, value([conv('a', 1)]))
    localStorage.setItem(chatMessagesKey(KEY, 'stray'), '[]')
    await createResilientStorage()!.getItem(KEY)
    expect(messageKeys()).toEqual(['a'])

    storage.removeItem(KEY)
    expect(localStorage.getItem(chatIndexKey(KEY))).toBeNull()
    expect(messageKeys()).toEqual([])
  })
})

describe('moving the single key into one key per conversation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** What the old storage wrote: the whole history under `KEY`, the open conversation as its id. */
  const legacy = (conversations: Conversation[], openId: string | null) =>
    JSON.stringify({
      state: {
        currentUserId: 'u1',
        conversations,
        currentConversation: openId,
        pendingInteraction: null,
        composerDrafts: { b: 'halb geschrieben' },
      },
      version: 0,
    })

  test('reads the old key once, splits it, removes it, and loses nothing', async () => {
    const a: Conversation = { ...conv('a', 2), enabledDataSourceIds: ['web_search'] }
    const b: Conversation = {
      ...conv('b', 1),
      messages: [text('b-1', 'fertig'), text('b-2', 'Brucht', { isStreaming: true })],
    }
    localStorage.setItem(KEY, legacy([a, b], 'b'))

    const restored = await createResilientStorage()!.getItem(KEY)

    // What the page gets is what the old storage would have given it.
    expect(restored?.state.conversations.map((c) => c.id)).toEqual(['a', 'b'])
    expect(restored?.state.currentConversation?.id).toBe('b')
    expect(restored?.state.composerDrafts).toEqual({ b: 'halb geschrieben' })
    // The fragment of an interrupted answer is dropped, as a read always did.
    expect(restored?.state.conversations[1]?.messages.map((m) => m.id)).toEqual(['b-1'])

    // And storage now holds it in the new shape, without the old key.
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(messageKeys()).toEqual(['a', 'b'])
    const again = await createResilientStorage()!.getItem(KEY)
    expect(again?.state.conversations.map((c) => c.messages.length)).toEqual([1, 1])
    expect(again?.state.conversations[0]?.enabledDataSourceIds).toEqual(['web_search'])
    expect(again?.state.composerDrafts).toEqual({ b: 'halb geschrieben' })
    expect(again?.state.currentConversation?.id).toBe('b')
  })

  test('an old key at the quota moves too: the index first, then the newest conversations', async () => {
    const conversations = [conv('new', 3, 2_000), conv('mid', 2, 2_000), conv('old', 1, 2_000)]
    const raw = legacy(conversations, 'new')
    localStorage.setItem(KEY, raw)
    // Nothing fits beside the old key (already past this quota), and not all
    // of it fits in the new shape.
    withQuota(Math.floor(raw.length * 0.8))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const restored = await createResilientStorage()!.getItem(KEY)
    // This page has everything in memory.
    expect(restored?.state.conversations.map((c) => c.messages.length)).toEqual([1, 1, 1])
    // Storage has the whole list and the drafts, and the newest messages.
    expect(localStorage.getItem(KEY)).toBeNull()
    const stored = readStoredChat(KEY)!.state
    expect(stored.conversations.map((c) => c.id)).toEqual(['new', 'mid', 'old'])
    expect(stored.composerDrafts).toEqual({ b: 'halb geschrieben' })
    expect(messageKeys()).toContain('new')
    expect(messageKeys()).not.toContain('old')
  })

  test('an old key that cannot be read is removed rather than read again on every load', async () => {
    localStorage.setItem(KEY, '{not json')
    expect(await createResilientStorage()!.getItem(KEY)).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
