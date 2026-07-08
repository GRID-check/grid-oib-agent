/**
 * Agent-group registry — the org-admin-facing override points for runtime
 * model configuration (ADR-0014, docs/architecture/org-model-configuration.md).
 *
 * Each group carries the capability REQUIREMENTS a model must satisfy to be
 * selectable for it. The requirements are checked against the OpenRouter
 * model catalog (`GET /api/v1/models`: `supported_parameters`,
 * `context_length`, `architecture.input_modalities`) both when the picker
 * lists models AND server-side on every save — the catalog filter is the
 * "only allow appropriate models for the task" contract.
 *
 * The id set mirrors `AgentGroup` in src/aiq_agent/common/model_overrides.py
 * (the backend consumer of the override header) — keep the two in sync.
 */

export interface AgentGroupRequirements {
  /** Every entry must appear in the model's `supported_parameters`. */
  requiredParameters: string[]
  /** Model's `context_length` must be at least this. */
  minContextLength: number
}

export interface AgentGroupDefinition {
  id: string
  label: string
  description: string
  /**
   * Names of the workflow-config LLMs (`llms:` block) this group re-points.
   * Used to resolve the group's "workflow default" model from the backend's
   * /v1/config/llm-defaults endpoint — keep these exact config keys.
   */
  configLlmRefs: string[]
  requirements: AgentGroupRequirements
}

export const AGENT_GROUPS: AgentGroupDefinition[] = [
  {
    id: 'intent',
    label: 'Intent & routing',
    description:
      'Classifies each message (meta vs research, shallow vs deep) and writes short meta answers. High-frequency, latency-sensitive.',
    configLlmRefs: ['intent_llm'],
    requirements: { requiredParameters: [], minContextLength: 16384 },
  },
  {
    id: 'clarifier',
    label: 'Clarifier',
    description:
      'Asks clarification questions and drafts research plans before deep research. Calls tools (e.g. web search) for context.',
    configLlmRefs: ['clarifier_llm'],
    requirements: { requiredParameters: ['tools'], minContextLength: 32768 },
  },
  {
    id: 'shallow_research',
    label: 'Shallow research',
    description: 'The default research agent: iterative tool-calling over knowledge and web sources.',
    configLlmRefs: ['shallow_llm'],
    requirements: { requiredParameters: ['tools'], minContextLength: 65536 },
  },
  {
    id: 'deep_research',
    label: 'Deep research',
    description:
      'Orchestrator, planner, researcher, and report writer of multi-phase deep research. The heaviest reasoning and longest contexts in the system.',
    configLlmRefs: ['deep_orchestrator_llm', 'deep_planner_llm', 'deep_researcher_llm'],
    requirements: { requiredParameters: ['tools'], minContextLength: 131072 },
  },
  {
    id: 'deep_research_router',
    label: 'Deep-research source router',
    description: 'Routes deep-research subtasks to data sources. Small, high-frequency structured outputs.',
    configLlmRefs: ['deep_router_llm'],
    requirements: { requiredParameters: [], minContextLength: 16384 },
  },
  {
    id: 'memory_reflection',
    label: 'Memory reflection',
    description:
      'Post-answer background pass that distills durable project memory from a finished turn. Cost-sensitive; runs after every substantive answer when enabled.',
    configLlmRefs: ['card_llm'],
    requirements: { requiredParameters: [], minContextLength: 32768 },
  },
]

export const AGENT_GROUP_IDS = AGENT_GROUPS.map((group) => group.id)

export function getAgentGroup(id: string): AgentGroupDefinition | undefined {
  return AGENT_GROUPS.find((group) => group.id === id)
}

/** OpenRouter model ids are `author/slug` with an optional `:variant` suffix. */
export const OPENROUTER_MODEL_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.:-]{1,128}$/
