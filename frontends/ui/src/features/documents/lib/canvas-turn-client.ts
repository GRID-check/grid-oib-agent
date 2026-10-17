/**
 * Piloti's turns on the review canvas: one conversation, one socket, no store.
 *
 * The chat's driver (`features/chat/hooks/use-websocket-chat.ts`) is welded to
 * the chat store. The canvas needs the same two store-free pieces underneath it,
 * `createTurnSocket` (connect, hello, reconnect, attach on reopen) and
 * `foldTurnEvent` (the one reader of the wire), and only the essentials of the
 * driver between them:
 *
 * - **The conversation first.** The person's thread about the document
 *   (`POST /api/documents/{id}/thread`, ADR-0106), or `POST /api/conversations`
 *   (idempotent for its creator), exists before the socket opens: a socket opened onto a
 *   conversation the database does not hold carries no verified conversation
 *   id in its envelope (ADR-0084), and the subject document is then refused.
 *   The question is stored by this browser (`POST …/messages`), as the chat
 *   does; the answer is stored by the server.
 * - **Every question ends.** A question the server does not acknowledge within
 *   {@link CANVAS_ACK_TIMEOUT_MS} reopens the socket and goes out again; a
 *   second miss fails the turn (`agent.no_response`). A refusal, a `RUN_ERROR`
 *   or a socket that gave up fails it too. Nothing waits on silence.
 * - **One turn at a time.** A second question while one runs is refused
 *   (`CanvasTurnError('busy')`). What the person adds meanwhile is a note
 *   for the running turn instead (`steer`, when the hello offers it): the
 *   turn reads it before its next round, and a note it never read is handed
 *   back (`onLeftover`) once the turn has ended, to be asked next.
 * - **Gaps.** A jump in a turn's `seq` is attached from the last seq folded,
 *   once per gap; a reopened socket attaches the running turn by itself.
 * - **Nothing travels silently short.** A server whose hello does not name the
 *   box or the thread target answers without them (`forServer`). The question
 *   still goes, and `onDegraded` says what it went without, so the canvas can
 *   say so instead of showing an answer about the whole document as the
 *   answer about the box.
 */

import { v4 as uuidv4 } from 'uuid'
import {
  createTurnSocket,
  type OpenTurn,
  type TurnSocket,
  type TurnSocketOptions,
  type TurnSocketStatus,
} from '@/adapters/api/turn-socket'
import type { ClientMessage, WireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvent, initialTurnView, isSteerRead, stopTurnView, type TurnView } from '@/features/chat/lib/turn-fold'
import { clampFocusRegion, type CanvasFocusRegion } from '@/features/chat/lib/canvas-bridge'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import type { ChatEffort } from '@/lib/reasoning-settings/catalog'

/** How long a question may go unacknowledged before the socket is reopened (the chat's figure). */
export const CANVAS_ACK_TIMEOUT_MS = 15_000
const ACK_MISSES_BEFORE_GIVING_UP = 2
const MAX_AUTH_EXPIRED = 3
/** Sockets in a row the watchdog may drop for a turn's silence before it is ended: the chat driver's figure. */
const SILENT_DROPS_BEFORE_GIVING_UP = 2

/**
 * The box a question is about: a 1-based page and a region of it as shares of
 * the page, top-left origin (the `PageRegion` frame Anmerkungen use).
 * `annotation_id` names the Anmerkung the box belongs to, when it is one.
 *
 * LOCAL until the generated wire type carries it (`wire-v2.generated.ts`,
 * `user_message.focus_region`); switch to the generated type then. The chat's
 * send path carries the same shape (`features/chat/lib/canvas-bridge.ts`).
 */
export type FocusRegion = CanvasFocusRegion

type WireUserMessage = Extract<ClientMessage, { message_id: string }>

/**
 * A `user_message` as the canvas sends it. LOCAL for the same reason as
 * {@link FocusRegion}: `focus_region` and `reply_in_thread` are being added to
 * the wire; once generated, this is the generated type.
 */
export type CanvasUserMessage = WireUserMessage & {
  focus_region?: FocusRegion | null
  /** Piloti answers in the thread of `focus_region.annotation_id`, as a reply. */
  reply_in_thread?: boolean
}

export interface CanvasQuestion {
  text: string
  /** The box asked about; null asks about the whole document. */
  region?: FocusRegion | null
  fileName?: string | null
  versionId?: string | null
  versionState?: DocumentVersionState | null
  shelf?: 'session' | 'project' | 'archiv' | null
  replyInThread?: boolean
  effort?: ChatEffort
}

/** What of a canvas question a server may not read: the box, and the ask to answer in the mark's thread. */
export type CanvasDegradation = 'region' | 'thread'

/** The parts of `message` a server that names only `accepts` would leave out (`forServer`). Pure. */
export function canvasDegradations(
  message: CanvasUserMessage,
  accepts: (entry: string) => boolean
): CanvasDegradation[] {
  const dropped: CanvasDegradation[] = []
  if (message.focus_region && !accepts('user_message.focus_region')) dropped.push('region')
  if (message.reply_in_thread && !accepts('user_message.reply_in_thread')) dropped.push('thread')
  return dropped
}

export class CanvasTurnError extends Error {
  constructor(readonly code: 'busy' | 'closed') {
    super(code === 'busy' ? 'Piloti is still answering the previous question' : 'The canvas client is closed')
    this.name = 'CanvasTurnError'
  }
}

export interface CanvasTurnClientOptions {
  conversationId: string
  /**
   * The conversation row exists already: the person's own thread about the
   * document, which `POST /api/documents/{id}/thread` created (ADR-0106).
   * Nothing is created before the socket opens.
   */
  conversationExists?: boolean
  projectId?: string | null
  documentId: string
  /** The conversation's title, when it is created. */
  title: string
  /** Every change to a turn's view: folded events, and the failures this client decides. */
  onTurn: (view: TurnView) => void
  /** The conversation row exists: its link may be offered. */
  onConversation?: () => void
  /** A question went out without parts its server does not read; called once per question, after it is sent. */
  onDegraded?: (turnId: string, dropped: CanvasDegradation[]) => void
  /** Refresh the auth cookie before each socket attempt. */
  refreshAuth?: () => Promise<void>
  /** The socket factory; a fake in specs. */
  createSocket?: (options: TurnSocketOptions) => TurnSocket
  /** `fetch`; a stand-in in specs that do not run MSW. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  ackTimeoutMs?: number
}

export interface CanvasTurnClient {
  readonly conversationId: string
  /** Create the conversation (once; a failure is tried again on the next call). */
  ensureConversation: () => Promise<void>
  /**
   * Ask. `turnId` becomes the turn's id (the question's message id). Resolves
   * once the question is on its way; what happens to it arrives through
   * `onTurn`, a failure to store it included. Throws only `busy` and `closed`.
   */
  ask: (question: CanvasQuestion, turnId: string) => Promise<void>
  /** Stop a turn: the view keeps what arrived, marked cancelled. */
  cancel: (turnId: string) => void
  /**
   * A note for the running turn. False when no turn runs or the server reads
   * no notes. A note the turn never read reaches `onLeftover` once it has
   * ended (not after a Stop).
   */
  steer: (text: string, options?: { region?: FocusRegion | null; onLeftover?: (text: string) => void }) => boolean
  close: () => void
}

/** The version state the agent reads as bytes: an open one. Published is what retrieval already sees. */
const openVersionState = (state: DocumentVersionState | null | undefined): CanvasUserMessage['focus_version_state'] =>
  state === 'draft' || state === 'in_review' || state === 'changes_requested' ? state : null

const jsonInit = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

/** The `user_message` for one question, in the field order `openAgentTurn` writes. */
export function canvasUserMessage(
  conversationId: string,
  documentId: string,
  turnId: string,
  question: CanvasQuestion
): CanvasUserMessage {
  return {
    type: 'user_message',
    conversation_id: conversationId,
    message_id: turnId,
    text: question.text,
    focus_file_name: question.fileName?.trim() || null,
    focus_shelf: question.shelf ?? 'project',
    focus_document_id: documentId,
    focus_version_id: question.versionId ?? null,
    focus_version_state: openVersionState(question.versionState),
    focus_region: question.region ? clampFocusRegion(question.region) : null,
    ...(question.replyInThread ? { reply_in_thread: true } : {}),
    reasoning_effort: question.effort ?? 'low',
  }
}

export function createCanvasTurnClient(options: CanvasTurnClientOptions): CanvasTurnClient {
  const { conversationId } = options
  const run = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const ackTimeout = options.ackTimeoutMs ?? CANVAS_ACK_TIMEOUT_MS
  const views = new Map<string, TurnView>()
  const gapsAttached = new Map<string, number>()
  /** Silent sockets per turn, reset whenever the turn is heard from. */
  const silentDrops = new Map<string, number>()
  /** The question not yet acknowledged, its deadline and the deadlines it missed. */
  let pending: {
    message: CanvasUserMessage
    timer: ReturnType<typeof setTimeout> | null
    misses: number
    degradedTold?: boolean
  } | null = null
  /** The turn this client is waiting on, asked or running. */
  let running: string | null = null
  let conversation: Promise<void> | null = null
  let socket: TurnSocket | null = null
  let socketOpen = false
  let authExpired = 0
  let closed = false
  /** The notes sent to the running turn, by `steer_id`, until it ends. */
  const steers = new Map<string, { turnId: string; text: string; onLeftover?: (text: string) => void }>()

  /** The turn ended: a note it never read goes back to the canvas, to be asked next; a Stop drops it. */
  const settleSteers = (view: TurnView): void => {
    for (const [steerId, note] of [...steers]) {
      if (note.turnId !== view.turnId) continue
      steers.delete(steerId)
      if (isSteerRead(view, steerId) || view.outcome === 'cancelled' || !note.onLeftover) continue
      const leftover = note.onLeftover
      setTimeout(() => leftover(note.text), 0)
    }
  }

  const publish = (view: TurnView): void => {
    const previous = views.get(view.turnId)
    views.set(view.turnId, view)
    options.onTurn(view)
    if (view.phase !== 'running' && previous?.phase === 'running') settleSteers(view)
  }

  const forgetPending = (): void => {
    if (pending?.timer) clearTimeout(pending.timer)
    pending = null
  }

  /** End a turn this client cannot continue; what it had written stays. */
  const fail = (turnId: string, code: string, message: string): void => {
    if (pending?.message.message_id === turnId) forgetPending()
    if (running === turnId) running = null
    const view = views.get(turnId) ?? initialTurnView(turnId, conversationId)
    if (view.phase !== 'running') return
    publish({ ...view, phase: 'failed', streaming: false, interaction: undefined, error: { code, message } })
  }

  const awaitAck = (): void => {
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(missedAck, ackTimeout)
  }

  function missedAck(): void {
    if (!pending) return
    pending.timer = null
    pending.misses += 1
    if (pending.misses >= ACK_MISSES_BEFORE_GIVING_UP) {
      fail(pending.message.message_id, 'agent.no_response', 'Piloti did not answer')
      return
    }
    // An open socket that did not answer is reopened, and the question goes
    // out again on the new one; a socket still connecting is left to its ladder.
    if (socketOpen) socket?.reconnect()
    awaitAck()
  }

  /** Send the question waiting for its answer, once a socket can take it; say what it went without. */
  const sendPending = (): boolean => {
    if (!pending || !socket?.send(pending.message)) return false
    const dropped = canvasDegradations(pending.message, socket.accepts)
    if (dropped.length > 0 && !pending.degradedTold) {
      pending.degradedTold = true
      options.onDegraded?.(pending.message.message_id, dropped)
    }
    return true
  }

  const openTurns = (): OpenTurn[] => {
    if (!running || pending?.message.message_id === running) return []
    return [{ turnId: running, lastSeq: views.get(running)?.lastSeq ?? 0 }]
  }

  const attach = (turnId: string, afterSeq: number): void => {
    socket?.send({ type: 'attach', conversation_id: conversationId, turn_id: turnId, after_seq: afterSeq })
  }

  const rejected = (event: Extract<WireEvent, { type: 'CUSTOM'; name: 'rejected' }>): void => {
    const { turn_id: turnId, value } = event
    // A refused note never ends its turn: it stays unread, and is handed back when the turn ends.
    if (value.of === 'steer') return
    switch (value.code) {
      case 'auth_expired':
        authExpired += 1
        if (authExpired > MAX_AUTH_EXPIRED) return fail(turnId, 'auth.session_expired', 'The session expired')
        // A reconnect refreshes the token; the pending question goes out again on the new socket.
        socket?.reconnect()
        return
      case 'duplicate_turn':
        // The server has the question already: follow it instead of asking again.
        if (pending?.message.message_id === turnId) forgetPending()
        attach(turnId, views.get(turnId)?.lastSeq ?? 0)
        return
      case 'turn_not_found':
      case 'conversation_mismatch':
      case 'invalid_message':
        if (value.of === 'cancel_turn') return
        return fail(turnId, value.of === 'user_message' ? 'agent.response_failed' : 'agent.response_interrupted', value.message ?? value.code)
      case 'not_asker':
      case 'no_pending_interaction':
        return
    }
  }

  const receive = (event: WireEvent): void => {
    if (!views.has(event.turn_id)) return
    if (event.type === 'CUSTOM' && event.name === 'rejected') return rejected(event)
    // Anything the server says of the question is its answer: the socket works.
    if (pending?.message.message_id === event.turn_id) forgetPending()
    if (event.type === 'RUN_STARTED') authExpired = 0
    silentDrops.delete(event.turn_id)
    const previous = views.get(event.turn_id)
    const next = foldTurnEvent(previous, event)
    if (next === previous) return
    if (next.gap && gapsAttached.get(next.turnId) !== next.lastSeq) {
      gapsAttached.set(next.turnId, next.lastSeq)
      attach(next.turnId, next.lastSeq)
    }
    if (next.phase !== 'running' && running === next.turnId) running = null
    publish(next)
  }

  const onStatus = (status: TurnSocketStatus): void => {
    socketOpen = status === 'open'
    if (status === 'open' && pending) sendPending()
    if (status === 'failed' || status === 'incompatible' || status === 'outdated') {
      if (running) fail(running, `connection.${status}`, 'The connection to Piloti gave up')
    }
  }

  const socketFor = (): TurnSocket => {
    socket ??= (options.createSocket ?? createTurnSocket)({
      conversationId,
      projectId: options.projectId ?? undefined,
      openTurns,
      refreshAuth: options.refreshAuth,
      onEvent: receive,
      onStatus,
      onSilent: (turnIds) => {
        // One silent socket is reopened by the socket itself; the second in a row ends the turn.
        for (const turnId of turnIds) {
          const drops = (silentDrops.get(turnId) ?? 0) + 1
          silentDrops.set(turnId, drops)
          if (drops < SILENT_DROPS_BEFORE_GIVING_UP) continue
          silentDrops.delete(turnId)
          fail(turnId, 'agent.response_interrupted', 'Piloti went silent')
        }
      },
    })
    return socket
  }

  const ensureConversation = (): Promise<void> => {
    if (options.conversationExists && !conversation) {
      conversation = Promise.resolve().then(() => options.onConversation?.())
    }
    conversation ??= (async () => {
      const response = await run(
        '/api/conversations',
        jsonInit({
          id: conversationId,
          title: options.title,
          projectId: options.projectId ?? null,
          subjectResourceType: 'document',
          subjectResourceId: options.documentId,
        })
      )
      if (!response.ok) throw new Error(`conversation ${response.status}`)
      options.onConversation?.()
    })().catch((error: unknown) => {
      conversation = null
      throw error
    })
    return conversation
  }

  /** The question as a row of the conversation, the way the chat stores its own. */
  const storeQuestion = async (turnId: string, text: string): Promise<void> => {
    const response = await run(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      jsonInit({ id: turnId, role: 'user', content: text, messageType: 'user' })
    )
    if (!response.ok) throw new Error(`message ${response.status}`)
  }

  return {
    conversationId,
    ensureConversation,
    ask: async (question, turnId) => {
      if (closed) throw new CanvasTurnError('closed')
      if (running) throw new CanvasTurnError('busy')
      running = turnId
      publish(initialTurnView(turnId, conversationId))
      try {
        await ensureConversation()
        await storeQuestion(turnId, question.text)
      } catch {
        return fail(turnId, 'canvas.not_stored', 'The question could not be stored')
      }
      if (closed || running !== turnId) return
      const message = canvasUserMessage(conversationId, options.documentId, turnId, question)
      pending = { message, timer: null, misses: 0 }
      awaitAck()
      const current = socketFor()
      if (!sendPending()) void current.connect()
    },
    cancel: (turnId) => {
      const view = views.get(turnId)
      const unasked = pending?.message.message_id === turnId
      if (unasked) forgetPending()
      if (running === turnId) running = null
      if (!view || view.phase !== 'running') return
      const stopped = stopTurnView(view, undefined)
      if (!unasked) {
        socket?.send({ type: 'cancel_turn', conversation_id: conversationId, turn_id: turnId, shown: stopped.shown })
      }
      publish(stopped.view)
    },
    steer: (text, steerOptions) => {
      const turnId = running
      if (!turnId || pending?.message.message_id === turnId || !socket?.accepts('steer')) return false
      const steerId = uuidv4()
      const region = steerOptions?.region
      steers.set(steerId, { turnId, text, onLeftover: steerOptions?.onLeftover })
      socket.send({
        type: 'steer',
        conversation_id: conversationId,
        turn_id: turnId,
        steer_id: steerId,
        text,
        ...(region ? { focus_region: clampFocusRegion(region) } : {}),
      })
      return true
    },
    close: () => {
      closed = true
      forgetPending()
      running = null
      socket?.close()
      socket = null
    },
  }
}
