/**
 * How alike two projects are, for the office's reference projects
 * (docs/design/cross-project-escalation.md): which past projects the agent is
 * told about at the start of a turn, and the order a `similar` search walks.
 *
 * Read off the confirmed profile facts in the shape the intake wizard stores
 * them (where a key has no fact, off the suggestion read from the project's
 * documents, `docs/design/closed-project-experience.md`): a building's
 * answers carry its instance (`bauweise@bw1`), and a project
 * of several buildings is read as all of them, so a GK 4 timber house with a
 * masonry annex resembles both a timber and a masonry project. Weighted by what decides whether a past
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
  /** Every building's class, ascending; one per building that has one. */
  gebaeudeklasse: readonly number[]
  /** A multi-select in the intake (a hybrid is „holzbau" and „stahlbeton"). */
  bauweise: readonly string[]
  nutzungen: readonly string[]
  /** A multi-select too (Neubau and Zubau); an older profile may hold one token. */
  vorhabensart: readonly string[]
}

type Profile = Pick<Project, 'profile'>['profile']

/** A stored value as the list the ranking reads: a multi-select's entries, a single value as one, nothing for null. */
function valuesOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? (value as unknown[]) : [value]
}

/**
 * Every stored value of a fact: the project-wide key and each building's copy
 * (`bauweise@bw1`), multi-selects flattened, in key order. A use zone's copy
 * (`x@bw1@wohnen`) is that zone's detail, not the building's, and is not read.
 */
function factValues(profile: Profile | null, key: string): unknown[] {
  const facts = profile?.facts ?? {}
  return Object.keys(facts)
    .filter((name) => {
      const [base, , zone] = name.split('@')
      return base === key && zone === undefined
    })
    .sort()
    .flatMap((name) => valuesOf(facts[name]?.value))
}

/**
 * What the ranking reads for one fingerprint key: its confirmed facts when they
 * hold any value, else the agent's suggestion from the project's documents (an
 * unconfirmed assumption with source `agent_suggested`). A wizard default
 * (`onboarding_default`) is no evidence and is never read. A confirmed fact
 * wins even where it says „offen": the person decided, and a suggestion does not
 * overrule that.
 */
function readKey(profile: Profile | null, key: string): unknown[] {
  const confirmed = factValues(profile, key)
  if (confirmed.length > 0) return confirmed
  const suggestion = profile?.assumptions?.[key]
  return suggestion?.source === 'agent_suggested' ? valuesOf(suggestion.value) : []
}

/**
 * A value as the intake's token: lower case, umlauts and ß spelled out, so a
 * label („Niederösterreich") and its token („niederoesterreich") are one value.
 */
function token(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value
    .trim()
    .toLocaleLowerCase('de')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
}

/** The intake's answer for a site abroad: no Land, so two such projects share no jurisdiction. */
const ABROAD = 'ausserhalb_oesterreichs'

/** The project's Bundesland as the intake stores it, folded to its token; `ausserhalb_oesterreichs` is kept as the answer it is. */
export function bundeslandOf(profile: Profile | null): string | null {
  return tokens(factValues(profile, 'bundesland'))[0] ?? null
}

/** The Land the ranking compares: a site abroad has none, so two such projects share no jurisdiction. */
function land(profile: Profile | null): string | null {
  const found = tokens(readKey(profile, 'bundesland'))[0] ?? null
  return found === ABROAD ? null : found
}

/** `4`, `"4"`, `"GK4"`, `"GK 4"` → 4; anything else → null. */
function gebaeudeklasse(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  const match = typeof value === 'string' ? /(\d)/.exec(value) : null
  return match ? Number(match[1]) : null
}

/** The intake's „noch offen": an answer that says nothing about the building. */
export const UNDECIDED = 'offen'

/** Values as distinct tokens, „offen" left out. */
function tokens(values: readonly unknown[]): string[] {
  const found = values.map(token).filter((entry): entry is string => entry !== null && entry !== UNDECIDED)
  return [...new Set(found)]
}

function overlap(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((entry) => b.includes(entry))
}

/**
 * The facts of one profile the ranking reads; missing or malformed facts read
 * as unknown, and a suggestion stands in where no fact does.
 */
export function similarityFacts(profile: Profile | null): SimilarityFacts {
  return {
    bundesland: land(profile),
    gebaeudeklasse: [
      ...new Set(
        readKey(profile, 'gebaeudeklasse')
          .map(gebaeudeklasse)
          .filter((value): value is number => value !== null)
      ),
    ].sort((a, b) => a - b),
    bauweise: tokens(readKey(profile, 'bauweise')),
    nutzungen: tokens(readKey(profile, 'nutzungen')),
    vorhabensart: tokens(readKey(profile, 'vorhabensart')),
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

/** The smallest class distance between any building of one and any of the other; null when either knows none. */
function closestClass(a: readonly number[], b: readonly number[]): number | null {
  const distances = a.flatMap((x) => b.map((y) => Math.abs(x - y)))
  return distances.length > 0 ? Math.min(...distances) : null
}

/** How alike `candidate` is to `current`; 0 when either side knows nothing. */
export function similarity(current: SimilarityFacts, candidate: SimilarityFacts): number {
  const w = SIMILARITY_WEIGHTS
  let score = 0
  if (current.bundesland && current.bundesland === candidate.bundesland) score += w.bundesland
  const distance = closestClass(current.gebaeudeklasse, candidate.gebaeudeklasse)
  if (distance === 0) score += w.gebaeudeklasse
  else if (distance === 1) score += w.gebaeudeklasseAdjacent
  if (overlap(current.bauweise, candidate.bauweise).length > 0) score += w.bauweise
  const shared = overlap(current.nutzungen, candidate.nutzungen).length
  score += Math.min(shared * w.nutzung, w.nutzungMax)
  if (overlap(current.vorhabensart, candidate.vorhabensart).length > 0) score += w.vorhabensart
  return score
}

/** A fact two projects share, by profile key and token (the Gebäudeklasse as its number). */
export interface SharedTrait {
  key: 'bundesland' | 'gebaeudeklasse' | 'bauweise' | 'nutzungen'
  value: string
}

/** What the facts have in common, in the order the ranking weighs them. */
export function sharedTraits(current: SimilarityFacts, candidate: SimilarityFacts): SharedTrait[] {
  const traits: SharedTrait[] = []
  if (current.bundesland && current.bundesland === candidate.bundesland) {
    traits.push({ key: 'bundesland', value: candidate.bundesland })
  }
  for (const value of current.gebaeudeklasse.filter((gk) => candidate.gebaeudeklasse.includes(gk))) {
    traits.push({ key: 'gebaeudeklasse', value: String(value) })
  }
  for (const value of overlap(current.bauweise, candidate.bauweise)) traits.push({ key: 'bauweise', value })
  for (const value of overlap(current.nutzungen, candidate.nutzungen)) traits.push({ key: 'nutzungen', value })
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
