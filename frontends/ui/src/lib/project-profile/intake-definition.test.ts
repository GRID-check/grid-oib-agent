import { describe, expect, it } from 'vitest'

import {
  answersFromProfile,
  buildIntakeProfile,
  evaluateIntakeCondition,
  flattenIntakeQuestions,
  formatIntakeAnswer,
  projectIntakeDefinitionV1,
} from './intake-definition'
import { ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue } from './types'

const definition = projectIntakeDefinitionV1

describe('buildIntakeProfile', () => {
  it('writes confirmed facts and goals through the shared patch engine', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      hauptnutzung: 'wohnen',
      anzahl_einheiten: 12,
      focus_areas: ['einreichung', 'brandschutz'],
      deadline: 'this_month',
    }

    const profile = buildIntakeProfile(answers, definition)

    // Shape matches the schema exactly (same engine as chat-driven edits).
    expect(() => ProjectProfileSchema.parse(profile)).not.toThrow()
    expect(profile.facts.anzahl_einheiten?.value).toBe(12)
    expect(profile.facts.anzahl_einheiten?.source).toBe('onboarding')
    expect(profile.facts.anzahl_einheiten?.confidence).toBe('confirmed')
    expect(profile.goals.focus_areas).toEqual(['einreichung', 'brandschutz'])
    expect(profile.goals.deadline).toBe('this_month')
  })

  it('seeds project_name from the created project instead of asking again', () => {
    const profile = buildIntakeProfile({}, definition, { projectName: '  Haus am See ' })

    expect(profile.facts.project_name?.value).toBe('Haus am See')
    expect(profile.facts.project_name?.source).toBe('onboarding')
    expect(profile.facts.project_name?.confidence).toBe('confirmed')
    // No project_name question exists anymore, so it can never be an unknown.
    expect(profile.unknowns).not.toContain('project_name')
  })

  it('records relevant-but-unanswered questions in unknowns', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      hauptnutzung: 'wohnen',
    }

    const profile = buildIntakeProfile(answers, definition)

    // anzahl_einheiten is now relevant (wohnen) and unanswered -> unknown.
    expect(profile.unknowns).toContain('anzahl_einheiten')
    // Skippable questions still count as unknowns when left blank.
    expect(profile.unknowns).toContain('widmung')
    // anzahl_betten only applies to beherbergung -> NOT an unknown here.
    expect(profile.unknowns).not.toContain('anzahl_betten')
  })

  it('does not treat conditionally-hidden questions as unknown', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      hauptnutzung: 'buero',
      focus_areas: ['compliance_check'],
    }

    const profile = buildIntakeProfile(answers, definition)
    expect(profile.unknowns).not.toContain('anzahl_einheiten')
    expect(profile.unknowns).not.toContain('anzahl_betten')
    expect(profile.unknowns).not.toContain('sicherheitskategorie')
    // goal_details only applies when 'sonstiges' is among the focus areas.
    expect(profile.unknowns).not.toContain('goal_details')
  })
})

describe('answersFromProfile', () => {
  it('round-trips a built profile back into wizard answers for edit mode', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      hauptnutzung: 'wohnen',
      anzahl_einheiten: 12,
      grundgrenze: true,
      focus_areas: ['einreichung', 'sanierung'],
      deadline: 'no_deadline',
    }

    const profile = buildIntakeProfile(answers, definition)
    const restored = answersFromProfile(profile, definition)

    expect(restored.hauptnutzung).toBe('wohnen')
    expect(restored.anzahl_einheiten).toBe(12)
    expect(restored.grundgrenze).toBe(true)
    expect(restored.focus_areas).toEqual(['einreichung', 'sanierung'])
    expect(restored.deadline).toBe('no_deadline')
  })
})

describe('formatIntakeAnswer', () => {
  const useQuestion = flattenIntakeQuestions(definition).find((q) => q.id === 'hauptnutzung')!

  it('renders option labels rather than raw values', () => {
    expect(formatIntakeAnswer(useQuestion, 'wohnen')).toBe('Residential')
  })

  it('renders a dash for missing answers', () => {
    expect(formatIntakeAnswer(useQuestion, undefined)).toBe('—')
  })
})

describe('projectIntakeDefinitionV1 shape', () => {
  it('asks for the focus first and never re-asks the project name', () => {
    expect(definition.stages[0].id).toBe('goal')
    expect(flattenIntakeQuestions(definition).some((q) => q.id === 'project_name')).toBe(false)
  })

  it('reveals the free-text goal only when "something else" is among the focus areas', () => {
    const goalDetails = flattenIntakeQuestions(definition).find((q) => q.id === 'goal_details')!

    expect(evaluateIntakeCondition(goalDetails, { focus_areas: ['einreichung'] })).toBe(false)
    expect(evaluateIntakeCondition(goalDetails, { focus_areas: ['einreichung', 'sonstiges'] })).toBe(true)
  })
})
