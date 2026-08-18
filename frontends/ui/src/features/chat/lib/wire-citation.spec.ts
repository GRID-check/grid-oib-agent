/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  citationFromWire,
  citationsFromWireList,
  dedupeBufferedCitations,
  mergeCitation,
  normalizeOrigin,
  sameCitation,
} from './wire-citation'
import type { WireCitationSource } from '../types'

const KB_WIRE: WireCitationSource = {
  content: '[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12',
  title: 'OIB-Richtlinie 2',
  citation_key: 'oib-rl_2_ausgabe_mai_2023.pdf, p.12',
  collection: 'oib_knowledge',
  source_type: 'knowledge_layer',
  tool: 'knowledge_search',
  origin: 'kb',
  file_name: 'oib-rl_2_ausgabe_mai_2023.pdf',
  page: 12,
  kind: 'baurecht',
  lane: 'baurecht_oib',
  lane_label: 'OIB-Richtlinie',
  number: 1,
}

describe('normalizeOrigin', () => {
  test('accepts the three origin tokens, bracketed or bare', () => {
    expect(normalizeOrigin('kb')).toBe('kb')
    expect(normalizeOrigin('[RIS]')).toBe('ris')
    expect(normalizeOrigin(' Web ')).toBe('web')
  })

  test('rejects anything else', () => {
    expect(normalizeOrigin('project')).toBeUndefined()
    expect(normalizeOrigin(null)).toBeUndefined()
  })
})

describe('citationFromWire', () => {
  test('carries the canonical taxonomy fields through', () => {
    const citation = citationFromWire(KB_WIRE)
    expect(citation.kind).toBe('baurecht')
    expect(citation.lane).toBe('baurecht_oib')
    expect(citation.laneLabel).toBe('OIB-Richtlinie')
    expect(citation.number).toBe(1)
    expect(citation.fileName).toBe('oib-rl_2_ausgabe_mai_2023.pdf')
    expect(citation.page).toBe(12)
  })

  test('narrows an unknown kind instead of passing it through', () => {
    expect(citationFromWire({ ...KB_WIRE, kind: 'nonsense' }).kind).toBeUndefined()
  })

  test('drops a non-positive or fractional citation number', () => {
    expect(citationFromWire({ ...KB_WIRE, number: 0 }).number).toBeUndefined()
    expect(citationFromWire({ ...KB_WIRE, number: 1.5 }).number).toBeUndefined()
  })

  test('keeps a real binding classification', () => {
    expect(citationFromWire({ ...KB_WIRE, binding_status: 'verbindlich_erklaert' }).bindingStatus).toBe(
      'verbindlich_erklaert',
    )
  })

  test('drops unbekannt to undefined so it renders as no badge, not a hedge', () => {
    // The one direction a legal signal must not fail in: absence reads as
    // "not known", never as "not binding".
    expect(citationFromWire({ ...KB_WIRE, binding_status: 'unbekannt' }).bindingStatus).toBeUndefined()
    expect(citationFromWire(KB_WIRE).bindingStatus).toBeUndefined()
  })
})

describe('sameCitation', () => {
  test('matches on the document key regardless of the rest', () => {
    const discovered = citationFromWire(KB_WIRE)
    const cited = citationFromWire({ citation_key: KB_WIRE.citation_key, content: 'x' }, { isCited: true })
    expect(sameCitation(discovered, cited)).toBe(true)
  })

  test('matches URLs that differ only by a trailing slash', () => {
    const a = citationFromWire({ url: 'https://example.com/a' })
    const b = citationFromWire({ url: 'https://example.com/a/' })
    expect(sameCitation(a, b)).toBe(true)
  })

  test('keeps distinct documents apart', () => {
    const a = citationFromWire({ citation_key: 'plan.pdf, p.1' })
    const b = citationFromWire({ citation_key: 'bestandsplan.pdf, p.1' })
    expect(sameCitation(a, b)).toBe(false)
  })

  test('keeps the same document at different pages apart when it has no key', () => {
    const a = citationFromWire({ file_name: 'plan.pdf', page: 1 })
    const b = citationFromWire({ file_name: 'plan.pdf', page: 4 })
    expect(sameCitation(a, b)).toBe(false)
  })
})

describe('mergeCitation', () => {
  test('a sparse cited event raises isCited without erasing the rich payload', () => {
    const discovered = citationFromWire(KB_WIRE)
    const cited = citationFromWire({ citation_key: KB_WIRE.citation_key }, { isCited: true })
    const merged = mergeCitation(discovered, cited)
    expect(merged.isCited).toBe(true)
    expect(merged.kind).toBe('baurecht')
    expect(merged.title).toBe('OIB-Richtlinie 2')
    expect(merged.page).toBe(12)
  })

  test('isCited is sticky once set', () => {
    const cited = citationFromWire(KB_WIRE, { isCited: true })
    const rediscovered = citationFromWire(KB_WIRE, { isCited: false })
    expect(mergeCitation(cited, rediscovered).isCited).toBe(true)
  })

  test('identity and first-seen time stay with the entry already held', () => {
    const first = citationFromWire(KB_WIRE, { id: 'first', timestamp: new Date(0) })
    const later = citationFromWire(KB_WIRE, { id: 'later', timestamp: new Date(1000) })
    const merged = mergeCitation(first, later)
    expect(merged.id).toBe('first')
    expect(merged.timestamp).toEqual(new Date(0))
  })
})

describe('dedupeBufferedCitations', () => {
  const now = new Date(0)

  test('folds a discovery and its later cited event into one row', () => {
    const rows = dedupeBufferedCitations(
      [
        { wire: KB_WIRE, isCited: false },
        { wire: { citation_key: KB_WIRE.citation_key, content: 'x' }, isCited: true },
      ],
      now
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].isCited).toBe(true)
    // The replayed row must be as rich as the live one.
    expect(rows[0].kind).toBe('baurecht')
    expect(rows[0].page).toBe(12)
  })

  test('keeps genuinely different sources apart', () => {
    const rows = dedupeBufferedCitations(
      [
        { wire: KB_WIRE, isCited: true },
        { wire: { url: 'https://example.com/a' }, isCited: true },
      ],
      now
    )
    expect(rows).toHaveLength(2)
  })

  test('an empty replay yields no rows', () => {
    expect(dedupeBufferedCitations([], now)).toEqual([])
  })
})

describe('citationsFromWireList', () => {
  test('normalizes every entry and skips non-objects', () => {
    const list = citationsFromWireList([KB_WIRE, null, 'nope', { url: 'https://example.com/a' }])
    expect(list).toHaveLength(2)
    expect(list?.[0].kind).toBe('baurecht')
  })

  test('an empty or absent list yields undefined', () => {
    expect(citationsFromWireList([])).toBeUndefined()
    expect(citationsFromWireList(undefined)).toBeUndefined()
  })
})
