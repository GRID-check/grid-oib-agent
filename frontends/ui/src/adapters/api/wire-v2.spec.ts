/**
 * @vitest-environment node
 */
/**
 * The chat wire v2 contract, read from this side (`docs/design/chat-wire-v2.md`).
 *
 * `shared/wire/v2/` holds recorded turns, one event per line, and
 * `tests/aiq_agent/common/test_wire_v2.py` reads the same files with the Pydantic
 * models they were generated from. Every event must parse here, parse to the
 * type it says it is, and every frame of the old wire must NOT parse: there is
 * no second reader.
 *
 * The fixtures are read at runtime, walking up from `process.cwd()`, for the
 * reason `test-utils/card-json-schema.ts` gives: `shared/` is outside the
 * frontend image's build context, and `next build` type-checks specs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldTurnEvents } from '@/features/chat/lib/turn-fold'
import { clientMessageSchema, parseHello, parseWireEvent, type WireEvent } from './wire-v2'

function fixtureDir(): string {
  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, 'shared', 'wire', 'v2')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`shared/wire/v2 not found above ${process.cwd()}`)
    dir = parent
  }
}

const DIR = fixtureDir()
const lines = (name: string): unknown[] =>
  readFileSync(join(DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown)

const TURNS = readdirSync(DIR).filter((name) => name.startsWith('turn-') && name.endsWith('.jsonl'))

const parsedTurn = (name: string): WireEvent[] =>
  lines(name).map((raw, index) => {
    const event = parseWireEvent(raw)
    if (!event)
      throw new Error(`${name}:${index + 1} did not parse: ${JSON.stringify(raw).slice(0, 200)}`)
    return event
  })

describe('chat wire v2 fixtures', () => {
  it('has recorded turns to read', () => {
    expect(TURNS.length).toBeGreaterThanOrEqual(5)
  })

  it.each(TURNS)('%s parses event for event, in seq order', (name) => {
    const events = parsedTurn(name)
    expect(events[0].type).toBe('RUN_STARTED')
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
    for (const [index, event] of events.entries()) {
      const raw = lines(name)[index] as { type: string; name?: string }
      expect(event.type).toBe(raw.type)
      if (event.type === 'CUSTOM') expect(event.name).toBe(raw.name)
    }
  })

  it('restores what a minimal frame omits', () => {
    const [started] = parsedTurn('turn-retracted.jsonl').filter(
      (event) => event.type === 'STEP_STARTED'
    )
    if (started?.type !== 'STEP_STARTED' || started.step.kind !== 'tool') {
      throw new Error('the retracted turn records a tool step that starts')
    }
    expect(started.step.status).toBe('running')
    expect(started.step.scope).toBe('chat')
  })

  it('carries the Herleitung as typed lanes, never as tool text', () => {
    const sources = parsedTurn('turn-answered.jsonl').flatMap((event) =>
      event.type === 'STEP_FINISHED' && event.step.kind === 'sources' ? [event.step] : []
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].lanes.map((lane) => lane.kind)).toEqual(['baurecht', 'projekt'])
  })

  it('parses the out-of-band refusals', () => {
    for (const raw of lines('rejected.jsonl')) {
      const event = parseWireEvent(raw)
      expect(event?.type === 'CUSTOM' && event.name === 'rejected' && event.seq === 0).toBe(true)
    }
  })

  it('parses the hello, and never as a turn event', () => {
    const [raw] = lines('hello.jsonl')
    expect(parseHello(raw)).toMatchObject({ v: 2, name: 'hello', value: { build: expect.any(String) } })
    expect(parseWireEvent(raw)).toBeNull()
  })

  it('takes no turn event, and no old frame, for a hello', () => {
    for (const raw of [...lines('rejected.jsonl'), ...lines('invalid-events.jsonl'), ...lines('turn-answered.jsonl')]) {
      expect(parseHello(raw)).toBeNull()
    }
    expect(parseHello({ v: 3, type: 'CUSTOM', name: 'hello', ts: 1, value: { build: 'x' } })).toBeNull()
  })

  it.each(lines('invalid-events.jsonl').map((raw) => [JSON.stringify(raw).slice(0, 80), raw]))(
    'refuses %s',
    (_label, raw) => {
      expect(parseWireEvent(raw)).toBeNull()
    }
  )

  it('parses every client message', () => {
    for (const raw of lines('client.jsonl')) {
      expect(clientMessageSchema.safeParse(raw).success, JSON.stringify(raw)).toBe(true)
    }
  })

  it('refuses every client message the contract does not describe', () => {
    for (const raw of lines('invalid-client.jsonl')) {
      expect(clientMessageSchema.safeParse(raw).success, JSON.stringify(raw)).toBe(false)
    }
  })
})

/**
 * A tab outlives a deploy, so the bundle reading a frame is often older than the
 * server that wrote it. `newer-events.jsonl` is drift a newer server may send:
 * the server's own models refuse it (`test_wire_v2.py`), this side reads it.
 */
describe('chat wire v2 frames from a newer server', () => {
  type Raw = Record<string, unknown>
  const newer = lines('newer-events.jsonl') as Raw[]
  const byType = (type: string, name?: string, kind?: string): Raw => {
    const raw = newer.find(
      (frame) =>
        frame.type === type &&
        (name === undefined || frame.name === name) &&
        (kind === undefined || (frame.step as Raw | undefined)?.kind === kind)
    )
    if (!raw) throw new Error(`newer-events.jsonl has no ${type} ${name ?? ''}`)
    return raw
  }

  it.each(newer.map((raw) => [JSON.stringify(raw).slice(0, 80), raw]))('reads %s', (_label, raw) => {
    expect(parseWireEvent(raw)).not.toBeNull()
  })

  it('strips an unknown key, in the body and in the result', () => {
    const event = parseWireEvent(byType('RUN_FINISHED'))
    if (event?.type !== 'RUN_FINISHED') throw new Error('a RUN_FINISHED with an extra key must parse')
    expect(event.result.text).toBe('Hallo')
    expect(event).not.toHaveProperty('replica')
    expect(event.result).not.toHaveProperty('answer_digest')
  })

  it('strips a raw payload off a step, so no tool text reaches the fold', () => {
    const event = parseWireEvent(byType('STEP_FINISHED', undefined, 'tool'))
    if (event?.type !== 'STEP_FINISHED') throw new Error('a step with an extra key must parse')
    expect(event.step).not.toHaveProperty('payload')
  })

  const ENVELOPE = {
    v: 2,
    conversation_id: '5f5b7a5c-1f0e-4a9d-9c3a-2f2f9a1b7c11',
    turn_id: 'msg_1759000000000_3',
    seq: 3,
    ts: 1759000000100,
  }

  it.each([
    ['a CUSTOM name', byType('CUSTOM', 'answer_outline'), 'CUSTOM:answer_outline'],
    ['a step kind', byType('STEP_STARTED'), 'STEP_STARTED:plan'],
    ['a type', byType('REASONING_MESSAGE_START'), 'REASONING_MESSAGE_START'],
  ])('hands on %s it does not know by its envelope, its body dropped', (_label, raw, of) => {
    expect(parseWireEvent(raw)).toEqual({ ...ENVELOPE, type: 'UNKNOWN', of })
  })

  it('still refuses a frame that names only known things and does not parse, or is not a v2 turn event', () => {
    const custom = byType('CUSTOM', 'answer_outline')
    expect(parseWireEvent({ ...custom, name: 'heartbeat', value: {} })).toBeNull()
    expect(parseWireEvent({ ...custom, v: 1 })).toBeNull()
    const { type: _type, ...untyped } = custom
    expect(parseWireEvent(untyped)).toBeNull()
    const { turn_id: _turn, ...unbound } = byType('REASONING_MESSAGE_START')
    expect(parseWireEvent(unbound)).toBeNull()
    expect(parseWireEvent({ ...byType('STEP_STARTED'), step: { id: 'tool:1', kind: 'tool' } })).toBeNull()
  })

  it('folds a recorded turn to the same answer, settled and without a gap, with unknown events and extra keys in it', () => {
    const recorded = lines('turn-answered.jsonl') as Raw[]
    const finished = recorded.findIndex((frame) => frame.type === 'RUN_FINISHED')
    const unknown: Raw[] = [
      byType('CUSTOM', 'answer_outline'),
      byType('STEP_STARTED'),
      byType('STEP_FINISHED', undefined, 'llm'),
      byType('REASONING_MESSAGE_START'),
    ].map((frame) => ({ ...frame, turn_id: recorded[0].turn_id }))
    const drifted = [...recorded.slice(0, finished), ...unknown, ...recorded.slice(finished)].map((frame, index) =>
      frame.type === 'RUN_FINISHED'
        ? { ...frame, seq: index + 1, replica: 'aiq-2', result: { ...(frame.result as Raw), answer_digest: 'x' } }
        : { ...frame, seq: index + 1 }
    )
    const fold = (frames: Raw[]) => {
      const events = frames.map(parseWireEvent)
      expect(events).not.toContain(null)
      return foldTurnEvents(undefined, events as WireEvent[])
    }
    const expected = fold(recorded)
    const actual = fold(drifted)
    expect(actual?.phase).toBe('finished')
    expect(actual?.gap).toBe(false)
    expect(actual?.lastSeq).toBe(recorded.length + unknown.length)
    expect({ ...actual, lastSeq: 0, lastBeatAt: 0 }).toEqual({ ...expected, lastSeq: 0, lastBeatAt: 0 })
  })
})
