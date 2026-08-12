/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  KIND_TO_SIGNAL,
  LEGACY_SCOPE_QUALIFIERS,
  SHELVES,
  asShelf,
  asSourceKind,
  authorityTag,
  scopeForQualifier,
  shelfLabel,
  type Shelf,
  type SourceKind,
} from './source-kinds'

describe('asSourceKind', () => {
  test('accepts the four canonical kinds', () => {
    for (const k of ['baurecht', 'buero', 'projekt', 'web'] as SourceKind[]) {
      expect(asSourceKind(k)).toBe(k)
    }
  })

  test('rejects unknown / empty values', () => {
    expect(asSourceKind('law')).toBeUndefined()
    expect(asSourceKind('')).toBeUndefined()
    expect(asSourceKind(null)).toBeUndefined()
    expect(asSourceKind(undefined)).toBeUndefined()
  })
})

describe('KIND_TO_SIGNAL', () => {
  test('maps the OIB corpus + RIS (baurecht) to the law tint family', () => {
    expect(KIND_TO_SIGNAL.baurecht).toBe('law')
  })

  test('maps office/project/web to their families', () => {
    expect(KIND_TO_SIGNAL.buero).toBe('office')
    expect(KIND_TO_SIGNAL.projekt).toBe('project')
    expect(KIND_TO_SIGNAL.web).toBe('auto')
  })

})

describe('authorityTag', () => {
  test('distinguishes OIB from RIS within the Baurecht family', () => {
    expect(authorityTag('baurecht_oib')).toBe('OIB')
    expect(authorityTag('baurecht_oib_leitfaden')).toBe('OIB')
    expect(authorityTag('baurecht_ris')).toBe('RIS')
    expect(authorityTag('baurecht_bund')).toBe('RIS')
    expect(authorityTag('baurecht_verordnung')).toBe('RIS')
  })

  test('tags external norms and authority info distinctly', () => {
    expect(authorityTag('norm_extern')).toBe('ÖNORM')
    expect(authorityTag('behoerde')).toBe('Behörde')
  })

  test('office/project/web carry no authority tag', () => {
    expect(authorityTag('buero')).toBeNull()
    expect(authorityTag('projekt')).toBeNull()
    expect(authorityTag('web')).toBeNull()
    expect(authorityTag(null)).toBeNull()
  })

  test('an unclassified document does not claim to be an Austrian legal source', () => {
    // `baurecht_basis` is the lane of the DEFAULT doc_class — nobody has
    // classified this document yet. Inheriting the `baurecht` prefix's RIS
    // badge would let any upload wear the strongest provenance claim the UI
    // can make.
    expect(authorityTag('baurecht_basis')).toBeNull()
  })
})

describe('Shelf (ADR-0047)', () => {
  test('is exactly the four wire shelves', () => {
    expect([...SHELVES]).toEqual(['archiv', 'project', 'session', 'base'])
  })

  test('accepts a shelf the wire states, case- and whitespace-tolerantly', () => {
    for (const shelf of SHELVES) expect(asShelf(shelf)).toBe(shelf)
    expect(asShelf(' Session ')).toBe('session')
  })

  test('an unknown or missing shelf is UNKNOWN — never a default', () => {
    // The predecessor of this narrowing (`collectionScope`) failed OPEN and
    // returned `baurecht`, so an unrecognised collection claimed to be
    // authoritative base law. Unknown must stay unknown.
    expect(asShelf('baurecht')).toBeUndefined()
    expect(asShelf('projekt')).toBeUndefined()
    expect(asShelf('archiv_org1')).toBeUndefined()
    expect(asShelf('')).toBeUndefined()
    expect(asShelf(null)).toBeUndefined()
    expect(asShelf(undefined)).toBeUndefined()
  })

  test('the shelf is never inferred from a collection-id prefix', async () => {
    // ADR-0047's acceptance test: the prefix table is DELETED, not synchronised.
    // While a `('s_', 'projekt')` row existed, a private session attachment could
    // only ever be guessed into the project shelf.
    const source = await import('./source-kinds')
    expect('collectionScope' in source).toBe(false)
    expect('COLLECTION_SCOPE_PREFIXES' in source).toBe(false)
    expect('SCOPE_QUALIFIERS' in source).toBe(false)
  })
})

describe('shelfLabel', () => {
  test('renders each shelf in German', () => {
    expect(shelfLabel('archiv')).toBe('Büroarchiv')
    expect(shelfLabel('project')).toBe('Projektwissen')
    expect(shelfLabel('base')).toBe('Basiswissen')
  })

  test('a private session attachment is NOT labelled Projektwissen', () => {
    // The headline defect: a file the user attached to one chat was told to the
    // user as a "Private Sitzung" and then cited as project knowledge.
    expect(shelfLabel('session')).toBe('Private Sitzung')
    expect(shelfLabel('session')).not.toBe(shelfLabel('project'))
  })

  test('every shelf has a distinct label', () => {
    const labels = SHELVES.map((shelf: Shelf) => shelfLabel(shelf))
    expect(new Set(labels).size).toBe(SHELVES.length)
  })
})

describe('scopeForQualifier (legacy citation keys)', () => {
  test('every legacy qualifier still parses back to its shelf', () => {
    for (const [qualifier, shelf] of LEGACY_SCOPE_QUALIFIERS) {
      expect(scopeForQualifier(qualifier)).toBe(shelf)
    }
    expect(LEGACY_SCOPE_QUALIFIERS.map(([, shelf]) => shelf)).toEqual([
      'archiv',
      'project',
      'base',
    ])
  })

  test('qualifiers are matched case-insensitively', () => {
    // The qualifier survives a round trip through an LLM, which may recase it.
    expect(scopeForQualifier('projektwissen')).toBe('project')
    expect(scopeForQualifier('  BÜROARCHIV  ')).toBe('archiv')
    expect(scopeForQualifier('Internal')).toBeUndefined()
    expect(scopeForQualifier('')).toBeUndefined()
    expect(scopeForQualifier(null)).toBeUndefined()
  })

  test('the legacy reader knows no session qualifier — no key ever carried one', () => {
    expect(scopeForQualifier('Private Sitzung')).toBeUndefined()
  })
})
