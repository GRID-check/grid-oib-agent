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
  /**
   * True when this group runs with reasoning DISABLED at the backend
   * (`reasoning_effort: none`). Reasoning-mandatory models must not be
   * selectable here — OpenRouter returns HTTP 400 "Reasoning is mandatory
   * for this endpoint and cannot be disabled" and breaks every call.
   * Enforced via `isReasoningSafeForOff` in openrouter.ts.
   */
  reasoningOff?: boolean
  /**
   * True when this group sends IMAGES to the model (a vision task). The model's
   * `architecture.input_modalities` must include `image`, else it cannot see
   * the page/drawing and ingestion produces empty captions. Enforced in
   * `validateModelForGroup`; self-skips when a (BYOK) catalog carries no
   * modality metadata, matching the text-input check.
   */
  requiresImageInput?: boolean
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
    // The intent LLM runs with reasoning disabled: config_oib_openrouter.yml
    // `intent_llm` sets `reasoning_effort: none`. Pointing this group at a
    // reasoning-mandatory model (incident: org override `intent ->
    // x-ai/grok-4.5`) makes OpenRouter reject every intent call with HTTP 400
    // "Reasoning is mandatory for this endpoint and cannot be disabled".
    // `reasoningOff` filters those out via a denylist of known reasoning-only
    // families (isReasoningSafeForOff); hybrid models that accept reasoning-off
    // — nearly the whole modern catalog — stay selectable.
    requirements: { requiredParameters: [], minContextLength: 16384, reasoningOff: true },
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
  {
    id: 'follow_ups',
    label: 'Follow-up questions',
    description:
      'Post-answer background pass that reads the finished answer and proposes the two to four questions it just made askable. Short structured output; runs on substantive answers when enabled.',
    configLlmRefs: ['follow_ups_llm'],
    // Reasoning is deliberately OFF for this group (config_oib_openrouter.yml
    // `follow_ups_llm` sets `reasoning_effort: none`): the stage declares a hard
    // output-token ceiling, and on a reasoning-mandatory model the reasoning
    // tokens are spent against that same ceiling, so the JSON body is truncated
    // and a working stage silently becomes one that returns nothing.
    requirements: { requiredParameters: [], minContextLength: 32768, reasoningOff: true },
  },
  {
    id: 'ingest_vlm',
    label: 'Document vision (ingestion)',
    description:
      'Captions images and describes vector/scanned drawings (plans, sections, elevations, perspectives) during document ingestion. Must be a vision model that accepts image input.',
    // The ingestion VLM is env-configured (AIQ_VLM_MODEL), not a `llms:` entry;
    // the backend reports its default under the synthetic `vlm` key from
    // /v1/config/llm-defaults (see config_info.py) so this group still shows a
    // "workflow default".
    configLlmRefs: ['vlm'],
    // Vision is the only hard requirement — a caption call needs no tools and
    // little context; the image dominates the payload. minContextLength 0
    // avoids excluding otherwise-valid vision models.
    requirements: { requiredParameters: [], minContextLength: 0, requiresImageInput: true },
  },
]

export const AGENT_GROUP_IDS = AGENT_GROUPS.map((group) => group.id)

export function getAgentGroup(id: string): AgentGroupDefinition | undefined {
  return AGENT_GROUPS.find((group) => group.id === id)
}

/** OpenRouter model ids are `author/slug` with an optional `:variant` suffix. */
export const OPENROUTER_MODEL_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.:-]{1,128}$/

/**
 * BYOK-aware model id shape (ADR-0022): OpenRouter's `author/slug` OR a
 * plain provider-native id (`gpt-4o`, `ft:gpt-4o:acme::abc`, Azure
 * deployment names). The catalog-membership check in `validateOverrides`
 * remains the real gate — this pattern only rejects obvious garbage.
 * Mirrors `_MODEL_ID_RE` in `src/aiq_agent/common/model_overrides.py`.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}(\/[A-Za-z0-9_.:-]{1,128})?$/
