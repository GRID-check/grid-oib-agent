/**
 * Intermediate Step Parser
 *
 * Utilities for parsing and processing intermediate step messages
 * from the WebSocket backend (NAT protocol).
 *
 * Categories are maintained for data organization and potential future features,
 * but are not used for UI display in the current ChatThinking component.
 */

import {
  isSkillSelectionStepName,
  isSkillStepName,
  skillNameFromStepName,
} from '@/features/skills/lib/skill-activity'
import type { Translator } from '@/i18n'
import { isStatusStepName } from './turn-events'
import type { IntermediateStepCategory } from '../types'

/**
 * Mapping of function names to their data categories.
 * Used for persistence and data organization.
 */
const CATEGORY_MAP: Record<string, IntermediateStepCategory> = {
  '<workflow>': 'tasks',
  intent_classifier: 'agents',
  depth_router: 'agents',
  shallow_research_agent: 'agents',
  deep_research_agent: 'agents',
  meta_chatter: 'agents',
  chat_deepresearcher_agent: 'agents',
  web_search_tool: 'tools',
  tavily_search: 'tools',
  // The agent's skill machinery: `use_skill` is a real LangChain tool, and the
  // narration steps around it describe the same capability, so they file under
  // the same category rather than inventing a fourth one.
  use_skill: 'tools',
  skill_selection: 'tools',
}

/**
 * Default category for unknown function names
 */
const DEFAULT_CATEGORY: IntermediateStepCategory = 'agents'

/**
 * Result of parsing a function name from the backend
 */
export interface ParsedFunctionName {
  /** The raw function name (e.g., "web_search_tool") */
  functionName: string
  /** Whether this is a "Function Start" (false) or "Function Complete" (true) */
  isComplete: boolean
}

/**
 * Parse the function name and status from the backend message name.
 * Backend format: "Function Start: <function_name>" or "Function Complete: <function_name>"
 *
 * @param name - The raw name field from backend (e.g., "Function Start: web_search_tool")
 * @returns Parsed function name and completion status
 */
export const parseFunctionName = (name: string): ParsedFunctionName => {
  // Match patterns like "Function Start: xyz" or "Function Complete: xyz"
  const startMatch = name.match(/^Function Start:\s*(.+)$/i)
  if (startMatch) {
    return {
      functionName: startMatch[1].trim(),
      isComplete: false,
    }
  }

  const completeMatch = name.match(/^Function Complete:\s*(.+)$/i)
  if (completeMatch) {
    return {
      functionName: completeMatch[1].trim(),
      isComplete: true,
    }
  }

  // Fallback: treat the whole name as the function name
  return {
    functionName: name.trim(),
    isComplete: false,
  }
}

/**
 * Map a function name to its data category for persistence.
 *
 * @param functionName - The function name (e.g., "web_search_tool")
 * @returns The category for data organization
 */
export const mapFunctionToCategory = (functionName: string): IntermediateStepCategory => {
  // Names that carry a variable suffix (`skill:<skillname>`,
  // `status:retrieval:<n>`) cannot be map keys.
  if (isSkillStepName(functionName)) return 'tools'
  // A status one-liner is about the TURN, not about an agent or a tool.
  if (isStatusStepName(functionName)) return 'tasks'
  return CATEGORY_MAP[functionName] ?? DEFAULT_CATEGORY
}

/**
 * Check if a name represents an LLM model rather than a function/tool.
 * LLM models typically have format: "provider/org/model-name" or contain slashes.
 *
 * @param name - The name to check (e.g., "nvidia/nvidia/Nemotron-3-Nano-30B-A3B")
 * @returns True if this appears to be an LLM model name
 */
export const isLLMModel = (name: string): boolean => {
  return name.includes('/') && !name.startsWith('Function') && !name.startsWith('Tool:')
}

/**
 * Check if a name has the "Tool:" prefix (LLM announcing tool call).
 *
 * @param name - The name to check (e.g., "Tool: web_search_tool")
 * @returns True if this has the "Tool:" prefix
 */
export const hasToolPrefix = (name: string): boolean => {
  return name.startsWith('Tool:')
}

/**
 * Whether the backend step name is a top-level function (Function Start/Complete).
 * Such steps are shown as main list items; others (model, Tool: ...) are shown indented.
 */
export const isFunctionStepName = (rawName: string): boolean => {
  return /^Function (Start|Complete):/i.test(rawName?.trim() ?? '')
}

/**
 * Legacy ingest label for the root workflow step (chat_deepresearcher_agent).
 *
 * Kept because the ingest paths still stamp it onto the step they persist; it
 * is no longer what the reader sees — `getStepLabel` names that node from the
 * dictionary, so the label is localised and identical for a live turn and a
 * turn restored from the server.
 */
export const getWorkflowDisplayName = (functionName: string): string => {
  if (functionName === 'chat_deepresearcher_agent') {
    return 'Workflow: Chat Researcher'
  }
  return ''
}

/**
 * Reader-facing label for a known node, as an i18n key under `chat.thinking.*`.
 *
 * A map, not a formatter: what the backend puts on the wire is an internal id
 * (`knowledge_search`, `intent_classifier`), and NAT additionally forwards
 * LangChain span names — CamelCase class names that no amount of snake_case
 * splitting turns into prose. Deriving a label from the id therefore either
 * fabricates an English noun phrase in a German UI ("Use Skill") or hands the
 * reader a class name verbatim. Both were happening; this decides the wording
 * once, and the dictionary owns the words in the reader's own locale.
 *
 * Entries a chip already names reuse the `stepName.*` keys of the "Ausgeführt:"
 * row, so a node cannot be worded one way there and another way here.
 */
const NODE_LABEL_KEYS: Record<string, string> = {
  '<workflow>': 'nodeName.workflow',
  chat_deepresearcher_agent: 'nodeName.workflow',
  intent_classifier: 'stepName.understanding',
  depth_router: 'stepName.routing',
  clarifier_agent: 'nodeName.clarification',
  ask_user: 'nodeName.askUser',
  // The shallow node doubles as the conversational assistant (greetings,
  // capability questions, memory) AND the quick-lookup path — so "Shallow
  // Research Agent" mislabels a simple greeting as a research run. It reads
  // neutrally, as the assistant, for every turn it handles.
  shallow_research_agent: 'stepName.assistant',
  shallow_research: 'stepName.assistant',
  meta_chatter: 'stepName.assistant',
  deep_research_agent: 'nodeName.deepResearch',
  deep_research: 'nodeName.deepResearch',
  data_sources: 'nodeName.dataSources',
  web_search_tool: 'stepName.webSearch',
  advanced_web_search_tool: 'stepName.webSearch',
  tavily_search: 'stepName.webSearch',
  knowledge_search: 'stepName.corpus',
  knowledge_retrieval: 'stepName.corpus',
  ris_search_tool: 'stepName.ris',
  ris_fetch_tool: 'stepName.ris',
  ris_catalog_lookup_tool: 'stepName.ris',
  remember: 'nodeName.note',
  emit_card: 'nodeName.card',
  describe_card: 'nodeName.card',
  surface_documents: 'nodeName.documents',
  ifc_query: 'nodeName.model',
  ifc_measure: 'nodeName.measure',
  compliance_check: 'nodeName.compliance',
  // `use_skill` is the MECHANISM, not the skill — labelled honestly and
  // unnamed, exactly as the chip row labels it.
  use_skill: 'stepName.skillUnnamed',
}

/** The label for a node this build has no entry for. */
const UNKNOWN_NODE_KEY = 'nodeName.internal'

/** Lookup form of a step name: `Tool: use_skill` and `use_skill` are one node. */
const nodeKeyOf = (functionName: string): string | undefined =>
  NODE_LABEL_KEYS[functionName.trim().replace(/^Tool:\s*/i, '').toLowerCase()]

/** A model id humanised by its last path segment: `google/gemini-3.6-flash`. */
const modelLabel = (name: string): string =>
  name
    .split('/')
    .slice(-1)[0]
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

/**
 * The names that ARE the label — identifiers the reader is meant to see
 * verbatim, so no dictionary is involved and no locale applies.
 *
 * Returns `null` for everything else, which is the signal that the wording has
 * to come from the dictionary.
 */
const verbatimIdentifier = (functionName: string): string | null => {
  const name = functionName.trim()
  // A skill name is an IDENTIFIER, not prose. `skill:oib-brandschutz` must read
  // "oib-brandschutz" and never "Oib Brandschutz" — the same class of mistake
  // that made `use_skill` render as the English "Use Skill" in a German UI. The
  // user-facing labels come from `features/skills/lib/skill-activity`; this is
  // only the technical panel, and even there the raw name is right.
  if (isSkillStepName(name)) return skillNameFromStepName(name) ?? name
  // Status slots are identifiers too (`status:retrieval:0`) — and a CLOSED,
  // learnable vocabulary, which is why they stay raw here while an unrecognised
  // node name does not. The reader-facing wording is the payload's own
  // sentence, rendered on the live line; here — the opt-in technical panel —
  // the raw slot is what a power user came for.
  if (isStatusStepName(name)) return name
  return null
}

/**
 * The model a step ran, when the step IS a model call — `null` otherwise.
 *
 * A model id is a name, not an internal node: "Gemini 3.6 Flash" is what the
 * vendor calls it, so it is spelled out rather than translated. The
 * deep-research stream prefixes the same thing with `llm:`.
 */
const modelName = (functionName: string): string | null => {
  const name = functionName.trim()
  const llmStep = name.match(/^llm:\s*(.+)$/i)
  if (llmStep) return modelLabel(llmStep[1])
  return isLLMModel(name) ? modelLabel(name) : null
}

/**
 * Locale-free name for a step, or `''` when only the dictionary can name it.
 *
 * This is what the ingest paths persist on the step. It deliberately no longer
 * title-cases an unknown identifier into a plausible English phrase: the empty
 * string means "nobody has named this", which `getStepLabel` answers from the
 * dictionary in the reader's locale — including for turns restored from the
 * server, whose stored labels were written by an older build.
 *
 * @param functionName - The raw function name (e.g., "web_search_tool", "<workflow>")
 * @returns The identifier the reader should see verbatim, or `''`
 */
export const getDisplayName = (functionName: string): string =>
  verbatimIdentifier(functionName) ?? modelName(functionName) ?? ''

/** The subset of a step `getStepLabel` reads. */
export interface StepLabelInput {
  functionName: string
  displayName?: string
}

/**
 * The label the technical panel renders for one step.
 *
 * Order of authority: an identifier that is its own label, then this build's
 * dictionary, then a name some other path deliberately supplied (the
 * deep-research stream writes "Planner > Kimi K2", which says more than either
 * half alone), then the model behind an unnamed model call, and only then the
 * neutral fallback. An internal identifier reaches the reader through none of
 * them — the ingest paths stopped persisting one (`getDisplayName`), so the
 * `displayName` rung carries only names somebody chose.
 *
 * @param step - The step's function name, plus any name already attached to it
 * @param t    - A `chat`-namespace translator
 */
export const getStepLabel = (step: StepLabelInput, t: Translator): string => {
  const verbatim = verbatimIdentifier(step.functionName)
  if (verbatim) return verbatim
  if (isSkillSelectionStepName(step.functionName)) return t('thinking.nodeName.skillSelection')
  const key = nodeKeyOf(step.functionName)
  if (key) return t(`thinking.${key}`)
  return (
    step.displayName?.trim() ||
    modelName(step.functionName) ||
    t(`thinking.${UNKNOWN_NODE_KEY}`)
  )
}

/**
 * Clean up and format the payload content for storage/display.
 * Removes excessive markdown formatting and Python repr noise.
 *
 * @param payload - The raw payload string from backend
 * @returns Cleaned and formatted content
 */
export const formatPayload = (payload: string): string => {
  if (!payload) return ''

  let cleaned = payload

  // Remove "**Function Input:**" and "**Function Output:**" headers
  cleaned = cleaned.replace(/\*\*Function Input:\*\*/gi, '')
  cleaned = cleaned.replace(/\*\*Function Output:\*\*/gi, '')

  // Remove code block markers for python/json
  cleaned = cleaned.replace(/```(?:python|json)?\n?/gi, '')
  cleaned = cleaned.replace(/```/g, '')

  // Decode HTML entities in ONE regex pass. Sequential replaces decode
  // `&amp;` before `&quot;`/`&#39;`, so an attacker-controlled `&amp;quot;`
  // re-unescapes to `"` — the double-unescape the CodeQL rule forbids. A
  // single pass replaces each entity exactly once; an entity that is itself
  // encoded stays literal (`&amp;amp;` → `&amp;`).
  cleaned = cleaned.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => {
    const decodes: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
    }
    return decodes[entity]
  })

  // Clean up Python repr formatting (e.g., "type=<ChatContentType.TEXT: 'text'>")
  cleaned = cleaned.replace(/<\w+\.\w+:\s*'[^']*'>/g, (match) => {
    // Extract the value part (e.g., 'text' from "<ChatContentType.TEXT: 'text'>")
    const valueMatch = match.match(/:\s*'([^']*)'/)
    return valueMatch ? `'${valueMatch[1]}'` : match
  })

  // Trim whitespace
  cleaned = cleaned.trim()

  return cleaned
}
