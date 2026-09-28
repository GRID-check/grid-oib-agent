/**
 * @vitest-environment node
 */
/**
 * The v2 socket client (`chat-wire-v2.md` §e.2): it asks for v2 and opens
 * only on the server's hello, re-attaches every running turn on reopen, drops a
 * socket that went silent mid-turn, and stops for good on 4426 or a frame it
 * cannot read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frameOf } from '@/test-utils/wire-v2-fixtures'
import {
  HELLO_TIMEOUT_MS,
  createTurnSocket,
  type OpenTurn,
  type TurnSocketOptions,
  type TurnSocketStatus,
} from './turn-socket'
import type { WireEvent } from './wire-v2'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: unknown[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw))
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  /** Opened, and the server said hello: what `ChatSocket.serve` does. */
  greet(): void {
    this.open()
    this.receive(HELLO)
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const HELLO = { v: 2, type: 'CUSTOM', name: 'hello', ts: 1, value: { build: 'abc1234' } }

const latest = (): FakeSocket => {
  const socket = FakeSocket.instances.at(-1)
  if (!socket) throw new Error('no socket opened')
  return socket
}

const setup = (turns: OpenTurn[] = [], extra: Partial<TurnSocketOptions> = {}) => {
  const events: WireEvent[] = []
  const statuses: TurnSocketStatus[] = []
  const refreshAuth = vi.fn(async () => undefined)
  const socket = createTurnSocket({
    conversationId: 'conv_1',
    projectId: 'proj_1',
    url: 'ws://test/websocket',
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    openTurns: () => turns,
    refreshAuth,
    ladder: { delaysMs: [100, 100, 100] },
    ...extra,
  })
  return { socket, events, statuses, refreshAuth }
}

/** Let the connect's awaits (auth refresh, URL) settle. */
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('turn socket', () => {
  it('asks for v2 with the conversation and project, after refreshing auth', async () => {
    const { socket, refreshAuth } = setup()
    await socket.connect()
    expect(refreshAuth).toHaveBeenCalledOnce()
    const url = new URL(latest().url)
    expect(Object.fromEntries(url.searchParams)).toEqual({ v: '2', conversationId: 'conv_1', projectId: 'proj_1' })
  })

  it('hands on parsed v2 events once the server said hello', async () => {
    const { socket, events } = setup()
    await socket.connect()
    latest().greet()
    latest().receive(frameOf(1, { type: 'RUN_STARTED', message_id: 'a' }))
    expect(events.map((event) => event.type)).toEqual(['RUN_STARTED'])
  })

  it('reads a frame it cannot parse after the hello as a newer server: outdated, no reconnect', async () => {
    const { socket, events, statuses } = setup([{ turnId: 't1', lastSeq: 3 }])
    await socket.connect()
    latest().greet()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // A terminal with a code this bundle does not know: dropping it would leave the turn waiting forever.
    latest().receive(frameOf(4, { type: 'RUN_ERROR', code: 'budget_exhausted', message: 'x' }, 't1'))
    expect(events).toEqual([])
    expect(latest().closed).toBe(true)
    expect(statuses.at(-1)).toBe('outdated')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('never takes a frame it cannot read for life: not JSON ends the socket the same way', async () => {
    const onSilent = vi.fn()
    const { socket, statuses } = setup([{ turnId: 't1', lastSeq: 3 }], { onSilent })
    await socket.connect()
    latest().greet()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    latest().onmessage?.({ data: 'not json' })
    expect(latest().closed).toBe(true)
    expect(statuses.at(-1)).toBe('outdated')
    expect(onSilent).not.toHaveBeenCalled()
  })

  it('sends only while open, and queues nothing', async () => {
    const { socket } = setup()
    const cancel = { type: 'cancel_turn', conversation_id: 'conv_1', turn_id: 't1' } as const
    expect(socket.send(cancel)).toBe(false)
    await socket.connect()
    latest().greet()
    expect(socket.send(cancel)).toBe(true)
    expect(latest().sent).toEqual([cancel])
  })

  it('reconnects after a drop and attaches every running turn from its last seq', async () => {
    const { socket, statuses, refreshAuth } = setup([{ turnId: 't1', lastSeq: 7 }])
    await socket.connect()
    latest().greet()
    const first = latest()
    first.drop()
    expect(statuses.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(100)
    expect(latest()).not.toBe(first)
    expect(refreshAuth).toHaveBeenCalledTimes(2)
    latest().greet()
    expect(latest().sent).toEqual([{ type: 'attach', conversation_id: 'conv_1', turn_id: 't1', after_seq: 7 }])
    expect(statuses.at(-1)).toBe('open')
  })

  it('stops for good on 4426: the page is older than the server', async () => {
    const { socket, statuses } = setup()
    await socket.connect()
    latest().greet()
    latest().drop(4426)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(statuses.at(-1)).toBe('outdated')
  })

  it('fails once the ladder is spent', async () => {
    const { socket, statuses } = setup()
    await socket.connect()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      latest().drop()
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(statuses.at(-1)).toBe('failed')
    expect(FakeSocket.instances).toHaveLength(4)
  })

  it('drops a socket that stays silent for three beats while a turn runs, then re-attaches', async () => {
    const turns: OpenTurn[] = [{ turnId: 't1', lastSeq: 3 }]
    const { socket } = setup(turns)
    await socket.connect()
    latest().greet()
    latest().receive(frameOf(3, { type: 'CUSTOM', name: 'heartbeat', value: { every_ms: 1_000 } }, 't1'))
    const silent = latest()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(silent.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(silent.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    latest().greet()
    expect(latest().sent).toEqual([{ type: 'attach', conversation_id: 'conv_1', turn_id: 't1', after_seq: 3 }])
  })

  it('counts no silence while no turn runs: before RUN_STARTED, or after the terminal', async () => {
    const { socket } = setup([])
    await socket.connect()
    latest().greet()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(latest().closed).toBe(false)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('closes without reconnecting when the caller closes it', async () => {
    const { socket, statuses } = setup([{ turnId: 't1', lastSeq: 1 }])
    await socket.connect()
    latest().greet()
    socket.close()
    await settle()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(latest().closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(statuses.at(-1)).toBe('closed')
  })
})

describe('the hello', () => {
  it('sends nothing, attaches nothing and is not open until the server says hello', async () => {
    const { socket, statuses } = setup([{ turnId: 't1', lastSeq: 2 }])
    await socket.connect()
    latest().open()
    const cancel = { type: 'cancel_turn', conversation_id: 'conv_1', turn_id: 't1' } as const
    expect(socket.send(cancel)).toBe(false)
    expect(latest().sent).toEqual([])
    expect(statuses).not.toContain('open')

    latest().receive(HELLO)
    expect(statuses.at(-1)).toBe('open')
    expect(latest().sent).toEqual([{ type: 'attach', conversation_id: 'conv_1', turn_id: 't1', after_seq: 2 }])
    expect(socket.send(cancel)).toBe(true)
  })

  it('drops a socket that stays silent past the hello timeout, and tries again', async () => {
    const { socket, statuses } = setup()
    await socket.connect()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    latest().open()
    const silent = latest()
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS - 1)
    expect(silent.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(silent.closed).toBe(true)
    expect(statuses.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(100)
    expect(latest()).not.toBe(silent)
    latest().greet()
    expect(statuses.at(-1)).toBe('open')
  })

  it('takes anything else first as another dialect: the stock NAT socket answers with its own error frame', async () => {
    const { socket, events } = setup()
    await socket.connect()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    latest().open()
    const old = latest()
    old.receive({ type: 'error_message', id: 'x', status: 'complete', content: { code: 'invalid_message' } })
    expect(old.closed).toBe(true)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('refuses a hello in another version', async () => {
    const { socket, statuses } = setup()
    await socket.connect()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    latest().open()
    latest().receive({ ...HELLO, v: 3 })
    expect(latest().closed).toBe(true)
    expect(statuses.at(-1)).toBe('reconnecting')
  })

  it('ends incompatible, not failed, when every attempt reached a server without a hello', async () => {
    const { socket, statuses } = setup()
    await socket.connect()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      latest().open()
      await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS + 100)
    }
    expect(statuses.at(-1)).toBe('incompatible')
    expect(FakeSocket.instances).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(FakeSocket.instances).toHaveLength(4)
  })

  it('starts a new ladder when asked to connect after giving up', async () => {
    const { socket, statuses } = setup()
    await socket.connect()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      latest().drop()
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(statuses.at(-1)).toBe('failed')
    await socket.connect()
    expect(FakeSocket.instances).toHaveLength(5)
    latest().drop()
    expect(statuses.at(-1)).toBe('reconnecting')
  })
})

describe('reconnect', () => {
  it('drops the open socket and opens a fresh one at once, from the first rung', async () => {
    const { socket } = setup()
    await socket.connect()
    latest().greet()
    const first = latest()
    socket.reconnect()
    await settle()
    expect(first.closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})

describe('silence', () => {
  it('names the turns it was waiting on when it drops a silent socket', async () => {
    const onSilent = vi.fn()
    const { socket } = setup([{ turnId: 't1', lastSeq: 3 }, { turnId: 't0', lastSeq: 9, settled: true }], { onSilent })
    await socket.connect()
    latest().greet()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onSilent).toHaveBeenCalledWith(['t1'])
  })
})
