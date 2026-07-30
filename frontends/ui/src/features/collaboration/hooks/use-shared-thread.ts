'use client'

/**
 * The ADR-0033 seam: "load from server, subscribe, reconcile" for ONE
 * conversation.
 *
 * Chat is local-first. The chat store persists conversations to browser storage
 * and `hydrateConversationMessages` bails when a conversation already has
 * messages, so the local copy always wins — which is correct for one author and
 * incorrect by construction for two, because a browser cannot know what a
 * colleague just wrote. ADR-0033 inverts the source of truth for **shared**
 * conversations only, and this hook is the single place that inversion happens.
 * Everything below it keeps rendering from the store exactly as before.
 *
 * Four properties are the whole contract:
 *
 *  1. **A private thread is untouched.** With the collaboration flag off, or once
 *     the server says the conversation is not shared, this hook opens no
 *     subscription, issues no message request, runs no poll and never writes to
 *     the store (spec NF-8). The only request it can make in that case is the
 *     single cheap access read that decides which path applies — sharedness is a
 *     server-computed fact and there is no other way to learn it (ADR-0033 §1).
 *
 *     The deliberate cost of that strictness: a thread that becomes shared *while
 *     the reader has it open* switches paths on the next open (or conversation
 *     switch), not instantly, because nothing is listening on the private path. The
 *     sharing surfaces that DO hold a subscription — the participant strip and the
 *     share dialog — are what make the change visible in the meantime, and the
 *     inverse case (losing access) is a server-side authorization decision, so it
 *     cannot be missed by a client that is not listening.
 *  2. **The server is authoritative** for a shared thread's message list: the
 *     history load replaces the store's copy for that conversation.
 *  3. **Deduplicated by message id.** Your own write comes back over the push
 *     channel; without dedup it would render twice next to its optimistic echo.
 *     The store's `insertRemoteMessages` owns that, and this hook additionally
 *     drops the *event* for its own write rather than refetching for it.
 *  4. **Correctness never depends on an event arriving** (spec CC-10, RT-4). Every
 *     state reachable here is reachable by a plain fetch on open, on window focus,
 *     or on the disconnected poll — `useLiveEvents` supplies all three triggers.
 *     A dropped event is therefore a latency problem, not a correctness one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CollaborationEvent } from '@/lib/events/types'
import type { DirectoryPerson, ResourceRole, ResourceSharingState } from '@/lib/sharing/types'
import { useChatStore } from '@/features/chat/store'
import type { ChatMessage } from '@/features/chat/types'
import type { MessagesSlice } from '@/features/chat/stores/messages-store'
import { mapServerMessagesToChatMessages } from '@/features/chat/lib/server-message-mapper'
import type { ConversationEngagement, Message } from '@/lib/db/schema'
import { publishThreadSharing, publishTurnActor } from '@/shared/collaboration/thread-sharing'
import { useLiveEvents } from './use-live-events'

/**
 * How long a "turn started" banner may survive without its `ended` event before
 * we stop believing it. The banner is the one piece of state here with no fetch
 * behind it (there is no "is a turn running" endpoint), so it gets an expiry
 * instead — a dropped `ended` must not leave every observer staring at a spinner
 * for the rest of the session.
 */
const TURN_BANNER_MAX_AGE_MS = 5 * 60_000

/** Debounce on the read receipt, so a burst of arrivals is one POST, not ten. */
const MARK_READ_DEBOUNCE_MS = 1_200

/**
 * The access facts `GET /api/conversations/:id` adds to the conversation. Declared
 * locally rather than imported from the service so this client module does not
 * reach into a server-only one.
 */
interface ConversationAccessFacts {
  shared?: boolean
  myRole?: ResourceRole | null
  myReadState?: { lastReadMessageId: string | null } | null
  /** When the agent answers a message that tags nobody (ADR-0036). */
  engagementMode?: ConversationEngagement
  /** A mode worth offering, never one that has been applied. */
  engagementSuggestion?: ConversationEngagement | null
}

/** Who the agent is currently working for (spec CC-13). */
export interface SharedThreadTurn {
  actorUserId: string | null
}

/** A message that arrived from someone else, for the polite announcement (CC-9). */
export interface SharedThreadArrival {
  messageId: string
  authorUserId: string | null
  authorName: string | null
}

export interface UseSharedThreadOptions {
  conversationId: string | null
  /**
   * The collaboration feature flag. **Off is the default**: a caller that has not
   * been taught about sharing gets exactly today's behaviour, including no
   * request at all (spec NF-8).
   */
  enabled?: boolean
  /** The signed-in user, so their own echo is recognised and "You" can render. */
  currentUserId?: string | null
  /**
   * Whether the thread is actually on screen. Gates the read receipt only — the
   * history load and the subscription do not depend on it, because a thread that
   * is mounted but scrolled away must still converge.
   */
  active?: boolean
}

export interface UseSharedThreadResult {
  /** Server-computed: is this conversation shared at all (ADR-0033 §1)? */
  shared: boolean
  /** The caller's role, so a viewer's UI can hide what they may not do. */
  myRole: ResourceRole | null
  /** True while the first server load of a shared thread is in flight. */
  loading: boolean
  /** Live-channel health, so a degraded hint is possible. */
  connected: boolean
  /** Non-null while the agent is answering somebody's question. */
  turnInFlight: SharedThreadTurn | null
  /** Everyone with access, for author names/avatars and the participant strip. */
  participants: DirectoryPerson[]
  /** Resolve one author's directory entry (name + avatar) by user id. */
  authorOf: (userId: string | null | undefined) => DirectoryPerson | null
  /**
   * The reader's read high-water mark as it was when they OPENED the thread, which
   * is where the unread separator belongs (spec CC-19). Frozen on purpose: it must
   * not jump as the same reader is marked read a second later.
   */
  unreadAfterMessageId: string | null
  /** The most recent message from someone else, for an `aria-live` announcement. */
  lastArrival: SharedThreadArrival | null
  /**
   * The routing rule for a message that tags nobody (ADR-0036): `ask` means it
   * goes to Piloti, `mention` means it goes to the chat.
   *
   * Server-resolved, never derived here — the composer's statement of who receives
   * the next message and the routing that delivers it must come from one answer.
   */
  engagement: ConversationEngagement
  /**
   * A mode worth offering the reader, or null. `ask` stays the default however
   * many people are in the thread — this is a suggestion, not a change.
   */
  engagementSuggestion: ConversationEngagement | null
  /** Change the rule. Resolves false when the server refused. */
  setEngagement: (mode: ConversationEngagement) => Promise<boolean>
  /** Force a re-read. Same path the focus/poll fallbacks use. */
  refresh: () => void
}

const INERT: Omit<UseSharedThreadResult, 'refresh' | 'authorOf' | 'setEngagement'> = {
  shared: false,
  myRole: null,
  loading: false,
  connected: false,
  turnInFlight: null,
  participants: [],
  unreadAfterMessageId: null,
  lastArrival: null,
  // A gated or private thread answers everything, which is what it has always
  // done — the mode can only ever narrow a SHARED thread.
  engagement: 'ask',
  engagementSuggestion: null,
}

/**
 * Resolve author display data onto messages from the conversation's roster.
 *
 * The message row carries only `authorUserId` (the name is not denormalised onto
 * it, so a rename is not stale in old messages). Only messages that gain
 * something are rebuilt, so unchanged messages keep object identity and the
 * message list does not re-render them.
 */
function withAuthorIdentity(
  messages: ChatMessage[],
  directory: Map<string, DirectoryPerson>
): ChatMessage[] {
  if (directory.size === 0) return messages
  return messages.map((message) => {
    if (!message.authorUserId) return message
    const person = directory.get(message.authorUserId)
    if (!person) return message
    if (
      message.authorName === person.name &&
      message.authorAvatarUrl === person.profilePictureUrl
    ) {
      return message
    }
    return { ...message, authorName: person.name, authorAvatarUrl: person.profilePictureUrl }
  })
}

export function useSharedThread(options: UseSharedThreadOptions): UseSharedThreadResult {
  const { conversationId, enabled = false, currentUserId = null, active = true } = options

  const [shared, setShared] = useState(false)
  const [myRole, setMyRole] = useState<ResourceRole | null>(null)
  // `ask` until the server says otherwise: it is the behaviour every thread had
  // before this existed, so a load that has not landed yet cannot change routing.
  const [engagement, setEngagementState] = useState<ConversationEngagement>('ask')
  const [engagementSuggestion, setEngagementSuggestion] = useState<ConversationEngagement | null>(
    null
  )
  const [loading, setLoading] = useState(false)
  const [participants, setParticipants] = useState<DirectoryPerson[]>([])
  const [turnInFlight, setTurnInFlight] = useState<SharedThreadTurn | null>(null)
  const [unreadAfterMessageId, setUnreadAfterMessageId] = useState<string | null>(null)
  const [lastArrival, setLastArrival] = useState<SharedThreadArrival | null>(null)
  /**
   * Newest message id the SERVER has told us about. State rather than a ref
   * because the read receipt is an effect keyed on it — a ref would move without
   * waking the effect that has to report it.
   */
  const [newestMessageId, setNewestMessageId] = useState<string | null>(null)

  // `shared` is read inside callbacks that must not be re-created when it flips
  // (re-creating them would re-run the load effect), so it is mirrored in a ref.
  const sharedRef = useRef(false)
  const currentUserIdRef = useRef(currentUserId)
  currentUserIdRef.current = currentUserId
  // Directory of participants, for resolving author names during a load that may
  // race the roster fetch.
  const directoryRef = useRef<Map<string, DirectoryPerson>>(new Map())
  // Guards an out-of-order response from overwriting a newer one (conversation
  // switch, or two refreshes in flight).
  const seq = useRef(0)
  // The unread anchor is captured once per conversation and then left alone.
  const unreadAnchoredRef = useRef<string | null>(null)
  // Read receipt bookkeeping: the id we last reported, and the pending debounce
  // timer.
  const reportedReadIdRef = useRef<string | null>(null)
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turnStartedAtRef = useRef<number>(0)

  const base = conversationId ? `/api/conversations/${encodeURIComponent(conversationId)}` : null

  /**
   * Write the server's history into the store. `replace` on the first load of a
   * thread (the server is authoritative), a plain merge afterwards — either way
   * the store dedupes by id, so an echo of our own write cannot double-render.
   */
  const applyMessages = useCallback(
    (targetConversationId: string, rows: Message[], replace: boolean) => {
      const mapped = withAuthorIdentity(mapServerMessagesToChatMessages(rows), directoryRef.current)

      // `insertRemoteMessages` is declared on the messages slice; `ChatActions`
      // (features/chat/types.ts) is shared surface this task may not extend, so
      // the one cast lives here rather than at every call site.
      const store = useChatStore.getState() as unknown as MessagesSlice
      store.insertRemoteMessages(targetConversationId, mapped, { replace })

      const newest = mapped[mapped.length - 1] ?? null
      setNewestMessageId(newest?.id ?? null)

      // Announce the newest message written by somebody ELSE. Two exclusions, both
      // about not talking over the reader: our own messages are already on screen
      // as an optimistic echo, and the initial load is history — announcing it
      // would read out a colleague's name every time a thread is opened, when the
      // announcement's whole job is to report what arrived WHILE reading.
      const me = currentUserIdRef.current
      const foreign = replace
        ? undefined
        : [...mapped]
            .reverse()
            .find((message) => message.authorUserId && message.authorUserId !== me)
      if (foreign) {
        setLastArrival((previous) =>
          previous?.messageId === foreign.id
            ? previous
            : {
                messageId: foreign.id,
                authorUserId: foreign.authorUserId ?? null,
                authorName: foreign.authorName ?? null,
              }
        )
      }

      // An agent answer landing IS the end of the turn, whether or not the
      // `ended` event reached us — this is what makes the observer's banner
      // correct on a fetch alone (spec CC-10).
      if (newest?.role === 'assistant') setTurnInFlight(null)
    },
    []
  )

  /** The roster, which is where author names and avatars come from. */
  const loadRoster = useCallback(async (targetConversationId: string, current: number) => {
    try {
      const response = await fetch(
        `/api/sharing/conversation/${encodeURIComponent(targetConversationId)}`
      )
      if (!response.ok) return
      const state = (await response.json()) as ResourceSharingState
      if (current !== seq.current) return
      const people = (state.entries ?? []).map((entry) => entry.person)
      directoryRef.current = new Map(people.map((person) => [person.userId, person]))
      setParticipants(people)
    } catch {
      // Names are a nicety; a thread with unresolved names still renders (the
      // avatar falls back to the id's colour and the bubble to "?").
    }
  }, [])

  /** Read the message history. Only ever called for a shared conversation. */
  const loadMessages = useCallback(
    async (targetConversationId: string, current: number, replace: boolean) => {
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(targetConversationId)}/messages`
        )
        if (!response.ok) return
        const rows = (await response.json()) as Message[]
        if (current !== seq.current) return
        if (!Array.isArray(rows)) return
        applyMessages(targetConversationId, rows, replace)
      } catch {
        // Keep what is on screen. The focus/poll fallbacks will try again, which
        // is precisely why a failed read is allowed to be silent here.
      }
    },
    [applyMessages]
  )

  /**
   * The whole read path: learn whether the conversation is shared, and if it is,
   * load its history and roster. `replace` is true only for the first load of a
   * conversation — later reads merge, so they cannot disturb an in-flight turn.
   */
  const load = useCallback(
    async (replace: boolean) => {
      if (!enabled || !conversationId) {
        sharedRef.current = false
        setShared(false)
        setMyRole(null)
        setLoading(false)
        return
      }

      const current = ++seq.current
      if (replace) setLoading(true)
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`)
        if (!response.ok) {
          // A 403 from the feature gate or a 404 (no access) both mean "no shared
          // behaviour here" — fall back to the local-first path rather than
          // retrying, and never surface an error over a working thread.
          if (current === seq.current) {
            sharedRef.current = false
            setShared(false)
            setLoading(false)
            // Same fallback for the composer's socket: a thread with no shared
            // behaviour behaves like a private one, connect-on-mount included.
            publishThreadSharing(conversationId, false)
          }
          return
        }
        const facts = (await response.json()) as ConversationAccessFacts
        if (current !== seq.current) return

        const isShared = facts.shared === true
        sharedRef.current = isShared
        setShared(isShared)
        setMyRole(facts.myRole ?? null)
        setEngagementState(facts.engagementMode ?? 'ask')
        setEngagementSuggestion(facts.engagementSuggestion ?? null)
        // Hand the answer to the agent-socket gate (`useWebSocketChat`). This read
        // is the ONLY place sharedness is learned, and the composer lives in a
        // sibling component — publishing it here is what keeps the composer from
        // paying for the same request twice.
        publishThreadSharing(conversationId, isShared)

        // Freeze the unread separator at the mark the reader arrived with (CC-19).
        if (isShared && unreadAnchoredRef.current === null) {
          const anchor = facts.myReadState?.lastReadMessageId ?? null
          unreadAnchoredRef.current = anchor ?? ''
          setUnreadAfterMessageId(anchor)
        }

        // NOT shared: stop here. No message request, no roster request, no store
        // write, no subscription — the local-first path owns this thread.
        if (!isShared) {
          setLoading(false)
          return
        }

        await Promise.all([
          loadRoster(conversationId, current),
          loadMessages(conversationId, current, replace),
        ])
        // The roster may have landed after the messages were mapped; re-apply the
        // now-resolved names over the store copy (a no-op when nothing changed).
        if (current === seq.current) {
          const conversation = useChatStore
            .getState()
            .conversations.find((candidate) => candidate.id === conversationId)
          if (conversation) {
            const store = useChatStore.getState() as unknown as MessagesSlice
            store.insertRemoteMessages(
              conversationId,
              withAuthorIdentity(conversation.messages, directoryRef.current)
            )
          }
        }
      } catch {
        if (current === seq.current) {
          sharedRef.current = false
          setShared(false)
          // Deliberately NOT published: a network failure is not evidence that the
          // thread is private, and telling the socket gate "private" on a guess is
          // how the two-participant collision comes back. Left `unknown`, so the
          // composer opens its socket on intent instead of on mount.
        }
      } finally {
        if (current === seq.current) setLoading(false)
      }
    },
    [conversationId, enabled, loadMessages, loadRoster]
  )

  // Open / switch conversation: reset every per-conversation fact, then load.
  // Every setter here is written so that resetting an ALREADY-empty hook is a
  // no-op — `setParticipants([])` with a fresh array would otherwise re-render
  // every mount, including the disabled one that is supposed to cost nothing.
  useEffect(() => {
    unreadAnchoredRef.current = null
    reportedReadIdRef.current = null
    setNewestMessageId(null)
    setUnreadAfterMessageId(null)
    setLastArrival(null)
    setTurnInFlight(null)
    setParticipants((previous) => (previous.length === 0 ? previous : []))
    directoryRef.current = new Map()
    void load(true)
  }, [load])

  const onEvent = useCallback(
    (event: CollaborationEvent) => {
      if (!conversationId) return

      if (event.kind === 'conversation.message') {
        if (event.conversationId !== conversationId) return
        // Our own write, already on screen as an optimistic echo. Re-reading for
        // it would be pure cost — and the next focus/poll refresh picks up the
        // server's version of it anyway.
        if (event.authorUserId && event.authorUserId === currentUserIdRef.current) return
        void loadMessages(conversationId, seq.current, false)
        return
      }

      if (event.kind === 'conversation.turn') {
        if (event.conversationId !== conversationId) return
        if (event.phase === 'started') {
          turnStartedAtRef.current = Date.now()
          setTurnInFlight({ actorUserId: event.actorUserId })
        } else {
          setTurnInFlight(null)
          // The answer is persisted by the time the turn ends, so go and read it.
          void loadMessages(conversationId, seq.current, false)
        }
        return
      }

      if (event.kind === 'resource.access.changed') {
        // Sharing this thread (or losing it) changes which PATH applies, so the
        // access fact has to be re-read, not just the messages.
        if (event.resourceType === 'conversation' && event.resourceId === conversationId) {
          void load(false)
        }
      }
    },
    [conversationId, load, loadMessages]
  )

  const refresh = useCallback(() => {
    // Expire a turn banner whose `ended` never arrived, so the fallback path
    // heals it exactly like every other piece of state here.
    if (
      turnStartedAtRef.current > 0 &&
      Date.now() - turnStartedAtRef.current > TURN_BANNER_MAX_AGE_MS
    ) {
      setTurnInFlight(null)
    }
    if (!sharedRef.current) {
      // Not shared (or not yet known): re-read the access fact only. This is what
      // makes "a colleague shared it with me while I had it open" converge without
      // an event, and it is the ONLY request a private thread can cause.
      void load(false)
      return
    }
    if (conversationId) void loadMessages(conversationId, seq.current, false)
  }, [conversationId, load, loadMessages])

  const { connected } = useLiveEvents({
    // No subscription at all until the server has confirmed the thread is shared:
    // a private thread must open no live channel (spec NF-8).
    enabled: enabled && shared && Boolean(conversationId),
    onEvent,
    onRefresh: refresh,
  })

  // ── Read receipt (spec CC-18) ───────────────────────────────────────────────
  // Debounced and keyed on the newest message id, so a burst of arrivals is ONE
  // POST rather than one per message. Only while the thread is actually being
  // looked at: marking a backgrounded tab read would clear a colleague's inbox
  // item for a thread nobody read.
  useEffect(() => {
    if (!enabled || !shared || !base || !active) return
    const newest = newestMessageId
    if (!newest || newest === reportedReadIdRef.current) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

    markReadTimerRef.current = setTimeout(() => {
      reportedReadIdRef.current = newest
      void fetch(`${base}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastReadMessageId: newest }),
      }).catch(() => {
        // Reading is not a mutation the user is waiting on; the next arrival (or
        // the next open) reports the mark again.
        reportedReadIdRef.current = null
      })
    }, MARK_READ_DEBOUNCE_MS)

    return () => {
      if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current)
      markReadTimerRef.current = null
    }
  }, [enabled, shared, base, active, newestMessageId])

  const directory = useMemo(
    () => new Map(participants.map((person) => [person.userId, person])),
    [participants]
  )

  const authorOf = useCallback(
    (userId: string | null | undefined): DirectoryPerson | null =>
      userId ? (directory.get(userId) ?? null) : null,
    [directory]
  )

  /**
   * Change when the agent answers here (ADR-0036).
   *
   * Optimistic, then reconciled from the server's answer: the notice that carries
   * this control also states the current rule, and a control whose label lags a
   * round-trip behind reads as broken. A refusal restores the truth by returning
   * false, which the caller surfaces.
   */
  const setEngagement = useCallback(
    async (mode: ConversationEngagement): Promise<boolean> => {
      if (!base) return false
      const previous = engagement
      setEngagementState(mode)
      try {
        const response = await fetch(base, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engagement: mode }),
        })
        if (!response.ok) {
          setEngagementState(previous)
          return false
        }
        const facts = (await response.json()) as ConversationAccessFacts
        setEngagementState(facts.engagementMode ?? mode)
        // A mode that has been chosen is not nagged about the alternative.
        setEngagementSuggestion(facts.engagementSuggestion ?? null)
        return true
      } catch {
        setEngagementState(previous)
        return false
      }
    },
    [base, engagement]
  )

  /**
   * Tell the composer whose question Piloti is answering, when it is not the
   * reader's own (spec CC-13). The composer is locked by `isBusy` while any turn
   * runs, and in a shared thread that turn may belong to a colleague — an
   * unexplained dead input. The name lives here (the roster is here) and the
   * composer is a sibling component, so it travels the same channel sharedness does.
   */
  useEffect(() => {
    if (!conversationId) return
    const actorId = turnInFlight?.actorUserId ?? null
    const isSomeoneElse = actorId !== null && actorId !== currentUserId
    publishTurnActor(
      conversationId,
      isSomeoneElse ? (directory.get(actorId)?.name ?? null) : null,
    )
  }, [conversationId, turnInFlight, currentUserId, directory])

  const result = useMemo<UseSharedThreadResult>(
    () => ({
      shared,
      myRole,
      loading,
      connected,
      turnInFlight,
      participants,
      authorOf,
      unreadAfterMessageId,
      lastArrival,
      engagement,
      engagementSuggestion,
      setEngagement,
      refresh,
    }),
    [
      shared,
      myRole,
      loading,
      connected,
      turnInFlight,
      participants,
      authorOf,
      unreadAfterMessageId,
      lastArrival,
      engagement,
      engagementSuggestion,
      setEngagement,
      refresh,
    ]
  )

  // The disabled case is a distinct, deliberately inert object: no state a caller
  // could act on, so a gated org cannot render a collaboration affordance.
  return enabled && conversationId ? result : { ...INERT, authorOf, refresh, setEngagement }
}
