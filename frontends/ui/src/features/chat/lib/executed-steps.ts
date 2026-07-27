/**
 * Executed-step chips for the Herleitung basis area.
 *
 * Derives "what actually ran" from the turn's thinking steps — one compact chip
 * per executed agent/tool (Einordnung · Websuche · OIB-Korpus · RIS …), in run
 * order, without the technical-steps opt-in. Known functions get a localized
 * noun label; unknown functions honestly fall back to the step's own display
 * name. A chip marked `running` belongs to the step still in progress, so the
 * row doubles as a quiet "this is the active one" cue while streaming.
 */

import { isLLMModel } from './intermediate-step-parser'
import type { ThinkingStep } from '../types'

export interface ExecutedStep {
  /** Dedup key (the raw function name). */
  key: string
  label: string
  running: boolean
}

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

/** Function names that are graph scaffolding, not user-meaningful steps. */
const SKIP_RE = /^<workflow>$|^chat_deepresearcher_agent$/i

/**
 * @param steps  the turn's thinking steps (newest last)
 * @param t      a `chat`-namespace translator
 */
export const deriveExecutedSteps = (
  steps: Array<Pick<ThinkingStep, 'functionName' | 'displayName' | 'isComplete' | 'isDeepResearch'>>,
  t: (key: string) => string
): ExecutedStep[] => {
  const seen = new Set<string>()
  const out: ExecutedStep[] = []
  for (const step of steps) {
    const name = (step.functionName || '').trim()
    if (!name || step.isDeepResearch) continue
    if (SKIP_RE.test(name) || isLLMModel(name)) continue
    if (seen.has(name)) {
      // A later re-run of the same tool REPLACES the running flag — steps are
      // newest last, so a completed re-run must clear a chip an earlier
      // in-progress entry marked as running (restored turns carry both rows).
      const existing = out.find((e) => e.key === name)
      if (existing) existing.running = !step.isComplete
      continue
    }
    seen.add(name)
    const rule = STEP_NAME_RULES.find((r) => r.match.test(name.toLowerCase()))
    const label = rule ? t(`thinking.stepName.${rule.key}`) : step.displayName?.trim() || name
    out.push({ key: name, label, running: !step.isComplete })
  }
  return out
}
