/**
 * Skill activity — the ONE authority for naming a skill in the UI.
 *
 * A skill shows up in three places on a turn: the live header line while it is
 * being applied, the "Ran:" chip in the Herleitung, and the post-hoc
 * `SkillsUsedDisclosure` under the finished answer. Those must never disagree
 * about what a skill is called, so none of them formats a name itself — they
 * all call `skillLabel`, and the degradation ladder lives here:
 *
 *   1. `title` — the authored `grid-title` → proportional text.
 *   2. `name`  — the bare id → `font-mono`, matching how
 *      `SkillsUsedDisclosure` has always rendered a name.
 *   3. neither — `null`, and the caller DROPS the row. A skill row that cannot
 *      name its skill says nothing true, and "Use Skill …" (the mechanism,
 *      title-cased, in English) is exactly the non-answer this replaces.
 *
 * A skill id is an identifier, not prose: it is never title-cased, never
 * snake_case-expanded, and never otherwise rewritten. `getDisplayName`'s
 * snake_case→Title Case path must not touch it.
 *
 * The LIVE line is stricter than the ladder. An id like
 * `oib-brandschutznachweis-2024` in a status line is worse than silence, and
 * synthesising a title from it would make a missing name indistinguishable
 * from a real one — so the backend marks a titleless activation `technical`
 * and withholds its `key`, and `liveSkillActivity` honours that rather than
 * second-guessing it.
 *
 * The sentence itself is NOT the backend's to write. An activation ships the
 * key `skill.activated` or `skill.forced` plus `{ skill: <title> }`, and this
 * side renders it from `chat.thinking.skill.*` in whichever locale is reading.
 * The title travels verbatim because it is the office's own name for their own
 * method — the one value here that is the same word in every language.
 */

import {
  parseStepEventPayloads,
  renderTurnEventKey,
  stepEventLiveText,
  type SkillPhase,
  type StepEventChannel,
  type StepEventPayload,
  type StepEventTranslator,
} from '@/adapters/api/step-event-schemas'

/** Prefix of the per-skill intermediate step: `skill:<skillname>`. */
export const SKILL_STEP_PREFIX = 'skill:'

/** The round-level step recording the catalogue this turn was given. */
export const SKILL_SELECTION_STEP = 'skill_selection'

/**
 * The legacy signal: `use_skill` is an ordinary LangChain tool, so before the
 * `skill:` steps existed this was the only trace that a skill ran — and it
 * names the MECHANISM, not the skill. It arrives as `use_skill` or, when the
 * LLM announces the call, as `Tool: use_skill`. Kept recognised so it can be
 * labelled honestly and suppressed once richer events are present, but never
 * treated as a skill identity.
 */
export const USE_SKILL_TOOL = 'use_skill'

export type SkillActivityPhase = SkillPhase

/** A parsed skill event, in UI camelCase. */
export interface SkillActivity {
  phase: SkillActivityPhase
  channel?: StepEventChannel
  /** The stable dotted id of the sentence. Present only on live events. */
  key?: string
  /** Interpolation data for `key` — `{ skill: <authored title> }`. */
  values?: Record<string, string>
  /** LEGACY: a finished German sentence from a pre-`key` backend. */
  text?: string
  name?: string
  title?: string
  description?: string
  origin?: string
  forced?: boolean
  offeredCount?: number
  forcedNames?: string[]
  bodyChars?: number
}

/** A step name with any `Tool:` announcement prefix removed, lowercased. */
const normalise = (functionName: string): string =>
  (functionName || '').trim().replace(/^tool:\s*/i, '').toLowerCase()

/** Whether a step's function name is the per-skill `skill:<skillname>` step. */
export const isSkillStepName = (functionName: string): boolean =>
  normalise(functionName).startsWith(SKILL_STEP_PREFIX)

/** Whether a step's function name is the round-level `skill_selection` step. */
export const isSkillSelectionStepName = (functionName: string): boolean =>
  normalise(functionName) === SKILL_SELECTION_STEP

/** Whether a step's function name is the legacy `use_skill` tool call. */
export const isUseSkillStepName = (functionName: string): boolean =>
  normalise(functionName) === USE_SKILL_TOOL

/**
 * The skill id carried by the step NAME itself (`skill:oib-brandschutz` →
 * `oib-brandschutz`), or `null` for any other step. This is the fallback
 * identity when the payload is missing or malformed — the id is in the step
 * name too, so a broken payload must not cost us the one fact we have.
 */
export const skillNameFromStepName = (functionName: string): string | null => {
  const trimmed = (functionName || '').trim().replace(/^Tool:\s*/i, '')
  if (!isSkillStepName(trimmed)) return null
  const name = trimmed.slice(SKILL_STEP_PREFIX.length).trim()
  return name.length > 0 ? name : null
}

const toActivity = (payload: StepEventPayload): SkillActivity | null => {
  if (!payload.phase) return null
  return {
    phase: payload.phase,
    ...(payload.channel ? { channel: payload.channel } : {}),
    ...(payload.key?.trim() ? { key: payload.key.trim() } : {}),
    ...(payload.values ? { values: payload.values } : {}),
    ...(payload.text?.trim() ? { text: payload.text.trim() } : {}),
    ...(payload.name?.trim() ? { name: payload.name.trim() } : {}),
    ...(payload.title?.trim() ? { title: payload.title.trim() } : {}),
    ...(payload.description?.trim() ? { description: payload.description.trim() } : {}),
    ...(payload.origin?.trim() ? { origin: payload.origin.trim() } : {}),
    ...(payload.forced !== undefined ? { forced: payload.forced } : {}),
    ...(payload.offered_count !== undefined ? { offeredCount: payload.offered_count } : {}),
    ...(payload.forced_names !== undefined ? { forcedNames: payload.forced_names } : {}),
    ...(payload.body_chars !== undefined ? { bodyChars: payload.body_chars } : {}),
  }
}

/**
 * Every skill event in a step's payload, oldest first.
 *
 * A step carries several: the adaptor repeats the object under
 * `**Function Output:**`, and `activated` is followed by `loaded` under the
 * same step name, which the store appends to the same content.
 */
export const parseSkillActivities = (payload: string | null | undefined): SkillActivity[] =>
  parseStepEventPayloads(payload)
    .map(toActivity)
    .filter((activity): activity is SkillActivity => activity !== null)

/**
 * The skill's current state: the NEWEST event on the step, because the phases
 * supersede one another (`loaded` after `activated` after `offered`).
 */
export const parseSkillActivity = (payload: string | null | undefined): SkillActivity | null => {
  const all = parseSkillActivities(payload)
  return all.length > 0 ? all[all.length - 1] : null
}

/**
 * The newest event on this step that MAY drive the live line, or `null`.
 *
 * Not simply the newest event: `loaded` follows `activated` on the same step
 * and is technical, so taking the last one would blank the line the instant
 * the instructions arrived — the reader would see the skill announce itself
 * and vanish.
 */
export const liveSkillActivity = (payload: string | null | undefined): SkillActivity | null => {
  const all = parseSkillActivities(payload)
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const activity = all[i]
    if (activity.phase !== 'activated') continue
    if (activity.channel === 'technical') continue
    // A titleless activation is telemetry by contract; the backend withholds
    // its key, and we do not invent one. (`text` is the legacy backend's
    // finished sentence — see the module header.)
    if (!activity.key && !activity.text?.trim()) continue
    return activity
  }
  return null
}

/**
 * How a skill should be written on screen.
 *
 * `mono` is information, not a styling preference: a bare id is rendered
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
 * combination every streamed surface actually has. Falls back to the id
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

/**
 * The live sentence for a skill step, or `null` when it must stay silent.
 *
 * @param t a `chat`-namespace translator
 */
export const skillLiveText = (
  payload: string | null | undefined,
  t: StepEventTranslator
): string | null => {
  const activity = liveSkillActivity(payload)
  if (!activity) return null
  if (activity.key) return renderTurnEventKey(activity.key, activity.values, t)
  const legacy = activity.text?.trim()
  return legacy ? legacy : null
}

export { stepEventLiveText }
