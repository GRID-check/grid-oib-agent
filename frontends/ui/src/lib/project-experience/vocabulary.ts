/**
 * The vocabulary the closing extraction may answer in (docs/design/closed-project-experience.md):
 * for each fingerprint fact, the tokens the intake wizard accepts and the labels
 * it shows. The model may name only these tokens, and the BFF checks them again
 * before anything is written.
 *
 * The four multiple-choice and single-choice facts are read off the intake
 * definition, so the wizard and the extractor cannot disagree about what a
 * Bundesland or a Bauweise is. Two come from elsewhere: the Gebäudeklasse is
 * derived by the intake (an `info_placeholder`, with no options to read), and
 * the OIB edition is not a wizard question at all.
 */

import type { FingerprintKey } from '@/lib/cross-project/fingerprint'
import { UNDECIDED } from '@/lib/cross-project/similarity'
import { flattenIntakeQuestions, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ExperienceVocabulary, ExperienceVocabularyEntry } from './types'

/** The OIB-Richtlinien editions a project may have been planned under. */
const OIB_EDITIONS = ['2007', '2011', '2015', '2019', '2023', '2025'] as const

/** The building classes of the OIB-RL 2 (Gebäudeklasse 1 to 5). */
const GEBAEUDEKLASSEN = ['1', '2', '3', '4', '5'] as const

/** The fact's options as the intake wizard shows them, read off the question that writes it. */
function intakeEntry(key: Exclude<FingerprintKey, 'gebaeudeklasse'>): ExperienceVocabularyEntry {
  const writesTo = `/facts/${key}/value`
  const question = flattenIntakeQuestions(projectIntakeDefinitionV1).find((item) => item.writesTo === writesTo)
  if (!question?.options?.length) throw new Error(`The intake definition has no options for ${writesTo}`)
  return {
    multiple: question.type === 'multi_select',
    // „noch offen" is the wizard's way to defer an answer; no document states it.
    options: question.options
      .filter((option) => option.value !== UNDECIDED)
      .map((option) => ({ token: option.value, label: option.label })),
  }
}

/** Built on each call: the intake definition is static and the build is cheap. */
export function experienceVocabulary(): ExperienceVocabulary {
  return {
    bundesland: intakeEntry('bundesland'),
    gebaeudeklasse: {
      multiple: false,
      options: GEBAEUDEKLASSEN.map((grade) => ({ token: grade, label: `GK ${grade}` })),
    },
    bauweise: intakeEntry('bauweise'),
    nutzungen: intakeEntry('nutzungen'),
    vorhabensart: intakeEntry('vorhabensart'),
    oib_ausgabe: {
      multiple: false,
      options: OIB_EDITIONS.map((year) => ({ token: year, label: `OIB-Richtlinien ${year}` })),
    },
  }
}
