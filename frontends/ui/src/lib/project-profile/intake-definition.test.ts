import { describe, expect, it } from 'vitest'

import {
  answerKeyFor,
  answersFromProfile,
  BUNDESLAND_TOKENS,
  buildIntakeProfile,
  COUNTRY_TOKENS,
  evaluateIntakeCondition,
  findIntakeQuestion,
  flattenIntakeQuestions,
  formatIntakeAnswer,
  humanizeProfileKey,
  isValidBundeslandToken,
  isValidCountryToken,
  labelForProfileKey,
  mergeIntakeProfile,
  modeKeyFor,
  projectIntakeDefinitionV1,
  pruneStaleConditionalAnswers,
  validateProfilePatchVocabulary,
} from './intake-definition'
import { ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfilePatchOperation } from './types'

const definition = projectIntakeDefinitionV1
type Answers = Record<string, ProjectPrimitiveValue>

describe('buildIntakeProfile', () => {
  it('writes confirmed facts through the shared patch engine', () => {
    const answers: Answers = {
      A2_country: 'at',
      A2_land: 'tirol',
      A2_adr: 'Innrain 1, 6020 Innsbruck',
      A5: ['neubau'],
    }

    const profile = buildIntakeProfile(answers, definition)

    expect(() => ProjectProfileSchema.parse(profile)).not.toThrow()
    expect(profile.facts.bundesland?.value).toBe('tirol')
    expect(profile.facts.bundesland?.source).toBe('onboarding')
    expect(profile.facts.bundesland?.confidence).toBe('confirmed')
    expect(profile.facts.standort_adresse?.value).toBe('Innrain 1, 6020 Innsbruck')
    expect(profile.facts.vorhabensart?.value).toEqual(['neubau'])
  })

  it('seeds project_name from the created project instead of asking again', () => {
    const profile = buildIntakeProfile({}, definition, { projectName: '  Haus am See ' })

    expect(profile.facts.project_name?.value).toBe('Haus am See')
    expect(profile.facts.project_name?.source).toBe('onboarding')
    expect(profile.facts.project_name?.confidence).toBe('confirmed')
  })

  it('lets an explicit A1 answer override the seeded project name', () => {
    const profile = buildIntakeProfile({ A1: 'Renamed Project' }, definition, { projectName: 'Seed' })
    expect(profile.facts.project_name?.value).toBe('Renamed Project')
  })

  it('captures the Bundesland as a confirmed fact (jurisdiction is a hard fact)', () => {
    const profile = buildIntakeProfile({ A2_country: 'at', A2_land: 'tirol' }, definition)

    expect(profile.facts.bundesland?.value).toBe('tirol')
    expect(profile.facts.bundesland?.confidence).toBe('confirmed')
    expect(profile.unknowns).not.toContain('bundesland')
    expect(profile.unknowns).not.toContain('standort_details')
  })

  it('records the missing Bundesland as an unknown', () => {
    const profile = buildIntakeProfile({ A2_country: 'at', A5: ['neubau'] }, definition)
    expect(profile.unknowns).toContain('bundesland')
  })

  it('asks for a free-text location only outside Austria', () => {
    const profile = buildIntakeProfile({ A2_country: 'de' }, definition)
    expect(profile.unknowns).toContain('standort_details')

    const withDetails = buildIntakeProfile(
      { A2_country: 'de', standort_details: 'Bayern, Deutschland' },
      definition,
    )
    expect(withDetails.facts.standort_details?.value).toBe('Bayern, Deutschland')
    expect(withDetails.facts.bundesland?.value).toBe('ausserhalb_oesterreichs')
  })

  it('maps the number_tri answer modes onto facts / assumptions / unknowns', () => {
    // C2 (above-ground storeys, per building) needs its building to be a Gebäude.
    const base: Answers = { 'C1@bw1': 'gebaeude' }

    const confirmed = buildIntakeProfile(
      { ...base, 'C2@bw1': 3, [modeKeyFor('C2@bw1')]: 'wert' },
      definition,
    )
    expect(confirmed.facts['geschosse_oberirdisch@bw1']?.value).toBe(3)

    const estimated = buildIntakeProfile(
      { ...base, 'C2@bw1': 4, [modeKeyFor('C2@bw1')]: 'geschaetzt' },
      definition,
    )
    expect(estimated.facts['geschosse_oberirdisch@bw1']).toBeUndefined()
    expect(estimated.assumptions['geschosse_oberirdisch@bw1']?.value).toBe(4)
    expect(estimated.assumptions['geschosse_oberirdisch@bw1']?.status).toBe('unconfirmed')

    const open = buildIntakeProfile(
      { ...base, [modeKeyFor('C2@bw1')]: 'offen' },
      definition,
    )
    expect(open.unknowns).toContain('geschosse_oberirdisch@bw1')
  })

  it('derives bundesland=ausserhalb_oesterreichs when country is de', () => {
    const profile = buildIntakeProfile({ A2_country: 'de' }, definition)
    expect(profile.facts.bundesland?.value).toBe('ausserhalb_oesterreichs')
  })

  it('derives country=at from an AT bundesland for legacy profiles', () => {
    const profile = buildIntakeProfile(
      { A2_country: 'at', A2_land: 'wien', A2_adr: 'Test', A5: ['neubau'] } as any,
      definition,
      { projectName: 'Test' },
    )
    expect(profile.facts.country?.value).toBe('at')
    expect(profile.facts.bundesland?.value).toBe('wien')
  })

  it('leaves bundesland unset when country is de and standort_details provided', () => {
    const profile = buildIntakeProfile(
      { A2_country: 'de', standort_details: 'Bayern, Deutschland' } as any,
      definition,
      { projectName: 'Test' },
    )
    expect(profile.facts.bundesland?.value).toBe('ausserhalb_oesterreichs')
    expect(profile.facts.standort_details?.value).toBe('Bayern, Deutschland')
  })

  it('maps yes_no_open onto a boolean fact or an unknown', () => {
    const yes = buildIntakeProfile({ B5: 'ja' }, definition)
    expect(yes.facts.altlast?.value).toBe(true)

    const no = buildIntakeProfile({ B5: 'nein' }, definition)
    expect(no.facts.altlast?.value).toBe(false)

    const open = buildIntakeProfile({ B5: 'offen' }, definition)
    expect(open.facts.altlast).toBeUndefined()
    expect(open.unknowns).toContain('altlast')
  })

  it('expands the bauwerk scope over every building and the zone scope over selected uses', () => {
    const bauwerke = [
      { id: 'bw1', name: 'Haupthaus' },
      { id: 'bw2', name: 'Nebengebäude' },
    ]
    const answers: Answers = {
      'C1@bw1': 'gebaeude',
      'C2@bw1': 5,
      [modeKeyFor('C2@bw1')]: 'wert',
      'C1@bw2': 'gebaeude',
      'D0@bw1': ['wohnen'],
      'D_we@bw1@wohnen': 12,
      [modeKeyFor('D_we@bw1@wohnen')]: 'wert',
    }

    const profile = buildIntakeProfile(answers, definition, { bauwerke })

    expect(profile.facts['geschosse_oberirdisch@bw1']?.value).toBe(5)
    expect(profile.facts['bauwerk_name@bw1']?.value).toBe('Haupthaus')
    expect(profile.facts['bauwerk_name@bw2']?.value).toBe('Nebengebäude')
    expect(profile.facts['wohneinheiten@bw1@wohnen']?.value).toBe(12)
  })
})

describe('answersFromProfile', () => {
  it('round-trips a built profile back into wizard answers and the building list', () => {
    const bauwerke = [{ id: 'bw1', name: 'Haupthaus' }]
    const answers: Answers = {
      A2_country: 'at',
      A2_land: 'wien',
      A5: ['neubau', 'umbau'],
      'C1@bw1': 'gebaeude',
      'C4@bw1': 9,
      [modeKeyFor('C4@bw1')]: 'geschaetzt',
      B5: 'ja',
    }

    const profile = buildIntakeProfile(answers, definition, { bauwerke })
    const restored = answersFromProfile(profile, definition)

    expect(restored.answers.A2_land).toBe('wien')
    expect(restored.answers.A5).toEqual(['neubau', 'umbau'])
    expect(restored.answers['C1@bw1']).toBe('gebaeude')
    expect(restored.answers['C4@bw1']).toBe(9)
    expect(restored.answers[modeKeyFor('C4@bw1')]).toBe('geschaetzt')
    expect(restored.answers.B5).toBe('ja')
    expect(restored.bauwerke).toEqual([{ id: 'bw1', name: 'Haupthaus' }])
  })
})

describe('formatIntakeAnswer', () => {
  const landQuestion = findIntakeQuestion(definition, 'A2_land')!

  it('renders option labels rather than raw values', () => {
    expect(formatIntakeAnswer(landQuestion, 'wien')).toBe('Wien')
  })

  it('renders a dash for missing answers', () => {
    expect(formatIntakeAnswer(landQuestion, undefined)).toBe('—')
  })

  it('appends the unit for a number_tri answer', () => {
    const c4 = findIntakeQuestion(definition, 'C4')!
    expect(formatIntakeAnswer(c4, 9)).toBe('9 m')
  })
})

describe('labelForProfileKey', () => {
  it('maps a raw fact key back to its intake question label', () => {
    expect(labelForProfileKey(definition, 'fluchtniveau_m')).toBe('Fluchtniveau')
    expect(labelForProfileKey(definition, 'bundesland')).toBe('Bundesland')
  })

  it('resolves a scoped key by its base', () => {
    expect(labelForProfileKey(definition, 'geschosse_oberirdisch@bw1')).toBe('Anzahl oberirdischer Geschoße')
  })

  it('falls back to a title-cased humanization for genuinely unknown keys', () => {
    expect(labelForProfileKey(definition, 'some_unmapped_key')).toBe('Some Unmapped Key')
  })
})

describe('humanizeProfileKey', () => {
  it('title-cases snake_case keys and strips a scope suffix', () => {
    expect(humanizeProfileKey('bebauungsplan_besonderes')).toBe('Bebauungsplan Besonderes')
    expect(humanizeProfileKey('fluchtniveau_m@bw1')).toBe('Fluchtniveau M')
  })
})

describe('validateProfilePatchVocabulary', () => {
  const validate = (op: ProjectProfilePatchOperation['op'], path: string, value?: unknown) =>
    validateProfilePatchVocabulary([{ op, path, value }])

  it('accepts an allowed single-select value', () => {
    expect(() => validate('add', '/facts/bauwerkstyp', 'gebaeude')).not.toThrow()
  })

  it('rejects a single-select value outside the options', () => {
    expect(() => validate('add', '/facts/bauwerkstyp', 'nope')).toThrow(/Bauwerkstyp/)
  })

  it('rejects a Bundesland outside the vocabulary', () => {
    expect(() => validate('add', '/facts/bundesland', 'bayern')).toThrow(/Bundesland/)
    expect(() => validate('add', '/facts/bundesland', 'wien')).not.toThrow()
    expect(() => validate('add', '/facts/bundesland', 'ausserhalb_oesterreichs')).not.toThrow()
  })

  it('rejects a non-boolean for a yes_no_open fact', () => {
    expect(() => validate('add', '/facts/denkmalschutz', 'yes')).toThrow(/Denkmalschutz/)
  })

  it('accepts a finite number for a number_tri fact', () => {
    expect(() => validate('add', '/facts/geschosse_oberirdisch', 3)).not.toThrow()
  })

  it('resolves a scoped key by its base', () => {
    expect(() => validate('add', '/facts/geschosse_oberirdisch@bw1', 3)).not.toThrow()
    expect(() => validate('add', '/facts/bauwerkstyp@bw1', 'nope')).toThrow(/Bauwerkstyp/)
  })

  it('lets unknown keys through — the model may record novel facts', () => {
    expect(() => validate('add', '/facts/some_novel_fact', 'anything')).not.toThrow()
  })

  it('validates a shaped { value } op the same as a bare value', () => {
    expect(() =>
      validate('add', '/facts/bauwerkstyp', {
        value: 'nope',
        confidence: 'confirmed',
        source: 'user_confirmed',
        updatedAt: '2026-07-08T00:00:00.000Z',
      }),
    ).toThrow(/Bauwerkstyp/)
  })

  it('validates the deep /facts/<key>/value path form', () => {
    expect(() => validate('add', '/facts/bauwerkstyp/value', 'nope')).toThrow(/Bauwerkstyp/)
  })

  it('always passes remove operations', () => {
    expect(() => validate('remove', '/facts/bauwerkstyp')).not.toThrow()
  })

  it('rejects a multi-select value outside the options', () => {
    expect(() => validate('add', '/facts/vorhabensart', ['neubau', 'nope'])).toThrow(/Art des Vorhabens/)
  })
})

describe('pruneStaleConditionalAnswers', () => {
  it('drops a conditional answer once its condition no longer holds', () => {
    // A6 (Baujahr) applies only for existing-building work. Pure Neubau → prune it.
    const pruned = pruneStaleConditionalAnswers(
      { A5: ['neubau'], A6: 1962, [modeKeyFor('A6')]: 'wert' },
      definition,
    )
    expect(pruned.A6).toBeUndefined()
    expect(pruned[modeKeyFor('A6')]).toBeUndefined()
    expect(pruned.A5).toEqual(['neubau'])
  })

  it('keeps a conditional answer whose condition still holds', () => {
    const answers = { A5: ['umbau'], A6: 1962, [modeKeyFor('A6')]: 'wert' }
    const pruned = pruneStaleConditionalAnswers(answers, definition)
    expect(pruned.A6).toBe(1962)
  })

  it('prunes a bauwerk-scope conditional within its instance', () => {
    // C2@bw1 depends on C1@bw1 === 'gebaeude'. Flip the building type → prune C2.
    const pruned = pruneStaleConditionalAnswers(
      { 'C1@bw1': 'klein', 'C2@bw1': 3, [modeKeyFor('C2@bw1')]: 'wert' },
      definition,
    )
    expect(pruned['C2@bw1']).toBeUndefined()
    expect(pruned['C1@bw1']).toBe('klein')
  })

  it('leaves unconditional and unrelated answers untouched', () => {
    const answers = { A2_country: 'at', A2_land: 'wien', A5: ['neubau'] }
    const pruned = pruneStaleConditionalAnswers(answers, definition)
    expect(pruned).toEqual(answers)
    expect(pruned).toBe(answers)
  })

  it('is a no-op when the definition is missing', () => {
    const answers = { A5: ['neubau'], A6: 1962 }
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
      bundesland: fact('wien'),
      // Agent-recorded NOVEL fact (no intake question owns this key):
      brandabschnitt_flaeche: fact(1200),
    },
    goals: { zieltermin: '2027-03-01' },
    unknowns: ['statik_gutachten'],
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
    const built = buildIntakeProfile({ A2_country: 'at', A2_land: 'tirol' }, definition)
    const merged = mergeIntakeProfile(built, storedProfile, definition)

    // Intake-owned key wins from the wizard...
    expect(merged.facts.bundesland?.value).toBe('tirol')
    // ...while everything the wizard doesn't own survives.
    expect(merged.facts.brandabschnitt_flaeche?.value).toBe(1200)
    expect(merged.goals.zieltermin).toBe('2027-03-01')
    expect(merged.unknowns).toContain('statik_gutachten')
    expect(merged.assumptions.widmung?.value).toBe('bauland')
    expect(() => ProjectProfileSchema.parse(merged)).not.toThrow()
  })

  it('does NOT resurrect an intake answer the user just cleared', () => {
    const built = buildIntakeProfile({ A2_country: 'at' }, definition)
    const merged = mergeIntakeProfile(built, storedProfile, definition)

    expect(merged.facts.bundesland).toBeUndefined()
    expect(merged.unknowns).toContain('bundesland')
  })

  it('returns the built profile unchanged when there is no stored profile', () => {
    const built = buildIntakeProfile({ A2_country: 'at', A2_land: 'wien' }, definition)
    expect(mergeIntakeProfile(built, null, definition)).toBe(built)
  })
})

describe('evaluateIntakeCondition', () => {
  it('handles includes_any against a project-scope multi-select', () => {
    const a6 = findIntakeQuestion(definition, 'A6')!
    expect(evaluateIntakeCondition(a6, { A5: ['neubau'] })).toBe(false)
    expect(evaluateIntakeCondition(a6, { A5: ['umbau'] })).toBe(true)
  })

  it('resolves a bauwerk-scope param within the current instance', () => {
    const c2 = findIntakeQuestion(definition, 'C2')!
    expect(evaluateIntakeCondition(c2, { 'C1@bw1': 'gebaeude' }, 'bw1')).toBe(true)
    expect(evaluateIntakeCondition(c2, { 'C1@bw1': 'klein' }, 'bw1')).toBe(false)
  })

  it('answerKeyFor composes scope instance keys', () => {
    expect(answerKeyFor('C2', 'bw1')).toBe('C2@bw1')
    expect(answerKeyFor('D_we', 'bw2', 'wohnen')).toBe('D_we@bw2@wohnen')
  })
})

describe('projectIntakeDefinitionV1 shape', () => {
  it('starts with module A and carries the stable spec anchors', () => {
    expect(definition.stages[0].id).toBe('A')
    const ids = flattenIntakeQuestions(definition).map((q) => q.id)
    for (const anchor of ['A5', 'C4', 'D0', 'D_garagenfl']) {
      expect(ids).toContain(anchor)
    }
  })

  it('reveals the abbruch-only question F6 only when Abbruch is selected', () => {
    const f6 = findIntakeQuestion(definition, 'F6')!
    expect(evaluateIntakeCondition(f6, { A5: ['neubau'] })).toBe(false)
    expect(evaluateIntakeCondition(f6, { A5: ['neubau', 'abbruch'] })).toBe(true)
  })

  it('marks exactly the konzept-required questions as required', () => {
    const required = flattenIntakeQuestions(definition)
      .filter((q) => q.required)
      .map((q) => q.id)
    expect(new Set(required)).toEqual(new Set(['A1', 'A2_adr', 'A2_country', 'A2_land', 'A5']))
  })
})

describe('BUNDESLAND_TOKENS / isValidBundeslandToken', () => {
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

  it('stays byte-identical to the A2_land question options (single source of truth)', () => {
    const question = flattenIntakeQuestions(definition).find((q) => q.id === 'A2_land')!
    expect(BUNDESLAND_TOKENS).toEqual(question.options?.map((option) => option.value))
  })

  it('isValidBundeslandToken accepts every known token', () => {
    for (const token of BUNDESLAND_TOKENS) {
      expect(isValidBundeslandToken(token)).toBe(true)
    }
  })

  it('isValidBundeslandToken rejects unknown/malformed tokens', () => {
    expect(isValidBundeslandToken('atlantis')).toBe(false)
    expect(isValidBundeslandToken('')).toBe(false)
    expect(isValidBundeslandToken('Wien')).toBe(false)
  })
})

describe('COUNTRY_TOKENS / isValidCountryToken', () => {
  it('contains the four country options', () => {
    expect(COUNTRY_TOKENS).toEqual(['at', 'de', 'ch', 'other'])
  })

  it('accepts recognized country tokens', () => {
    expect(isValidCountryToken('at')).toBe(true)
    expect(isValidCountryToken('de')).toBe(true)
    expect(isValidCountryToken('ch')).toBe(true)
    expect(isValidCountryToken('other')).toBe(true)
  })

  it('rejects unknown country tokens', () => {
    expect(isValidCountryToken('fr')).toBe(false)
    expect(isValidCountryToken('')).toBe(false)
    expect(isValidCountryToken('AT')).toBe(false)
  })
})
