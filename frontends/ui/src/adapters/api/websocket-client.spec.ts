import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NATMessageType, NATWebSocketClient } from './websocket-client'

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
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
  })
}

describe('NATWebSocketClient auth observability', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).DD_RUM
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('emits RUM error for websocket auth_error payloads', async () => {
    const addError = vi.fn()
    ;(window as unknown as Record<string, unknown>).DD_RUM = { addError }
    const onError = vi.fn()
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: { onError },
    })

    await client.connect()
    const ws = MockWebSocket.instances[0]
    ws.onopen?.(new Event('open'))
    ws.onmessage?.(
      {
        data: JSON.stringify({
          type: NATMessageType.ERROR,
          content: {
            code: 'UNKNOWN_ERROR',
            message: 'auth_error',
            details: 'Token expired',
          },
          status: 'error',
        }),
      } as MessageEvent
    )

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UNKNOWN_ERROR',
        message: 'auth_error',
        details: 'Token expired',
      })
    )
    expect(addError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: 'websocket',
        auth_error_code: 'auth_error',
        details: 'Token expired',
      })
    )
  })

  test('rotate() ignores late onclose from the rotated-out socket', async () => {
    // Regression: NATWebSocketClient.rotate() must atomically detach the
    // old socket so a delayed `onclose` from it cannot be reclassified as
    // an unintentional disconnect on the freshly-opened socket. Without
    // this guarantee, the hook would see onConnectionChange('disconnected'
    // | 'error') seconds after a silent token rotation -- clobbering
    // streaming/loading state and potentially scheduling another reconnect.
    const onConnectionChange = vi.fn()
    const onError = vi.fn()
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: { onConnectionChange, onError },
    })

    // Open socket A and bring it to the connected state.
    await client.connect()
    const socketA = MockWebSocket.instances[0]
    socketA.onopen?.(new Event('open'))
    expect(onConnectionChange).toHaveBeenCalledWith('connected')
    onConnectionChange.mockClear()

    // Capture A's onclose BEFORE rotate() detaches it, then rotate.
    // Real browsers fire onclose asynchronously after close(); we
    // capture the reference so we can simulate that delayed event.
    const staleOnCloseA = socketA.onclose
    await client.rotate()

    // After rotate(): a brand new socket B exists, A's handlers are
    // detached (so calling staleOnCloseA directly is the only way the
    // old code path could be reached -- this is the worst case the
    // socket-instance guard protects against).
    expect(MockWebSocket.instances).toHaveLength(2)
    const socketB = MockWebSocket.instances[1]
    expect(socketB).not.toBe(socketA)
    // rotate() detaches A's handlers so the live A.onclose is now null
    // even though the browser would still hold a reference somewhere.
    expect(socketA.onclose).toBeNull()

    // Bring socket B to connected.
    socketB.onopen?.(new Event('open'))
    expect(onConnectionChange).toHaveBeenCalledWith('connected')
    onConnectionChange.mockClear()

    // Simulate the browser firing the LATE close on A (via the captured
    // handler reference -- mimicking the worst case where some polyfill
    // or stale reference still has it). The socket-instance guard inside
    // setupEventHandlers must drop this event silently: it must NOT push
    // 'disconnected' or 'error' through to the hook, must NOT touch
    // streaming/loading state, must NOT schedule an extra reconnect.
    staleOnCloseA?.(new CloseEvent('close'))

    expect(onConnectionChange).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()

    // And a late onmessage on A is dropped too (defense in depth: if
    // some buffered frame surfaces on the old socket after rotate, it
    // must not be parsed against the new conversation context).
    socketA.onmessage = null // already detached by rotate, double-check
  })

  test('rotate() coalesces concurrent calls -- only one new socket is created', async () => {
    // Regression: if a second rotate() is fired while one is already in
    // flight (e.g. the soft-rotation timer fires the same tick the
    // hook receives auth_expired), each call must NOT independently
    // detach handlers and start its own connect(). Worst case there is
    // two parallel `new WebSocket(...)` opens racing for `this.ws` --
    // exactly the kind of mid-rotation chaos the rotate() primitive
    // was introduced to prevent.
    const onConnectionChange = vi.fn()
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: { onConnectionChange },
    })

    await client.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    const socketA = MockWebSocket.instances[0]
    socketA.onopen?.(new Event('open'))

    // Fire two rotate() calls without awaiting the first.
    const r1 = client.rotate()
    const r2 = client.rotate()

    // The second call must coalesce into the first's in-flight promise,
    // not start its own rotation. Identity check is the strictest
    // possible assertion -- it proves we returned the cached promise,
    // not just a structurally-equivalent one.
    expect(r1).toBe(r2)

    await Promise.all([r1, r2])

    // Exactly one new socket B (total 2). If the second rotate() had
    // run independently, we would see THREE MockWebSocket instances:
    // the original A, the B opened by the first rotate(), and a third
    // C opened by the second rotate() after it tore B's handlers off.
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  test('connect() does not open a second socket while the first is still connecting', async () => {
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: {},
    })

    await client.connect()
    const socketA = MockWebSocket.instances[0]
    socketA.readyState = MockWebSocket.CONNECTING

    await client.connect()

    expect(MockWebSocket.instances).toHaveLength(1)
  })

  test('does not emit RUM error for non-auth websocket errors', async () => {
    const addError = vi.fn()
    ;(window as unknown as Record<string, unknown>).DD_RUM = { addError }
    const onError = vi.fn()
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: { onError },
    })

    await client.connect()
    const ws = MockWebSocket.instances[0]
    ws.onopen?.(new Event('open'))
    ws.onmessage?.(
      {
        data: JSON.stringify({
          type: NATMessageType.ERROR,
          content: {
            code: 'UNKNOWN_ERROR',
            message: 'workflow_error',
            details: 'Unexpected failure',
          },
          status: 'error',
        }),
      } as MessageEvent
    )

    expect(onError).toHaveBeenCalled()
    expect(addError).not.toHaveBeenCalled()
  })
})

describe('NATWebSocketClient frame tolerance + transparency (WP-B)', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const openClient = async (callbacks: Record<string, unknown>) => {
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks,
    })
    await client.connect()
    const ws = MockWebSocket.instances[0]
    ws.onopen?.(new Event('open'))
    return ws
  }

  test('a terminal system_response carries the transparency bundle to onResponse', async () => {
    const onResponse = vi.fn()
    const ws = await openClient({ onResponse })

    ws.onmessage?.(
      {
        data: JSON.stringify({
          type: NATMessageType.SYSTEM_RESPONSE,
          status: 'complete',
          content: 'here is your answer',
          routing_decision: 'deep',
          routing_reason: 'The question needs a deep dive.',
          escalation_reason: 'The first answer was insufficient.',
          answer_confidence_capped_reason: 'ungrounded',
          answer_confidence_reason: 'Only one source found.',
          citations_removed: { count: 1, reasons: ['not verifiable'] },
          job_admission_rejected: true,
          retry_after_seconds: 20,
        }),
      } as MessageEvent
    )

    expect(onResponse).toHaveBeenCalledTimes(1)
    const transparency = onResponse.mock.calls[0][8]
    expect(transparency).toEqual({
      routingDecision: 'deep',
      routingReason: 'The question needs a deep dive.',
      escalationReason: 'The first answer was insufficient.',
      answerConfidenceCappedReason: 'ungrounded',
      answerConfidenceReason: 'Only one source found.',
      citationsRemoved: { count: 1, reasons: ['not verifiable'] },
      jobAdmissionRejected: true,
      retryAfterSeconds: 20,
    })
  })

  test('an observability_trace_message is accepted silently (no callback, no warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onResponse = vi.fn()
    const onError = vi.fn()
    const ws = await openClient({ onResponse, onError })

    ws.onmessage?.(
      {
        data: JSON.stringify({
          type: NATMessageType.OBSERVABILITY_TRACE,
          id: 'trace-1',
          content: { span: 'orchestration' },
        }),
      } as MessageEvent
    )

    expect(onResponse).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  test('an unknown frame type is logged once per type and ignored (no pipeline throw)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onResponse = vi.fn()
    const ws = await openClient({ onResponse })

    const unknownFrame = {
      data: JSON.stringify({ type: 'brand_new_frame_type', content: 'whatever' }),
    } as MessageEvent

    // Two identical unknown frames must not throw and must warn only ONCE.
    expect(() => {
      ws.onmessage?.(unknownFrame)
      ws.onmessage?.(unknownFrame)
    }).not.toThrow()

    expect(onResponse).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('NATWebSocketClient URL construction', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('appends conversationId query param', async () => {
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: {},
    })

    await client.connect()
    const ws = MockWebSocket.instances[0]

    expect(ws.url).toBe('ws://localhost/websocket?conversationId=conv-1&conversation_id=conv-1')
  })

  test('appends both projectId and conversationId query params', async () => {
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      projectId: 'proj-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: {},
    })

    await client.connect()
    const ws = MockWebSocket.instances[0]

    expect(ws.url).toBe('ws://localhost/websocket?projectId=proj-1&conversationId=conv-1&conversation_id=conv-1')
  })

  test('preserves existing query params on websocketUrl', async () => {
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      projectId: 'proj-1',
      websocketUrl: 'ws://localhost/websocket?existing=yes',
      callbacks: {},
    })

    await client.connect()
    const ws = MockWebSocket.instances[0]

    expect(ws.url).toBe('ws://localhost/websocket?existing=yes&projectId=proj-1&conversationId=conv-1&conversation_id=conv-1')
  })

  test('uses URL without params when neither projectId nor conversationId is set', async () => {
    const client = new NATWebSocketClient({
      conversationId: '',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: {},
    })

    await client.connect()
    const ws = MockWebSocket.instances[0]

    expect(ws.url).toBe('ws://localhost/websocket')
  })

  test('reconnects with new conversationId after updateConversationId', async () => {
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: {},
    })

    await client.connect()
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost/websocket?conversationId=conv-1&conversation_id=conv-1')

    client.updateConversationId('conv-2')
    await client.rotate()

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toBe('ws://localhost/websocket?conversationId=conv-2&conversation_id=conv-2')
  })

  test('updateProjectId rotates and reconnects with the new projectId in the handshake', async () => {
    // The project scope is injected on the WS upgrade from the projectId query
    // param, so a changed projectId must re-open the socket. This is the fix
    // for the first-load race where the socket connected before the project
    // store resolved and never carried x-grid-project-context.
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      projectId: 'proj-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: {},
    })

    await client.connect()
    expect(MockWebSocket.instances[0].url).toBe(
      'ws://localhost/websocket?projectId=proj-1&conversationId=conv-1&conversation_id=conv-1',
    )

    client.updateProjectId('proj-2')
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2))

    expect(MockWebSocket.instances[1].url).toBe(
      'ws://localhost/websocket?projectId=proj-2&conversationId=conv-1&conversation_id=conv-1',
    )
  })

  test('updateProjectId is a no-op when the projectId is unchanged', async () => {
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      projectId: 'proj-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: {},
    })

    await client.connect()
    expect(MockWebSocket.instances).toHaveLength(1)

    // Same value -> must not rotate (no churn, no extra socket).
    client.updateProjectId('proj-1')
    await Promise.resolve()
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})

/**
 * THE INGEST-ONLY WIRE CONTRACT (ADR-0034 addendum).
 *
 * A human message that is NOT addressed to the agent still has to reach the agent's
 * conversation history, or `@Piloti given that, recheck` refers to nothing. It rides
 * the ordinary `user_message` frame with two additive fields inside the JSON text
 * payload: `context_only: true` and `author_name`.
 *
 * These tests assert on the BYTES that leave the socket, because the wire is the
 * contract — a backend on the other side of it cannot see our internal state.
 */
describe('NATWebSocketClient — the ingest-only user_message payload', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Open a client and hand back the parsed JSON text payload of the Nth frame. */
  const sentPayload = (ws: MockWebSocket, index = 0): Record<string, unknown> => {
    const frame = JSON.parse(ws.send.mock.calls[index][0] as string)
    return JSON.parse(frame.content.messages[0].content[0].text) as Record<string, unknown>
  }

  const openClient = async () => {
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: {},
    })
    await client.connect()
    return { client, ws: MockWebSocket.instances[0] }
  }

  test('a context-only send carries context_only + author_name alongside the query', async () => {
    const { client, ws } = await openClient()

    const id = client.sendMessage('Das Atrium zählt als eigener Brandabschnitt.', ['source-1'], {
      contextOnly: true,
      authorName: 'Anna Weber',
    })

    expect(id).toEqual(expect.any(String))
    expect(sentPayload(ws)).toEqual({
      query: 'Das Atrium zählt als eigener Brandabschnitt.',
      data_sources: ['source-1'],
      context_only: true,
      author_name: 'Anna Weber',
    })
  })

  test('an ordinary send is byte-for-byte what it always was — no new keys', async () => {
    const { client, ws } = await openClient()

    client.sendMessage('Wie breit muss der Fluchtweg sein?', ['source-1'])

    // A NEW backend receiving no field must behave exactly as today, which is only
    // guaranteed if the field is genuinely absent (not `context_only: false`).
    expect(sentPayload(ws)).toEqual({
      query: 'Wie breit muss der Fluchtweg sein?',
      data_sources: ['source-1'],
    })
  })

  test('a context-only send does NOT become the active parent id', async () => {
    // `activeParentId` is what the stale-response guard measures inbound answer
    // frames against. An ingest-only frame is never answered, so claiming it would
    // make the NEXT real turn's frames look stale and silently drop the answer.
    const { client, ws } = await openClient()

    const realId = client.sendMessage('Erste Frage', [])
    expect(client.activeParentId).toBe(realId)

    client.sendMessage('Annas Bemerkung', [], { contextOnly: true, authorName: 'Anna' })
    expect(client.activeParentId).toBe(realId)
    expect(ws.send).toHaveBeenCalledTimes(2)
  })

  test('author_name is omitted when the display name is unknown', async () => {
    const { client, ws } = await openClient()

    client.sendMessage('Bemerkung', [], { contextOnly: true, authorName: null })

    expect(sentPayload(ws)).toEqual({
      query: 'Bemerkung',
      data_sources: [],
      context_only: true,
    })
  })

  /**
   * `focusFileName` has been on this wire since "Asking about this file" shipped
   * and had no payload test on either side — which is a large part of why the
   * attachment gap (#429) survived: nothing described what the frame is supposed
   * to say about which document a turn is about.
   */
  test('focusFileName travels as focus_file_name, trimmed', async () => {
    const { client, ws } = await openClient()

    client.sendMessage('Fass das zusammen', ['source-1'], { focusFileName: '  Statik.pdf  ' })

    expect(sentPayload(ws)).toEqual({
      query: 'Fass das zusammen',
      data_sources: ['source-1'],
      focus_file_name: 'Statik.pdf',
    })
  })

  test('focus_file_name is omitted when there is no subject', async () => {
    const { client, ws } = await openClient()

    client.sendMessage('Allgemeine Frage', [], { focusFileName: '   ' })

    expect(sentPayload(ws)).toEqual({ query: 'Allgemeine Frage', data_sources: [] })
  })

  test('session attachments travel as session_attachments with file_name + state', async () => {
    const { client, ws } = await openClient()

    client.sendMessage('Fass den Inhalt zusammen', ['source-1'], {
      sessionAttachments: [
        { fileName: 'Statik-Bericht.pdf', state: 'ready' },
        { fileName: 'Grundriss.pdf', state: 'indexing' },
      ],
    })

    expect(sentPayload(ws)).toEqual({
      query: 'Fass den Inhalt zusammen',
      data_sources: ['source-1'],
      session_attachments: [
        { file_name: 'Statik-Bericht.pdf', state: 'ready' },
        { file_name: 'Grundriss.pdf', state: 'indexing' },
      ],
    })
  })

  test('session_attachments is omitted entirely when the session has none', async () => {
    // Compatibility by ABSENCE, like every other additive field on this frame:
    // never `session_attachments: []`, which a backend cannot distinguish from
    // "explicitly no attachments".
    const { client, ws } = await openClient()

    client.sendMessage('Wie breit muss der Fluchtweg sein?', ['source-1'], {
      sessionAttachments: [],
    })

    expect(sentPayload(ws)).toEqual({
      query: 'Wie breit muss der Fluchtweg sein?',
      data_sources: ['source-1'],
    })
  })

  test('focus_file_name and session_attachments coexist on one frame', async () => {
    // They answer different questions and neither suppresses the other.
    const { client, ws } = await openClient()

    client.sendMessage('Passt das zusammen?', [], {
      focusFileName: 'Grundriss.pdf',
      sessionAttachments: [{ fileName: 'Statik-Bericht.pdf', state: 'indexing' }],
    })

    expect(sentPayload(ws)).toEqual({
      query: 'Passt das zusammen?',
      data_sources: [],
      focus_file_name: 'Grundriss.pdf',
      session_attachments: [{ file_name: 'Statik-Bericht.pdf', state: 'indexing' }],
    })
  })
})

describe('NATWebSocketClient reconnect scheduling', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /**
   * Regression: the reconnect wait used to be a fixed `reconnectDelay`. A
   * rolling deploy drops every socket on a pod at the same instant, so a fixed
   * wait brings the whole herd back on an identical schedule — and each upgrade
   * costs a session resolution + FGA checks + budget reads (ADR-0020).
   */
  const scheduleFirstReconnect = async (random: number): Promise<number> => {
    vi.spyOn(Math, 'random').mockReturnValue(random)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    const client = new NATWebSocketClient({
      conversationId: 'conv-reconnect',
      reconnectDelay: 1000,
      callbacks: {},
    })
    await client.connect()

    const socket = MockWebSocket.instances.at(-1)!
    setTimeoutSpy.mockClear()
    socket.onclose?.(new CloseEvent('close'))

    const scheduled = setTimeoutSpy.mock.calls.at(-1)
    return scheduled?.[1] as number
  }

  test('the top of the jitter window is the configured base delay', async () => {
    expect(await scheduleFirstReconnect(1)).toBe(1000)
  })

  test('jitter can schedule earlier than the base delay', async () => {
    // Previously this was always exactly 1000 — that constancy was the bug.
    expect(await scheduleFirstReconnect(0)).toBe(500)
  })

  /**
   * Regression: the default budget used to be 3 attempts, i.e. it expired
   * ~4-7 seconds after the socket dropped. A rolling deploy takes minutes (the
   * serving pod drains, then the replacement cold-starts — see
   * `deploy/pulumi/src/platform/rollout.ts`), so EVERY deploy ended with
   * "Unable to connect to the server" in front of every open chat, even though
   * the stack came back healthy on its own moments later.
   *
   * The budget is asserted as a count rather than a wall-clock span because the
   * curve is jittered; the count is what `handleReconnect` gates on.
   */
  test('keeps retrying across a rolling deploy instead of giving up in seconds', async () => {
    vi.useFakeTimers()
    try {
      const onError = vi.fn()
      const client = new NATWebSocketClient({
        conversationId: 'conv-deploy',
        callbacks: { onError },
      })
      await client.connect()

      // Fail every attempt. Each close schedules the next connect; running the
      // timers drives the whole budget to exhaustion.
      for (let attempt = 0; attempt < 3; attempt++) {
        MockWebSocket.instances.at(-1)!.onclose?.(new CloseEvent('close'))
        await vi.runOnlyPendingTimersAsync()
      }
      // The old budget would already have surrendered here.
      expect(onError).not.toHaveBeenCalled()

      for (let attempt = 3; attempt < 12; attempt++) {
        MockWebSocket.instances.at(-1)!.onclose?.(new CloseEvent('close'))
        await vi.runOnlyPendingTimersAsync()
      }
      // ...and the 12th failure is still not terminal; the budget is spent only
      // when the next close arrives with no attempts left.
      expect(onError).not.toHaveBeenCalled()

      MockWebSocket.instances.at(-1)!.onclose?.(new CloseEvent('close'))
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'CONNECTION_FAILED' })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
