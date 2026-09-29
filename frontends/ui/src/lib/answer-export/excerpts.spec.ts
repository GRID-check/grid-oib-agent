/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { getDictionary } from '@/i18n/dictionaries'
import { legalBasisBlocks, quotedPassages } from './excerpts'

const t = createTranslator(getDictionary('de'), 'answerExport')

const ANSWER = [
  'Die Garage braucht eine Lüftung.',
  '',
  '> „Garagen sind mechanisch zu entlüften." [1]',
  '',
  '> Ein Zitat ohne Quelle.',
  '',
  '> „Nicht belegt." [7]',
].join('\n')

describe('quotedPassages', () => {
  it('reads every quote that ends in a citation, without the marker', () => {
    expect(quotedPassages(ANSWER)).toEqual([
      { text: '„Garagen sind mechanisch zu entlüften."', number: 1 },
      { text: '„Nicht belegt."', number: 7 },
    ])
  })
})

describe('legalBasisBlocks', () => {
  it('promotes only the quotes whose citation resolves to a reference', () => {
    const blocks = legalBasisBlocks(ANSWER, [{ number: 1, label: 'OIB-RL 2.1', page: 'S. 5' }], t)
    expect(blocks[0]).toEqual({ kind: 'heading', level: 2, text: 'Rechtsgrundlagen' })
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', runs: [{ text: '[1] ' }, { text: 'OIB-RL 2.1, S. 5' }] })
    expect(blocks[2]).toMatchObject({ style: 'quote', runs: [{ text: '„Garagen sind mechanisch zu entlüften."' }] })
  })

  it('prints no section without a resolved quote', () => {
    expect(legalBasisBlocks('> Ein Zitat.', [{ number: 1, label: 'X' }], t)).toEqual([])
  })

  it('promotes only a quote the server found verbatim, where it checked', () => {
    const references = [
      { number: 1, label: 'OIB-RL 2.1' },
      { number: 7, label: 'OIB-RL 4' },
    ]
    const stamps = [
      { text: 'Garagen sind mechanisch zu entlüften.', status: 'verbatim' as const, number: 1 },
      { text: 'Nicht belegt.', status: 'not_found' as const },
    ]
    const blocks = legalBasisBlocks(ANSWER, references, t, stamps)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toMatchObject({ runs: [{ text: '[1] ' }, { text: 'OIB-RL 2.1' }] })
    expect(legalBasisBlocks(ANSWER, references, t, [])).toEqual([])
  })
})
