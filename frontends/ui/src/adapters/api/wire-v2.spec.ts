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
import { clientMessageSchema, parseWireEvent, type WireEvent } from './wire-v2'

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
