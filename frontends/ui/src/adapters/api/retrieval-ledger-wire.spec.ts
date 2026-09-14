/**
 * The retrieval-ledger extra, from the terminal frame to the answer's props.
 *
 * The backend states what each retrieval round was asked, returned, and added
 * (`retrieval_ledger` on the terminal frame); the Herleitung will read it
 * instead of reconstructing rounds from step names. Every link had a test for
 * skills and the crossing did not — this file is the ledger's crossing, in
 * the same shape: frame → transparency bundle → schema, plus the
 * backend/frontend name parity that fails when either side renames the field.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NATMessageType, NATWebSocketClient } from './websocket-client'
import { NATSystemResponseMessageSchema } from './schemas'

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
  onerror: ((event: CloseEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send = vi.fn()
  close = vi.fn()
}

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

/** The transparency bundle the client hands `onResponse` for one terminal frame. */
const transparencyFor = async (extra: Record<string, unknown>) => {
  const onResponse = vi.fn()
  const ws = await openClient({ onResponse })
  ws.onmessage?.({
    data: JSON.stringify({
      type: NATMessageType.SYSTEM_RESPONSE,
      status: 'complete',
      content: 'die Antwort',
      ...extra,
    }),
  } as MessageEvent)
  expect(onResponse).toHaveBeenCalledTimes(1)
  return onResponse.mock.calls[0][8] as Record<string, unknown>
}

const WIRE_LEDGER = [
  {
    index: 0,
    key: 'status.retrieval.withQuery',
    tools: ['knowledge_search'],
    corpora: ['knowledge'],
    purpose: 'first_search',
    query: 'Fluchtweglänge GK4',
    docs: [{ name: 'OIB-RL_2.pdf' }],
    new_docs: ['OIB-RL_2.pdf'],
    hits: 1,
    documents: 1,
  },
]

describe('the retrieval ledger reaches the answer, not just the schema', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('the ledger rides the terminal frame into the transparency bundle, bounded', async () => {
    const transparency = await transparencyFor({ retrieval_ledger: WIRE_LEDGER })

    expect(transparency.retrievalLedger).toEqual([
      {
        index: 0,
        key: 'status.retrieval.withQuery',
        tools: ['knowledge_search'],
        corpora: ['knowledge'],
        purpose: 'first_search',
        query: 'Fluchtweglänge GK4',
        docs: [{ name: 'OIB-RL_2.pdf' }],
        newDocs: ['OIB-RL_2.pdf'],
        hits: 1,
        documents: 1,
      },
    ])
  })

  test('a turn with no ledger carries no ledger', async () => {
    const transparency = await transparencyFor({})
    expect(transparency.retrievalLedger).toBeUndefined()
  })

  test('a malformed ledger degrades to absent rather than killing the answer', async () => {
    const transparency = await transparencyFor({ retrieval_ledger: 'oib' })
    expect(transparency.retrievalLedger).toBeUndefined()
  })

  test('the schema lifts the ledger off the frame', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      type: 'system_response_message',
      id: 'm1',
      status: 'complete',
      content: { text: 'die Antwort' },
      retrieval_ledger: WIRE_LEDGER,
    })
    expect(parsed.retrieval_ledger).toEqual(WIRE_LEDGER)
  })
})

describe('the backend and this client name the same field', () => {
  const repoRoot = join(process.cwd(), '..', '..')

  /** The string literals inside `_TRANSPARENCY_EXTRA_FIELDS = ( … )`. */
  const backendFields = (): string[] => {
    const source = readFileSync(
      join(repoRoot, 'frontends/aiq_api/src/aiq_api/websocket_reconnect.py'),
      'utf8'
    )
    const block = source.split('_TRANSPARENCY_EXTRA_FIELDS = (')[1]
    expect(block, '_TRANSPARENCY_EXTRA_FIELDS not found').toBeDefined()
    // To the closing paren on its own line — comments inside the tuple hold
    // parens of their own, so the first `)` is not the end.
    const body = block.split('\n)')[0]
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  }

  test('the backend lifts retrieval_ledger onto the terminal frame', () => {
    expect(backendFields()).toContain('retrieval_ledger')
  })

  test('the schema round-trips the lifted value instead of dropping it', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      type: 'system_response_message',
      id: 'm1',
      status: 'complete',
      content: { text: 'die Antwort' },
      retrieval_ledger: WIRE_LEDGER,
    }) as Record<string, unknown>
    expect(parsed.retrieval_ledger).toEqual(WIRE_LEDGER)
  })
})
