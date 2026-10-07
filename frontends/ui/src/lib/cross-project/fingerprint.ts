/**
 * A project's fingerprint: the facts that decide whether its experience carries
 * over to another project (docs/roadmap/office-experience.md). One definition,
 * read by the reference catalog the agent sees (`reference-brief.ts`) and by
 * the closing debrief a person fills in (`closing-debrief.tsx`), so what the
 * debrief asks for is exactly what the ranking reads.
 *
 * Pure, and safe in the browser: no I/O, no `server-only`.
 */

import { flattenIntakeQuestions, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { similarityFacts, type SimilarityFacts } from './similarity'

/** The fingerprint's facts, in the order the similarity weighs them. */
export const FINGERPRINT_KEYS = ['bundesland', 'gebaeudeklasse', 'bauweise', 'nutzungen', 'vorhabensart'] as const
export type FingerprintKey = (typeof FINGERPRINT_KEYS)[number]

/**
 * The wizard's own label for a fact's token („niederoesterreich" →
 * „Niederösterreich"), read off the question that writes the fact, so a
 * reader sees what the intake showed. A token no option names is shown as it is.
 */
const FACT_LABELS: ReadonlyMap<string, ReadonlyMap<string, string>> = (() => {
  const labels = new Map<string, Map<string, string>>()
  for (const question of flattenIntakeQuestions(projectIntakeDefinitionV1)) {
    const key = /^\/facts\/([a-z_]+)\/value$/.exec(question.writesTo ?? '')?.[1]
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

/** One fact of the fingerprint as a reader sees it: its value's label, or null when the project leaves it open. */
export interface FingerprintFact {
  key: FingerprintKey
  value: string | null
}

function valueOf(key: FingerprintKey, facts: SimilarityFacts): string | null {
  const list = (values: readonly string[]) =>
    values.length > 0 ? values.map((value) => factLabel(key, value)).join('/') : null
  switch (key) {
    case 'bundesland':
      return facts.bundesland ? factLabel(key, facts.bundesland) : null
    case 'gebaeudeklasse':
      return facts.gebaeudeklasse !== null ? `GK ${facts.gebaeudeklasse}` : null
    case 'bauweise':
      return list(facts.bauweise)
    case 'nutzungen':
      return list(facts.nutzungen)
    case 'vorhabensart':
      return list(facts.vorhabensart)
  }
}

/** Every fingerprint fact of a profile, open ones included as null. */
export function fingerprintOf(profile: ProjectProfile | null | undefined): FingerprintFact[] {
  const facts = similarityFacts(profile ?? null)
  return FINGERPRINT_KEYS.map((key) => ({ key, value: valueOf(key, facts) }))
}

/** The fingerprint's known values, labelled, for a one-line summary („Niederösterreich, GK 4, Holzbau"). */
export function fingerprintLabels(profile: ProjectProfile | null | undefined): string[] {
  return fingerprintOf(profile)
    .map((fact) => fact.value)
    .filter((value): value is string => value !== null)
}
