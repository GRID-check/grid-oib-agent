/**
 * A scripted v2 chat server behind a stubbed `window.WebSocket`, for
 * `/dev/stream-socket`.
 *
 * The frames are paced by a Web Worker, not by timers on the page. A real
 * socket's frames arrive whether or not the page's main thread is free, and
 * queue up behind a busy one; that queue is the backlog the harness measures.
 * Timers on the main thread would be delayed by the very work being measured,
 * and the server would slow down to match the client. The worker stamps each
 * frame with its send time on the shared epoch clock (`timeOrigin + now()`),
 * and the page records when the client's `onmessage` returned.
 *
 * Like the real one (`docs/api/websocket-protocol.md`), the server keeps every
 * frame of a turn it sent, and a turn runs on whether or not a socket follows
 * it. So it answers what a client sends after an interruption:
 *
 * - `user_message` starts the next scripted turn on the socket that asked; a
 *   resend of a question it already holds is ignored.
 * - `attach{turn_id, after_seq}` replays the turn's frames after `after_seq`
 *   to the asking socket, which then follows the turn live. After a reload the
 *   page names the turn it was in (`resume`): the server takes it up on its
 *   original clock, so the replay holds every frame sent while the page was
 *   gone. A turn it never heard of is `rejected{turn_not_found}`.
 * - `cancel_turn` stops the turn and ends it `cancelled`, as `ChatSocket` does:
 *   cut to `shown`, the text the reader had on screen, by the rule the agent
 *   tier applies (`stopped-answer.ts`), or with the text sent so far when the
 *   cancel names no position. The hello says it reads `shown`. A Stop of a
 *   turn that has already ended is `rejected{turn_not_found}`, as the real
 *   server answers a Stop that crossed its finished answer.
 *
 * `drop()` closes the chat socket the way a lost network does (code 1006),
 * and the client's own ladder reconnects and re-attaches.
 *
 * Only the chat socket (`…/websocket`) is faked; any other `WebSocket` (the
 * dev server's HMR) is the real one.
 */

import { parseWireEvent, type ShownAnswer, type WireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvents } from '@/features/chat/lib/turn-fold'
import { stoppedAnswer } from '@/features/chat/lib/stopped-answer'
import { CONVERSATION_PLACEHOLDER, TURN_PLACEHOLDER, type FrameKind, type TurnScript } from './turn-script'

export interface SocketProbeSink {
  onOpen: () => void
  /** A new question reached the server; `index` is its scripted turn. */
  onUserMessage: (at: number, index: number) => void
  onFrameHandled: (kind: FrameKind, sentAt: number, handledAt: number) => void
  onHeartbeat: () => void
  /** The server answered an `attach`, replaying `frames` frames. */
  onAttach?: (afterSeq: number, frames: number) => void
}

/** A turn the page was in when it reloaded: the server picks it up on its original clock. */
export interface ResumeTurn {
  index: number
  turnId: string
  conversationId: string
  /** Epoch ms the turn started at, on the server's clock. */
  startedAtEpoch: number
}

export interface FakeTurnServer {
  uninstall: () => void
  /** Close the chat socket as a lost network does. */
  drop: () => void
  /** The turn running now, for the page to resume after a reload. */
  running: () => ResumeTurn | null
}

/**
 * The worker: holds every turn's frames, and once told a turn's ids, posts
 * each of its frames at its time, from the turn's start epoch (in the past
 * after a reload, which sends the frames already due at once).
 * Plain JS in a string, so it needs no bundler support for workers.
 */
const WORKER_SOURCE = `
let turns = []
const timers = new Map()
const now = () => performance.timeOrigin + performance.now()
self.onmessage = (event) => {
  const message = event.data
  if (message.type === 'load') { turns = message.turns; return }
  if (message.type === 'stop') { clearTimeout(timers.get(message.index)); timers.set(message.index, -1); return }
  if (message.type !== 'start') return
  const frames = turns[message.index] || []
  const fill = (data) => data.split(${JSON.stringify(TURN_PLACEHOLDER)}).join(message.turnId)
    .split(${JSON.stringify(CONVERSATION_PLACEHOLDER)}).join(message.conversationId)
    .replace('"ts":0', '"ts":' + Math.round(now()))
  const started = message.startedAtEpoch
  let index = 0
  const tick = () => {
    if (timers.get(message.index) === -1) return
    const elapsed = now() - started
    while (index < frames.length && frames[index].at <= elapsed) {
      const frame = frames[index++]
      self.postMessage({ index: message.index, seq: index, kind: frame.kind, sentAt: now(), data: fill(frame.data) })
    }
    if (index < frames.length) timers.set(message.index, setTimeout(tick, Math.max(0, frames[index].at - (now() - started))))
    else self.postMessage({ index: message.index, kind: 'end', sentAt: now() })
  }
  tick()
}
`

interface WorkerFrame {
  index: number
  seq?: number
  kind: FrameKind | 'end'
  sentAt: number
  data?: string
}

interface LoggedFrame {
  seq: number
  kind: FrameKind
  data: string
}

interface ServerTurn extends ResumeTurn {
  log: LoggedFrame[]
  follower: FakeTurnSocket | null
  ended: boolean
}

/** Epoch milliseconds on the page's own `performance.now()` clock. */
const pageTime = (epoch: number): number => epoch - performance.timeOrigin
const epochNow = (): number => performance.timeOrigin + performance.now()

const OPEN = 1
const CLOSED = 3

/** The answer text a turn's log adds up to, as the fold reads it: deltas, reset by a retraction. */
const sentText = (log: readonly LoggedFrame[]): string => {
  let text = ''
  for (const { data } of log) {
    const frame = JSON.parse(data) as { type?: string; name?: string; delta?: string; snapshot?: { text?: string } }
    if (frame.type === 'TEXT_MESSAGE_CONTENT') text += frame.delta ?? ''
    if (frame.type === 'STATE_SNAPSHOT') text = frame.snapshot?.text ?? text
    if (frame.name === 'answer_retracted') text = ''
  }
  return text
}

/**
 * What a stopped turn keeps when the cancel said what was on screen: the
 * frames through `shown.seq` folded as the client folds them, cut to
 * `shown.chars` by the agent tier's rule (`TurnTextFold.stopped`).
 */
const stoppedResult = (log: readonly LoggedFrame[], shown: ShownAnswer, messageId: string): Record<string, unknown> => {
  const events = log
    .filter((frame) => frame.seq <= shown.seq)
    .map((frame) => parseWireEvent(JSON.parse(frame.data)))
    .filter((event): event is WireEvent => event !== null)
  const view = foldTurnEvents(undefined, events)
  if (!view) return { message_id: messageId, text: '' }
  const kept = stoppedAnswer(
    { text: view.text, settled: view.settled, sources: view.sources, cards: view.cards },
    shown.chars
  )
  return {
    message_id: messageId,
    text: kept.text,
    ...(kept.sources.length > 0 && { sources: kept.sources }),
    ...(kept.cards.length > 0 && { cards: kept.cards }),
    ...(view.answerMeta && { answer_meta: view.answerMeta }),
  }
}

/** Declared here so `ServerTurn` can name it; the class is built inside the installer. */
interface FakeTurnSocket {
  readonly conversationId: string
  readyState: number
  deliver: (data: string) => void
  drop: () => void
}

/**
 * Install the fake server as `window.WebSocket`. `onScriptEnd` fires once the
 * worker has sent the last frame of the last scripted turn.
 */
export const installFakeTurnServer = (
  script: TurnScript,
  sink: SocketProbeSink,
  onScriptEnd: (lastSentAt: number) => void,
  options: { resume?: ResumeTurn } = {}
): FakeTurnServer => {
  const RealWebSocket = window.WebSocket
  const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
  // Loaded now, not at send: cloning megabytes of frames into the worker is
  // main-thread work that belongs to no turn.
  const worker = new Worker(workerUrl)
  worker.postMessage({ type: 'load', turns: script.turns.map((turn) => turn.frames) })
  const turns: ServerTurn[] = []
  const sockets = new Set<FakeTurnSocket>()

  /** Hand one frame to the turn's follower, if it has one that is open. */
  const forward = (turn: ServerTurn, frame: LoggedFrame, sentAt: number): void => {
    const socket = turn.follower
    if (!socket || socket.readyState !== OPEN) return
    socket.deliver(frame.data)
    if (frame.kind === 'heartbeat') sink.onHeartbeat()
    else sink.onFrameHandled(frame.kind, sentAt, performance.now())
  }

  worker.onmessage = (event: MessageEvent<WorkerFrame>) => {
    const message = event.data
    const turn = turns[message.index]
    if (!turn || turn.ended) return
    if (message.kind === 'end') {
      turn.ended = true
      if (message.index === script.turns.length - 1) onScriptEnd(pageTime(message.sentAt))
      return
    }
    if (!message.data || message.seq === undefined) return
    const frame = { seq: message.seq, kind: message.kind, data: message.data }
    turn.log.push(frame)
    forward(turn, frame, pageTime(message.sentAt))
  }

  const start = (turn: ServerTurn): void => {
    turns[turn.index] = turn
    const { index, turnId, conversationId, startedAtEpoch } = turn
    worker.postMessage({ type: 'start', index, turnId, conversationId, startedAtEpoch })
  }

  /** Stop: no more scripted frames, and the cancelled terminal with what was shown, or else what was sent. */
  const cancel = (turn: ServerTurn, shown: ShownAnswer | undefined): void => {
    if (turn.ended) return
    worker.postMessage({ type: 'stop', index: turn.index })
    turn.ended = true
    const seq = turn.log.length + 1
    const terminal = {
      v: 2,
      conversation_id: turn.conversationId,
      turn_id: turn.turnId,
      seq,
      ts: Date.now(),
      type: 'RUN_FINISHED',
      outcome: 'cancelled',
      result: shown
        ? stoppedResult(turn.log, shown, messageIdOf(turn))
        : { message_id: messageIdOf(turn), text: sentText(turn.log) },
    }
    const frame = { seq, kind: 'terminal' as const, data: JSON.stringify(terminal) }
    turn.log.push(frame)
    forward(turn, frame, performance.now())
  }

  /** The answer id the turn's `RUN_STARTED` named. */
  const messageIdOf = (turn: ServerTurn): string => {
    const started = turn.log[0] && (JSON.parse(turn.log[0].data) as { message_id?: string })
    return started?.message_id ?? ''
  }

  class Socket implements FakeTurnSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = OPEN
    static readonly CLOSING = 2
    static readonly CLOSED = CLOSED

    readonly url: string
    readonly conversationId: string = ''
    readonly protocol = ''
    readonly extensions = ''
    binaryType: BinaryType = 'blob'
    bufferedAmount = 0
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null

    constructor(url: string | URL, protocols?: string | string[]) {
      const href = new URL(String(url), window.location.href)
      this.url = String(url)
      // Not the chat socket: hand back a real one (the constructor's return value wins).
      if (!href.pathname.endsWith('/websocket')) {
        return new RealWebSocket(url, protocols) as unknown as Socket
      }
      // One socket per conversation, as the real URL names it.
      this.conversationId = href.searchParams.get('conversationId') ?? ''
      sockets.add(this)
      window.setTimeout(() => {
        if (this.readyState === CLOSED) return
        this.readyState = OPEN
        this.onopen?.(new Event('open'))
        // The server's first frame, as `ChatSocket.serve` sends it: the client
        // sends nothing on a socket that has not said hello.
        this.deliver(
          JSON.stringify({
            v: 2,
            type: 'CUSTOM',
            name: 'hello',
            ts: Date.now(),
            value: { build: 'dev', accepts: ['cancel_turn.shown'] },
          })
        )
        sink.onOpen()
      }, 20)
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as {
        type?: string
        message_id?: string
        turn_id?: string
        after_seq?: number
        shown?: ShownAnswer
      }
      if (message.type === 'user_message') return this.ask(message.message_id)
      const turnId = message.turn_id ?? ''
      if (message.type === 'attach') return this.attach(turnId, message.after_seq ?? 0)
      if (message.type === 'cancel_turn') {
        const turn = turns.find((candidate) => candidate?.turnId === turnId)
        if (turn && !turn.ended) cancel(turn, message.shown)
        else this.reject('cancel_turn', turnId)
      }
    }

    private ask(messageId: string | undefined): void {
      // A resend of a question the server holds: it is already running.
      if (!messageId || turns.some((turn) => turn?.turnId === messageId)) return
      const index = turns.length
      if (index >= script.turns.length) return
      sink.onUserMessage(performance.now(), index)
      start({ index, turnId: messageId, conversationId: this.conversationId, startedAtEpoch: epochNow(), log: [], follower: this, ended: false })
    }

    private attach(turnId: string, afterSeq: number): void {
      const turn = turns.find((candidate) => candidate?.turnId === turnId)
      if (turn) {
        const replay = turn.log.filter((frame) => frame.seq > afterSeq)
        turn.follower = this
        sink.onAttach?.(afterSeq, replay.length)
        replay.forEach((frame) => forward(turn, frame, performance.now()))
        return
      }
      const resume = options.resume
      if (resume?.turnId === turnId) {
        // The turn the page reloaded out of: the worker sends what is already
        // due at once, which is the replay from seq 1.
        sink.onAttach?.(afterSeq, 0)
        start({ ...resume, log: [], follower: this, ended: false })
        return
      }
      this.reject('attach', turnId)
    }

    /** `rejected{turn_not_found}`: the server holds no running turn by that id. */
    private reject(of: 'attach' | 'cancel_turn', turnId: string): void {
      this.deliver(
        JSON.stringify({
          v: 2,
          conversation_id: this.conversationId,
          turn_id: turnId,
          seq: 0,
          ts: Date.now(),
          type: 'CUSTOM',
          name: 'rejected',
          value: { of, code: 'turn_not_found', message: null },
        })
      )
    }

    deliver(data: string): void {
      if (this.readyState === OPEN) this.onmessage?.(new MessageEvent('message', { data }))
    }

    /** The network went away: closed without a close frame. */
    drop(): void {
      this.shut(1006, false)
    }

    close(): void {
      this.shut(1000, true)
    }

    private shut(code: number, wasClean: boolean): void {
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      sockets.delete(this)
      for (const turn of turns) if (turn?.follower === this) turn.follower = null
      this.onclose?.(new CloseEvent('close', { code, wasClean }))
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return true
    }
  }

  window.WebSocket = Socket as unknown as typeof WebSocket
  return {
    uninstall: () => {
      window.WebSocket = RealWebSocket
      worker.terminate()
      URL.revokeObjectURL(workerUrl)
    },
    drop: () => [...sockets].forEach((socket) => socket.drop()),
    running: () => {
      const turn = turns.findLast((candidate) => candidate && !candidate.ended)
      return turn ? { index: turn.index, turnId: turn.turnId, conversationId: turn.conversationId, startedAtEpoch: turn.startedAtEpoch } : null
    },
  }
}
