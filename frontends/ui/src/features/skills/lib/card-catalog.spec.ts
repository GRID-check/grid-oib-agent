import { describe, expect, test } from 'vitest'
import { gridCardSchema } from '@/shared/cards/schemas'
import {
  CARD_CATALOG,
  SYSTEM_CARD_TYPES,
  formatPreferredCardTypes,
  isSelectableCardType,
  parsePreferredCardTypes,
  searchCardCatalog,
} from './card-catalog'

describe('card catalogue extraction', () => {
  test('covers the generated union minus the withheld cards', () => {
    const union = [...gridCardSchema.optionsMap.keys()]
    expect(CARD_CATALOG).toHaveLength(union.length - SYSTEM_CARD_TYPES.length)
    // Derived, not hand-maintained: every offerable union member is offered.
    for (const type of union) {
      if ((SYSTEM_CARD_TYPES as readonly unknown[]).includes(type)) continue
      expect(CARD_CATALOG.map((entry) => entry.type)).toContain(type)
    }
  })

  test('excludes the system cards the backend also withholds', () => {
    for (const type of SYSTEM_CARD_TYPES) {
      // Still a real union member — it renders; it is just never requestable.
      expect(gridCardSchema.optionsMap.has(type)).toBe(true)
      expect(CARD_CATALOG.some((entry) => entry.type === type)).toBe(false)
      expect(isSelectableCardType(type)).toBe(false)
    }
  })

  test('carries each card’s own description, on one line', () => {
    const stair = CARD_CATALOG.find((entry) => entry.type === 'stair_diagram')
    expect(stair?.description.toLowerCase()).toContain('stair')
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
    expect(parsePreferredCardTypes(' calculation , stair_diagram ')).toEqual([
      'calculation',
      'stair_diagram',
    ])
    expect(parsePreferredCardTypes('calculation,calculation')).toEqual(['calculation'])
  })

  test('drops names the catalogue does not offer', () => {
    expect(parsePreferredCardTypes('calculation,memory_proposal,gibt_es_nicht')).toEqual([
      'calculation',
    ])
    // Retired types (ADR-0069) are not selectable cards.
    expect(parsePreferredCardTypes('summary,legal_basis,condition_tree')).toEqual([])
  })

  test('format is the inverse of parse', () => {
    const stored = formatPreferredCardTypes(['calculation', 'stair_diagram'])
    expect(stored).toBe('calculation,stair_diagram')
    expect(parsePreferredCardTypes(stored)).toEqual(['calculation', 'stair_diagram'])
  })
})
