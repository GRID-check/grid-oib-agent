/**
 * Live-activity derivation — a FILTER, not a renderer.
 *
 * The header line answers one question: what is the assistant doing right now,
 * said in the reader's own nouns. The bar every phrase must clear is that you
 * can finish "…so the reader knows that ___" with something from THEIR world —
 * their question, their sources, an OIB-Richtlinie, a skill's name. If the only
 * honest completion names a mechanism — a function, a graph node, a model id, a
 * byte count, a catalogue size — the step does not belong on this line. It is
 * still visible, verbatim, in the opt-in technical steps panel; that is where a
 * log stream belongs.
 *
 * So there is deliberately NO "show the step's own name" fallback any more.
 * That fallback is what manufactured the noise: it took any unknown internal
 * name, title-cased it, and presented an identifier dressed up as a status —
 * "Use Skill …", "Workflow: Chat Researcher", "Running Nemotron 3 Nano 30B …".
 * An unclassifiable step now falls back to the newest step that CAN be phrased,
 * and failing that to the caller's calm generic ("Antwort wird erstellt …").
 * Prefer silence over noise: a calm generic beats a truthful-but-meaningless
 * mechanism name.
 *
 * One line at a time. It replaces; it never accumulates.
 */

import {
  isSkillSelectionStepName,
  isSkillStepName,
  isUseSkillStepName,
  parseSkillActivity,
  skillLabel,
} from '@/features/skills/lib/skill-activity'
import type { ThinkingStep } from '../types'
import { isLLMModel } from './intermediate-step-parser'

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
  | 'usingSkill'
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
 * The phrase for a skill step, or `undefined` when this step is not about a
 * skill and the ordinary rules should decide.
 *
 * Exactly ONE skill fact is worth the reader's line: which skill is shaping
 * this answer. `activated` (the agent chose it) and `loaded` (its instructions
 * are in context) are two halves of that same fact, so they produce the SAME
 * phrase rather than a two-beat "wird geladen …" → "wird angewendet …" log.
 *
 * Everything else about skills is filtered out here:
 *   • `offered` is availability, and availability is never activity — that is
 *     the phantom-Websuche rule applied to a new event.
 *   • `skill_selection` carries how many skills were offered and which were
 *     pinned: catalogue size is a number the reader cannot act on.
 *   • `body_chars` and friends are plumbing and never reach a phrase.
 * Filtered steps return `null`, which sends the header to the previous
 * meaningful phrase or the calm generic.
 */
const skillActivityPhrase = (
  step: ThinkingStep,
  t: (key: string) => string
): string | null | undefined => {
  const name = (step.functionName || '').trim()

  // The legacy LangChain tool: it names the MECHANISM, and title-cased it read
  // "Use Skill …" — English, in a German UI. Unnamed but honest, and about a
  // thing the reader knows (skills are a product concept they attach with `/`).
  if (isUseSkillStepName(name)) return t('thinking.activity.usingSkillUnnamed')
  if (isSkillSelectionStepName(name)) return null
  if (!isSkillStepName(name)) return undefined

  const activity = parseSkillActivity(step.content ?? step.rawPayload)
  if (!activity || activity.phase === 'offered') return null

  const named = skillLabel(activity)
  if (!named) return null

  return t('thinking.activity.usingSkill').replace('{name}', named.text)
}

/**
 * The phrase a single step would produce, or `null` when it produces none.
 *
 * `null` is the filter doing its job — a scaffolding node, an availability
 * event, or an internal name we refuse to dress up as a status.
 */
const phraseFor = (step: ThinkingStep, t: (key: string) => string): string | null => {
  const name = (step.functionName || '').trim()
  if (!name) return null

  const skillPhrase = skillActivityPhrase(step, t)
  if (skillPhrase !== undefined) return skillPhrase

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
 * Scans the still-open steps newest-first and takes the first one that can be
 * phrased for a reader. A COMPLETED step must never drive the "right now"
 * phrase — after `Function Complete: web_search_tool` the backend goes quiet
 * while the LLM composes, and reusing that finished step left the header
 * shimmering "Searching the web …" for the whole compose phase. Walking the
 * remaining OPEN steps is what makes an unphraseable step degrade gracefully:
 * a sub-call we cannot name sits inside a parent we can, so the header holds
 * the parent's meaningful phrase instead of flashing an identifier.
 * Deep-research steps are excluded upstream by the caller, matching the rest of
 * ChatThinking.
 *
 * @param steps  the turn's thinking steps (newest last)
 * @param t      a `chat`-namespace translator
 * @returns a ready-to-render phrase, or `null` when nothing open can be phrased
 *          (the caller then shows the generic working copy)
 */
export const deriveLiveActivity = (
  steps: ThinkingStep[],
  t: (key: string) => string
): string | null => {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step.isComplete) continue
    const phrase = phraseFor(step, t)
    if (phrase) return phrase
  }
  return null
}
