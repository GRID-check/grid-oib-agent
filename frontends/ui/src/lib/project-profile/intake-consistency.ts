/**
 * Deterministic end-of-wizard intake consistency check (FB-13).
 *
 * Structured intake answers (selects / numbers / booleans) are checked HERE,
 * on the client, with plain typed predicates — no LLM, instant, no network.
 * (The LLM half, in `consistency_check.py`, only scrutinises free-text answers.)
 *
 * The rules are deliberately CONSERVATIVE: architects hate false positives, so
 * every rule only fires on an unambiguous, physically-impossible combination,
 * and a skipped / unknown answer NEVER triggers anything (all reads return
 * `undefined` for a missing value and every rule bails on `undefined`).
 *
 * Findings carry i18n message KEYS (+ params), never prose — the wizard renders
 * them via the `projects.intake.consistency.*` dictionary in both locales.
 *
 * Pure and isomorphic — safe on the server or the client, no I/O.
 */

import {
  answersFromProfile,
  evaluateIntakeCondition,
  flattenIntakeQuestions,
  formatIntakeAnswer,
  isIntakeAnswerProvided,
  projectIntakeDefinitionV1,
} from './intake-definition'
import type { ProjectIntakeDefinition, ProjectIntakeQuestion } from './intake-definition'
import type { ProjectPrimitiveValue, ProjectProfile } from './types'

/** Severity of a consistency-check finding. */
export type ConsistencySeverity = 'warning' | 'inconsistency'

/**
 * A contradiction found by the DETERMINISTIC rules. Carries an i18n `messageKey`
 * (resolved against `projects.intake.consistency.*`) plus `params`, never prose.
 * `fields` are the affected question labels so the wizard can offer Edit links.
 */
export interface DeterministicConsistencyFinding {
  kind: 'deterministic'
  fields: string[]
  severity: ConsistencySeverity
  messageKey: string
  params?: Record<string, string | number>
}

/**
 * A contradiction found by the LLM free-text check. Carries a ready-made,
 * locale-appropriate `message` (the backend wrote it in the request locale).
 */
export interface AiConsistencyFinding {
  kind: 'ai'
  fields: string[]
  severity: ConsistencySeverity
  message: string
}

/** Merged finding type the ReviewStep renders (either source). */
export type ConsistencyFinding = DeterministicConsistencyFinding | AiConsistencyFinding

/** A single answer sent to the free-text LLM check (label + rendered value). */
export interface ConsistencyCheckField {
  field: string
  value: string
}

type Answers = Record<string, ProjectPrimitiveValue>

// ---------------------------------------------------------------------------
// Reading answers, defensively.
// ---------------------------------------------------------------------------

function numericAnswer(answers: Answers, id: string): number | undefined {
  const value = answers[id]
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function stringAnswer(answers: Answers, id: string): string | undefined {
  const value = answers[id]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function questionById(definition: ProjectIntakeDefinition, id: string): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(definition).find((q) => q.id === id)
}

/** The question's human label, falling back to its id. */
function labelFor(definition: ProjectIntakeDefinition, id: string): string {
  return questionById(definition, id)?.label ?? id
}

// ---------------------------------------------------------------------------
// Rule 1 — low building class vs. too many above-ground floors.
// ---------------------------------------------------------------------------

/**
 * OIB Richtlinie 2 (Begriffsbestimmungen der Gebäudeklassen): GK1–GK3 permit at
 * most 3 above-ground floors, GK4 at most 4; GK5 is the "everything taller"
 * class (up to the 22 m Hochhaus threshold) and has no upper floor cap.
 *
 * The repo does not encode these floor thresholds anywhere — `applicable-
 * standards.ts` only uses the building class for the Hochhaus check — so, per the
 * FB-13 brief, we stay deliberately conservative and only flag when the floor
 * count exceeds FOUR (i.e. 5+ floors). Five above-ground floors is impossible
 * for GK1–GK3 (cap 3) and even for GK4 (cap 4), so this can never false-positive
 * on a legitimate low-rise.
 */
const LOW_BUILDING_CLASSES = new Set(['GK1', 'GK2', 'GK3'])
const CONSERVATIVE_LOW_CLASS_FLOOR_CEILING = 4

function checkLowClassTooManyFloors(
  answers: Answers,
  definition: ProjectIntakeDefinition,
): DeterministicConsistencyFinding[] {
  const buildingClass = stringAnswer(answers, 'gebaeudeklasse')
  const floors = numericAnswer(answers, 'geschosse_oberirdisch')
  if (buildingClass === undefined || floors === undefined) return []
  if (!LOW_BUILDING_CLASSES.has(buildingClass)) return []
  if (floors <= CONSERVATIVE_LOW_CLASS_FLOOR_CEILING) return []

  return [
    {
      kind: 'deterministic',
      fields: [labelFor(definition, 'gebaeudeklasse'), labelFor(definition, 'geschosse_oberirdisch')],
      severity: 'inconsistency',
      messageKey: 'lowClassTooManyFloors',
      // Data-driven so the copy can never drift from the rule: `threshold` is the
      // conservative ceiling this rule actually fires above, `count` the entered value.
      params: { buildingClass, count: floors, threshold: CONSERVATIVE_LOW_CLASS_FLOOR_CEILING },
    },
  ]
}

// ---------------------------------------------------------------------------
// Rule 2 — escape level vs. above-ground floor count (covers the Hochhaus /
// high-building-vs-low-floors and escape-vs-floors cases from the brief).
// ---------------------------------------------------------------------------

/**
 * The escape level is the height of the highest escape level above ground.
 * Reaching a given band needs a minimum number of above-ground floors. Even with
 * an implausibly low ~2.5 m storey height a `> 22 m` escape level implies ~8
 * floors and `11–22 m` implies ~4 floors; we flag well BELOW those physical
 * minimums so a tall-storey building never false-positives:
 *   `> 22 m`  → flag only at ≤ 2 above-ground floors (2 floors ⇒ ≥ 11 m/floor)
 *   `11–22 m` → flag only at ≤ 1 above-ground floor  (1 floor ⇒ ≥ 11 m/floor)
 * The `<= 7m` and `7-11m` bands are never flagged (achievable at low floor counts).
 */
const ESCAPE_LEVEL_MIN_FLOORS: Record<string, number> = { '>22m': 3, '11-22m': 2 }

function checkEscapeLevelVsFloors(
  answers: Answers,
  definition: ProjectIntakeDefinition,
): DeterministicConsistencyFinding[] {
  const escapeLevel = stringAnswer(answers, 'fluchtniveau')
  const floors = numericAnswer(answers, 'geschosse_oberirdisch')
  if (escapeLevel === undefined || floors === undefined) return []
  const minFloors = ESCAPE_LEVEL_MIN_FLOORS[escapeLevel]
  if (minFloors === undefined || floors >= minFloors) return []

  const question = questionById(definition, 'fluchtniveau')
  const escapeLabel = question ? formatIntakeAnswer(question, escapeLevel) : escapeLevel
  return [
    {
      kind: 'deterministic',
      fields: [labelFor(definition, 'fluchtniveau'), labelFor(definition, 'geschosse_oberirdisch')],
      severity: 'inconsistency',
      messageKey: 'escapeLevelTooFewFloors',
      params: { escapeLevel: escapeLabel, floors },
    },
  ]
}

/**
 * Rule 2b — the inverse direction: a LOW escape-level band with implausibly many
 * above-ground floors. The highest storey's floor is an escape level, so with N
 * floors the escape level is at least (N-1) × storey height. Even at an
 * implausibly low ~2.5 m per storey:
 *   `<= 7 m`  → impossible from 6 floors up (5 × 2.5 m = 12.5 m > 7 m)
 *   `7–11 m`  → impossible from 7 floors up (6 × 2.5 m = 15 m > 11 m)
 * Real storey heights (≥ 3 m) make these bounds generous, so no legitimate
 * building is flagged. (This caught a real case: 12 floors entered with 7–11 m.)
 */
const ESCAPE_LEVEL_MAX_FLOORS: Record<string, number> = { '<=7m': 5, '7-11m': 6 }

function checkEscapeLevelTooManyFloors(
  answers: Answers,
  definition: ProjectIntakeDefinition,
): DeterministicConsistencyFinding[] {
  const escapeLevel = stringAnswer(answers, 'fluchtniveau')
  const floors = numericAnswer(answers, 'geschosse_oberirdisch')
  if (escapeLevel === undefined || floors === undefined) return []
  const maxFloors = ESCAPE_LEVEL_MAX_FLOORS[escapeLevel]
  if (maxFloors === undefined || floors <= maxFloors) return []

  const question = questionById(definition, 'fluchtniveau')
  const escapeLabel = question ? formatIntakeAnswer(question, escapeLevel) : escapeLevel
  return [
    {
      kind: 'deterministic',
      fields: [labelFor(definition, 'fluchtniveau'), labelFor(definition, 'geschosse_oberirdisch')],
      severity: 'inconsistency',
      messageKey: 'escapeLevelTooManyFloors',
      params: { escapeLevel: escapeLabel, floors },
    },
  ]
}

// ---------------------------------------------------------------------------
// Rule 2c — building class vs. escape-level band (definitional, OIB RL 2).
// ---------------------------------------------------------------------------

/**
 * OIB Richtlinie 2 defines GK1–GK3 as buildings with a Fluchtniveau of at most
 * 7 m and GK4 as at most 11 m — a higher escape level is definitionally
 * impossible for those classes, not merely unusual. GK5 is deliberately NOT
 * constrained downward: a building can be GK5 with a low escape level when it
 * fails the other GK1–GK4 criteria (size, Betriebseinheiten), so flagging
 * GK5 + a low band would false-positive.
 */
const CLASS_MAX_ESCAPE_BANDS: Record<string, { allowed: Set<string>; maxLevel: string }> = {
  GK1: { allowed: new Set(['<=7m']), maxLevel: '7 m' },
  GK2: { allowed: new Set(['<=7m']), maxLevel: '7 m' },
  GK3: { allowed: new Set(['<=7m']), maxLevel: '7 m' },
  GK4: { allowed: new Set(['<=7m', '7-11m']), maxLevel: '11 m' },
}

function checkClassEscapeLevelMismatch(
  answers: Answers,
  definition: ProjectIntakeDefinition,
): DeterministicConsistencyFinding[] {
  const buildingClass = stringAnswer(answers, 'gebaeudeklasse')
  const escapeLevel = stringAnswer(answers, 'fluchtniveau')
  if (buildingClass === undefined || escapeLevel === undefined) return []
  const constraint = CLASS_MAX_ESCAPE_BANDS[buildingClass]
  if (constraint === undefined || constraint.allowed.has(escapeLevel)) return []

  const question = questionById(definition, 'fluchtniveau')
  const escapeLabel = question ? formatIntakeAnswer(question, escapeLevel) : escapeLevel
  return [
    {
      kind: 'deterministic',
      fields: [labelFor(definition, 'gebaeudeklasse'), labelFor(definition, 'fluchtniveau')],
      severity: 'inconsistency',
      messageKey: 'classEscapeLevelMismatch',
      params: { buildingClass, escapeLevel: escapeLabel, maxLevel: constraint.maxLevel },
    },
  ]
}

// ---------------------------------------------------------------------------
// Rule 4 — renovation focus on a new build.
// ---------------------------------------------------------------------------

/**
 * Selecting the "Renovation / existing-building compliance" focus while the
 * project is a pure NEW build ("neubau") is contradictory — renovation work
 * implies existing fabric. Extension/conversion ("zu_und_umbau") legitimately
 * mixes both and is never flagged. Soft ('warning'): the user may simply have
 * picked the wrong focus chip, but it could also be a mis-set building type.
 */
function checkRenovationFocusOnNewBuild(
  answers: Answers,
  definition: ProjectIntakeDefinition,
): DeterministicConsistencyFinding[] {
  const focus = answers['focus_areas']
  const buildingType = stringAnswer(answers, 'bestand_neubau')
  if (!Array.isArray(focus) || !focus.includes('sanierung')) return []
  if (buildingType !== 'neubau') return []

  return [
    {
      kind: 'deterministic',
      fields: [labelFor(definition, 'focus_areas'), labelFor(definition, 'bestand_neubau')],
      severity: 'warning',
      messageKey: 'renovationFocusOnNewBuild',
    },
  ]
}

// ---------------------------------------------------------------------------
// Rule 3 — orphaned conditional answers.
// ---------------------------------------------------------------------------

/**
 * A conditional question that has an answer even though its visibility condition
 * no longer holds — e.g. a bed count while the main use is Office, or an
 * existing-building age on a new build. The intake definition's own
 * `condition`s are the source of truth for what applies, so this rule needs no
 * hand-maintained list. Soft ('warning'): such an answer is dropped on save
 * anyway, but the user should know it won't be kept.
 */
function checkOrphanedConditionalAnswers(
  answers: Answers,
  definition: ProjectIntakeDefinition,
): DeterministicConsistencyFinding[] {
  const findings: DeterministicConsistencyFinding[] = []
  for (const question of flattenIntakeQuestions(definition)) {
    if (!question.condition) continue
    // A skipped/blank conditional answer never triggers anything.
    if (!isIntakeAnswerProvided(answers[question.id])) continue
    // The condition holds → the question legitimately applies.
    if (evaluateIntakeCondition(question, answers)) continue

    findings.push({
      kind: 'deterministic',
      fields: [question.label],
      severity: 'warning',
      messageKey: 'orphanedAnswer',
      params: { field: question.label, dependsOn: labelFor(definition, question.condition.field) },
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Deterministically check a set of intake answers for internal contradictions.
 * Used directly by the wizard, where orphaned answers the user just entered are
 * still present (the profile builder drops them on save).
 */
export function checkIntakeConsistencyFromAnswers(
  answers: Answers,
  definition: ProjectIntakeDefinition = projectIntakeDefinitionV1,
): DeterministicConsistencyFinding[] {
  return [
    ...checkLowClassTooManyFloors(answers, definition),
    ...checkEscapeLevelVsFloors(answers, definition),
    ...checkEscapeLevelTooManyFloors(answers, definition),
    ...checkClassEscapeLevelMismatch(answers, definition),
    ...checkRenovationFocusOnNewBuild(answers, definition),
    ...checkOrphanedConditionalAnswers(answers, definition),
  ]
}

/**
 * Deterministically check a {@link ProjectProfile} for internal contradictions
 * between its structured facts (FB-13 core). Reconstructs the intake answers
 * from the profile and applies the conservative rule set. Returns `[]` when the
 * profile is consistent (or too sparse to judge).
 */
export function checkIntakeConsistency(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition = projectIntakeDefinitionV1,
): DeterministicConsistencyFinding[] {
  return checkIntakeConsistencyFromAnswers(answersFromProfile(profile, definition), definition)
}

// ---------------------------------------------------------------------------
// Free-text collection for the LLM half.
// ---------------------------------------------------------------------------

/**
 * The free-text answers the LLM should scrutinise: every currently-applicable
 * text question whose trimmed answer is at least `minLength` characters. Shorter
 * or empty answers are omitted so the wizard can skip the network call entirely
 * when there is nothing substantive to check.
 */
export function collectFreeTextFields(
  answers: Answers,
  definition: ProjectIntakeDefinition = projectIntakeDefinitionV1,
  minLength = 10,
): ConsistencyCheckField[] {
  const fields: ConsistencyCheckField[] = []
  for (const question of flattenIntakeQuestions(definition)) {
    if (question.type !== 'text') continue
    if (!evaluateIntakeCondition(question, answers)) continue
    const raw = answers[question.id]
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value.length < minLength) continue
    fields.push({ field: question.label, value })
  }
  return fields
}

/**
 * The structured answers passed to the LLM as READ-ONLY context (so it can tell
 * whether the free text contradicts them). Only currently-applicable, answered,
 * non-text questions — skipped/orphaned answers are omitted.
 */
export function collectStructuredContextFields(
  answers: Answers,
  definition: ProjectIntakeDefinition = projectIntakeDefinitionV1,
): ConsistencyCheckField[] {
  const fields: ConsistencyCheckField[] = []
  for (const question of flattenIntakeQuestions(definition)) {
    if (question.type === 'text') continue
    if (!evaluateIntakeCondition(question, answers)) continue
    if (!isIntakeAnswerProvided(answers[question.id])) continue
    fields.push({ field: question.label, value: formatIntakeAnswer(question, answers[question.id]) })
  }
  return fields
}
