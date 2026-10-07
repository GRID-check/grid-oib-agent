/**
 * How alike two projects are, for the office's reference projects
 * (docs/design/cross-project-escalation.md): which past projects the agent is
 * told about at the start of a turn, and the order a `similar` search walks.
 *
 * Read off the confirmed profile facts, weighted by what decides whether a past
 * solution carries over: the Bundesland outweighs any single trait (it decides
 * which OIB edition and which Bauordnung apply), then the Gebäudeklasse, the
 * Bauweise, the uses and the kind of work; a building that matches in class,
 * construction and use in another Land still outranks a mere neighbour. A project with no facts in common scores 0 and is ordered
 * by recency alone. Pure: no I/O, no clock.
 */

import type { Project } from '@/lib/db/schema'

/** The facts the ranking reads, by profile key. */
export interface SimilarityFacts {
  bundesland: string | null
  gebaeudeklasse: number | null
  bauweise: string | null
  nutzungen: readonly string[]
  vorhabensart: string | null
}

type Profile = Pick<Project, 'profile'>['profile']

function factValue(profile: Profile, key: string): unknown {
  return profile?.facts?.[key]?.value ?? null
}

function token(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLocaleLowerCase('de') : null
}

/** `4`, `"4"`, `"GK4"`, `"GK 4"` → 4; anything else → null. */
function gebaeudeklasse(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  const match = typeof value === 'string' ? /(\d)/.exec(value) : null
  return match ? Number(match[1]) : null
}

function tokens(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list.map(token).filter((entry): entry is string => entry !== null)
}

/** The facts of one profile the ranking reads; missing or malformed facts read as unknown. */
export function similarityFacts(profile: Profile): SimilarityFacts {
  return {
    bundesland: token(factValue(profile, 'bundesland')),
    gebaeudeklasse: gebaeudeklasse(factValue(profile, 'gebaeudeklasse')),
    bauweise: token(factValue(profile, 'bauweise')),
    nutzungen: tokens(factValue(profile, 'nutzungen')),
    vorhabensart: token(factValue(profile, 'vorhabensart')),
  }
}

/** The weights, exported so the spec states the order they produce. */
export const SIMILARITY_WEIGHTS = {
  bundesland: 4,
  gebaeudeklasse: 3,
  gebaeudeklasseAdjacent: 1,
  bauweise: 2,
  nutzung: 1,
  nutzungMax: 2,
  vorhabensart: 1,
} as const

/** How alike `candidate` is to `current`; 0 when either side knows nothing. */
export function similarity(current: SimilarityFacts, candidate: SimilarityFacts): number {
  const w = SIMILARITY_WEIGHTS
  let score = 0
  if (current.bundesland && current.bundesland === candidate.bundesland) score += w.bundesland
  if (current.gebaeudeklasse !== null && candidate.gebaeudeklasse !== null) {
    const distance = Math.abs(current.gebaeudeklasse - candidate.gebaeudeklasse)
    if (distance === 0) score += w.gebaeudeklasse
    else if (distance === 1) score += w.gebaeudeklasseAdjacent
  }
  if (current.bauweise && current.bauweise === candidate.bauweise) score += w.bauweise
  const shared = current.nutzungen.filter((use) => candidate.nutzungen.includes(use)).length
  score += Math.min(shared * w.nutzung, w.nutzungMax)
  if (current.vorhabensart && current.vorhabensart === candidate.vorhabensart) score += w.vorhabensart
  return score
}

/** What the facts have in common, as short German labels for the brief („NÖ, GK 4, Holzbau"). */
export function sharedTraits(current: SimilarityFacts, candidate: SimilarityFacts): string[] {
  const traits: string[] = []
  if (current.bundesland && current.bundesland === candidate.bundesland) traits.push(candidate.bundesland)
  if (current.gebaeudeklasse !== null && current.gebaeudeklasse === candidate.gebaeudeklasse) {
    traits.push(`GK ${candidate.gebaeudeklasse}`)
  }
  if (current.bauweise && current.bauweise === candidate.bauweise) traits.push(candidate.bauweise)
  for (const use of current.nutzungen) if (candidate.nutzungen.includes(use)) traits.push(use)
  return traits
}

/**
 * `projects` ordered by likeness to `current`, most alike first; ties keep the
 * given order (the caller passes newest first). With no current profile (a chat
 * outside every project) the given order stands.
 */
export function rankBySimilarity<P extends Pick<Project, 'profile'>>(current: Profile | null, projects: readonly P[]): P[] {
  if (!current) return [...projects]
  const facts = similarityFacts(current)
  return projects
    .map((project, index) => ({ project, index, score: similarity(facts, similarityFacts(project.profile)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.project)
}
