/**
 * @vitest-environment node
 */
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
    // C3 (above-ground storeys, per building) needs its building to be a Gebäude.
    const base: Answers = { 'C1@bw1': 'gebaeude' }

    const confirmed = buildIntakeProfile(
      { ...base, 'C3@bw1': 3, [modeKeyFor('C3@bw1')]: 'wert' },
      definition,
    )
    expect(confirmed.facts['geschosse_oberirdisch@bw1']?.value).toBe(3)

    const estimated = buildIntakeProfile(
      { ...base, 'C3@bw1': 4, [modeKeyFor('C3@bw1')]: 'geschaetzt' },
      definition,
    )
    expect(estimated.facts['geschosse_oberirdisch@bw1']).toBeUndefined()
    expect(estimated.assumptions['geschosse_oberirdisch@bw1']?.value).toBe(4)
    expect(estimated.assumptions['geschosse_oberirdisch@bw1']?.status).toBe('unconfirmed')

    const open = buildIntakeProfile(
      { ...base, [modeKeyFor('C3@bw1')]: 'offen' },
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
      { A2_country: 'at', A2_land: 'wien', A2_adr: 'Test', A5: ['neubau'] },
      definition,
      { projectName: 'Test' },
    )
    expect(profile.facts.country?.value).toBe('at')
    expect(profile.facts.bundesland?.value).toBe('wien')
  })

  it('leaves bundesland unset when country is de and standort_details provided', () => {
    const profile = buildIntakeProfile(
      { A2_country: 'de', standort_details: 'Bayern, Deutschland' },
      definition,
      { projectName: 'Test' },
    )
    expect(profile.facts.bundesland?.value).toBe('ausserhalb_oesterreichs')
    expect(profile.facts.standort_details?.value).toBe('Bayern, Deutschland')
  })

  it('maps yes_no_open onto a boolean fact or an unknown', () => {
    const yes = buildIntakeProfile({ B8: 'ja' }, definition)
    expect(yes.facts.anbau_grundgrenze?.value).toBe(true)

    const no = buildIntakeProfile({ B8: 'nein' }, definition)
    expect(no.facts.anbau_grundgrenze?.value).toBe(false)

    const open = buildIntakeProfile({ B8: 'offen' }, definition)
    expect(open.facts.anbau_grundgrenze).toBeUndefined()
    expect(open.unknowns).toContain('anbau_grundgrenze')
  })

  it('expands the bauwerk scope over every building and the zone scope over selected uses', () => {
    const bauwerke = [
      { id: 'bw1', name: 'Haupthaus' },
      { id: 'bw2', name: 'Nebengebäude' },
    ]
    const answers: Answers = {
      'C1@bw1': 'gebaeude',
      'C3@bw1': 5,
      [modeKeyFor('C3@bw1')]: 'wert',
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
      'C5@bw1': 9,
      [modeKeyFor('C5@bw1')]: 'geschaetzt',
      B8: 'ja',
    }

    const profile = buildIntakeProfile(answers, definition, { bauwerke })
    const restored = answersFromProfile(profile, definition)

    expect(restored.answers.A2_land).toBe('wien')
    expect(restored.answers.A5).toEqual(['neubau', 'umbau'])
    expect(restored.answers['C1@bw1']).toBe('gebaeude')
    expect(restored.answers['C5@bw1']).toBe(9)
    expect(restored.answers[modeKeyFor('C5@bw1')]).toBe('geschaetzt')
    expect(restored.answers.B8).toBe('ja')
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
    const c4 = findIntakeQuestion(definition, 'C5')!
    expect(formatIntakeAnswer(c4, 9)).toBe('9 m')
  })
})

describe('labelForProfileKey', () => {
  it('maps a raw fact key back to its intake question label', () => {
    expect(labelForProfileKey(definition, 'fluchtniveau_m')).toBe('Fluchtniveau (Zielzustand)')
    expect(labelForProfileKey(definition, 'bundesland')).toBe('Bundesland')
  })

  it('resolves a scoped key by its base', () => {
    expect(labelForProfileKey(definition, 'geschosse_oberirdisch@bw1')).toBe('Anzahl oberirdischer Geschoße (Zielzustand)')
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
    // CB1 (Baujahr) belongs to a Bestandsgebäude. Flip C2 to Neubau → prune it.
    const pruned = pruneStaleConditionalAnswers(
      { 'C2@bw1': 'neubau', 'CB1@bw1': 1962, [modeKeyFor('CB1@bw1')]: 'wert' },
      definition,
    )
    expect(pruned['CB1@bw1']).toBeUndefined()
    expect(pruned[modeKeyFor('CB1@bw1')]).toBeUndefined()
    expect(pruned['C2@bw1']).toBe('neubau')
  })

  it('keeps a conditional answer whose condition still holds', () => {
    const answers = { 'C2@bw1': 'bestand', 'CB1@bw1': 1962, [modeKeyFor('CB1@bw1')]: 'wert' }
    const pruned = pruneStaleConditionalAnswers(answers, definition)
    expect(pruned['CB1@bw1']).toBe(1962)
  })

  it('prunes a bauwerk-scope conditional within its instance', () => {
    // C2@bw1 depends on C1@bw1 === 'gebaeude'. Flip the building type → prune C2.
    const pruned = pruneStaleConditionalAnswers(
      { 'C1@bw1': 'klein', 'C3@bw1': 3, [modeKeyFor('C3@bw1')]: 'wert' },
      definition,
    )
    expect(pruned['C3@bw1']).toBeUndefined()
    expect(pruned['C1@bw1']).toBe('klein')
  })

  it('leaves unconditional and unrelated answers untouched', () => {
    const answers = { A2_country: 'at', A2_land: 'wien', A5: ['neubau'] }
    const pruned = pruneStaleConditionalAnswers(answers, definition)
    expect(pruned).toEqual(answers)
    expect(pruned).toBe(answers)
  })

  it('is a no-op when the definition is missing', () => {
    const answers = { A5: ['neubau'], 'CB1@bw1': 1962 }
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
  it('handles includes_any against a bauwerk-scope multi-select', () => {
    // CB6 needs C2=bestand AND a hull-touching measure in CB4.
    const cb6 = findIntakeQuestion(definition, 'CB6')!
    const base = { 'C2@bw1': 'bestand' }
    expect(evaluateIntakeCondition(cb6, { ...base, 'CB4@bw1': ['umbau_innen'] }, 'bw1')).toBe(false)
    expect(evaluateIntakeCondition(cb6, { ...base, 'CB4@bw1': ['kernsanierung'] }, 'bw1')).toBe(true)
  })

  it('resolves a bauwerk-scope param within the current instance', () => {
    const c3 = findIntakeQuestion(definition, 'C3')!
    expect(evaluateIntakeCondition(c3, { 'C1@bw1': 'gebaeude' }, 'bw1')).toBe(true)
    expect(evaluateIntakeCondition(c3, { 'C1@bw1': 'klein' }, 'bw1')).toBe(false)
  })

  it('answerKeyFor composes scope instance keys', () => {
    expect(answerKeyFor('C3', 'bw1')).toBe('C3@bw1')
    expect(answerKeyFor('D_we', 'bw2', 'wohnen')).toBe('D_we@bw2@wohnen')
  })

  describe('lte (the C8 gate)', () => {
    const c8 = findIntakeQuestion(definition, 'C8')!
    const gebaeude = { 'C1@bw1': 'gebaeude' }

    it('is satisfied only at or below the bound', () => {
      expect(evaluateIntakeCondition(c8, { ...gebaeude, 'C3@bw1': 4, [modeKeyFor('C3@bw1')]: 'wert' }, 'bw1')).toBe(true)
      expect(evaluateIntakeCondition(c8, { ...gebaeude, 'C3@bw1': 5, [modeKeyFor('C3@bw1')]: 'wert' }, 'bw1')).toBe(false)
    })

    it('an estimate can satisfy it, an explicitly open value cannot', () => {
      // Spec conventions: lte needs a present value whose mode is not 'offen'.
      expect(
        evaluateIntakeCondition(c8, { ...gebaeude, 'C3@bw1': 3, [modeKeyFor('C3@bw1')]: 'geschaetzt' }, 'bw1'),
      ).toBe(true)
      expect(evaluateIntakeCondition(c8, { ...gebaeude, [modeKeyFor('C3@bw1')]: 'offen' }, 'bw1')).toBe(false)
    })

    it('an absent storey count never reveals the question', () => {
      expect(evaluateIntakeCondition(c8, gebaeude, 'bw1')).toBe(false)
    })
  })
})

describe('projectIntakeDefinitionV1 shape', () => {
  it('starts with module A and carries the stable spec anchors', () => {
    expect(definition.stages[0].id).toBe('A')
    const ids = flattenIntakeQuestions(definition).map((q) => q.id)
    for (const anchor of ['A5', 'C2', 'CB1', 'CB7_fn', 'C8', 'C10_text', 'B3_stellplatz', 'D0', 'D_garagenfl']) {
      expect(ids).toContain(anchor)
    }
  })

  it('reveals the abbruch-only question F5 only when Abbruch is selected', () => {
    const f5 = findIntakeQuestion(definition, 'F5')!
    expect(evaluateIntakeCondition(f5, { A5: ['neubau'] })).toBe(false)
    expect(evaluateIntakeCondition(f5, { A5: ['neubau', 'abbruch'] })).toBe(true)
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

describe('v1.0 → v1.2 legacy bridges (answersFromProfile)', () => {
  const fact = (value: ProjectPrimitiveValue) => ({
    value,
    confidence: 'confirmed' as const,
    source: 'user_confirmed' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const empty: ProjectProfile = { facts: {}, goals: {}, unknowns: [], assumptions: {} }

  it('inverts the stored ne_unter_400 into C8 instead of reusing its key', () => {
    // v1.0 asked "alle Einheiten ≤ 400 m²?"; v1.2's C8 asks the inverse. A
    // reused key would silently flip the meaning of every stored answer — and
    // the GK derivation with it.
    const allSmall = answersFromProfile(
      { ...empty, facts: { 'ne_unter_400@bw1': fact(true) } },
      definition,
    )
    expect(allSmall.answers['C8@bw1']).toBe('nein')

    const hasLarge = answersFromProfile(
      { ...empty, facts: { 'ne_unter_400@bw1': fact(false) } },
      definition,
    )
    expect(hasLarge.answers['C8@bw1']).toBe('ja')
  })

  it('keeps an openly-unknown ne_unter_400 open', () => {
    const restored = answersFromProfile({ ...empty, unknowns: ['ne_unter_400@bw1'] }, definition)
    expect(restored.answers['C8@bw1']).toBe('offen')
  })

  it('C8 writes einheiten_ueber_400, never the legacy key', () => {
    const profile = buildIntakeProfile(
      {
        'C1@bw1': 'gebaeude',
        'C3@bw1': 3,
        [modeKeyFor('C3@bw1')]: 'wert',
        'C8@bw1': 'ja',
      },
      definition,
    )
    expect(profile.facts['einheiten_ueber_400@bw1']?.value).toBe(true)
    expect(profile.facts['ne_unter_400@bw1']).toBeUndefined()
  })

  it('moves the project-scope Bestand block onto the single building', () => {
    // v1.0's A6/A7 were one project-global statement; with exactly one
    // building it is that building's, and C2 gates open so the block shows.
    const restored = answersFromProfile(
      { ...empty, facts: { baujahr_bestand: fact(1962), denkmalschutz: fact(true) } },
      definition,
    )
    expect(restored.answers['CB1@bw1']).toBe(1962)
    expect(restored.answers[modeKeyFor('CB1@bw1')]).toBe('wert')
    expect(restored.answers['CB3@bw1']).toBe('ja')
    expect(restored.answers['C2@bw1']).toBe('bestand')
  })

  it('does NOT guess which of several buildings a legacy Bestand answer describes', () => {
    const restored = answersFromProfile(
      {
        ...empty,
        facts: {
          baujahr_bestand: fact(1962),
          'bauwerk_name@bw1': fact('Haupthaus'),
          'bauwerk_name@bw2': fact('Hoftrakt'),
        },
      },
      definition,
    )
    expect(restored.answers['CB1@bw1']).toBeUndefined()
    expect(restored.answers['CB1@bw2']).toBeUndefined()
  })

  it('folds the legacy Altlast/Baum/Schutzgebiet booleans into B4', () => {
    const restored = answersFromProfile(
      {
        ...empty,
        facts: { gefahrenzonen: fact(['hw_hq100']), altlast: fact(true), schutzgebiet: fact(true), baumbestand: fact(false) },
      },
      definition,
    )
    expect(restored.answers['B4']).toEqual(['hw_hq100', 'altlast', 'schutzgebiet'])
  })

  it('condenses the three Erschließungs-booleans, refusing a partial picture', () => {
    const full = answersFromProfile(
      { ...empty, facts: { kanal: fact(true), trinkwasser: fact(true), zufahrt_feuerwehr: fact(true) } },
      definition,
    )
    expect(full.answers['B6']).toBe('ja')

    const mixed = answersFromProfile(
      { ...empty, facts: { kanal: fact(true), trinkwasser: fact(false), zufahrt_feuerwehr: fact(true) } },
      definition,
    )
    expect(mixed.answers['B6']).toBe('teilweise')

    const partial = answersFromProfile({ ...empty, facts: { kanal: fact(true) } }, definition)
    expect(partial.answers['B6']).toBeUndefined()
  })

  it('maps Fernwärme booleans onto the status select, Anschlussgebiet first', () => {
    const zone = answersFromProfile(
      { ...empty, facts: { fernwaerme: fact(true), fernwaerme_zone: fact(true) } },
      definition,
    )
    expect(zone.answers['B7']).toBe('anschlussgebiet')

    const available = answersFromProfile({ ...empty, facts: { fernwaerme: fact(true) } }, definition)
    expect(available.answers['B7']).toBe('verfuegbar')
  })

  it('maps the legacy single Bauweise token into the multi-select', () => {
    const restored = answersFromProfile({ ...empty, facts: { 'bauweise@bw1': fact('massivbau') } }, definition)
    expect(restored.answers['C10@bw1']).toEqual(['mauerwerk_massivbau'])
  })

  it('drops a legacy hybrid Bauweise rather than guessing its members', () => {
    const restored = answersFromProfile({ ...empty, facts: { 'bauweise@bw1': fact('hybrid') } }, definition)
    expect(restored.answers['C10@bw1']).toBeUndefined()
  })

  it('carries a legacy Zertifizierung into the fused F4', () => {
    const restored = answersFromProfile(
      { ...empty, facts: { foerderung: fact(['wohnbaufoerderung']), zertifizierung: fact('klimaaktiv') } },
      definition,
    )
    expect(restored.answers['F4']).toEqual(['wohnbaufoerderung', 'klimaaktiv'])
  })

  it('appends the merged G-texts instead of overwriting', () => {
    const restored = answersFromProfile(
      {
        ...empty,
        facts: {
          kontext_beschreibung: fact('Ein Wohnhaus.'),
          kontext_grundstueck: fact('Hanglage.'),
          kontext_sonstiges: fact('Noch etwas.'),
        },
      },
      definition,
    )
    expect(restored.answers['G1']).toBe('Ein Wohnhaus.\n\nHanglage.')
    expect(restored.answers['G4']).toBe('Noch etwas.')
  })

  it('folds the four legacy Technik booleans into E2', () => {
    const restored = answersFromProfile(
      { ...empty, facts: { 'pv@bw1': fact(true), 'versickerung@bw1': fact(true), 'kuehlung@bw1': fact(false) } },
      definition,
    )
    expect(restored.answers['E2@bw1']).toEqual(['pv', 'versickerung'])
  })
})

describe('v1.2 catalog shape', () => {
  it('carries the Schnellstart core path', () => {
    const core = flattenIntakeQuestions(definition)
      .filter((q) => q.core)
      .map((q) => q.id)
    // The spec's core:true set — the Schnellstart path.
    expect(new Set(core)).toEqual(
      new Set([
        'A1', 'A2_adr', 'A2_country', 'A2_land', 'A4', 'A5',
        'B1', 'B1_text', 'B2', 'B2_upl',
        'C1', 'C2', 'CB3', 'CB4', 'C3', 'C5', 'C7',
        'D0', 'DX1',
        'G1',
      ]),
    )
  })

  it('marks the B-Plan extraction Kernset', () => {
    const kernset = flattenIntakeQuestions(definition)
      .filter((q) => q.kernset)
      .map((q) => q.id)
    expect(new Set(kernset)).toEqual(
      new Set(['B3_hoehe', 'B3_weise', 'B3_dichte', 'B3_flucht', 'B3_bes', 'B3_stellplatz']),
    )
  })

  it('dropped the v1.0-only questions', () => {
    const ids = new Set(flattenIntakeQuestions(definition).map((q) => q.id))
    for (const gone of ['A3', 'A6', 'A11', 'B1_orig', 'B6_tag', 'B7_kanal', 'B9', 'C12', 'E6', 'F6', 'G5']) {
      expect(ids.has(gone)).toBe(false)
    }
  })
})
