import { describe, expect, it } from 'vitest'
import {
  TOUR_ANCHORS,
  TOUR_START_URL,
  TOUR_STOPS,
  cardSide,
  placeStops,
  requestsTour,
  tourAnchorSelector,
  type AnchorBox,
} from './product-tour'

const BOX: AnchorBox = { left: 900, right: 1000 }

describe('product tour stops', () => {
  it('opens and closes on centred cards, with every anchored stop in between', () => {
    expect(TOUR_STOPS[0]).toEqual({ id: 'welcome' })
    expect(TOUR_STOPS.at(-1)).toEqual({ id: 'shortcuts' })
    expect(TOUR_STOPS.filter((stop) => stop.anchor).map((stop) => stop.anchor)).toEqual(
      Object.values(TOUR_ANCHORS),
    )
  })

  it('drops a stop whose anchor is not on screen instead of pointing at nothing', () => {
    // An organization without the Archiv and Postfach flags.
    const hidden = new Set([tourAnchorSelector('archiv'), tourAnchorSelector('inbox')])
    const placed = placeStops(TOUR_STOPS, (selector) => (hidden.has(selector) ? null : BOX), 1280)
    expect(placed.map((stop) => stop.id)).toEqual(['welcome', 'createProject', 'account', 'shortcuts'])
  })

  it('places anchored stops and leaves centred ones unplaced', () => {
    const placed = placeStops(TOUR_STOPS, () => BOX, 1280)
    expect(placed.find((stop) => stop.id === 'welcome')?.side).toBeUndefined()
    expect(placed.find((stop) => stop.id === 'createProject')?.side).toBe('bottom-right')
  })
})

describe('cardSide', () => {
  it('hangs the card leftwards under an anchor in the right half', () => {
    expect(cardSide({ left: 1040, right: 1184 }, 1280)).toBe('bottom-right')
  })

  it('hangs it rightwards under an anchor in the left half — the phone "New project" button', () => {
    expect(cardSide({ left: 16, right: 158 }, 390)).toBe('bottom-left')
  })
})

describe('requestsTour', () => {
  it('starts on the URL onboarding hands over to, and on nothing else', () => {
    expect(requestsTour(new URL(TOUR_START_URL, 'http://x').search)).toBe(true)
    expect(requestsTour('?tour=other')).toBe(false)
    expect(requestsTour('?new=1')).toBe(false)
    expect(requestsTour('')).toBe(false)
  })
})
