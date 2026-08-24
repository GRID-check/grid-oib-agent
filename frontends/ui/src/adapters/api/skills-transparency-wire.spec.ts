/**
 * The skills-transparency extras, from the terminal frame to the answer's props.
 *
 * `grid-hidden` metadata makes `SkillRuntime.hidden_activated` name a skill,
 * the shallow researcher puts that list on `skills_hidden`, the aiq_api lifts
 * it onto the terminal frame beside `skills_activated`, and the disclosure
 * reads the pair: `skills_activated` is the record of what shaped the answer
 * and `skills_hidden` is the subset it mutes until the reader turns the
 * reasoning view on. Drop the hidden half and a house-voice row reads at full
 * weight on every answer; drop the activated half and the record is gone.
 *
 * Every link had a test and the crossing did not. `skills-transparency.spec.tsx`
 * pins `skills_activated` at the schema and the disclosure component at its
 * props; nothing anywhere named `skills_hidden` on the wire, so deleting
 * `skillsHidden: message.skills_hidden` from the client's transparency bundle
 * left the whole UI suite green. (Deleting the SCHEMA field alone is caught,
 * but by `tsc`, not by a test — and only for as long as a reader of that field
 * survives it.)
 *
 * The Python half cannot be asserted from here, so the two are pinned to the
 * same named constant instead: `_SKILLS_EXTRA_FIELDS` in
 * `frontends/aiq_api/src/aiq_api/websocket_reconnect.py` is the list of fields
 * the backend lifts onto the frame, and it is read from source below — the same
 * device `chat/lib/turn-events.spec.ts` uses for `ALL_STATUS_KEYS`. Rename a
 * field on either side and exactly one of the two halves fails.
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

describe('the skills extras reach the answer, not just the schema', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('both halves ride the terminal frame into the transparency bundle', async () => {
    const transparency = await transparencyFor({
      skills_activated: ['oib-brandschutz', 'piloti-voice'],
      skills_hidden: ['piloti-voice'],
    })

    expect(transparency.skillsActivated).toEqual(['oib-brandschutz', 'piloti-voice'])
    // The half nothing was watching. `piloti-voice` runs on every answer, so
    // without this the disclosure reads it at full weight every single turn.
    expect(transparency.skillsHidden).toEqual(['piloti-voice'])
  })

  test('a turn with no hidden skill carries no hidden list', async () => {
    const transparency = await transparencyFor({ skills_activated: ['oib-brandschutz'] })
    expect(transparency.skillsActivated).toEqual(['oib-brandschutz'])
    expect(transparency.skillsHidden).toBeUndefined()
  })

  test('a malformed hidden list degrades to absent rather than killing the answer', async () => {
    // Per-field `.catch(undefined)`, like every other transparency extra: the
    // answer text must survive a bad extra, and a muted-or-not decision is not
    // worth an unrendered turn.
    const transparency = await transparencyFor({
      skills_activated: ['oib-brandschutz'],
      skills_hidden: 'piloti-voice',
    })
    expect(transparency.skillsHidden).toBeUndefined()
    expect(transparency.skillsActivated).toEqual(['oib-brandschutz'])
  })

  test('the schema lifts the hidden subset off the frame', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      type: 'system_response_message',
      id: 'm1',
      status: 'complete',
      content: { text: 'die Antwort' },
      skills_hidden: ['piloti-voice'],
    })
    expect(parsed.skills_hidden).toEqual(['piloti-voice'])
  })
})

describe('the backend and this client name the same fields', () => {
  const repoRoot = join(process.cwd(), '..', '..')

  /** The string literals inside `_SKILLS_EXTRA_FIELDS = ( … )`. */
  const backendFields = (): string[] => {
    const source = readFileSync(
      join(repoRoot, 'frontends/aiq_api/src/aiq_api/websocket_reconnect.py'),
      'utf8'
    )
    const block = source.split('_SKILLS_EXTRA_FIELDS = (')[1]
    expect(block, '_SKILLS_EXTRA_FIELDS not found').toBeDefined()
    return [...block.split(')')[0].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  }

  test('the guard is actually reading the backend', () => {
    // A regex that quietly stopped matching would make the test below pass
    // over an empty list.
    expect(backendFields()).toEqual(['skills_activated', 'skills_hidden'])
  })

  test('every field the backend lifts is one this schema reads', () => {
    const declared = new Set(backendFields())
    // The schema must accept each one under the backend's own spelling…
    for (const field of declared) {
      const parsed = NATSystemResponseMessageSchema.parse({
        type: 'system_response_message',
        id: 'm1',
        status: 'complete',
        content: { text: 'die Antwort' },
        [field]: ['piloti-voice'],
      }) as Record<string, unknown>
      expect(parsed[field], field).toEqual(['piloti-voice'])
    }
  })
})
