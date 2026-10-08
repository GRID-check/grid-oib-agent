/**
 * The chat socket's driver over the REAL socket client, against servers that
 * do not behave: the one the dev deploy rolled back to (NAT's stock socket,
 * which accepts the upgrade, ignores `?v=2`, never says hello and answers a
 * `user_message` with a frame of its own dialect), and a v2 server that says
 * hello and then never answers. In both the page used to show „Denkt nach…"
 * forever. Every one of these ends, visibly, on a clock.
 *
 * `use-websocket-chat.spec.ts` drives the driver through a mocked socket; this
 * file stubs only `WebSocket`, so the hello gate, the ladder and the driver's
 * deadlines run together.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HELLO_TIMEOUT_MS } from '@/adapters/api/turn-socket'

interface Sent {
  type: string
  message_id?: string
}

/** One server connection. `behave` decides what the server does. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static behave: (socket: FakeSocket) => void = () => undefined
  readyState = 0
  sent: Sent[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this)
    setTimeout(() => {
      if (this.closed) return
      this.readyState = 1
      this.onopen?.()
      FakeSocket.behave(this)
    }, 10)
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Sent
    this.sent.push(message)
    this.onSend?.(message)
  }

  onSend?: (message: Sent) => void

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Max' }, authRequired: false, isLoading: false }),
}))
vi.mock('@/i18n', () => ({ useTranslations: () => (key: string) => key, getActiveLocale: () => 'de' }))
vi.mock('@/shared/collaboration/thread-sharing', () => ({ useThreadSharing: () => 'private' }))
vi.mock('@/shared/hooks/use-backend-health', () => ({
  checkBackendHealthCached: vi.fn(async () => true),
  invalidateHealthCache: vi.fn(),
}))
vi.mock('@/features/layout/store', () => ({
  useLayoutStore: {
    getState: () => ({
      enabledDataSourceIds: [],
      availableDataSources: [],
      knowledgeLayerAvailable: false,
      activeSourcePreset: null,
      setEnabledDataSources: vi.fn(),
    }),
  },
}))
vi.mock('@/features/documents/discard-session-resources', () => ({ discardSessionDocumentsResources: vi.fn() }))
const client = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn().mockResolvedValue([]),
  createMessage: vi.fn().mockResolvedValue(undefined),
  updateMessageProvenance: vi.fn().mockResolvedValue(undefined),
  updateMessageStages: vi.fn().mockResolvedValue(undefined),
  updateMessagePromptState: vi.fn().mockResolvedValue(undefined),
  generateTitle: vi.fn().mockResolvedValue(undefined),
  newestFrameAge: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/adapters/api/conversations-client', () => ({ conversationsClient: client }))

import { useChatStore } from '../store'
import { ACK_TIMEOUT_MS, useWebSocketChat } from './use-websocket-chat'

const CONVERSATION = 's_servers'
const conversation = () => ({
  id: CONVERSATION,
  userId: 'user-1',
  title: '',
  messages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
})
const errorCodes = () =>
  (useChatStore.getState().currentConversation?.messages ?? []).flatMap((message) =>
    message.messageType === 'error' && message.errorData ? [message.errorData.errorCode] : []
  )
const HELLO = { v: 2, type: 'CUSTOM', name: 'hello', ts: 1, value: { build: 'abc1234' } }
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  // The gave-up explanation asks a same-origin endpoint; there is none here.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  useChatStore.setState({
    currentUserId: 'user-1',
    conversations: [conversation()],
    currentConversation: conversation(),
    turns: {},
    resumableTurn: null,
    isStreaming: false,
    isLoading: false,
    pendingInteraction: null,
    currentUserMessageId: null,
    composerDrafts: {},
    composerSubject: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ask = async () => {
  const hook = renderHook(() => useWebSocketChat())
  await tick(0)
  act(() => void hook.result.current.sendMessage('Was weißt du über die OIB 2?'))
  return hook
}

describe('a server that does not speak wire v2 (NAT stock socket)', () => {
  beforeEach(() => {
    // Silent on open; a user_message gets NAT's error frame back.
    FakeSocket.behave = (socket) => {
      socket.onSend = (message) =>
        socket.receive({ type: 'error_message', id: message.message_id, status: 'complete', content: { code: 'invalid_message' } })
    }
  })

  it('never puts the question on its socket, and ends it with an error card within two deadlines', async () => {
    await ask()
    expect(useChatStore.getState().isLoading).toBe(true)

    await tick(2 * ACK_TIMEOUT_MS)

    expect(FakeSocket.instances.flatMap((socket) => socket.sent)).toEqual([])
    expect(useChatStore.getState()).toMatchObject({ isLoading: false, isStreaming: false })
    await vi.waitFor(() => expect(errorCodes()).toContain('agent.response_failed'))
  })

  it('gives up saying the server is incompatible, not that the network failed', async () => {
    await ask()

    await tick(15 * 60_000)

    expect(errorCodes()).toContain('connection.server_incompatible')
    expect(errorCodes()).not.toContain('connection.failed')
    const opened = FakeSocket.instances.length
    await tick(15 * 60_000)
    expect(FakeSocket.instances.length).toBe(opened)
  })
})

describe('a v2 server that says hello and never answers', () => {
  beforeEach(() => {
    FakeSocket.behave = (socket) => socket.receive(HELLO)
  })

  it('asks on a fresh socket once, then ends the question with an error card', async () => {
    await ask()
    await tick(HELLO_TIMEOUT_MS)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(FakeSocket.instances[0]!.sent.map((message) => message.type)).toEqual(['user_message'])

    await tick(ACK_TIMEOUT_MS)
    expect(FakeSocket.instances[0]!.closed).toBe(true)
    expect(FakeSocket.instances.at(-1)!.sent.map((message) => message.type)).toEqual(['user_message'])

    await tick(ACK_TIMEOUT_MS)
    expect(useChatStore.getState()).toMatchObject({ isLoading: false, isStreaming: false })
    await vi.waitFor(() => expect(errorCodes()).toContain('agent.response_failed'))
  })

  it('ends a turn that started and then went silent, instead of reconnecting forever', async () => {
    await ask()
    await tick(HELLO_TIMEOUT_MS)
    const id = FakeSocket.instances[0]!.sent[0]!.message_id!
    act(() =>
      FakeSocket.instances[0]!.receive({
        v: 2,
        type: 'RUN_STARTED',
        conversation_id: CONVERSATION,
        turn_id: id,
        seq: 1,
        ts: 1,
        message_id: 'answer-1',
      })
    )
    expect(useChatStore.getState().isStreaming).toBe(true)

    await tick(10 * 60_000)

    expect(useChatStore.getState().isStreaming).toBe(false)
    await vi.waitFor(() => expect(errorCodes()).toContain('agent.response_interrupted'))
    expect(FakeSocket.instances.length).toBeLessThan(5)
  })
})
