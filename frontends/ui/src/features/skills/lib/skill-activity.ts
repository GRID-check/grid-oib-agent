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
 *   3. neither — `null`, and the caller DROPS the row.
 *
 * A skill id is an identifier, not prose: it is never title-cased or otherwise
 * rewritten.
 *
 * The live line is not decided here. The fold keeps the `skill.activated` turn
 * event only for a live, visible activation with an authored title
 * (`toStoredStep`), so a titleless id never reaches the header.
 */

import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'

export type SkillActivityPhase = 'offered' | 'activated' | 'loaded'

/** The skill a stored `skill` step records. */
export interface SkillActivity {
  phase: SkillActivityPhase
  name?: string
  title?: string
  hidden: boolean
}

const PHASES: readonly string[] = ['offered', 'activated', 'loaded']

/** The skill fact of a `skill` step, or `null` for any other step. */
export const skillActivityOf = (
  step: Pick<StoredThinkingStep, 'kind' | 'skill' | 'detail'>
): SkillActivity | null => {
  if (step.kind !== 'skill') return null
  const { phase, hidden, title } = step.detail ?? {}
  if (typeof phase !== 'string' || !PHASES.includes(phase)) return null
  return {
    phase: phase as SkillActivityPhase,
    ...(step.skill ? { name: step.skill } : {}),
    ...(typeof title === 'string' && title ? { title } : {}),
    hidden: hidden === true,
  }
}

/**
 * How a skill should be written on screen.
 *
 * `mono` is information, not a styling preference: a bare id is rendered
 * `font-mono` so the reader can tell a machine name from an authored title.
 */
export interface SkillLabel {
  text: string
  mono: boolean
}

/** The one naming rule. `null` means "this cannot be named" — drop the row. */
export const skillLabel = (
  skill: { name?: string | null; title?: string | null } | null | undefined
): SkillLabel | null => {
  const title = skill?.title?.trim()
  if (title) return { text: title, mono: false }
  const name = skill?.name?.trim()
  if (name) return { text: name, mono: true }
  return null
}
