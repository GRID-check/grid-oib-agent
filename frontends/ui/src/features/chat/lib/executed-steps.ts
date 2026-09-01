/**
 * Executed-step chips for the Herleitung basis area.
 *
 * Derives "what actually ran" from the turn's thinking steps — one compact chip
 * per executed agent/tool (Einordnung · Websuche · OIB-Korpus · RIS …), in run
 * order, without the technical-steps opt-in. A chip marked `running` belongs to
 * the step still in progress, so the row doubles as a quiet "this is the active
 * one" cue while streaming.
 *
 * Two rules decide what gets a chip, and both are about the reader:
 *
 * 1. Only ACTIVITY. A skill step is admitted once it reports `activated` or
 *    `loaded`; a skill that was merely `offered`, and the round-level
 *    `skill_selection` bookkeeping, are availability. Rendering availability
 *    here is precisely the bug that had every turn claiming a web search.
 * 2. Only steps we can NAME in the reader's own nouns. A function with no
 *    reader-facing label is dropped rather than title-cased into a plausible
 *    English phrase — "Use Skill", "Workflow: Chat Researcher" and the like are
 *    identifiers dressed up as work. The step itself stays visible in the
 *    opt-in technical steps panel, which is where a log stream belongs — as a
 *    timestamped row under a neutral label, since that panel stopped showing
 *    internal names too (`getStepLabel`).
 *
 * The `status:<slot>` turn events are excluded outright. They are SENTENCES
 * about the turn, not tools that ran, and NAT reports them as top-level
 * functions — so left alone they would land here under raw machine names, and
 * `status:retrieval:0` would even match the corpus rule and duplicate the chip
 * belonging to the retrieval tool it was describing. Their home is the live
 * line.
 *
 * Which is why nothing here resolves a turn event's `key`: the only turn event
 * that earns a chip is a skill, and a skill chip is not a sentence — it is the
 * skill's NAME in a frontend-owned template (`thinking.stepName.skill`), read
 * off the structured `title`/`name` fields through the one label authority.
 * Every word on this row already comes from the dictionary, in the reader's
 * locale, and no backend-authored prose has ever reached it.
 */

import {
  isSkillSelectionStepName,
  isSkillStepName,
  isUseSkillStepName,
  parseSkillActivity,
  skillLabel,
} from '@/features/skills/lib/skill-activity'
import { isLLMModel } from './intermediate-step-parser'
import { isStatusStepName, stepEventPayload } from './turn-events'
import type { ThinkingStep } from '../types'

export interface ExecutedStep {
  /** Dedup key (the raw function name). */
  key: string
  /** Full chip text — `prefix` + `mono` when those are set. */
  label: string
  /**
   * Leading, proportional part of the label (e.g. `Skill:`). Set only together
   * with `mono`; a plain chip has neither and renders `label` as-is.
   */
  prefix?: string
  /**
   * Trailing machine identifier, rendered `font-mono` — a skill's bare
   * `/identifier` when it has no authored title, matching how
   * `SkillsUsedDisclosure` renders the same fact under the finished answer.
   */
  mono?: string
  running: boolean
}

/** The subset of a thinking step this derivation reads. */
export type ExecutedStepInput = Pick<ThinkingStep, 'functionName' | 'isComplete'> &
  Partial<Pick<ThinkingStep, 'displayName' | 'isDeepResearch' | 'content' | 'rawPayload'>>

/** i18n keys under `chat.thinking.stepName.*`, matched on the lowercased function name. */
const STEP_NAME_RULES: Array<{ match: RegExp; key: string }> = [
  { match: /intent|classif/, key: 'understanding' },
  { match: /depth_router|router/, key: 'routing' },
  { match: /web[_-]?search|tavily/, key: 'webSearch' },
  { match: /ris/, key: 'ris' },
  { match: /knowledge|retriev|corpus/, key: 'corpus' },
  { match: /shallow|meta_chatter|assistant/, key: 'assistant' },
  { match: /read|fetch/, key: 'reading' },
]

/**
 * The reader-facing noun for a tool/agent step, or `null` when we have none.
 *
 * Exported because the Herleitung's truncation line needs the SAME answer this
 * row's chips give: named in the reader's own nouns where a rule exists, and
 * otherwise not named at all rather than title-cased into a plausible English
 * phrase. A caller with no label may still show the bare identifier as an
 * identifier (`font-mono`) — that is the established ladder, and it is what
 * `skillLabel` does for a skill with no authored title.
 */
export const stepNameLabel = (functionName: string, t: (key: string) => string): string | null => {
  const rule = STEP_NAME_RULES.find((r) => r.match.test((functionName || '').toLowerCase()))
  return rule ? t(`thinking.stepName.${rule.key}`) : null
}

/** Function names that are graph scaffolding, not user-meaningful steps. */
const SKIP_RE = /^<workflow>$|^chat_deepresearcher_agent$/i

/**
 * Build the skill chip for a `skill:<skillname>` step, or `null` to drop it.
 *
 * Dropped when the step reports only `offered` (availability), when the payload
 * is unreadable — in which case we cannot tell an offer from an activation and
 * must not guess in the direction that overclaims — or when the skill cannot be
 * named at all.
 */
const skillChip = (
  step: ExecutedStepInput,
  t: (key: string) => string
): Pick<ExecutedStep, 'label' | 'prefix' | 'mono'> | null => {
  const activity = parseSkillActivity(stepEventPayload(step))
  if (!activity) return null
  if (activity.phase === 'offered') return null

  const named = skillLabel(activity)
  if (!named) return null

  const template = t('thinking.stepName.skill')
  const label = template.replace('{name}', named.text)
  if (!named.mono) return { label }
  return { label, prefix: template.split('{name}')[0].trim(), mono: named.text }
}

/**
 * @param steps  the turn's thinking steps (newest last)
 * @param t      a `chat`-namespace translator
 */
export const deriveExecutedSteps = (
  steps: ExecutedStepInput[],
  t: (key: string) => string
): ExecutedStep[] => {
  // Keyed by what the reader SEES, not by the internal tool name.
  //
  // `ris_search_tool`, `ris_fetch_tool` and `ris_catalog_lookup_tool` are three
  // names for one chip („RIS"), and `knowledge_search` shares its rule with
  // every other retrieval tool. Deduplicating on the raw name therefore printed
  // the same word two or three times in a row — „RIS, RIS, RIS" — which reads
  // as a stutter rather than as three tools, and told the reader nothing the
  // first chip had not. A chip stands for a KIND of work; the row is a list of
  // what was done, not a call log.
  //
  // Skills keep their own identity: two named skills are two different things
  // and each has earned its chip.
  const seen = new Map<string, ExecutedStep>()
  const out: ExecutedStep[] = []
  let sawNamedSkill = false

  for (const step of steps) {
    const name = (step.functionName || '').trim()
    if (!name || step.isDeepResearch) continue
    if (SKIP_RE.test(name) || isLLMModel(name)) continue
    // Round-level skill bookkeeping (how many were offered, which were pinned)
    // is availability, not activity — it never earns a chip.
    if (isSkillSelectionStepName(name)) continue
    // Status one-liners are sentences, not executed tools (see the header).
    if (isStatusStepName(name)) continue

    if (isSkillStepName(name)) {
      const chip = skillChip(step, t)
      if (!chip) continue
      const existing = seen.get(`skill:${name}`)
      if (existing) {
        existing.running = !step.isComplete
        continue
      }
      const entry = { key: name, ...chip, running: !step.isComplete }
      seen.set(`skill:${name}`, entry)
      sawNamedSkill = true
      out.push(entry)
      continue
    }

    // `use_skill` is the MECHANISM, not the skill: title-cased it reads "Use
    // Skill", which is English, and names the machinery rather than what was
    // applied. Label it honestly and unnamed; the richer `skill:` chips
    // supersede it below when the backend emits them.
    if (isUseSkillStepName(name)) {
      const label = t('thinking.stepName.skillUnnamed')
      const existing = seen.get(`label:${label}`)
      if (existing) {
        existing.running = !step.isComplete
        continue
      }
      const entry = { key: name, label, running: !step.isComplete }
      seen.set(`label:${label}`, entry)
      out.push(entry)
      continue
    }

    const rule = STEP_NAME_RULES.find((r) => r.match.test(name.toLowerCase()))
    // No reader-facing label — an internal name. It is NOT title-cased into a
    // chip here; the step still shows up (timestamped, neutrally labelled) in
    // the technical steps panel for anyone who opts in, and a fabricated
    // English noun phrase would only look like work that was done.
    if (!rule) continue

    const label = t(`thinking.stepName.${rule.key}`)
    const existing = seen.get(`label:${label}`)
    if (existing) {
      // A later step under the same chip REPLACES the running flag — steps are
      // newest last, so a completed run must clear a chip an earlier
      // in-progress entry marked as running (restored turns carry both rows).
      existing.running = !step.isComplete
      continue
    }
    const entry = { key: name, label, running: !step.isComplete }
    seen.set(`label:${label}`, entry)
    out.push(entry)
  }

  // One fact, one chip: when named skill steps are present they say everything
  // the bare `use_skill` chip said and more, so the mechanism chip drops out
  // rather than sitting beside them claiming a second skill ran.
  return sawNamedSkill ? out.filter((chip) => !isUseSkillStepName(chip.key)) : out
}
