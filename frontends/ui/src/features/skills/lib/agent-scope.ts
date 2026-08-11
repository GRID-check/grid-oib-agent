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
export const SKILL_AGENTS = ['shallow_researcher', 'deep_researcher'] as const
export type SkillAgent = (typeof SKILL_AGENTS)[number]

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
  const listed = split(raw)
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
  const known = split(raw).filter(isAgent)
  if (known.length === 0 || known.length === SKILL_AGENTS.length) return null
  return known[0] === 'shallow_researcher' ? 'chatOnly' : 'deepOnly'
}
