/**
 * `read_sources`, from the backend's lift list to the answer's disclosure.
 *
 * The turn retrieved documents it never cited. The backend threads their
 * identities (document key + lane/kind + page, NO prose) from
 * `ledger.assemble_result` through `ANSWER_LIFTS` / `RESPONSE_LIFTS` onto the
 * terminal frame; this client carries them into the transparency bundle, the
 * hook normalizes them, and the answer renders the collapsed
 * "Gelesen, nicht zitiert" disclosure.
 *
 * The crossing is what breaks: a field lifted on one side but not declared on
 * the other vanishes with nothing failing anywhere (see
 * `research-truncated-wire.spec.ts`). So this pins the same three points —
 * the backend's own list of lifted fields, the schema, and the bundle the
 * client hands `onResponse` — and it reads the Python list out of the source,
 * because the Python half cannot be asserted from here.
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
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send = vi.fn()
  close = vi.fn()
}

const WIRE_READ = {
  document_id: 'doc:oib_knowledge:oib-rl_2.pdf',
  citation_key: 'oib-rl_2.pdf, p.12',
  file_name: 'oib-rl_2.pdf',
  page: 12,
  kind: 'baurecht',
  lane: 'baurecht_oib',
  lane_label: 'OIB-Richtlinie',
}

const transparencyFor = async (extra: Record<string, unknown>) => {
  const onResponse = vi.fn()
  const client = new NATWebSocketClient({
    conversationId: 'conv-1',
    websocketUrl: 'ws://localhost/websocket',
    callbacks: { onResponse },
  })
  await client.connect()
  const ws = MockWebSocket.instances[0]
  ws.onopen?.(new Event('open'))
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

describe('the read-but-uncited identities cross into the answer', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('they ride the terminal frame into the transparency bundle', async () => {
    const transparency = await transparencyFor({ read_sources: [WIRE_READ] })
    expect(transparency.readSources).toEqual([WIRE_READ])
  })

  test('a turn that cited everything it read carries nothing', async () => {
    const transparency = await transparencyFor({})
    expect(transparency.readSources).toBeUndefined()
  })

  test('one malformed entry degrades to absent while the rest survive', () => {
    const frame = NATSystemResponseMessageSchema.parse({
      type: 'system_response_message',
      id: 'm1',
      status: 'complete',
      content: { text: 'die Antwort' },
      read_sources: [WIRE_READ, 42],
    })
    expect(frame.read_sources).toEqual([expect.objectContaining({ file_name: 'oib-rl_2.pdf' })])
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
    return [...block.split(')')[0].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  }

  test('the backend lifts read_sources onto the frame', () => {
    expect(backendFields()).toContain('read_sources')
  })

  test('read_sources is one this schema declares', () => {
    // Declared, not merely tolerated: an undeclared field is silently stripped
    // by the schema, which is exactly how a lifted extra reaches the client
    // and then vanishes with nothing failing anywhere.
    expect(Object.keys(NATSystemResponseMessageSchema.shape)).toContain('read_sources')
  })
})
