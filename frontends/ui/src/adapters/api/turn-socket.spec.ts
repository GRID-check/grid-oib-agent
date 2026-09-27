/**
 * @vitest-environment node
 */
/**
 * The v2 socket client (`chat-wire-v2.md` §e.2): it asks for v2, re-attaches
 * every running turn on reopen, drops a socket that went silent mid-turn, and
 * stops for good on 4426.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frameOf } from '@/test-utils/wire-v2-fixtures'
import { createTurnSocket, type OpenTurn, type TurnSocketStatus } from './turn-socket'
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

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const latest = (): FakeSocket => {
  const socket = FakeSocket.instances.at(-1)
  if (!socket) throw new Error('no socket opened')
  return socket
}

const setup = (turns: OpenTurn[] = []) => {
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

  it('hands on parsed v2 events and drops anything else', async () => {
    const { socket, events } = setup()
    await socket.connect()
    latest().open()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    latest().receive({ type: 'system_response_message', content: { text: 'alt' } })
    latest().receive(frameOf(1, { type: 'RUN_STARTED', message_id: 'a' }))
    expect(events.map((event) => event.type)).toEqual(['RUN_STARTED'])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('sends only while open, and queues nothing', async () => {
    const { socket } = setup()
    const cancel = { type: 'cancel_turn', conversation_id: 'conv_1', turn_id: 't1' } as const
    expect(socket.send(cancel)).toBe(false)
    await socket.connect()
    latest().open()
    expect(socket.send(cancel)).toBe(true)
    expect(latest().sent).toEqual([cancel])
  })

  it('reconnects after a drop and attaches every running turn from its last seq', async () => {
    const { socket, statuses, refreshAuth } = setup([{ turnId: 't1', lastSeq: 7 }])
    await socket.connect()
    latest().open()
    const first = latest()
    first.drop()
    expect(statuses.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(100)
    expect(latest()).not.toBe(first)
    expect(refreshAuth).toHaveBeenCalledTimes(2)
    latest().open()
    expect(latest().sent).toEqual([{ type: 'attach', conversation_id: 'conv_1', turn_id: 't1', after_seq: 7 }])
    expect(statuses.at(-1)).toBe('open')
  })

  it('stops for good on 4426: the page is older than the server', async () => {
    const { socket, statuses } = setup()
    await socket.connect()
    latest().open()
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
    latest().open()
    latest().receive(frameOf(3, { type: 'CUSTOM', name: 'heartbeat', value: { every_ms: 1_000 } }, 't1'))
    const silent = latest()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(silent.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(silent.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    latest().open()
    expect(latest().sent).toEqual([{ type: 'attach', conversation_id: 'conv_1', turn_id: 't1', after_seq: 3 }])
  })

  it('counts no silence while no turn runs: before RUN_STARTED, or after the terminal', async () => {
    const { socket } = setup([])
    await socket.connect()
    latest().open()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(latest().closed).toBe(false)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('closes without reconnecting when the caller closes it', async () => {
    const { socket, statuses } = setup([{ turnId: 't1', lastSeq: 1 }])
    await socket.connect()
    latest().open()
    socket.close()
    await settle()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(latest().closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(statuses.at(-1)).toBe('closed')
  })
})
