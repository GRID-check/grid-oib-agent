/**
 * The turn-heartbeat frame, from the wire to the callback.
 *
 * The frame carries one fact — this turn is still running — and one number,
 * `every_ms`, which is the server's own stated cadence. That number is the
 * point: the client's tolerance is a multiple of it, so the backend can retune
 * `TURN_HEARTBEAT_SECONDS` without a matching edit here. Before this frame the
 * client held a copy of `DEFAULT_MAX_RUN_SECONDS` and waited it out, which is
 * two numbers in two languages with nothing keeping them in step.
 *
 * The shape asserted here is `websocket_reconnect.GridTurnHeartbeat`. Its
 * Python half is pinned by `test_websocket_reconnect.py::TestTurnHeartbeat`;
 * change either and change both.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NATWebSocketClient } from './websocket-client'
import { NATIncomingMessageSchema, NATTurnHeartbeatSchema } from './schemas'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readonly url: string
  readyState = MockWebSocket.OPEN
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send = vi.fn()
  close = vi.fn()
}

/** Exactly what `GridTurnHeartbeat.model_dump()` puts on the wire. */
const FRAME = {
  type: 'grid_turn_heartbeat',
  v: 1,
  conversation_id: 'conv-1',
  parent_id: 'msg-1',
  every_ms: 20000,
  timestamp: '2026-09-05T09:00:00+00:00',
}

const deliver = async (frame: unknown) => {
  const onTurnHeartbeat = vi.fn()
  const client = new NATWebSocketClient({
    conversationId: 'conv-1',
    websocketUrl: 'ws://localhost/websocket',
    callbacks: { onTurnHeartbeat },
  })
  await client.connect()
  const ws = MockWebSocket.instances[0]!
  ws.onopen?.(new Event('open'))
  ws.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  return onTurnHeartbeat
}

describe('the turn heartbeat on the wire', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  test('the backend frame parses as itself', () => {
    const parsed = NATTurnHeartbeatSchema.safeParse(FRAME)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  test('and is reachable through the incoming union', () => {
    // Parsing standalone is not the same fact as being dispatchable: a member
    // missing from the union leaves the frame to the warn-and-drop fallback
    // with the test above still green — and a dropped heartbeat is a turn the
    // client goes back to judging by a constant.
    expect(NATIncomingMessageSchema.safeParse(FRAME).success).toBe(true)
  })

  test('it reaches the callback carrying the cadence, and nothing else', async () => {
    const onTurnHeartbeat = await deliver(FRAME)

    expect(onTurnHeartbeat).toHaveBeenCalledTimes(1)
    expect(onTurnHeartbeat).toHaveBeenCalledWith(20000)
  })

  test('a heartbeat without a parent still counts', async () => {
    // `parent_id` is nullable on the model: a turn whose user-message id the
    // handler never saw is still a turn, and refusing its beats would put it
    // straight back on the fallback deadline.
    const { parent_id: _parentId, ...withoutParent } = FRAME
    expect(NATTurnHeartbeatSchema.safeParse(withoutParent).success).toBe(true)
    expect(await deliver({ ...withoutParent, parent_id: null })).toHaveBeenCalledWith(20000)
  })

  test('a cadence that is not a positive number is refused', async () => {
    // The client multiplies this to get a deadline. A zero or a negative would
    // produce a deadline already in the past and end every turn at the first
    // probe, so the frame is dropped rather than half-believed.
    for (const everyMs of [0, -1, 'soon']) {
      expect(NATTurnHeartbeatSchema.safeParse({ ...FRAME, every_ms: everyMs }).success).toBe(false)
    }
    expect(await deliver({ ...FRAME, every_ms: 0 })).not.toHaveBeenCalled()
  })
})
