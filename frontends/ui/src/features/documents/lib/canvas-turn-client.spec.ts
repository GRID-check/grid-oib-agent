/**
 * The canvas's turn client against a scripted socket and a recorded `fetch`.
 *
 * What is pinned: the conversation exists before the socket opens, the
 * question is stored as a row of it, and the `user_message` carries the
 * document, the box and the thread; answer events fold into one view; every
 * question ends (refused, unanswered twice, silent twice, stopped); one turn
 * at a time; a gap in the stream is attached from the last seq folded; a
 * question whose server reads neither its box nor its thread says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnSocket, TurnSocketOptions } from '@/adapters/api/turn-socket'
import type { ClientMessage } from '@/adapters/api/wire-v2'
import type { TurnView } from '@/features/chat/lib/turn-fold'
import { eventOf, frameOf } from '@/test-utils/wire-v2-fixtures'
import { CANVAS_ACK_TIMEOUT_MS, CanvasTurnError, canvasDegradations, createCanvasTurnClient } from './canvas-turn-client'

/** A socket the test plays: opens on connect, records what is sent, delivers frames on cue. */
function scriptedSocket() {
  const sent: ClientMessage[] = []
  let options: TurnSocketOptions | null = null
  let open = false
  const socket: TurnSocket = {
    connect: async () => {
      open = true
      options?.onStatus?.('open')
    },
    send: (message) => {
      if (!open) return false
      sent.push(message)
      return true
    },
    accepts: (entry) => open && entry === 'steer',
    reconnect: vi.fn(() => options?.onStatus?.('open')),
    close: vi.fn(() => {
      open = false
    }),
  }
  return {
    sent,
    socket,
    create: (given: TurnSocketOptions) => {
      options = given
      return socket
    },
    deliver: (seq: number, body: Record<string, unknown>, turnId = 'turn-1') =>
      options?.onEvent(eventOf(frameOf(seq, body, turnId))),
    options: () => options,
  }
}

/** A `fetch` that answers 201 (or what `status` says) and records each request. */
function recordedFetch(status: (path: string) => number = () => 201) {
  const calls: Array<{ path: string; body: unknown }> = []
  const run = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response('{}', { status: status(path) })
  })
  return { calls, run }
}

const REGION = { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.25 }

function setup(status?: (path: string) => number) {
  const socket = scriptedSocket()
  const fetched = recordedFetch(status)
  const views: TurnView[] = []
  const onConversation = vi.fn()
  const client = createCanvasTurnClient({
    conversationId: 'conv_1',
    projectId: 'proj_1',
    documentId: 'doc_1',
    title: 'Grundriss.pdf · Prüfansicht',
    onTurn: (view) => views.push(view),
    onConversation,
    createSocket: socket.create,
    fetch: fetched.run,
  })
  const last = () => views[views.length - 1]
  return { client, socket, fetched, views, last, onConversation }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the canvas turn client', () => {
  it('creates the conversation, stores the question, then asks with the box', async () => {
    const { client, socket, fetched, onConversation } = setup()

    await client.ask(
      {
        text: 'Was ist das?',
        region: { ...REGION, annotation_id: 'ann_7' },
        fileName: 'Grundriss.pdf',
        versionState: 'in_review',
        replyInThread: true,
      },
      'turn-1'
    )

    expect(fetched.calls).toEqual([
      {
        path: '/api/conversations',
        body: {
          id: 'conv_1',
          title: 'Grundriss.pdf · Prüfansicht',
          projectId: 'proj_1',
          subjectResourceType: 'document',
          subjectResourceId: 'doc_1',
        },
      },
      {
        path: '/api/conversations/conv_1/messages',
        body: { id: 'turn-1', role: 'user', content: 'Was ist das?', messageType: 'user' },
      },
    ])
    expect(onConversation).toHaveBeenCalledTimes(1)
    expect(socket.options()?.conversationId).toBe('conv_1')
    expect(socket.options()?.projectId).toBe('proj_1')
    expect(socket.sent).toEqual([
      {
        type: 'user_message',
        conversation_id: 'conv_1',
        message_id: 'turn-1',
        text: 'Was ist das?',
        focus_file_name: 'Grundriss.pdf',
        focus_shelf: 'project',
        focus_document_id: 'doc_1',
        focus_version_id: null,
        focus_version_state: 'in_review',
        focus_region: { ...REGION, annotation_id: 'ann_7' },
        reply_in_thread: true,
        reasoning_effort: 'low',
      },
    ])
  })

  it('creates the conversation once for every question asked in it', async () => {
    const { client, socket, fetched } = setup()
    await client.ask({ text: 'Eins', region: REGION }, 'turn-1')
    socket.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    socket.deliver(2, { type: 'RUN_FINISHED', outcome: 'answered', result: { message_id: 'a-1', text: 'Ja.' } })
    await client.ask({ text: 'Zwei', region: null }, 'turn-2')

    expect(fetched.calls.filter((call) => call.path === '/api/conversations')).toHaveLength(1)
    expect(socket.sent.at(-1)).toMatchObject({ message_id: 'turn-2', focus_region: null })
  })

  it('folds the answer as it streams, and ends the turn on its terminal', async () => {
    const { client, socket, last } = setup()
    await client.ask({ text: 'Maße prüfen', region: REGION }, 'turn-1')
    expect(last().phase).toBe('running')

    socket.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    socket.deliver(2, { type: 'STEP_STARTED', step: { id: 'tool:1', kind: 'tool', tool: 'view_knowledge_image' } })
    socket.deliver(3, { type: 'TEXT_MESSAGE_START', message_id: 'a-1' })
    socket.deliver(4, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a-1', delta: 'Die Raumhöhe ' })
    socket.deliver(5, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a-1', delta: 'fehlt.' })
    expect(last()).toMatchObject({ text: 'Die Raumhöhe fehlt.', streaming: true, stepOrder: ['tool:1'] })

    socket.deliver(6, {
      type: 'RUN_FINISHED',
      outcome: 'answered',
      result: { message_id: 'a-1', text: 'Die Raumhöhe fehlt [1].' },
    })
    expect(last()).toMatchObject({ phase: 'finished', text: 'Die Raumhöhe fehlt [1].' })
  })

  it('refuses a second question while one runs', async () => {
    const { client } = setup()
    await client.ask({ text: 'Eins', region: REGION }, 'turn-1')
    await expect(client.ask({ text: 'Zwei', region: REGION }, 'turn-2')).rejects.toEqual(new CanvasTurnError('busy'))
  })

  it('fails a question it could not store, and never sends it', async () => {
    const { client, socket, last } = setup((path) => (path.endsWith('/messages') ? 500 : 201))
    await client.ask({ text: 'Was ist das?', region: REGION }, 'turn-1')
    expect(last()).toMatchObject({ phase: 'failed', error: { code: 'canvas.not_stored' } })
    expect(socket.sent).toEqual([])
  })

  it('reopens once for an unanswered question, then gives up on it', async () => {
    vi.useFakeTimers()
    const { client, socket, last } = setup()
    await client.ask({ text: 'Was ist das?', region: REGION }, 'turn-1')

    await vi.advanceTimersByTimeAsync(CANVAS_ACK_TIMEOUT_MS)
    expect(socket.socket.reconnect).toHaveBeenCalledTimes(1)
    // The reopened socket said hello: the question went out again.
    expect(socket.sent.filter((message) => message.type === 'user_message')).toHaveLength(2)
    expect(last().phase).toBe('running')

    await vi.advanceTimersByTimeAsync(CANVAS_ACK_TIMEOUT_MS)
    expect(last()).toMatchObject({ phase: 'failed', error: { code: 'agent.no_response' } })
  })

  it('ends a question the server refused', async () => {
    const { client, socket, last } = setup()
    await client.ask({ text: 'Was ist das?', region: REGION }, 'turn-1')
    socket.deliver(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'user_message', code: 'invalid_message', message: 'focus_region' } })
    expect(last()).toMatchObject({ phase: 'failed', error: { code: 'agent.response_failed', message: 'focus_region' } })
  })

  it('attaches from the last seq folded when the stream skips, once per gap', async () => {
    const { client, socket } = setup()
    await client.ask({ text: 'Was ist das?', region: REGION }, 'turn-1')
    socket.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    socket.deliver(4, { type: 'TEXT_MESSAGE_START', message_id: 'a-1' })
    socket.deliver(5, { type: 'TEXT_MESSAGE_START', message_id: 'a-1' })
    expect(socket.sent.filter((message) => message.type === 'attach')).toEqual([
      { type: 'attach', conversation_id: 'conv_1', turn_id: 'turn-1', after_seq: 1 },
    ])
  })

  it('stops a turn: the cancel says how far it got, the view keeps what came', async () => {
    const { client, socket, last } = setup()
    await client.ask({ text: 'Was ist das?', region: REGION }, 'turn-1')
    socket.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })
    socket.deliver(2, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a-1', delta: 'Eine Tür' })

    client.cancel('turn-1')

    expect(socket.sent.at(-1)).toEqual({
      type: 'cancel_turn',
      conversation_id: 'conv_1',
      turn_id: 'turn-1',
      shown: { seq: 2, chars: 8 },
    })
    expect(last()).toMatchObject({ phase: 'finished', outcome: 'cancelled', text: 'Eine Tür' })
    // Free again.
    await expect(client.ask({ text: 'Noch eine', region: REGION }, 'turn-2')).resolves.toBeUndefined()
  })

  it('closes its socket', async () => {
    const { client, socket } = setup()
    await client.ask({ text: 'Was ist das?', region: REGION }, 'turn-1')
    client.close()
    expect(socket.socket.close).toHaveBeenCalled()
    await expect(client.ask({ text: 'Zwei', region: REGION }, 'turn-2')).rejects.toEqual(new CanvasTurnError('closed'))
  })
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('a note for the turn Piloti is working on', () => {
  const started = () => ({ type: 'RUN_STARTED', message_id: 'answer-1' })
  const finishedBody = { type: 'RUN_FINISHED', outcome: 'answered', result: { message_id: 'answer-1', text: 'Die Treppe.' } }

  it('goes to the running turn with the box drawn meanwhile, and asks nothing new when the turn read it', async () => {
    vi.useFakeTimers()
    const { client, socket, last } = setup()
    await client.ask({ text: 'Markier die Tür.' }, 'turn-1')
    socket.deliver(1, started())
    const leftover = vi.fn()

    expect(client.steer('nicht die Tür, die Treppe', { region: REGION, onLeftover: leftover })).toBe(true)
    const note = socket.sent.find((message) => message.type === 'steer') as Record<string, unknown>
    expect(note).toMatchObject({ turn_id: 'turn-1', text: 'nicht die Tür, die Treppe', focus_region: REGION })

    socket.deliver(2, { type: 'CUSTOM', name: 'steer_received', value: { steer_id: note.steer_id, text: 'nicht die Tür, die Treppe' } })
    socket.deliver(3, { type: 'CUSTOM', name: 'steer_applied', value: { steer_id: note.steer_id, round: 2 } })
    socket.deliver(4, finishedBody)
    await vi.advanceTimersByTimeAsync(1)

    expect(last()?.steers?.[String(note.steer_id)]).toEqual({ text: 'nicht die Tür, die Treppe', round: 2 })
    expect(leftover).not.toHaveBeenCalled()
  })

  it('hands a note the turn never read back once it has ended, refused or not', async () => {
    vi.useFakeTimers()
    const { client, socket, last } = setup()
    await client.ask({ text: 'Markier die Tür.' }, 'turn-1')
    socket.deliver(1, started())
    const leftover = vi.fn()
    client.steer('und das Podest?', { onLeftover: leftover })

    socket.deliver(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'steer', code: 'steer_limit' } })
    expect(last()?.phase).toBe('running')
    socket.deliver(2, finishedBody)
    await vi.advanceTimersByTimeAsync(1)

    expect(leftover).toHaveBeenCalledWith('und das Podest?')
  })

  it('takes no note when nothing runs, or when the server reads none', async () => {
    const { client, socket } = setup()
    expect(client.steer('die Treppe')).toBe(false)

    await client.ask({ text: 'Markier die Tür.' }, 'turn-1')
    socket.deliver(1, started())
    vi.spyOn(socket.socket, 'accepts').mockReturnValue(false)
    expect(client.steer('die Treppe')).toBe(false)
    expect(socket.sent.filter((message) => message.type === 'steer')).toEqual([])
  })
})

describe('a question its server cannot read whole', () => {
  it('names what a server leaves out: the box, the thread, or nothing', () => {
    const message = {
      type: 'user_message' as const,
      conversation_id: 'c',
      message_id: 't',
      text: 'x',
      focus_region: { ...REGION },
      reply_in_thread: true,
    }
    expect(canvasDegradations(message, () => false)).toEqual(['region', 'thread'])
    expect(canvasDegradations(message, () => true)).toEqual([])
    expect(canvasDegradations({ ...message, reply_in_thread: undefined }, (entry) => entry === 'steer')).toEqual([
      'region',
    ])
  })

  it('still asks, and says once what the question went without', async () => {
    const socket = scriptedSocket()
    const onDegraded = vi.fn()
    const client = createCanvasTurnClient({
      conversationId: 'conv_1',
      conversationExists: true,
      documentId: 'doc_1',
      title: 't',
      onTurn: () => {},
      onDegraded,
      createSocket: socket.create,
      fetch: recordedFetch().run,
    })
    await client.ask({ text: 'Was ist das?', region: REGION, replyInThread: false }, 'turn-1')

    expect(socket.sent).toHaveLength(1)
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith('turn-1', ['region'])
  })
})

describe('a turn that goes silent', () => {
  it('survives one silent socket and ends on the second in a row', async () => {
    const { client, socket, last } = setup()
    await client.ask({ text: 'Was ist das?', region: REGION }, 'turn-1')
    socket.deliver(1, { type: 'RUN_STARTED', message_id: 'a-1' })

    socket.options()?.onSilent?.(['turn-1'])
    expect(last().phase).toBe('running')
    socket.options()?.onSilent?.(['turn-1'])
    expect(last()).toMatchObject({ phase: 'failed', error: { code: 'agent.response_interrupted' } })
  })
})
