/**
 * Live-activity derivation.
 *
 * Turns the raw stream of thinking steps into a single human phrase describing
 * what the assistant is doing *right now* — so a long wait says "Searching your
 * sources …" instead of a flat "Working on a response …". The phrase is derived
 * only from real streamed step data (the newest step's function name); when a
 * step can't be classified we fall back to its own display name, and when there
 * is no step at all the caller shows the generic working copy. Nothing is
 * fabricated.
 */

import type { ThinkingStep } from '../types'

/** i18n keys under `chat.thinking.activity.*`, one per recognised activity. */
export type LiveActivityKey =
  | 'understanding'
  | 'planning'
  | 'searchingKnowledge'
  | 'searchingRis'
  | 'searchingWeb'
  | 'searchingSources'
  | 'researching'
  | 'reading'
  | 'composing'

/**
 * Ordered keyword → activity rules. First match on the (lowercased) function
 * name wins, so more specific buckets are listed before broader ones (e.g.
 * "web_search" resolves to the web bucket before the generic "search" rule,
 * and "knowledge_search" / "ris_search_tool" get their own OIB/RIS labels
 * before the generic sources rule's `lookup`/`knowledge` keywords).
 */
const ACTIVITY_RULES: Array<{ match: RegExp; key: LiveActivityKey }> = [
  { match: /intent|classif|understand/, key: 'understanding' },
  { match: /web[_-]?search|tavily|serp|google|bing/, key: 'searchingWeb' },
  { match: /knowledge/, key: 'searchingKnowledge' },
  { match: /ris[_-]?(search|catalog|fetch)/, key: 'searchingRis' },
  { match: /retriev|corpus|vector|embed|rag|index|lookup|qdrant/, key: 'searchingSources' },
  { match: /read|fetch|crawl|scrape|extract|parse|open[_-]?url|browse/, key: 'reading' },
  { match: /depth|rout|plan|decompos|strateg/, key: 'planning' },
  { match: /research/, key: 'researching' },
  { match: /chatter|writ|report|compose|answer|respond|generat|synthes|summar|draft/, key: 'composing' },
  // Generic search fallback (checked after the specific web/source buckets).
  { match: /search|query/, key: 'searchingSources' },
]

const classify = (functionName: string): LiveActivityKey | null => {
  const name = functionName.toLowerCase()
  for (const rule of ACTIVITY_RULES) {
    if (rule.match.test(name)) return rule.key
  }
  return null
}

/**
 * The step that best represents the current moment: the newest step still in
 * progress, or `null` when every step is complete. A COMPLETED step must never
 * drive the "right now" phrase — after `Function Complete: web_search_tool`
 * the backend goes quiet while the LLM composes, and falling back to that
 * finished step left the header shimmering "Searching the web …" for the whole
 * compose phase. When nothing is running the caller shows the generic working
 * copy instead. Deep-research steps are excluded upstream by the caller,
 * matching the rest of ChatThinking.
 */
const currentStep = (steps: ThinkingStep[]): ThinkingStep | null => {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (!steps[i].isComplete) return steps[i]
  }
  return null
}

/**
 * Resolve the current live-activity phrase.
 *
 * @param steps  the turn's thinking steps (newest last)
 * @param t      a `chat`-namespace translator
 * @returns a ready-to-render phrase, or `null` when there is no step yet
 *          (the caller then shows the generic working copy)
 */
export const deriveLiveActivity = (
  steps: ThinkingStep[],
  t: (key: string) => string
): string | null => {
  const step = currentStep(steps)
  if (!step) return null

  const key = classify(step.functionName)
  if (key) return t(`thinking.activity.${key}`)

  // Unclassified but real: surface the step's own display name so the user
  // still sees a concrete, honest signal rather than a generic placeholder.
  const name = step.displayName?.trim()
  return name ? t('thinking.activity.runningNamed').replace('{name}', name) : null
}
