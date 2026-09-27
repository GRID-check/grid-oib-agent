import { describe, expect, it } from 'vitest'
import { gridCardSchema } from '@/shared/cards/schemas'
import { cardTypeOf } from '@/features/a2ui/catalog'
import { CARD_PLACEHOLDER_HEIGHTS, DEFAULT_CARD_PLACEHOLDER_HEIGHT } from './CardPlaceholder'

describe('CARD_PLACEHOLDER_HEIGHTS', () => {
  it('holds a height for every card type', () => {
    // The ratchet: a new card type fails here until it is measured on
    // `/dev/a2ui` and given its row, or it would arrive from 96 px again.
    const missing = gridCardSchema.options
      .map(cardTypeOf)
      .filter((type) => !(type in CARD_PLACEHOLDER_HEIGHTS))
    expect(missing).toEqual([])
  })

  it('names no type the schema does not have', () => {
    const types = new Set(gridCardSchema.options.map(cardTypeOf))
    expect(Object.keys(CARD_PLACEHOLDER_HEIGHTS).filter((type) => !types.has(type))).toEqual([])
  })

  it('holds every known card at more than the unknown-type default', () => {
    for (const height of Object.values(CARD_PLACEHOLDER_HEIGHTS)) {
      expect(height).toBeGreaterThan(DEFAULT_CARD_PLACEHOLDER_HEIGHT)
    }
  })
})
