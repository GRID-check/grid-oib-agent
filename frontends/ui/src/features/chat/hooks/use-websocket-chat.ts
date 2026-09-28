/**
 * useWebSocketChat: the chat socket's driver (docs/design/chat-wire-v2.md §e.2,
 * §e.3).
 *
 * The socket (`createTurnSocket`) connects, reconnects and re-attaches; the
 * fold (`foldTurnEvent`, through the store's `applyTurnEvents`) is the one
 * reader of what it carries. What is left here is the driver between them:
 *
 * - **Sending.** A question is a `user_message` whose `message_id` is the
 *   question's own id, which the server makes the turn id. It is resent on
 *   every reopen until its `RUN_STARTED` acknowledges it; a resend the server
 *   already holds is refused as `duplicate_turn` and attached instead.
 * - **Folding.** An answer delta waits for the next {@link DELTA_FLUSH_MS}
 *   flush; any other event flushes at once, so a step, a card or the terminal
 *   is never held behind prose.
 * - **One cursor.** The socket re-attaches every turn the store's views hold
 *   open (`openTurns`): a running turn from its last seq, and a finished one
 *   until its stages have landed or the server's stage TTL has passed. A gap
 *   in a turn's seq is attached from the last seq folded.
 * - **Ending.** Stop is `cancel_turn`; the partial answer stays, marked
 *   stopped. A turn the stream no longer holds, or a socket that gave up, asks
 *   the server for the finished answer before any banner. Close code 4426 is
 *   a reload notice.
 *
 * A deep-research run is a message in the thread (ADR-0062); its block follows
 * the run's own stream (`features/runs/hooks/use-run-ledger.ts`).
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useShallow } from 'zustand/react/shallow'
import { useTranslations } from '@/i18n'
import { useAuth } from '@/adapters/auth'
import { createTurnSocket, type OpenTurn } from '@/adapters/api/turn-socket'
import type { ClientMessage, WireEvent } from '@/adapters/api/wire-v2'
import { checkBackendHealthCached, invalidateHealthCache } from '@/shared/hooks/use-backend-health'
import { useThreadSharing } from '@/shared/collaboration/thread-sharing'
import type { AddresseeSet } from '@/lib/mentions/types'
import { useChatStore } from '../store'
import { isFilePeekVisible, useFilePreviewStore } from '@/features/documents/stores/file-preview-store'
import { registerStopStreamingHandler, runningTurnIn } from '../stores/messages-store'
import { useConnectionRecovery } from './use-connection-recovery'
import { useEffortStore } from '../stores/effort-store'
import { useLayoutStore } from '@/features/layout/store'
import { useDocumentsStore } from '@/features/documents/store'
import { fetchRunMessage } from '../lib/commissioned-run'
import { STAGE_COUNT } from '../lib/turn-projection'
import type { TurnView } from '../lib/turn-fold'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import type { ChatMessage, Conversation, ErrorCode, PendingInteraction } from '../types'

/** A mention as the composer holds it: the structured target plus its text token. */
export interface SendMessageMention {
  targetId: string
  display: string
}

export interface SendMessageOptions {
  /**
   * Mentions chosen from the `@` picker (spec MN-3). Their presence switches the
   * send onto the addressee path: persistence is awaited and the SERVER decides
   * whether the agent answers.
   */
  mentions?: readonly SendMessageMention[]
  /** The asker's question, carried into the recipient's inbox item (spec MN-12). */
  mentionNote?: string | null
  /**
   * The thread is visibly waiting on a named person (an `open` mention request).
   *
   * A plain message in that state is a remark to the people in the thread, not a
   * question for the agent (ADR-0034 addendum) — so it must go down the same
   * awaited-persist path as a mention and let the SERVER rule on it. This flag only
   * decides whether the ruling is ASKED FOR; it never decides what the ruling is,
   * so a stale read costs a round trip and nothing else.
   */
  awaitingHuman?: boolean
}

/** A refusal the composer can localise from `details.reason`. */
export interface SendMessageFailure {
  reason: string | null
  message: string | null
  /** The mention target the refusal names, when the server supplied one. */
  targetId?: string | null
}

/** What a mention send resolves to — the server's ruling, or why it was refused. */
export interface SendMessageOutcome {
  ok: boolean
  /** The server's addressee ruling (spec MN-1/MN-2), when it answered. */
  addressees?: AddresseeSet
  failure?: SendMessageFailure
}

/** Read the standard error envelope so the composer can name the reason. */
async function readSendFailure(response: Response): Promise<SendMessageFailure> {
  try {
    const body = (await response.json()) as {
      error?: string
      details?: { reason?: string; targetId?: string } | null
    }
    return {
      reason: body.details?.reason ?? null,
      message: body.error ?? null,
      targetId: body.details?.targetId ?? null,
    }
  } catch {
    return { reason: null, message: null }
  }
}

/**
 * Pull this message's addressee ruling out of the persist response.
 *
 * `POST /api/conversations/:id/messages` answers with the persisted rows (an array,
 * even for one message), each carrying `addressees`. A row that is missing means the
 * insert conflicted — i.e. something else already wrote this id — and the ruling is
 * then NOT ours to act on, so it comes back null and no turn is opened.
 */
function readAddresseeRuling(body: unknown, messageId: string): AddresseeSet | null {
  const rows = (Array.isArray(body) ? body : [body]) as Array<{
    id?: string
    addressees?: AddresseeSet
  } | null>
  const row = rows.find((entry) => entry?.id === messageId) ?? null
  const addressees = row?.addressees
  if (!addressees || typeof addressees.agent !== 'boolean' || !Array.isArray(addressees.users)) {
    return null
  }
  return addressees
}

/**
 * Append a user message to the thread WITHOUT persisting it.
 *
 * Deliberately not `addUserMessage`, and this is the one subtle thing about the
 * mention path. `addUserMessage` persists fire-and-forget, WITHOUT the mentions —
 * and the server's ruling only comes back on the request that CREATES the row: a
 * second POST for the same id reads the first ruling back and drops the mentions
 * (`prepareMessage`, `lib/conversations/service.ts`). Letting the store's POST race
 * ours would therefore, whenever it won, store the message as "addressed to the
 * agent", create no request, notify nobody — and silently swallow the mention. So
 * the mention path owns the persist (awaited, with the mentions, with the id it
 * generated) and writes the echo straight into the thread here.
 *
 * `setState` is guarded because suites that mock the store wholesale do not supply
 * it; the send then still resolves, it simply renders nothing locally.
 */
function appendLocalUserMessage(message: ChatMessage): void {
  const store = useChatStore as unknown as {
    getState: () => { currentConversation: Conversation | null; conversations: Conversation[] }
    setState?: (
      partial: Partial<{ currentConversation: Conversation | null; conversations: Conversation[] }>
    ) => void
  }
  const { currentConversation, conversations } = store.getState()
  if (!currentConversation || typeof store.setState !== 'function') return

  const updated: Conversation = {
    ...currentConversation,
    // First message names the session, exactly like the store's own path does.
    title: currentConversation.title || message.content.trim().slice(0, 50),
    messages: [...currentConversation.messages, message],
    updatedAt: new Date(),
  }
  store.setState({
    currentConversation: updated,
    conversations: conversations.map((conversation) =>
      conversation.id === updated.id ? updated : conversation
    ),
  })
}

/**
 * How often buffered answer deltas reach the store while an answer streams.
 * Each flush re-renders everything subscribed to the open conversation; once
 * per animation frame, that was a 50–70 ms task every few frames on a 4×
 * throttled CPU. What the reader sees is paced separately (`usePacedText`),
 * so the flush can be this coarse without the text arriving in steps.
 */
export const DELTA_FLUSH_MS = 100

/**
 * How long the server keeps a finished turn's sequencer for its stages
 * (`STAGE_WIRE_TTL_S`, chat-wire-v2.md §c). Past it no stage can arrive, so
 * the turn is not attached again.
 */
const STAGE_WIRE_TTL_MS = 10 * 60_000

/**
 * `auth_expired` refusals in a row before the reader is asked to sign in
 * again. One is a token that expired under an open socket, and the reconnect
 * that refreshes it is the fix; a run of them is a token that does not
 * refresh, and reconnecting forever would hide that behind a spinner.
 */
const MAX_CONSECUTIVE_AUTH_EXPIRED = 3

/** Client messages that may wait for a socket; a burst of context lines is bounded, the oldest goes. */
const MAX_WAITING = 8

/** A turn that failed, as the reader is told about it. */
const RUN_ERROR_CODES: Record<NonNullable<TurnView['error']>['code'], ErrorCode> = {
  workflow_error: 'agent.workflow_error',
  auth_error: 'auth.session_expired',
  interaction_expired: 'agent.response_interrupted',
}

type Rejection = Extract<WireEvent, { type: 'CUSTOM'; name: 'rejected' }>
/** A `user_message` as the client builds it (its `type` has a default, so it is optional here). */
type UserMessage = Extract<ClientMessage, { message_id: string }>

/** What the driver needs from the hook: the reader-facing half of a failure. */
interface DriverHooks {
  refreshAuth: () => Promise<void>
  onConnected: (connected: boolean) => void
  /** The socket gave up reconnecting: say why, if the reason can be found. */
  onGaveUp: () => void
  /** The job queue refused the turn: a warning the reader can act on. */
  onQueueFull: (text: string, retryAfterSeconds: number | null) => void
}

export interface TurnDriver {
  conversationId: string
  projectId: string | undefined
  connect: () => Promise<void>
  close: () => void
  /** Put a question on the wire, and keep it there until the server acknowledges it. */
  ask: (message: UserMessage) => void
  /** Send now, or as soon as there is a socket. */
  deliver: (message: ClientMessage) => void
  /** Stop a turn: what arrived for it is folded first, so the answer kept is all of it. */
  cancel: (turnId: string) => void
}

const store = () => useChatStore.getState()

/** The subject's version state, when it is an OPEN version: the one retrieval cannot see, read as bytes instead. */
const openVersionState = (state: DocumentVersionState | null | undefined): UserMessage['focus_version_state'] =>
  state === 'draft' || state === 'in_review' || state === 'changes_requested' ? state : null

/**
 * End a turn this page cannot continue, but ask the server first: the backend
 * finishes and persists a turn whether or not anyone is listening, so the
 * answer may be waiting there. Only when it is not does the banner go up.
 */
const endInterruptedTurn = (view: TurnView): void => {
  store().dropTurn(view.turnId)
  void store()
    ._awaitServerAnswer(view.conversationId, view.turnId)
    .then((outcome) => {
      if (outcome === 'nothing' && store().currentConversation?.id === view.conversationId) {
        store().addErrorCard('agent.response_interrupted')
      }
    })
}

/** A turn that ended with `RUN_ERROR`: nothing was persisted, but the server is asked once before the banner. */
const endFailedTurn = (view: TurnView): void => {
  store().dropTurn(view.turnId)
  void store()
    ._recoverInterruptedAssistantMessage(view.conversationId, view.turnId)
    .then((outcome) => {
      if (outcome !== 'nothing' || store().currentConversation?.id !== view.conversationId) return
      const code = view.error ? RUN_ERROR_CODES[view.error.code] : 'agent.response_failed'
      store().addErrorCard(code, view.error?.message)
    })
}

/** The socket of one conversation and the turns it carries. */
const createTurnDriver = (conversationId: string, projectId: string | undefined, hooks: DriverHooks): TurnDriver => {
  /** Questions not yet acknowledged by their `RUN_STARTED`, by turn id. */
  const unacknowledged = new Map<string, ClientMessage>()
  /** The last answer, cancel or context line sent per turn and type, for a resend after `auth_expired`. */
  const sent = new Map<string, ClientMessage>()
  const waiting: ClientMessage[] = []
  const finishedAt = new Map<string, number>()
  /** The seq each gap was attached from, so one gap is attached once. */
  const gapsAttached = new Map<string, number>()
  let buffer: WireEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let authExpired = 0

  const keyOf = (message: ClientMessage): string =>
    `${message.type}:${'turn_id' in message ? message.turn_id : message.message_id}`

  const openTurns = (): OpenTurn[] => {
    const now = Date.now()
    return Object.values(store().turns).flatMap((view): OpenTurn[] => {
      if (view.conversationId !== conversationId || unacknowledged.has(view.turnId)) return []
      if (view.phase === 'running') return [{ turnId: view.turnId, lastSeq: view.lastSeq }]
      const finished = finishedAt.get(view.turnId)
      const stagesPending =
        view.phase === 'finished' &&
        view.outcome !== 'cancelled' &&
        finished !== undefined &&
        now - finished < STAGE_WIRE_TTL_MS &&
        Object.keys(view.stages).length < STAGE_COUNT
      return stagesPending ? [{ turnId: view.turnId, lastSeq: view.lastSeq, settled: true }] : []
    })
  }

  const socket = createTurnSocket({
    conversationId,
    projectId,
    openTurns,
    refreshAuth: hooks.refreshAuth,
    onEvent: (event) => receive(event),
    onStatus: (status) => {
      hooks.onConnected(status === 'open')
      if (status === 'open') opened()
      else if (status === 'failed' || status === 'outdated') gaveUp(status)
    },
  })

  const deliver = (message: ClientMessage): void => {
    if (message.type !== 'user_message' || message.context_only) sent.set(keyOf(message), message)
    if (socket.send(message)) return
    waiting.push(message)
    if (waiting.length > MAX_WAITING) waiting.shift()
  }

  const opened = (): void => {
    invalidateHealthCache()
    store().dismissConnectionErrors()
    for (const message of unacknowledged.values()) socket.send(message)
    for (const message of waiting.splice(0)) deliver(message)
  }

  const runningTurns = (): TurnView[] =>
    Object.values(store().turns).filter((view) => view.conversationId === conversationId && view.phase === 'running')

  const gaveUp = (status: 'failed' | 'outdated'): void => {
    unacknowledged.clear()
    waiting.length = 0
    if (status === 'outdated') store().addErrorCard('connection.client_outdated')
    else hooks.onGaveUp()
    for (const view of runningTurns()) endInterruptedTurn(view)
  }

  /** What a folded turn asks of the page beyond its messages. */
  const react = (previous: TurnView | undefined, view: TurnView | undefined): void => {
    if (!view) return
    if (view.gap && gapsAttached.get(view.turnId) !== view.lastSeq) {
      gapsAttached.set(view.turnId, view.lastSeq)
      socket.send({ type: 'attach', conversation_id: conversationId, turn_id: view.turnId, after_seq: view.lastSeq })
    }
    if (view.phase === 'failed' && previous?.phase !== 'failed') endFailedTurn(view)
    const result = view.result
    if (!result || result === previous?.result) return
    if (result.job_admission_rejected) hooks.onQueueFull(result.text, result.retry_after_seconds)
    // The turn commissioned a run (ADR-0062): its message already exists, and
    // the block renders from it and follows the run's own stream.
    const run = result.run
    if (run) {
      void fetchRunMessage(conversationId, run.run_message_id).then((message) => {
        if (message) store().adoptRunMessage(conversationId, message)
      })
    }
  }

  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    const events = buffer
    buffer = []
    if (events.length === 0) return
    const before = store().turns
    store().applyTurnEvents(events)
    const after = store().turns
    for (const turnId of new Set(events.map((event) => event.turn_id))) react(before[turnId], after[turnId])
  }

  const rejected = ({ turn_id: turnId, value }: Rejection): void => {
    const view = store().turns[turnId]
    switch (value.code) {
      case 'auth_expired': {
        authExpired += 1
        if (authExpired > MAX_CONSECUTIVE_AUTH_EXPIRED) {
          authExpired = 0
          store().addErrorCard('auth.session_expired')
          unacknowledged.delete(turnId)
          if (view?.phase === 'running') store().dropTurn(turnId)
          return
        }
        // The socket's token expired under it. A reconnect refreshes it, and
        // the refused message goes out again on the new socket.
        const refused = sent.get(`${value.of}:${turnId}`)
        if (refused) waiting.push(refused)
        socket.close()
        void socket.connect()
        return
      }
      case 'duplicate_turn':
        // The server has the question already: follow it instead of asking again.
        unacknowledged.delete(turnId)
        socket.send({ type: 'attach', conversation_id: conversationId, turn_id: turnId, after_seq: view?.lastSeq ?? 0 })
        return
      case 'turn_not_found':
        if (view?.phase === 'running') endInterruptedTurn(view)
        else if (view) store().dropTurn(turnId)
        return
      case 'conversation_mismatch':
      case 'invalid_message':
        if (value.of !== 'user_message') return
        unacknowledged.delete(turnId)
        store().dropTurn(turnId)
        store().addErrorCard('agent.response_failed', value.message ?? undefined)
        return
      case 'not_asker':
      case 'no_pending_interaction':
        // A Stop of someone else's turn, or an answer to a question already
        // closed: the turn itself says what happens next.
        return
    }
  }

  function receive(event: WireEvent): void {
    if (event.type === 'CUSTOM' && event.name === 'rejected') return rejected(event)
    if (event.type === 'RUN_STARTED') {
      unacknowledged.delete(event.turn_id)
      authExpired = 0
    }
    // This page's clock, like the TTL it is measured against: `ts` is the server's.
    if (event.type === 'RUN_FINISHED') finishedAt.set(event.turn_id, Date.now())
    buffer.push(event)
    if (event.type !== 'TEXT_MESSAGE_CONTENT') flush()
    else flushTimer ??= setTimeout(flush, DELTA_FLUSH_MS)
  }

  return {
    conversationId,
    projectId,
    connect: socket.connect,
    close: () => {
      flush()
      socket.close()
    },
    ask: (message) => {
      unacknowledged.set(message.message_id, message)
      socket.send(message)
    },
    deliver,
    cancel: (turnId) => {
      flush()
      deliver({ type: 'cancel_turn', conversation_id: conversationId, turn_id: turnId })
    },
  }
}

/**
 * Message kinds that count as "part of the conversation" when deciding whether a
 * turn is still open. Mirrors `restoreSessionState`'s own `meaningfulTypes` set
 * (sessions-store) on purpose: the two are answering the same question — "is the
 * last thing in this thread an unfinished turn?" — and they must not disagree.
 */
const MEANINGFUL_MESSAGE_TYPES = new Set(['user', 'assistant', 'agent_response', 'error', 'prompt'])

interface UseWebSocketChatOptions {
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean
  /**
   * Whether collaboration is reachable for this org (the dark-launch flag).
   *
   * **Defaults to false, and false means "exactly today"** (spec NF-8): the socket
   * opens on mount, before the user has done anything, with no request in front of
   * it. Only with the flag ON does the socket wait to learn whether the thread is
   * shared — see `socketPermitted` below for why that is not a latency cost for
   * private threads either.
   */
  canCollaborate?: boolean
}

interface UseWebSocketChatReturn {
  /**
   * Send a message. With nothing tagged and no hand-off open this returns
   * `false` when there was nothing to send (so the caller can keep the input).
   * With mentions, or with `awaitingHuman`, it returns a promise carrying the
   * server's addressee ruling: the agent answers only if that ruling says so
   * (ADR-0034 §4), and is DELIVERED the message either way, as context when it
   * is not the addressee. Plus a localisable `failure` when the send was refused.
   */
  sendMessage: (content: string, options?: SendMessageOptions) => boolean | Promise<SendMessageOutcome>
  /** Answer the open question: typed text, or a `choice` prompt's option id. */
  respondToInteraction: (response: string) => void
  /**
   * Declare that the user means to write something (composer focus, or a send).
   *
   * In a **shared** thread this is what opens the agent socket, because merely
   * opening the thread must not (ADR-0033 §7: a participant who did not start a
   * turn observes it over the SSE channel and needs no socket). Idempotent, and a
   * no-op wherever the socket is already permitted — so a private thread and a
   * gated org never reach it.
   */
  noteSendIntent: () => void
  /** The question is sent and the server has not acknowledged it yet. */
  isLoading: boolean
  /** The question the agent is waiting on. */
  pendingInteraction: PendingInteraction | null
}

/**
 * Ask the same-origin diagnostics endpoint whether a failed socket was a
 * budget block the browser could not read from the collapsed upgrade. The
 * localized banner message (admin or member copy) when it was, null for any
 * other cause or on error. Never throws.
 */
const discoverBudgetFailureMessage = async (t: ReturnType<typeof useTranslations>): Promise<string | null> => {
  try {
    const activeProjectId = useChatStore.getState().projectId
    const query = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : ''
    const res = await fetch(`/api/auth/connection-diagnostics${query}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { budgetExhausted?: boolean; canManageBudgets?: boolean }
    if (!body.budgetExhausted) return null
    return body.canManageBudgets ? t('budgetExhausted.adminMessage') : t('budgetExhausted.memberMessage')
  } catch {
    return null
  }
}

/**
 * Is the newest thing in this thread an unfinished turn that belongs to ME?
 *
 * "Mine" is `authorUserId === currentUserId`, or absent — a solo thread renders
 * no attribution and writes no author, so absent means "there is only me".
 * An unresponded HITL prompt counts: the thread is paused on an answer only this
 * browser can give. So does a still-`isStreaming` assistant message. A reload
 * no longer restores one (the storage drops an interrupted answer, and the
 * question it answers is then the newest turn), but a socket that drops
 * mid-answer without a reload leaves exactly that.
 */
const ownsUnansweredTurnIn = (
  messages: ChatMessage[] | undefined,
  currentUserId: string | null
): boolean => {
  if (!messages?.length) return false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!MEANINGFUL_MESSAGE_TYPES.has(message.messageType ?? '')) continue
    if (message.messageType === 'prompt') return !message.isPromptResponded
    if (message.messageType === 'user') {
      return !message.authorUserId || message.authorUserId === currentUserId
    }
    // An assistant/error message closes the turn — unless it is the partial
    // bubble a refresh interrupted, which is exactly a turn to reattach to.
    return message.isStreaming === true
  }
  return false
}

export const useWebSocketChat = (options: UseWebSocketChatOptions = {}): UseWebSocketChatReturn => {
  const { autoConnect = true, canCollaborate = false } = options
  const { user, authRequired, isLoading: authLoading, getAccessToken } = useAuth()
  const tChat = useTranslations('chat')

  // The conversation's id and whether its newest turn is mine, not the
  // conversation itself: the conversation is a new object on every flush,
  // and this hook's host (the composer) would re-render with each one.
  const { currentConversationId, ownsUnansweredTurn, isLoading, pendingInteraction, resumableTurn } =
    useChatStore(
      useShallow((s) => ({
        currentConversationId: s.currentConversation?.id,
        ownsUnansweredTurn: ownsUnansweredTurnIn(s.currentConversation?.messages, s.currentUserId),
        isLoading: s.isLoading,
        pendingInteraction: s.pendingInteraction,
        resumableTurn: s.resumableTurn,
      }))
    )
  const projectId = useChatStore((s) => s.projectId) || undefined
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const addErrorCard = useChatStore((s) => s.addErrorCard)
  const respondToPrompt = useChatStore((s) => s.respondToPrompt)
  const setCurrentUser = useChatStore((s) => s.setCurrentUser)

  useEffect(() => {
    setCurrentUser(user?.id ?? null)
  }, [user?.id, setCurrentUser])

  /* ────────────────────────────────────────────────────────────────────────────
   * MAY THIS BROWSER HOLD AN AGENT SOCKET FOR THIS CONVERSATION?
   *
   * The agent tier's socket registry keys live sockets by conversation_id, so a
   * second socket on the same conversation REPLACES the first. For one user reconnecting
   * that is the feature. For two participants in a shared thread it is a defect:
   * a reader who merely OPENS the thread takes over the asker's registration, so
   * his answer streams into her connection and disappears from his — and because
   * `clear_socket` is identity-guarded, her leaving unregisters the conversation
   * outright rather than handing it back.
   *
   * The frontend cause is that this hook auto-connected on MOUNT. ADR-0033 §7
   * already decided the shape of the fix: an observer sees turn *state* over the
   * SSE channel ("Piloti is answering Anna's question", then the answer), not
   * token streaming. So a participant who is only reading has no reason to hold a
   * socket, and the connection can follow **intent to send** instead of mounting.
   *
   * Four things open the gate, and the order matters:
   *
   *   1. `!canCollaborate` — the flag is off. Byte-identical to today, evaluated
   *      synchronously on the first render, with no request in front of it (NF-8).
   *      This is the overwhelming majority of usage and it pays nothing.
   *   2. `sharing === 'private'` — the server has said this thread is solo. Also
   *      connect-on-mount. The access read this reads from is the one
   *      `useSharedThread` already issues on open (ADR-0033 §1), so it costs no
   *      extra round trip and it resolves while the thread is still painting —
   *      long before anyone can focus a composer. A private thread therefore
   *      keeps today's first-message latency.
   *   3. `intent` — composer focus (or a send). See `noteSendIntent`.
   *   4. `ownsUnansweredTurn` — this browser is the one waiting on an answer, so
   *      it must reconnect WITHOUT being touched: the new socket `attach`es the
   *      turn, and a refresh mid-answer would otherwise sit there until the user
   *      clicked the composer.
   *
   * `'unknown'` (collaboration on, access read not yet answered) deliberately does
   * NOT open the gate: guessing "private" there would re-open the collision, while
   * guessing "unknown" only defers a connect that (1)-(4) will make anyway.
   *
   * The result is LATCHED per conversation. Once a socket is permitted it stays
   * permitted until the conversation changes, because every input above is
   * transient — `ownsUnansweredTurn` flips false the moment the answer starts
   * arriving, and re-evaluating the gate then would tear down the very socket the
   * answer is streaming on.
   * ──────────────────────────────────────────────────────────────────────────── */
  const threadSharing = useThreadSharing(currentConversationId)

  const socketGateRef = useRef<{
    conversationId: string | undefined
    intent: boolean
    open: boolean
  }>({ conversationId: undefined, intent: false, open: false })

  // Re-render trigger for `noteSendIntent`. The intent itself lives in the ref, not
  // in state, so that switching conversations resets it in the SAME render that
  // resets the latch — a state reset lands one render late, which would let the
  // previous thread's intent open the gate on the new one.
  const [, bumpSocketGate] = useState(0)

  if (socketGateRef.current.conversationId !== currentConversationId) {
    socketGateRef.current = { conversationId: currentConversationId, intent: false, open: false }
  }

  const noteSendIntent = useCallback(() => {
    if (socketGateRef.current.intent) return
    socketGateRef.current.intent = true
    bumpSocketGate((n) => n + 1)
  }, [])

  if (
    !canCollaborate ||
    threadSharing === 'private' ||
    socketGateRef.current.intent ||
    ownsUnansweredTurn
  ) {
    socketGateRef.current.open = true
  }
  const socketPermitted = socketGateRef.current.open

  const driverRef = useRef<TurnDriver | null>(null)
  const [isConnected, setIsConnected] = useState(false)

  /**
   * The reader-facing half of the driver, read through a ref so a socket
   * lives as long as its conversation: AuthKit hands out a new
   * `getAccessToken` whenever its token state changes, and a socket keyed on
   * that identity reconnected all through a streaming answer.
   */
  const isSessionExpired = authRequired && !user && !authLoading
  const hooks: DriverHooks = {
    refreshAuth: async () => {
      if (!authRequired || !getAccessToken) return
      await getAccessToken()
    },
    onConnected: setIsConnected,
    onGaveUp: () => void explainConnectionFailure(),
    onQueueFull: (text, retryAfter) => {
      const hint = retryAfter ? tChat('errorRegistry.researchQueueFull.retryHint', { seconds: retryAfter }) : ''
      addErrorCard('research.queue_full', [text.trim(), hint].filter(Boolean).join(' ') || undefined)
    },
  }
  const hooksRef = useRef(hooks)
  useEffect(() => {
    hooksRef.current = hooks
  })

  /**
   * Why the socket gave up. The gateway refuses a budget-exhausted upgrade with
   * a bare failed handshake the browser cannot read, so a same-origin endpoint
   * is asked once per failure episode; then the backend's health separates
   * "down" from a session that drifted.
   */
  const budgetCheckedRef = useRef(false)
  const explainConnectionFailure = async (): Promise<void> => {
    const conversationId = useChatStore.getState().currentConversation?.id
    const stillHere = () => useChatStore.getState().currentConversation?.id === conversationId
    if (!budgetCheckedRef.current) {
      budgetCheckedRef.current = true
      const budgetMessage = await discoverBudgetFailureMessage(tChat)
      if (!stillHere()) return
      if (budgetMessage) return addErrorCard('budget.exhausted', budgetMessage)
    }
    const backendUp = await checkBackendHealthCached()
    if (!stillHere()) return
    addErrorCard(backendUp && isSessionExpired ? 'auth.session_expired' : 'connection.failed')
  }

  /** This conversation's driver, created (and connected) when it has none. */
  const ensureDriver = useCallback((conversationId: string): TurnDriver => {
    const projectId = useChatStore.getState().projectId || undefined
    const current = driverRef.current
    if (current?.conversationId === conversationId && current.projectId === projectId) return current
    current?.close()
    budgetCheckedRef.current = false
    const driver = createTurnDriver(conversationId, projectId, {
      refreshAuth: () => hooksRef.current.refreshAuth(),
      onConnected: (connected) => hooksRef.current.onConnected(connected),
      onGaveUp: () => hooksRef.current.onGaveUp(),
      onQueueFull: (text, retryAfter) => hooksRef.current.onQueueFull(text, retryAfter),
    })
    driverRef.current = driver
    void driver.connect()
    return driver
  }, [])

  // One socket per conversation (and project scope): opened once the gate
  // allows it, closed when the conversation changes. A turn running in the
  // conversation left keeps its view, and coming back re-attaches it.
  useEffect(() => {
    if (currentConversationId && autoConnect && socketPermitted) ensureDriver(currentConversationId)
  }, [currentConversationId, projectId, autoConnect, socketPermitted, ensureDriver])
  useEffect(
    () => () => {
      driverRef.current?.close()
      driverRef.current = null
      setIsConnected(false)
    },
    [currentConversationId]
  )

  // A turn a reload cut off: once there is a socket, fold it again from its
  // first event. The stream answers with the replay, or with `turn_not_found`,
  // which sends the reader to the server's copy.
  useEffect(() => {
    const driver = driverRef.current
    if (!resumableTurn || !isConnected || driver?.conversationId !== resumableTurn.conversationId) return
    const { turns, beginTurn } = useChatStore.getState()
    if (runningTurnIn(turns, resumableTurn.conversationId)) return
    beginTurn(resumableTurn.conversationId, resumableTurn.turnId)
    driver.deliver({
      type: 'attach',
      conversation_id: resumableTurn.conversationId,
      turn_id: resumableTurn.turnId,
      after_seq: 0,
    })
  }, [resumableTurn, isConnected])

  // Stop: `cancel_turn`, sent now or as soon as the socket is back.
  useEffect(() => {
    registerStopStreamingHandler((turnId) => {
      const conversationId = useChatStore.getState().currentConversation?.id
      if (conversationId) ensureDriver(conversationId).cancel(turnId)
    })
    return () => registerStopStreamingHandler(null)
  }, [ensureDriver])

  const connect = useCallback(() => {
    const conversationId = useChatStore.getState().currentConversation?.id
    if (!conversationId) return
    if (driverRef.current?.conversationId === conversationId) void driverRef.current.connect()
    else ensureDriver(conversationId)
  }, [ensureDriver])
  // Reconnect once the backend is healthy again while a connection error is shown.
  useConnectionRecovery(connect)

  /**
   * Deliver a human message to the agent as CONTEXT ONLY — "always send, never
   * always judge" (ADR-0034 addendum).
   *
   * The hand-off suppresses the agent by not invoking it, which is right about
   * tokens and was wrong about MEMORY: the agent's history is its LangGraph
   * checkpoint, so a turn that never reached it leaves a hole, and `@Piloti given
   * that, recheck` then refers to nothing. This closes the hole without making
   * routing probabilistic — the server already ruled that the agent is not
   * addressed; only DELIVERY changes.
   *
   * No turn is opened for it (no view, no acknowledgement to wait for): the
   * frame is answered by design. Best effort: the message is already persisted
   * in Postgres, so a frame that cannot go out costs the agent a line of memory
   * and the thread nothing. With no socket yet it waits for one, among a
   * bounded few, and is discarded with the conversation if none comes up.
   */
  const deliverAsContext = useCallback(
    (messageId: string, content: string, dataSourcesForMessage: string[]): void => {
      const conversationId = useChatStore.getState().currentConversation?.id
      if (!conversationId) return
      // The user just wrote in this thread, so they are not an observer any
      // more: the same intent a composer focus declares.
      noteSendIntent()
      ensureDriver(conversationId).deliver({
        type: 'user_message',
        conversation_id: conversationId,
        message_id: messageId,
        text: content,
        data_sources: dataSourcesForMessage,
        context_only: true,
        author_name: user?.name ?? user?.email ?? null,
      })
    },
    [user?.name, user?.email, ensureDriver, noteSendIntent]
  )

  /**
   * The send metadata both paths need: which sources are live, and which of this
   * session's files are attached.
   */
  const collectSendMetadata = useCallback(() => {
    const layoutState = useLayoutStore.getState()
    const enabledDataSources = layoutState.enabledDataSourceIds

    // Get session files
    const sessionId = useChatStore.getState().currentConversation?.id
    const trackedFiles = useDocumentsStore.getState().trackedFiles
    const sessionFiles = sessionId
      ? trackedFiles.filter(
          (f) =>
            f.collectionName === sessionId && (f.status === 'ingesting' || f.status === 'success')
        )
      : []

    return {
      // Keep internal knowledge available for base/project/session corpora even though it is hidden from toggles.
      dataSourcesForMessage: layoutState.knowledgeLayerAvailable
        ? Array.from(new Set([...enabledDataSources, 'knowledge_layer']))
        : enabledDataSources,
      // Prepare file metadata for display
      messageFiles: sessionFiles.map((f) => ({ id: f.id, fileName: f.fileName })),
    }
  }, [])

  /**
   * Open an agent turn for the question `messageId`: its view starts running
   * now, and the question goes on the wire, or waits for the socket and goes
   * on it the moment it opens. Both send paths share this one definition of
   * "a turn starts", and the mention path can decline to call it at all: the
   * point of MN-7 is that nothing is started rather than started and
   * cancelled.
   */
  const openAgentTurn = useCallback(
    (messageId: string, content: string, dataSourcesForMessage: string[], conversationId: string | undefined): boolean => {
      if (!conversationId) {
        addErrorCard('system.unknown', 'No active conversation')
        return false
      }
      // Retrieval follows the composer bar ("Asking about this file"). A
      // visible peek is the fallback when there is no bar yet. A version id
      // only ever comes from the SUBJECT: it says what this turn is about, and
      // a file that merely happens to be visible beside the chat does not.
      const preview = useFilePreviewStore.getState()
      const subject = useChatStore.getState().composerSubject
      const subjectName = subject?.filename?.trim() || subject?.title?.trim() || undefined
      const peekName = isFilePeekVisible(preview) ? preview.file?.filename.trim() || undefined : undefined
      useChatStore.getState().beginTurn(conversationId, messageId)
      ensureDriver(conversationId).ask({
        type: 'user_message',
        conversation_id: conversationId,
        message_id: messageId,
        text: content,
        data_sources: dataSourcesForMessage,
        focus_file_name: subjectName || peekName || null,
        focus_shelf: subject?.shelf ?? null,
        focus_document_id: subject?.resourceId ?? null,
        focus_version_id: subject?.versionId ?? null,
        focus_version_state: openVersionState(subject?.versionState),
        source_preset: useLayoutStore.getState().activeSourcePreset ?? null,
        // The composer's Aufwand dial. Always stated, so the level the chat
        // shows is the level the turn runs at (`effort-store.ts`).
        reasoning_effort: useEffortStore.getState().levelForSend(conversationId),
      })
      return true
    },
    [addErrorCard, ensureDriver]
  )

  /**
   * Send a message the SERVER rules on — THE ADDRESSEE CONTRACT (ADR-0034 §4).
   *
   * Taken by a message that carries mentions, and by a plain message sent while the
   * thread waits on a named person (the addendum's second state, where a remark is
   * not a question). Everything that makes this path different from the fast one
   * follows from one rule: **the server decides who answers.** So persistence is
   * awaited, the `addressees` ruling is read off the response, and an agent turn is
   * opened only when `addressees.agent` is true. When it is false nothing is STARTED
   * — no status, no thinking bubble, no tokens (spec MN-7) — and the thread's
   * awaiting-state explains the silence instead.
   *
   * The message still reaches the agent, as context only (see `deliverAsContext`).
   * Not answering is a routing decision; not remembering was a bug.
   *
   * It also means a refusal (a collaborator tagging a non-participant, a target
   * outside the project, a rate limit) refuses the WHOLE send: nothing is echoed
   * into the thread, so the composer can keep the user's text and say why.
   */
  const sendRuledMessage = useCallback(
    async (content: string, options: SendMessageOptions): Promise<SendMessageOutcome> => {
      const mentions = options.mentions ?? []
      const store = useChatStore.getState()
      const conversationId = store.currentConversation?.id ?? store.ensureSession?.()
      if (!conversationId) {
        addErrorCard('system.unknown', 'No active conversation')
        return { ok: false }
      }

      const { dataSourcesForMessage, messageFiles } = collectSendMetadata()
      // Our id, generated up front: it is the anchor the mention request points at,
      // and the idempotency key the server rules on.
      const messageId = uuidv4()

      let ruling: AddresseeSet | null = null
      try {
        // The conversation row has to exist before a message can be posted onto it.
        // Shared with the store's own append path, so it is at most one round trip.
        await store._ensureConversationExists?.()

        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: messageId,
              role: 'user',
              content,
              messageType: 'user',
              metadata: {
                enabledDataSources: dataSourcesForMessage,
                ...(messageFiles.length > 0 ? { messageFiles } : {}),
              },
              createdAt: new Date().toISOString(),
              // Structured references, never a text match on a name (spec MN-3).
              mentions: mentions.map((mention) => ({ targetId: mention.targetId })),
              ...(options.mentionNote ? { mentionNote: options.mentionNote } : {}),
            }),
          }
        )

        if (!response.ok) {
          return { ok: false, failure: await readSendFailure(response) }
        }
        ruling = readAddresseeRuling(await response.json(), messageId)
      } catch {
        // Network/offline: nothing was stored, so nothing is echoed and no turn is
        // opened. The composer keeps the text.
        return { ok: false, failure: { reason: null, message: null } }
      }

      if (!ruling) return { ok: false, failure: { reason: null, message: null } }

      appendLocalUserMessage({
        id: messageId,
        role: 'user',
        content,
        timestamp: new Date(),
        messageType: 'user',
        enabledDataSources: dataSourcesForMessage,
        messageFiles: messageFiles.length > 0 ? messageFiles : undefined,
        // Kept on the message so the bubble can render the tokens as chips
        // without re-deriving anything from the text.
        mentions: mentions.map((mention) => ({ ...mention })),
        addressees: ruling,
      })

      if (!ruling.agent) {
        // The thread now waits for a human. Nothing is STARTED (MN-7) — but the
        // agent still has to see what was written, or the next `@Piloti given
        // that…` has nothing to refer to. Free, silent, best-effort.
        deliverAsContext(messageId, content, dataSourcesForMessage)
        return { ok: true, addressees: ruling }
      }

      const started = openAgentTurn(messageId, content, dataSourcesForMessage, conversationId)
      return { ok: started, addressees: ruling }
    },
    [addErrorCard, collectSendMetadata, deliverAsContext, openAgentTurn]
  )

  /**
   * Send a message via WebSocket.
   *
   * Two paths, deliberately asymmetric:
   *   - **a thread in its normal state, with nothing tagged**: the message is
   *     echoed and persisted fire-and-forget and the turn opens immediately.
   *     This is the 99% case and it must not pay for the feature (returns a
   *     plain boolean).
   *   - **mentions, or a plain message while the thread waits on a person**:
   *     the addressee contract, where persistence is awaited and the server
   *     decides whether a turn opens at all (returns an outcome).
   */
  const sendMessage = useCallback(
    (content: string, options?: SendMessageOptions): boolean | Promise<SendMessageOutcome> => {
      if (!content.trim()) return false
      if ((options?.mentions && options.mentions.length > 0) || options?.awaitingHuman) {
        return sendRuledMessage(content, options ?? {})
      }
      const { dataSourcesForMessage, messageFiles } = collectSendMetadata()
      const message = addUserMessage(content, { enabledDataSources: dataSourcesForMessage, messageFiles })
      // The conversation may have just been created inside addUserMessage.
      const conversationId = useChatStore.getState().currentConversation?.id
      return openAgentTurn(message.id, content, dataSourcesForMessage, conversationId)
    },
    [addUserMessage, collectSendMetadata, openAgentTurn, sendRuledMessage]
  )

  /**
   * Answer the open `interaction_request`: the typed text, or the chosen
   * option's id for a `choice` prompt. Sent now, or when the socket is back.
   */
  const respondToInteraction = useCallback(
    (response: string) => {
      const { pendingInteraction: pending, currentConversation } = useChatStore.getState()
      if (!pending || !currentConversation) return
      const prompt = currentConversation.messages.findLast(
        (m) => m.messageType === 'prompt' && m.promptId === pending.interactionId
      )
      if (prompt) respondToPrompt(prompt.id, response)
      ensureDriver(currentConversation.id).deliver({
        type: 'interaction_response',
        conversation_id: currentConversation.id,
        turn_id: pending.turnId,
        interaction_id: pending.interactionId,
        answer: pending.input === 'choice' ? { option_id: response } : { text: response },
      })
    },
    [respondToPrompt, ensureDriver]
  )

  return { sendMessage, respondToInteraction, noteSendIntent, isLoading, pendingInteraction }
}
