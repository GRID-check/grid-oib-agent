import { describe, expect, it } from 'vitest'

import {
  answersFromProfile,
  BUNDESLAND_TOKENS,
  buildIntakeProfile,
  evaluateIntakeCondition,
  flattenIntakeQuestions,
  formatIntakeAnswer,
  humanizeProfileKey,
  isValidBundeslandToken,
  labelForProfileKey,
  mergeIntakeProfile,
  projectIntakeDefinitionV1,
  pruneStaleConditionalAnswers,
  validateProfilePatchVocabulary,
} from './intake-definition'
import { ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfilePatchOperation } from './types'

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

  it('captures the Bundesland as a confirmed fact (jurisdiction is a hard fact)', () => {
    const profile = buildIntakeProfile({ bundesland: 'tirol' }, definition)

    expect(profile.facts.bundesland?.value).toBe('tirol')
    expect(profile.facts.bundesland?.confidence).toBe('confirmed')
    expect(profile.unknowns).not.toContain('bundesland')
    // standort_details applies only outside Austria -> not an unknown here.
    expect(profile.unknowns).not.toContain('standort_details')
  })

  it('records the missing Bundesland as an unknown', () => {
    const profile = buildIntakeProfile({ hauptnutzung: 'wohnen' }, definition)

    expect(profile.unknowns).toContain('bundesland')
  })

  it('asks for a free-text location only outside Austria', () => {
    const profile = buildIntakeProfile({ bundesland: 'ausserhalb_oesterreichs' }, definition)

    expect(profile.unknowns).toContain('standort_details')

    const withDetails = buildIntakeProfile(
      { bundesland: 'ausserhalb_oesterreichs', standort_details: 'Bayern, Deutschland' },
      definition,
    )
    expect(withDetails.facts.standort_details?.value).toBe('Bayern, Deutschland')
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

  it('rejects a Bundesland outside the vocabulary', () => {
    expect(() => validate('add', '/facts/bundesland', 'bayern')).toThrow(/located/)
    expect(() => validate('add', '/facts/bundesland', 'wien')).not.toThrow()
    expect(() => validate('add', '/facts/bundesland', 'ausserhalb_oesterreichs')).not.toThrow()
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
      /Piloti help with/,
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

describe('mergeIntakeProfile', () => {
  const fact = (value: ProjectPrimitiveValue) => ({
    value,
    confidence: 'confirmed' as const,
    source: 'user_confirmed' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  const storedProfile: ProjectProfile = {
    facts: {
      // Intake-owned, previously answered:
      hauptnutzung: fact('buero'),
      // Agent-recorded NOVEL fact (no intake question owns this key):
      brandabschnitt_flaeche: fact(1200),
    },
    goals: {
      focus_areas: ['einreichung'],
      // Agent-recorded novel goal:
      zieltermin: '2027-03-01',
    },
    unknowns: ['gebaeudeklasse', 'statik_gutachten'],
    assumptions: {
      widmung: {
        value: 'bauland',
        status: 'unconfirmed' as const,
        reason: 'agent guess',
        source: 'agent_suggested' as const,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }

  it('preserves agent-recorded novel facts, goals, unknowns, and assumptions', () => {
    const built = buildIntakeProfile({ hauptnutzung: 'wohnen', anzahl_einheiten: 8 }, definition)
    const merged = mergeIntakeProfile(built, storedProfile, definition)

    // The wizard's fresh answers win for intake-owned keys...
    expect(merged.facts.hauptnutzung?.value).toBe('wohnen')
    expect(merged.facts.anzahl_einheiten?.value).toBe(8)
    // ...while everything the wizard doesn't own survives.
    expect(merged.facts.brandabschnitt_flaeche?.value).toBe(1200)
    expect(merged.goals.zieltermin).toBe('2027-03-01')
    expect(merged.unknowns).toContain('statik_gutachten')
    expect(merged.assumptions.widmung?.value).toBe('bauland')
    expect(() => ProjectProfileSchema.parse(merged)).not.toThrow()
  })

  it('does NOT resurrect an intake answer the user just cleared', () => {
    // hauptnutzung answered before, left blank now → it must land in unknowns,
    // not silently reappear from the stored profile.
    const built = buildIntakeProfile({}, definition)
    const merged = mergeIntakeProfile(built, storedProfile, definition)

    expect(merged.facts.hauptnutzung).toBeUndefined()
    expect(merged.unknowns).toContain('hauptnutzung')
  })

  it('drops stored intake-owned unknowns that the wizard has now answered', () => {
    const built = buildIntakeProfile({ gebaeudeklasse: 'GK3' }, definition)
    const merged = mergeIntakeProfile(built, storedProfile, definition)

    expect(merged.facts.gebaeudeklasse?.value).toBe('GK3')
    expect(merged.unknowns).not.toContain('gebaeudeklasse')
    // Non-intake unknowns are kept, without duplicates.
    expect(merged.unknowns.filter((k) => k === 'statik_gutachten')).toHaveLength(1)
  })

  it('returns the built profile unchanged when there is no stored profile', () => {
    const built = buildIntakeProfile({ hauptnutzung: 'wohnen', anzahl_einheiten: 8 }, definition)
    expect(mergeIntakeProfile(built, null, definition)).toBe(built)
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

describe('BUNDESLAND_TOKENS / isValidBundeslandToken', () => {
  // Backlog T3-9 follow-up (2026-07-16, user-mandated): the structured
  // `bundesland` envelope field must validate against the exact same
  // vocabulary the intake wizard offers (nine states + ausserhalb_oesterreichs)
  // -- mirrored (not imported) on the Python side by
  // aiq_agent.project_context's `_BUNDESLAND_TOKENS`.
  it('contains exactly the nine Bundesland tokens plus ausserhalb_oesterreichs', () => {
    expect(new Set(BUNDESLAND_TOKENS)).toEqual(
      new Set([
        'wien',
        'niederoesterreich',
        'oberoesterreich',
        'steiermark',
        'kaernten',
        'salzburg',
        'tirol',
        'vorarlberg',
        'burgenland',
        'ausserhalb_oesterreichs',
      ]),
    )
  })

  it('stays byte-identical to the bundesland question options (single source of truth)', () => {
    const bundeslandQuestion = flattenIntakeQuestions(definition).find((q) => q.id === 'bundesland')!
    expect(BUNDESLAND_TOKENS).toEqual(bundeslandQuestion.options?.map((option) => option.value))
  })

  it('isValidBundeslandToken accepts every known token', () => {
    for (const token of BUNDESLAND_TOKENS) {
      expect(isValidBundeslandToken(token)).toBe(true)
    }
  })

  it('isValidBundeslandToken rejects unknown/malformed tokens', () => {
    expect(isValidBundeslandToken('atlantis')).toBe(false)
    expect(isValidBundeslandToken('')).toBe(false)
    expect(isValidBundeslandToken('Wien')).toBe(false) // case-sensitive: the wire token is lowercase
  })
})
