/**
 * `research_truncated`, from the backend's lift list to the answer's props.
 *
 * The turn ran out of research budget before it ran out of question. The
 * backend has logged and traced that for a while; this is the field that lets
 * the ANSWER say it, which is the only surface where it changes what a person
 * does next.
 *
 * The crossing is what breaks: `skills_hidden` was once dropped from the
 * client's transparency bundle with the whole UI suite still green, because
 * every link had a test and the CROSSING did not. So this pins the same three
 * points that fix pinned — the backend's own list of lifted fields, the
 * schema, and the bundle the client hands `onResponse` — and it reads the
 * Python list out of the source, because the Python half cannot be asserted
 * from here. Rename the field on either side and exactly one half fails.
 *
 * Note which list it is on: `_TRANSPARENCY_EXTRA_FIELDS`, beside
 * `citations_removed`, NOT `_SKILLS_EXTRA_FIELDS`. Truncation is a fact about
 * the evidence, not about skills, and the skills pin stays at exactly two
 * entries.
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

describe('the truncation flag crosses into the answer', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('it rides the terminal frame into the transparency bundle', async () => {
    const transparency = await transparencyFor({ research_truncated: true })
    expect(transparency.researchTruncated).toBe(true)
  })

  test('a turn that finished its research carries nothing', async () => {
    const transparency = await transparencyFor({})
    expect(transparency.researchTruncated).toBeUndefined()
  })

  test('only literal true counts', () => {
    // Presence IS the fact. A `false` on the wire would be a second way to say
    // "not truncated" and a second thing every reader has to interpret.
    const frame = (value: unknown) =>
      NATSystemResponseMessageSchema.parse({
        type: 'system_response_message',
        id: 'm1',
        status: 'complete',
        content: { text: 'die Antwort' },
        research_truncated: value,
      })
    expect(frame(true).research_truncated).toBe(true)
    expect(frame(false).research_truncated).toBeUndefined()
    expect(frame('yes').research_truncated).toBeUndefined()
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

  test('the guard is actually reading the backend', () => {
    // A regex that quietly stopped matching would make the test below pass over
    // an empty list.
    expect(backendFields()).toContain('citations_removed')
  })

  test('the backend lifts research_truncated onto the frame', () => {
    expect(backendFields()).toContain('research_truncated')
  })

  test('every field the backend lifts is one this schema declares', () => {
    // Declared, not merely tolerated: an undeclared field is silently stripped
    // by the schema, which is exactly how a lifted extra reaches the client and
    // then vanishes with nothing failing anywhere.
    const declared = Object.keys(NATSystemResponseMessageSchema.shape)
    for (const field of backendFields()) {
      expect(declared, field).toContain(field)
    }
  })
})
