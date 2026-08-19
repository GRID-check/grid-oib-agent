/**
 * The post-answer stage WIRE CONTRACT, from the shared fixture file to the
 * client's `onStage` callback (`docs/architecture/post-answer-stages.md` §4, §9).
 *
 * The fixtures in `shared/stages/frames.json` are the contract itself, not a
 * copy of it: the Python frame-builder test
 * (`tests/aiq_agent/stages/test_frame_contract.py`) asserts `build_stage_frame()`
 * produces them, and this file asserts the client accepts them. If the two
 * halves drift, one of them fails — which is the only enforcement a
 * "contract-first" split has, since neither half can call the other.
 *
 * So this file deliberately does NOT hand-write a frame. A frame typed in here
 * would be this half's opinion of the contract, and two opinions is exactly the
 * failure mode the shared file exists to prevent.
 *
 * It also does not read `runner.py`. It used to: while the Python reader did not
 * exist, this file stood in for it with regexes over the backend source. That
 * stand-in is gone, because the moment the real reader landed, two tests were
 * asserting the same thing by different routes — and the route that would have
 * quietly stopped meaning anything is the one that greps another language's
 * source for a constant.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NATWebSocketClient } from './websocket-client'
import {
  NATIncomingMessageSchema,
  NATStageMessageSchema,
  STAGE_FRAME_VERSION,
  STAGE_IDS,
} from './schemas'

const FIXTURES = join(process.cwd(), '..', '..', 'shared', 'stages', 'frames.json')

interface Fixtures {
  v: number
  type: string
  delivered: Record<string, Record<string, unknown>>
  rejected: Record<string, { why: string; frame: Record<string, unknown> }>
}

const fixtures = (): Fixtures => JSON.parse(readFileSync(FIXTURES, 'utf8')) as Fixtures

const deliveredKeys = (name: string) => Object.keys(fixtures().delivered[name]).sort()

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

/** Feed one raw frame down a live client and report what `onStage` saw. */
const deliver = async (frame: unknown) => {
  const onStage = vi.fn()
  const client = new NATWebSocketClient({
    conversationId: 'conv-1',
    websocketUrl: 'ws://localhost/websocket',
    callbacks: { onStage },
  })
  await client.connect()
  const ws = MockWebSocket.instances[0]
  ws.onopen?.(new Event('open'))
  ws.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  return onStage
}

describe('the shared fixture file is the contract both halves read', () => {
  test('it is on disk where the Python half also looks for it', () => {
    // A guard on the guard: if this file moves, every assertion below would
    // pass over an empty fixture set instead of failing.
    const { delivered, rejected } = fixtures()
    expect(Object.keys(delivered).length).toBeGreaterThan(0)
    expect(Object.keys(rejected).length).toBeGreaterThan(0)
  })

  test('there is one delivered fixture per (stage, status) that reaches the wire', () => {
    // Derived from `STAGE_IDS`, not typed out, so this half is exhaustive the
    // same way the Python half is exhaustive over the stage registry. Both
    // directions are then live: a stage the backend delivers and this client
    // has no renderer for has no fixture and fails here, and a stage this
    // client declares with a fixture missing fails here too.
    //
    // ready | empty | failed, and nothing else: the runner maps `timeout` onto
    // `failed` and never puts skipped/disabled on the wire at all.
    const expected = STAGE_IDS.flatMap((stage) =>
      (['empty', 'failed', 'ready'] as const).map((status) => `${stage}.${status}`),
    ).sort()
    expect(Object.keys(fixtures().delivered).sort()).toEqual(expected)
  })

  test('the envelope version this client pins is the one the fixtures carry', () => {
    expect(fixtures().v).toBe(STAGE_FRAME_VERSION)
  })
})

describe('every delivered fixture parses as the envelope it claims to be', () => {
  for (const [name, frame] of Object.entries(fixtures().delivered)) {
    test(`${name} parses`, () => {
      const parsed = NATStageMessageSchema.safeParse(frame)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    })

    test(`${name} is reachable through the incoming union`, () => {
      // Parsing standalone is not the same fact as being dispatchable: a member
      // missing from `NATIncomingMessageSchema` would leave the frame to the
      // warn-once-and-drop fallback with this file still green.
      expect(NATIncomingMessageSchema.safeParse(frame).success).toBe(true)
    })
  }

  test('only a ready fixture carries a payload — for every stage', () => {
    for (const [name, frame] of Object.entries(fixtures().delivered)) {
      if (frame.status === 'ready') expect(frame.payload, name).toBeDefined()
      else expect(frame.payload, name).toBeUndefined()
    }
  })

  test('a failed frame carries no reason for the reader — for every stage', () => {
    // Failure reasons are machine keys for the ledger, not user-facing text
    // (§4.1); the client renders `failed` and `empty` identically. Asserted as
    // the WHOLE key set rather than "no `reason` key", so a producer that
    // smuggles the reason out under another name fails here too.
    const envelope = ['conversation_id', 'parent_id', 'stage', 'status', 'timestamp', 'type', 'v']
    for (const name of Object.keys(fixtures().delivered)) {
      if (!name.endsWith('.failed')) continue
      expect(deliveredKeys(name), name).toEqual(envelope)
    }
  })
})

describe('the client dispatches what the contract delivers', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  for (const [name, frame] of Object.entries(fixtures().delivered)) {
    test(`${name} reaches onStage intact`, async () => {
      const onStage = await deliver(frame)
      expect(onStage).toHaveBeenCalledTimes(1)
      expect(onStage.mock.calls[0][0]).toMatchObject({
        stage: frame.stage,
        status: frame.status,
        parent_id: frame.parent_id,
        conversation_id: frame.conversation_id,
      })
    })
  }

  for (const [name, { why, frame }] of Object.entries(fixtures().rejected)) {
    test(`${name} never reaches onStage — ${why}`, async () => {
      const onStage = await deliver(frame)
      expect(onStage).not.toHaveBeenCalled()
    })
  }

  test('a dropped stage frame does not take the rest of the socket with it', async () => {
    // The version-skew promise of §4.1: a new backend against an old tab loses
    // the stage and NOTHING else.
    const onStage = vi.fn()
    const onResponse = vi.fn()
    const client = new NATWebSocketClient({
      conversationId: 'conv-1',
      websocketUrl: 'ws://localhost/websocket',
      callbacks: { onStage, onResponse },
    })
    await client.connect()
    const ws = MockWebSocket.instances[0]
    ws.onopen?.(new Event('open'))
    ws.onmessage?.({
      data: JSON.stringify(fixtures().rejected['unknown-stage'].frame),
    } as MessageEvent)
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'system_response_message',
        status: 'complete',
        content: 'die Antwort',
      }),
    } as MessageEvent)
    expect(onStage).not.toHaveBeenCalled()
    expect(onResponse).toHaveBeenCalledTimes(1)
  })
})
