import { describe, expect, it } from 'vitest'

import {
  checkIntakeConsistency,
  checkIntakeConsistencyFromAnswers,
  collectFreeTextFields,
  collectStructuredContextFields,
} from './intake-consistency'
import { buildIntakeProfile, projectIntakeDefinitionV1 } from './intake-definition'
import type { ProjectPrimitiveValue } from './types'

const definition = projectIntakeDefinitionV1

type Answers = Record<string, ProjectPrimitiveValue>

/** Run the deterministic check on a raw answer map. */
function check(answers: Answers) {
  return checkIntakeConsistencyFromAnswers(answers, definition)
}

function keys(findings: ReturnType<typeof check>): string[] {
  return findings.map((f) => f.messageKey)
}

describe('checkIntakeConsistency — rule 1: low building class vs. floors', () => {
  it('flags GK1/GK2/GK3 with clearly too many above-ground floors', () => {
    for (const buildingClass of ['GK1', 'GK2', 'GK3']) {
      const findings = check({ gebaeudeklasse: buildingClass, geschosse_oberirdisch: 8 })
      expect(keys(findings)).toContain('lowClassTooManyFloors')
      const finding = findings.find((f) => f.messageKey === 'lowClassTooManyFloors')!
      expect(finding.severity).toBe('inconsistency')
      expect(finding.params).toEqual({ buildingClass, floors: 8 })
      // Both offending fields are named so the wizard can offer Edit links.
      expect(finding.fields).toEqual(['Building class', 'Above-ground floors'])
    }
  })

  it('does NOT flag a plausible low-rise (at or below the conservative ceiling)', () => {
    expect(check({ gebaeudeklasse: 'GK1', geschosse_oberirdisch: 3 })).toEqual([])
    // The threshold is deliberately conservative: 4 floors never trips it.
    expect(check({ gebaeudeklasse: 'GK2', geschosse_oberirdisch: 4 })).toEqual([])
  })

  it('does NOT flag high building classes with many floors', () => {
    expect(check({ gebaeudeklasse: 'GK4', geschosse_oberirdisch: 8 })).toEqual([])
    expect(check({ gebaeudeklasse: 'GK5', geschosse_oberirdisch: 20 })).toEqual([])
  })

  it('never triggers when either answer is skipped', () => {
    expect(check({ gebaeudeklasse: 'GK1' })).toEqual([])
    expect(check({ geschosse_oberirdisch: 8 })).toEqual([])
    expect(check({ gebaeudeklasse: '', geschosse_oberirdisch: 8 })).toEqual([])
  })

  it('reads a floor count stored as a numeric string', () => {
    const findings = check({ gebaeudeklasse: 'GK1', geschosse_oberirdisch: '8' as unknown as number })
    expect(keys(findings)).toContain('lowClassTooManyFloors')
  })
})

describe('checkIntakeConsistency — rule 2: escape level vs. floors', () => {
  it('flags a >22m escape level with too few floors', () => {
    const findings = check({ fluchtniveau: '>22m', geschosse_oberirdisch: 2 })
    const finding = findings.find((f) => f.messageKey === 'escapeLevelTooFewFloors')!
    expect(finding.severity).toBe('inconsistency')
    expect(finding.params).toEqual({ escapeLevel: '> 22m', floors: 2 })
    expect(finding.fields).toEqual(['Escape level', 'Above-ground floors'])
  })

  it('flags an 11-22m escape level with a single floor', () => {
    const findings = check({ fluchtniveau: '11-22m', geschosse_oberirdisch: 1 })
    expect(keys(findings)).toContain('escapeLevelTooFewFloors')
    expect(findings[0].params).toEqual({ escapeLevel: '11–22m', floors: 1 })
  })

  it('does NOT flag plausible escape-level / floor combinations', () => {
    expect(check({ fluchtniveau: '>22m', geschosse_oberirdisch: 8 })).toEqual([])
    expect(check({ fluchtniveau: '11-22m', geschosse_oberirdisch: 5 })).toEqual([])
    // Low bands are never flagged, even at one floor.
    expect(check({ fluchtniveau: '<=7m', geschosse_oberirdisch: 1 })).toEqual([])
    expect(check({ fluchtniveau: '7-11m', geschosse_oberirdisch: 1 })).toEqual([])
  })

  it('never triggers when either answer is skipped', () => {
    expect(check({ fluchtniveau: '>22m' })).toEqual([])
    expect(check({ geschosse_oberirdisch: 1 })).toEqual([])
  })
})

describe('checkIntakeConsistency — rule 3: orphaned conditional answers', () => {
  it('flags a bed count when the use is not hospitality', () => {
    const findings = check({ hauptnutzung: 'buero', anzahl_betten: 40 })
    const finding = findings.find((f) => f.messageKey === 'orphanedAnswer')!
    expect(finding.severity).toBe('warning')
    expect(finding.fields).toEqual(['Number of beds'])
    expect(finding.params).toEqual({ field: 'Number of beds', dependsOn: 'Main use' })
  })

  it('flags an existing-building age on a new build', () => {
    const findings = check({ bestand_neubau: 'neubau', bestandsalter: '>50' })
    expect(keys(findings)).toContain('orphanedAnswer')
    expect(findings[0].params).toMatchObject({ field: 'Age of existing building' })
  })

  it('does NOT flag a conditional answer whose condition holds', () => {
    expect(check({ hauptnutzung: 'beherbergung', anzahl_betten: 40 })).toEqual([])
    expect(check({ bestand_neubau: 'bestand', bestandsalter: '>50' })).toEqual([])
  })

  it('never triggers for a skipped conditional answer', () => {
    // Use is Office and the (hidden) bed count is simply absent → nothing to flag.
    expect(check({ hauptnutzung: 'buero' })).toEqual([])
    expect(check({ hauptnutzung: 'buero', anzahl_betten: '' })).toEqual([])
  })
})

describe('checkIntakeConsistency — profile entry point', () => {
  it('runs the rules against a reconstructed profile', () => {
    const profile = buildIntakeProfile(
      { gebaeudeklasse: 'GK1', geschosse_oberirdisch: 8, fluchtniveau: '<=7m' },
      definition,
    )
    const findings = checkIntakeConsistency(profile, definition)
    expect(keys(findings)).toContain('lowClassTooManyFloors')
  })

  it('returns [] for a consistent (or too-sparse) profile', () => {
    const profile = buildIntakeProfile({ hauptnutzung: 'wohnen', anzahl_einheiten: 10 }, definition)
    expect(checkIntakeConsistency(profile, definition)).toEqual([])
    expect(checkIntakeConsistency(buildIntakeProfile({}, definition), definition)).toEqual([])
  })
})

describe('collectFreeTextFields', () => {
  it('collects applicable free-text answers over the length threshold', () => {
    const answers: Answers = {
      focus_areas: ['sonstiges'],
      goal_details: 'Confirm the fire-compartment strategy for the submission.',
    }
    expect(collectFreeTextFields(answers, definition)).toEqual([
      { field: 'Tell Grid more', value: 'Confirm the fire-compartment strategy for the submission.' },
    ])
  })

  it('omits trivial (<10 char) and blank free text', () => {
    expect(collectFreeTextFields({ focus_areas: ['sonstiges'], goal_details: 'ok' }, definition)).toEqual([])
    expect(collectFreeTextFields({ focus_areas: ['sonstiges'], goal_details: '   ' }, definition)).toEqual([])
  })

  it('omits free text whose visibility condition does not hold', () => {
    // goal_details only applies when focus_areas includes "sonstiges".
    const answers: Answers = { focus_areas: ['einreichung'], goal_details: 'Some detailed note here.' }
    expect(collectFreeTextFields(answers, definition)).toEqual([])
  })
})

describe('collectStructuredContextFields', () => {
  it('renders applicable structured answers with option labels, excluding text', () => {
    const answers: Answers = {
      hauptnutzung: 'wohnen',
      anzahl_einheiten: 12,
      gebaeudeklasse: 'GK4',
      focus_areas: ['sonstiges'],
      goal_details: 'A free-text note that must not appear in the structured context.',
    }
    const fields = collectStructuredContextFields(answers, definition)
    expect(fields).toContainEqual({ field: 'Main use', value: 'Residential' })
    expect(fields).toContainEqual({ field: 'Building class', value: 'GK4' })
    expect(fields.some((f) => f.field === 'Tell Grid more')).toBe(false)
  })
})
