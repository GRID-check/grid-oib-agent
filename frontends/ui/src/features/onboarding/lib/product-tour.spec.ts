import { describe, expect, it } from 'vitest'
import {
  ARRIVAL_ANCHOR,
  TOURS,
  TOUR_START_URL,
  cardSide,
  placeStops,
  projectTourUrl,
  requestedTour,
  sectionAnchor,
  tourAnchorSelector,
  tourForPath,
  type AnchorBox,
  type TourFlags,
} from './product-tour'

const DESKTOP = { width: 1280, height: 820 }
const PHONE = { width: 390, height: 844 }
const ALL_ON: TourFlags = { canAccessArchiv: true, canAccessInbox: true }
const BOX: AnchorBox = { left: 900, right: 1000, top: 20, bottom: 56 }
const everywhere = (): AnchorBox => BOX
const nowhere = (): AnchorBox | null => null

const ids = (stops: { id: string }[]): string[] => stops.map((stop) => stop.id)

describe('welcome tour', () => {
  it('opens and closes on centred cards, with the header controls in between', () => {
    expect(ids(placeStops(TOURS.welcome, ALL_ON, everywhere, DESKTOP))).toEqual([
      'welcome',
      'createProject',
      'archiv',
      'inbox',
      'account',
      'shortcuts',
    ])
  })

  it('drops the Archiv and the Postfach for an organization without them', () => {
    const flags = { canAccessArchiv: false, canAccessInbox: false }
    expect(ids(placeStops(TOURS.welcome, flags, everywhere, DESKTOP))).toEqual([
      'welcome',
      'createProject',
      'account',
      'shortcuts',
    ])
  })
})

describe('project tour', () => {
  it('walks chat, Files, the Archiv and the two compared, then sources and settings', () => {
    expect(ids(placeStops(TOURS.project, ALL_ON, everywhere, DESKTOP))).toEqual([
      'projectWelcome',
      'projectChat',
      'projectFiles',
      'projectArchiv',
      'filesOrArchiv',
      'projectSources',
      'projectSettings',
    ])
  })

  it('points at the rail items the sidebar marks, by section key', () => {
    const anchors = TOURS.project.flatMap((stop) => (stop.anchor ? [stop.anchor] : []))
    expect(anchors).toEqual(['chat', 'files', 'archiv', 'settings'].map(sectionAnchor))
  })

  it('drops both Archiv stops when the organization has no Archiv', () => {
    const placed = placeStops(TOURS.project, { ...ALL_ON, canAccessArchiv: false }, everywhere, DESKTOP)
    expect(ids(placed)).not.toContain('projectArchiv')
    expect(ids(placed)).not.toContain('filesOrArchiv')
  })

  it('keeps every stop on a phone, centred, when the rail is a closed drawer', () => {
    // The drawer renders nothing while closed: every anchor is absent. The
    // explanation still matters, so nothing is dropped — only the spotlight.
    const placed = placeStops(TOURS.project, ALL_ON, nowhere, PHONE)
    expect(placed).toHaveLength(TOURS.project.length)
    expect(placed.every((stop) => stop.side === undefined)).toBe(true)
  })

  it('waits for nothing on arrival — the rail is shell chrome, already standing', () => {
    expect(ARRIVAL_ANCHOR.project).toBeNull()
    expect(ARRIVAL_ANCHOR.welcome).not.toBeNull()
  })
})

describe('cardSide', () => {
  it('below an anchor in the right half, hangs the card leftwards', () => {
    expect(cardSide({ left: 1040, right: 1184, top: 96, bottom: 132 }, DESKTOP, 'below')).toBe('bottom-right')
  })

  it('below an anchor in the left half — the phone "New project" button — hangs it rightwards', () => {
    expect(cardSide({ left: 16, right: 158, top: 120, bottom: 156 }, PHONE, 'below')).toBe('bottom-left')
  })

  it('beside a rail item, centres on it wherever it is — the library never flips `right`', () => {
    expect(cardSide({ left: 12, right: 224, top: 150, bottom: 186 }, DESKTOP, 'beside')).toBe('right')
    expect(cardSide({ left: 12, right: 224, top: 680, bottom: 716 }, DESKTOP, 'beside')).toBe('right')
  })
})

describe('where tours run and how they are asked for', () => {
  it('maps the projects home to the welcome tour and any project page to the project tour', () => {
    expect(tourForPath('/app/projects')).toBe('welcome')
    expect(tourForPath('/app/projects/p1')).toBe('project')
    expect(tourForPath('/app/projects/p1/files')).toBe('project')
    expect(tourForPath('/app/organization')).toBeNull()
  })

  it('reads the tour from the hand-over URLs, and nothing else', () => {
    expect(requestedTour(new URL(TOUR_START_URL, 'http://x').search)).toBe('welcome')
    expect(requestedTour(new URL(projectTourUrl('p1'), 'http://x').search)).toBe('project')
    expect(requestedTour('?tour=other')).toBeNull()
    expect(requestedTour('?new=1')).toBeNull()
  })

  it('sends the project hand-over straight to chat, where the tour belongs', () => {
    // The project root is a server redirect, which would drop `?tour=`.
    expect(new URL(projectTourUrl('p1'), 'http://x').pathname).toBe('/app/projects/p1/chat')
    expect(tourForPath('/app/projects/p1/chat')).toBe('project')
  })

  it('builds anchor selectors the DOM can match', () => {
    expect(tourAnchorSelector('section-files')).toBe('[data-tour="section-files"]')
  })
})
