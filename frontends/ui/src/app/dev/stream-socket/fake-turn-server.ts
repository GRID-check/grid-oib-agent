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
 * Only the chat socket (`…/websocket`) is faked; any other `WebSocket` (the
 * dev server's HMR) is the real one.
 */

import { CONVERSATION_PLACEHOLDER, TURN_PLACEHOLDER, type FrameKind, type TurnScript } from './turn-script'

export interface SocketProbeSink {
  onOpen: () => void
  onUserMessage: (at: number) => void
  onFrameHandled: (kind: FrameKind, sentAt: number, handledAt: number) => void
  onHeartbeat: () => void
}

/**
 * The worker: holds the frames, and once told the ids, posts each at its
 * time. Plain JS in a string, so it needs no bundler support for workers.
 */
const WORKER_SOURCE = `
let frames = []
const now = () => performance.timeOrigin + performance.now()
self.onmessage = (event) => {
  const message = event.data
  if (message.type === 'load') { frames = message.frames; return }
  if (message.type !== 'start') return
  const fill = (data) => data.split(${JSON.stringify(TURN_PLACEHOLDER)}).join(message.turnId)
    .split(${JSON.stringify(CONVERSATION_PLACEHOLDER)}).join(message.conversationId)
    .replace('"ts":0', '"ts":' + Math.round(now()))
  const started = now()
  let index = 0
  const tick = () => {
    const elapsed = now() - started
    while (index < frames.length && frames[index].at <= elapsed) {
      const frame = frames[index++]
      self.postMessage({ kind: frame.kind, sentAt: now(), data: fill(frame.data) })
    }
    if (index < frames.length) setTimeout(tick, Math.max(0, frames[index].at - (now() - started)))
    else self.postMessage({ kind: 'end', sentAt: now() })
  }
  tick()
}
`

interface WorkerFrame {
  kind: FrameKind | 'end'
  sentAt: number
  data?: string
}

/** Epoch milliseconds on the page's own `performance.now()` clock. */
const pageTime = (epoch: number): number => epoch - performance.timeOrigin

const OPEN = 1
const CLOSED = 3

/**
 * Install the fake server as `window.WebSocket`. Returns the uninstaller.
 * `onScriptEnd` fires once the worker has sent its last frame.
 */
export const installFakeTurnServer = (
  script: TurnScript,
  sink: SocketProbeSink,
  onScriptEnd: (lastSentAt: number) => void
): (() => void) => {
  const RealWebSocket = window.WebSocket
  const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
  // Loaded now, not at send: cloning megabytes of frames into the worker is
  // main-thread work that belongs to no turn.
  const worker = new Worker(workerUrl)
  worker.postMessage({ type: 'load', frames: script.frames })
  let started = false
  // The chat's socket: the latest one the client opened.
  const chat: { socket: FakeTurnSocket | null } = { socket: null }
  worker.onmessage = (event: MessageEvent<WorkerFrame>) => chat.socket?.receive(event.data)

  class FakeTurnSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = OPEN
    static readonly CLOSING = 2
    static readonly CLOSED = CLOSED

    readonly url: string
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
      const href = String(url)
      this.url = href
      // Not the chat socket: hand back a real one (the constructor's return value wins).
      if (!new URL(href, window.location.href).pathname.endsWith('/websocket')) {
        return new RealWebSocket(url, protocols) as unknown as FakeTurnSocket
      }
      chat.socket = this
      window.setTimeout(() => {
        this.readyState = OPEN
        this.onopen?.(new Event('open'))
        // The server's first frame, as `ChatSocket.serve` sends it: the client
        // sends nothing on a socket that has not said hello.
        this.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({ v: 2, type: 'CUSTOM', name: 'hello', ts: Date.now(), value: { build: 'dev' } }),
          })
        )
        sink.onOpen()
      }, 20)
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { type?: string; message_id?: string; conversation_id?: string }
      // One scripted turn per page load; `attach` and `cancel_turn` are not scripted.
      if (message.type !== 'user_message' || !message.message_id || started) return
      started = true
      sink.onUserMessage(performance.now())
      worker.postMessage({ type: 'start', turnId: message.message_id, conversationId: message.conversation_id ?? '' })
    }

    receive(frame: WorkerFrame): void {
      if (frame.kind === 'end') {
        onScriptEnd(pageTime(frame.sentAt))
        return
      }
      if (this.readyState !== OPEN || !frame.data) return
      this.onmessage?.(new MessageEvent('message', { data: frame.data }))
      if (frame.kind === 'heartbeat') {
        sink.onHeartbeat()
        return
      }
      sink.onFrameHandled(frame.kind, pageTime(frame.sentAt), performance.now())
    }

    close(): void {
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      this.onclose?.(new CloseEvent('close', { code: 1000, wasClean: true }))
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return true
    }
  }

  window.WebSocket = FakeTurnSocket as unknown as typeof WebSocket
  return () => {
    window.WebSocket = RealWebSocket
    worker.terminate()
    URL.revokeObjectURL(workerUrl)
  }
}
