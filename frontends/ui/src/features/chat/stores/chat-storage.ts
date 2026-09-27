/**
 * The persisted chat store's storage: one localStorage key per conversation's
 * messages, and one small index key for everything else.
 *
 * ```
 * <name>:index           {version, state: {currentUserId, currentConversation (an id),
 *                          pendingInteraction, composerDrafts, conversations: [every field but messages],
 *                          awaitingServerMessages: [ids whose messages were never loaded]}}
 * <name>:messages:<id>   that conversation's messages, pruned (`pruneMessageForStorage`)
 * ```
 *
 * Why this shape (2026-09, React performance audit, 390 px at 4× CPU throttle):
 * the whole history used to be ONE key. Every write pruned, serialized and
 * wrote all of it (250–700 ms a send, a settle or a switch with 20–40
 * conversations), and past the quota (40 conversations with real cards and
 * citations were about 5 MB) `setItem` threw and the recovery wiped every
 * stored session. Now a write costs the conversation that changed plus the
 * index, and the quota costs the oldest conversations' messages, never the
 * list.
 *
 * Evicting messages is safe because localStorage is a cache of the server
 * here: every message is posted as it is created (`_appendMessage`), the
 * backend persists every finished answer itself, the Herleitung, card
 * decisions, prompt answers and post-answer stages are mirrored to the
 * message row, and a conversation whose messages are missing is fetched
 * again when it is opened (`hydrateConversationMessages`). What exists only
 * here lives in the index, which is never evicted: the drafts, the
 * conversation list with each one's title and data-source choice, the open
 * question.
 *
 * The rules a write follows, kept from the single-key storage:
 * - a live turn's growth (the streaming answer, the question's reasoning
 *   steps) is never written: `getItem` drops an answer still marked streaming,
 *   so it would read back as the last write does;
 * - a composer draft is written 400 ms after the last keystroke and when the
 *   page hides;
 * - anything else (a deletion, a rename, a new session, a settled turn) is
 *   written at once;
 * - a store update that leaves every persisted field the same object writes
 *   and serializes nothing.
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware'
import type { ChatMessage, ChatState, Conversation } from '../types'
import { pruneMessageForStorage } from '../lib/prune-message-for-storage'
import { hasLiveRun } from '../lib/session-activity'
import {
  logStorageAvailability,
  logStorageEviction,
  logStorageFailure,
  logStorageMigration,
  logStorageWrite,
} from '../lib/storage-logger'

export type PersistedChatState = {
  currentUserId: ChatState['currentUserId']
  conversations: ChatState['conversations']
  currentConversation: ChatState['currentConversation']
  pendingInteraction: ChatState['pendingInteraction']
  composerDrafts: ChatState['composerDrafts']
}

type PersistedChatStorageValue = StorageValue<PersistedChatState>

/** A conversation as the index holds it: everything but its messages. */
type ConversationEntry = Omit<Conversation, 'messages'>

type StoredIndex = {
  version?: number
  state: {
    currentUserId: string | null
    currentConversation: string | null
    pendingInteraction: PersistedChatState['pendingInteraction']
    composerDrafts: PersistedChatState['composerDrafts']
    conversations: ConversationEntry[]
    /** Conversations whose messages this browser never loaded (see below). */
    awaitingServerMessages?: string[]
  }
}

/** The key of the small record that names every conversation. */
export const chatIndexKey = (name: string): string => `${name}:index`

const messagesKeyPrefix = (name: string): string => `${name}:messages:`

/** The key of one conversation's messages. */
export const chatMessagesKey = (name: string, conversationId: string): string =>
  `${messagesKeyPrefix(name)}${conversationId}`

/** How long after the last keystroke a composer draft is written. */
const DRAFT_WRITE_DELAY_MS = 400

/**
 * What the chat store lets itself hold, in characters, before it evicts the
 * oldest conversations' messages. Headroom for the rest of the origin (the
 * layout store): the real quota is per origin and differs by browser and by
 * content (Chromium stores a Latin-1 string at one byte a character, anything
 * else at two), so a `QuotaExceededError` below this evicts as well.
 */
export const CHAT_STORAGE_BUDGET_CHARS = 3_000_000

// ---------------------------------------------------------------------------
// Conversations whose messages this page does not have
// ---------------------------------------------------------------------------

/**
 * Conversations known to have messages this page has not loaded: evicted from
 * storage, or listed by the server without them. An empty message list means
 * "not here", not "none", and nothing may act on it as if it were the thread:
 * the upload-only cleanup used to delete such a conversation on the server
 * when it was opened and left before its messages arrived.
 *
 * The set outlives a reload: the index names its members, an awaiting
 * conversation's empty list is never written as `[]`, and a read takes a
 * missing, unreadable or empty message key as awaiting too. Held only in
 * memory, a reload after any write turned "not loaded" into a stored `[]`, and
 * the cleanup deleted the conversation on the server again (2026-09).
 */
const awaitingServerMessages = new Set<string>()

export const markAwaitingServerMessages = (conversationId: string): void => {
  awaitingServerMessages.add(conversationId)
}

export const clearAwaitingServerMessages = (conversationId: string): void => {
  awaitingServerMessages.delete(conversationId)
}

export const isAwaitingServerMessages = (conversationId: string): boolean =>
  awaitingServerMessages.has(conversationId)

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const isQuotaExceededError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if (error.name === 'QuotaExceededError') return true
  return /quota|exceeded|storage/i.test(error.message)
}

const updatedAtMs = (conversation: { updatedAt: Date | string }): number =>
  new Date(conversation.updatedAt).getTime() || 0

const entryOf = (conversation: Conversation): ConversationEntry => {
  const { messages: _messages, ...entry } = conversation
  return entry
}

/** Are `a` and `b` the same in every field but `except`, field by field? */
function sameExcept(a: Conversation, b: Conversation, except: 'messages'): boolean
function sameExcept(a: ChatMessage, b: ChatMessage, except: 'thinkingSteps'): boolean
function sameExcept(
  a: Conversation | ChatMessage,
  b: Conversation | ChatMessage,
  except: 'messages' | 'thinkingSteps'
): boolean {
  const aFields: Record<string, unknown> = { ...a }
  const bFields: Record<string, unknown> = { ...b }
  for (const key of new Set([...Object.keys(aFields), ...Object.keys(bFields)])) {
    if (key !== except && aFields[key] !== bFields[key]) return false
  }
  return true
}

/** Where the newest question is: the last message from a person. */
const lastUserMessageIndex = (messages: readonly ChatMessage[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.messageType === 'user' || message.role === 'user') return i
  }
  return -1
}

/**
 * Is the live turn's growth the only difference between two versions of one
 * conversation's messages: the streaming answer at its end, and the reasoning
 * steps of the question it answers? Every other message must be the very
 * same object: a card decision while a turn works is written at once. The
 * store keeps an untouched message as the same object on every flush.
 *
 * The steps count as growth because each one wrote the whole history: 5–6
 * writes of 250–1000 ms per turn on a 4× throttled phone with 40
 * conversations stored (React performance audit, 2026-09). The turn's user
 * message was written when it was sent, and the settled turn is written with
 * its steps; a page that dies between gets the turn back from the replay
 * stream or the server.
 */
export const onlyTheLiveTurnGrewIn = (
  was: readonly ChatMessage[],
  now: readonly ChatMessage[]
): boolean => {
  // The answer opened since the last write (one more message), or grew (same count).
  if (now.length !== was.length && now.length !== was.length + 1) return false
  const last = now[now.length - 1]
  if (now.length === was.length + 1 && !last?.isStreaming) return false
  const question = lastUserMessageIndex(now)
  for (let i = 0; i < now.length; i++) {
    const message = now[i]!
    const previous = was[i]
    if (message === previous) continue
    if (i === now.length - 1 && message.isStreaming) continue
    if (i === question && previous && sameExcept(previous, message, 'thinkingSteps')) continue
    return false
  }
  return true
}

/** The same conversation, and nothing but its live turn grew. */
const onlyTheLiveTurnGrew = (
  before: Conversation | null | undefined,
  after: Conversation | null | undefined
): boolean => {
  if (!before || !after || before.id !== after.id) return false
  if (!sameExcept(before, after, 'messages')) return false
  return onlyTheLiveTurnGrewIn(before.messages, after.messages)
}

/**
 * Nothing streams in a page that is only now loading, so an answer stored
 * mid-stream was interrupted by the reload. Its text is a fragment this page
 * cannot finish: the reattached turn opens a bubble of its own, and the
 * fragment used to stay beside it with a caret forever. It also hid the turn
 * from the recovery that fetches a finished answer (`restoreSessionState`
 * looks for an unanswered question), so the reload is handed to that path,
 * the one a reload before the first word already takes. A connection error is
 * about a socket that no longer exists.
 */
const restorableMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter(
    (m) =>
      m.isStreaming !== true &&
      !(m.messageType === 'error' && m.errorData?.errorCode?.startsWith('connection.'))
  )

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const asStoredIndex = (value: unknown): StoredIndex | null => {
  if (!value || typeof value !== 'object') return null
  const state = (value as { state?: unknown }).state
  if (!state || typeof state !== 'object') return null
  const conversations = (state as { conversations?: unknown }).conversations
  return Array.isArray(conversations) ? (value as StoredIndex) : null
}

/**
 * The stored chat as the old single key, `<name>`, held it: the whole state
 * with the open conversation as its id. Assembled from the index and the
 * message keys; a conversation whose messages are not stored has none.
 * `getItem` builds on this, and specs read storage through it.
 */
export const readStoredChat = (name: string): PersistedChatStorageValue | null => {
  const index = asStoredIndex(parseJson(localStorage.getItem(chatIndexKey(name))))
  if (!index) return null
  const conversations = index.state.conversations.map((entry) => {
    const messages = parseJson(localStorage.getItem(chatMessagesKey(name, entry.id)))
    return { ...entry, messages: Array.isArray(messages) ? (messages as ChatMessage[]) : [] }
  })
  return {
    version: index.version,
    state: {
      currentUserId: index.state.currentUserId ?? null,
      conversations: conversations as Conversation[],
      currentConversation: (index.state.currentConversation ?? null) as unknown as Conversation | null,
      pendingInteraction: index.state.pendingInteraction ?? null,
      composerDrafts: index.state.composerDrafts ?? {},
    },
  }
}

// ---------------------------------------------------------------------------
// One storage area per persist `name`
// ---------------------------------------------------------------------------

/** What storage holds for one conversation's messages, as of the last write or read. */
type StoredMessages = {
  /** The messages array last written or read; a write compares against it. */
  messages: readonly ChatMessage[]
  /** Characters the key and value take; 0 when the key is not in storage. */
  chars: number
  updatedAt: number
}

class ChatStorageArea {
  private readonly stored = new Map<string, StoredMessages>()
  private indexRaw: string | null = null
  private indexChars = 0
  /** What the last `setItem` was handed, written or held. */
  lastState: PersistedChatState | null = null
  lastVersion: number | undefined
  /** What storage holds, as of the last write that succeeded. */
  lastWritten: PersistedChatState | null = null

  constructor(readonly name: string) {}

  private totalChars(): number {
    let total = this.indexChars
    for (const entry of this.stored.values()) total += entry.chars
    return total
  }

  /** Forget everything: storage was cleared under us, or by `removeItem`. */
  reset(): void {
    this.stored.clear()
    this.indexRaw = null
    this.indexChars = 0
    this.lastState = null
    this.lastVersion = undefined
    this.lastWritten = null
  }

  /** Record what a read found, so the next write skips what is already there. */
  noteRead(conversations: readonly Conversation[], rawChars: ReadonlyMap<string, number>): void {
    this.stored.clear()
    for (const conversation of conversations) {
      this.stored.set(conversation.id, {
        messages: conversation.messages,
        chars: rawChars.get(conversation.id) ?? 0,
        updatedAt: updatedAtMs(conversation),
      })
    }
  }

  noteIndexRead(raw: string): void {
    this.indexRaw = raw
    this.indexChars = chatIndexKey(this.name).length + raw.length
  }

  /**
   * Evict the messages of the least recently updated conversation that may
   * make room for `forId`: never the open one or one with a live run, and for
   * anything but the open conversation only one updated before it, so an old
   * conversation cannot push out a newer one. False when there is none.
   */
  private evictOne(forId: string, protectedIds: ReadonlySet<string>, openId: string | null): boolean {
    const forUpdatedAt = this.stored.get(forId)?.updatedAt ?? Number.POSITIVE_INFINITY
    let oldest: [string, StoredMessages] | null = null
    for (const candidate of this.stored) {
      const [id, entry] = candidate
      if (entry.chars === 0 || id === forId || protectedIds.has(id)) continue
      if (forId !== openId && entry.updatedAt >= forUpdatedAt) continue
      if (!oldest || entry.updatedAt < oldest[1].updatedAt) oldest = candidate
    }
    if (!oldest) return false
    const [id, entry] = oldest
    localStorage.removeItem(chatMessagesKey(this.name, id))
    logStorageEviction(id, entry.chars)
    // The page keeps them in memory; a reload reads the server's copy.
    this.stored.set(id, { ...entry, chars: 0 })
    return true
  }

  /**
   * Store one string, evicting old conversations' messages while it does not
   * fit the budget or the quota. False when it could not be stored.
   */
  private put(
    key: string,
    value: string,
    forId: string,
    previousChars: number,
    protectedIds: ReadonlySet<string>,
    openId: string | null
  ): boolean {
    const chars = key.length + value.length
    while (this.totalChars() - previousChars + chars > CHAT_STORAGE_BUDGET_CHARS) {
      if (this.evictOne(forId, protectedIds, openId)) continue
      // Nothing older to make room with. The index and the open conversation
      // are written anyway, and only the quota can stop them; any other
      // conversation is the oldest one left, and is left to the server.
      if (forId === '' || forId === openId) break
      logStorageEviction(forId, chars)
      return false
    }
    for (;;) {
      try {
        localStorage.setItem(key, value)
        return true
      } catch (error) {
        if (!isQuotaExceededError(error)) throw error
        if (!this.evictOne(forId, protectedIds, openId)) {
          logStorageFailure(key, chars, error)
          return false
        }
      }
    }
  }

  private writeIndex(state: PersistedChatState, protectedIds: ReadonlySet<string>): void {
    const index: StoredIndex = {
      version: this.lastVersion,
      state: {
        currentUserId: state.currentUserId ?? null,
        currentConversation: state.currentConversation?.id ?? null,
        pendingInteraction: state.pendingInteraction ?? null,
        composerDrafts: state.composerDrafts ?? {},
        conversations: (state.conversations ?? []).map(entryOf),
        awaitingServerMessages: (state.conversations ?? [])
          .filter((c) => isAwaitingServerMessages(c.id))
          .map((c) => c.id),
      },
    }
    const raw = JSON.stringify(index)
    if (raw === this.indexRaw) return
    const key = chatIndexKey(this.name)
    const openId = state.currentConversation?.id ?? null
    // The index is never evicted: it is the part that exists nowhere else.
    if (!this.put(key, raw, '', this.indexChars, protectedIds, openId)) return
    this.indexRaw = raw
    this.indexChars = key.length + raw.length
  }

  private writeMessages(
    conversation: Conversation,
    protectedIds: ReadonlySet<string>,
    openId: string | null
  ): void {
    const known = this.stored.get(conversation.id)
    const updatedAt = updatedAtMs(conversation)
    if (known?.messages === conversation.messages) {
      if (known.updatedAt !== updatedAt) this.stored.set(conversation.id, { ...known, updatedAt })
      return
    }
    // The live turn's growth is not written, whatever else changed with it.
    if (known && onlyTheLiveTurnGrewIn(known.messages, conversation.messages)) return
    // Not loaded is not empty: a stored `[]` would read back as a thread with
    // no messages, which the upload-only cleanup deletes on the server.
    if (conversation.messages.length === 0 && isAwaitingServerMessages(conversation.id)) return

    const key = chatMessagesKey(this.name, conversation.id)
    const previousChars = known?.chars ?? 0
    this.stored.set(conversation.id, { messages: conversation.messages, chars: previousChars, updatedAt })
    const raw = JSON.stringify(conversation.messages.map(pruneMessageForStorage))
    if (this.put(key, raw, conversation.id, previousChars, protectedIds, openId)) {
      this.stored.set(conversation.id, { messages: conversation.messages, chars: key.length + raw.length, updatedAt })
      logStorageWrite(conversation.id, raw.length)
      return
    }
    // It does not fit even alone. What storage holds for it is an older
    // version; drop that, and the server's copy is read when it is opened.
    localStorage.removeItem(key)
    this.stored.set(conversation.id, { messages: conversation.messages, chars: 0, updatedAt })
  }

  /**
   * Write what changed since the last write: the index and each changed
   * conversation's messages (`messages: false` writes the index alone).
   */
  write(state: PersistedChatState, { messages = true }: { messages?: boolean } = {}): void {
    const conversations = state.conversations ?? []
    const present = new Set(conversations.map((c) => c.id))
    // A deleted conversation leaves storage first, which also frees its room.
    for (const id of [...this.stored.keys()]) {
      if (present.has(id)) continue
      localStorage.removeItem(chatMessagesKey(this.name, id))
      this.stored.delete(id)
    }

    const openId = state.currentConversation?.id ?? null
    const protectedIds = new Set(conversations.filter((c) => hasLiveRun(c.messages)).map((c) => c.id))
    if (openId) protectedIds.add(openId)

    // The index first: it is small, and it is what exists nowhere else.
    this.writeIndex(state, protectedIds)
    if (!messages) return
    // Newest first, so what does not fit is the oldest.
    const byRecency = [...conversations].sort((a, b) => updatedAtMs(b) - updatedAtMs(a))
    for (const conversation of byRecency) this.writeMessages(conversation, protectedIds, openId)
    this.lastWritten = state
  }

  /**
   * Is nothing but the open conversation's live turn, and the composer
   * drafts, new since the last write? The live turn's growth is skipped and a
   * draft is written a moment later. A deletion, a rename or a new session is
   * written at once, so a browser that dies mid-answer cannot bring a deleted
   * conversation back.
   */
  onlyTheOpenTurnOrDraftsChanged(next: PersistedChatState): boolean {
    const written: Record<string, unknown> | null = this.lastWritten
    if (written === null) return false
    const nextFields: Record<string, unknown> = next
    const keys = new Set([...Object.keys(written), ...Object.keys(nextFields)])
    for (const key of keys) {
      if (key === 'conversations' || key === 'currentConversation' || key === 'composerDrafts') continue
      if (nextFields[key] !== written[key]) return false
    }
    const before = this.lastWritten?.conversations ?? []
    const after = next.conversations ?? []
    const beforeOpen = this.lastWritten?.currentConversation ?? null
    const afterOpen = next.currentConversation ?? null
    if (after === before && afterOpen === beforeOpen) return true
    const openId = afterOpen?.id
    if (!openId || beforeOpen?.id !== openId) return false
    return (
      before.length === after.length &&
      after.every((c, i) => c === before[i] || (c.id === openId && onlyTheLiveTurnGrew(before[i], c))) &&
      onlyTheLiveTurnGrew(beforeOpen, afterOpen)
    )
  }

  /**
   * `persist` calls setItem on EVERY store update — a loading flag, a status
   * line, a thinking step. The store updates immutably, so a persisted field
   * that is the same reference is the same content: a call whose fields all
   * are is skipped before any work. Every key either state carries is
   * compared, so a field `partialize` gains later is written rather than
   * silently never.
   */
  unchangedSinceLastCall(value: PersistedChatStorageValue): boolean {
    const previous: Record<string, unknown> | null = this.lastState
    if (previous === null || value.version !== this.lastVersion) return false
    const next: Record<string, unknown> = value.state
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
    for (const key of keys) if (next[key] !== previous[key]) return false
    return true
  }
}

// ---------------------------------------------------------------------------
// Reading, and the one-time move from the single key
// ---------------------------------------------------------------------------

/** Remove message keys no index entry names: left by a tab that died between writes. */
const removeOrphanedMessageKeys = (name: string, ids: ReadonlySet<string>): void => {
  const prefix = messagesKeyPrefix(name)
  const orphans: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(prefix) && !ids.has(key.slice(prefix.length))) orphans.push(key)
  }
  for (const key of orphans) localStorage.removeItem(key)
}

/**
 * The single key the whole history used to live in, if it is still there.
 * Its presence means a write the new shape has not taken in: the first load
 * after the change, or a tab still running the old code.
 */
const readLegacy = (name: string): PersistedChatStorageValue | null => {
  const raw = localStorage.getItem(name)
  if (raw === null) return null
  const parsed = asStoredIndex(parseJson(raw))
  if (!parsed) {
    // Nothing in it can be read, so nothing in it can be saved.
    localStorage.removeItem(name)
    return null
  }
  return parsed as unknown as PersistedChatStorageValue
}

/**
 * Move the single key into the new shape. The index goes first, while the old
 * key still stands: it is small, and it holds what exists nowhere else (the
 * drafts, the list, the titles). Should even that not fit beside the old key,
 * the old key goes first; its content is in memory and written in the same
 * task. Then the old key goes, and each conversation's messages follow,
 * newest first, so what the quota cannot take is the oldest, which the server
 * holds.
 */
const migrate = (area: ChatStorageArea, legacy: PersistedChatStorageValue): void => {
  const conversations = legacy.state.conversations ?? []
  const openId = legacy.state.currentConversation as unknown as string | null
  const state: PersistedChatState = {
    ...legacy.state,
    currentConversation: conversations.find((c) => c.id === openId) ?? null,
  }
  area.reset()
  area.lastVersion = legacy.version
  const indexKey = chatIndexKey(area.name)
  area.write(state, { messages: false })
  if (localStorage.getItem(indexKey) === null) {
    localStorage.removeItem(area.name)
    area.write(state, { messages: false })
  }
  // Not even the index fits: keep the old key rather than lose it.
  if (localStorage.getItem(indexKey) === null) return
  localStorage.removeItem(area.name)
  area.write(state)
  logStorageMigration(conversations.length)
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The persisted chat store's localStorage adapter (see the file comment).
 * `undefined` where there is no localStorage.
 */
export const createResilientStorage = (): PersistStorage<PersistedChatState> | undefined => {
  try {
    if (typeof localStorage === 'undefined') throw new Error('no localStorage')
    localStorage.getItem('')
  } catch {
    logStorageAvailability(false)
    return undefined
  }

  const areas = new Map<string, ChatStorageArea>()
  const areaFor = (name: string): ChatStorageArea => {
    let area = areas.get(name)
    if (!area) {
      area = new ChatStorageArea(name)
      areas.set(name, area)
    }
    return area
  }

  // A draft is written this long after the last keystroke, and when the page
  // is hidden. Written with every key it serialised the whole history inside
  // the input event: 264 ms a keystroke on a 4× throttled phone with 20
  // conversations stored (React performance audit, 2026-09).
  let heldDraft: { name: string; state: PersistedChatState } | null = null
  let heldDraftTimer: ReturnType<typeof setTimeout> | undefined
  const writeHeldDraft = (): void => {
    clearTimeout(heldDraftTimer)
    const held = heldDraft
    heldDraft = null
    if (held) areaFor(held.name).write(held.state)
  }
  const holdDraft = (name: string, state: PersistedChatState): void => {
    heldDraft = { name, state }
    clearTimeout(heldDraftTimer)
    heldDraftTimer = setTimeout(writeHeldDraft, DRAFT_WRITE_DELAY_MS)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', writeHeldDraft)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') writeHeldDraft()
    })
  }

  const read = (name: string): PersistedChatStorageValue | null => {
    const area = areaFor(name)
    const legacy = readLegacy(name)
    if (legacy) {
      const conversations = (legacy.state.conversations ?? []).map((c) => ({
        ...c,
        messages: restorableMessages(c.messages ?? []),
      }))
      migrate(area, { ...legacy, state: { ...legacy.state, conversations } })
      return { ...legacy, state: { ...legacy.state, conversations } }
    }

    const indexRaw = localStorage.getItem(chatIndexKey(name))
    const index = asStoredIndex(parseJson(indexRaw))
    if (!index || indexRaw === null) return null
    const rawChars = new Map<string, number>()
    const awaiting = new Set(index.state.awaitingServerMessages ?? [])
    const conversations = index.state.conversations.map((entry): Conversation => {
      const key = chatMessagesKey(name, entry.id)
      const raw = localStorage.getItem(key)
      const parsed = parseJson(raw)
      // An empty list is read as "not here" as well: a conversation that
      // really has none is confirmed empty by the server when it is opened
      // (`hydrateConversationMessages`), and only then may anything act on it.
      if (awaiting.has(entry.id) || !Array.isArray(parsed) || parsed.length === 0) {
        markAwaitingServerMessages(entry.id)
      }
      if (raw === null || !Array.isArray(parsed)) return { ...entry, messages: [] }
      rawChars.set(entry.id, key.length + raw.length)
      return { ...entry, messages: restorableMessages(parsed as ChatMessage[]) }
    })
    removeOrphanedMessageKeys(name, new Set(conversations.map((c) => c.id)))
    area.reset()
    area.noteIndexRead(indexRaw)
    area.noteRead(conversations, rawChars)
    area.lastVersion = index.version
    return {
      version: index.version,
      state: {
        currentUserId: index.state.currentUserId ?? null,
        conversations,
        currentConversation: index.state.currentConversation as unknown as Conversation | null,
        pendingInteraction: index.state.pendingInteraction ?? null,
        composerDrafts: index.state.composerDrafts ?? {},
      },
    }
  }

  return {
    getItem: async (name: string): Promise<PersistedChatStorageValue | null> => {
      const value = read(name)
      if (!value) return null
      const storedId = value.state.currentConversation as unknown as string | null
      const conversations = value.state.conversations ?? []
      return {
        ...value,
        state: {
          ...value.state,
          currentConversation: storedId ? (conversations.find((c) => c.id === storedId) ?? null) : null,
        },
      }
    },
    removeItem: (name: string) => {
      if (heldDraft?.name === name) {
        heldDraft = null
        clearTimeout(heldDraftTimer)
      }
      areaFor(name).reset()
      localStorage.removeItem(name)
      localStorage.removeItem(chatIndexKey(name))
      removeOrphanedMessageKeys(name, new Set())
    },
    setItem: (name: string, value: PersistedChatStorageValue) => {
      const area = areaFor(name)
      if (area.unchangedSinceLastCall(value)) return
      area.lastState = value.state
      area.lastVersion = value.version
      // A streaming answer's growth is never written, nor the reasoning steps
      // of the question it answers. Writing it cost a prune, a serialize and a
      // write of the WHOLE history every couple of seconds while the answer
      // streamed. The answer is written once, when it settles.
      if (area.onlyTheOpenTurnOrDraftsChanged(value.state)) {
        if (value.state.composerDrafts !== area.lastWritten?.composerDrafts) holdDraft(name, value.state)
        return
      }
      // Anything else is written at once, and carries the drafts with it.
      if (heldDraft?.name === name) {
        heldDraft = null
        clearTimeout(heldDraftTimer)
      }
      area.write(value.state)
    },
  }
}
