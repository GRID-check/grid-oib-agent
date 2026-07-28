import { describe, expect, it } from 'vitest'
import {
  buildMissingSourceCandidates,
  classifyTarget,
  fileNameFromTarget,
  risDocumentNumber,
} from './missing-sources'
import type { FailedTargetRow } from './repository'

const row = (overrides: Partial<FailedTargetRow>): FailedTargetRow => ({
  target: 'OIB-RL6-2023.pdf, p.12',
  reason: 'citation_key_not_in_registry',
  turns: 9,
  organizations: 2,
  lastSeenAt: new Date('2026-07-27T10:00:00.000Z'),
  ...overrides,
})

describe('classifyTarget', () => {
  it('recognizes RIS URLs regardless of subdomain or scheme', () => {
    expect(classifyTarget('https://ris.bka.gv.at/Dokument.wxe?Abfrage=LrW&Dokumentnummer=LrW40009155')).toBe('ris')
    expect(classifyTarget('http://www.ris.bka.gv.at/GeltendeFassung.wxe')).toBe('ris')
  })

  it('treats other URLs as web, not as addable corpus material', () => {
    expect(classifyTarget('https://example.test/guide')).toBe('web')
  })

  it('recognizes document keys with and without a page reference', () => {
    expect(classifyTarget('OIB-RL6-2023.pdf, p.12')).toBe('document')
    expect(classifyTarget('OIB-RL6-2023.pdf')).toBe('document')
    expect(classifyTarget('Merkblatt MA37.docx, S. 4')).toBe('document')
  })

  it('does not mistake bare prose for a document', () => {
    expect(classifyTarget('Bauordnung für Wien')).toBe('web')
  })
})

describe('fileNameFromTarget', () => {
  it('strips the page reference and any path', () => {
    expect(fileNameFromTarget('OIB-RL6-2023.pdf, p.12')).toBe('OIB-RL6-2023.pdf')
    expect(fileNameFromTarget('corpus/oib/OIB-RL6-2023.pdf')).toBe('OIB-RL6-2023.pdf')
    expect(fileNameFromTarget('Merkblatt.docx, S. 4')).toBe('Merkblatt.docx')
  })

  it('returns null when there is no filename to extract', () => {
    expect(fileNameFromTarget('Bauordnung für Wien')).toBeNull()
  })
})

describe('risDocumentNumber', () => {
  it('reads the document number out of a RIS citation URL', () => {
    expect(risDocumentNumber('https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=NOR40021234')).toBe('NOR40021234')
  })

  it('returns null when the URL carries no document identity', () => {
    expect(risDocumentNumber('https://ris.bka.gv.at/Suche')).toBeNull()
  })
})

describe('buildMissingSourceCandidates', () => {
  it('marks a document absent from the corpus as an upload candidate', () => {
    const [candidate] = buildMissingSourceCandidates([row({})], ['Something-Else.pdf'], [])
    expect(candidate).toMatchObject({
      kind: 'document',
      fileName: 'OIB-RL6-2023.pdf',
      present: false,
      action: 'upload_to_base_knowledge',
      turns: 9,
      organizations: 2,
    })
  })

  it('does NOT ask for an upload of a document the corpus already holds', () => {
    // The whole point of the cross-check: re-uploading a present document
    // would be the wrong fix and would waste an operator's time.
    const [candidate] = buildMissingSourceCandidates([row({})], ['oib-rl6-2023.PDF'], [])
    expect(candidate.present).toBe(true)
    expect(candidate.action).toBe('investigate_retrieval')
  })

  it('offers a norm-catalog entry for an uncatalogued RIS pointer', () => {
    const [candidate] = buildMissingSourceCandidates(
      [row({ target: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=NOR40021234', reason: 'url_not_in_registry' })],
      [],
      ['NOR40009999'],
    )
    expect(candidate).toMatchObject({
      kind: 'ris',
      documentNumber: 'NOR40021234',
      present: false,
      action: 'add_to_norm_catalog',
    })
  })

  it('recognizes a RIS pointer already in the catalog, case-insensitively', () => {
    const [candidate] = buildMissingSourceCandidates(
      [row({ target: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=NOR40021234' })],
      [],
      ['nor40021234'],
    )
    expect(candidate.present).toBe(true)
    expect(candidate.action).toBe('investigate_retrieval')
  })

  it('offers no action for a general web page — it is not corpus material', () => {
    const [candidate] = buildMissingSourceCandidates([row({ target: 'https://example.test/a' })], [], [])
    expect(candidate).toMatchObject({ kind: 'web', action: 'none', present: false })
  })

  it('treats an unknown inventory as "not held" rather than "all fine"', () => {
    // The service passes empty inventories when the backend is unreachable.
    // Over-reporting work beats silently declaring the corpus complete.
    const [candidate] = buildMissingSourceCandidates([row({})], [], [])
    expect(candidate.present).toBe(false)
    expect(candidate.action).toBe('upload_to_base_knowledge')
  })

  it('serializes lastSeenAt as ISO for the wire', () => {
    const [candidate] = buildMissingSourceCandidates([row({})], [], [])
    expect(candidate.lastSeenAt).toBe('2026-07-27T10:00:00.000Z')
  })
})
