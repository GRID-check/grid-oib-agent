/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  KIND_TO_SIGNAL,
  SCOPE_QUALIFIERS,
  asSourceKind,
  authorityTag,
  collectionScope,
  scopeForQualifier,
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

describe('collectionScope', () => {
  test('maps a collection id to the shelf it lives on', () => {
    expect(collectionScope('archiv_org1')).toBe('buero')
    expect(collectionScope('proj_alpha')).toBe('projekt')
    expect(collectionScope('s_9f2a4c')).toBe('projekt')
    // A named collection that is neither project/session nor Archiv is the base
    // knowledge corpus — same branch order as the backend's lane_for_hit.
    expect(collectionScope('oib_knowledge')).toBe('baurecht')
  })

  test('no collection means no scope (never a wrong guess)', () => {
    expect(collectionScope('')).toBeUndefined()
    expect(collectionScope(null)).toBeUndefined()
    expect(collectionScope(undefined)).toBeUndefined()
  })

  test('every qualifier round-trips back to its scope', () => {
    for (const scope of Object.keys(SCOPE_QUALIFIERS) as (keyof typeof SCOPE_QUALIFIERS)[]) {
      expect(scopeForQualifier(SCOPE_QUALIFIERS[scope])).toBe(scope)
    }
  })

  test('qualifiers are matched case-insensitively', () => {
    // The qualifier survives a round trip through an LLM, which may recase it.
    expect(scopeForQualifier('projektwissen')).toBe('projekt')
    expect(scopeForQualifier('  BÜROARCHIV  ')).toBe('buero')
    expect(scopeForQualifier('Internal')).toBeUndefined()
  })
})
