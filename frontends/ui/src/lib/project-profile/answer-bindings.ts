/**
 * The project facts an answer binds with `:project[key]`, read off the profile.
 *
 * The model names a key (`lib/text/answer-directives.ts` `PROJECT_KEYS`); this
 * module is where the key becomes the value a reader sees, so the model never
 * types a project value (answer-richness guardrail 7). Three states, each drawn
 * differently by the answer's value chip:
 *
 *  - `confirmed`: a fact in `profile.facts` (the intake or a confirmed patch);
 *  - `assumed`: an agent or default assumption awaiting confirmation;
 *  - `missing`: neither. The chip offers to fill it in.
 *
 * Pure and isomorphic. The display value is German, the answer's language:
 * option labels come from the intake definition, numbers are written the way a
 * planner writes them („10,8 m", „1.450 m²").
 */

import { PROJECT_KEYS, type ProjectKey } from '@/lib/text/answer-directives'
import { flattenIntakeQuestions, formatIntakeAnswer, projectIntakeDefinitionV1 } from './intake-definition'
import type { ProjectIntakeQuestion } from './intake-definition'
import { ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue, ProjectProfile } from './types'

export type BoundFactState = 'confirmed' | 'assumed' | 'missing'

export interface BoundFact {
  key: ProjectKey
  state: BoundFactState
  /** The value as the reader sees it („GK 4", „10,8 m", „Wien"), or null when missing. */
  text: string | null
  /** The number behind a numeric fact (10.8 for „10,8 m"), for a scale or a matched case. */
  number: number | null
  /** Why the agent assumed it, for an assumption. */
  reason?: string
  /** When the profile last changed this fact. */
  updatedAt?: string
}

/** Resolves a key to its bound fact; supplied by the surface that knows the project. */
export type ProjectFactResolver = (key: ProjectKey) => BoundFact

/** The unit each numeric key is written in. */
const UNITS: Partial<Record<ProjectKey, string>> = {
  escape_level_m: 'm',
  gross_floor_area_m2: 'm²',
}

/** The unit a key's value is written in, or undefined for a bare count or a word. */
export const unitFor = (key: ProjectKey): string | undefined => UNITS[key]

/** German figures with a decimal comma and a thousands dot, as the answer writes them. */
const FIGURES = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 })

export const formatFigure = (value: number, unit?: string): string =>
  unit ? `${FIGURES.format(value)} ${unit}` : FIGURES.format(value)

/** The intake question that writes a fact key, for its option labels. */
function questionFor(factKey: string): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (question) => question.writesTo?.match(/^\/facts\/([^/]+)/)?.[1] === factKey
  )
}

/** A Gebäudeklasse as its number: „GK4", „GK 4", 4 and „4" all give 4. */
export function buildingClassNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value !== 'string') return null
  const match = /^(?:gk|gebäudeklasse|geb[aä]udeklasse)?\s*([1-5])$/i.exec(value.trim())
  return match ? Number(match[1]) : null
}

/** The value a stored fact holds, as text and, where it is one, a number. */
function display(key: ProjectKey, value: ProjectPrimitiveValue): { text: string; number: number | null } | null {
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null
  if (key === 'building_class') {
    const number = buildingClassNumber(value)
    return number === null ? { text: String(value), number: null } : { text: `GK ${number}`, number }
  }
  if (typeof value === 'number') return { text: formatFigure(value, UNITS[key]), number: value }
  const question = questionFor(PROJECT_KEYS[key])
  const text = question ? formatIntakeAnswer(question, value) : Array.isArray(value) ? value.join(', ') : String(value)
  return text && text !== '—' ? { text, number: null } : null
}

/**
 * The stored entry for a fact key: the key itself, or the first scoped copy
 * (`fluchtniveau_m@bw1`) when the profile records it per Bauwerk.
 */
function entryFor<T>(record: Record<string, T>, factKey: string): T | undefined {
  if (record[factKey] !== undefined) return record[factKey]
  const scoped = Object.keys(record)
    .filter((name) => name.split('@')[0] === factKey)
    .sort()[0]
  return scoped === undefined ? undefined : record[scoped]
}

/** One key, bound: confirmed beats assumed, and neither is missing. */
export function bindProjectFact(profile: ProjectProfile | null | undefined, key: ProjectKey): BoundFact {
  const factKey = PROJECT_KEYS[key]
  const fact = profile ? entryFor(profile.facts, factKey) : undefined
  const shown = fact ? display(key, fact.value) : null
  if (fact && shown) return { key, state: 'confirmed', ...shown, updatedAt: fact.updatedAt }
  const assumption = profile ? entryFor(profile.assumptions, factKey) : undefined
  const assumed = assumption ? display(key, assumption.value) : null
  if (assumption && assumed) {
    return { key, state: 'assumed', ...assumed, reason: assumption.reason, updatedAt: assumption.updatedAt }
  }
  return { key, state: 'missing', text: null, number: null }
}

/** A resolver over one profile, as parsed from whatever the API returned. */
export function projectFactResolver(rawProfile: unknown): ProjectFactResolver {
  const parsed = ProjectProfileSchema.safeParse(rawProfile ?? {})
  const profile = parsed.success ? parsed.data : null
  const cache = new Map<ProjectKey, BoundFact>()
  return (key) => {
    const known = cache.get(key)
    if (known) return known
    const bound = bindProjectFact(profile, key)
    cache.set(key, bound)
    return bound
  }
}
