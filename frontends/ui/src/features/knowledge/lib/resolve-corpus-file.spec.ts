/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { resolveCorpusFileName } from './resolve-corpus-file'

const files = [
  { fileName: 'oib-rl_1_ausgabe_mai_2023.pdf', state: 'ingested' },
  { fileName: 'oib-rl_2.1_ausgabe_mai_2023.pdf', state: 'ingested' },
  { fileName: 'oib-rl_2_ausgabe_mai_2023.pdf', state: 'ingested' },
  { fileName: 'oib-rl_2_leitfaden_ausgabe_mai_2023.pdf', state: 'ingested' },
  { fileName: 'oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf', state: 'ingested' },
  { fileName: 'aenderungen_oib-rl_2_ausgabe_mai_2023.pdf', state: 'ingested' },
  // The name oib.or.at publishes OIB-RL 2.2 under, with its Erläuterungen beside it.
  { fileName: 'oib-richtlinie_2.2_ausgabe_mai_2023.pdf', state: 'ingested' },
  { fileName: 'erlaeuterungen-zu-oib-richtlinie_2.2_ausgabe_mai_2023.pdf', state: 'ingested' },
]

describe('resolveCorpusFileName', () => {
  it('resolves a plain Richtlinie label to the main guideline PDF', () => {
    expect(resolveCorpusFileName('OIB-Richtlinie 2', files)).toBe('oib-rl_2_ausgabe_mai_2023.pdf')
    expect(resolveCorpusFileName('OIB Richtlinie 2.1', files)).toBe('oib-rl_2.1_ausgabe_mai_2023.pdf')
    expect(resolveCorpusFileName('OIB-RL 1 (Ausgabe 2023)', files)).toBe('oib-rl_1_ausgabe_mai_2023.pdf')
  })

  it('prefers the Leitfaden variant when the label asks for it', () => {
    expect(resolveCorpusFileName('OIB-Richtlinie 2 Leitfaden', files)).toBe(
      'oib-rl_2_leitfaden_ausgabe_mai_2023.pdf',
    )
  })

  it('resolves the Begriffsbestimmungen document', () => {
    expect(resolveCorpusFileName('OIB Begriffsbestimmungen', files)).toBe(
      'oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf',
    )
  })

  it('returns null for non-OIB laws and unknown codes', () => {
    expect(resolveCorpusFileName('Wiener Bauordnung § 76', files)).toBeNull()
    expect(resolveCorpusFileName('OIB-Richtlinie 9', files)).toBeNull()
    expect(resolveCorpusFileName('', files)).toBeNull()
  })

  it('never resolves to files the corpus does not hold', () => {
    const indexOnly = [{ fileName: 'oib-rl_2_ausgabe_mai_2023.pdf', state: 'removed' }]
    expect(resolveCorpusFileName('OIB-Richtlinie 2', indexOnly)).toBeNull()
  })

  it('resolves OIB-RL 2.2 under the name the OIB publishes it with', () => {
    expect(resolveCorpusFileName('OIB-Richtlinie 2.2', files)).toBe('oib-richtlinie_2.2_ausgabe_mai_2023.pdf')
  })
})
