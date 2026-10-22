import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { createTranslator } from '@/i18n/translate'
import {
  ALLOWED_TAGS,
  DOCUMENT_TYPE_TAGS,
  LABELLED_TAGS,
  areTagsValid,
  documentTypeOf,
  tagLabel,
} from './tag-vocabulary'

/**
 * A stored tag is what the vocabulary lists; what a person reads is its label.
 * The token `correspondence` (the Dokumentart of an E-Mail-Verlauf) is the
 * first tag stored in English, so it is the one read through i18n.
 */
describe('tag vocabulary', () => {
  it('lists correspondence as a document type, so it validates, filters and types a document', () => {
    expect(DOCUMENT_TYPE_TAGS).toContain('correspondence')
    expect(ALLOWED_TAGS.has('correspondence')).toBe(true)
    expect(areTagsValid(['correspondence', 'Brandschutz'])).toBe(true)
    expect(documentTypeOf(['Brandschutz', 'correspondence'])).toBe('correspondence')
  })

  it('keeps the old German spelling out: „Korrespondenz“ is a label, never a stored tag', () => {
    expect(ALLOWED_TAGS.has('Korrespondenz')).toBe(false)
  })

  it.each([
    ['de', de, 'Korrespondenz'],
    ['en', en, 'Correspondence'],
  ] as const)('reads a token as its %s label', (_locale, dictionary, label) => {
    const t = createTranslator(dictionary, 'files')
    expect(tagLabel('correspondence', t)).toBe(label)
  })

  it('reads every labelled token from every dictionary, and a German value as itself', () => {
    for (const dictionary of [de, en]) {
      const t = createTranslator(dictionary, 'files')
      for (const tag of LABELLED_TAGS) {
        expect(tagLabel(tag, t)).not.toBe(`documentTag.${tag}`)
        expect(tagLabel(tag, t)).not.toBe(tag)
      }
      expect(tagLabel('Grundriss', t)).toBe('Grundriss')
      expect(tagLabel('a free topic', t)).toBe('a free topic')
    }
  })
})
