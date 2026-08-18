/**
 * Skill activity — the ONE authority for naming a skill in the UI.
 *
 * A skill shows up in three places on a turn: the live header line while it is
 * being applied, the "Ran:" chip in the Herleitung, and the post-hoc
 * `SkillsUsedDisclosure` under the finished answer. Those must never disagree
 * about what a skill is called, so none of them formats a name itself — they
 * all call `skillLabel`, and the degradation ladder lives here:
 *
 *   1. `title` — an authored, human-readable label → proportional text.
 *   2. `name`  — the bare `/identifier` → `font-mono`, matching how
 *      `SkillsUsedDisclosure` has always rendered a name.
 *   3. neither — `null`, and the caller DROPS the step. A skill row that cannot
 *      name its skill says nothing true, and "Use Skill …" (the mechanism,
 *      title-cased, in English) is exactly the non-answer this replaces.
 *
 * A skill name is an identifier, not prose: it is never title-cased, never
 * snake_case-expanded, and never otherwise rewritten. `getDisplayName`'s
 * snake_case→Title Case path must not touch it.
 */

import {
  SkillActivityPayloadSchema,
  type SkillActivityPhaseWire,
} from '@/adapters/api/skill-activity-schemas'

/** Prefix of the per-skill intermediate step: `skill:<skillname>`. */
export const SKILL_STEP_PREFIX = 'skill:'

/** The round-level intermediate step describing the whole offer/choice decision. */
export const SKILL_SELECTION_STEP = 'skill_selection'

/**
 * The legacy signal: `use_skill` is an ordinary LangChain tool, so before the
 * `skill:` steps existed this was the only trace that a skill ran — and it
 * names the MECHANISM, not the skill. Kept recognised (so it can be labelled
 * honestly and, once richer `skill:` steps are present, suppressed) but never
 * treated as a skill identity.
 */
export const USE_SKILL_TOOL = 'use_skill'

export type SkillActivityPhase = SkillActivityPhaseWire

/** A parsed skill-activity step, in UI camelCase. */
export interface SkillActivity {
  phase: SkillActivityPhase
  name?: string
  title?: string
  description?: string
  origin?: string
  forced?: boolean
  offeredCount?: number
  forcedNames?: string[]
  bodyChars?: number
}

/** Whether a step's function name is the per-skill `skill:<skillname>` step. */
export const isSkillStepName = (functionName: string): boolean =>
  functionName.trim().toLowerCase().startsWith(SKILL_STEP_PREFIX)

/** Whether a step's function name is the round-level `skill_selection` step. */
export const isSkillSelectionStepName = (functionName: string): boolean =>
  functionName.trim().toLowerCase() === SKILL_SELECTION_STEP

/** Whether a step's function name is the legacy `use_skill` tool call. */
export const isUseSkillStepName = (functionName: string): boolean =>
  functionName.trim().toLowerCase() === USE_SKILL_TOOL

/**
 * The skill name carried by the step NAME itself (`skill:oib-brandschutz` →
 * `oib-brandschutz`), or `null` for any other step. This is the fallback
 * identity when the payload is missing or malformed — the name is in the step
 * name too, so a broken payload must not cost us the one fact we have.
 */
export const skillNameFromStepName = (functionName: string): string | null => {
  const trimmed = functionName.trim()
  if (!isSkillStepName(trimmed)) return null
  const name = trimmed.slice(SKILL_STEP_PREFIX.length).trim()
  return name.length > 0 ? name : null
}

/**
 * Pull the balanced top-level `{…}` objects out of a payload blob.
 *
 * Needed because the three phases of one skill arrive under the SAME step name,
 * and the store appends each payload to the step's content — so by the time a
 * surface reads it, `content` can hold several JSON objects separated by
 * newlines. Brace-matching (string-aware, so a `}` inside a quoted value does
 * not close the object) is used rather than a line split because a
 * pretty-printed payload spans lines.
 */
const extractJsonObjects = (raw: string): string[] => {
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
 * Parse a skill-activity step payload.
 *
 * Returns the LAST well-formed object in the blob, because the phases accumulate
 * in run order and the newest one is the current state of that skill (`loaded`
 * supersedes `activated` supersedes `offered`). Returns `null` when nothing in
 * the blob validates — the caller then falls back to the step name, or drops
 * the step.
 */
export const parseSkillActivity = (payload: string | undefined | null): SkillActivity | null => {
  if (!payload || !payload.trim()) return null

  const candidates = extractJsonObjects(payload)
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let json: unknown
    try {
      json = JSON.parse(candidates[i])
    } catch {
      continue
    }
    const parsed = SkillActivityPayloadSchema.safeParse(json)
    if (!parsed.success) continue
    const p = parsed.data
    return {
      phase: p.phase,
      ...(p.name?.trim() ? { name: p.name.trim() } : {}),
      ...(p.title?.trim() ? { title: p.title.trim() } : {}),
      ...(p.description?.trim() ? { description: p.description.trim() } : {}),
      ...(p.origin?.trim() ? { origin: p.origin.trim() } : {}),
      ...(p.forced !== undefined ? { forced: p.forced } : {}),
      ...(p.offered_count !== undefined ? { offeredCount: p.offered_count } : {}),
      ...(p.forced_names !== undefined ? { forcedNames: p.forced_names } : {}),
      ...(p.body_chars !== undefined ? { bodyChars: p.body_chars } : {}),
    }
  }
  return null
}

/**
 * How a skill should be written on screen.
 *
 * `mono` is information, not styling preference: a bare identifier is rendered
 * `font-mono` (as `SkillsUsedDisclosure` already does) so the reader can tell a
 * machine name from an authored title at a glance.
 */
export interface SkillLabel {
  text: string
  mono: boolean
}

/**
 * The one naming rule. `null` means "this cannot be named" — drop the row.
 *
 * @param skill  a parsed activity, or any `{ name?, title? }` (the post-hoc
 *               disclosure passes a plain name; the catalogue may add a title).
 */
export const skillLabel = (
  skill: { name?: string | null; title?: string | null } | null | undefined
): SkillLabel | null => {
  const title = skill?.title?.trim()
  if (title) return { text: title, mono: false }
  const name = skill?.name?.trim()
  if (name) return { text: name, mono: true }
  return null
}

/**
 * The label for a skill step given its function name and raw payload — the
 * combination every streamed surface actually has. Falls back to the name
 * encoded in the step name when the payload is unusable.
 */
export const skillLabelForStep = (
  functionName: string,
  payload?: string | null
): SkillLabel | null => {
  const activity = parseSkillActivity(payload)
  const fallbackName = skillNameFromStepName(functionName)
  return skillLabel({
    title: activity?.title,
    name: activity?.name ?? fallbackName,
  })
}
