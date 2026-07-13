import { describe, expect, it } from 'vitest'

import { buildPatchPreviewRows } from './patch-preview'
import { ProjectProfileSchema } from './types'
import type { ProjectProfile, ProjectProfilePatchOperation } from './types'

const NOW = '2026-07-08T00:00:00.000Z'

function fact(value: ProjectProfile['facts'][string]['value']): ProjectProfile['facts'][string] {
  return { value, confidence: 'confirmed', source: 'onboarding', updatedAt: NOW }
}

const baseProfile: ProjectProfile = ProjectProfileSchema.parse({
  facts: {
    hauptnutzung: fact('buero'),
    grundgrenze: fact(false),
  },
  goals: { focus_areas: ['einreichung'] },
})

function op(
  o: ProjectProfilePatchOperation['op'],
  path: string,
  value?: unknown,
): ProjectProfilePatchOperation {
  return { op: o, path, value }
}

describe('buildPatchPreviewRows', () => {
  it('maps a known enum key to its option label, before from the current profile', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/hauptnutzung', 'wohnen')], baseProfile)
    expect(rows).toEqual([{ label: 'Main use', before: 'Office', after: 'Residential' }])
  })

  it('renders an em dash for a before that is not yet set', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/gebaeudeklasse', 'GK4')], baseProfile)
    expect(rows).toEqual([{ label: 'Building class', before: '—', after: 'GK4' }])
  })

  it('renders remove as an em dash after value', () => {
    const rows = buildPatchPreviewRows([op('remove', '/facts/hauptnutzung')], baseProfile)
    expect(rows[0]).toMatchObject({ label: 'Main use', before: 'Office', after: '—' })
  })

  it('formats booleans as Yes/No', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/grundgrenze', true)], baseProfile)
    expect(rows[0]).toMatchObject({ label: 'On a property boundary', before: 'No', after: 'Yes' })
  })

  it('joins multi-select option labels', () => {
    const rows = buildPatchPreviewRows(
      [op('add', '/goals/focus_areas', ['einreichung', 'brandschutz'])],
      baseProfile,
    )
    expect(rows[0].after).toBe(
      'Getting a permit submission (Einreichung) approved, Fire-safety concept',
    )
  })

  it('accepts the deep /facts/<key>/value path form', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/gebaeudeklasse/value', 'GK4')], baseProfile)
    expect(rows[0]).toMatchObject({ label: 'Building class', after: 'GK4' })
  })

  it('unwraps a shaped { value } op value', () => {
    const shaped = { value: 'wohnen', confidence: 'confirmed', source: 'user_confirmed', updatedAt: NOW }
    const rows = buildPatchPreviewRows([op('add', '/facts/hauptnutzung', shaped)], baseProfile)
    expect(rows[0].after).toBe('Residential')
  })

  it('never hides a foreign object value — it JSON-stringifies it', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/hauptnutzung', { foo: 'bar' })], baseProfile)
    expect(rows[0].after).toBe('{"foo":"bar"}')
  })

  it('falls back to a humanized label for an unknown key', () => {
    const rows = buildPatchPreviewRows(
      [op('add', '/facts/some_novel_fact', 'brandschutzkonzept liegt vor')],
      baseProfile,
    )
    expect(rows[0]).toMatchObject({
      label: 'Some Novel Fact',
      before: '—',
      after: 'brandschutzkonzept liegt vor',
    })
  })

  it('leaves before blank when the profile is not yet loaded', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/hauptnutzung', 'wohnen')], null)
    expect(rows).toEqual([{ label: 'Main use', before: '', after: 'Residential' }])
  })
})
