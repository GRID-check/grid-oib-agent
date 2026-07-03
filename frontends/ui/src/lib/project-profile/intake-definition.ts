// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfilePatchOperation } from './types'

export type ProjectIntakeQuestionType = 'single_select' | 'multi_select' | 'boolean' | 'number' | 'text'

export interface ProjectIntakeOption {
  value: string
  label: string
}

export interface ProjectIntakeQuestion {
  id: string
  label: string
  /** Optional one-line helper shown under the field label. */
  help?: string
  type: ProjectIntakeQuestionType
  options?: ProjectIntakeOption[]
  condition?: { field: string; equals?: string; oneOf?: string[] }
  writesTo?: string
}

export interface ProjectIntakeStage {
  id: string
  title: string
  /** Optional one-line description shown under the stage title. */
  description?: string
  questions: ProjectIntakeQuestion[]
}

export interface ProjectIntakeDefinition {
  version: number
  stages: ProjectIntakeStage[]
}

export const projectIntakeDefinitionV1: ProjectIntakeDefinition = {
  version: 1,
  stages: [
    {
      id: 'core',
      title: 'Project core',
      description: 'The essentials Grid needs to frame the building.',
      questions: [
        {
          id: 'project_name',
          label: 'Project name',
          type: 'text',
          writesTo: '/facts/project_name/value',
        },
        {
          id: 'hauptnutzung',
          label: 'Main use',
          type: 'single_select',
          options: [
            { value: 'wohnen', label: 'Residential' },
            { value: 'buero', label: 'Office' },
            { value: 'beherbergung', label: 'Hospitality' },
            { value: 'versammlung', label: 'Assembly' },
            { value: 'gesundheit', label: 'Healthcare' },
            { value: 'landwirtschaft', label: 'Agriculture' },
            { value: 'produzierend', label: 'Manufacturing' },
            { value: 'lager', label: 'Storage' },
            { value: 'sonstiges', label: 'Other' },
          ],
          writesTo: '/facts/hauptnutzung/value',
        },
        {
          id: 'anzahl_betten',
          label: 'Number of beds',
          type: 'number',
          condition: { field: 'hauptnutzung', equals: 'beherbergung' },
          writesTo: '/facts/anzahl_betten/value',
        },
        {
          id: 'anzahl_einheiten',
          label: 'Number of units',
          type: 'number',
          condition: { field: 'hauptnutzung', equals: 'wohnen' },
          writesTo: '/facts/anzahl_einheiten/value',
        },
        {
          id: 'sicherheitskategorie',
          label: 'Safety category',
          type: 'single_select',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ],
          condition: { field: 'hauptnutzung', oneOf: ['beherbergung', 'gesundheit'] },
          writesTo: '/facts/sicherheitskategorie/value',
        },
      ],
    },
    {
      id: 'classification',
      title: 'Classification',
      description: 'How the building is categorised under the Bauordnung.',
      questions: [
        {
          id: 'widmung',
          label: 'Zoning',
          help: 'Land-use category (Widmung) from the development plan.',
          type: 'single_select',
          options: [
            { value: 'bauland', label: 'Building land (Bauland)' },
            { value: 'verkehrsflaeche', label: 'Transport area (Verkehrsfläche)' },
            { value: 'freiland', label: 'Open land (Freiland)' },
            { value: 'kerngebiet', label: 'Core zone (Kerngebiet)' },
            { value: 'gemischt', label: 'Mixed use (Gemischt)' },
          ],
          writesTo: '/facts/widmung/value',
        },
        {
          id: 'gebaeudeklasse',
          label: 'Building class',
          help: 'OIB building class GK1–GK5.',
          type: 'single_select',
          options: [
            { value: 'GK1', label: 'GK1' },
            { value: 'GK2', label: 'GK2' },
            { value: 'GK3', label: 'GK3' },
            { value: 'GK4', label: 'GK4' },
            { value: 'GK5', label: 'GK5' },
          ],
          writesTo: '/facts/gebaeudeklasse/value',
        },
        {
          id: 'bauweise',
          label: 'Construction method',
          type: 'single_select',
          options: [
            { value: 'offen', label: 'Open' },
            { value: 'gekuppelt', label: 'Coupled' },
            { value: 'geschlossen', label: 'Closed' },
          ],
          writesTo: '/facts/bauweise/value',
        },
        {
          id: 'hohe_gebaeude_details',
          label: 'High-building details',
          help: 'Relevant details for GK4/GK5 high buildings.',
          type: 'text',
          condition: { field: 'gebaeudeklasse', oneOf: ['GK4', 'GK5'] },
          writesTo: '/facts/hohe_gebaeude_details/value',
        },
      ],
    },
    {
      id: 'building',
      title: 'Building details',
      description: 'Storeys and escape level.',
      questions: [
        {
          id: 'geschosse_oberirdisch',
          label: 'Above-ground floors',
          type: 'number',
          writesTo: '/facts/geschosse_oberirdisch/value',
        },
        {
          id: 'geschosse_unterirdisch',
          label: 'Below-ground floors',
          type: 'number',
          writesTo: '/facts/geschosse_unterirdisch/value',
        },
        {
          id: 'fluchtniveau',
          label: 'Escape level',
          help: 'Height of the highest escape level above ground.',
          type: 'single_select',
          options: [
            { value: '<=7m', label: '≤ 7m' },
            { value: '7-11m', label: '7–11m' },
            { value: '11-22m', label: '11–22m' },
            { value: '>22m', label: '> 22m' },
          ],
          writesTo: '/facts/fluchtniveau/value',
        },
      ],
    },
    {
      id: 'regulatory',
      title: 'Regulatory context',
      description: 'Site constraints and whether this is new or existing fabric.',
      questions: [
        {
          id: 'grundgrenze',
          label: 'On a property boundary',
          type: 'boolean',
          writesTo: '/facts/grundgrenze/value',
        },
        {
          id: 'fluchtlinie',
          label: 'On a building line',
          type: 'boolean',
          writesTo: '/facts/fluchtlinie/value',
        },
        {
          id: 'schutzzone',
          label: 'In a protection zone',
          type: 'boolean',
          writesTo: '/facts/schutzzone/value',
        },
        {
          id: 'abweichender_bebauungsplan',
          label: 'Deviates from the development plan',
          type: 'boolean',
          writesTo: '/facts/abweichender_bebauungsplan/value',
        },
        {
          id: 'bestand_neubau',
          label: 'Existing or new building',
          type: 'single_select',
          options: [
            { value: 'bestand', label: 'Existing building' },
            { value: 'neubau', label: 'New build' },
            { value: 'zu_und_umbau', label: 'Extension / conversion' },
          ],
          writesTo: '/facts/bestand_neubau/value',
        },
        {
          id: 'bestandsalter',
          label: 'Age of existing building',
          type: 'single_select',
          options: [
            { value: '<10', label: '< 10 years' },
            { value: '10-30', label: '10–30 years' },
            { value: '30-50', label: '30–50 years' },
            { value: '>50', label: '> 50 years' },
          ],
          condition: { field: 'bestand_neubau', equals: 'bestand' },
          writesTo: '/facts/bestandsalter/value',
        },
      ],
    },
    {
      id: 'goals',
      title: 'Goals & output',
      description: 'What you want Grid to help you achieve.',
      questions: [
        {
          id: 'primary_goal',
          label: 'Primary goal',
          help: 'e.g. "Confirm fire-compartment strategy for the submission".',
          type: 'text',
          writesTo: '/goals/primary_goal',
        },
        {
          id: 'output_format',
          label: 'Preferred output',
          type: 'single_select',
          options: [
            { value: 'design_constraints', label: 'Design constraints' },
            { value: 'compliance_checklist', label: 'Compliance checklist' },
            { value: 'full_report', label: 'Full report' },
          ],
          writesTo: '/facts/output_format/value',
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// Shared intake helpers — used by both the wizard (client) and, where relevant,
// server routes. Pure and isomorphic.
// ---------------------------------------------------------------------------

/** Whether a question is currently relevant given the answers collected so far. */
export function evaluateIntakeCondition(
  question: ProjectIntakeQuestion,
  answers: Record<string, ProjectPrimitiveValue>,
): boolean {
  const cond = question.condition
  if (!cond) return true
  const answer = answers[cond.field]
  if (cond.equals !== undefined) return answer === cond.equals
  if (cond.oneOf !== undefined) return typeof answer === 'string' && cond.oneOf.includes(answer)
  return true
}

/** All questions across every stage, in definition order. */
export function flattenIntakeQuestions(definition: ProjectIntakeDefinition): ProjectIntakeQuestion[] {
  return definition.stages.flatMap((stage) => stage.questions)
}

/** Whether an answer counts as provided (non-empty). */
export function isIntakeAnswerProvided(answer: ProjectPrimitiveValue | undefined): boolean {
  if (answer === undefined || answer === null || answer === '') return false
  if (Array.isArray(answer)) return answer.length > 0
  return true
}

interface WriteTarget {
  scope: 'facts' | 'goals'
  key: string
}

/** Resolve the fact/goal key a question writes to (e.g. '/facts/widmung/value' -> facts:widmung). */
function resolveWriteTarget(writesTo: string | undefined): WriteTarget | null {
  if (!writesTo) return null
  const factMatch = writesTo.match(/^\/facts\/([^/]+)/)
  if (factMatch) return { scope: 'facts', key: factMatch[1] }
  const goalMatch = writesTo.match(/^\/goals\/([^/]+)/)
  if (goalMatch) return { scope: 'goals', key: goalMatch[1] }
  return null
}

/**
 * Build a {@link ProjectProfile} from collected intake answers using the SAME
 * JSON-pointer patch engine that chat-driven edits use, so the resulting shape is
 * identical to a profile edited through {@link applyProjectProfilePatch}.
 *
 * Currently-relevant questions that were left unanswered are recorded in
 * `profile.unknowns`, so Overview's "what Grid still doesn't know" is accurate.
 */
export function buildIntakeProfile(
  answers: Record<string, ProjectPrimitiveValue>,
  definition: ProjectIntakeDefinition,
): ProjectProfile {
  const now = new Date().toISOString()
  const patch: ProjectProfilePatchOperation[] = []
  const unknowns: string[] = []

  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue
    // Only questions that actually apply to this building count toward answered/unknown.
    if (!evaluateIntakeCondition(question, answers)) continue

    const answer = answers[question.id]
    if (!isIntakeAnswerProvided(answer)) {
      unknowns.push(target.key)
      continue
    }

    const value: ProjectPrimitiveValue = Array.isArray(answer) ? [...answer] : answer
    if (target.scope === 'goals') {
      patch.push({ op: 'add', path: `/goals/${target.key}`, value })
    } else {
      patch.push({
        op: 'add',
        path: `/facts/${target.key}`,
        value: { value, confidence: 'confirmed', source: 'onboarding', updatedAt: now },
      })
    }
  }

  for (const key of unknowns) {
    patch.push({ op: 'add', path: '/unknowns/-', value: key })
  }

  return applyProjectProfilePatch(emptyProjectProfile(), patch)
}

/**
 * Reverse of {@link buildIntakeProfile}: seed wizard answers from an already-saved
 * profile so re-entering intake opens in edit mode, prefilled.
 */
export function answersFromProfile(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
): Record<string, ProjectPrimitiveValue> {
  const answers: Record<string, ProjectPrimitiveValue> = {}

  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (!target) continue

    let value: ProjectPrimitiveValue | undefined =
      target.scope === 'goals' ? profile.goals?.[target.key] : profile.facts?.[target.key]?.value

    if (value === undefined || value === null) continue

    // Tolerate legacy multi_select values that were persisted as a JSON string.
    if (question.type === 'multi_select' && typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (Array.isArray(parsed)) value = parsed as string[]
      } catch {
        /* not JSON, keep as-is */
      }
    }

    answers[question.id] = value
  }

  return answers
}

/** Human-readable rendering of a single answer, using option labels where available. */
export function formatIntakeAnswer(
  question: ProjectIntakeQuestion,
  answer: ProjectPrimitiveValue | undefined,
): string {
  if (!isIntakeAnswerProvided(answer)) return '—'
  if (question.type === 'boolean') return answer ? 'Yes' : 'No'

  const optionLabel = (value: string): string =>
    question.options?.find((option) => option.value === value)?.label ?? value

  if (question.type === 'multi_select' && Array.isArray(answer)) {
    return answer.map(optionLabel).join(', ')
  }
  if (question.type === 'single_select' && typeof answer === 'string') {
    return optionLabel(answer)
  }
  return String(answer)
}
