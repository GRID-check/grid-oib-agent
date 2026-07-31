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
import {
  publishThreadRole,
  publishThreadSharing,
  publishTurnActor,
  useThreadRevision,
} from '@/shared/collaboration/thread-sharing'
import { useLiveEvents } from './use-live-events'

/**
 * Backoff ladder for a failed ACCESS read, in ms.
 *
 * Short and bounded: this covers a blip, not an outage. See `scheduleAccessRetry`
 * for why this one read needs a recovery path that the others do not.
 */
const ACCESS_RETRY_DELAYS_MS = [1_000, 3_000, 8_000]

/**
 * How long a "turn started" banner may survive without its `ended` event before
 * we stop believing it. The banner is the one piece of state here with no fetch
 * behind it (there is no "is a turn running" endpoint), so it gets an expiry
 * instead — a dropped `ended` must not leave every observer staring at a spinner
 * for the rest of the session.
 *
 * It is a SLIDING deadline, not a fixed one. Five minutes of *silence* is the
 * bar — not five minutes of turn. A fixed five minutes erased a colleague's
 * answer mid-sentence on any longer turn (deep research routinely is); a fixed
 * thirty minutes would have made every path that produces no evidence of life —
 * a deployment with no shared cache tier, the reader's own turn, a spent
 * reconnect budget — wait six times longer behind a locked composer. So the
 * clock restarts on evidence the turn is alive (`noteTurnActivity`), and the
 * short bar applies to a turn that has genuinely gone quiet.
 */
const TURN_BANNER_MAX_AGE_MS = 5 * 60_000

/** How often the silence above is checked. Coarse, because the deadline is. */
const TURN_SILENCE_POLL_MS = 30_000

/** Debounce on the read receipt, so a burst of arrivals is one POST, not ten. */
const MARK_READ_DEBOUNCE_MS = 1_200
/** Retry spacing and budget for a failed read receipt, so a dropped POST does
    not silently move the reader's unread anchor to a stale mark. */
const MARK_READ_RETRY_MS = 8_000
const MARK_READ_MAX_ATTEMPTS = 3

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

/**
 * How often the typist list is swept for expired claims.
 *
 * Presence has no fetch behind it (see `@/lib/conversations/presence`), so a
 * `typing: false` that never arrives — the tab was closed mid-word, the channel
 * dropped — is healed by the claim aging out rather than by a re-read. The sweep
 * is cheap and only runs while somebody is actually typing.
 */
const TYPING_SWEEP_MS = 1_000

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
  /**
   * True once a thread that WAS shared stops being reachable for this reader
   * (access revoked while viewing). The fallback local-first copy then keeps
   * rendering, and this flag is what lets the UI say why it stopped updating
   * instead of silently freezing.
   */
  accessLost: boolean
  /** Non-null while the agent is answering somebody's question. */
  turnInFlight: SharedThreadTurn | null
  /**
   * Clear the turn banner because the turn demonstrably ended — the observer's
   * spectated stream saw its terminal frame. Without this the banner (and the
   * composer lock that hangs off it) waited out {@link TURN_BANNER_MAX_AGE_MS}
   * whenever no assistant message was persisted to publish the `ended` event.
   */
  clearTurnInFlight: () => void
  /**
   * Report that the turn is demonstrably still running, restarting the staleness
   * clock. Fed by the observer's spectated stream, which is the only thing that
   * can see a long turn making progress.
   */
  noteTurnActivity: () => void
  /**
   * Colleagues composing right now, resolved to directory entries so the caller
   * can name them. Never includes the reader (the publisher drops its own echo),
   * and empties itself when the claims expire — a chat where somebody is
   * permanently "typing…" is worse than one with no indicator at all.
   */
  typists: DirectoryPerson[]
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

const INERT: Omit<
  UseSharedThreadResult,
  'refresh' | 'authorOf' | 'setEngagement' | 'clearTurnInFlight' | 'noteTurnActivity'
> = {
  shared: false,
  myRole: null,
  loading: false,
  connected: false,
  accessLost: false,
  turnInFlight: null,
  typists: [],
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
  const [accessLost, setAccessLost] = useState(false)
  const [participants, setParticipants] = useState<DirectoryPerson[]>([])
  const [turnInFlight, setTurnInFlight] = useState<SharedThreadTurn | null>(null)
  /**
   * userId → the moment their typing claim stops being believable. A map rather
   * than a list because a refresh from the same person must move their expiry
   * instead of adding a second entry.
   */
  const [typingUntil, setTypingUntil] = useState<Record<string, number>>({})
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
  /*
    Retry bookkeeping for the access read.

    The access read is the hook's keystone: `shared` gates the live subscription,
    the focus/visibility listener and the fallback poll. So a failure there is the
    one failure that can also remove every route by which the hook would notice it
    had failed, and it needs a recovery path of its own rather than borrowing one.
    Short and bounded — this covers a blip, not an outage.
  */
  const accessAttempt = useRef(0)
  const accessRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadRef = useRef<(replace: boolean) => void>(() => {})

  const cancelAccessRetry = useCallback(() => {
    if (accessRetryTimer.current === null) return
    clearTimeout(accessRetryTimer.current)
    accessRetryTimer.current = null
  }, [])

  const scheduleAccessRetry = useCallback(() => {
    const delay = ACCESS_RETRY_DELAYS_MS[accessAttempt.current]
    if (delay === undefined) return
    accessAttempt.current += 1
    cancelAccessRetry()
    accessRetryTimer.current = setTimeout(() => {
      accessRetryTimer.current = null
      loadRef.current(false)
    }, delay)
  }, [cancelAccessRetry])
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
  /**
   * When the turn last showed a sign of life. A REF, not state, on purpose: this
   * is fed by every spectated frame, and bumping state per frame re-rendered the
   * hook's owner — the whole chat column — a second time per token.
   */
  const lastTurnActivityRef = useRef<number>(0)

  /**
   * Has the turn stopped showing any sign of life for longer than the deadline?
   *
   * The start of the turn counts as a sign, so a turn that has produced nothing
   * yet is measured from when it began. Both expiry paths — the interval and the
   * focus/poll `refresh` — ask this one question, or they disagree about what
   * "stale" means and the stricter one wins by accident.
   */
  const turnHasGoneQuiet = useCallback((): boolean => {
    const lastSign = Math.max(lastTurnActivityRef.current, turnStartedAtRef.current)
    return lastSign > 0 && Date.now() - lastSign > TURN_BANNER_MAX_AGE_MS
  }, [])


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
    async (
      targetConversationId: string,
      current: number,
      replace: boolean
    ): Promise<'ok' | 'denied' | 'failed'> => {
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(targetConversationId)}/messages`
        )
        if (!response.ok) {
          // A denial on a thread believed shared is the revocation signal when
          // no live event arrived — the caller re-reads the access fact.
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            return 'denied'
          }
          return 'failed'
        }
        const rows = (await response.json()) as Message[]
        if (current !== seq.current) return 'failed'
        if (!Array.isArray(rows)) return 'failed'
        applyMessages(targetConversationId, rows, replace)
        return 'ok'
      } catch {
        // Keep what is on screen. The focus/poll fallbacks will try again, which
        // is precisely why a failed read is allowed to be silent here.
        return 'failed'
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
    async (replace: boolean): Promise<'ok' | 'denied'> => {
      if (!enabled || !conversationId) {
        sharedRef.current = false
        setShared(false)
        setMyRole(null)
        setLoading(false)
        return 'ok'
      }

      const current = ++seq.current
      if (replace) setLoading(true)
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`)
        if (!response.ok) {
          // A 403 from the feature gate or a 404 (no access) both mean "no shared
          // behaviour here" — fall back to the local-first path rather than
          // retrying, and never surface an error over a working thread. One
          // exception: a thread that WAS shared for this reader and now denies
          // access has been revoked mid-view, and a silent fallback would leave
          // them reading a frozen thread with a live-looking composer. That case
          // is flagged so the UI can say what happened.
          if (current === seq.current) {
            const wasShared = sharedRef.current
            sharedRef.current = false
            setShared(false)
            setLoading(false)
            if (wasShared) setAccessLost(true)
            // Same fallback for the composer's socket: a thread with no shared
            // behaviour behaves like a private one, connect-on-mount included.
            publishThreadSharing(conversationId, false)
          }
          return 'ok'
        }
        const facts = (await response.json()) as ConversationAccessFacts
        if (current !== seq.current) return 'ok'

        // A successful access read heals any earlier revocation signal, and ends
        // any retry ladder a previous failure started.
        cancelAccessRetry()
        accessAttempt.current = 0
        setAccessLost(false)
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
          return 'ok'
        }

        const [, messages] = await Promise.all([
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
        // Report a denied history read to the caller: the access fact we just read
        // said "shared", so the denial means access went away BETWEEN the two
        // requests, and nothing above has flagged it yet.
        return messages === 'denied' ? 'denied' : 'ok'
      } catch {
        if (current === seq.current) {
          // A network failure is not evidence about this thread at all, and it
          // used to clear `shared` — which ALSO switched off the live
          // subscription, the focus listener and the fallback poll, every one of
          // which is gated on that flag. A single dropped request (a sleeping
          // laptop, one 502) therefore froze the thread permanently: stale
          // messages, no error, a live-looking composer, and no way back except
          // a remount. Keep the last known answer and retry on a short ladder.
          //
          // Nothing is published for the same reason as before: telling the
          // socket gate "private" on a guess is how the two-participant
          // collision comes back.
          scheduleAccessRetry()
        }
        return 'ok'
      } finally {
        if (current === seq.current) setLoading(false)
      }
    },
    [conversationId, enabled, loadMessages, loadRoster, scheduleAccessRetry, cancelAccessRetry]
  )

  /**
   * `load`, plus the bounded revalidation `refresh` already does by hand: a
   * denied history read on a thread the access read called shared is a
   * revocation that landed between the two requests, so re-read the access fact
   * ONCE — that second read is what clears `shared`/`myRole` and raises
   * `accessLost` instead of leaving a live-looking composer over a frozen
   * thread. Its own outcome is deliberately ignored, so this can never loop.
   */
  const loadAndRevalidate = useCallback(
    async (replace: boolean) => {
      if ((await load(replace)) === 'denied') await load(false)
    },
    [load]
  )

  // Lets a scheduled retry call the CURRENT load without making `load` depend on
  // itself.
  useEffect(() => {
    loadRef.current = (replace: boolean) => void loadAndRevalidate(replace)
  }, [loadAndRevalidate])

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
    setAccessLost(false)
    setTypingUntil((previous) => (Object.keys(previous).length === 0 ? previous : {}))
    setParticipants((previous) => (previous.length === 0 ? previous : []))
    directoryRef.current = new Map()
    accessAttempt.current = 0
    cancelAccessRetry()
    // Re-seed the revision watermark. It is per-hook-instance while `revision`
    // is per-conversation, so switching from a thread where a mention was sent
    // (revision 1) to a fresh one (revision 0) read as "declared stale" and
    // fired a second, racing load on every switch.
    lastRevisionRef.current = revisionRef.current
    void loadAndRevalidate(true)
    // Switching conversation (or unmounting) abandons a retry in flight —
    // otherwise a retry for the thread you just left writes over the one you
    // are in. The `seq` bump matters for UNMOUNT specifically: a load already
    // in flight lands after this cleanup and would otherwise schedule a fresh
    // timer that `cancelAccessRetry` has already run past, chaining fetches for
    // a conversation nobody is viewing. (A switch is safe without it, because
    // the effect body's own load bumps `seq` first.)
    return () => {
      seq.current += 1
      cancelAccessRetry()
    }
  }, [loadAndRevalidate, cancelAccessRetry])

  /*
    Re-read when somebody tells us the server's answer has moved.

    The case: the first `@` in a PRIVATE thread. That send makes the thread
    shared server-side, but this hook only reads sharedness on a conversation
    change — and every live subscription that would otherwise carry the news is
    gated on `shared`, which is exactly the flag that is now wrong. So the asker
    watched their mention land and then saw nothing: no waiting banner, no
    explanation for the agent's silence, no route back short of a reload.

    Not `replace`: the messages are already right, it is the access facts that
    are stale, and replacing would flash a skeleton over a thread the reader is
    looking at. Skipped on the initial value so this never doubles the mount read.
  */
  const revision = useThreadRevision(conversationId)
  const lastRevisionRef = useRef(revision)
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  useEffect(() => {
    if (revision === lastRevisionRef.current) return
    lastRevisionRef.current = revision
    void loadAndRevalidate(false)
  }, [revision, loadAndRevalidate])

  const onEvent = useCallback(
    (event: CollaborationEvent) => {
      if (!conversationId) return

      if (event.kind === 'conversation.message') {
        if (event.conversationId !== conversationId) return
        // Refetch even when the author is us: on THIS device our write is an
        // optimistic echo the store dedupes by id, but the same event also fires
        // for a message we sent from a second device, which has no echo here.
        // The id-keyed merge makes the refetch free in the first case and
        // correct in the second.
        void loadMessages(conversationId, seq.current, false)
        return
      }

      if (event.kind === 'conversation.turn') {
        if (event.conversationId !== conversationId) return
        if (event.phase === 'started') {
          turnStartedAtRef.current = Date.now()
          // A previous turn's activity must not count as this one's.
          lastTurnActivityRef.current = 0
          setTurnInFlight({ actorUserId: event.actorUserId })
        } else {
          setTurnInFlight(null)
          // The answer is persisted by the time the turn ends, so go and read it.
          void loadMessages(conversationId, seq.current, false)
        }
        return
      }

      if (event.kind === 'conversation.typing') {
        if (event.conversationId !== conversationId) return
        // Defence in depth: the publisher already excludes the reader, but an
        // indicator that says YOU are typing is the one failure nobody would
        // report as a bug and everybody would notice.
        if (event.userId === currentUserIdRef.current) return
        setTypingUntil((previous) => {
          if (!event.typing) {
            if (previous[event.userId] === undefined) return previous
            const next = { ...previous }
            delete next[event.userId]
            return next
          }
          return { ...previous, [event.userId]: Date.now() + event.ttlMs }
        })
        return
      }

      if (event.kind === 'resource.access.changed') {
        // Sharing this thread (or losing it) changes which PATH applies, so the
        // access fact has to be re-read, not just the messages.
        if (event.resourceType === 'conversation' && event.resourceId === conversationId) {
          void loadAndRevalidate(false)
        }
      }
    },
    [conversationId, loadAndRevalidate, loadMessages]
  )

  const refresh = useCallback(() => {
    // Expire a turn banner whose `ended` never arrived, so the fallback path
    // heals it exactly like every other piece of state here — using the SAME
    // silence rule as the interval below. Measuring from the turn's start
    // instead would have this door clear a turn that is actively streaming, at
    // exactly the five-minute mark the sliding deadline exists to survive.
    if (turnHasGoneQuiet()) setTurnInFlight(null)
    if (!sharedRef.current) {
      // Not shared (or not yet known): re-read the access fact only. This is what
      // makes "a colleague shared it with me while I had it open" converge without
      // an event, and it is the ONLY request a private thread can cause.
      void loadAndRevalidate(false)
      return
    }
    if (conversationId) {
      void loadMessages(conversationId, seq.current, false).then((outcome) => {
        // Access revoked without a live event (SSE down, tab focused): the
        // messages read is the first thing that notices, so it escalates to the
        // access re-read, which is what flags `accessLost`.
        if (outcome === 'denied') void load(false)
      })
    }
  }, [conversationId, load, loadAndRevalidate, loadMessages, turnHasGoneQuiet])

  const { connected } = useLiveEvents({
    // No subscription at all until the server has confirmed the thread is shared:
    // a private thread must open no live channel (spec NF-8).
    enabled: enabled && shared && Boolean(conversationId),
    onEvent,
    onRefresh: refresh,
  })

  // Turn-banner expiry as a TIMER, not only inside `refresh`: the disconnected
  // poll that drives `refresh` does not run while the live channel is healthy,
  // so a dropped `ended` event on a good connection would otherwise leave the
  // banner up for the rest of the session.
  // A polled check against the last sign of life, rather than a timer restarted
  // per frame: that is what makes this a SILENCE timeout instead of a
  // turn-length one, and it costs one cheap interval instead of a re-render per
  // token. The poll is coarse because the deadline is coarse.
  useEffect(() => {
    if (!turnInFlight) return
    const id = setInterval(() => {
      if (turnHasGoneQuiet()) setTurnInFlight(null)
    }, TURN_SILENCE_POLL_MS)
    return () => clearInterval(id)
  }, [turnInFlight, turnHasGoneQuiet])

  // Expire typing claims. Runs only while somebody is claimed to be typing, so a
  // quiet thread costs nothing, and it is the ONLY thing that clears the list
  // when a `typing: false` never arrives.
  useEffect(() => {
    if (Object.keys(typingUntil).length === 0) return
    const timer = setInterval(() => {
      const now = Date.now()
      setTypingUntil((previous) => {
        const live = Object.entries(previous).filter(([, until]) => until > now)
        if (live.length === Object.keys(previous).length) return previous
        return Object.fromEntries(live)
      })
    }, TYPING_SWEEP_MS)
    return () => clearInterval(timer)
  }, [typingUntil])

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

    let attempts = 0
    const report = () => {
      reportedReadIdRef.current = newest
      void fetch(`${base}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastReadMessageId: newest }),
      })
        .then((response) => {
          if (!response.ok) throw new Error(`read receipt failed: ${response.status}`)
        })
        .catch(() => {
          // Reading is not a mutation the user is waiting on, but a silently
          // dropped mark IS visible (the next open anchors the unread divider
          // at the stale server mark), so retry a few times before deferring to
          // the next arrival or open.
          reportedReadIdRef.current = null
          attempts += 1
          if (attempts < MARK_READ_MAX_ATTEMPTS) {
            markReadTimerRef.current = setTimeout(report, MARK_READ_RETRY_MS)
          }
        })
    }
    markReadTimerRef.current = setTimeout(report, MARK_READ_DEBOUNCE_MS)

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
   * Typists, resolved against the roster.
   *
   * Unresolved ids are dropped rather than shown as "someone": the indicator's
   * only content is a name, and a nameless one would be a permanent mystery
   * rather than a piece of information. The roster is loaded alongside the
   * history, so this is a race that resolves itself within one round trip.
   */
  const typists = useMemo(
    () =>
      Object.keys(typingUntil)
        .map((userId) => directory.get(userId))
        .filter((person): person is DirectoryPerson => person !== undefined),
    [typingUntil, directory]
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

  /**
   * Stop believing in a turn because it actually ended.
   *
   * The `ended` event is published as a side effect of an assistant message
   * being persisted, so a turn that dies without one — a cancelled turn, a
   * failed server-side persist — never publishes it, and the expiry above was
   * the only thing that ever cleared the banner. Meanwhile the observer's own
   * spectated stream sees the terminal frame immediately and knows. This is how
   * it says so.
   */
  const clearTurnInFlight = useCallback(() => setTurnInFlight(null), [])

  /**
   * Evidence the turn is still running, which restarts the staleness clock.
   *
   * The observer's spectated stream is the only thing that sees a long turn
   * making progress — there is no "is a turn running" endpoint — so it is what
   * feeds this.
   */
  const noteTurnActivity = useCallback(() => {
    lastTurnActivityRef.current = Date.now()
  }, [])

  /**
   * The reader's own role, same channel and same reason: a viewer's send is
   * rejected server-side, so the composer must be read-only BEFORE the attempt.
   * Cleared the moment the thread is no longer shared for this reader.
   */
  useEffect(() => {
    if (!conversationId) return
    publishThreadRole(conversationId, shared ? myRole : null)
  }, [conversationId, shared, myRole])

  const result = useMemo<UseSharedThreadResult>(
    () => ({
      shared,
      myRole,
      loading,
      connected,
      accessLost,
      turnInFlight,
      clearTurnInFlight,
      noteTurnActivity,
      typists,
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
      accessLost,
      turnInFlight,
      clearTurnInFlight,
      noteTurnActivity,
      typists,
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
  return enabled && conversationId
    ? result
    : { ...INERT, authorOf, refresh, setEngagement, clearTurnInFlight, noteTurnActivity }
}
