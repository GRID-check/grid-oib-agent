/**
 * The store holds a turn (docs/design/chat-wire-v2.md §e.3): the recorded v2
 * turns (`shared/wire/v2/`) folded through `applyTurnEvents`, and what the
 * thread shows and persists for each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WireEvent } from '@/adapters/api/wire-v2'
import { wireEvents } from '@/test-utils/wire-v2-fixtures'

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: {
    getState: () => ({ enabledDataSourceIds: [], availableDataSources: [], setEnabledDataSources: vi.fn() }),
  },
}))
vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: vi.fn(),
}))
const client = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn().mockResolvedValue([]),
  createMessage: vi.fn().mockResolvedValue(undefined),
  updateMessageProvenance: vi.fn().mockResolvedValue(undefined),
  updateMessageStages: vi.fn().mockResolvedValue(undefined),
  generateTitle: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/adapters/api/conversations-client', () => ({ conversationsClient: client }))

import { useChatStore } from '../store'
import { registerStopStreamingHandler } from './messages-store'
import type { ChatMessage, Conversation } from '../types'

const answered = wireEvents('turn-answered.jsonl')
const TURN = answered[0]!.turn_id
const CONVERSATION = answered[0]!.conversation_id
const finished = answered.find((event) => event.type === 'RUN_FINISHED')!
const RESULT = finished.type === 'RUN_FINISHED' ? finished.result : undefined!

const upTo = (events: WireEvent[], seq: number) => events.filter((event) => event.seq <= seq)
const from = (events: WireEvent[], seq: number) => events.filter((event) => event.seq >= seq)

/** Open `events`' conversation with the question its turn answers, and start folding the turn. */
const ask = (events: WireEvent[]): { turnId: string; conversationId: string } => {
  const { turn_id: turnId, conversation_id: conversationId } = events[0]!
  const question: ChatMessage = {
    id: turnId,
    role: 'user',
    content: 'Wie lang darf der Fluchtweg sein?',
    timestamp: new Date('2026-09-25T09:00:00.000Z'),
    messageType: 'user',
  }
  const conversation: Conversation = {
    id: conversationId,
    userId: 'user-1',
    title: 'Fluchtweg',
    messages: [question],
    createdAt: new Date('2026-09-25T09:00:00.000Z'),
    updatedAt: new Date('2026-09-25T09:00:00.000Z'),
  }
  useChatStore.setState({ conversations: [conversation], currentConversation: conversation })
  useChatStore.getState().beginTurn(conversationId, turnId)
  return { turnId, conversationId }
}

const messages = () => useChatStore.getState().currentConversation!.messages
const answerOf = (id: string) => messages().find((message) => message.id === id)
const questionOf = (id: string) => messages().find((message) => message.id === id)!

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useChatStore.setState({
    currentUserId: 'user-1',
    conversations: [],
    currentConversation: null,
    turns: {},
    isStreaming: false,
    isLoading: false,
    pendingInteraction: null,
    currentUserMessageId: null,
    currentTurnStartedAt: null,
    composerDrafts: {},
  })
})
afterEach(() => registerStopStreamingHandler(null))

describe('a turn folded into its thread', () => {
  it('is loading until RUN_STARTED acknowledges the question, then streaming', () => {
    ask(answered)
    expect(useChatStore.getState()).toMatchObject({ isStreaming: true, isLoading: true })

    useChatStore.getState().applyTurnEvents(upTo(answered, 1))

    expect(useChatStore.getState()).toMatchObject({ isStreaming: true, isLoading: false })
    // Nothing to draw yet: no empty bubble in place of the typing cue.
    expect(messages()).toHaveLength(1)
  })

  it('draws the steps on the question and the prose, masthead and cards on the answer as they arrive', () => {
    ask(answered)
    useChatStore.getState().applyTurnEvents(upTo(answered, 15))

    const view = useChatStore.getState().turns[TURN]!
    expect(questionOf(TURN).thinkingSteps).toEqual(view.stepOrder.map((id) => view.steps[id]))
    const answer = answerOf(RESULT.message_id)!
    expect(answer).toMatchObject({ messageType: 'agent_response', isStreaming: true, content: view.text })
    expect(answer.answerMeta).toBeDefined()
    expect(answer.cards?.[0]?.type).toBe('egress_diagram')
  })

  it('keeps a card and an untouched step the same objects across flushes', () => {
    ask(answered)
    useChatStore.getState().applyTurnEvents(upTo(answered, 15))
    const card = answerOf(RESULT.message_id)!.cards![0]
    const step = questionOf(TURN).thinkingSteps![0]

    useChatStore.getState().applyTurnEvents(from(upTo(answered, 17), 16))

    expect(answerOf(RESULT.message_id)!.cards![0]).toBe(card)
    expect(questionOf(TURN).thinkingSteps![0]).toBe(step)
  })

  it('settles on the terminal result, persists the answer and the Herleitung, and lands its stages', async () => {
    ask(answered)
    useChatStore.getState().applyTurnEvents(answered)

    const answer = answerOf(RESULT.message_id)!
    expect(answer.isStreaming).toBeUndefined()
    expect(answer.content).toBe(RESULT.text)
    expect(answer.answerConfidence).toBe('high')
    expect(answer.citations).toHaveLength(RESULT.sources!.length)
    expect(answer.cards).toHaveLength(1)
    expect(answer.stages?.followUps).toBeDefined()
    expect(useChatStore.getState()).toMatchObject({ isStreaming: false, isLoading: false })

    await vi.waitFor(() => expect(client.createMessage).toHaveBeenCalled())
    expect(client.createMessage.mock.calls.map(([, message]) => message.id)).toContain(RESULT.message_id)
    await vi.waitFor(() =>
      expect(client.updateMessageProvenance).toHaveBeenCalledWith(
        CONVERSATION,
        TURN,
        expect.objectContaining({ thinkingSteps: questionOf(TURN).thinkingSteps })
      )
    )
    await vi.waitFor(() => expect(client.updateMessageStages).toHaveBeenCalled())
    expect(client.updateMessageStages).toHaveBeenCalledWith(
      CONVERSATION,
      RESULT.message_id,
      expect.objectContaining({ followUps: expect.anything() })
    )
  })

  it('stamps how long the turn took when this page sent the question', () => {
    ask(answered)
    useChatStore.setState({ currentTurnStartedAt: Date.now() - 4_000 })
    useChatStore.getState().applyTurnEvents(upTo(answered, 20))
    expect(answerOf(RESULT.message_id)!.answerDurationMs).toBeGreaterThanOrEqual(4_000)
  })

  it('stores the follow-ups but does not draw them under a reader who is typing', async () => {
    ask(answered)
    useChatStore.setState({ composerDrafts: { [CONVERSATION]: 'Und bei GK 5?' } })
    useChatStore.getState().applyTurnEvents(answered)

    expect(answerOf(RESULT.message_id)!.stages?.followUps).toBeUndefined()
    // Mirrored all the same: the refusal guards the reader's scroll, not the record.
    await vi.waitFor(() => expect(client.updateMessageStages).toHaveBeenCalled())
  })

  it('takes back a retracted round and settles on the result', () => {
    const events = wireEvents('turn-retracted.jsonl')
    const { turnId } = ask(events)
    useChatStore.getState().applyTurnEvents(upTo(events, 3))
    const id = useChatStore.getState().turns[turnId]!.messageId!
    expect(answerOf(id)!.content).not.toBe('')

    useChatStore.getState().applyTurnEvents(from(upTo(events, 4), 4))
    expect(answerOf(id)!.content).toBe('')

    useChatStore.getState().applyTurnEvents(from(events, 5))
    expect(answerOf(id)).toMatchObject({ answerConfidence: 'low', answerConfidenceCappedReason: 'ungrounded' })
    expect(answerOf(id)!.citationsRemoved).toEqual({ count: 1, reasons: ['no_matching_passage'] })
  })
})

describe('Stop', () => {
  const cancelled = wireEvents('turn-cancelled.jsonl')

  it('sends cancel_turn and keeps the answer so far, marked stopped, with the composer free', () => {
    const { turnId } = ask(cancelled)
    const cancel = vi.fn()
    registerStopStreamingHandler(cancel)
    useChatStore.getState().applyTurnEvents(upTo(cancelled, 4))
    const id = useChatStore.getState().turns[turnId]!.messageId!
    const partial = answerOf(id)!.content

    useChatStore.getState().stopStreaming()

    expect(cancel).toHaveBeenCalledWith(turnId)
    expect(answerOf(id)).toMatchObject({ content: partial, stopped: true })
    expect(answerOf(id)!.isStreaming).toBeUndefined()
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(client.createMessage).not.toHaveBeenCalled()
  })

  it("persists the server's cancelled terminal as the stopped answer", async () => {
    const { turnId } = ask(cancelled)
    useChatStore.getState().applyTurnEvents(cancelled)
    const id = useChatStore.getState().turns[turnId]!.messageId!

    expect(answerOf(id)!.stopped).toBe(true)
    await vi.waitFor(() =>
      expect(client.createMessage).toHaveBeenCalledWith(CONVERSATION_OF(cancelled), expect.objectContaining({ id }))
    )
  })
})

const CONVERSATION_OF = (events: WireEvent[]) => events[0]!.conversation_id

describe('a question for the asker, then a run', () => {
  const hitl = wireEvents('turn-hitl-handoff.jsonl')

  it('opens a prompt card and the pending question, and closes the question when it is resolved', async () => {
    const { turnId } = ask(hitl)
    useChatStore.getState().applyTurnEvents(upTo(hitl, 4))

    const prompt = messages().find((message) => message.messageType === 'prompt')!
    expect(prompt).toMatchObject({ promptId: 'ask_01J9Z6', promptParentId: turnId, promptInputType: 'choice' })
    expect(prompt.promptOptions?.[0]).toEqual({ id: '1', label: expect.any(String) })
    expect(useChatStore.getState().pendingInteraction).toEqual({
      turnId,
      interactionId: 'ask_01J9Z6',
      input: 'choice',
    })
    // The composer answers the question; the turn is not "streaming" meanwhile.
    expect(useChatStore.getState().isStreaming).toBe(false)
    await vi.waitFor(() =>
      expect(client.createMessage).toHaveBeenCalledWith(CONVERSATION_OF(hitl), expect.objectContaining({ id: prompt.id }))
    )

    useChatStore.getState().applyTurnEvents(from(upTo(hitl, 6), 5))
    expect(useChatStore.getState().pendingInteraction).toBeNull()
    expect(useChatStore.getState().isStreaming).toBe(true)
  })

  it('draws no answer for a turn that handed off to a run', () => {
    ask(hitl)
    useChatStore.getState().applyTurnEvents(hitl)
    expect(messages().some((message) => message.messageType === 'agent_response')).toBe(false)
    expect(useChatStore.getState().isStreaming).toBe(false)
  })
})

describe('a turn this tab cannot continue', () => {
  it('is dropped with its unfinished answer', () => {
    ask(answered)
    useChatStore.getState().applyTurnEvents(upTo(answered, 14))
    expect(answerOf(RESULT.message_id)).toBeDefined()

    useChatStore.getState().dropTurn(TURN)

    expect(answerOf(RESULT.message_id)).toBeUndefined()
    expect(useChatStore.getState().turns[TURN]).toBeUndefined()
    expect(useChatStore.getState().isStreaming).toBe(false)
  })
})
