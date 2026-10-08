/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { FINGERPRINT_KEYS } from '@/lib/cross-project/fingerprint'
import { experienceVocabulary } from './vocabulary'
import { experienceVocabularySchema } from './types'

describe('experienceVocabulary', () => {
  const vocabulary = experienceVocabulary()

  it('covers every fingerprint key, each with options', () => {
    for (const key of FINGERPRINT_KEYS) {
      const entry = vocabulary[key]
      expect(entry, key).toBeDefined()
      expect(entry.options.length, key).toBeGreaterThan(0)
    }
  })

  it('reads the choice-type of each fact off the intake definition', () => {
    expect(vocabulary.bundesland.multiple).toBe(false)
    expect(vocabulary.bauweise.multiple).toBe(true)
    expect(vocabulary.nutzungen.multiple).toBe(true)
    expect(vocabulary.vorhabensart.multiple).toBe(true)
  })

  it('labels the tokens as the intake wizard does', () => {
    const bundesland = vocabulary.bundesland.options
    expect(bundesland).toContainEqual({ token: 'niederoesterreich', label: 'Niederösterreich' })
    const bauweise = vocabulary.bauweise.options
    expect(bauweise).toContainEqual({ token: 'holzbau', label: 'Holzbau' })
  })

  it('leaves out the wizard\'s „noch offen": no document states that a question is undecided', () => {
    for (const entry of Object.values(experienceVocabulary())) {
      expect(entry.options.map((option) => option.token)).not.toContain('offen')
    }
  })

  it('gives the Gebäudeklasse as tokens 1 to 5, labelled GK n', () => {
    expect(vocabulary.gebaeudeklasse).toEqual({
      multiple: false,
      options: ['1', '2', '3', '4', '5'].map((grade) => ({ token: grade, label: `GK ${grade}` })),
    })
  })

  it('gives the OIB edition as the six editions, labelled OIB-Richtlinien <year>', () => {
    expect(vocabulary.oib_ausgabe.multiple).toBe(false)
    expect(vocabulary.oib_ausgabe.options.map((option) => option.token)).toEqual([
      '2007',
      '2011',
      '2015',
      '2019',
      '2023',
      '2025',
    ])
    expect(vocabulary.oib_ausgabe.options[3]).toEqual({ token: '2019', label: 'OIB-Richtlinien 2019' })
  })

  it('is valid against the wire schema the backend request carries', () => {
    expect(experienceVocabularySchema.safeParse(vocabulary).success).toBe(true)
  })
})
