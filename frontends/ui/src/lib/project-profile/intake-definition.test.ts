import { describe, expect, it } from 'vitest'

import {
  answersFromProfile,
  buildIntakeProfile,
  evaluateIntakeCondition,
  flattenIntakeQuestions,
  formatIntakeAnswer,
  humanizeProfileKey,
  labelForProfileKey,
  projectIntakeDefinitionV1,
  pruneStaleConditionalAnswers,
  validateProfilePatchVocabulary,
} from './intake-definition'
import { ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue, ProjectProfilePatchOperation } from './types'

const definition = projectIntakeDefinitionV1

describe('buildIntakeProfile', () => {
  it('writes confirmed facts and goals through the shared patch engine', () => {
    const answers: Record<string, ProjectPrimitiveValue> = {
      hauptnutzung: 'wohnen',
      anzahl_einheiten: 12,
      focus_areas: ['einreichung', 'brandschutz'],
    }

    const profile = buildIntakeProfile(answers, definition)

    // Shape matches the schema exactly (same engine as chat-driven edits).
    expect(() => ProjectProfileSchema.parse(profile)).not.toThrow()
    expect(profile.facts.anzahl_einheiten?.value).toBe(12)
    expect(profile.facts.anzahl_einheiten?.source).toBe('onboarding')
    expect(profile.facts.anzahl_einheiten?.confidence).toBe('confirmed')
    expect(profile.goals.focus_areas).toEqual(['einreichung', 'brandschutz'])
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
    }

    const profile = buildIntakeProfile(answers, definition)
    const restored = answersFromProfile(profile, definition)

    expect(restored.hauptnutzung).toBe('wohnen')
    expect(restored.anzahl_einheiten).toBe(12)
    expect(restored.grundgrenze).toBe(true)
    expect(restored.focus_areas).toEqual(['einreichung', 'sanierung'])
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

describe('labelForProfileKey', () => {
  it('maps a raw fact key back to its intake question label', () => {
    expect(labelForProfileKey(definition, 'fluchtniveau')).toBe('Escape level')
    expect(labelForProfileKey(definition, 'hauptnutzung')).toBe('Main use')
  })

  it('falls back to a title-cased humanization for genuinely unknown keys', () => {
    expect(labelForProfileKey(definition, 'some_unmapped_key')).toBe('Some Unmapped Key')
  })
})

describe('humanizeProfileKey', () => {
  it('title-cases snake_case keys', () => {
    expect(humanizeProfileKey('hohe_gebaeude_details')).toBe('Hohe Gebaeude Details')
  })
})

describe('validateProfilePatchVocabulary', () => {
  const validate = (op: ProjectProfilePatchOperation['op'], path: string, value?: unknown) =>
    validateProfilePatchVocabulary([{ op, path, value }])

  it('accepts an allowed single-select value', () => {
    expect(() => validate('add', '/facts/gebaeudeklasse', 'GK4')).not.toThrow()
  })

  it('rejects a single-select value outside the options', () => {
    expect(() => validate('add', '/facts/gebaeudeklasse', 'GK9')).toThrow(/Building class/)
  })

  it('rejects a non-boolean for a boolean fact', () => {
    expect(() => validate('add', '/facts/grundgrenze', 'yes')).toThrow(/On a property boundary/)
  })

  it('accepts a finite number for a number fact', () => {
    expect(() => validate('add', '/facts/geschosse_oberirdisch', 3)).not.toThrow()
  })

  it('lets unknown keys through — the model may record novel facts', () => {
    expect(() => validate('add', '/facts/some_novel_fact', 'anything')).not.toThrow()
  })

  it('validates a shaped { value } op the same as a bare value', () => {
    expect(() =>
      validate('add', '/facts/gebaeudeklasse', {
        value: 'GK9',
        confidence: 'confirmed',
        source: 'user_confirmed',
        updatedAt: '2026-07-08T00:00:00.000Z',
      }),
    ).toThrow(/Building class/)
  })

  it('validates the deep /facts/<key>/value path form', () => {
    expect(() => validate('add', '/facts/gebaeudeklasse/value', 'GK9')).toThrow(/Building class/)
  })

  it('always passes remove operations', () => {
    expect(() => validate('remove', '/facts/gebaeudeklasse')).not.toThrow()
  })

  it('rejects a multi-select value outside the options', () => {
    expect(() => validate('add', '/goals/focus_areas', ['einreichung', 'nope'])).toThrow(
      /Grid help with/,
    )
  })
})

describe('pruneStaleConditionalAnswers', () => {
  it('drops a conditional answer once its condition no longer holds', () => {
    // Bed count applies only when the main use is Hospitality. Switch to Office →
    // the stale bed count must be removed (otherwise the orphanedAnswer rule fires).
    const pruned = pruneStaleConditionalAnswers(
      { hauptnutzung: 'buero', anzahl_betten: 40 },
      definition,
    )
    expect(pruned.anzahl_betten).toBeUndefined()
    expect(pruned.hauptnutzung).toBe('buero')
  })

  it('keeps a conditional answer whose condition still holds', () => {
    const answers = { hauptnutzung: 'beherbergung', anzahl_betten: 40 }
    const pruned = pruneStaleConditionalAnswers(answers, definition)
    expect(pruned.anzahl_betten).toBe(40)
  })

  it('leaves unconditional and unrelated answers untouched', () => {
    const answers = {
      hauptnutzung: 'wohnen',
      anzahl_einheiten: 12,
      geschosse_oberirdisch: 3,
    }
    const pruned = pruneStaleConditionalAnswers(answers, definition)
    expect(pruned).toEqual(answers)
    // No change → same reference is returned (cheap no-op).
    expect(pruned).toBe(answers)
  })

  it('prunes chained conditions recursively', () => {
    // goal_details depends on focus_areas including "sonstiges"; bestandsalter depends
    // on bestand_neubau === "bestand". Flip both governing answers → both dependents go.
    const pruned = pruneStaleConditionalAnswers(
      {
        focus_areas: ['einreichung'],
        goal_details: 'Some note that no longer applies.',
        bestand_neubau: 'neubau',
        bestandsalter: '>50',
      },
      definition,
    )
    expect(pruned.goal_details).toBeUndefined()
    expect(pruned.bestandsalter).toBeUndefined()
    expect(pruned.focus_areas).toEqual(['einreichung'])
    expect(pruned.bestand_neubau).toBe('neubau')
  })

  it('is a no-op when the definition is missing', () => {
    const answers = { hauptnutzung: 'buero', anzahl_betten: 40 }
    expect(pruneStaleConditionalAnswers(answers, null)).toBe(answers)
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
