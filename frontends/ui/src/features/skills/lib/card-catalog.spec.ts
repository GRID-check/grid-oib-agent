import { describe, expect, test } from 'vitest'
import { gridCardSchema } from '@/shared/cards/schemas'
import {
  CARD_CATALOG,
  ENVELOPE_CARD_TYPES,
  SYSTEM_CARD_TYPES,
  formatPreferredCardTypes,
  isSelectableCardType,
  parsePreferredCardTypes,
  searchCardCatalog,
} from './card-catalog'

describe('card catalogue extraction', () => {
  test('covers the generated union minus the withheld cards', () => {
    const union = [...gridCardSchema.optionsMap.keys()]
    const withheld = SYSTEM_CARD_TYPES.length + ENVELOPE_CARD_TYPES.length
    expect(CARD_CATALOG).toHaveLength(union.length - withheld)
    // Derived, not hand-maintained: every offerable union member is offered.
    for (const type of union) {
      if ((SYSTEM_CARD_TYPES as readonly unknown[]).includes(type)) continue
      if ((ENVELOPE_CARD_TYPES as readonly unknown[]).includes(type)) continue
      expect(CARD_CATALOG.map((entry) => entry.type)).toContain(type)
    }
  })

  test('excludes the system and envelope cards the backend also withholds', () => {
    for (const type of [...SYSTEM_CARD_TYPES, ...ENVELOPE_CARD_TYPES]) {
      // Still a real union member — it renders; it is just never requestable.
      expect(gridCardSchema.optionsMap.has(type)).toBe(true)
      expect(CARD_CATALOG.some((entry) => entry.type === type)).toBe(false)
      expect(isSelectableCardType(type)).toBe(false)
    }
  })

  test('carries each card’s own description, on one line', () => {
    const legalBasis = CARD_CATALOG.find((entry) => entry.type === 'legal_basis')
    expect(legalBasis?.description).toContain('legal norm')
    // The longer descriptions continue into model-facing emission guidance; a
    // picker row takes the first paragraph only, and never a raw newline.
    for (const entry of CARD_CATALOG) {
      expect(entry.description).not.toBe('')
      expect(entry.description).not.toContain('\n')
    }
  })

  test('search matches the type and the description', () => {
    expect(searchCardCatalog('egress').map((e) => e.type)).toEqual(['egress_diagram'])
    // An author searches for what they want to SHOW, not the union's spelling.
    expect(searchCardCatalog('escape').map((e) => e.type)).toContain('egress_diagram')
    expect(searchCardCatalog('  ')).toEqual(CARD_CATALOG)
    expect(searchCardCatalog('nichts dergleichen')).toEqual([])
  })

  test('a system card is never surfaced by a search that names it', () => {
    expect(searchCardCatalog('memory_proposal')).toEqual([])
  })
})

describe('grid-cards value round-trip', () => {
  test('parses a stored value, trimming and deduplicating', () => {
    expect(parsePreferredCardTypes(undefined)).toEqual([])
    expect(parsePreferredCardTypes('')).toEqual([])
    expect(parsePreferredCardTypes(' condition_tree , legal_basis ')).toEqual([
      'condition_tree',
      'legal_basis',
    ])
    expect(parsePreferredCardTypes('condition_tree,condition_tree')).toEqual(['condition_tree'])
  })

  test('drops names the catalogue no longer offers', () => {
    expect(parsePreferredCardTypes('condition_tree,memory_proposal,gibt_es_nicht')).toEqual([
      'condition_tree',
    ])
    // Envelope types are answer fields now, not selectable cards.
    expect(parsePreferredCardTypes('summary,verdict_header,callout')).toEqual([])
  })

  test('format is the inverse of parse', () => {
    const stored = formatPreferredCardTypes(['condition_tree', 'comparison_table'])
    expect(stored).toBe('condition_tree,comparison_table')
    expect(parsePreferredCardTypes(stored)).toEqual(['condition_tree', 'comparison_table'])
  })
})
