/**
 * @vitest-environment node
 */
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

function check(answers: Answers) {
  return checkIntakeConsistencyFromAnswers(answers, definition)
}
function keys(findings: ReturnType<typeof check>): string[] {
  return findings.map((f) => f.messageKey)
}

describe('checkIntakeConsistency — fossil heat source on a new build', () => {
  it('flags a gas heat supply on a new build (Erneuerbare-Wärme-Gesetz)', () => {
    const findings = check({ A5: ['neubau'], 'E1@bw1': 'gas' })
    const finding = findings.find((f) => f.messageKey === 'fossilNeubauConflict')!
    expect(finding).toBeDefined()
    expect(finding.severity).toBe('inconsistency')
    expect(finding.params).toMatchObject({ bauwerk: 'Bauwerk 1' })
    expect(finding.fields[0]).toBe('Art des Vorhabens')
  })

  it('flags each offending building independently', () => {
    const findings = check({
      A5: ['neubau'],
      'E1@bw1': 'gas',
      'E1@bw2': 'waermepumpe',
      'E1@bw3': 'gas',
    })
    expect(findings.filter((f) => f.messageKey === 'fossilNeubauConflict')).toHaveLength(2)
  })

  it('does NOT flag gas on an existing-building project', () => {
    expect(check({ A5: ['umbau', 'sanierung'], 'E1@bw1': 'gas' })).toEqual([])
  })

  it('does NOT flag a non-fossil supply on a new build', () => {
    expect(check({ A5: ['neubau'], 'E1@bw1': 'fernwaerme' })).toEqual([])
  })

  it('never triggers when either answer is skipped', () => {
    expect(check({ A5: ['neubau'] })).toEqual([])
    expect(check({ 'E1@bw1': 'gas' })).toEqual([])
  })
})

describe('checkIntakeConsistency — profile entry point', () => {
  it('runs the rules against a reconstructed profile', () => {
    const profile = buildIntakeProfile({ A5: ['neubau'], 'E1@bw1': 'gas' }, definition)
    expect(keys(checkIntakeConsistency(profile, definition))).toContain('fossilNeubauConflict')
  })

  it('returns [] for a consistent (or too-sparse) profile', () => {
    const profile = buildIntakeProfile({ A5: ['neubau'], 'E1@bw1': 'waermepumpe' }, definition)
    expect(checkIntakeConsistency(profile, definition)).toEqual([])
    expect(checkIntakeConsistency(buildIntakeProfile({}, definition), definition)).toEqual([])
  })
})

describe('collectFreeTextFields', () => {
  it('collects applicable free-text answers over the length threshold', () => {
    const answers: Answers = {
      G1: 'Ein städtebaulich markanter Wohnbau am Fluss mit begrüntem Innenhof.',
    }
    expect(collectFreeTextFields(answers, definition)).toEqual([
      { field: 'Projektbeschreibung & Entwurfsidee', value: 'Ein städtebaulich markanter Wohnbau am Fluss mit begrüntem Innenhof.' },
    ])
  })

  it('omits trivial (<10 char) and blank free text', () => {
    expect(collectFreeTextFields({ G1: 'ok' }, definition)).toEqual([])
    expect(collectFreeTextFields({ G1: '   ' }, definition)).toEqual([])
  })
})

describe('collectStructuredContextFields', () => {
  it('renders applicable structured answers with option labels, excluding free text', () => {
    const answers: Answers = {
      A2_country: 'at',
      A2_land: 'wien',
      A5: ['neubau'],
      G1: 'Ein Freitext, der nicht im strukturierten Kontext auftauchen darf.',
    }
    const fields = collectStructuredContextFields(answers, definition)
    expect(fields).toContainEqual({ field: 'Bundesland', value: 'Wien' })
    expect(fields).toContainEqual({ field: 'Art des Vorhabens', value: 'Neubau' })
    expect(fields.some((f) => f.field === 'Projektbeschreibung & Entwurfsidee')).toBe(false)
  })
})
