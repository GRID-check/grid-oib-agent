/**
 * The chat socket's driver (docs/design/chat-wire-v2.md §e.2, §e.3), driven
 * through a mock socket that delivers the recorded v2 turns
 * (`shared/wire/v2/`) into the real store.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, WireEvent } from '@/adapters/api/wire-v2'
import type { TurnSocketOptions, TurnSocketStatus } from '@/adapters/api/turn-socket'
import { eventOf, wireEvents } from '@/test-utils/wire-v2-fixtures'

const sockets = vi.hoisted(() => [] as Array<{ options: TurnSocketOptions; sent: unknown[]; open: boolean; connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; reconnect: ReturnType<typeof vi.fn> }>)
vi.mock('@/adapters/api/turn-socket', () => ({
  createTurnSocket: (options: TurnSocketOptions) => {
    const socket = {
      options,
      sent: [] as unknown[],
      open: false,
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      reconnect: vi.fn(),
    }
    sockets.push(socket)
    return {
      connect: socket.connect,
      close: socket.close,
      reconnect: socket.reconnect,
      send: (message: unknown) => {
        if (!socket.open) return false
        socket.sent.push(message)
        return true
      },
    }
  },
}))
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
      enabledDataSourceIds: ['web_search'],
      availableDataSources: [],
      knowledgeLayerAvailable: false,
      activeSourcePreset: null,
      setEnabledDataSources: vi.fn(),
    }),
  },
}))
vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: vi.fn(),
}))
const runMessage = vi.hoisted(() => vi.fn())
vi.mock('../lib/commissioned-run', () => ({ fetchRunMessage: runMessage }))
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
import { ACK_TIMEOUT_MS, DELTA_FLUSH_MS, useWebSocketChat } from './use-websocket-chat'
import type { ChatMessage, Conversation } from '../types'

const conversationOf = (id: string, messages: ChatMessage[] = []): Conversation => ({
  id,
  userId: 'user-1',
  title: 'Fluchtweg',
  messages,
  createdAt: new Date('2026-09-25T09:00:00.000Z'),
  updatedAt: new Date('2026-09-25T09:00:00.000Z'),
})
const questionOf = (id: string): ChatMessage => ({
  id,
  role: 'user',
  content: 'Wie lang darf der Fluchtweg sein?',
  timestamp: new Date('2026-09-25T09:00:00.000Z'),
  messageType: 'user',
})

/** A recorded turn, as this conversation's turn `turnId`. */
const retarget = (events: WireEvent[], conversationId: string, turnId: string): WireEvent[] =>
  events.map((event) => ({ ...event, conversation_id: conversationId, turn_id: turnId }) as WireEvent)

const socket = () => sockets[sockets.length - 1]!
const status = (next: TurnSocketStatus) =>
  act(() => {
    socket().open = next === 'open'
    socket().options.onStatus?.(next)
  })
const deliver = (events: WireEvent[]) =>
  act(() => {
    for (const event of events) socket().options.onEvent(event)
  })
const sentOf = (type: ClientMessage['type']) =>
  socket().sent.filter((message) => (message as { type: string }).type === type) as Record<string, unknown>[]
const messages = () => useChatStore.getState().currentConversation!.messages

const open = (conversation: Conversation) => {
  useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
  const hook = renderHook(() => useWebSocketChat())
  status('open')
  return hook
}

/**
 * A socket open on `events`' conversation, and the turn of those events just
 * sent from it: its question in the thread, its view begun.
 */
const openTurn = (events: WireEvent[]) => {
  const { conversation_id: conversationId, turn_id: turnId } = events[0]!
  const hook = open(conversationOf(conversationId))
  act(() => {
    const conversation = conversationOf(conversationId, [questionOf(turnId)])
    useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
    useChatStore.getState().beginTurn(conversationId, turnId)
  })
  return hook
}

const answered = wireEvents('turn-answered.jsonl')
const CONVERSATION = answered[0]!.conversation_id

beforeEach(() => {
  vi.clearAllMocks()
  sockets.length = 0
  localStorage.clear()
  useChatStore.setState({
    currentUserId: 'user-1',
    conversations: [],
    currentConversation: null,
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
afterEach(() => vi.useRealTimers())

describe('a question', () => {
  it('goes out as a user_message whose id is the question, and again on every reopen until RUN_STARTED', () => {
    const { result } = open(conversationOf(CONVERSATION))

    act(() => void result.current.sendMessage('Wie lang darf der Fluchtweg sein?'))

    const question = messages().find((message) => message.messageType === 'user')!
    expect(sentOf('user_message')).toEqual([
      expect.objectContaining({ message_id: question.id, conversation_id: CONVERSATION, data_sources: ['web_search'] }),
    ])
    expect(useChatStore.getState()).toMatchObject({ isStreaming: true, isLoading: true })
    // Not acknowledged: not attached either, since the server may not have it.
    expect(socket().options.openTurns()).toEqual([])

    status('reconnecting')
    status('open')
    expect(sentOf('user_message')).toHaveLength(2)

    deliver(retarget(answered, CONVERSATION, question.id).slice(0, 1))
    expect(useChatStore.getState().isLoading).toBe(false)
    expect(socket().options.openTurns()).toEqual([{ turnId: question.id, lastSeq: 1 }])
    status('reconnecting')
    status('open')
    expect(sentOf('user_message')).toHaveLength(2)
  })

  it('is followed rather than asked again when the server already has it', () => {
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))
    const id = messages()[0]!.id

    deliver([eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: id, seq: 0, ts: 1, value: { of: 'user_message', code: 'duplicate_turn' } })])

    expect(sentOf('attach')).toEqual([{ type: 'attach', conversation_id: CONVERSATION, turn_id: id, after_seq: 0 }])
  })
})

describe('folding', () => {
  const TURN = answered[0]!.turn_id

  it('holds answer deltas for the flush, and flushes at once for anything else', () => {
    vi.useFakeTimers()
    openTurn(answered)

    deliver(answered.filter((event) => event.seq <= 13))
    const answerId = useChatStore.getState().turns[TURN]!.messageId!
    const bubble = () => messages().find((message) => message.id === answerId)
    expect(bubble()?.content ?? '').toBe('')
    act(() => void vi.advanceTimersByTime(DELTA_FLUSH_MS))
    expect(bubble()!.content).not.toBe('')

    deliver(answered.filter((event) => event.seq === 14 || event.seq === 15))
    // The card flushed the delta before it, without waiting.
    expect(bubble()!.cards?.[0]?.type).toBe('egress_diagram')
    expect(bubble()!.content).toBe(useChatStore.getState().turns[TURN]!.text)
  })

  it('attaches a gap from the last seq it folded, once', () => {
    openTurn(answered)

    deliver(answered.filter((event) => event.seq <= 3 || event.seq === 6 || event.seq === 7))

    expect(sentOf('attach')).toEqual([{ type: 'attach', conversation_id: CONVERSATION, turn_id: TURN, after_seq: 3 }])
  })

  it('keeps a finished turn attachable until its stages have landed', () => {
    openTurn(answered)

    deliver(answered.filter((event) => event.seq <= 20))
    expect(socket().options.openTurns()).toEqual([{ turnId: TURN, lastSeq: 20, settled: true }])

    deliver(answered.filter((event) => event.seq > 20))
    expect(socket().options.openTurns()).toEqual([])
  })
})

describe('reload mid-answer', () => {
  const TURN = answered[0]!.turn_id

  it('attaches the open question from its first event and rebuilds the answer from the replay', () => {
    const conversation = conversationOf(CONVERSATION, [questionOf(TURN)])
    useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
    useChatStore.getState().restoreSessionState(conversation)
    renderHook(() => useWebSocketChat())
    expect(sentOf('attach')).toEqual([])

    status('open')

    expect(sentOf('attach')).toEqual([{ type: 'attach', conversation_id: CONVERSATION, turn_id: TURN, after_seq: 0 }])
    expect(useChatStore.getState()).toMatchObject({ isStreaming: true, resumableTurn: null })

    deliver(answered)
    const result = answered.find((event) => event.type === 'RUN_FINISHED')!
    expect(messages().at(-1)).toMatchObject({
      id: result.type === 'RUN_FINISHED' ? result.result.message_id : '',
      content: result.type === 'RUN_FINISHED' ? result.result.text : '',
    })
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it('asks the server for the answer when the stream no longer holds the turn, and says so only when it has none', async () => {
    const conversation = conversationOf(CONVERSATION, [questionOf(TURN)])
    useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
    useChatStore.getState().restoreSessionState(conversation)
    renderHook(() => useWebSocketChat())
    status('open')

    deliver([eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: TURN, seq: 0, ts: 1, value: { of: 'attach', code: 'turn_not_found' } })])

    expect(useChatStore.getState().isStreaming).toBe(false)
    await vi.waitFor(() =>
      expect(messages().at(-1)).toMatchObject({ messageType: 'error', errorData: { errorCode: 'agent.response_interrupted' } })
    )
  })
})

describe('switching conversations mid-turn', () => {
  const TURN = answered[0]!.turn_id

  it('closes the socket with the conversation and re-attaches the turn from its last seq on return', () => {
    const { rerender } = openTurn(answered)
    deliver(answered.filter((event) => event.seq <= 9))
    const first = socket()
    const b = conversationOf('conv-b')
    useChatStore.setState({ conversations: [useChatStore.getState().currentConversation!, b] })

    act(() => useChatStore.getState().selectConversation(b.id))
    rerender()
    expect(first.close).toHaveBeenCalled()
    expect(socket().options.conversationId).toBe('conv-b')
    expect(useChatStore.getState().isStreaming).toBe(false)

    act(() => useChatStore.getState().selectConversation(CONVERSATION))
    rerender()
    expect(socket().options.conversationId).toBe(CONVERSATION)
    expect(socket().options.openTurns()).toEqual([{ turnId: TURN, lastSeq: 9 }])
    expect(useChatStore.getState().isStreaming).toBe(true)
  })
})

describe('Stop', () => {
  const cancelled = wireEvents('turn-cancelled.jsonl')
  const TURN = cancelled[0]!.turn_id
  const CANCELLED_CONVERSATION = cancelled[0]!.conversation_id

  it('sends cancel_turn and keeps the partial answer, marked stopped', () => {
    openTurn(cancelled)
    // The last delta is still waiting for its flush when Stop is pressed.
    deliver(cancelled.filter((event) => event.seq <= 4))

    act(() => useChatStore.getState().stopStreaming())

    expect(sentOf('cancel_turn')).toEqual([{ type: 'cancel_turn', conversation_id: CANCELLED_CONVERSATION, turn_id: TURN }])
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(messages().find((message) => message.messageType === 'agent_response')).toMatchObject({
      content: useChatStore.getState().turns[TURN]!.text,
      stopped: true,
    })

    deliver(cancelled.filter((event) => event.seq === 5))
    const answer = messages().find((message) => message.messageType === 'agent_response')!
    expect(answer).toMatchObject({ stopped: true })
    expect(answer.content).not.toBe('')
  })
})

describe('a question for the asker', () => {
  const hitl = wireEvents('turn-hitl-handoff.jsonl')
  const TURN = hitl[0]!.turn_id
  const HITL_CONVERSATION = hitl[0]!.conversation_id

  it("answers a choice with the option's id, and follows the run the turn hands off to", async () => {
    const { result } = openTurn(hitl)
    deliver(hitl.filter((event) => event.seq <= 4))
    expect(result.current.pendingInteraction).toEqual({ turnId: TURN, interactionId: 'ask_01J9Z6', input: 'choice' })

    act(() => result.current.respondToInteraction('1'))

    expect(sentOf('interaction_response')).toEqual([
      {
        type: 'interaction_response',
        conversation_id: HITL_CONVERSATION,
        turn_id: TURN,
        interaction_id: 'ask_01J9Z6',
        answer: { option_id: '1' },
      },
    ])
    expect(messages().find((message) => message.messageType === 'prompt')).toMatchObject({
      isPromptResponded: true,
      promptResponse: '1',
    })

    runMessage.mockResolvedValue(null)
    deliver(hitl.filter((event) => event.seq > 4))
    const finish = hitl.find((event) => event.type === 'RUN_FINISHED')!
    const runMessageId = finish.type === 'RUN_FINISHED' ? finish.result.run!.run_message_id : ''
    expect(runMessage).toHaveBeenCalledWith(HITL_CONVERSATION, runMessageId)
  })
})

describe('the socket', () => {
  it('asks for a reload when the server speaks a newer wire (4426)', () => {
    open(conversationOf(CONVERSATION))
    status('outdated')
    expect(messages().at(-1)).toMatchObject({ errorData: { errorCode: 'connection.client_outdated' } })
  })

  it('reconnects on auth_expired and sends the refused question again', () => {
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))
    const id = messages()[0]!.id

    deliver([eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: id, seq: 0, ts: 1, value: { of: 'user_message', code: 'auth_expired' } })])
    expect(socket().close).toHaveBeenCalled()
    expect(socket().connect).toHaveBeenCalledTimes(2)

    status('open')
    expect(sentOf('user_message').map((message) => message.message_id)).toEqual([id, id])
  })

  it('ends a failed turn with its banner once the server has no answer for it', async () => {
    const failed = wireEvents('turn-error.jsonl')
    const TURN = failed[0]!.turn_id
    openTurn(failed)

    deliver(failed)

    expect(useChatStore.getState().turns[TURN]).toBeUndefined()
    await vi.waitFor(() =>
      expect(messages().at(-1)).toMatchObject({ messageType: 'error', errorData: { errorCode: 'agent.workflow_error' } })
    )
  })
})

describe('nothing waits on silence', () => {
  const TURN = answered[0]!.turn_id
  const rejection = (turnId: string, of: string, code: string) =>
    eventOf({ v: 2, type: 'CUSTOM', name: 'rejected', conversation_id: CONVERSATION, turn_id: turnId, seq: 0, ts: 1, value: { of, code } })
  const lastError = () => messages().filter((message) => message.messageType === 'error').at(-1)

  it('ends a question the server never answers with an error the reader can retry, not a spinner', async () => {
    vi.useFakeTimers()
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Wie lang darf der Fluchtweg sein?'))
    expect(useChatStore.getState().isLoading).toBe(true)

    // First miss: the socket that did not answer is reopened, and the question goes out again.
    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS))
    expect(socket().reconnect).toHaveBeenCalledOnce()
    status('reconnecting')
    status('open')
    expect(sentOf('user_message')).toHaveLength(2)

    // Second miss: the turn ends, visibly.
    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS))
    expect(useChatStore.getState()).toMatchObject({ isLoading: false, isStreaming: false })
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'agent.response_failed' } }))

    // And it is not asked again behind the reader's back.
    status('reconnecting')
    status('open')
    expect(sentOf('user_message')).toHaveLength(2)
  })

  it('reopens nothing for a question the server acknowledged', () => {
    vi.useFakeTimers()
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))
    const id = messages()[0]!.id
    deliver(retarget(answered, CONVERSATION, id).slice(0, 1))

    act(() => void vi.advanceTimersByTime(10 * ACK_TIMEOUT_MS))

    expect(socket().reconnect).not.toHaveBeenCalled()
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(lastError()).toBeUndefined()
  })

  it('takes any answer as a sign the socket works: a refusal restarts the deadline', () => {
    vi.useFakeTimers()
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))
    const id = messages()[0]!.id

    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1))
    deliver([rejection(id, 'user_message', 'auth_expired')])
    act(() => void vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1))

    expect(socket().reconnect).not.toHaveBeenCalled()
  })

  it('opens a new socket for a question asked after the last one gave up', async () => {
    const { result } = open(conversationOf(CONVERSATION))
    status('failed')
    // The explanation is asynchronous; let it land here, not in the next test's thread.
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'connection.failed' } }))
    const connects = socket().connect.mock.calls.length

    act(() => void result.current.sendMessage('Noch einmal'))

    expect(socket().connect.mock.calls.length).toBe(connects + 1)
  })

  it('does not ask a question again that was stopped before the server acknowledged it', () => {
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))

    act(() => useChatStore.getState().stopStreaming())
    status('reconnecting')
    status('open')

    expect(sentOf('user_message')).toHaveLength(1)
    expect(sentOf('cancel_turn')).toHaveLength(1)
  })

  it('ends a running turn found silent on two sockets in a row, and asks the server first', async () => {
    openTurn(answered)
    deliver(answered.filter((event) => event.seq <= 3))

    act(() => socket().options.onSilent?.([TURN]))
    // Something of the turn in between: it lives, and the count starts over.
    deliver(answered.filter((event) => event.seq === 4))
    act(() => socket().options.onSilent?.([TURN]))
    expect(useChatStore.getState().isStreaming).toBe(true)

    act(() => socket().options.onSilent?.([TURN]))
    expect(useChatStore.getState().isStreaming).toBe(false)
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'agent.response_interrupted' } }))
  })

  it('ends a turn whose resume the server refused as invalid, like one it no longer holds', async () => {
    const conversation = conversationOf(CONVERSATION, [questionOf(TURN)])
    useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
    useChatStore.getState().restoreSessionState(conversation)
    renderHook(() => useWebSocketChat())
    status('open')

    deliver([rejection(TURN, 'attach', 'invalid_message')])

    expect(useChatStore.getState().isStreaming).toBe(false)
    await vi.waitFor(() => expect(lastError()).toMatchObject({ errorData: { errorCode: 'agent.response_interrupted' } }))
  })

  it('says the server is incompatible, not the network, and ends the turn that was waiting', async () => {
    const { result } = open(conversationOf(CONVERSATION))
    act(() => void result.current.sendMessage('Frage'))

    status('incompatible')

    expect(messages().some((message) => message.errorData?.errorCode === 'connection.server_incompatible')).toBe(true)
    expect(messages().some((message) => message.errorData?.errorCode === 'connection.failed')).toBe(false)
    expect(useChatStore.getState().isStreaming).toBe(false)
  })
})
