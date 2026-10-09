/**
 * The chat socket, v2 (`docs/design/chat-wire-v2.md` §e.2): connect, send,
 * reconnect, and nothing that interprets a turn. Every frame is parsed by
 * `parseWireEvent` and handed on; `foldTurnEvent` is the only reader.
 *
 * - **Version, both ways.** The upgrade asks for `?v=2`, and close code 4426
 *   means this page is older than the server: `outdated`, and no reconnect.
 *   The other way round is the `hello`: the server's first frame says it
 *   speaks v2. Until it arrives the socket is not `open` and sends nothing. A
 *   socket that stays silent for {@link HELLO_TIMEOUT_MS}, or opens with
 *   anything else, reached a server that does not speak this wire (an agent
 *   rolled back to NAT's stock socket accepts the upgrade and ignores `?v=2`):
 *   the attempt failed, and when the ladder is spent the status is
 *   `incompatible`, not `failed`, because the network is fine.
 * - **Optional fields, by the hello.** The server reads what the client sends
 *   strictly: an unknown field refuses the message. A field added to a client
 *   message is therefore sent only to a server whose hello names it in
 *   `accepts` ({@link forServer}): during a rolling deploy the socket may have
 *   reached a pod one release older, and a Stop it refused would leave the
 *   turn running. The check is made on the socket that sends, so a message
 *   held across a reconnect is shaped for the server it finally reaches.
 * - **Drift.** After the hello, a frame this page cannot parse means the
 *   server speaks a newer v2 than this bundle: `outdated`, as for 4426. It is
 *   never dropped and waited past, because a turn whose next `seq` cannot be
 *   read can never fold another event, its terminal included. Additive drift
 *   (an unknown key; an unknown `type`, step `kind` or `CUSTOM` name) parses:
 *   `parseWireEvent` reads it, and the fold passes over what it does not know.
 * - **Resume.** On every reopen, each running turn is re-`attach`ed from the
 *   last seq its view folded; the server replays from there and continues live.
 *   The caller owns those cursors (`openTurns`), so there is one `lastSeq`.
 * - **Liveness.** While a turn runs, the server beats every `every_ms`. Three
 *   beats with no frame this page could read and the socket is dropped and
 *   reopened, and `onSilent` names the turns it was waiting on, so the caller
 *   can stop waiting on a turn that stays silent across reopens. A question not
 *   yet acknowledged (`RUN_STARTED`) is the caller's to watch (`openTurns`
 *   leaves it out); a turn waiting for its stages (`settled`) gets no beats.
 * - **Backoff.** `createRetryLadder`, with the auth refresh before each attempt:
 *   the handshake is the only point where the gateway reads the cookie. The
 *   hello is the evidence that starts the ladder over. `partysocket` was weighed
 *   for this (MIT, 210 KB, one polyfill) and not taken: the ladder is already
 *   ours, and its send queue would replay stale client messages that `attach`
 *   makes wrong.
 */

import { createRetryLadder, type RetryLadderOptions } from '@/shared/utils/backoff'
import { getWebSocketUrl } from './config'
import {
  CLOSE_CLIENT_OUTDATED,
  WIRE_VERSION,
  parseHello,
  parseWireEvent,
  type ClientMessage,
  type Hello,
  type WireEvent,
} from './wire-v2'

export type TurnSocketStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  /** The ladder is spent and the last attempt never reached a server. */
  | 'failed'
  /** The ladder is spent and the last attempt reached a server that does not speak wire v2. */
  | 'incompatible'
  /** The server speaks a newer wire than this page: 4426, or a frame this bundle cannot read. */
  | 'outdated'
  | 'closed'

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
  /** The watchdog dropped the socket: these running turns said nothing for three beats. */
  onSilent?: (turnIds: readonly string[]) => void
  /** Refresh the auth cookie before each attempt. A failure does not stop the attempt. */
  refreshAuth?: () => Promise<void>
  /** Default: 1 s doubling to 30 s, 12 attempts, which outlasts a rolling deploy of both tiers. */
  ladder?: RetryLadderOptions
}

export interface TurnSocket {
  /** Open, or keep open. After the ladder gave up, a new ladder: this is a new request. */
  connect: () => Promise<void>
  /** False when the socket is not open (no hello yet); nothing is queued. */
  send: (message: ClientMessage) => boolean
  /** Drop the current socket, if any, and open a fresh one now, from the first rung. */
  reconnect: () => void
  close: () => void
}

/**
 * How long a socket that opened may take to say hello. The server sends it
 * right after `accept()`, the version check and the token check, all in
 * process, so it is one round trip behind `onopen`; the gateway's scope lookup
 * happens before the upgrade completes and does not count. Five seconds is
 * many times that, and short enough that a server in another dialect costs one
 * rung of the ladder rather than a turn.
 */
export const HELLO_TIMEOUT_MS = 5_000

/**
 * `message` as the server whose hello said `accepts` can read it: an optional
 * field it does not name is left out, and the rest of the message still goes.
 * Without the field the server does what it did before it existed: a Stop
 * without `shown` keeps everything streamed so far.
 */
export const forServer = (message: ClientMessage, accepts: ReadonlySet<string>): ClientMessage => {
  if (message.type !== 'cancel_turn' || !message.shown || accepts.has('cancel_turn.shown')) return message
  const { shown: _unread, ...rest } = message
  return rest
}

/** The heartbeat interval assumed until the server states its own. */
const DEFAULT_BEAT_MS = 20_000
const DEAD_AFTER_BEATS = 3
const OPEN = 1

/** A frame as JSON, or `undefined` when it is not JSON at all. */
const jsonOf = (data: unknown): unknown => {
  try {
    return JSON.parse(String(data))
  } catch {
    return undefined
  }
}

const typeOf = (raw: unknown): string => {
  const record = raw !== null && typeof raw === 'object' ? (raw as { type?: unknown; name?: unknown }) : {}
  return [record.type, record.name].filter((part) => typeof part === 'string').join(':') || typeof raw
}

export function createTurnSocket(options: TurnSocketOptions): TurnSocket {
  const ladder = createRetryLadder(options.ladder ?? { baseMs: 1_000, maxMs: 30_000, budget: 12 })
  const warned = new Set<string>()
  let socket: WebSocket | null = null
  let opening: Promise<void> | null = null
  let stopped = true
  /** The current socket's server said hello: it speaks v2, and `send` may use it. */
  let ready = false
  /** The optional client fields the current socket's server named in its hello. */
  let accepts: ReadonlySet<string> = new Set()
  /** Why the last attempt failed, which names the status when the ladder is spent. */
  let lastFailure: 'failed' | 'incompatible' = 'failed'
  let everyMs = DEFAULT_BEAT_MS
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const status = (next: TurnSocketStatus): void => options.onStatus?.(next)

  /** Once per cause and frame type: a server in another dialect would otherwise fill the console. */
  const warnOnce = (what: string, raw?: unknown): void => {
    const detail = raw === undefined ? '' : typeOf(raw)
    const key = `${what}:${detail}`
    if (!warned.has(key)) console.warn(`[turn-socket] ${what}`, detail)
    warned.add(key)
  }

  const disarm = (): void => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }

  /** Detach and close the current socket without its close event starting anything. */
  const drop = (): void => {
    const current = socket
    socket = null
    ready = false
    accepts = new Set()
    disarm()
    if (!current) return
    current.onopen = current.onmessage = current.onclose = current.onerror = null
    current.close()
  }

  const retry = (): void => {
    status('reconnecting')
    if (!ladder.schedule(() => void open())) status(lastFailure)
  }

  /** The server does not speak this wire: this attempt failed, the next may reach another pod. */
  const incompatible = (): void => {
    lastFailure = 'incompatible'
    drop()
    retry()
  }

  /** The server speaks a newer wire than this page can read: reload, as for 4426. */
  const outdated = (): void => {
    drop()
    stopped = true
    status('outdated')
  }

  /** Time out a socket that opened and has not said hello. */
  const awaitHello = (): void => {
    disarm()
    watchdog = setTimeout(() => {
      watchdog = null
      warnOnce('no hello within the timeout')
      incompatible()
    }, HELLO_TIMEOUT_MS)
  }

  /** Watch the running turns: three beats with no frame and the socket is dead. */
  const arm = (): void => {
    disarm()
    watchdog = setTimeout(() => {
      watchdog = null
      const silent = options
        .openTurns()
        .filter((turn) => !turn.settled)
        .map((turn) => turn.turnId)
      if (silent.length === 0) return
      drop()
      options.onSilent?.(silent)
      retry()
    }, DEAD_AFTER_BEATS * everyMs)
  }

  const send = (message: ClientMessage): boolean => {
    if (!ready || socket?.readyState !== OPEN) return false
    socket.send(JSON.stringify(forServer(message, accepts)))
    return true
  }

  /** The hello: the server speaks v2. Now the socket is open, and every open turn is attached. */
  const greeted = (hello: Hello): void => {
    ready = true
    accepts = new Set(hello.value.accepts ?? [])
    ladder.reset()
    status('open')
    for (const turn of options.openTurns()) {
      send({ type: 'attach', conversation_id: options.conversationId, turn_id: turn.turnId, after_seq: turn.lastSeq })
    }
    arm()
  }

  const receive = (data: unknown): void => {
    const raw = jsonOf(data)
    if (!ready) {
      const hello = parseHello(raw)
      if (hello) return greeted(hello)
      warnOnce('opened with something other than a v2 hello', raw)
      return incompatible()
    }
    const event = parseWireEvent(raw)
    if (!event) {
      warnOnce('not a v2 event this page can read', raw)
      return outdated()
    }
    if (event.type === 'CUSTOM' && event.name === 'heartbeat') everyMs = event.value.every_ms
    arm()
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
    lastFailure = 'failed'
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => {
      if (socket === ws) awaitHello()
    }
    ws.onmessage = (message: MessageEvent) => {
      if (socket === ws) receive(message.data)
    }
    ws.onclose = (event: CloseEvent) => {
      if (socket !== ws) return
      socket = null
      ready = false
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
      if (ladder.spent) ladder.reset()
      return open()
    },
    send,
    reconnect: () => {
      stopped = false
      ladder.reset()
      drop()
      void open()
    },
    close: () => {
      stopped = true
      ladder.cancel()
      drop()
      status('closed')
    },
  }
}
