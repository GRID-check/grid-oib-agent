/**
 * The chat socket, v2 (`docs/design/chat-wire-v2.md` §e.2): connect, send,
 * reconnect, and nothing that interprets a turn. Every frame is parsed by
 * `parseWireEvent` and handed on; `foldTurnEvent` is the only reader.
 *
 * - **Version.** The upgrade asks for `?v=2`. Close code 4426 means this page
 *   is older than the server: `outdated`, and no reconnect.
 * - **Resume.** On every reopen, each running turn is re-`attach`ed from the
 *   last seq its view folded; the server replays from there and continues live.
 *   The caller owns those cursors (`openTurns`), so there is one `lastSeq`.
 * - **Liveness.** While a turn runs, the server beats every `every_ms`. Three
 *   beats of silence and the socket is dropped and reopened. Before
 *   `RUN_STARTED` there is no turn to watch, so no silence counts, nor after
 *   the terminal: a turn waiting for its stages (`settled`) gets no beats.
 * - **Backoff.** `createRetryLadder`, with the auth refresh before each attempt:
 *   the handshake is the only point where the gateway reads the cookie.
 *   `partysocket` was weighed for this (MIT, 210 KB, one polyfill) and not
 *   taken: the ladder is already ours, and its send queue would replay stale
 *   client messages that `attach` makes wrong.
 */

import { createRetryLadder, type RetryLadderOptions } from '@/shared/utils/backoff'
import { getWebSocketUrl } from './config'
import { CLOSE_CLIENT_OUTDATED, WIRE_VERSION, parseWireEvent, type ClientMessage, type WireEvent } from './wire-v2'

export type TurnSocketStatus = 'connecting' | 'open' | 'reconnecting' | 'failed' | 'outdated' | 'closed'

/** A turn still running, and the last seq its view folded. */
export interface OpenTurn {
  turnId: string
  lastSeq: number
  /** Finished, waiting only for its post-answer stages: attached on reopen, never watched. */
  settled?: true
}

export interface TurnSocketOptions {
  conversationId: string
  projectId?: string
  /** Base URL; same-origin `/websocket` by default. */
  url?: string
  onEvent: (event: WireEvent) => void
  onStatus?: (status: TurnSocketStatus) => void
  /** The turns to attach on reopen, and the ones the watchdog guards. */
  openTurns: () => readonly OpenTurn[]
  /** Refresh the auth cookie before each attempt. A failure does not stop the attempt. */
  refreshAuth?: () => Promise<void>
  /** Default: 1 s doubling to 30 s, 12 attempts, which outlasts a rolling deploy of both tiers. */
  ladder?: RetryLadderOptions
}

export interface TurnSocket {
  connect: () => Promise<void>
  /** False when the socket is not open; nothing is queued. */
  send: (message: ClientMessage) => boolean
  close: () => void
}

/** The heartbeat interval assumed until the server states its own. */
const DEFAULT_BEAT_MS = 20_000
const DEAD_AFTER_BEATS = 3
const OPEN = 1

export function createTurnSocket(options: TurnSocketOptions): TurnSocket {
  const ladder = createRetryLadder(options.ladder ?? { baseMs: 1_000, maxMs: 30_000, budget: 12 })
  const warned = new Set<string>()
  let socket: WebSocket | null = null
  let opening: Promise<void> | null = null
  let stopped = true
  let everyMs = DEFAULT_BEAT_MS
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const status = (next: TurnSocketStatus): void => options.onStatus?.(next)

  const disarm = (): void => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }

  /** Detach and close the current socket without its close event starting anything. */
  const drop = (): void => {
    const current = socket
    socket = null
    disarm()
    if (!current) return
    current.onopen = current.onmessage = current.onclose = current.onerror = null
    current.close()
  }

  const retry = (): void => {
    status('reconnecting')
    if (!ladder.schedule(() => void open())) status('failed')
  }

  const arm = (): void => {
    disarm()
    watchdog = setTimeout(() => {
      watchdog = null
      if (options.openTurns().every((turn) => turn.settled)) return
      drop()
      retry()
    }, DEAD_AFTER_BEATS * everyMs)
  }

  const send = (message: ClientMessage): boolean => {
    if (socket?.readyState !== OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  const receive = (data: unknown): void => {
    let raw: unknown
    try {
      raw = JSON.parse(String(data))
    } catch {
      return
    }
    const event = parseWireEvent(raw)
    if (!event) {
      const type = String((raw as { type?: unknown } | null)?.type)
      if (!warned.has(type)) console.warn('[turn-socket] not a v2 event, dropped:', type)
      warned.add(type)
      return
    }
    if (event.type === 'CUSTOM' && event.name === 'heartbeat') everyMs = event.value.every_ms
    options.onEvent(event)
  }

  const urlOf = async (): Promise<string> => {
    const base = options.url ?? (await getWebSocketUrl())
    const params = new URLSearchParams({ v: String(WIRE_VERSION), conversationId: options.conversationId })
    if (options.projectId) params.set('projectId', options.projectId)
    return `${base}${base.includes('?') ? '&' : '?'}${params}`
  }

  const connectOnce = async (): Promise<void> => {
    status('connecting')
    await options.refreshAuth?.().catch(() => undefined)
    const url = await urlOf()
    if (stopped) return
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => {
      ladder.reset()
      status('open')
      for (const turn of options.openTurns()) {
        send({ type: 'attach', conversation_id: options.conversationId, turn_id: turn.turnId, after_seq: turn.lastSeq })
      }
      arm()
    }
    ws.onmessage = (message: MessageEvent) => {
      receive(message.data)
      if (socket === ws) arm()
    }
    ws.onclose = (event: CloseEvent) => {
      if (socket !== ws) return
      socket = null
      disarm()
      if (stopped) return
      if (event.code === CLOSE_CLIENT_OUTDATED) {
        stopped = true
        status('outdated')
        return
      }
      retry()
    }
  }

  const open = (): Promise<void> => {
    if (stopped || socket) return Promise.resolve()
    opening ??= connectOnce().finally(() => (opening = null))
    return opening
  }

  return {
    connect: () => {
      stopped = false
      return open()
    },
    send,
    close: () => {
      stopped = true
      ladder.cancel()
      drop()
      status('closed')
    },
  }
}
