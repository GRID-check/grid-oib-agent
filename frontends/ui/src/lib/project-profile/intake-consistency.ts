/**
 * Deterministic end-of-wizard intake consistency check (FB-13).
 *
 * Structured intake answers are checked HERE, on the client, with plain typed
 * predicates — no LLM, instant, no network. (The LLM half, in
 * `consistency_check.py`, only scrutinises free-text answers.)
 *
 * The rules are deliberately CONSERVATIVE: architects hate false positives, so
 * every rule only fires on an unambiguous contradiction, and a skipped / unknown
 * answer NEVER triggers anything.
 *
 * Findings carry i18n message KEYS (+ params), never prose — the wizard renders
 * them via the `projects.intake.consistency.*` dictionary in both locales.
 *
 * Pure and isomorphic — safe on the server or the client, no I/O.
 */

import {
  answerKeyFor,
  answersFromProfile,
  bauwerkeFromAnswers,
  evaluateIntakeCondition,
  flattenIntakeQuestions,
  formatIntakeAnswer,
  isIntakeAnswerProvided,
  projectIntakeDefinitionV1,
} from './intake-definition'
import type { ProjectIntakeDefinition, ProjectIntakeQuestion } from './intake-definition'
import type { ProjectPrimitiveValue, ProjectProfile } from './types'

export type ConsistencySeverity = 'warning' | 'inconsistency'

export interface DeterministicConsistencyFinding {
  kind: 'deterministic'
  fields: string[]
  severity: ConsistencySeverity
  messageKey: string
  params?: Record<string, string | number>
}

export interface AiConsistencyFinding {
  kind: 'ai'
  fields: string[]
  severity: ConsistencySeverity
  message: string
}

export type ConsistencyFinding = DeterministicConsistencyFinding | AiConsistencyFinding

/** A single answer sent to the free-text LLM check (label + rendered value). */
export interface ConsistencyCheckField {
  field: string
  value: string
}

type Answers = Record<string, ProjectPrimitiveValue>

function questionById(
  definition: ProjectIntakeDefinition,
  id: string
): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(definition).find((q) => q.id === id)
}

function labelFor(definition: ProjectIntakeDefinition, id: string): string {
  return questionById(definition, id)?.label ?? id
}

// ---------------------------------------------------------------------------
// Rule — fossil heat source on a new build (Erneuerbare-Wärme-Gesetz).
//
// E1 (Wärmeversorgung, per building) = "Gas (nur Bestand)" while the project's
// A5 (Art des Vorhabens) contains Neubau is a hard conflict: the EWG forbids
// fossil systems in new builds. This is the spec's own `fossil_konflikt`
// derivation (wizard_spec derived_values), the one deterministic contradiction
// that survives the move to derived building classes.
// ---------------------------------------------------------------------------

function checkFossilNeubauConflict(
  answers: Answers,
  definition: ProjectIntakeDefinition
): DeterministicConsistencyFinding[] {
  const vorhaben = answers['A5']
  const isNeubau = Array.isArray(vorhaben) && vorhaben.includes('neubau')
  if (!isNeubau) return []

  const findings: DeterministicConsistencyFinding[] = []
  for (const bw of bauwerkeFromAnswers(answers)) {
    if (answers[answerKeyFor('E1', bw.id)] === 'gas') {
      findings.push({
        kind: 'deterministic',
        fields: [labelFor(definition, 'A5'), `${bw.name} · ${labelFor(definition, 'E1')}`],
        severity: 'inconsistency',
        messageKey: 'fossilNeubauConflict',
        params: { bauwerk: bw.name },
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export function checkIntakeConsistencyFromAnswers(
  answers: Answers,
  definition: ProjectIntakeDefinition = projectIntakeDefinitionV1
): DeterministicConsistencyFinding[] {
  return [...checkFossilNeubauConflict(answers, definition)]
}

export function checkIntakeConsistency(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition = projectIntakeDefinitionV1
): DeterministicConsistencyFinding[] {
  const { answers } = answersFromProfile(profile, definition)
  return checkIntakeConsistencyFromAnswers(answers, definition)
}

// ---------------------------------------------------------------------------
// Free-text collection for the LLM half.
// ---------------------------------------------------------------------------

/** Whether a question type is free text the LLM should scrutinise. */
function isFreeText(question: ProjectIntakeQuestion): boolean {
  return question.type === 'text' || question.type === 'textarea'
}

/**
 * The free-text answers the LLM should scrutinise: every currently-applicable,
 * project-scope free-text question whose trimmed answer is at least `minLength`
 * characters. (Project-scope covers the guided free-text module G, where all the
 * substantive context lives.)
 */
export function collectFreeTextFields(
  answers: Answers,
  definition: ProjectIntakeDefinition = projectIntakeDefinitionV1,
  minLength = 10
): ConsistencyCheckField[] {
  const fields: ConsistencyCheckField[] = []
  for (const stage of definition.stages) {
    if (stage.scope === 'bauwerk') continue
    for (const question of stage.questions) {
      if (!isFreeText(question)) continue
      if (!evaluateIntakeCondition(question, answers)) continue
      const raw = answers[question.id]
      const value = typeof raw === 'string' ? raw.trim() : ''
      if (value.length < minLength) continue
      fields.push({ field: question.label, value })
    }
  }
  return fields
}

/**
 * The structured answers passed to the LLM as READ-ONLY context. Currently-
 * applicable, answered, non-free-text project-scope questions.
 */
export function collectStructuredContextFields(
  answers: Answers,
  definition: ProjectIntakeDefinition = projectIntakeDefinitionV1
): ConsistencyCheckField[] {
  const fields: ConsistencyCheckField[] = []
  for (const stage of definition.stages) {
    if (stage.scope === 'bauwerk') continue
    for (const question of stage.questions) {
      if (
        isFreeText(question) ||
        question.type === 'info_placeholder' ||
        question.type === 'upload'
      )
        continue
      if (!evaluateIntakeCondition(question, answers)) continue
      const raw = answers[question.id]
      if (!isIntakeAnswerProvided(raw)) continue
      fields.push({ field: question.label, value: formatIntakeAnswer(question, raw) })
    }
  }
  return fields
}
