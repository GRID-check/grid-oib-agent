/**
 * The recorded v2 turns (`shared/wire/v2/`) and a builder for synthetic frames,
 * for specs that fold events. Read at runtime, walking up from `process.cwd()`,
 * for the reason `card-json-schema.ts` gives: `shared/` is outside the image's
 * build context. Node-only (`node:fs`); import it from specs only.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseWireEvent, type WireEvent } from '@/adapters/api/wire-v2'

const fixtureDir = (): string => {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'shared', 'wire', 'v2')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) throw new Error(`shared/wire/v2 not found above ${process.cwd()}`)
  }
}

const DIR = fixtureDir()

/** Every recorded turn file, `turn-*.jsonl`. */
export const WIRE_TURN_FILES: string[] = readdirSync(DIR).filter((name) => /^turn-.*\.jsonl$/.test(name))

/** A recorded file, one parsed event per line. Throws on a line the contract refuses. */
export const wireEvents = (name: string): WireEvent[] =>
  readFileSync(join(DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => eventOf(JSON.parse(line) as Record<string, unknown>))

/** A raw frame: the envelope plus `body`, as the server writes it. */
export const frameOf = (seq: number, body: Record<string, unknown>, turnId = 'turn-1'): Record<string, unknown> => ({
  v: 2,
  conversation_id: 'conv_1',
  turn_id: turnId,
  seq,
  ts: 1_759_000_000_000 + seq * 10,
  ...body,
})

/** A raw frame parsed; throws when the contract refuses it, so a spec cannot fold a typo. */
export const eventOf = (raw: Record<string, unknown>): WireEvent => {
  const event = parseWireEvent(raw)
  if (!event) throw new Error(`not a v2 event: ${JSON.stringify(raw).slice(0, 200)}`)
  return event
}
