/**
 * Turn-event intermediate-step payloads (backend → UI wire contract).
 *
 * The agent narrates itself with custom NAT steps that ride the ordinary
 * `system_intermediate_message` channel — no new frame type. Two families, one
 * payload shape (see `aiq_agent/common/turn_status.py` and
 * `aiq_agent/skills/events.py`):
 *
 *   `status:<slot>`      — what the turn is doing (`routing`, `retrieval:0`,
 *                          `documents`, `citations`, `escalation`).
 *   `skill:<skillname>`  — one step per skill, so N skills stay N steps.
 *   `skill_selection`    — the catalogue, round-level.
 *
 * ONE schema for both, because the backend serialises one shape on purpose:
 * every consumer parses the same object, and a field added later cannot break
 * a reader that does not know about it. `kind` discriminates.
 *
 * Two properties of the wire are load-bearing and easy to get wrong:
 *
 * 1. **`channel` is a hard rule, not a hint.** `technical` events exist for the
 *    opt-in details panel and must never reach the live line. The backend makes
 *    that structurally safe by omitting `text` on them — so a renderer that
 *    only ever prints `text` cannot leak telemetry even if it ignores
 *    `channel`. Both checks are applied here anyway.
 * 2. **NAT html-escapes the payload** (`html.escape(..., quote=False)`), so
 *    `&`, `<` and `>` arrive encoded. German status text really does contain
 *    `&`, and `JSON.parse` throws on the raw form — hence the single-pass
 *    unescape fallback in `parseStepEventPayloads`.
 *
 * Everything past `kind` is optional with its own `.catch(undefined)` and the
 * object is `.passthrough()`: one malformed detail degrades to "absent" rather
 * than discarding the event. `exclude_none` on the backend means absent is
 * absent — never null.
 */

import { z } from 'zod'

/** Where an event is allowed to be shown. */
export const StepEventChannelSchema = z.enum(['live', 'technical'])
export type StepEventChannel = z.infer<typeof StepEventChannelSchema>

/** Which family the event belongs to. */
export const StepEventKindSchema = z.enum(['status', 'skill'])
export type StepEventKind = z.infer<typeof StepEventKindSchema>

/** A skill's position in the turn. */
export const SkillPhaseSchema = z.enum(['offered', 'activated', 'loaded'])
export type SkillPhase = z.infer<typeof SkillPhaseSchema>

export const StepEventPayloadSchema = z
  .object({
    kind: StepEventKindSchema.optional().catch(undefined),
    channel: StepEventChannelSchema.optional().catch(undefined),
    /**
     * The German sentence a reader may be shown. Present ONLY on live events —
     * absent is the backend's structural guarantee that telemetry cannot be
     * rendered as status.
     */
    text: z.string().optional().catch(undefined),

    // ── status extras ──────────────────────────────────────────────────────
    slot: z.string().optional().catch(undefined),
    intent: z.string().optional().catch(undefined),
    depth: z.string().optional().catch(undefined),
    /** Routing/escalation rationale, in the classifier's own words. */
    reason: z.string().optional().catch(undefined),
    tools: z.array(z.string()).optional().catch(undefined),
    query: z.string().optional().catch(undefined),
    shelves: z.array(z.string()).optional().catch(undefined),
    source_count: z.number().optional().catch(undefined),

    // ── skill extras ───────────────────────────────────────────────────────
    phase: SkillPhaseSchema.optional().catch(undefined),
    /** The skill id — a routing key, never a label. */
    name: z.string().optional().catch(undefined),
    /** The skill's authored `grid-title`. Absent when the author gave none. */
    title: z.string().optional().catch(undefined),
    description: z.string().optional().catch(undefined),
    origin: z.string().optional().catch(undefined),
    /** `activated` only — the USER named this skill rather than the model. */
    forced: z.boolean().optional().catch(undefined),
    offered_count: z.number().optional().catch(undefined),
    forced_names: z.array(z.string()).optional().catch(undefined),
    body_chars: z.number().optional().catch(undefined),
  })
  .passthrough()

export type StepEventPayload = z.infer<typeof StepEventPayloadSchema>

/**
 * Undo NAT's `html.escape(..., quote=False)` in ONE pass.
 *
 * One pass matters: decoding `&amp;` before `&lt;` would re-unescape an
 * attacker-supplied `&amp;lt;` into `<`. A single replace visits each entity
 * exactly once, so an encoded entity stays literal.
 */
export const unescapeStepPayload = (raw: string): string =>
  raw.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => {
    const decodes: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
    }
    return decodes[entity]
  })

/**
 * Every balanced top-level `{…}` substring, in order.
 *
 * A step's payload is not one object: the adaptor wraps it in markdown and
 * repeats it under `**Function Output:**` on the Complete frame, and the store
 * appends later phases of the same step to the same content. Brace matching is
 * string-aware, so a `}` inside a quoted German sentence does not close the
 * object, and it survives pretty-printing where a line split would not.
 */
const balancedObjects = (raw: string): string[] => {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        out.push(raw.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/**
 * Parse every turn-event payload carried by a step, oldest first.
 *
 * Returns `[]` for an ordinary step — this is the ONLY place the wire form is
 * decoded, so callers never touch raw payload text.
 */
export const parseStepEventPayloads = (
  payload: string | null | undefined
): StepEventPayload[] => {
  if (!payload || !payload.trim()) return []

  const out: StepEventPayload[] = []
  for (const candidate of balancedObjects(payload)) {
    let json: unknown
    try {
      json = JSON.parse(candidate)
    } catch {
      // Still escaped (raw payload, or a consumer that skipped `formatPayload`).
      try {
        json = JSON.parse(unescapeStepPayload(candidate))
      } catch {
        continue
      }
    }
    const parsed = StepEventPayloadSchema.safeParse(json)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/**
 * The sentence this payload may be shown as on the live line, or `null`.
 *
 * Both gates, deliberately: `channel === 'live'` is the contract, a present
 * `text` is the structural guarantee. A payload from an older backend that
 * carries text but no channel is trusted — the absence of the field is not a
 * `technical` marking.
 */
export const stepEventLiveText = (payload: StepEventPayload): string | null => {
  if (payload.channel === 'technical') return null
  const text = payload.text?.trim()
  return text ? text : null
}
