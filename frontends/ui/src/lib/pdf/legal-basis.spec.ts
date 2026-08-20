/**
 * The narrowing `legalBasisSection` does, asked directly.
 *
 * `markdown-pdf.spec.ts` already reads this module's output back out of real
 * PDF bytes, which is the right question for everything about how a Fundstelle
 * LOOKS. These are a different question: what this module lets through. The
 * input is jsonb that crossed a process boundary, the output is a page that
 * leaves the app attached to an Einreichung, and the interesting cases are the
 * ones that produce nothing — a claim about absence is cheaper and clearer to
 * make against the returned sections than against a rendered page that would
 * have to be searched for words that are not on it.
 */

import { describe, expect, it } from 'vitest'
import { getDictionary } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import { legalBasisSection } from './legal-basis'

const t = createTranslator(getDictionary('de'), 'answerExport')
const de = getDictionary('de').answerExport

/** Every label a printed card's blocks carry, flattened. */
function labels(cards: unknown): string[] {
  return legalBasisSection(cards, t).flatMap((section) =>
    section.blocks.flatMap((block) => {
      if (block.kind === 'rows') return block.rows.map((row) => row.label)
      if (block.kind === 'prose') return [block.label]
      return []
    })
  )
}

describe('legalBasisSection', () => {
  it('prints a card that names its law', () => {
    const [section] = legalBasisSection([{ type: 'legal_basis', law: 'OIB-Richtlinie 2' }], t)

    expect(section.heading).toBe(de.legalBasis)
    expect(labels([{ type: 'legal_basis', law: 'OIB-Richtlinie 2' }])).toContain(de.fields.law)
  })

  // `LegalBasisCard.law` is `str` with `min_length=1` and no default
  // (`src/aiq_agent/cards/models.py`), so a card that passed `validate_cards`
  // always has one. These are the cards that did not.
  describe('a card that does not name its law is not a citation', () => {
    it.each([
      ['no law key at all', { type: 'legal_basis', summary: 'Die Fluchtwegbreite beträgt 1,20 m.' }],
      ['an empty law', { type: 'legal_basis', law: '', article: '§ 3' }],
      ['a law that is only whitespace', { type: 'legal_basis', law: '   ', article: '§ 3' }],
      ['a law a newer build stored as an object', { type: 'legal_basis', law: { name: 'OIB 2' }, article: '§ 3' }],
      ['a law stored as a number', { type: 'legal_basis', law: 2, article: '§ 3' }],
    ])('contributes nothing when it has %s', (_case, card) => {
      // Not merely "no heading": the card's OTHER fields must not print either.
      // An entry under „Rechtsgrundlagen" that states a legal position and
      // names no law does not read as an incomplete card on a page that has
      // left the app — it reads as a claim whose source the reader could not
      // find.
      expect(legalBasisSection([card], t)).toEqual([])
    })

    it('costs only itself — a good card in the same answer still prints', () => {
      const sections = legalBasisSection(
        [
          { type: 'legal_basis', summary: 'Ohne Fundstelle.' },
          { type: 'legal_basis', law: 'Wiener Bauordnung', article: '§ 108' },
        ],
        t
      )

      expect(sections).toHaveLength(1)
      const text = JSON.stringify(sections)
      expect(text).toContain('Wiener Bauordnung')
      expect(text).not.toContain('Ohne Fundstelle.')
    })
  })

  it('ignores every other card type in the same answer', () => {
    expect(
      legalBasisSection(
        [
          { type: 'summary', content: 'Zusammenfassung.' },
          { type: 'diagram', title: 'Ablauf', source: 'graph TD' },
        ],
        t
      )
    ).toEqual([])
  })

  it('returns nothing for a value that is not a list', () => {
    // `metadata.cards` is jsonb; a build that stored an object, or a null, must
    // not reach `.filter` as if it were an array.
    for (const notAList of [undefined, null, 'cards', 42, { type: 'legal_basis', law: 'OIB 2' }]) {
      expect(legalBasisSection(notAList, t)).toEqual([])
    }
  })
})
