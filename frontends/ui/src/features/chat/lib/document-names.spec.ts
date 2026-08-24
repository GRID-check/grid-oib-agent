/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { oibDisplayTitle, documentDisplayName, documentShortName } from './document-names'

describe('oibDisplayTitle — mirror of norm_registry.guess_display_title', () => {
  // Cases lifted from the backend docstring; both sides must agree or a card's
  // name would change when a message is reloaded from storage.
  test.each([
    ['oib-rl_2_ausgabe_mai_2023.pdf', 'OIB-Richtlinie 2, Ausgabe Mai 2023'],
    ['oib-rl_2.3_ausgabe_mai_2023.pdf', 'OIB-Richtlinie 2.3, Ausgabe Mai 2023'],
    ['oib-rl_6-leitfaden_ausgabe_mai_2023.pdf', 'OIB-Richtlinie 6 – Leitfaden, Ausgabe Mai 2023'],
    ['oib-rl_2_leitfaden_ausgabe_mai_2023.pdf', 'OIB-Richtlinie 2 – Leitfaden, Ausgabe Mai 2023'],
    ['erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf', 'Erläuterungen zu OIB-Richtlinie 2, Ausgabe Mai 2023'],
    ['aenderungen_oib-rl_5_ausgabe_mai_2023.pdf', 'Änderungen zu OIB-Richtlinie 5, Ausgabe Mai 2023'],
    ['oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf', 'OIB-Richtlinie Begriffsbestimmungen, Ausgabe Mai 2023'],
    [
      'oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023_rev.1.pdf',
      'OIB-Richtlinie – Zitierte Normen und sonstige technische Regelwerke, Ausgabe Mai 2023, Rev. 1',
    ],
  ])('%s → %s', (fileName, expected) => {
    expect(oibDisplayTitle(fileName)).toBe(expected)
  })

  test('a path is resolved to its base name', () => {
    expect(oibDisplayTitle('data/oib/oib-rl_1_ausgabe_mai_2023.pdf')).toBe('OIB-Richtlinie 1, Ausgabe Mai 2023')
  })

  test('returns null for anything that is not an OIB corpus filename', () => {
    expect(oibDisplayTitle('Grundriss_EG.pdf')).toBeNull()
    expect(oibDisplayTitle('Bauordnung für Wien')).toBeNull()
    expect(oibDisplayTitle('')).toBeNull()
  })
})

describe('documentDisplayName', () => {
  test('an authoritative wire title always wins', () => {
    expect(documentDisplayName('oib-rl_2_ausgabe_mai_2023.pdf', 'Hausregel Brandschutz')).toBe('Hausregel Brandschutz')
  })

  test('falls back to the OIB derivation when the wire carries no title', () => {
    expect(documentDisplayName('oib-rl_2_ausgabe_mai_2023.pdf')).toBe('OIB-Richtlinie 2, Ausgabe Mai 2023')
    expect(documentDisplayName('oib-rl_2_ausgabe_mai_2023.pdf', '   ')).toBe('OIB-Richtlinie 2, Ausgabe Mai 2023')
  })

  test('humanizes a plain upload filename', () => {
    expect(documentDisplayName('Brandschutzkonzept_2023.pdf')).toBe('Brandschutzkonzept 2023')
    expect(documentDisplayName('Grundriss_EG.pdf')).toBe('Grundriss EG')
    expect(documentDisplayName('projekt/statik_bericht.docx')).toBe('Statik bericht')
  })

  test('hyphens survive — they carry meaning in norm identifiers', () => {
    expect(documentDisplayName('EN-1993-1-2.pdf')).toBe('EN-1993-1-2')
  })

  test('leaves a name that has no known document extension intact', () => {
    // A hostname from the URL-scan fallback must not lose its TLD.
    expect(documentDisplayName('ris.bka.gv.at', 'ris.bka.gv.at')).toBe('ris.bka.gv.at')
    expect(documentDisplayName('Konzept_v1.2')).toBe('Konzept v1.2')
  })

  test('is idempotent on an already-human name', () => {
    const human = 'OIB-Richtlinie 2, Ausgabe Mai 2023'
    expect(documentDisplayName(human)).toBe(human)
    expect(documentDisplayName(documentDisplayName('oib-rl_2_ausgabe_mai_2023.pdf'))).toBe(human)
    expect(documentDisplayName('Bauordnung für Wien')).toBe('Bauordnung für Wien')
  })

  test('empty input stays empty', () => {
    expect(documentDisplayName('')).toBe('')
  })
})

describe('documentShortName', () => {
  test('drops the edition and revision tail for tight card real estate', () => {
    expect(documentShortName('oib-rl_2_ausgabe_mai_2023.pdf')).toBe('OIB-Richtlinie 2')
    expect(documentShortName('oib-rl_6-leitfaden_ausgabe_mai_2023.pdf')).toBe('OIB-Richtlinie 6 – Leitfaden')
    expect(documentShortName('erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf')).toBe(
      'Erläuterungen zu OIB-Richtlinie 2'
    )
    expect(
      documentShortName('oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023_rev.1.pdf')
    ).toBe('OIB-Richtlinie – Zitierte Normen und sonstige technische Regelwerke')
  })

  test('keeps a comma that carries content', () => {
    expect(documentShortName('Bauordnung für Wien, § 108')).toBe('Bauordnung für Wien, § 108')
  })

  test('never returns an empty name', () => {
    expect(documentShortName('Ausgabe Mai 2023')).toBe('Ausgabe Mai 2023')
  })
})
