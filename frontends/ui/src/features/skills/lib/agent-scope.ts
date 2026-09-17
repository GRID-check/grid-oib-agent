/**
 * `grid-agents` — which agents may use a skill, and the only scope there is.
 *
 * A skill is available to every agent unless it says otherwise in so many
 * words. `grid-execution` used to narrow this too, which meant declaring what a
 * SCHEDULED run should produce silently decided where the skill existed; it no
 * longer does (see `lib/skills/service.ts::skillTargetsAgent` and the Python
 * mirror in `src/aiq_agent/skills/resolver.py`).
 *
 * Client-side and dependency-free on purpose: the editor and the toolbox both
 * need it, and `@/lib/skills/types` is the server-side write boundary that
 * drags in the Drizzle schema.
 */

/**
 * The agents that run skills. There is no third, and both resolvers IGNORE any
 * other name, so this list is the whole vocabulary a UI has to offer.
 */
export const SKILL_AGENTS = ['researcher', 'deep_researcher'] as const
export type SkillAgent = (typeof SKILL_AGENTS)[number]

/**
 * Retired `grid-agents` names, and the agent each one now means.
 *
 * `shallow_researcher` became `researcher`. Authors write this key by hand and
 * ten past migrations seeded it, so rows carrying the old name outlive the
 * rename; `0081_grid_agents_researcher_rename.sql` rewrites the rows we can
 * see and this map covers the rest.
 *
 * It must be an alias rather than a third entry in `SKILL_AGENTS`, and the
 * reason is that BOTH other readings fail silently. Unknown, the name is
 * ignored, and an allowlist of only ignored names reads as absent — a chat-only
 * skill would quietly become available to deep research. Known, the allowlist
 * would be `{shallow_researcher}`, which does not contain `researcher` — the
 * skill would quietly vanish from chat instead.
 *
 * Mirrored in `lib/skills/service.ts::skillTargetsAgent` and in
 * `src/aiq_agent/skills/resolver.py::AGENT_ALIASES`; the three are a contract
 * set, pinned against the same case in each suite.
 */
const AGENT_ALIASES: Record<string, SkillAgent> = {
  shallow_researcher: 'researcher',
}

/** The current name for `name`, following one retired alias. */
export function canonicalAgent(name: string): string {
  return AGENT_ALIASES[name] ?? name
}

export interface AgentScope {
  selected: SkillAgent[]
  /**
   * Names in `grid-agents` that are not agents.
   *
   * Both resolvers log and ignore these — an allowlist of only unknown names
   * behaves as if it were absent. They are carried through a save rather than
   * dropped, because rewriting somebody's metadata on their behalf is worse
   * than keeping a typo they can still see in the document preview.
   */
  unknown: string[]
}

function split(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function isAgent(name: string): name is SkillAgent {
  return (SKILL_AGENTS as readonly string[]).includes(name)
}

export function parseAgentScope(raw: string | undefined): AgentScope {
  // Canonicalised first, so a row still saying `shallow_researcher` shows the
  // scope its author chose instead of an "unknown name" the editor would then
  // write back verbatim on the next save.
  const listed = split(raw).map(canonicalAgent)
  const selected = listed.filter(isAgent)
  return {
    // No known name — including no key at all — means every agent.
    selected: selected.length > 0 ? selected : [...SKILL_AGENTS],
    unknown: listed.filter((name) => !isAgent(name)),
  }
}

/**
 * `grid-agents` for a scope, or `''` when the key should not be written.
 *
 * Every agent is the DEFAULT, and the default is the absence of the key —
 * writing both names would mean the same thing while reading as a restriction
 * somebody chose.
 */
export function formatAgentScope(scope: AgentScope): string {
  const restricted = scope.selected.length > 0 && scope.selected.length < SKILL_AGENTS.length
  return [...(restricted ? scope.selected : []), ...scope.unknown].join(',')
}

/**
 * How a list should be LABELLED: `null` when the skill reaches every agent.
 *
 * Null rather than an "all agents" label because that is the default and the
 * overwhelming majority — a badge on every row would carry no information and
 * would be the repeated chrome this UI has been stripping out.
 */
export function agentScopeLabelKey(raw: string | undefined): 'chatOnly' | 'deepOnly' | null {
  const known = split(raw).map(canonicalAgent).filter(isAgent)
  if (known.length === 0 || known.length === SKILL_AGENTS.length) return null
  return known[0] === 'researcher' ? 'chatOnly' : 'deepOnly'
}
