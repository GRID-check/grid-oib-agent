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
 * **The wire carries KEYS, not sentences.** An event ships `key` (a stable
 * dotted id) plus `values` (interpolation data only), and THIS side owns every
 * word in every locale. The first cut shipped finished German prose in `text`,
 * which the live line rendered verbatim — so an English-locale reader read
 * German. `TURN_EVENT_KEYS` below is the closed set of ids we can phrase; an id
 * outside it renders NOTHING, because the alternative is printing an
 * identifier, and this product has already shipped "Use Skill …" once.
 *
 * Three further properties of the wire are load-bearing and easy to get wrong:
 *
 * 1. **`channel` is a hard rule, not a hint.** `technical` events exist for the
 *    opt-in details panel and must never reach the live line. The backend makes
 *    that structurally safe by omitting `key` on them — so a renderer that only
 *    ever resolves `key` cannot leak telemetry even if it ignores `channel`.
 *    Both checks are applied here anyway.
 * 2. **`text` is the legacy field, read but never written.** A backend from
 *    before the key change still sends a finished German sentence; rendering it
 *    is strictly better than a blank line for the one release it takes to roll
 *    forward, and `key` always wins where both are present. Nothing in this
 *    repo emits `text` any more, and the Python side has a test that says so.
 * 3. **NAT html-escapes the payload** (`html.escape(..., quote=False)`), so
 *    `&`, `<` and `>` arrive encoded. A quoted user query really does contain
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
     * The stable dotted id of the sentence to show (`status.retrieval.withQuery`,
     * `skill.activated`). Present ONLY on live events — absent is the backend's
     * structural guarantee that telemetry cannot be rendered as status.
     */
    key: z.string().optional().catch(undefined),
    /**
     * Interpolation data for `key`, and nothing else. Values are proper nouns
     * that read the same in every language (a skill's authored title), ids the
     * dictionary names itself (`corpus`), or the reader's own words echoed back
     * (`query`) — never prose the backend wrote.
     */
    values: z.record(z.string()).optional().catch(undefined),
    /**
     * LEGACY: a finished German sentence from a pre-`key` backend. Read as a
     * fallback for one release, never written. See the header.
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
 * Every turn-event key this UI can phrase, and where it looks it up.
 *
 * A closed set on purpose. `createTranslator` falls back to the KEY ITSELF for
 * a miss (and only warns outside production), so resolving an unrecognised id
 * would put `status.retrieval.withQuery` on the live line as if it were a
 * status — the same class of bug as title-casing `use_skill` into "Use Skill".
 * Anything not listed here renders nothing at all, and the caller falls back to
 * the previous meaningful phrase.
 *
 * The dictionary path is the `chat` namespace plus this prefix plus the key, so
 * `status.citations` lives at `chat.thinking.turnStatus.status.citations` and
 * `skill.activated` at `chat.thinking.skill.activated`.
 */
export const TURN_EVENT_KEYS: Record<string, string> = {
  'status.documents.archiv': 'thinking.turnStatus.',
  'status.documents.project': 'thinking.turnStatus.',
  'status.documents.session': 'thinking.turnStatus.',
  'status.documents.several': 'thinking.turnStatus.',
  'status.routing.meta': 'thinking.turnStatus.',
  'status.routing.outOfScope': 'thinking.turnStatus.',
  'status.routing.shallow': 'thinking.turnStatus.',
  'status.routing.deep': 'thinking.turnStatus.',
  'status.retrieval.withQuery': 'thinking.turnStatus.',
  'status.retrieval.plain': 'thinking.turnStatus.',
  'status.action.remember': 'thinking.turnStatus.',
  'status.action.card': 'thinking.turnStatus.',
  'status.citations': 'thinking.turnStatus.',
  'status.escalation': 'thinking.turnStatus.',
  // Skill keys drop the `skill.` segment: it is already the dictionary group.
  'skill.activated': 'thinking.',
  'skill.forced': 'thinking.',
}

/** Keys whose template has a `{corpus}` slot filled from a list of corpus ids. */
const CORPUS_KEYS = new Set(['status.retrieval.withQuery', 'status.retrieval.plain'])

/** Corpus ids the dictionary can name. Anything else is dropped, not printed. */
const CORPUS_IDS = new Set(['knowledge', 'ris', 'web', 'documents', 'ifc'])

/** A `chat`-namespace translator. Structural, so no i18n import is needed here. */
export type StepEventTranslator = (
  key: string,
  vars?: Record<string, string | number>
) => string

/**
 * The `{corpus}` slot: corpus IDS named and joined in the reader's language.
 *
 * The backend sends `knowledge,ris` because "im OIB-Wissen" is product copy
 * with a German preposition welded on, and the "und" between two of them is
 * grammar. Both belong here. An id we cannot name is dropped; if that leaves
 * nothing, the whole line is dropped rather than shown with an empty slot.
 */
const corpusPhrase = (raw: string, t: StepEventTranslator): string | null => {
  const named = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => CORPUS_IDS.has(id))
    .map((id) => t(`thinking.turnStatus.corpus.${id}`))
  if (named.length === 0) return null
  return named.join(t('thinking.turnStatus.corpusJoin'))
}

/**
 * Resolve a turn-event key and its values to one sentence, or `null`.
 *
 * `null` for an unknown key, and for a key whose values cannot be resolved —
 * silence beats an identifier, and beats a template with a hole in it.
 */
export const renderTurnEventKey = (
  key: string,
  values: Record<string, string> | undefined,
  t: StepEventTranslator
): string | null => {
  const prefix = TURN_EVENT_KEYS[key]
  if (prefix === undefined) return null

  const vars: Record<string, string> = { ...(values ?? {}) }
  if (CORPUS_KEYS.has(key)) {
    const phrase = corpusPhrase(vars.corpus ?? '', t)
    if (!phrase) return null
    vars.corpus = phrase
  }

  const rendered = t(`${prefix}${key}`, vars).trim()
  // Belt and braces against the translator's key-as-fallback: a key listed
  // above but missing from the dictionary must still not reach the screen.
  return rendered && rendered !== `${prefix}${key}` ? rendered : null
}

/**
 * The sentence this payload may be shown as on the live line, or `null`.
 *
 * Both gates, deliberately: `channel === 'live'` is the contract, a present
 * `key` is the structural guarantee. A payload from an older backend that
 * carries one but no channel is trusted — the absence of the field is not a
 * `technical` marking.
 *
 * `key` wins over `text` wherever both are present: `text` exists only so a UI
 * deployed ahead of its backend still says something for one release.
 */
export const stepEventLiveText = (
  payload: StepEventPayload,
  t: StepEventTranslator
): string | null => {
  if (payload.channel === 'technical') return null
  const key = payload.key?.trim()
  if (key) return renderTurnEventKey(key, payload.values, t)
  const legacy = payload.text?.trim()
  return legacy ? legacy : null
}
