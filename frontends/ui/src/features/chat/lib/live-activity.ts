/**
 * Live-activity derivation — a FILTER, not a renderer.
 *
 * The header line answers one question: what is the assistant doing right now,
 * said in the reader's own nouns. The bar every phrase must clear is that you
 * can finish "…so the reader knows that ___" with something from THEIR world —
 * their question, the corpus being searched, the skill shaping the answer. If
 * the only honest completion names a mechanism (a function, a graph node, a
 * model id, a character count, a catalogue size), the step does not belong on
 * this line. It stays visible, verbatim, in the opt-in technical panel; that is
 * where a log stream belongs.
 *
 * Two eras, and the newer one wins wherever it exists:
 *
 * **Turn events (`status:<slot>`, `skill:<id>`).** The backend states what it
 * is doing at the moment it does it, and only marks `live` what a reader can
 * use. It states it as a stable KEY plus interpolation VALUES — never as a
 * sentence, because a sentence has a language and the reader picked theirs —
 * and the phrasing comes from this side's dictionary. What those events carry
 * that the frontend cannot know is the FACTS: which corpus, and the actual
 * query (*Sucht im OIB-Wissen: „Fluchtweglänge GK4“*), the routing decision,
 * the skill's authored title. So once a turn carries any turn event, the line
 * is driven by those events ALONE: a generic *Quellen werden durchsucht …*
 * derived from a tool name would otherwise overwrite the better sentence a
 * second later, purely because the tool span opens after the status that
 * announced it.
 *
 * A turn event whose key this UI cannot phrase resolves to nothing and the loop
 * keeps walking back to the newest event that CAN be phrased — the same
 * silence-over-noise rule as below, applied to the newer era.
 *
 * **Legacy classification.** Without turn events (an older backend, a turn that
 * emitted none) the line falls back to matching the function name, exactly as
 * before. There is deliberately NO "show the step's own name" fallback: that is
 * what manufactured the noise, taking any unknown internal name, title-casing
 * it, and presenting an identifier dressed up as a status — "Use Skill …",
 * "Workflow: Chat Researcher", "Running Nemotron 3 Nano 30B …". An
 * unclassifiable step falls through to the newest step that CAN be phrased, and
 * failing that to the caller's calm generic ("Antwort wird erstellt …").
 * Prefer silence over noise.
 *
 * One line at a time. It replaces; it never accumulates.
 */

import type { StepEventTranslator } from '@/adapters/api/step-event-schemas'
import { isUseSkillStepName } from '@/features/skills/lib/skill-activity'
import type { ThinkingStep } from '../types'
import { isLLMModel } from './intermediate-step-parser'
import { isTurnEventStepName, turnEventLiveText } from './turn-events'

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
  | 'usingSkillUnnamed'

/**
 * Graph scaffolding: the root workflow node and the deep-research container.
 * They are open for the whole turn and say nothing about the moment — and
 * `chat_deepresearcher_agent` would otherwise match the `research` rule and
 * announce "Recherche läuft …" over a bare greeting, the same overclaim as the
 * phantom web search. `executed-steps` skips them for the same reason.
 */
const SCAFFOLD_RE = /^<workflow>$|^chat_deepresearcher_agent$/i

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
  // The shallow node doubles as the conversational assistant, so it must not
  // fall through to the `research` rule and call a greeting a Recherche. What
  // it is doing, from where the reader sits, is writing the answer.
  { match: /shallow|meta_chatter/, key: 'composing' },
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
 * The legacy phrase for a single step, or `null` when it produces none.
 *
 * `null` is the filter doing its job — a scaffolding node or an internal name
 * we refuse to dress up as a status.
 */
const legacyPhrase = (step: ThinkingStep, t: StepEventTranslator): string | null => {
  const name = (step.functionName || '').trim()
  if (!name) return null

  // `use_skill` names the MECHANISM, and title-cased it read "Use Skill …" —
  // English, in a German UI. Honest and unnamed instead. (Superseded entirely
  // once the backend emits `skill:<id>` events, which carry the skill's title.)
  if (isUseSkillStepName(name)) return t('thinking.activity.usingSkillUnnamed')

  if (SCAFFOLD_RE.test(name)) return null

  const key = classify(name)
  if (key) return t(`thinking.activity.${key}`)

  // An LLM step IS the compose phase, and its name is the MODEL. Which model
  // answers is an implementation detail of the product, not a fact about the
  // user's question. Say what is happening instead of who is doing it.
  if (isLLMModel(name)) return t('thinking.activity.composing')

  // Unclassifiable: an internal name we have no reader-facing phrase for. It
  // stays in the technical steps panel; it does not become a status line.
  return null
}

/**
 * Resolve the current live-activity phrase.
 *
 * @param steps  the turn's thinking steps (newest last)
 * @param t      a `chat`-namespace translator
 * @returns a ready-to-render phrase, or `null` when nothing can be phrased
 *          (the caller then shows the generic working copy)
 */
export const deriveLiveActivity = (
  steps: ThinkingStep[],
  t: StepEventTranslator
): string | null => {
  // ── The turn narrated itself ────────────────────────────────────────────
  // Newest first, and completeness is irrelevant here: a turn event is pushed
  // as a balanced START/END pair, so it is finished the instant it exists. It
  // marks what happens NEXT, which is exactly what the line should say.
  const hasTurnEvents = steps.some((step) => isTurnEventStepName(step.functionName || ''))
  if (hasTurnEvents) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i]
      if (!isTurnEventStepName(step.functionName || '')) continue
      const text = turnEventLiveText(step, t)
      if (text) return text
    }
    return null
  }

  // ── Legacy: infer from the function name ────────────────────────────────
  // A COMPLETED step must never drive the "right now" phrase — after
  // `Function Complete: web_search_tool` the backend goes quiet while the LLM
  // composes, and reusing that finished step left the header shimmering
  // "Searching the web …" for the whole compose phase. Walking the remaining
  // OPEN steps is what makes an unphraseable step degrade gracefully: a
  // sub-call we cannot name sits inside a parent we can, so the header holds
  // the parent's meaningful phrase instead of flashing an identifier.
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step.isComplete) continue
    const phrase = legacyPhrase(step, t)
    if (phrase) return phrase
  }
  return null
}
