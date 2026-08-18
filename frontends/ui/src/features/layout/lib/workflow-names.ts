/**
 * Reader-facing names for the part of a research run a card came from.
 *
 * The thought and tool-call cards carry a line saying where the inference or
 * the tool call happened. It used to interpolate the backend's raw value —
 * „über researcher-agent" — which is a kebab-case identifier standing in the
 * middle of a German sentence. The reader has never been told that word, it is
 * not a vocabulary anybody can learn, and it is not even the product's own
 * name for that work.
 *
 * This is the same fix `chat/lib/intermediate-step-parser` made for the trace
 * step labels: a MAP from identifier to i18n key, resolved at render time, with
 * an identifier this build cannot name resolving to a neutral phrase rather
 * than leaking verbatim. As there, nothing is dropped — a card whose origin
 * this map has no entry for still says that the work happened somewhere
 * internal, because the panel above it counts its cards and a silently
 * origin-less card would make the count and the list disagree.
 *
 * ## Where the identifiers come from, and why they are their own group
 *
 * The value is `metadata.workflow` on the deep-research SSE stream, which
 * `aiq_api/jobs/callbacks.py` fills with the name of the nearest enclosing
 * LangChain chain whose name contains "agent" (`_is_agent_like` /
 * `_find_agent_for_run`). In the deep-research graph those names are the four
 * subagent roles declared in `aiq_agent/agents/deep_researcher/factory.py`:
 * `planner-agent`, `researcher-agent`, `source-router-agent`, `writer-agent`.
 * The orchestrator itself is not one — "orchestrator" does not contain "agent",
 * so no card is ever attributed to it.
 *
 * They are a group of their own rather than entries in `chat.thinking.nodeName`
 * because the two vocabularies do not meet. `nodeName` names NAT function ids
 * (`shallow_research_agent`, `intent_classifier`, `knowledge_search`) — the
 * nodes of a chat turn's graph. These are the roles WITHIN one deep-research
 * run, and not one identifier appears in both lists. Filing them under
 * `nodeName` would put two unrelated vocabularies in one namespace; restating
 * `nodeName`'s words here for ids that never arrive would be the parallel
 * vocabulary that drifts.
 */

import type { Translator } from '@/i18n'

/**
 * Deep-research role → the `research.workflowName.*` key naming it.
 *
 * The words describe the WORK, not our tiers: the reader is told that Piloti
 * was planning, researching, choosing sources or writing the report, which is
 * the wording the rest of the research surface already uses.
 */
const WORKFLOW_LABEL_KEYS: Record<string, string> = {
  'planner-agent': 'planning',
  'researcher-agent': 'research',
  'source-router-agent': 'sourceSelection',
  'writer-agent': 'writing',
}

/**
 * The name for an origin this build has no entry for.
 *
 * Reachable in practice: the same backend rule accepts any chain whose name
 * merely CONTAINS "agent", so a graph-internal node name can arrive here, and
 * a run of an older or a differently configured backend can send a role this
 * build predates. None of those is a word for a reader, so the card says only
 * that the step was an internal one.
 */
const UNKNOWN_WORKFLOW_KEY = 'internal'

/**
 * The name of the part of the run a card belongs to.
 *
 * @param workflow - The raw `metadata.workflow` value (e.g. "researcher-agent")
 * @param t        - A `research`-namespace translator
 */
export const getWorkflowLabel = (workflow: string, t: Translator): string =>
  t(`workflowName.${WORKFLOW_LABEL_KEYS[workflow.trim().toLowerCase()] ?? UNKNOWN_WORKFLOW_KEY}`)
