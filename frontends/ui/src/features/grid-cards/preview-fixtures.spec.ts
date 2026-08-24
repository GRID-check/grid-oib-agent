/**
 * @vitest-environment node
 */

/**
 * The guard that keeps the platform card gallery complete.
 *
 * `CARD_INTERACTIVITY` is exhaustive over the generated union, so it is the
 * list of every card type that exists. Each one must either have a preview
 * fixture or be named in `PREVIEW_EXCLUDED` with a reason — otherwise a card
 * type added to the union quietly appears in the gallery with no picture, and
 * the page tells a platform owner Grid cannot show something it can.
 *
 * A fixture that stops matching the schema fails here too: the exported map is
 * built by running the raw fixtures through `validateGridCards`, so a dropped
 * one is a missing key.
 */

import { describe, expect, it } from 'vitest'
import { CARD_INTERACTIVITY } from './card-decision'
import { CARD_PREVIEW_FIXTURES, PREVIEW_EXCLUDED, previewFixtureFor } from './preview-fixtures'

const ALL_TYPES = Object.keys(CARD_INTERACTIVITY)

describe('card preview fixtures', () => {
  it('covers every card type with a fixture or a stated exclusion', () => {
    const uncovered = ALL_TYPES.filter(
      (type) => !(type in CARD_PREVIEW_FIXTURES) && !(type in PREVIEW_EXCLUDED)
    )
    expect(uncovered).toEqual([])
  })

  it('excludes only types that exist, and previews nothing it excluded', () => {
    expect(Object.keys(PREVIEW_EXCLUDED).filter((type) => !ALL_TYPES.includes(type))).toEqual([])
    expect(Object.keys(PREVIEW_EXCLUDED).filter((type) => type in CARD_PREVIEW_FIXTURES)).toEqual([])
  })

  it('keeps every fixture valid against the live card union', () => {
    // Survival IS the assertion: an invalid fixture is dropped by
    // validateGridCards, so it would be missing from the map entirely.
    for (const [type, card] of Object.entries(CARD_PREVIEW_FIXTURES)) {
      expect(card?.type).toBe(type)
    }
    expect(Object.keys(CARD_PREVIEW_FIXTURES).length).toBe(ALL_TYPES.length - Object.keys(PREVIEW_EXCLUDED).length)
  })

  it('parsing fills the schema defaults an authored fixture omits', () => {
    // The fixtures are written in input shape; the map holds parsed cards, so
    // a renderer reading `note` gets null rather than undefined.
    const summary = previewFixtureFor('summary')
    expect(summary).toMatchObject({ type: 'summary' })
    const checklist = previewFixtureFor('requirement_checklist')
    expect(checklist).toHaveProperty('note', null)
  })

  it('returns undefined for a type it cannot preview', () => {
    expect(previewFixtureFor('ifc_viewer')).toBeUndefined()
    expect(previewFixtureFor('not_a_card')).toBeUndefined()
  })
})
