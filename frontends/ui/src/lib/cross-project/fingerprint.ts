/**
 * A project's fingerprint: the facts that decide whether its experience carries
 * over to another project (docs/roadmap/office-experience.md). One definition,
 * read by the reference catalog the agent sees (`reference-brief.ts`) and by
 * the closing debrief a person fills in (`closing-debrief.tsx`), so what the
 * debrief asks for is exactly what the ranking reads.
 *
 * What a fact means for a project comes from the intake definition, never from
 * a list kept here: whether the wizard asks it at all for this project (the
 * Bauweise is asked of a building, not of a Stützmauer), and whether the wizard
 * can write it (the Gebäudeklasse is derived, so „im Briefing ergänzen" cannot
 * fill it).
 *
 * Pure, and safe in the browser: no I/O, no `server-only`.
 */

import {
  answerKeyFor,
  answersFromProfile,
  defaultBauwerke,
  evaluateIntakeCondition,
  flattenIntakeQuestions,
  isIntakeAnswerProvided,
  projectIntakeDefinitionV1,
  type ProjectIntakeQuestion,
} from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { similarityFacts, type SimilarityFacts } from './similarity'

/** The fingerprint's facts, in the order the similarity weighs them. */
export const FINGERPRINT_KEYS = ['bundesland', 'gebaeudeklasse', 'bauweise', 'nutzungen', 'vorhabensart'] as const
export type FingerprintKey = (typeof FINGERPRINT_KEYS)[number]

const DEFINITION = projectIntakeDefinitionV1
const FACT_PATH = /^\/facts\/([a-z_]+)\/value$/

/**
 * The wizard's own label for a fact's token („niederoesterreich" →
 * „Niederösterreich"), read off the question that writes the fact, so a
 * reader sees what the intake showed. A token no option names is shown as it is.
 */
const FACT_LABELS: ReadonlyMap<string, ReadonlyMap<string, string>> = (() => {
  const labels = new Map<string, Map<string, string>>()
  for (const question of flattenIntakeQuestions(DEFINITION)) {
    const key = FACT_PATH.exec(question.writesTo ?? '')?.[1]
    if (!key || !question.options?.length) continue
    const options = labels.get(key) ?? new Map<string, string>()
    for (const option of question.options) options.set(String(option.value).toLocaleLowerCase('de'), option.label)
    labels.set(key, options)
  }
  return labels
})()

export function factLabel(key: string, token: string): string {
  return FACT_LABELS.get(key)?.get(token) ?? token
}

/** A question that writes or derives a fact, and whether it is asked once per building. */
interface Asker {
  question: ProjectIntakeQuestion
  perBuilding: boolean
}

/** The intake questions behind each fingerprint fact, read off the definition once. */
const ASKERS: ReadonlyMap<string, readonly Asker[]> = (() => {
  const askers = new Map<string, Asker[]>()
  for (const stage of DEFINITION.stages) {
    for (const question of stage.questions) {
      const key = FACT_PATH.exec(question.writesTo ?? '')?.[1] ?? question.derives
      if (!key) continue
      askers.set(key, [...(askers.get(key) ?? []), { question, perBuilding: stage.scope === 'bauwerk' }])
    }
  }
  return askers
})()

/**
 * Whether the wizard asks this question here, or would once a condition it
 * hangs on is answered: an unanswered Bauwerkstyp leaves the Bauweise open,
 * not inapplicable.
 */
function asked(question: ProjectIntakeQuestion, answers: Record<string, ProjectPrimitiveValue>, building?: string): boolean {
  if (evaluateIntakeCondition(question, answers, building)) return true
  return (question.conditions ?? []).some(
    (condition) =>
      !isIntakeAnswerProvided(answers[building ? answerKeyFor(condition.param, building) : condition.param]) &&
      !isIntakeAnswerProvided(answers[condition.param])
  )
}

/** One fact of the fingerprint as a reader sees it. */
export interface FingerprintFact {
  key: FingerprintKey
  /** Its value's label, or null when the project leaves it open. */
  value: string | null
  /** Whether the intake asks it of this project at all (no Bauweise for a Stützmauer). */
  applies: boolean
  /** Whether the intake wizard writes it, so the briefing is where to add it. */
  editable: boolean
  /**
   * Whether the value is only a suggestion read from the project's documents
   * (`closed-project-experience.md`): no person confirmed it yet.
   */
  suggested: boolean
}

function valueOf(key: FingerprintKey, facts: SimilarityFacts): string | null {
  const list = (values: readonly string[]) =>
    values.length > 0 ? values.map((value) => factLabel(key, value)).join('/') : null
  switch (key) {
    case 'bundesland':
      return facts.bundesland ? factLabel(key, facts.bundesland) : null
    case 'gebaeudeklasse':
      return facts.gebaeudeklasse.length > 0 ? facts.gebaeudeklasse.map((gk) => `GK ${gk}`).join('/') : null
    case 'bauweise':
      return list(facts.bauweise)
    case 'nutzungen':
      return list(facts.nutzungen)
    case 'vorhabensart':
      return list(facts.vorhabensart)
  }
}

/** Every fingerprint fact of a profile, open and inapplicable ones included. */
export function fingerprintOf(profile: ProjectProfile | null | undefined): FingerprintFact[] {
  const facts = similarityFacts(profile ?? null)
  const confirmed = similarityFacts(profile ? { ...profile, assumptions: {} } : null)
  const { answers, bauwerke } = profile
    ? answersFromProfile(profile, DEFINITION)
    : { answers: {} as Record<string, ProjectPrimitiveValue>, bauwerke: defaultBauwerke() }
  return FINGERPRINT_KEYS.map((key) => {
    const askers = ASKERS.get(key) ?? []
    const applies =
      askers.length === 0 ||
      askers.some(({ question, perBuilding }) =>
        perBuilding ? bauwerke.some((building) => asked(question, answers, building.id)) : asked(question, answers)
      )
    const value = valueOf(key, facts)
    return {
      key,
      value,
      applies,
      editable: askers.some(({ question }) => Boolean(question.writesTo)),
      suggested: value !== null && valueOf(key, confirmed) === null,
    }
  })
}

/**
 * The fingerprint's known values, labelled, for a one-line summary („Niederösterreich,
 * GK 4, Holzbau"). A value only read from the documents says so, so the agent's
 * catalog never presents a suggestion as a confirmed fact.
 */
export function fingerprintLabels(profile: ProjectProfile | null | undefined): string[] {
  return fingerprintOf(profile).flatMap((fact) => {
    if (fact.value === null) return []
    return [fact.suggested ? `${fact.value} (${SUGGESTED_MARK})` : fact.value]
  })
}

/** How a summary line marks a value only the project's documents suggest. */
export const SUGGESTED_MARK = 'aus den Unterlagen, unbestätigt'
