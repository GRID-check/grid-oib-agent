/**
 * A scripted v2 chat server behind a stubbed `window.WebSocket`, and the API
 * routes the scenario touches, for `/dev/turn-outcomes`.
 *
 * Unlike `/dev/stream-socket`'s server this one answers the client: an
 * `interaction_response` plays the scenario's continuation, a `cancel_turn`
 * drops what was still to come and sends the cancelled terminal with the text
 * sent so far. Timers run on the page: nothing here is measured, so the
 * worker that keeps that harness honest under load is not needed.
 *
 * Only the chat socket (`…/websocket`) is faked; any other `WebSocket` (the
 * dev server's HMR) is the real one.
 */

import { PROJECT_ID, storedRunMessage, type Scenario, type TimedBody } from './scenarios'

const OPEN = 1
const CLOSED = 3

/** What the page wants to know about the turn. */
export interface SocketSink {
  onOpen: () => void
  onBody: (body: Record<string, unknown>) => void
}

/** Install the fake server. Returns the uninstaller. */
export const installFakeSocket = (scenario: Scenario, sink: SocketSink): (() => void) => {
  const RealWebSocket = window.WebSocket
  const timers = new Set<number>()
  const chat: { socket: FakeSocket | null } = { socket: null }
  const turn = { id: '', conversationId: '', seq: 0, sentText: '', started: false }

  const send = (body: Record<string, unknown>): void => {
    if (body.type === 'TEXT_MESSAGE_CONTENT') turn.sentText += String(body.delta ?? '')
    if (body.name === 'answer_retracted') turn.sentText = ''
    turn.seq += 1
    const frame = {
      v: 2,
      conversation_id: turn.conversationId,
      turn_id: turn.id,
      seq: turn.seq,
      ts: Date.now(),
      ...body,
    }
    chat.socket?.deliver(JSON.stringify(frame))
    sink.onBody(body)
  }

  const play = (bodies: TimedBody[]): void => {
    for (const { at, body } of bodies) {
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        send(body)
      }, at)
      timers.add(timer)
    }
  }

  const stopAll = (): void => {
    timers.forEach((timer) => window.clearTimeout(timer))
    timers.clear()
  }

  class FakeSocket {
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
        return new RealWebSocket(url, protocols) as unknown as FakeSocket
      }
      chat.socket = this
      window.setTimeout(() => {
        this.readyState = OPEN
        this.onopen?.(new Event('open'))
        // `ChatSocket.serve` says hello first; the client sends nothing before it.
        this.deliver(
          JSON.stringify({
            v: 2,
            type: 'CUSTOM',
            name: 'hello',
            ts: Date.now(),
            value: { build: 'dev' },
          })
        )
        sink.onOpen()
      }, 20)
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as {
        type?: string
        message_id?: string
        conversation_id?: string
      }
      if (message.type === 'user_message' && message.message_id && !turn.started) {
        turn.started = true
        turn.id = message.message_id
        turn.conversationId = message.conversation_id ?? ''
        play(scenario.script)
      } else if (message.type === 'interaction_response' && scenario.afterAnswer) {
        play(scenario.afterAnswer)
      } else if (message.type === 'cancel_turn' && scenario.afterCancel) {
        stopAll()
        play(scenario.afterCancel(turn.sentText))
      }
    }

    deliver(data: string): void {
      if (this.readyState === OPEN) this.onmessage?.(new MessageEvent('message', { data }))
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

  window.WebSocket = FakeSocket as unknown as typeof WebSocket
  return () => {
    stopAll()
    window.WebSocket = RealWebSocket
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const later = <T>(ms: number, value: () => T): Promise<T> =>
  new Promise((resolve) => window.setTimeout(() => resolve(value()), ms))

/**
 * The routes a scenario reaches, answered here; every other `/api/` route
 * answers at once and empty, as on `/dev/stream-socket`.
 *
 * - `GET …/messages`: the run's stored message, after the scenario's delay —
 *   the read `fetchRunMessage` makes after a hand-off.
 * - `GET`/`POST /api/projects/…/folders`: the project's one folder, and a slow
 *   create, so the proposal card's busy state can be seen.
 */
export const stubApi = (scenario: Scenario): (() => void) => {
  const realFetch = window.fetch
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? String(input) : input.url,
      window.location.href
    )
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/'))
      return realFetch(input, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    if (
      method === 'GET' &&
      /^\/api\/conversations\/[^/]+\/messages$/.test(path) &&
      scenario.runMessageAfterMs !== undefined
    ) {
      return later(scenario.runMessageAfterMs, () =>
        json([storedRunMessage(scenario.question, new Date())])
      )
    }
    if (path === `/api/projects/${PROJECT_ID}/folders`) {
      if (method === 'GET')
        return Promise.resolve(
          json({
            folders: [
              { id: 'f-einreichung', name: 'Einreichung', path: 'Einreichung', parentId: null },
            ],
          })
        )
      return later(700, () =>
        json({ folder: { id: `f-${Math.random().toString(36).slice(2)}` } }, 201)
      )
    }
    return Promise.resolve(json(method === 'GET' ? [] : {}))
  }
  return () => {
    window.fetch = realFetch
  }
}
